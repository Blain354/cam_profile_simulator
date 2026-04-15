"""
Simulation logic for the cam profile valve simulation.
Extracted from simulation_came.py for use as a FastAPI backend module.
"""

import math
import uuid
import numpy as np
from math import exp
import dataclasses
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

MAX_RETURNED_CANDIDATES = 100

# How feasible triples are ordered for the aggressivity slider (mutually exclusive).
CANDIDATE_RANK_EQUALIZATION_REL = "equalization_rel_time"
CANDIDATE_RANK_FLOW_20_80 = "flow_rise_20_80"
CANDIDATE_RANK_FLOW_EXP = "flow_exp"
CANDIDATE_RANK_FLOW_AT_Y = "flow_at_y"
DEFAULT_CANDIDATE_RANK_BY = CANDIDATE_RANK_FLOW_20_80

# Clamp for “static flow at Y” ranking (mm).
_MIN_RANK_FLOW_Y_MM = 1e-6
_MAX_RANK_FLOW_Y_MM = 100.0

# Linear rise-rate rank: (Q_hi − Q_lo) / (Y_hi − Y_lo) on the monotone envelope for Y ≥ 0.
FLOW_LINEAR_SLOPE_Q_LO_FRAC = 0.05
FLOW_LINEAR_SLOPE_Q_HI_FRAC = 0.25

# Exponential rank: least-squares fit uses only samples whose monotone static flow lies between these
# fractions of Q_sat (excludes near-zero foot and saturation plateau).
FLOW_EXP_FIT_Q_MIN_FRAC = 0.05
FLOW_EXP_FIT_Q_MAX_FRAC = 0.95


# --- Physical constants ---
GAMMA = 1.4          # ratio of specific heats for air
R_AIR = 287.05       # J/(kg·K) specific gas constant
T_AMB = 293.15       # K (20°C ambient)
P_ATM = 101325.0     # Pa atmospheric
CD = 0.62            # discharge coefficient
P_CRIT = ((GAMMA + 1) / 2.0) ** (GAMMA / (GAMMA - 1))  # ≈ 1.893

# Radial play (mm) between lead-screw axis and bushing. In compute_simulation this is *added* to the
# geometric clearance (dist − R_bushing). CAD default_distance is for the bushing centered on the axis,
# so to target a physical opening gap G (e.g. theoretical × safety factor), use default_distance ≈ G − AXIS_BUSHING_PLAY_MM.
AXIS_BUSHING_PLAY_MM = 0.25

def _target_free_air_ml_for_chamber_fill(chamber_volume_ml: float, input_pressure_psi: float) -> float:
    """
    Mass of air needed to bring a rigid chamber of volume chamber_volume_ml from
    atmospheric pressure to line (absolute) pressure, expressed as equivalent volume
    at ambient pressure (same convention as compute_simulation total_volume_ml).

    Ideal gas, isothermal: Δm = (P_up - P_atm) * V / (R T)
    Equivalent free-air volume: Δm * R T / P_atm = V * (P_up - P_atm) / P_atm
    """
    pressure_pa = input_pressure_psi * 6894.76
    p_up = P_ATM + pressure_pa
    return float(chamber_volume_ml * (p_up - P_ATM) / P_ATM)


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
    chamber_volume_ml: float = 0.0   # mL (0 = static model / infinite volume)


@dataclass
class SimulationResult:
    # Cam profile
    cam_X: List[float]
    cam_Y: List[float]
    # Distance vs Y
    Y_positions: List[float]
    min_gaps: List[float]
    flow_area: List[float]
    flow_l_min: List[float]           # static model (P_downstream = P_atm always)
    # Dynamic chamber model (only populated when chamber_volume_ml > 0)
    dynamic_flow_l_min: List[float]
    chamber_pressure_kpa: List[float]  # absolute static pressure, kPa (P_Pa/1000)
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
    equalization_time_ms: float       # time when P_chamber >= 0.99 * P_upstream (-1 if never)
    total_volume_ml: float            # integrated volume that entered the chamber


def _compute_orifice_mass_flow_rate(area_mm2: float, P_up: float, P_down: float) -> float:
    """
    Compressible orifice mass flow rate (kg/s).
    area_mm2: orifice area in mm²
    P_up / P_down: absolute pressures in Pa
    Returns mass flow rate in kg/s.
    """
    if area_mm2 <= 0 or P_up <= P_down or P_down <= 0:
        return 0.0

    area_m2 = area_mm2 * 1e-6
    rho_up = P_up / (R_AIR * T_AMB)
    ratio = P_up / P_down

    if ratio >= P_CRIT:
        T_star = T_AMB * 2.0 / (GAMMA + 1)
        v_star = np.sqrt(GAMMA * R_AIR * T_star)
        rho_star = rho_up * (2.0 / (GAMMA + 1)) ** (1.0 / (GAMMA - 1))
        return CD * area_m2 * rho_star * v_star
    else:
        pr = P_down / P_up
        v_sub = np.sqrt(
            2.0 * GAMMA / (GAMMA - 1) * R_AIR * T_AMB
            * (1.0 - pr ** ((GAMMA - 1) / GAMMA))
        )
        rho_exit = rho_up * pr ** (1.0 / GAMMA)
        return CD * area_m2 * rho_exit * v_sub


def _max_static_flow_l_min_full_opening(params: SimulationParams) -> float:
    """
    Static-model flow (L/min) when the effective orifice area reaches the tube inner circle cap
    π (ID/2)² — the same upper bound used in compute_simulation for flow_area.
    For fixed tube_id and upstream pressure this is independent of cam geometry.
    """
    r_inner = params.tube_id / 2.0
    max_area_mm2 = float(np.pi * (r_inner**2))
    pressure_pa = params.input_pressure_psi * 6894.76
    p_upstream = P_ATM + pressure_pa
    rho_upstream = p_upstream / (R_AIR * T_AMB)
    mdot = _compute_orifice_mass_flow_rate(max_area_mm2, p_upstream, P_ATM)
    q_m3s = mdot / rho_upstream
    return float(q_m3s * 60.0 * 1000.0)


