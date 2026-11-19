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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from simulation import SimulationParams, compute_simulation, SolverParams, SolverResult, solve_cam_profile
from storage import LINKAGE_KINDS, BuilderExperienceStorage, LinkageProfileStorage, SimulationStorage, default_db_path

import onshape_export
import onshape_variables
from linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage


app = FastAPI(title="Cam Profile Simulation API")

_solve_stream_cancel_lock = threading.Lock()
_active_solve_cancel_event: Optional[threading.Event] = None
_active_solve_terminate_event: Optional[threading.Event] = None
_solve_candidates_cache_lock = threading.Lock()
_solve_candidates_cache: dict[str, list] = {}
_solve_candidates_cache_order: list[str] = []
_MAX_SOLVE_CANDIDATE_SETS = 6
storage = SimulationStorage(default_db_path())
builder_storage = BuilderExperienceStorage(default_db_path())
linkage_storage = LinkageProfileStorage(default_db_path())

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://cam-profile-sim.blain-projects.ca",
        "http://localhost:5173",
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
            storage.migrate_legacy_configs_from_dir(cfg_dir)
            break


class SimRequest(BaseModel):
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
    input_pressure_psi: float = 30.0
    compliance: float = 0.7
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
        input_pressure_psi=req.input_pressure_psi,
        compliance=req.compliance,
        chamber_volume_ml=req.chamber_volume_ml,
    )
    result = compute_simulation(params)
    return dataclasses.asdict(result)


class SolveRequest(BaseModel):
    motor_speed: float = 100.0
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_psi: float = 30.0
    chamber_volume_ml: float = 5.0
    compliance: float = 0.7
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


class BuilderExperienceSaveRequest(BaseModel):
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
        input_pressure_psi=req.input_pressure_psi,
        chamber_volume_ml=req.chamber_volume_ml,
        compliance=req.compliance,
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
    result = solve_cam_profile(_solver_params_from_request(req))
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


@app.get("/api/configs")
def list_configs():
    return {"configs": storage.list_configs()}

@app.get("/api/configs/default")
def get_default_config():
    return {"default": storage.get_default_config()}

@app.post("/api/configs/default/{name}")
def set_default_config(name: str):
    storage.set_default_config(name)
    return {"status": "set", "default": name}

@app.get("/api/configs/{name}")
def get_config(name: str):
    cfg = storage.get_config(name)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Config not found")
    return cfg

@app.put("/api/configs/{name}")
def update_config(name: str, req: SimRequest):
    ok = storage.update_config(name, req.model_dump())
    if not ok:
        raise HTTPException(status_code=404, detail="Config not found")
    return {"status": "updated", "filename": name}

@app.delete("/api/configs/{name}")
def delete_config(name: str):
    ok = storage.delete_config(name)
    if not ok:
        raise HTTPException(status_code=404, detail="Config not found")
    return {"status": "deleted"}

@app.post("/api/save-config")
def save_config(req: SimRequest):
    name = storage.save_new_config(req.model_dump())
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


class STLExportRequest(BaseModel):
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
    input_pressure_psi: Optional[float] = None
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


@app.get("/api/builder-experiences")
def list_builder_experiences():
    return {"experiences": builder_storage.list_experiences()}


@app.get("/api/builder-experiences/{name}")
def get_builder_experience(name: str):
    item = builder_storage.get_experience(name)
    if item is None:
        raise HTTPException(status_code=404, detail="Experience not found")
    return item


@app.post("/api/builder-experiences")
def save_builder_experience(req: BuilderExperienceSaveRequest):
    filename = builder_storage.save_experience(
        builder_params=req.builder_params,
        solver_result=req.solver_result,
        note=req.note or "",
        last_solve_request=req.last_solve_request,
    )
    return {"status": "saved", "filename": filename}


