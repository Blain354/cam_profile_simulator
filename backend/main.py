"""
FastAPI backend for the cam profile simulation.
Run with: uvicorn backend.main:app --reload
"""

import dataclasses
import json
import queue
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from simulation import SimulationParams, compute_simulation, SolverParams, SolverResult, solve_cam_profile
from storage import BuilderExperienceStorage, SimulationStorage, default_db_path


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