def _compute_static_flow_vs_y_arrays(
    params: SimulationParams,
    cam_x: np.ndarray,
    cam_y: np.ndarray,
    bushing_radius: float,
    y_start: float,
    y_end: float,
    n_sim: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Sample Y from y_start..y_end and return Y, min_gaps, flow_area, static_flow_l_min."""
    y_positions = np.linspace(y_start, y_end, n_sim)
    min_gaps = np.zeros(n_sim)
    for i, y_pos in enumerate(y_positions):
        distances = np.sqrt(cam_x**2 + (cam_y - y_pos) ** 2)
        gap = distances.min() - bushing_radius + AXIS_BUSHING_PLAY_MM
        min_gaps[i] = gap

    pressure_mpa = params.input_pressure_psi * 0.00689476
    compliance_opening = params.compliance * pressure_mpa
    r_inner = params.tube_id / 2.0
    flow_area = np.zeros(n_sim)
    for i, gap in enumerate(min_gaps):
        inner_gap = gap - (params.tube_od - params.tube_id) + compliance_opening
        if inner_gap <= 0:
            flow_area[i] = 0.0
        else:
            width = (np.pi / 2.0) * params.tube_id
            area = width * inner_gap
            flow_area[i] = min(area, np.pi * (r_inner**2))

    pressure_pa = params.input_pressure_psi * 6894.76
    p_upstream = P_ATM + pressure_pa
    rho_upstream = p_upstream / (R_AIR * T_AMB)
    static_flow_l_min = np.zeros(n_sim)
    for i in range(n_sim):
        mdot = _compute_orifice_mass_flow_rate(flow_area[i], p_upstream, P_ATM)
        q_m3s = mdot / rho_upstream
        static_flow_l_min[i] = q_m3s * 60.0 * 1000.0

    return y_positions, min_gaps, flow_area, static_flow_l_min


def _trim_y_domain_after_static_plateau(
    y_positions: np.ndarray,
    min_gaps: np.ndarray,
    flow_area: np.ndarray,
    static_flow: np.ndarray,
    *,
    window: int = 28,
    pad_points: int = 18,
    rel_spread: float = 8e-4,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Shorten the Y sample domain once static flow has clearly reached a plateau (near global max).
    Avoids long flat tails in flow-vs-Y plots when Y_end was set large (e.g. absolute cap).
    """
    f = np.asarray(static_flow, dtype=float)
    n = f.size
    if n < window + 3:
        return y_positions, min_gaps, flow_area, static_flow
    q_peak = float(np.max(f))
    if q_peak <= 1e-15:
        return y_positions, min_gaps, flow_area, static_flow
    abs_spread = max(rel_spread * q_peak, 1e-12)

    trim_end = n
    for k in range(0, n - window + 1):
        win = f[k : k + window]
        if float(np.max(win)) < q_peak - 3.0 * abs_spread:
            continue
        if float(np.max(win) - np.min(win)) > abs_spread:
            continue
        trim_end = min(n, k + window + pad_points)
        break

    if trim_end >= n:
        return y_positions, min_gaps, flow_area, static_flow

    return (
        y_positions[:trim_end].copy(),
        min_gaps[:trim_end].copy(),
        flow_area[:trim_end].copy(),
        static_flow[:trim_end].copy(),
    )


def _static_flow_plateau_reached_for_extension(
    static_flow: np.ndarray,
    q_ceiling: float,
    rel_ceiling_tol: float,
    *,
    window: int = 24,
    rel_plateau_spread: float = 8e-4,
) -> bool:
    """True if static flow has hit the physical ceiling or a sustained high plateau (solver extension can stop)."""
    f = np.asarray(static_flow, dtype=float)
    q_max = float(np.max(f))
    if q_max >= q_ceiling * (1.0 - rel_ceiling_tol):
        return True
    n = f.size
    if n < window or q_max <= 1e-15:
        return False
    abs_spread = max(rel_plateau_spread * q_max, 1e-12)
    for k in range(0, n - window + 1):
        win = f[k : k + window]
        if float(np.max(win)) < q_max - 3.0 * abs_spread:
            continue
        if float(np.max(win) - np.min(win)) <= abs_spread:
            return True
    return False


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

    cam_y = np.concatenate([straight_Y, bezier_Y, ext_Y])
    cam_x = np.concatenate([straight_X, bezier_X, ext_X])

    linear_speed = params.motor_speed * params.lead_screw_pitch  # mm/min
    linear_speed_mm_s = linear_speed / 60.0
    # Y span: extend until static flow reaches the physical plateau (full-opening cap) or a local plateau,
    # but Y_end never exceeds this absolute position (mm along the cam Y axis).
    abs_y_end_cap_mm = 5.0
    y_start = -params.deadband / 2.0 - 1.0
    y_end_geom = -params.deadband / 2.0 + params.height + 1.0
    y_end_max = abs_y_end_cap_mm
    y_end = min(float(y_end_geom), float(y_end_max))
    n_sim = 500
    q_ceiling = _max_static_flow_l_min_full_opening(params)
    y_extend_mm = 3.0
    rel_ceiling_tol = 1e-4
    q_prev_max = -1.0

    y_positions: np.ndarray
    min_gaps: np.ndarray
    flow_area: np.ndarray
    static_flow_l_min: np.ndarray

    for _ in range(120):
        y_positions, min_gaps, flow_area, static_flow_l_min = _compute_static_flow_vs_y_arrays(
            params, cam_x, cam_y, bushing_radius, y_start, y_end, n_sim
        )
        q_max = float(np.max(static_flow_l_min))

        if _static_flow_plateau_reached_for_extension(static_flow_l_min, q_ceiling, rel_ceiling_tol):
            break
        if y_end >= y_end_max - 1e-9:
            break
        if q_prev_max >= 0.0 and abs(q_max - q_prev_max) / max(q_max, 1e-12) < 1e-7:
            break
        q_prev_max = q_max
        y_end = min(y_end + y_extend_mm, float(y_end_max))

    y_positions, min_gaps, flow_area, static_flow_l_min = _trim_y_domain_after_static_plateau(
        y_positions, min_gaps, flow_area, static_flow_l_min
    )

    Y_start = y_start
    Y_end = float(y_positions[-1])
    N_SIM = int(y_positions.size)
    gap_at_Y0 = float(np.interp(0.0, y_positions, min_gaps))

    pressure_pa = params.input_pressure_psi * 6894.76
    P_upstream = P_ATM + pressure_pa
    rho_upstream = P_upstream / (R_AIR * T_AMB)

    total_travel = Y_end - Y_start
    travel_time_s = total_travel / linear_speed_mm_s if linear_speed_mm_s > 0 else 0
    time_axis = np.linspace(0, travel_time_s * 1000, N_SIM)  # ms

    # --- Dynamic chamber model ---
    dynamic_flow_l_min = np.zeros(N_SIM)
    chamber_pressure_kpa = np.zeros(N_SIM)
    equalization_time_ms = -1.0
    total_volume_ml = 0.0

    if params.chamber_volume_ml > 0 and linear_speed_mm_s > 0:
        V_chamber_m3 = params.chamber_volume_ml * 1e-6  # mL -> m³
        dt_s = (time_axis[1] - time_axis[0]) / 1000.0 if N_SIM > 1 else 0.0

        # Initial state: chamber at atmospheric pressure
        accumulated_mass = P_ATM * V_chamber_m3 / (R_AIR * T_AMB)
        P_chamber = P_ATM
        equalized = False
        total_volume_m3 = 0.0

        for i in range(N_SIM):
            chamber_pressure_kpa[i] = P_chamber / 1000.0  # Pa -> kPa

            mdot = _compute_orifice_mass_flow_rate(flow_area[i], P_upstream, P_chamber)
            accumulated_mass += mdot * dt_s

            # Isothermal: P = m * R * T / V; cannot exceed supply (physical + numerical cap)
            P_chamber = accumulated_mass * R_AIR * T_AMB / V_chamber_m3
            P_chamber = min(P_chamber, P_upstream)
            accumulated_mass = P_chamber * V_chamber_m3 / (R_AIR * T_AMB)

            # Volumetric flow at upstream density
            q_m3s = mdot / rho_upstream
            dynamic_flow_l_min[i] = q_m3s * 60.0 * 1000.0

            # Accumulate volume (at atmospheric conditions)
            total_volume_m3 += (mdot * dt_s) * R_AIR * T_AMB / P_ATM

            if not equalized and P_chamber >= 0.99 * P_upstream:
                equalization_time_ms = float(time_axis[i])
                equalized = True

        total_volume_ml = total_volume_m3 * 1e6
    else:
        # No dynamic model: copy static values, compute static volume
        dynamic_flow_l_min = static_flow_l_min.copy()
        chamber_pressure_kpa = np.full(N_SIM, P_ATM / 1000.0)

        if linear_speed_mm_s > 0:
            dt_arr = np.diff(time_axis) / 1000.0
            q_m3s_arr = static_flow_l_min / (60.0 * 1000.0)
            avg_q = (q_m3s_arr[:-1] + q_m3s_arr[1:]) / 2.0
            total_volume_ml = float(np.sum(avg_q * dt_arr) * 1e6)

    # Downsample cam profile for JSON (every 3rd point)
    cam_step = 3
    return SimulationResult(
        cam_X=cam_x[::cam_step].tolist(),
        cam_Y=cam_y[::cam_step].tolist(),
        Y_positions=y_positions.tolist(),
        min_gaps=min_gaps.tolist(),
        flow_area=flow_area.tolist(),
        flow_l_min=static_flow_l_min.tolist(),
        dynamic_flow_l_min=dynamic_flow_l_min.tolist(),
        chamber_pressure_kpa=chamber_pressure_kpa.tolist(),
        time_axis_ms=time_axis.tolist(),
        gap_at_Y0=gap_at_Y0,
        default_distance=params.default_distance,
        deadband=params.deadband,
        height=params.height,
        linear_speed_mm_s=linear_speed_mm_s,
        ctrl_length=ctrl_length,
        Y_start=Y_start,
        Y_end=Y_end,
        equalization_time_ms=equalization_time_ms,
        total_volume_ml=total_volume_ml,
    )


# --- Solver ---


def _make_1d_search_grid(
    lo: float,
    hi: float,
    *,
    fixed: bool,
    fixed_v: float,
    mode: str,
    n_samples: int,
    step: float,
    min_linspace: int,
) -> np.ndarray:
    """Build 1D search samples: fixed single value, uniform step, or linspace count."""
    a = float(min(lo, hi))
    b = float(max(lo, hi))
    if fixed:
        return np.array([float(np.clip(fixed_v, a, b))])
    md = (mode or "count").lower()
    if md == "step":
        st = max(1e-9, float(step))
        if b - a < 1e-12:
            return np.array([a])
        n_pts = int(np.floor((b - a) / st)) + 1
        n_pts = max(1, n_pts)
        pts = a + st * np.arange(n_pts, dtype=float)
        pts = pts[pts <= b + 1e-9]
        if pts.size == 0:
            return np.array([a])
        return pts.astype(float)
    n = max(min_linspace, int(n_samples))
    return np.linspace(a, b, n)


@dataclass
class SolverParams:
    motor_speed: float = 100.0
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_psi: float = 30.0
    chamber_volume_ml: float = 5.0
    compliance: float = 0.7
    thickness: float = 2.5
    bushing_diameter: float = 3.0
    lead_screw_pitch: float = 0.5

    # Keep a triple if gap_at_Y0 is in [theoretical_gap_mm − margin, theoretical_gap_mm] (mm); margin >= 0.
    gap_at_y0_margin_mm: float = 0.1

    k_min: float = 0.5
    k_max: float = 8.0
    k_sample_mode: str = "count"  # "count" | "step"
    k_steps: int = 10
    k_step: float = 0.25

    deadband_min: float = 0.1
    deadband_max: float = 8.0
    deadband_sample_mode: str = "count"
    deadband_steps: int = 10
    deadband_step: float = 0.2
    fix_deadband: bool = False
    fixed_deadband: float = 1.5

    h_search_lo: float = 0.05
    h_search_max: float = 40.0
    height_sample_mode: str = "count"
    height_steps: int = 14
    height_step: float = 1.0
    fix_height: bool = False
    fixed_height: float = 2.0

    dd_max_search_mm: float = 25.0
    # Fixed rest gap: theoretical mechanical opening × this factor, minus AXIS_BUSHING_PLAY_MM (see compute_simulation).
    default_distance_safety_factor: float = 0.95
    # If False (default): single rest gap dd = theoretical_gap_mm × safety factor (capped); only K, h, deadband vary.
    # If True: legacy behaviour — binary search for max dd per (K, h, deadband) under gap ceiling.
    optimize_default_distance: bool = False

    fix_k: bool = False
    fixed_k: float = 2.0

    # Ordering of feasible triples for the aggressivity list (see CANDIDATE_RANK_* constants).
    candidate_rank_by: str = DEFAULT_CANDIDATE_RANK_BY
    # Cam travel Y (mm, ≥ 0) at which static flow is read when ``candidate_rank_by`` is flow_at_y.
    candidate_rank_flow_y_mm: float = 1.0


@dataclass
class SolverResult:
    success: bool
    message: str
    height: float
    K: float
    deadband: float
    default_distance: float
    gap_at_Y0: float = 0.0
    theoretical_gap_mm: float = 0.0
    simulation: Optional[SimulationResult] = None
    # Volume-near-optimal configs sorted by effective flow rise-rate (5%–25% linear band) (gradual → snappy).
    candidates: Optional[List[Dict[str, Any]]] = None
    selected_candidate_index: int = 0
    solve_id: Optional[str] = None
    candidate_simulations: Optional[List[SimulationResult]] = None


def _theoretical_mechanical_gap_mm(sp: SolverParams) -> float:
    pressure_mpa = sp.input_pressure_psi * 0.00689476
    return float((sp.tube_od - sp.tube_id) - sp.compliance * pressure_mpa)


def _gap_at_y0_in_acceptable_band(
    g0: float,
    theoretical_mm: float,
    margin_mm: float,
) -> bool:
    """
    True if simulated gap_at_Y0 lies in [max(0, theoretical − margin), theoretical] (mm).
    Margin is an absolute length below the physics opening, not a multiplier.
    """
    m = max(0.0, float(margin_mm))
    lo = max(0.0, float(theoretical_mm) - m)
    hi = float(theoretical_mm)
    tol = 5e-4
    return g0 >= lo - tol and g0 <= hi + tol


def _max_default_distance_for_gap_ceiling(
    sp: SolverParams,
    K: float,
    height: float,
    deadband: float,
    ceiling_mm: float,
) -> Optional[float]:
    """Largest default_distance such that simulated gap_at_Y0 <= ceiling_mm."""

    def gap_at(dd: float) -> float:
        r = compute_simulation(
            SimulationParams(
                motor_speed=sp.motor_speed,
                height=height,
                thickness=sp.thickness,
                K=K,
                deadband=deadband,
                default_distance=dd,
                bushing_diameter=sp.bushing_diameter,
                lead_screw_pitch=sp.lead_screw_pitch,
                tube_id=sp.tube_id,
                tube_od=sp.tube_od,
                input_pressure_psi=sp.input_pressure_psi,
                compliance=sp.compliance,
                chamber_volume_ml=sp.chamber_volume_ml,
            )
        )
        return float(r.gap_at_Y0)

    lo = 0.01
    if gap_at(lo) > ceiling_mm + 1e-6:
        return None

    dd_hi = float(sp.dd_max_search_mm)
    if gap_at(dd_hi) <= ceiling_mm + 1e-9:
        return dd_hi

    left, right = lo, dd_hi
    for _ in range(55):
        if right - left < 5e-4:
            break
        mid = (left + right) * 0.5
        if gap_at(mid) <= ceiling_mm + 1e-9:
            left = mid
        else:
            right = mid
    return float(left)


def _flow_versus_y_slope_l_per_mm(sim: SimulationResult) -> float:
    """
    Effective rise-rate metric on the early ramp (L/min per mm): flow levels
    FLOW_LINEAR_SLOPE_Q_LO_FRAC·Q_max … FLOW_LINEAR_SLOPE_Q_HI_FRAC·Q_max on the monotone envelope.

    This is intentionally more robust than a global OLS slope because deadzone and
    saturation plateaus can bias linear fits. We restrict to Y >= 0 and compute:
        (Q_hi - Q_lo) / (Y_hi - Y_lo)
    where Y_lo / Y_hi are interpolated crossing points on the monotone envelope.
    """
    y = np.asarray(sim.Y_positions, dtype=float)
    f = np.asarray(sim.flow_l_min, dtype=float)
    if y.size < 2 or f.size != y.size:
        return 0.0
    mask = y >= 0.0
    if np.count_nonzero(mask) < 3:
        return 0.0

    yw = y[mask]
    fw = f[mask]
    if len(yw) < 3:
        return 0.0

    # Build monotone envelope to avoid tiny local decreases from numerical noise.
    f_env = np.maximum.accumulate(fw)
    q_max = float(np.max(f_env))
    if q_max <= 1e-9:
        return 0.0

    q_lo = FLOW_LINEAR_SLOPE_Q_LO_FRAC * q_max
    q_hi = FLOW_LINEAR_SLOPE_Q_HI_FRAC * q_max
    if q_hi - q_lo <= 1e-9:
        return 0.0

    def _interp_y_at(level: float) -> Optional[float]:
        idx = np.where(f_env >= level)[0]
        if idx.size == 0:
            return None
        i = int(idx[0])
        if i == 0:
            return float(yw[0])
        y0, y1 = float(yw[i - 1]), float(yw[i])
        f0, f1 = float(f_env[i - 1]), float(f_env[i])
        if abs(f1 - f0) < 1e-12:
            return y1
        t = (level - f0) / (f1 - f0)
        return y0 + t * (y1 - y0)

    y_lo = _interp_y_at(q_lo)
    y_hi = _interp_y_at(q_hi)
    if y_lo is None or y_hi is None:
        return 0.0
    dy = float(y_hi - y_lo)
    if dy <= 1e-6:
        return 0.0
    return float((q_hi - q_lo) / dy)


def _static_flow_at_cam_y_mm(sim: SimulationResult, y_mm: float) -> float:
    """
    Monotone-envelope static flow (L/min) at cam position Y = y_mm (mm), using samples with Y ≥ 0.
    ``y_mm`` is clamped to the simulated Y range after sorting by Y (linear interpolation on Y).
    """
    y = np.asarray(sim.Y_positions, dtype=float)
    f = np.asarray(sim.flow_l_min, dtype=float)
    if y.size < 2 or f.size != y.size:
        return float("nan")
    m = y >= 0.0
    yp = y[m]
    fp = f[m]
    if yp.size < 2:
        return float("nan")
    order = np.argsort(yp)
    ys = yp[order].astype(float)
    fs = fp[order].astype(float)
    f_env = np.maximum.accumulate(fs)
    yt = float(np.clip(y_mm, _MIN_RANK_FLOW_Y_MM, _MAX_RANK_FLOW_Y_MM))
    if yt <= float(ys[0]):
        return float(f_env[0])
    if yt >= float(ys[-1]):
        return float(f_env[-1])
    return float(np.interp(yt, ys, f_env))


def _time_ms_at_y0_crossing(sim: SimulationResult) -> float:
    """Linear crossing time (ms) when cam Y passes 0 (same convention as the UI pressure chart)."""
    y_arr = np.asarray(sim.Y_positions, dtype=float)
    t_arr = np.asarray(sim.time_axis_ms, dtype=float)
    if y_arr.size < 2 or t_arr.size != y_arr.size:
        return 0.0
    for i in range(int(y_arr.size) - 1):
        y0_, y1_ = float(y_arr[i]), float(y_arr[i + 1])
        t0_, t1_ = float(t_arr[i]), float(t_arr[i + 1])
        if (y0_ <= 0.0 <= y1_) or (y0_ >= 0.0 >= y1_):
            den = y1_ - y0_
            if abs(den) < 1e-15:
                return t0_
            ratio = (0.0 - y0_) / den
            return float(t0_ + ratio * (t1_ - t0_))
    return float(t_arr[0])


def _equalization_time_rel_y0_ms(sim: SimulationResult) -> float:
    """
    Time (ms) from nominal opening at Y=0 until chamber pressure reaches the equalized threshold
    (same instant as ``equalization_time_ms`` on the absolute time axis, minus Y=0 crossing time).
    NaN if no dynamic chamber model or equalization never occurs.
    """
    if sim.equalization_time_ms < 0:
        return float("nan")
    y0_t = _time_ms_at_y0_crossing(sim)
    return max(0.0, float(sim.equalization_time_ms) - y0_t)


def _flow_vs_y_exponential_k(sim: SimulationResult) -> float:
    """
    Best-fit rate k (1/mm) for Q(Y) ≈ Q_sat (1 − exp(−k Y)) using **only** the transient rise:
    samples with Y ≥ 0 whose **monotone** static flow lies in
    [FLOW_EXP_FIT_Q_MIN_FRAC · Q_sat, FLOW_EXP_FIT_Q_MAX_FRAC · Q_sat], with Q_sat = max(flow) on Y ≥ 0.
    Squared error is minimized on that band only (plateau and near-zero foot excluded).
    Larger k = faster ramp (snappier); smaller k = more gradual.
    """
    y = np.asarray(sim.Y_positions, dtype=float)
    f = np.asarray(sim.flow_l_min, dtype=float)
    mask = y >= 0.0
    y = y[mask]
    f = f[mask]
    if y.size < 4:
        return float("nan")
    f = np.maximum.accumulate(f.astype(float))
    qmax = float(np.max(f))
    if qmax < 1e-12:
        return float("nan")
    y = np.maximum(y.astype(float), 0.0)

    q_lo = FLOW_EXP_FIT_Q_MIN_FRAC * qmax
    q_hi = FLOW_EXP_FIT_Q_MAX_FRAC * qmax
    if q_hi - q_lo <= 1e-18:
        return float("nan")
    fit_m = (f >= q_lo) & (f <= q_hi)
    y_fit = y[fit_m]
    f_fit = f[fit_m]
    if y_fit.size < 4:
        return float("nan")
    if float(np.max(y_fit) - np.min(y_fit)) < 1e-9:
        return float("nan")

    best_k = 0.0
    best_sse = float("inf")
    for k in np.logspace(-4.0, 3.5, 220):
        pred = qmax * (1.0 - np.exp(-k * y_fit))
        sse = float(np.sum((f_fit - pred) ** 2))
        if sse < best_sse:
            best_sse = sse
            best_k = float(k)
    return best_k


@dataclass
class _ScoredRow:
    rel_err: float
    K: float
    h: float
    db: float
    dd: float
    vol: float
    g0: float
    slope_20_80: float
    eq_rel_ms: float
    exp_k: float
    flow_at_y: float


def _normalize_candidate_rank_by(raw: Optional[str]) -> str:
    s = (raw or "").strip().lower()
    if s in (
        CANDIDATE_RANK_EQUALIZATION_REL,
        CANDIDATE_RANK_FLOW_20_80,
        CANDIDATE_RANK_FLOW_EXP,
        CANDIDATE_RANK_FLOW_AT_Y,
    ):
        return s
    return DEFAULT_CANDIDATE_RANK_BY


def _sort_key_for_aggressivity(row: _ScoredRow, rank_by: str) -> Tuple[float, float, float, float]:
    """
    Sort ascending: left of slider = more gradual, right = snappier.
    - Equalization: longer time to equalize after Y=0 = more gradual (sort by descending time).
    - Linear 5–25% slope: lower rise-rate = gradual.
    - Exponential k: lower k = gradual.
    - Flow at Y: lower static flow at the chosen Y = gradual.
    """
    rb = _normalize_candidate_rank_by(rank_by)
    if rb == CANDIDATE_RANK_EQUALIZATION_REL:
        t = row.eq_rel_ms
        if t != t or math.isnan(t):  # type: ignore[comparison-overlap]
            t = 1e15
        return (-float(t), row.rel_err, row.h, row.db)
    if rb == CANDIDATE_RANK_FLOW_EXP:
        k = row.exp_k
        if k != k or math.isnan(k):  # type: ignore[comparison-overlap]
            k = 0.0
        return (float(k), row.rel_err, row.h, row.db)
    if rb == CANDIDATE_RANK_FLOW_AT_Y:
        q = row.flow_at_y
        if q != q or math.isnan(q):  # type: ignore[comparison-overlap]
            q = 0.0
        return (float(q), row.rel_err, row.h, row.db)
    return (row.slope_20_80, row.rel_err, row.h, row.db)


def _rank_mode_label(rank_by: str, flow_y_mm: float = 1.0) -> str:
    rb = _normalize_candidate_rank_by(rank_by)
    if rb == CANDIDATE_RANK_EQUALIZATION_REL:
        return "equalization time (after Y=0)"
    if rb == CANDIDATE_RANK_FLOW_EXP:
        return "exponential flow-vs-Y fit"
    if rb == CANDIDATE_RANK_FLOW_AT_Y:
        y = float(np.clip(flow_y_mm, _MIN_RANK_FLOW_Y_MM, _MAX_RANK_FLOW_Y_MM))
        return f"static flow at Y={y:.3g} mm"
    return "static flow 5%–25% rise-rate"


class SolveCancelled(Exception):
    """Raised when the client requests cancellation (cancel_event is set)."""


def _ordered_unique_indices(indices: List[int], n: int) -> List[int]:
    out: List[int] = []
    for i in indices:
        ii = int(np.clip(i, 0, n - 1))
        if not out or out[-1] != ii:
            out.append(ii)
    return out


def _expand_index_list_to_count(indices: List[int], n: int, k: int) -> List[int]:
    """Insert midpoints along the largest gaps until we have at least k distinct indices (rare)."""
    s = sorted(set(int(np.clip(i, 0, n - 1)) for i in indices))
    if len(s) >= k:
        return s[:k]
    while len(s) < k:
        best_gap = 0
        best_mid: Optional[int] = None
        for a in range(len(s) - 1):
            lo, hi = s[a], s[a + 1]
            if hi - lo <= 1:
                continue
            mid = (lo + hi) // 2
            if hi - lo > best_gap:
                best_gap = hi - lo
                best_mid = mid
        if best_mid is None:
            break
        s.append(best_mid)
        s.sort()
    return s[:k] if len(s) >= k else s


def _select_evenly_spaced_along_rank_order(
    ordered: List[_ScoredRow],
    max_candidates: int,
) -> List[_ScoredRow]:
    """
    ``ordered``: feasible triples sorted gradual → snappy along the active rank axis.

    Keep up to ``max_candidates`` entries **evenly spaced** along that order, always including
    index 0 (most gradual) and index n−1 (snappiest) when n > max_candidates.
    """
    n = len(ordered)
    if n <= max_candidates:
        return list(ordered)
    k = max_candidates
    raw_idx = [int(round(j * (n - 1) / (k - 1))) for j in range(k)]
    raw_idx[0] = 0
    raw_idx[k - 1] = n - 1
    idx = _ordered_unique_indices(raw_idx, n)
    if len(idx) < k:
        idx = _expand_index_list_to_count(idx, n, k)
    return [ordered[i] for i in idx]


def solve_cam_profile(
    sp: SolverParams,
    progress: Optional[Callable[[int, str, int, int, int], None]] = None,
    cancel_event: Optional[Any] = None,
    terminate_event: Optional[Any] = None,
) -> SolverResult:
    cancel_ev = cancel_event
    terminate_ev = terminate_event

    def _check_cancel() -> None:
        if cancel_ev is not None and cancel_ev.is_set():
            raise SolveCancelled()

    def _should_terminate() -> bool:
        return terminate_ev is not None and terminate_ev.is_set()

    def prog(
        pct: int,
        msg: str,
        feasible_count: int = 0,
        tested_count: int = 0,
        total_count: int = 0,
    ) -> None:
        _check_cancel()
        if progress is not None:
            progress(max(0, min(100, pct)), msg, feasible_count, tested_count, total_count)

    theoretical_gap_mm = _theoretical_mechanical_gap_mm(sp)

    if theoretical_gap_mm <= 0:
        return SolverResult(
            success=False,
            message=f"Impossible: theoretical mechanical gap <= 0 ({theoretical_gap_mm:.4f} mm). "
                    f"Adjust tube dimensions or pressure/compliance.",
            height=0, K=0, deadband=0, default_distance=0.0,
            gap_at_Y0=0.0, theoretical_gap_mm=theoretical_gap_mm,
        )

    prog(1, "Preparing search…", 0, 0, 0)
    margin_mm = max(0.0, float(sp.gap_at_y0_margin_mm))
    gap_band_lo = max(0.0, float(theoretical_gap_mm) - margin_mm)
    gap_band_hi = float(theoretical_gap_mm)
    # Upper bound for binary search on default_distance: never exceed full theoretical opening.
    ceiling_mm = gap_band_hi
    target_vol = _target_free_air_ml_for_chamber_fill(sp.chamber_volume_ml, sp.input_pressure_psi)
    sf = max(0.01, min(1.0, float(sp.default_distance_safety_factor)))
    # Fixed rest gap for whole grid (when not optimizing dd per triple): CAD distance centers the bushing;
    # effective opening includes +AXIS_BUSHING_PLAY_MM in compute_simulation, so subtract it here.
    dd_fixed = max(
        0.01,
        min(
            float(sp.dd_max_search_mm),
            float(theoretical_gap_mm) * sf - AXIS_BUSHING_PLAY_MM,
        ),
    )

    db_lo = min(sp.deadband_min, sp.deadband_max)
    db_hi = max(sp.deadband_min, sp.deadband_max)
    k_lo = min(sp.k_min, sp.k_max)
    k_hi = max(sp.k_min, sp.k_max)
    h_lo = min(sp.h_search_lo, sp.h_search_max)
    h_hi = max(sp.h_search_lo, sp.h_search_max)

    k_grid = _make_1d_search_grid(
        k_lo,
        k_hi,
        fixed=sp.fix_k,
        fixed_v=sp.fixed_k,
        mode=sp.k_sample_mode,
        n_samples=sp.k_steps,
        step=sp.k_step,
        min_linspace=3,
    )
    db_grid = _make_1d_search_grid(
        db_lo,
        db_hi,
        fixed=sp.fix_deadband,
        fixed_v=sp.fixed_deadband,
        mode=sp.deadband_sample_mode,
        n_samples=sp.deadband_steps,
        step=sp.deadband_step,
        min_linspace=3,
    )
    h_grid = _make_1d_search_grid(
        h_lo,
        h_hi,
        fixed=sp.fix_height,
        fixed_v=sp.fixed_height,
        mode=sp.height_sample_mode,
        n_samples=sp.height_steps,
        step=sp.height_step,
        min_linspace=4,
    )

    nk, ndb, nh = len(k_grid), len(db_grid), len(h_grid)
    total_triples = max(1, nk * ndb * nh)

    scored: List[_ScoredRow] = []
    rank_by = _normalize_candidate_rank_by(sp.candidate_rank_by)
    rank_flow_y_mm = float(np.clip(sp.candidate_rank_flow_y_mm, _MIN_RANK_FLOW_Y_MM, _MAX_RANK_FLOW_Y_MM))
    solve_id = uuid.uuid4().hex

    try:
        done = 0
        terminated_early = False
        for K in k_grid:
            if _should_terminate():
                terminated_early = True
                break
            for db in db_grid:
                if _should_terminate():
                    terminated_early = True
                    break
                for h in h_grid:
                    if _should_terminate():
                        terminated_early = True
                        break
                    done += 1
                    # Main work: 5%–88% of total bar (linear in *triples tested*, not wall time — cost/triple varies,
                    # e.g. optimize_default_distance runs a binary search with many compute_simulation calls).
                    pct = 5 + int(83 * done / total_triples)
                    k_tag = f"K={float(K):.2f}" if not sp.fix_k else f"K fixed={float(K):.2f}"
                    grid_msg = (
                        f"Grid {done}/{total_triples} ({k_tag}, deadband={float(db):.2f}, h={float(h):.2f} mm)"
                    )
                    if sp.optimize_default_distance:
                        dd_raw = _max_default_distance_for_gap_ceiling(sp, float(K), float(h), float(db), ceiling_mm)
                        if dd_raw is None:
                            prog(pct, grid_msg, len(scored), done, total_triples)
                            continue
                        dd = max(0.01, float(dd_raw) * sf)
                    else:
                        dd = dd_fixed
                    sim = compute_simulation(
                        SimulationParams(
                            motor_speed=sp.motor_speed,
                            height=float(h),
                            thickness=sp.thickness,
                            K=float(K),
                            deadband=float(db),
                            default_distance=dd,
                            bushing_diameter=sp.bushing_diameter,
                            lead_screw_pitch=sp.lead_screw_pitch,
                            tube_id=sp.tube_id,
                            tube_od=sp.tube_od,
                            input_pressure_psi=sp.input_pressure_psi,
                            compliance=sp.compliance,
                            chamber_volume_ml=sp.chamber_volume_ml,
                        )
                    )
                    vol = sim.total_volume_ml
                    g0 = float(sim.gap_at_Y0)
                    if not _gap_at_y0_in_acceptable_band(g0, theoretical_gap_mm, margin_mm):
                        prog(pct, grid_msg, len(scored), done, total_triples)
                        continue
                    rel_err = abs(vol - target_vol) / max(target_vol, 1e-9)
                    slope = _flow_versus_y_slope_l_per_mm(sim)
                    eq_rel = _equalization_time_rel_y0_ms(sim)
                    exp_k = _flow_vs_y_exponential_k(sim)
                    fy = _static_flow_at_cam_y_mm(sim, rank_flow_y_mm)
                    scored.append(
                        _ScoredRow(
                            rel_err=rel_err,
                            K=float(K),
                            h=float(h),
                            db=float(db),
                            dd=dd,
                            vol=vol,
                            g0=g0,
                            slope_20_80=slope,
                            eq_rel_ms=eq_rel,
                            exp_k=exp_k,
                            flow_at_y=fy,
                        )
                    )
                    prog(pct, grid_msg, len(scored), done, total_triples)
                if terminated_early:
                    break
            if terminated_early:
                break

        prog(89, f"Evaluated {done} triples, {len(scored)} feasible…", len(scored), done, total_triples)

        if not scored:
            dd_mode = (
                f"fixed rest gap {dd_fixed:.4f} mm (theoretical {theoretical_gap_mm:.4f} × safety factor − "
                f"{AXIS_BUSHING_PLAY_MM:.2f} mm axis play)"
                if not sp.optimize_default_distance
                else "per-cell max rest gap under theoretical opening"
            )
            return SolverResult(
                success=False,
                message=(
                    f"No feasible (K, height, deadband) with {dd_mode} and gap@Y0 in "
                    f"[{gap_band_lo:.4f}, {gap_band_hi:.4f}] mm "
                    f"(theoretical {theoretical_gap_mm:.4f} mm with margin {margin_mm:.4f} mm). "
                    f"Widen height / deadband search"
                    + ("" if sp.fix_k else " / K")
                    + ", increase gap margin, adjust rest-gap factor, or enable “max rest gap per cell” in the API."
                ),
                height=0, K=0, deadband=0, default_distance=0.0,
                gap_at_Y0=0.0,
                theoretical_gap_mm=theoretical_gap_mm,
            )

        prog(91, "Selecting best match…", len(scored), done, total_triples)
        scored.sort(key=lambda x: x.rel_err)
        best_rel_err = scored[0].rel_err
        ordered_full = list(scored)
        ordered_full.sort(key=lambda r: _sort_key_for_aggressivity(r, rank_by))
        ordered = _select_evenly_spaced_along_rank_order(ordered_full, MAX_RETURNED_CANDIDATES)
        n = len(ordered)

        prog(94, "Building candidate set…", n, done, total_triples)
        candidates_payload: List[Dict[str, Any]] = []
        candidate_simulations: List[SimulationResult] = []
        for item in ordered:
            _check_cancel()
            rel_err = item.rel_err
            K, h, db, dd, vol, g0 = item.K, item.h, item.db, item.dd, item.vol, item.g0
            slope = item.slope_20_80
            p = SimulationParams(
                motor_speed=sp.motor_speed,
                height=float(h),
                thickness=sp.thickness,
                K=float(K),
                deadband=float(db),
                default_distance=float(dd),
                bushing_diameter=sp.bushing_diameter,
                lead_screw_pitch=sp.lead_screw_pitch,
                tube_id=sp.tube_id,
                tube_od=sp.tube_od,
                input_pressure_psi=sp.input_pressure_psi,
                compliance=sp.compliance,
                chamber_volume_ml=sp.chamber_volume_ml,
            )
            sim_i = compute_simulation(p)
            candidate_simulations.append(sim_i)
            cand: Dict[str, Any] = {
                "height": float(h),
                "K": float(K),
                "deadband": float(db),
                "default_distance": float(dd),
                "gap_at_Y0": float(sim_i.gap_at_Y0),
                "volume_rel_error": float(rel_err),
                "volume_error_pct": float(100.0 * rel_err),
                "flow_slope_l_per_mm": float(slope),
                "total_volume_ml": float(vol),
            }
            if item.eq_rel_ms == item.eq_rel_ms and not math.isnan(item.eq_rel_ms):
                cand["equalization_time_rel_ms"] = float(item.eq_rel_ms)
            if item.exp_k == item.exp_k and not math.isnan(item.exp_k):
                cand["flow_exp_k_per_mm"] = float(item.exp_k)
            if rank_by == CANDIDATE_RANK_FLOW_AT_Y:
                cand["rank_flow_y_mm"] = float(rank_flow_y_mm)
                if item.flow_at_y == item.flow_at_y and not math.isnan(item.flow_at_y):
                    cand["static_flow_at_rank_y_l_min"] = float(item.flow_at_y)
            candidates_payload.append(cand)

        selected_index = n // 2 if n else 0
        final_result = compute_simulation(
            SimulationParams(
                motor_speed=sp.motor_speed,
                height=float(candidates_payload[selected_index]["height"]),
                thickness=sp.thickness,
                K=float(candidates_payload[selected_index]["K"]),
                deadband=float(candidates_payload[selected_index]["deadband"]),
                default_distance=float(candidates_payload[selected_index]["default_distance"]),
                bushing_diameter=sp.bushing_diameter,
                lead_screw_pitch=sp.lead_screw_pitch,
                tube_id=sp.tube_id,
                tube_od=sp.tube_od,
                input_pressure_psi=sp.input_pressure_psi,
                compliance=sp.compliance,
                chamber_volume_ml=sp.chamber_volume_ml,
            )
        )
        opt_K = float(candidates_payload[selected_index]["K"])
        opt_h = float(candidates_payload[selected_index]["height"])
        opt_db = float(candidates_payload[selected_index]["deadband"])
        opt_dd = float(candidates_payload[selected_index]["default_distance"])
        opt_vol = float(candidates_payload[selected_index]["total_volume_ml"])
        opt_g0 = float(candidates_payload[selected_index]["gap_at_Y0"])

        k_note = f"K fixed at {opt_K:.3f}. " if sp.fix_k else ""
        dd_note = (
            f"Rest gap (default_distance) fixed at {opt_dd:.4f} mm "
            f"(= theoretical opening × safety factor − {AXIS_BUSHING_PLAY_MM:.2f} mm axis play). "
            if not sp.optimize_default_distance
            else ""
        )
        feasible_total = len(scored)
        rlabel = _rank_mode_label(rank_by, rank_flow_y_mm)
        if feasible_total > MAX_RETURNED_CANDIDATES:
            subset_note = (
                f"{feasible_total} feasible grid point(s) found; listing {n} candidates evenly spaced along "
                f"{rlabel} (gradual→snappy), always including the two extremes. "
            )
        else:
            subset_note = (
                f"{feasible_total} feasible config(s), ordered gradual→snappy by {rlabel}. "
            )
        msg = (
            f"{k_note}{dd_note}Best feasible volume error in this solve: {100.0 * best_rel_err:.2f}% "
            f"(target {target_vol:.3f} mL equiv.). "
            f"gap_at_Y0={opt_g0:.4f} mm in [{gap_band_lo:.4f}, {gap_band_hi:.4f}] mm "
            f"(theoretical {theoretical_gap_mm:.4f} mm, margin {margin_mm:.4f} mm). "
            f"{subset_note}"
            f"Use the aggressivity slider in Found Parameters to compare."
        )
        if terminated_early:
            msg = f"Terminated early. {msg}"

    except SolveCancelled:
        return SolverResult(
            success=False,
            message="Solve cancelled.",
            height=0, K=0, deadband=0, default_distance=0.0,
            gap_at_Y0=0.0,
            theoretical_gap_mm=theoretical_gap_mm,
        )
    except Exception as e:
        return SolverResult(
            success=False,
            message=f"Solver failed: {str(e)}",
            height=0, K=0, deadband=0, default_distance=0.0,
            gap_at_Y0=0.0,
            theoretical_gap_mm=theoretical_gap_mm,
        )

    prog(100, "Done", n, done, total_triples)

    return SolverResult(
        success=True,
        message=msg,
        height=opt_h,
        K=opt_K,
        deadband=opt_db,
        default_distance=opt_dd,
        gap_at_Y0=float(final_result.gap_at_Y0),
        theoretical_gap_mm=theoretical_gap_mm,
        simulation=final_result,
        candidates=candidates_payload,
        selected_candidate_index=selected_index,
            solve_id=solve_id,
            candidate_simulations=candidate_simulations,
    )
