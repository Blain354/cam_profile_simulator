"""
FastAPI backend for the cam profile simulation.
Run with: uvicorn backend.main:app --reload
"""

import dataclasses
import json
import queue
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from simulation import SimulationParams, compute_simulation, SolverParams, SolverResult, solve_cam_profile
from storage import (
    LINKAGE_KINDS, PROFILE_TYPES, CompliantExperimentStorage, LinkageProfileStorage,
    ProfileStorage, default_db_path,
)

import onshape_export
import onshape_variables
from legacy_units import legacy_psi_to_kpa
from linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage
from compliant_bars import compute_compliant, solve_compliant
from compliant_bars import _constraints_from_mapping as _compliant_constraints
from compliant_bars import _params_from_mapping as _compliant_params
from compliant_solver import CompliantSolveJobManager
import tube_model as tube_law


app = FastAPI(title="Cam Profile Simulation API")

_solve_stream_cancel_lock = threading.Lock()
_active_solve_cancel_event: Optional[threading.Event] = None
_active_solve_terminate_event: Optional[threading.Event] = None
_solve_candidates_cache_lock = threading.Lock()
_solve_candidates_cache: dict[str, list] = {}
_solve_candidates_cache_order: list[str] = []
_MAX_SOLVE_CANDIDATE_SETS = 6
# Every saved profile lives in `profiles` (copied once from the old tables at import).
# linkage_storage only serves the custom materials, still in linkage_profiles.
profiles = ProfileStorage(default_db_path())
linkage_storage = LinkageProfileStorage(default_db_path())
compliant_experiments = CompliantExperimentStorage(default_db_path())
compliant_jobs = CompliantSolveJobManager(compliant_experiments)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://cam-profile-sim.blain-projects.ca",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event() -> None:
    # Backward-compatible one-way migration from legacy JSON files.
    backend_dir = Path(__file__).resolve().parent
    candidate_dirs = [
        backend_dir.parent / "configs",  # local dev layout: repo/configs
        backend_dir / "configs",         # fallback if copied differently
    ]
    for cfg_dir in candidate_dirs:
        if cfg_dir.exists() and cfg_dir.is_dir():
            profiles.import_legacy_config_files(cfg_dir, transform=legacy_psi_to_kpa)
            break


class KpaBody(BaseModel):
    """A body that used to carry pressures in psi: an old client or saved body still works."""

    @model_validator(mode="before")
    @classmethod
    def _legacy_psi(cls, data):
        return legacy_psi_to_kpa(data)


class SimRequest(KpaBody):
    motor_speed: float = 100.0
    height: float = 2.0
    thickness: float = 2.5
    K: float = 2.0
    deadband: float = 1.5
    default_distance: float = 0.35
    ramp_enabled: bool = False
    bushing_diameter: float = 3.0
    lead_screw_pitch: float = 0.5
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    compliance: float = 0.7
    tube_model: str = Field(tube_law.DEFAULT_TUBE_MODEL, pattern="^(fem|simple)$")
    tube_shore_a: float = Field(tube_law.DEFAULT_SHORE_A, ge=10, le=90)
    chamber_volume_ml: float = 0.0
    note: str = ""
    chart_settings: dict = Field(default_factory=dict)


@app.post("/api/simulate")
def simulate(req: SimRequest):
    params = SimulationParams(
        motor_speed=req.motor_speed,
        height=req.height,
        thickness=req.thickness,
        K=req.K,
        deadband=req.deadband,
        default_distance=req.default_distance,
        ramp_enabled=req.ramp_enabled,
        bushing_diameter=req.bushing_diameter,
        lead_screw_pitch=req.lead_screw_pitch,
        tube_id=req.tube_id,
        tube_od=req.tube_od,
        input_pressure_kpa=req.input_pressure_kpa,
        compliance=req.compliance,
        tube_model=req.tube_model,
        tube_shore_a=req.tube_shore_a,
        chamber_volume_ml=req.chamber_volume_ml,
    )
    try:
        result = compute_simulation(params)
    except tube_law.TubeModelError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return dataclasses.asdict(result)


class SolveRequest(KpaBody):
    motor_speed: float = 100.0
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    chamber_volume_ml: float = 5.0
    compliance: float = 0.7
    tube_model: str = Field(tube_law.DEFAULT_TUBE_MODEL, pattern="^(fem|simple)$")
    tube_shore_a: float = Field(tube_law.DEFAULT_SHORE_A, ge=10, le=90)
    thickness: float = 2.5
    ramp_enabled: bool = False
    gap_at_y0_margin_mm: float = 0.1

    k_min: float = 0.5
    k_max: float = 8.0
    k_sample_mode: str = "count"
    k_steps: int = 10
    k_step: float = 0.25
    fix_k: bool = False
    fixed_k: float = 2.0

    deadband_min: float = 0.1
    deadband_max: float = 8.0
    deadband_sample_mode: str = "count"
    deadband_steps: int = 10
    deadband_step: float = 0.2
    fix_deadband: bool = False
    fixed_deadband: float = 1.5

    h_search_min: float = 0.05
    h_search_max: float = 40.0
    height_sample_mode: str = "count"
    height_steps: int = 14
    height_step: float = 1.0
    fix_height: bool = False
    fixed_height: float = 2.0

    default_distance_safety_factor: float = 0.95
    # False: single fixed rest gap from theoretical opening × factor (only K, h, deadband vary).
    # True: search max rest gap per grid cell (legacy).
    optimize_default_distance: bool = False
    # equalization_rel_time | flow_rise_20_80 (5–25% linear slope) | flow_exp | flow_at_y — aggressivity ordering.
    candidate_rank_by: str = "flow_rise_20_80"
    # Cam Y (mm) for static flow when candidate_rank_by is flow_at_y (default 1 mm).
    candidate_rank_flow_y_mm: float = 1.0


