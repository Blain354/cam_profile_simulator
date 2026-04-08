"""
FastAPI backend for the cam profile simulation.
Run with: uvicorn backend.main:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from simulation import SimulationParams, compute_simulation
import dataclasses


app = FastAPI(title="Cam Profile Simulation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    )
    result = compute_simulation(params)
    return dataclasses.asdict(result)


import os
import json
from fastapi import HTTPException

CONFIGS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "configs")

@app.get("/api/configs")
def list_configs():
    if not os.path.exists(CONFIGS_DIR):
        return {"configs": []}
    files = [f for f in os.listdir(CONFIGS_DIR) if f.endswith(".json") and f != "default_config.json"]
    return {"configs": files}

@app.get("/api/configs/default")
def get_default_config():
    path = os.path.join(CONFIGS_DIR, "default_config.json")
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {"default": None}

@app.post("/api/configs/default/{name}")
def set_default_config(name: str):
    path = os.path.join(CONFIGS_DIR, "default_config.json")
    with open(path, "w") as f:
        json.dump({"default": name}, f)
    return {"status": "set", "default": name}

@app.get("/api/configs/{name}")
def get_config(name: str):
    file_path = os.path.join(CONFIGS_DIR, name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Config not found")
    with open(file_path, "r") as f:
        return json.load(f)

@app.put("/api/configs/{name}")
def update_config(name: str, req: SimRequest):
    file_path = os.path.join(CONFIGS_DIR, name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Config not found")
    with open(file_path, "w") as f:
        json.dump(req.model_dump(), f, indent=2)
    return {"status": "updated", "filename": name}

@app.delete("/api/configs/{name}")
def delete_config(name: str):
    file_path = os.path.join(CONFIGS_DIR, name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Config not found")
    os.remove(file_path)
    return {"status": "deleted"}

@app.post("/api/save-config")
def save_config(req: SimRequest):
    if not os.path.exists(CONFIGS_DIR):
        os.makedirs(CONFIGS_DIR, exist_ok=True)
    
    import datetime
    now = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    
    # Find highest count among all json files by splitting at "_"
    max_count = 0
    for f in os.listdir(CONFIGS_DIR):
        if f.endswith(".json"):
            parts = f.replace(".json", "").split("_")
            if parts:
                try:
                    c = int(parts[-1])
                    if c > max_count:
                        max_count = c
                except (ValueError, IndexError):
                    continue
    
    name = f"{now}_{max_count + 1}.json"
    
    file_path = os.path.join(CONFIGS_DIR, name)
    with open(file_path, "w") as f:
        json.dump(req.model_dump(), f, indent=2)
    return {"status": "saved", "filename": name}

@app.get("/api/health")
def health():
    return {"status": "ok"}