@app.put("/api/builder-experiences/{name}")
def update_builder_experience(name: str, req: BuilderExperienceSaveRequest):
    ok = builder_storage.update_experience(
        name=name,
        builder_params=req.builder_params,
        solver_result=req.solver_result,
        note=req.note or "",
        last_solve_request=req.last_solve_request,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Experience not found")
    return {"status": "updated", "filename": name}


@app.delete("/api/builder-experiences/{name}")
def delete_builder_experience(name: str):
    ok = builder_storage.delete_experience(name)
    if not ok:
        raise HTTPException(status_code=404, detail="Experience not found")
    return {"status": "deleted"}


# ─── Bar linkage pinch valves ────────────────────────────────────

class LinkageRequest(BaseModel):
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
    input_pressure_psi: float = 15.0
    compliance: float = 0.7
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
    compliant: bool = False
    carriage_clamped: bool = False
    carriage_pin_diameter: float = Field(1.5, ge=0, le=100)
    carriage_pin_length: float = Field(8.0, ge=0, le=1000)
    member_strength_mpa: float = Field(40.0, ge=0, le=1e5)
    carriage_pin_strength_mpa: float = Field(300.0, ge=0, le=1e5)


class LinkageOptimizeRequest(LinkageRequest):
    bar1_min: float = 6.0
    bar1_max: float = 20.0
    bar2_min: float = 3.0
    bar2_max: float = 14.0
    lever_min: float = 10.0
    lever_max: float = 22.0
    anchor_min: float = 0.0
    anchor_max: float = 6.0
    foot_min: float = Field(1.0, ge=0, le=50)
    foot_max: float = Field(6.0, ge=0, le=50)
    foot_angle_min: float = Field(45.0, ge=0, le=180)
    foot_angle_max: float = Field(135.0, ge=0, le=180)
    min_pivot_height: float = 3.0
    max_pivot_height: float = 16.0
    max_oversqueeze: float = 0.5
    objective: str = "response"
    max_stroke: float = Field(3.0, gt=0, le=50)


def _linkage_params(req: LinkageRequest) -> LinkageParams:
    names = [f.name for f in dataclasses.fields(LinkageParams)]
    return LinkageParams(**{n: getattr(req, n) for n in names})


@app.post("/api/linkage/simulate")
def linkage_simulate(req: LinkageRequest):
    return dataclasses.asdict(compute_linkage(_linkage_params(req)))


@app.post("/api/linkage/optimize")
def linkage_optimize(req: LinkageOptimizeRequest):
    params = _linkage_params(req)
    names = [f.name for f in dataclasses.fields(LinkageSearch)]
    best, feasible, tested, report = optimize_linkage(params, LinkageSearch(**{n: getattr(req, n) for n in names}))
    if best is None:
        return {"found": False, "feasible": feasible, "tested": tested, "search_report": report}
    return {
        "found": True,
        "feasible": feasible,
        "tested": tested,
        "search_report": report,
        "params": dataclasses.asdict(best),
        "result": dataclasses.asdict(compute_linkage(best)),
    }


# ─── Linkage dimensions to the Onshape variable table ────────────

class LinkageOnshapeApplyRequest(LinkageRequest):
    names: list[str] = Field(default_factory=list, max_length=100)
    create_missing: bool = False


def _onshape_variables(call):
    try:
        return call()
    except onshape_variables.LinkageOnshapeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except onshape_export.OnshapeConfigError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except onshape_export.OnshapeAPIError as exc:
        raise HTTPException(status_code=502, detail=f"Onshape refused the request: {exc}")


@app.post("/api/linkage/onshape/preview")
def linkage_onshape_preview(req: LinkageRequest):
    """What writing this design to Onshape would change. Reads only."""
    return _onshape_variables(lambda: onshape_variables.preview(_linkage_params(req)))


@app.post("/api/linkage/onshape/apply")
def linkage_onshape_apply(req: LinkageOnshapeApplyRequest):
    """Overwrite the named Onshape variables with this design's values."""
    return _onshape_variables(lambda: onshape_variables.apply(_linkage_params(req), req.names, req.create_missing))


# ─── Saved linkage profiles ──────────────────────────────────────

class LinkageProfileBody(BaseModel):
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
    return {"profiles": linkage_storage.list_profiles(kind)}


@app.get("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_get(kind: str, name: str):
    item = linkage_storage.get_profile(*_profile_key(kind, name))
    if item is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return item


@app.put("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_save(kind: str, name: str, body: LinkageProfileBody):
    kind, name = _profile_key(kind, name)
    existed = linkage_storage.save_profile(kind, name, {"params": body.params, "search": body.search, "chart_settings": body.chart_settings})
    return {"status": "updated" if existed else "saved", "name": name}


@app.delete("/api/linkage/profiles/{kind}/{name}")
def linkage_profile_delete(kind: str, name: str):
    if not linkage_storage.delete_profile(*_profile_key(kind, name)):
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"status": "deleted"}


# ─── Bar materials ───────────────────────────────────────────────
# A material is a modulus and a strength. The two built-in ones are indicative values for
# printed parts; custom ones are kept with the profiles, under a kind no linkage uses.

BUILTIN_MATERIALS = {
    "PETG": {"modulus_mpa": 2500.0, "strength_mpa": 40.0},
    "PLA": {"modulus_mpa": 3500.0, "strength_mpa": 50.0},
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