class BuilderExperienceSaveRequest(KpaBody):
    note: str = ""
    builder_params: dict
    solver_result: dict
    # JSON body last sent to /api/solve-stream for this solver_result (snake_case keys).
    last_solve_request: Optional[dict] = None


def _solver_params_from_request(req: SolveRequest) -> SolverParams:
    return SolverParams(
        motor_speed=req.motor_speed,
        tube_id=req.tube_id,
        tube_od=req.tube_od,
        input_pressure_kpa=req.input_pressure_kpa,
        chamber_volume_ml=req.chamber_volume_ml,
        compliance=req.compliance,
        tube_model=req.tube_model,
        tube_shore_a=req.tube_shore_a,
        thickness=req.thickness,
        ramp_enabled=req.ramp_enabled,
        gap_at_y0_margin_mm=req.gap_at_y0_margin_mm,
        k_min=req.k_min,
        k_max=req.k_max,
        k_sample_mode=req.k_sample_mode,
        k_steps=req.k_steps,
        k_step=req.k_step,
        fix_k=req.fix_k,
        fixed_k=req.fixed_k,
        deadband_min=req.deadband_min,
        deadband_max=req.deadband_max,
        deadband_sample_mode=req.deadband_sample_mode,
        deadband_steps=req.deadband_steps,
        deadband_step=req.deadband_step,
        fix_deadband=req.fix_deadband,
        fixed_deadband=req.fixed_deadband,
        h_search_lo=req.h_search_min,
        h_search_max=req.h_search_max,
        height_sample_mode=req.height_sample_mode,
        height_steps=req.height_steps,
        height_step=req.height_step,
        fix_height=req.fix_height,
        fixed_height=req.fixed_height,
        default_distance_safety_factor=req.default_distance_safety_factor,
        optimize_default_distance=req.optimize_default_distance,
        candidate_rank_by=req.candidate_rank_by,
        candidate_rank_flow_y_mm=req.candidate_rank_flow_y_mm,
    )


def _solver_result_to_dict(result: SolverResult) -> dict:
    out = {
        "success": result.success,
        "message": result.message,
        "height": result.height,
        "K": result.K,
        "deadband": result.deadband,
        "default_distance": result.default_distance,
        "gap_at_Y0": result.gap_at_Y0,
        "theoretical_gap_mm": result.theoretical_gap_mm,
    }
    if result.simulation:
        out["simulation"] = dataclasses.asdict(result.simulation)
    if result.candidates is not None:
        out["candidates"] = result.candidates
    out["selected_candidate_index"] = result.selected_candidate_index
    out["solve_id"] = result.solve_id
    return out


def _store_candidate_simulations(result: SolverResult) -> None:
    if not result.solve_id or not result.candidate_simulations:
        return
    with _solve_candidates_cache_lock:
        _solve_candidates_cache[result.solve_id] = result.candidate_simulations
        _solve_candidates_cache_order.append(result.solve_id)
        while len(_solve_candidates_cache_order) > _MAX_SOLVE_CANDIDATE_SETS:
            old = _solve_candidates_cache_order.pop(0)
            _solve_candidates_cache.pop(old, None)


@app.post("/api/solve")
def solve(req: SolveRequest):
    try:
        result = solve_cam_profile(_solver_params_from_request(req))
    except tube_law.TubeModelError as e:
        raise HTTPException(status_code=422, detail=str(e))
    _store_candidate_simulations(result)
    return _solver_result_to_dict(result)


@app.post("/api/solve-cancel")
def solve_cancel():
    """Signal the current streaming solve (if any) to stop at the next cancellation check."""
    global _active_solve_cancel_event
    with _solve_stream_cancel_lock:
        ev = _active_solve_cancel_event
    if ev is not None:
        ev.set()
    return {"status": "cancel_requested"}


@app.post("/api/solve-terminate")
def solve_terminate():
    """Request graceful stop: end solve early and return current feasible candidates."""
    global _active_solve_terminate_event
    with _solve_stream_cancel_lock:
        ev = _active_solve_terminate_event
    if ev is not None:
        ev.set()
    return {"status": "terminate_requested"}


