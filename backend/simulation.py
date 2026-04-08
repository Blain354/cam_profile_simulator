"""
Simulation logic for the cam profile valve simulation.
Extracted from simulation_came.py for use as a FastAPI backend module.
"""

import numpy as np
from math import exp
from dataclasses import dataclass
from typing import List


@dataclass
class SimulationParams:
    motor_speed: float = 100.0       # RPM
    height: float = 2.0              # mm
    thickness: float = 2.5           # mm
    K: float = 2.0                   # gain
    deadband: float = 1.5            # mm
    default_distance: float = 0.35   # mm
    bushing_diameter: float = 3.0    # mm
    lead_screw_pitch: float = 0.5    # mm
    tube_id: float = 2.0             # mm
    tube_od: float = 3.0             # mm
    input_pressure_psi: float = 30.0 # psi
    compliance: float = 0.7          # mm/MPa - tube opening per unit pressure


@dataclass
class SimulationResult:
    # Cam profile
    cam_X: List[float]
    cam_Y: List[float]
    # Distance vs Y
    Y_positions: List[float]
    min_gaps: List[float]
    flow_area: List[float]
    flow_l_min: List[float]
    # Distance vs Time
    time_axis_ms: List[float]
    # Derived values
    gap_at_Y0: float
    default_distance: float
    deadband: float
    height: float
    linear_speed_mm_s: float
    ctrl_length: float
    Y_start: float
    Y_end: float