@app.post("/api/solve-stream")
def solve_stream(req: SolveRequest):
    """NDJSON stream: progress lines then final result (same shape as /api/solve)."""

    def generate():
        global _active_solve_cancel_event, _active_solve_terminate_event
        q: queue.Queue = queue.Queue()
        cancel_ev = threading.Event()
        terminate_ev = threading.Event()
        with _solve_stream_cancel_lock:
            _active_solve_cancel_event = cancel_ev
            _active_solve_terminate_event = terminate_ev

        def progress(
            pct: int,
            msg: str,
            feasible_count: int = 0,
            tested_count: int = 0,
            total_count: int = 0,
        ) -> None:
            q.put(
                {
                    "type": "progress",
                    "percent": pct,
                    "message": msg,
                    "feasible_count": feasible_count,
                    "tested_count": tested_count,
                    "total_count": total_count,
                }
            )

        def worker() -> None:
            global _active_solve_cancel_event, _active_solve_terminate_event
            try:
                sp = _solver_params_from_request(req)
                result = solve_cam_profile(
                    sp,
                    progress=progress,
                    cancel_event=cancel_ev,
                    terminate_event=terminate_ev,
                )
                _store_candidate_simulations(result)
                q.put({"type": "result", "payload": _solver_result_to_dict(result)})
            except Exception as e:
                q.put({"type": "error", "message": str(e)})
            finally:
                with _solve_stream_cancel_lock:
                    if _active_solve_cancel_event is cancel_ev:
                        _active_solve_cancel_event = None
                    if _active_solve_terminate_event is terminate_ev:
                        _active_solve_terminate_event = None
                q.put(None)

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        while True:
            item = q.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"
        t.join()

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.get("/api/solve-candidate/{solve_id}/{index}")
def solve_candidate_detail(solve_id: str, index: int):
    """
    Returns cached simulation for a solve/candidate index when available.
    Always HTTP 200: use cached=false when the server has no cache entry (restart, LRU eviction)
    or the index is invalid — the client then falls back to POST /api/simulate.
    Avoids noisy 404 logs on every aggressivity slider move.
    """
    with _solve_candidates_cache_lock:
        sims = _solve_candidates_cache.get(solve_id)
    if sims is None or index < 0 or index >= len(sims):
        return {"cached": False, "simulation": None}
    return {"cached": True, "simulation": dataclasses.asdict(sims[index])}


# ─── Saved profiles: one store, one type per feature ─────────────

_PROFILE_MAX_BYTES = 2 * 1024 * 1024


class ProfileBody(KpaBody):
    payload: dict
    note: str = ""


def _profile_type(profile_type: str) -> str:
    if profile_type not in PROFILE_TYPES:
        raise HTTPException(status_code=404, detail="Unknown profile type")
    return profile_type


def _profile_name(profile_type: str, name: str) -> str:
    """Linkage names: 1 to 60 characters. Cam names are generated file-like names
    (`20260326_162442_1.json`, `…_1.builder.json`): up to 120. Never a slash or a control character."""
    name = name.strip()
    limit = 120 if profile_type in ("cam", "cam-finder") else 60
    if not 1 <= len(name) <= limit or "/" in name or any(ord(ch) < 32 for ch in name):
        raise HTTPException(status_code=400, detail=f"Profile name must be 1 to {limit} characters, without slashes")
    return name


def _get_profile(profile_type: str, name: str):
    """A stored profile, its payload in kPa whatever it was saved in."""
    item = profiles.get(profile_type, name)
    if item is not None:
        item["payload"] = legacy_psi_to_kpa(item["payload"])
    return item


def _check_payload_size(body: ProfileBody) -> None:
    if len(json.dumps([body.payload, body.note], ensure_ascii=False).encode("utf-8")) > _PROFILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Profile payload is larger than 2 MB")


@app.get("/api/profiles")
def profiles_list(type: str):
    profile_type = _profile_type(type)
    return {"profiles": profiles.list(profile_type), "default": profiles.get_default(profile_type)}


@app.post("/api/profiles/{type}")
def profiles_create(type: str, body: ProfileBody):
    profile_type = _profile_type(type)
    _check_payload_size(body)
    return {"status": "saved", "name": profiles.create(profile_type, body.payload, body.note)}


# Declared before /{type}/{name}: a profile named "default" is reserved.
@app.get("/api/profiles/{type}/default")
def profiles_get_default(type: str):
    return {"default": profiles.get_default(_profile_type(type))}


@app.put("/api/profiles/{type}/default/{name}")
def profiles_set_default(type: str, name: str):
    profile_type = _profile_type(type)
    if profiles.get(profile_type, name) is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    profiles.set_default(profile_type, name)
    return {"status": "set", "default": name}


@app.get("/api/profiles/{type}/{name}")
def profiles_get(type: str, name: str):
    item = _get_profile(_profile_type(type), name)
    if item is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {key: item[key] for key in ("name", "type", "note", "payload", "updated_at")}


@app.put("/api/profiles/{type}/{name}")
def profiles_save(type: str, name: str, body: ProfileBody):
    profile_type = _profile_type(type)
    name = _profile_name(profile_type, name)
    if name == "default":
        raise HTTPException(status_code=400, detail='"default" is reserved')
    _check_payload_size(body)
    existed = profiles.save(profile_type, name, body.payload, body.note)
    return {"status": "updated" if existed else "saved", "name": name}


@app.delete("/api/profiles/{type}/{name}")
def profiles_delete(type: str, name: str):
    if not profiles.delete(_profile_type(type), name):
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"status": "deleted"}


# ─── Cam configs: the old routes, over the profile store (type "cam") ───

@app.get("/api/configs")
def list_configs():
    return {"configs": [{"filename": p["name"], "note": p["note"]} for p in profiles.list("cam")]}

@app.get("/api/configs/default")
def get_default_config():
    return {"default": profiles.get_default("cam")}

@app.post("/api/configs/default/{name}")
def set_default_config(name: str):
    # The frontend posts "none" to clear the default.
    profiles.set_default("cam", None if name == "none" else name)
    return {"status": "set", "default": name}

@app.get("/api/configs/{name}")
def get_config(name: str):
    item = _get_profile("cam", name)
    if item is None:
        raise HTTPException(status_code=404, detail="Config not found")
    # A cam payload carries its note; the note column is the one to trust.
    # Old payloads without a note key come back exactly as stored.
    payload = item["payload"]
    if "note" in payload or item["note"]:
        payload["note"] = item["note"]
    return payload

@app.put("/api/configs/{name}")
def update_config(name: str, req: SimRequest):
    if profiles.get("cam", name) is None:
        raise HTTPException(status_code=404, detail="Config not found")
    payload = req.model_dump()
    profiles.save("cam", name, payload, payload["note"])
    return {"status": "updated", "filename": name}

@app.delete("/api/configs/{name}")
def delete_config(name: str):
    if not profiles.delete("cam", name):
        raise HTTPException(status_code=404, detail="Config not found")
    return {"status": "deleted"}

@app.post("/api/save-config")
def save_config(req: SimRequest):
    payload = req.model_dump()
    name = profiles.create("cam", payload, payload["note"])
    return {"status": "saved", "filename": name}

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Onshape STL export ──────────────────────────────────────────────────────
#
# Pipeline implemented in `onshape_export.py` — itself derived from the
# OpenClaw `onshape` skill (`~/.openclaw/workspace/skills/onshape/SKILL.md`).
# The stream endpoint emits granular NDJSON progress events the frontend
# renders inside the STL export modal; once the STL bytes have been retrieved
# we cache them in-memory under a one-shot job id so the browser can pull
# the file via a follow-up GET (which lets us trigger the native file picker).

_stl_jobs_lock = threading.Lock()
_stl_jobs: "OrderedDict[str, dict]" = OrderedDict()
_STL_JOB_TTL_S = 600
_STL_JOB_MAX = 12


def _prune_stl_jobs() -> None:
    now = time.time()
    with _stl_jobs_lock:
        stale = [jid for jid, j in _stl_jobs.items() if now - j["created_at"] > _STL_JOB_TTL_S]
        for jid in stale:
            _stl_jobs.pop(jid, None)
        while len(_stl_jobs) > _STL_JOB_MAX:
            _stl_jobs.popitem(last=False)


class STLExportRequest(KpaBody):
    """Configuration payload pushed to Onshape before exporting the STL.

    Mirrors `SimRequest` but only the fields that are actually mapped to
    Onshape variables matter — the rest is forwarded for future use.
    """

    motor_speed: Optional[float] = None
    height: Optional[float] = None
    thickness: Optional[float] = None
    K: Optional[float] = None
    deadband: Optional[float] = None
    default_distance: Optional[float] = None
    ramp_enabled: bool = False
    bushing_diameter: Optional[float] = None
    lead_screw_pitch: Optional[float] = None
    tube_id: Optional[float] = None
    tube_od: Optional[float] = None
    input_pressure_kpa: Optional[float] = None
    compliance: Optional[float] = None
    chamber_volume_ml: Optional[float] = None
    note: Optional[str] = ""
    # Optional pre-baked filename suggested to the browser save dialog.
    filename: Optional[str] = None


@app.get("/api/export/stl-config")
def export_stl_config():
    """Lightweight health probe used by the UI before opening the modal —
    tells the user whether Onshape credentials and document ids are wired."""
    import os as _os
    target = onshape_export.get_default_target_or_none()
    has_keys = bool(_os.environ.get("ONSHAPE_ACCESS_KEY") and _os.environ.get("ONSHAPE_SECRET_KEY"))
    if not has_keys:
        has_keys = (Path.home() / ".hermes" / "secrets" / "onshape.env").exists()
    return {
        "ready": target is not None and has_keys,
        "has_keys": has_keys,
        "has_target": target is not None,
        "target": (
            {
                "document_id": target.document_id,
                "workspace_id": target.workspace_id,
                "element_id": target.element_id,
                "part_id": target.part_id,
                "variable_element_id": target.variable_element_id,
                "variable_mapping": target.variable_mapping,
                "config_parameter_id": target.config_parameter_id,
                "config_enum_value": target.config_enum_value,
            }
            if target
            else None
        ),
    }