def compute_simulation(params: SimulationParams) -> SimulationResult:
    bushing_radius = params.bushing_diameter / 2.0
    X_wall_straight = bushing_radius + params.default_distance

    # Bézier control point
    ctrl_length = params.height * (1.0 - (exp(params.K) - 1.0) / (params.K * exp(params.K)))

    # Quadratic Bézier control points (Y, X)
    P0 = np.array([-params.deadband / 2.0, X_wall_straight])
    P1 = np.array([-params.deadband / 2.0 + ctrl_length, X_wall_straight])
    P2 = np.array([-params.deadband / 2.0 + params.height, X_wall_straight + params.thickness])

    # Sample Bézier
    N_BEZIER = 300
    t_bez = np.linspace(0, 1, N_BEZIER)
    bezier_points = (
        np.outer((1 - t_bez)**2, P0)
        + np.outer(2 * t_bez * (1 - t_bez), P1)
        + np.outer(t_bez**2, P2)
    )
    bezier_Y = bezier_points[:, 0]
    bezier_X = bezier_points[:, 1]

    # Straight section
    N_STRAIGHT = 100
    straight_Y = np.linspace(-params.deadband / 2.0 - 10.0, -params.deadband / 2.0, N_STRAIGHT)
    straight_X = np.full(N_STRAIGHT, X_wall_straight)

    # Extension beyond curve
    N_EXT = 50
    ext_Y = np.linspace(-params.deadband / 2.0 + params.height,
                        -params.deadband / 2.0 + params.height + 5.0, N_EXT)
    ext_X = np.full(N_EXT, X_wall_straight + params.thickness)

    cam_Y = np.concatenate([straight_Y, bezier_Y, ext_Y])
    cam_X = np.concatenate([straight_X, bezier_X, ext_X])

    # Minimum distance computation
    Y_start = -params.deadband / 2.0 - 1.0
    Y_end = -params.deadband / 2.0 + params.height + 1.0
    N_SIM = 500
    Y_positions = np.linspace(Y_start, Y_end, N_SIM)
    min_gaps = np.zeros(N_SIM)

    for i, Y_pos in enumerate(Y_positions):
        distances = np.sqrt(cam_X**2 + (cam_Y - Y_pos)**2)
        # Account for 0.25mm play between axis and bushing
        gap = distances.min() - bushing_radius + 0.25
        min_gaps[i] = gap

    # Compliance: pressure-assisted tube opening
    # compliance (mm/MPa) * pressure (MPa) = opening (mm)
    # Direct empirical parameter: how much the tube opens per unit of internal pressure
    pressure_mpa = params.input_pressure_psi * 0.00689476  # PSI -> MPa
    compliance_opening = params.compliance * pressure_mpa  # mm

    R_inner = params.tube_id / 2.0
    flow_area = np.zeros(N_SIM)

    for i, gap in enumerate(min_gaps):
        # Effective inner gap: mechanical gap minus two wall thicknesses + pressure-assisted opening
        inner_gap = gap - (params.tube_od - params.tube_id) + compliance_opening

        if inner_gap <= 0:
            flow_area[i] = 0.0
        else:
            # Pinch area model (stadium/slot shape)
            # A flattened tube opens as a slot: width ≈ (π/2 * ID)
            width = (np.pi / 2.0) * params.tube_id
            area = width * inner_gap
            # Cap at full open circular area
            flow_area[i] = min(area, np.pi * (R_inner**2))

    # Compressible flow model for air through pinch orifice
    # Constants
    gamma = 1.4          # ratio of specific heats for air
    R_air = 287.05       # J/(kg·K) specific gas constant
    T = 293.15           # K (20°C ambient)
    P_atm = 101325.0     # Pa atmospheric
    Cd = 0.62            # discharge coefficient

    pressure_pa = params.input_pressure_psi * 6894.76
    P_upstream = P_atm + pressure_pa  # absolute upstream pressure (Pa)
    rho_upstream = P_upstream / (R_air * T)  # upstream density (kg/m³)

    # Critical pressure ratio for choked flow
    P_ratio = P_upstream / P_atm
    P_crit = ((gamma + 1) / 2.0) ** (gamma / (gamma - 1))  # ≈ 1.893

    if P_ratio >= P_crit:
        # Choked flow: velocity limited to sonic at the throat
        T_star = T * 2.0 / (gamma + 1)  # throat temperature
        v_star = np.sqrt(gamma * R_air * T_star)  # sonic velocity at throat
        rho_star = rho_upstream * (2.0 / (gamma + 1)) ** (1.0 / (gamma - 1))
        q_m3s = Cd * (flow_area * 1e-6) * rho_star * v_star / rho_upstream
    else:
        # Subsonic isentropic flow
        pr = P_atm / P_upstream  # downstream/upstream ratio
        v_sub = np.sqrt(
            2.0 * gamma / (gamma - 1) * R_air * T
            * (1.0 - pr ** ((gamma - 1) / gamma))
        )
        rho_exit = rho_upstream * pr ** (1.0 / gamma)
        q_m3s = Cd * (flow_area * 1e-6) * rho_exit * v_sub / rho_upstream

    flow_l_min = q_m3s * 60 * 1000  # m³/s -> L/min
    
    gap_at_Y0 = float(np.interp(0.0, Y_positions, min_gaps))

    # Kinematics
    linear_speed = params.motor_speed * params.lead_screw_pitch  # mm/min
    linear_speed_mm_s = linear_speed / 60.0
    total_travel = Y_end - Y_start
    travel_time_s = total_travel / linear_speed_mm_s if linear_speed_mm_s > 0 else 0
    time_axis = np.linspace(0, travel_time_s * 1000, N_SIM)  # ms

    # Downsample cam profile for JSON (every 3rd point)
    cam_step = 3
    return SimulationResult(
        cam_X=cam_X[::cam_step].tolist(),
        cam_Y=cam_Y[::cam_step].tolist(),
        Y_positions=Y_positions.tolist(),
        min_gaps=min_gaps.tolist(),
        flow_area=flow_area.tolist(),
        flow_l_min=flow_l_min.tolist(),
        time_axis_ms=time_axis.tolist(),
        gap_at_Y0=gap_at_Y0,
        default_distance=params.default_distance,
        deadband=params.deadband,
        height=params.height,
        linear_speed_mm_s=linear_speed_mm_s,
        ctrl_length=ctrl_length,
        Y_start=Y_start,
        Y_end=Y_end,
    )