@app.post("/api/export/stl-stream")
def export_stl_stream(req: STLExportRequest):
    """NDJSON stream of granular Onshape export progress events.

    Final line is either `{"type":"result","job_id":...}` (download the STL
    via `/api/export/stl-download/{job_id}`) or `{"type":"error", ...}`.
    """

    if req.ramp_enabled:
        raise HTTPException(
            status_code=422,
            detail="Closure ramp STL export requires a matching ramp in the Onshape sketch. The current CAD export supports the plateau profile only.",
        )
    payload = req.model_dump(exclude_none=True)
    filename = payload.pop("filename", None) or f"cam-profile-{int(time.time())}.stl"

    def generate():
        q: "queue.Queue" = queue.Queue()
        cancel_ev = threading.Event()

        def progress(pct: int, msg: str, details: Optional[dict] = None) -> None:
            q.put(
                {
                    "type": "progress",
                    "percent": int(max(0, min(99, pct))),
                    "message": msg,
                    "details": details or {},
                    "timestamp": time.time(),
                }
            )

        def worker() -> None:
            try:
                progress(2, "Validating Onshape configuration…", None)
                target = onshape_export.get_default_target_or_none()
                if target is None:
                    raise onshape_export.OnshapeConfigError(
                        "Onshape target is not configured. Set ONSHAPE_DOCUMENT_ID, "
                        "ONSHAPE_WORKSPACE_ID and ONSHAPE_ELEMENT_ID on the backend."
                    )

                result = onshape_export.run_full_export(
                    payload,
                    target=target,
                    progress=progress,
                    cancel_event=cancel_ev,
                )

                job_id = uuid.uuid4().hex
                with _stl_jobs_lock:
                    _stl_jobs[job_id] = {
                        "bytes": result.stl_bytes,
                        "filename": filename,
                        "created_at": time.time(),
                        "translation_id": result.translation_id,
                        "pushed_variables": result.pushed_variables,
                        "params": payload,
                    }
                _prune_stl_jobs()

                q.put(
                    {
                        "type": "result",
                        "percent": 100,
                        "message": "STL ready — pick a destination to download.",
                        "job_id": job_id,
                        "download_url": f"/api/export/stl-download/{job_id}",
                        "filename": filename,
                        "size_bytes": len(result.stl_bytes),
                        "translation_id": result.translation_id,
                        "pushed_variables": result.pushed_variables,
                    }
                )
            except onshape_export.OnshapeConfigError as exc:
                q.put({"type": "error", "code": "config", "message": str(exc)})
            except onshape_export.OnshapeAPIError as exc:
                q.put(
                    {
                        "type": "error",
                        "code": "onshape_api",
                        "status": exc.status,
                        "message": str(exc),
                        "payload": exc.payload,
                    }
                )
            except Exception as exc:  # noqa: BLE001 — surface to UI verbatim
                q.put({"type": "error", "code": "internal", "message": str(exc)})
            finally:
                q.put(None)

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        try:
            while True:
                item = q.get()
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"
        finally:
            cancel_ev.set()
            t.join(timeout=2)

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.get("/api/export/stl-download/{job_id}")
def export_stl_download(job_id: str):
    """One-shot download of a freshly exported STL blob."""
    _prune_stl_jobs()
    with _stl_jobs_lock:
        job = _stl_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="STL job not found or expired")
    headers = {
        "Content-Disposition": f'attachment; filename="{job["filename"]}"',
        "Content-Length": str(len(job["bytes"])),
        "Cache-Control": "no-store",
    }
    return Response(content=job["bytes"], media_type="model/stl", headers=headers)


# ─── Builder experiences: the old routes, over the profile store (type "cam-finder") ───

def _experience_payload(req: BuilderExperienceSaveRequest) -> dict:
    payload = {"builder_params": req.builder_params, "solver_result": req.solver_result}
    if req.last_solve_request is not None:
        payload["last_solve_request"] = req.last_solve_request
    return payload


@app.get("/api/builder-experiences")
def list_builder_experiences():
    return {"experiences": [{"filename": p["name"], "note": p["note"]} for p in profiles.list("cam-finder")]}


@app.get("/api/builder-experiences/{name}")
def get_builder_experience(name: str):
    item = _get_profile("cam-finder", name)
    if item is None:
        raise HTTPException(status_code=404, detail="Experience not found")
    payload = item["payload"]
    out = {
        "filename": item["name"],
        "note": item["note"],
        "builder_params": payload.get("builder_params"),
        "solver_result": payload.get("solver_result"),
    }
    if payload.get("last_solve_request") is not None:
        out["last_solve_request"] = payload["last_solve_request"]
    return out


@app.post("/api/builder-experiences")
def save_builder_experience(req: BuilderExperienceSaveRequest):
    filename = profiles.create("cam-finder", _experience_payload(req), req.note or "")
    return {"status": "saved", "filename": filename}


@app.put("/api/builder-experiences/{name}")
def update_builder_experience(name: str, req: BuilderExperienceSaveRequest):
    if profiles.get("cam-finder", name) is None:
        raise HTTPException(status_code=404, detail="Experience not found")
    profiles.save("cam-finder", name, _experience_payload(req), req.note or "")
    return {"status": "updated", "filename": name}


@app.delete("/api/builder-experiences/{name}")
def delete_builder_experience(name: str):
    if not profiles.delete("cam-finder", name):
        raise HTTPException(status_code=404, detail="Experience not found")
    return {"status": "deleted"}


# ─── Tube section (FEM) ───────────────────────────────────────────

class TubeSectionRequest(BaseModel):
    tube_od: float = Field(3.0, gt=0, le=50)
    tube_id: float = Field(2.0, gt=0, le=50)
    tube_shore_a: float = Field(tube_law.DEFAULT_SHORE_A, ge=10, le=90)
    input_pressure_kpa: float = Field(100.0, ge=0, le=2000)
    h: float = Field(..., description="plate distance (pin or cam to wall), mm")


@app.post("/api/tube/section")
def tube_section(req: TubeSectionRequest):
    """Deformed cross-section of the tube squeezed to h, from the finite-element model."""
    if req.tube_id >= req.tube_od:
        raise HTTPException(status_code=422, detail="The tube needs OD > ID.")
    try:
        return tube_law.section(req, req.h)
    except tube_law.TubeModelError as e:
        raise HTTPException(status_code=422, detail=str(e))


class TubeSweepRequest(BaseModel):
    tube_od: float = Field(3.0, gt=0, le=50)
    tube_id: float = Field(2.0, gt=0, le=50)
    tube_shore_a: float = Field(tube_law.DEFAULT_SHORE_A, ge=10, le=90)
    input_pressure_kpa: float = Field(100.0, ge=0, le=2000)


@app.post("/api/tube/sweep")
def tube_sweep(req: TubeSweepRequest):
    """The FEM tube over its whole sweep of plate distance (quarter outlines, force, open bore),
    fetched once per tube by the browser, which interpolates the section at any h per frame."""
    if req.tube_id >= req.tube_od:
        raise HTTPException(status_code=422, detail="The tube needs OD > ID.")
    try:
        return tube_law.sweep(req)
    except tube_law.TubeModelError as e:
        raise HTTPException(status_code=422, detail=str(e))


# ─── Bar linkage pinch valves ────────────────────────────────────

class LinkageRequest(KpaBody):
    linkage_type: str = "elbow"
    bar1_length: float = 13.0
    bar2_length: float = 7.8
    lever_length: float = 16.5
    foot_length: float = Field(1.5, ge=0, le=50)
    foot_angle_deg: float = Field(100.0, ge=0, le=180)
    pad_length: float = Field(0.0, ge=0, le=50)
    fixed_height: float = Field(0.0, ge=0, le=200)
    anchor_distance: float = 2.33
    pivot_offset: float = 3.9
    tube_center_x: float = 8.0
    pin_diameter: float = 1.0
    preload: float = 0.1
    stroke: float = Field(3.0, gt=0, le=50)
    target_exponent: float = Field(1.0, gt=0, le=10)
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    compliance: float = 0.7
    tube_model: str = Field(tube_law.DEFAULT_TUBE_MODEL, pattern="^(fem|simple)$")
    tube_shore_a: float = Field(tube_law.DEFAULT_SHORE_A, ge=10, le=90)
    chamber_volume_ml: float = Field(10.0, ge=0, le=10000)
    motor_speed: float = Field(100.0, ge=0, le=100000)
    lead_screw_pitch: float = Field(0.5, ge=0, le=100)
    speed_factor: float = Field(0.85, ge=0, le=1)
    motor_torque_mnm: float = Field(30.0, ge=0, le=100000)
    screw_diameter: float = Field(3.0, gt=0, le=100)
    screw_friction: float = Field(0.3, ge=0, le=5)
    member_modulus_mpa: float = Field(2500.0, ge=0, le=1e6)
    member_width: float = Field(2.0, ge=0, le=100)
    member_thickness: float = Field(3.0, ge=0, le=100)
    contact_deformation: bool = True
    link_curved: bool = False
    link_curve_mode: str = Field("", pattern="^(|straight|tangent|radius)$")
    link_curve_flip: bool = False
    link_radius: float = Field(10.0, ge=0, le=1000)
    compliant: bool = False
    carriage_clamped: bool = False
    carriage_pin_diameter: float = Field(1.5, ge=0, le=100)
    carriage_pin_length: float = Field(8.0, ge=0, le=1000)
    member_strength_mpa: float = Field(40.0, ge=0, le=1e5)
    carriage_pin_strength_mpa: float = Field(300.0, ge=0, le=1e5)
    pivot_inverted: bool = False
    assembly_clearance: float = Field(0.3, ge=0, le=20)
    linkage_plane_spacing: float = Field(10.75, ge=0, le=200)
    carriage_block_width: float = Field(5.5, ge=0, le=200)
    carriage_block_length: float = Field(17.5, ge=0, le=200)
    carriage_block_height: float = Field(5.0, ge=0, le=200)
    carriage_block_offset: float = Field(0.95, ge=-100, le=100)


class LinkageOptimizeRequest(LinkageRequest):
    bar1_min: float = 6.0
    bar1_max: float = 20.0
    bar2_min: float = 3.0
    bar2_max: float = 14.0
    lever_min: float = 10.0
    lever_max: float = 22.0
    anchor_min: float = 0.0
    anchor_max: float = 6.0
    anchor_avoid_min: float = 0.0
    anchor_avoid_max: float = 0.0
    pinch_height_min: float = 0.0
    pinch_height_max: float = 0.0
    foot_min: float = Field(1.0, ge=0, le=50)
    foot_max: float = Field(6.0, ge=0, le=50)
    foot_angle_min: float = Field(45.0, ge=0, le=180)
    foot_angle_max: float = Field(135.0, ge=0, le=180)
    min_pivot_height: float = 3.0
    max_pivot_height: float = 16.0
    max_oversqueeze: float = 0.5
    objective: str = Field("response", pattern="^(response|deadband|chamber|progressive|target)$")
    max_stroke: float = Field(3.0, gt=0, le=50)
    min_flow_pct: float = Field(0.0, ge=0, le=95)
    pivot_side: str = Field("normal", pattern="^(normal|inverted|both)$")
    require_seal: bool = True
    link_curve_search: str = Field("current", pattern="^(current|all|straight|tangent|tangent_flip|radius)$")
    link_radius_min: float = Field(5.0, gt=0, le=1000)
    link_radius_max: float = Field(40.0, gt=0, le=1000)


def _linkage_params(req: LinkageRequest) -> LinkageParams:
    names = [f.name for f in dataclasses.fields(LinkageParams)]
    return LinkageParams(**{n: getattr(req, n) for n in names})


@app.post("/api/linkage/simulate")
def linkage_simulate(req: LinkageRequest):
    return dataclasses.asdict(compute_linkage(_linkage_params(req)))


@app.post("/api/compliant/simulate")
def compliant_simulate(payload: dict = Body(...)):
    constraints = _compliant_constraints(payload.get("constraints"))
    return dataclasses.asdict(compute_compliant(_compliant_params(payload), constraints=constraints))


class CompliantSolveBody(BaseModel):
    params: dict
    bounds: dict = Field(default_factory=dict)
    budget: int = Field(36, ge=1, le=80)
    constraints: Optional[dict] = None
    pivot_side: str = Field("current", pattern="^(current|normal|inverted|both)$")


@app.post("/api/compliant/solve")
def compliant_solve(body: CompliantSolveBody):
    bounds = {}
    for key, pair in body.bounds.items():
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            bounds[key] = (float(pair[0]), float(pair[1]))
    constraints = _compliant_constraints(body.constraints)
    try:
        return solve_compliant(
            _compliant_params(body.params),
            bounds,
            budget=body.budget,
            constraints=constraints,
            pivot_side=body.pivot_side,
        )
    except tube_law.TubeModelError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/compliant/onshape/measured")
def compliant_onshape_measured():
    """The inputs the CAD decides for compliant bars, as Onshape computes them now. Reads only."""
    return _onshape_variables(lambda: onshape_variables.read_measured("compliant"))


class CompliantSolveJobBody(BaseModel):
    params: dict
    bounds: dict = Field(default_factory=dict)
    constraints: Optional[dict] = None
    pivot_side: str = Field("current", pattern="^(current|normal|inverted|both)$")
    goal: str = Field("dx_at_025", pattern="^(dx_at_025|pass_freq_bw|min_open_stroke|flow_slope|trajectory_target|min_energy)$")
    goal_weights: Optional[dict] = None
    method: str = Field("hybrid", pattern="^(hybrid|brute_force|evolutionary|local_refine)$")
    method_params: Optional[dict] = None
    time_budget_s: float = Field(30.0, ge=1.0)
    name: Optional[str] = None
    note: str = ""


class CompliantExperimentPatchBody(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None


@app.post("/api/compliant/solve/jobs")
def compliant_solve_job_start(body: CompliantSolveJobBody):
    bounds = {}
    for key, pair in body.bounds.items():
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            bounds[key] = (float(pair[0]), float(pair[1]))
    return compliant_jobs.start_job(
        params_dict=body.params,
        bounds=bounds,
        constraints_dict=body.constraints,
        pivot_side=body.pivot_side,
        goal=body.goal,
        goal_weights=body.goal_weights,
        method=body.method,
        method_params=body.method_params,
        time_budget_s=body.time_budget_s,
        name=body.name,
        note=body.note,
    )


@app.get("/api/compliant/solve/jobs/{job_id}")
def compliant_solve_job_status(job_id: str):
    job = compliant_jobs.get_job(job_id)
    if job is not None:
        return job
    exp = compliant_experiments.get_experiment(job_id)
    if exp is not None:
        return {
            "job_id": exp["id"],
            "experiment_id": exp["id"],
            "name": exp["name"],
            "note": exp["note"],
            "status": exp["status"],
            "goal": exp["goal"],
            "time_budget_s": exp["time_budget_s"],
            "summary": exp["summary"],
            "found": exp["best_params"] is not None,
            "params": exp["best_params"],
            "result": exp["best_result"],
            "runners": exp["summary"].get("runners", []),
            "message": "Loaded from saved experiment.",
            "error": None,
        }
    raise HTTPException(status_code=404, detail="Solve job not found.")


@app.post("/api/compliant/solve/jobs/{job_id}/cancel")
def compliant_solve_job_cancel(job_id: str):
    ok = compliant_jobs.cancel_job(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Solve job not found.")
    return {"cancelled": True, "job_id": job_id}


@app.get("/api/compliant/experiments")
def compliant_experiments_list():
    return {"experiments": compliant_experiments.list_experiments()}


@app.get("/api/compliant/experiments/{exp_id}")
def compliant_experiments_get(exp_id: str):
    exp = compliant_experiments.get_experiment(exp_id)
    if exp is None:
        raise HTTPException(status_code=404, detail="Experiment not found.")
    return exp


@app.patch("/api/compliant/experiments/{exp_id}")
def compliant_experiments_patch(exp_id: str, body: CompliantExperimentPatchBody):
    ok = compliant_experiments.update_meta(exp_id, name=body.name, note=body.note)
    if not ok:
        raise HTTPException(status_code=404, detail="Experiment not found.")
    return {"updated": True, "id": exp_id}


@app.delete("/api/compliant/experiments/{exp_id}")
def compliant_experiments_delete(exp_id: str):
    ok = compliant_experiments.delete_experiment(exp_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Experiment not found.")
    return {"deleted": True, "id": exp_id}


@app.post("/api/linkage/optimize")
def linkage_optimize(req: LinkageOptimizeRequest):
    params = _linkage_params(req)
    names = [f.name for f in dataclasses.fields(LinkageSearch)]
    try:
        best, feasible, tested, report = optimize_linkage(params, LinkageSearch(**{n: getattr(req, n) for n in names}))
    except tube_law.TubeModelError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if best is None:
        return {"found": False, "feasible": feasible, "tested": tested, "search_report": report, "candidates": []}
    return {
        "found": True,
        "feasible": feasible,
        "tested": tested,
        "search_report": report,
        "candidates": report.get("candidates", []),
        "params": dataclasses.asdict(best),
        "result": dataclasses.asdict(compute_linkage(best)),
    }


# ─── Linkage dimensions to the Onshape variable table ────────────

class LinkageOnshapePreviewRequest(LinkageRequest):
    # Name of the simulator's own Variable Studio; empty means cam_sim_<kind>. Checked in onshape_variables.
    table_name: Optional[str] = Field(None, max_length=200)


class LinkageOnshapeApplyRequest(LinkageOnshapePreviewRequest):
    names: list[str] = Field(default_factory=list, max_length=100)


def _onshape_variables(call):
    try:
        return call()
    except onshape_variables.TableNameError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except onshape_variables.LinkageOnshapeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except onshape_export.OnshapeConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except onshape_export.OnshapeAPIError as exc:
        raise HTTPException(status_code=502, detail=f"Onshape refused the request: {exc}")


@app.post("/api/linkage/onshape/preview")
def linkage_onshape_preview(req: LinkageOnshapePreviewRequest):
    """What writing this design to its own Onshape Variable Studio would change. Reads only."""
    return _onshape_variables(lambda: onshape_variables.preview(_linkage_params(req), req.table_name))


@app.post("/api/linkage/onshape/measured")
def linkage_onshape_measured(req: LinkageRequest):
    """The inputs the CAD decides (measured variables of the Part Studio), as Onshape computes them now. Reads only."""
    return _onshape_variables(lambda: onshape_variables.read_measured(req.linkage_type))


@app.post("/api/linkage/onshape/apply")
def linkage_onshape_apply(req: LinkageOnshapeApplyRequest):
    """Write the named variables into the simulator's own Variable Studio, creating it if missing."""
    return _onshape_variables(lambda: onshape_variables.apply(_linkage_params(req), req.names, req.table_name))


# ─── Saved linkage profiles ──────────────────────────────────────

class LinkageProfileBody(KpaBody):
    params: dict
    search: dict = Field(default_factory=dict)
    chart_settings: dict = Field(default_factory=dict)


def _profile_key(kind: str, name: str):
    name = name.strip()
    if kind not in LINKAGE_KINDS:
        raise HTTPException(status_code=404, detail="Unknown linkage type")
    if not 1 <= len(name) <= 60 or "/" in name or any(ord(ch) < 32 for ch in name):
        raise HTTPException(status_code=400, detail="Profile name must be 1 to 60 characters, without slashes")
    return kind, name


@app.get("/api/linkage/profiles")
def linkage_profiles(kind: str):
    if kind not in LINKAGE_KINDS:
        raise HTTPException(status_code=404, detail="Unknown linkage type")
    return {"profiles": [{"name": p["name"], "updated_at": p["updated_at"]} for p in profiles.list(kind)]}


@app.get("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_get(kind: str, name: str):
    item = _get_profile(*_profile_key(kind, name))
    if item is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return item["payload"]


@app.put("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_save(kind: str, name: str, body: LinkageProfileBody):
    kind, name = _profile_key(kind, name)
    existed = profiles.save(kind, name, {"params": body.params, "search": body.search, "chart_settings": body.chart_settings})
    return {"status": "updated" if existed else "saved", "name": name}


@app.delete("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_delete(kind: str, name: str):
    if not profiles.delete(*_profile_key(kind, name)):
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"status": "deleted"}


# ─── Bar materials ───────────────────────────────────────────────
# A material is a modulus and a strength. The two built-in ones are indicative values for
# printed parts; custom ones are kept with the profiles, under a kind no linkage uses.

BUILTIN_MATERIALS = {
    "PETG Basic (bamb)": {"modulus_mpa": 1950.0, "strength_mpa": 75.0},
    "PETG Translucent (bamb)": {"modulus_mpa": 1610.0, "strength_mpa": 68.0},
    "PLA Basic (bamb)": {"modulus_mpa": 2750.0, "strength_mpa": 76.0},
    "ABS (bamb)": {"modulus_mpa": 1880.0, "strength_mpa": 62.0},
}
_MATERIAL_KIND = "material"


class MaterialBody(BaseModel):
    modulus_mpa: float = Field(..., gt=0, le=1e6)
    strength_mpa: float = Field(..., ge=0, le=1e5)


def _material_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= 60 or "/" in name or any(ord(ch) < 32 for ch in name):
        raise HTTPException(status_code=400, detail="Material name must be 1 to 60 characters, without slashes")
    if name.lower() in {key.lower() for key in BUILTIN_MATERIALS}:
        raise HTTPException(status_code=409, detail=f"{name} is a built-in material: save yours under another name")
    return name


@app.get("/api/linkage/materials")
def linkage_materials():
    items = [{"name": name, **values, "builtin": True} for name, values in BUILTIN_MATERIALS.items()]
    for row in linkage_storage.list_profiles(_MATERIAL_KIND):
        values = linkage_storage.get_profile(_MATERIAL_KIND, row["name"]) or {}
        items.append({"name": row["name"], "modulus_mpa": values.get("modulus_mpa"), "strength_mpa": values.get("strength_mpa"), "builtin": False})
    return {"materials": items}


@app.put("/api/linkage/materials/{name}")
def linkage_material_save(name: str, body: MaterialBody):
    name = _material_name(name)
    existed = linkage_storage.save_profile(_MATERIAL_KIND, name, {"modulus_mpa": body.modulus_mpa, "strength_mpa": body.strength_mpa})
    return {"status": "updated" if existed else "saved", "name": name}


@app.delete("/api/linkage/materials/{name}")
def linkage_material_delete(name: str):
    if not linkage_storage.delete_profile(_MATERIAL_KIND, _material_name(name)):
        raise HTTPException(status_code=404, detail="Material not found")
    return {"status": "deleted"}
