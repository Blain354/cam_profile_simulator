"""Time-budgeted multi-stage optimizer & async job manager for Compliant Bars.

The "cmaes" method is the one to reach for: a covariance-matrix-adaptation evolution strategy
started on the current design, with restarts. It learns which variables move together (thickness
against handle offsets, say), which the other methods cannot. With a seed and an evaluation
budget it returns the same design every time.

The older methods, kept:

Replaces the 36-point uniform random search with:
  1. Latin Hypercube Sampling (LHS) waves for stratified global space coverage.
  2. Multi-start projected gradient ascent (SPSA + coordinate pattern search) that
     actively walks both near-feasible seeds into the feasible region and feasible
     leaders toward higher objective values.
  3. Nelder-Mead simplex polish on the best feasible basin(s).

Tracks live rejection statistics, per-variable coverage histograms, bound saturation
warnings, convergence history, and auto-persists completed experiments to SQLite.
"""

from dataclasses import asdict, replace
import datetime
import multiprocessing
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import uuid

import numpy as np

try:
    from compliant_bars import (
        ALL_SOLVER_KEYS,
        SOLVER_GOALS,
        CompliantConstraints,
        CompliantParams,
        CompliantResult,
        _apply_pinch_goal,
        _constraints_from_mapping,
        _params_from_mapping,
        _row_to_params,
        _screw_factors,
        admission_score,
        anchor_symmetric_range,
        anchor_val_to_z,
        anchor_z_to_val,
        compute_compliant,
        handle_point,
        normalize_goal_weights,
    )
    from storage import CompliantExperimentStorage
    import tube_model as tube_law
except ImportError:
    from .compliant_bars import (
        ALL_SOLVER_KEYS,
        SOLVER_GOALS,
        CompliantConstraints,
        CompliantParams,
        CompliantResult,
        _apply_pinch_goal,
        _constraints_from_mapping,
        _params_from_mapping,
        _row_to_params,
        _screw_factors,
        admission_score,
        anchor_symmetric_range,
        anchor_val_to_z,
        anchor_z_to_val,
        compute_compliant,
        handle_point,
        normalize_goal_weights,
    )
    from .storage import CompliantExperimentStorage
    from . import tube_model as tube_law


CONSTRAINT_KEYS = (
    "stress", "stall_no_flow", "motor_stall", "seal_y0", "tube", "crossing", "buckling", "shell", "pivot", "pinch",
    "rotation", "junction_forbidden", "no_open", "geometry",
)

SOLVER_METHODS = ("cmaes", "hybrid", "brute_force", "evolutionary", "local_refine")


def _score_candidate(job: Tuple[CompliantParams, CompliantConstraints, str, Dict[str, float]]) -> Tuple[CompliantResult, float]:
    """One evaluation, in a worker process: no shared state, so a generation can be scored on several cores."""
    params, constraints, goal, weights = job
    result = compute_compliant(params, fast=True, constraints=constraints)
    return result, admission_score(result, constraints, goal=goal, goal_weights=weights)


def _default_workers() -> int:
    # Half the cores, six at most: the server runs other things, and a search can last hours.
    return int(max(1, min(6, (os.cpu_count() or 2) // 2)))


PARETO_CAP = 60


def _trade_axes(result: CompliantResult) -> Tuple[float, float, float]:
    """What a valve trades, each larger-is-better: flow at full stroke, motor torque, dead band."""
    torque = result.peak_torque_op_mnm if result.peak_torque_op_mnm is not None else result.peak_thrust_op_n
    return (
        float(result.max_flow_frac) if result.max_flow_frac is not None else 0.0,
        -float(torque) if torque is not None else -1.0e9,
        -float(result.y_open_mm) if result.y_open_mm is not None else -1.0e9,
    )


def _pareto_insert(front: List[tuple], item: tuple) -> None:
    """Keep `front` the set of admissible designs no other design beats on all three axes at once.

    item is (score, params, result, z); its axes are appended. Past PARETO_CAP the front is thinned
    where it is most crowded, keeping the better score of the closest pair.
    """
    axes = _trade_axes(item[2])
    kept = []
    for other in front:
        o = other[4]
        if o[0] >= axes[0] and o[1] >= axes[1] and o[2] >= axes[2]:
            return                              # another design is at least as good everywhere
        if not (axes[0] >= o[0] and axes[1] >= o[1] and axes[2] >= o[2]):
            kept.append(other)
    kept.append(item + (axes,))
    if len(kept) > PARETO_CAP:
        pts = np.array([k[4] for k in kept], dtype=float)
        span = np.maximum(pts.max(axis=0) - pts.min(axis=0), 1e-9)
        unit = (pts - pts.min(axis=0)) / span
        dist = np.sum((unit[:, None, :] - unit[None, :, :]) ** 2, axis=2)
        np.fill_diagonal(dist, np.inf)
        i, j = np.unravel_index(int(np.argmin(dist)), dist.shape)
        del kept[i if kept[i][0] < kept[j][0] else j]
    front[:] = kept


def _classify_rejections(result: CompliantResult) -> List[str]:
    """Return all constraint keys violated by an inadmissible evaluation."""
    if result.passes:
        return []
    reasons: List[str] = []
    if not result.feasible:
        if not result.Y_positions:
            return ["geometry"]
        reasons.append("no_open")
    if not result.plastic_ok:
        reasons.append("stress")
    if not getattr(result, "flow_ok", True) and result.feasible:
        stroke_max = max((abs(v) for v in result.Y_positions), default=0.0)
        eff = getattr(result, "effective_stroke_mm", None)
        if eff is not None and stroke_max > 0.0 and eff < stroke_max - 1e-6:
            reasons.append("stall_no_flow")
        elif "no_open" not in reasons:
            reasons.append("no_open")
    if not getattr(result, "motor_ok", True):
        reasons.append("motor_stall")
    if not getattr(result, "sealed_at_y0", True):
        reasons.append("seal_y0")
    if not getattr(result, "tube_ok", True):
        reasons.append("tube")
    if not getattr(result, "crossing_ok", True):
        reasons.append("crossing")
    if not getattr(result, "buckling_ok", True):
        reasons.append("buckling")
    if not result.shell_ok:
        reasons.append("shell")
    if not result.pivot_ok:
        reasons.append("pivot")
    if not result.pinch_ok:
        reasons.append("pinch")
    if not result.rotation_ok:
        reasons.append("rotation")
    if not getattr(result, "junction_ok", True):
        reasons.append("junction_forbidden")
    return reasons or ["geometry"]


def _latin_hypercube(n: int, d: int, rng: np.random.Generator) -> np.ndarray:
    """Stratified Latin Hypercube sample in [0, 1]^d with shape (n, d)."""
    if n <= 0 or d <= 0:
        return np.zeros((0, d), dtype=float)
    cut = np.linspace(0.0, 1.0, n + 1)
    u = rng.random((n, d))
    a = cut[:n, None]
    b = cut[1 : n + 1, None]
    pts = u * (b - a) + a
    out = np.empty_like(pts)
    for j in range(d):
        out[:, j] = pts[rng.permutation(n), j]
    return out


def _compact_timeline(items: List[dict], cap: int) -> List[dict]:
    """Thin a chronological list by ~2x while preserving first, last, and uniform coverage."""
    if len(items) <= cap * 2:
        return items
    kept = [items[0]] + items[2:-1:2] + [items[-1]]
    return kept


def _make_preview_frame(
    n: int,
    elapsed_s: float,
    params: CompliantParams,
    result: CompliantResult,
    score: float,
    is_best: bool,
    reason: Optional[str],
) -> dict:
    """Compact geometric snapshot (~300 B) for live preview & GIF export."""
    wall_x = float(result.wall_x) if result.wall_x > 1e-6 else float(params.tube_center_x + params.tube_od / 2.0)
    h0 = float(params.closed_carriage_height)
    if result.handles and "l" in result.handles and "r" in result.handles and "f" in result.handles:
        a = result.anchor
        j = result.junction
        v = result.pivot
        p = result.pinch
        hl_pair = result.handles["l"]
        hr_pair = result.handles["r"]
        hf_pair = result.handles["f"]
    else:
        a = [-float(params.anchor_distance), float(params.l_thickness) / 2.0]
        j = [float(params.junction_x), float(params.junction_y)]
        v = [-float(params.pivot_offset) if params.pivot_inverted else float(params.pivot_offset), h0]
        if result.pinch_x != 0.0:
            px = float(result.pinch_x)
        else:
            if tube_law.uses_fem(params):
                try:
                    closed_est = float(tube_law.law(params).closed_gap)
                except Exception:
                    closed_est = max(0.0, float(params.tube_od - params.tube_id))
            else:
                closed_est = max(0.0, float(params.tube_od - params.tube_id) - float(params.compliance * params.input_pressure_kpa * 1e-3))
            px = (closed_est - params.preload) - wall_x + params.f_thickness / 2.0
        p = [float(px), float(params.pinch_y)]

        def _handles_for(s_pt, e_pt, prefix: str):
            u1, v1 = float(getattr(params, f"{prefix}_u1")), float(getattr(params, f"{prefix}_v1"))
            u2, v2 = float(getattr(params, f"{prefix}_u2")), float(getattr(params, f"{prefix}_v2"))
            if u1 > u2:
                u1, u2, v1, v2 = u2, u1, v2, v1
            return [handle_point(s_pt, e_pt, u1, v1).tolist(), handle_point(s_pt, e_pt, u2, v2).tolist()]

        hl_pair = _handles_for(a, j, "l")
        hr_pair = _handles_for(j, v, "r")
        hf_pair = _handles_for(j, p, "f")

    def _r2(pair) -> List[float]:
        return [round(float(pair[0]), 2), round(float(pair[1]), 2)]

    def _rh(hp) -> List[float]:
        return [round(float(hp[0][0]), 2), round(float(hp[0][1]), 2), round(float(hp[1][0]), 2), round(float(hp[1][1]), 2)]

    return {
        "n": int(n),
        "t": round(float(elapsed_s), 2),
        "ok": bool(result.passes),
        "best": bool(is_best),
        "reason": None if result.passes else reason,
        "dx": round(float(result.dx_at_025_mm), 3) if result.dx_at_025_mm is not None else None,
        "stress": round(float(result.max_stress_mpa), 1) if result.max_stress_mpa is not None else None,
        "score": round(float(score), 3) if result.passes else None,
        "wall_x": round(wall_x, 2),
        "h0": round(h0, 2),
        "tube_od": round(float(params.tube_od), 2),
        "tube_id": round(float(params.tube_id), 2),
        "piv_off": round(float(params.pivot_offset), 2),
        "a": _r2(a),
        "j": _r2(j),
        "v": _r2(v),
        "p": _r2(p),
        "hl": _rh(hl_pair),
        "hr": _rh(hr_pair),
        "hf": _rh(hf_pair),
        "th": [round(float(params.l_thickness), 2), round(float(params.r_thickness), 2), round(float(params.f_thickness), 2)],
    }


def _runner_brief(params: CompliantParams, result: CompliantResult, score: float, keys=ALL_SOLVER_KEYS) -> dict:
    return {
        "score": float(score),
        "slope": result.flow_slope_mean,
        "dx_at_025_mm": result.dx_at_025_mm,
        "kinematic_gain": result.kinematic_gain,
        "attack_angle_deg": result.attack_angle_deg,
        "y_open_mm": result.y_open_mm,
        "y_90_mm": result.y_90_mm,
        "sealed_at_y0": result.sealed_at_y0,
        "max_stress_mpa": result.max_stress_mpa,
        "max_rotation_deg": result.max_rotation_deg,
        "shell_clearance_mm": result.shell_clearance_mm,
        "pivot_clearance_mm": result.pivot_clearance_mm,
        "pinch_ceiling_margin_mm": result.pinch_ceiling_margin_mm,
        "chamber_t50_ms": result.chamber_t50_ms,
        "chamber_t90_ms": result.chamber_t90_ms,
        "chamber_t100_ms": result.chamber_t100_ms,
        "chamber_cycle_freq_hz": result.chamber_cycle_freq_hz,
        "chamber_bandwidth_hz": result.chamber_bandwidth_hz,
        "energy_cycle_mj": result.energy_cycle_mj,
        "energy_stroke_mj": result.energy_stroke_mj,
        "buckling_margin": result.buckling_margin,
        "peak_thrust_op_n": result.peak_thrust_op_n,
        "peak_torque_op_mnm": result.peak_torque_op_mnm,
        "thrust_available_n": result.thrust_available_n,
        "thrust_to_yield_n": result.thrust_to_yield_n,
        "torque_to_yield_mnm": result.torque_to_yield_mnm,
        "stall_y_mm": result.stall_y_mm,
        "effective_stroke_mm": result.effective_stroke_mm,
        "max_flow_l_min": result.max_flow_l_min,
        "max_flow_frac": result.max_flow_frac,
        "yield_y_mm": result.yield_y_mm,
        "motor_margin": result.motor_margin,
        "motor_ok": result.motor_ok,
        "max_stress_op_mpa": result.max_stress_op_mpa,
        "max_stress_to_stall_mpa": result.max_stress_to_stall_mpa,
        "stroke": params.stroke,
        "pivot_inverted": params.pivot_inverted,
        "params": {**{key: getattr(params, key) for key in keys}, "pivot_inverted": params.pivot_inverted},
    }


def run_time_budgeted_solve(
    base: CompliantParams,
    bounds: Dict[str, Tuple[float, float]],
    time_budget_s: float = 30.0,
    goal: str = "dx_at_025",
    goal_weights: Optional[Dict[str, float]] = None,
    method: str = "hybrid",
    method_params: Optional[Dict[str, Any]] = None,
    constraints: Optional[CompliantConstraints] = None,
    pivot_side: str = "current",
    seed: Optional[int] = None,
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Callable[[dict], None]] = None,
) -> dict:
    """Run time-budgeted optimization using the chosen search method up to time_budget_s."""
    c = constraints or CompliantConstraints()
    _, _, base_thrust_avail, _ = _screw_factors(base)
    goal = goal if goal in SOLVER_GOALS else "dx_at_025"
    method = method if method in SOLVER_METHODS else "hybrid"
    mp: Dict[str, Any] = dict(method_params or {})
    norm_weights = normalize_goal_weights(goal, goal_weights)
    time_budget_s = float(max(0.5, time_budget_s))
    # A run that stops on a count of evaluations, with a seed, is repeatable. One that stops on the clock is not.
    # method_params: "max_evals" is a count, "max_evals_k" the same in thousands (the slider in the page).
    max_evals = int(max(0, int(float(mp.get("max_evals") or 0)) or int(round(1000.0 * float(mp.get("max_evals_k") or 0)))))
    if seed is None and mp.get("seed") not in (None, "", 0, "0"):
        seed = int(float(mp["seed"]))
    keys = ALL_SOLVER_KEYS
    lows_l, highs_l = [], []
    for key in keys:
        lo, hi = bounds.get(key, (getattr(base, key), getattr(base, key)))
        lo, hi = float(min(lo, hi)), float(max(lo, hi))
        lows_l.append(lo)
        highs_l.append(hi)
    lows = np.array(lows_l, dtype=float)
    highs = np.array(highs_l, dtype=float)
    span = highs - lows
    free_mask = span > 1e-9

    idx_anchor = keys.index("anchor_distance")
    idx_pinch = keys.index("pinch_y")
    idx_h0 = keys.index("closed_carriage_height")
    idx_jx = keys.index("junction_x")
    idx_jy = keys.index("junction_y")
    anchor_sym = bool(c.anchor_symmetric)
    a_lo, a_hi = anchor_symmetric_range(lows[idx_anchor], highs[idx_anchor])
    anchor_sym_active = anchor_sym and a_hi > 1e-9
    clip_lows = lows.copy()
    clip_highs = highs.copy()
    if anchor_sym_active:
        free_mask[idx_anchor] = True
        clip_lows[idx_anchor] = -a_hi
        clip_highs[idx_anchor] = a_hi
    if c.target_pinch_from_top_mm is not None:
        free_mask[idx_pinch] = False

    free_idx = np.flatnonzero(free_mask)
    local_anchor = int(np.where(free_idx == idx_anchor)[0][0]) if anchor_sym_active else -1
    d = len(free_idx)
    free_vars = [keys[i] for i in free_idx]
    fixed_vars = [keys[i] for i in range(len(keys)) if not free_mask[i]]

    if pivot_side == "both":
        sides = [False, True]
    elif pivot_side == "normal":
        sides = [False]
    elif pivot_side == "inverted":
        sides = [True]
    else:
        sides = [base.pivot_inverted]

    rng = np.random.default_rng(seed)
    t_start = time.monotonic()

    # Telemetry accumulators
    tested = 0
    feasible_count = 0
    rejection_counts = {k: 0 for k in CONSTRAINT_KEYS}
    sole_blocker_counts = {k: 0 for k in CONSTRAINT_KEYS}
    cov_bins = 10
    tested_hist = {k: [0] * cov_bins for k in free_vars}
    feasible_hist = {k: [0] * cov_bins for k in free_vars}
    pivot_tested = [0, 0]    # [Far side (False), Tube side (True)]
    pivot_feasible = [0, 0]
    scatter: List[dict] = []
    convergence: List[dict] = []
    timeline_best: List[dict] = []
    timeline_valid: List[dict] = []
    timeline_invalid: List[dict] = []
    live_preview: List[dict] = []
    best_preview: Optional[dict] = None
    last_live_invalid_t = -1.0
    last_live_valid_t = -1.0
    admissible_pool: List[Tuple[float, CompliantParams, CompliantResult, np.ndarray]] = []
    pareto_front: List[tuple] = []   # admissible designs on the flow / torque / dead-band front, see _pareto_insert
    near_pool: List[Tuple[float, CompliantParams, CompliantResult, np.ndarray, bool]] = []
    best_overall: Optional[Tuple[float, CompliantParams, CompliantResult]] = None
    best_feasible: Optional[Tuple[float, CompliantParams, CompliantResult]] = None
    phase = "Global exploration (LHS)"
    wave = 0
    last_emit = 0.0

    def time_up() -> bool:
        if cancel_event is not None and cancel_event.is_set():
            return True
        if max_evals > 0 and tested >= max_evals:
            return True
        return (time.monotonic() - t_start) >= time_budget_s

    def z_to_row(z: np.ndarray, side_base: CompliantParams) -> np.ndarray:
        row = np.array([getattr(side_base, k) for k in keys], dtype=float)
        row = np.clip(row, clip_lows, clip_highs)
        if d > 0:
            zc = np.clip(z, 0.0, 1.0)
            row[free_idx] = lows[free_idx] + zc * span[free_idx]
            if anchor_sym_active:
                row[idx_anchor] = anchor_z_to_val(float(zc[local_anchor]), a_lo, a_hi)
        return row

    def row_to_z(row: np.ndarray) -> np.ndarray:
        if d == 0:
            return np.zeros(0, dtype=float)
        safe_span = np.where(span[free_idx] > 1e-9, span[free_idx], 1.0)
        z = np.clip((row[free_idx] - lows[free_idx]) / safe_span, 0.0, 1.0)
        if anchor_sym_active:
            z[local_anchor] = anchor_val_to_z(float(row[idx_anchor]), a_lo, a_hi)
        return z

    def _compute_bound_hits(params: Optional[CompliantParams]) -> List[dict]:
        if params is None:
            return []
        hits = []
        for i in free_idx:
            key = keys[i]
            val = float(getattr(params, key))
            if i == idx_anchor and anchor_sym_active:
                w = a_hi - a_lo
                if w <= 1e-9:
                    continue
                frac = (abs(val) - a_lo) / w
                if frac <= 0.03:
                    hits.append({"key": key, "side": "min", "value": round(val, 4), "lo": round(-a_hi, 4), "hi": round(a_hi, 4)})
                elif frac >= 0.97:
                    hits.append({"key": key, "side": "max", "value": round(val, 4), "lo": round(-a_hi, 4), "hi": round(a_hi, 4)})
                continue
            frac = (val - lows[i]) / span[i]
            if frac <= 0.03:
                hits.append({"key": key, "side": "min", "value": round(val, 4), "lo": round(float(lows[i]), 4), "hi": round(float(highs[i]), 4)})
            elif frac >= 0.97:
                hits.append({"key": key, "side": "max", "value": round(val, 4), "lo": round(float(lows[i]), 4), "hi": round(float(highs[i]), 4)})
        return hits

    def _extract_runners() -> List[Tuple[float, CompliantParams, CompliantResult]]:
        admissible_pool.sort(key=lambda item: item[0], reverse=True)
        runners: List[Tuple[float, CompliantParams, CompliantResult]] = []

        def _is_distinct(prm: CompliantParams) -> bool:
            return not any(
                abs(prm.anchor_distance - o.anchor_distance) < 0.05
                and abs(prm.junction_x - o.junction_x) < 0.05
                and abs(prm.junction_y - o.junction_y) < 0.05
                and abs(prm.pinch_y - o.pinch_y) < 0.05
                and prm.pivot_inverted == o.pivot_inverted
                for _s, o, _r in runners
            )

        for sc, prm, res, _z in admissible_pool:
            if not _is_distinct(prm):
                continue
            runners.append((sc, prm, res))
            if len(runners) == 12:
                break

        # Then the trade-off front, spread from the lowest torque to the highest: a search that has converged
        # leaves one shape at the top of the pool, and the page re-ranks these to trade torque against flow.
        # Two designs on the front may share their nodes and differ by thickness alone, so thickness counts here.
        def _is_new_trade(prm: CompliantParams) -> bool:
            return not any(
                abs(prm.anchor_distance - o.anchor_distance) < 0.05
                and abs(prm.junction_x - o.junction_x) < 0.05
                and abs(prm.junction_y - o.junction_y) < 0.05
                and abs(prm.pinch_y - o.pinch_y) < 0.05
                and abs(prm.l_thickness - o.l_thickness) < 0.05
                and abs(prm.r_thickness - o.r_thickness) < 0.05
                and abs(prm.f_thickness - o.f_thickness) < 0.05
                and prm.pivot_inverted == o.pivot_inverted
                for _s, o, _r in runners
            )

        front = sorted(pareto_front, key=lambda it: it[4][1])
        room = 20 - len(runners)
        if front and room > 0:
            picks = sorted({int(round(k)) for k in np.linspace(0, len(front) - 1, min(room, len(front)))})
            for k in picks:
                sc, prm, res = front[k][0], front[k][1], front[k][2]
                if _is_new_trade(prm):
                    runners.append((sc, prm, res))

        # Also include top distinct tradeoff leaders (up to 24 total) so live weight re-ranking
        # in the UI can surface strong alternatives along every objective axis.
        if len(runners) < 24 and len(admissible_pool) > len(runners):
            axis_keys = [
                lambda it: it[2].dx_at_025_mm if it[2].dx_at_025_mm is not None else -1e9,
                lambda it: it[2].chamber_cycle_freq_hz if it[2].chamber_cycle_freq_hz is not None else -1e9,
                lambda it: it[2].flow_slope_mean if it[2].flow_slope_mean is not None else -1e9,
                lambda it: -(it[2].y_90_mm if it[2].y_90_mm is not None else 1e9),
                lambda it: -abs((it[2].attack_angle_deg if it[2].attack_angle_deg is not None else 180.0) - c.target_attack_angle_deg),
                lambda it: -(it[2].max_stress_mpa if it[2].max_stress_mpa is not None else 1e9),
                lambda it: -(it[2].energy_cycle_mj if it[2].energy_cycle_mj is not None else 1e9),
                lambda it: it[2].max_flow_frac if it[2].max_flow_frac is not None else -1e9,
                lambda it: -(it[2].peak_torque_op_mnm if it[2].peak_torque_op_mnm is not None else 1e9),
                lambda it: -(it[2].y_open_mm if it[2].y_open_mm is not None else 1e9),
            ]
            for key_fn in axis_keys:
                if len(runners) >= 24:
                    break
                added = 0
                for sc, prm, res, _z in sorted(admissible_pool, key=key_fn, reverse=True):
                    if _is_distinct(prm):
                        runners.append((sc, prm, res))
                        added += 1
                        if added >= 2 or len(runners) >= 24:
                            break
        return runners

    def build_snapshot(final: bool = False) -> dict:
        elapsed = max(1e-6, time.monotonic() - t_start)
        runners = _extract_runners()
        best_p = best_feasible[1] if best_feasible is not None else None
        best_r = best_feasible[2] if best_feasible is not None else None
        best_sc = best_feasible[0] if best_feasible is not None else None
        rejected_total = max(0, tested - feasible_count)
        rejection_stats = []
        for k in CONSTRAINT_KEYS:
            cnt = rejection_counts[k]
            sole = sole_blocker_counts[k]
            rejection_stats.append({
                "key": k,
                "count": cnt,
                "pct_of_tested": round(100.0 * cnt / tested, 1) if tested > 0 else 0.0,
                "pct_of_rejected": round(100.0 * cnt / rejected_total, 1) if rejected_total > 0 else 0.0,
                "sole_blocker": sole,
            })
        rejection_stats.sort(key=lambda item: item["count"], reverse=True)
        coverage = [
            {
                "key": k,
                "lo": round(float(clip_lows[keys.index(k)]), 4),
                "hi": round(float(clip_highs[keys.index(k)]), 4),
                "tested_bins": tested_hist[k],
                "feasible_bins": feasible_hist[k],
                "best_val": round(float(getattr(best_p, k)), 4) if best_p is not None else None,
            }
            for k in free_vars
        ]
        if len(sides) > 1:
            coverage.append({
                "key": "pivot_inverted",
                "lo": 0,
                "hi": 1,
                "tested_bins": list(pivot_tested),
                "feasible_bins": list(pivot_feasible),
                "best_val": (1 if best_p.pivot_inverted else 0) if best_p is not None else None,
            })
        all_free_vars = free_vars + (["pivot_inverted"] if len(sides) > 1 else [])
        all_fixed_vars = fixed_vars + (["pivot_inverted"] if len(sides) == 1 else [])
        preview_timeline: Optional[List[dict]] = None
        if final:
            by_n: Dict[int, dict] = {}
            for fr in timeline_invalid:
                by_n[fr["n"]] = fr
            for fr in timeline_valid:
                by_n[fr["n"]] = fr
            for fr in timeline_best:
                by_n[fr["n"]] = fr
            preview_timeline = [by_n[k] for k in sorted(by_n)]
        snap = {
            "phase": phase,
            "wave": wave,
            "method": method,
            "method_params": mp,
            "goal": goal,
            "goal_weights": {k: round(v, 4) for k, v in norm_weights.items()},
            "tested": tested,
            "feasible": feasible_count,
            "rejected": rejected_total,
            "elapsed_s": round(elapsed, 2),
            "time_budget_s": time_budget_s,
            "max_evals": max_evals or None,
            "seed": seed,
            "progress": 1.0 if final else min(0.99, max(elapsed / time_budget_s, (tested / max_evals) if max_evals > 0 else 0.0)),
            "evals_per_sec": round(tested / elapsed, 1),
            "best_score": round(float(best_sc), 4) if best_sc is not None else None,
            "best_dx_at_025_mm": round(float(best_r.dx_at_025_mm), 4) if (best_r and best_r.dx_at_025_mm is not None) else None,
            "best_slope": round(float(best_r.flow_slope_mean), 3) if (best_r and best_r.flow_slope_mean is not None) else None,
            "best_y_90_mm": round(float(best_r.y_90_mm), 3) if (best_r and best_r.y_90_mm is not None) else None,
            "best_attack_angle_deg": round(float(best_r.attack_angle_deg), 1) if (best_r and best_r.attack_angle_deg is not None) else None,
            "best_stress_mpa": round(float(best_r.max_stress_mpa), 1) if (best_r and best_r.max_stress_mpa is not None) else None,
            "best_chamber_t100_ms": round(float(best_r.chamber_t100_ms), 1) if (best_r and best_r.chamber_t100_ms is not None) else None,
            "best_chamber_cycle_freq_hz": round(float(best_r.chamber_cycle_freq_hz), 3) if (best_r and best_r.chamber_cycle_freq_hz is not None) else None,
            "best_chamber_bandwidth_hz": round(float(best_r.chamber_bandwidth_hz), 3) if (best_r and best_r.chamber_bandwidth_hz is not None) else None,
            "best_energy_cycle_mj": round(float(best_r.energy_cycle_mj), 2) if (best_r and best_r.energy_cycle_mj is not None) else None,
            "best_peak_thrust_op_n": round(float(best_r.peak_thrust_op_n), 2) if (best_r and best_r.peak_thrust_op_n is not None) else None,
            "best_peak_torque_op_mnm": round(float(best_r.peak_torque_op_mnm), 2) if (best_r and best_r.peak_torque_op_mnm is not None) else None,
            "best_stall_y_mm": round(float(best_r.stall_y_mm), 3) if (best_r and best_r.stall_y_mm is not None) else None,
            "rejection_stats": rejection_stats,
            "bound_hits": _compute_bound_hits(best_p),
            "free_vars": all_free_vars,
            "fixed_vars": all_fixed_vars,
            "pivot_sides": sides,
            "active_constraints": {
                "member_strength_mpa": base.member_strength_mpa,
                "stress_limit_factor": float(np.clip(c.stress_limit_factor, 0.05, 1.0)),
                "allowable_stress_mpa": round(base.member_strength_mpa * float(np.clip(c.stress_limit_factor, 0.05, 1.0)), 2),
                "motor_limited_stress": bool(c.motor_limited_stress),
                "require_no_stall_in_stroke": bool(c.require_no_stall_in_stroke),
                "motor_torque_mnm": round(float(base.motor_torque_mnm), 2),
                "thrust_available_n": round(float(base_thrust_avail), 2) if base_thrust_avail is not None else None,
                "min_shell_clearance_mm": c.min_shell_clearance_mm,
                "min_pivot_clearance_mm": c.min_pivot_clearance_mm,
                "min_tube_clearance_mm": c.min_tube_clearance_mm,
                "pinch_ceiling_margin_mm": c.pinch_ceiling_margin_mm,
                "pinch_floor_margin_mm": c.pinch_floor_margin_mm,
                "max_rotation_deg": c.max_rotation_deg,
                "min_buckling_margin": c.min_buckling_margin,
                "stroke_fixed": "stroke" in fixed_vars,
                "stroke_mm": base.stroke,
                "anchor_symmetric": anchor_sym,
            },
            "coverage": coverage,
            "scatter": scatter[-250:],
            "convergence": convergence[-80:],
            "runners": [_runner_brief(p, r, s, keys) for s, p, r in runners],
            "preview_frames": live_preview[-24:],
            "best_preview": best_preview,
        }
        if preview_timeline is not None:
            snap["preview_timeline"] = preview_timeline
        return snap

    pool = None   # worker processes, opened by the methods that score a whole generation at once

    def candidate(z: np.ndarray, side_base: CompliantParams) -> CompliantParams:
        row = z_to_row(z, side_base)
        return _apply_pinch_goal(_row_to_params(side_base, row, clip_lows, clip_highs, keys), c)

    def evaluate_many(zs: np.ndarray, side_base: CompliantParams) -> List[float]:
        """Score candidates in order, stopping at the budget. Same results with or without workers."""
        if max_evals > 0:
            zs = zs[: max(0, max_evals - tested)]
        scores: List[float] = []
        if pool is None:
            for z in zs:
                if time_up():
                    break
                scores.append(evaluate(z, side_base)[0])
            return scores
        if time_up() or len(zs) == 0:
            return scores
        prms = [candidate(z, side_base) for z in zs]
        scored = pool.map(_score_candidate, [(prm, c, goal, norm_weights) for prm in prms])
        for z, prm, (res, sc) in zip(zs, prms, scored):
            scores.append(evaluate(z, side_base, (prm, res, sc))[0])
        return scores

    def evaluate(
        z: np.ndarray,
        side_base: CompliantParams,
        scored: Optional[Tuple[CompliantParams, CompliantResult, float]] = None,
    ) -> Tuple[float, CompliantParams, CompliantResult]:
        nonlocal tested, feasible_count, best_overall, best_feasible, last_emit
        nonlocal best_preview, last_live_invalid_t, last_live_valid_t
        if scored is None:
            params = candidate(z, side_base)
            result = compute_compliant(params, fast=True, constraints=c)
            score = admission_score(result, c, goal=goal, goal_weights=norm_weights)
        else:
            params, result, score = scored
        tested += 1
        now = time.monotonic()
        elapsed_now = now - t_start

        # Record coverage histograms
        p_idx = 1 if params.pivot_inverted else 0
        pivot_tested[p_idx] += 1
        if result.passes:
            pivot_feasible[p_idx] += 1
        for local_j, k in enumerate(free_vars):
            bin_i = int(np.clip(z[local_j] * cov_bins, 0, cov_bins - 1)) if d > 0 else 0
            tested_hist[k][bin_i] += 1
            if result.passes:
                feasible_hist[k][bin_i] += 1

        is_new_best = False
        primary_reason: Optional[str] = None
        if result.passes:
            feasible_count += 1
            admissible_pool.append((score, params, result, z.copy()))
            _pareto_insert(pareto_front, (score, params, result, z.copy()))
            # Keep pool bounded so sorting stays O(1)
            if len(admissible_pool) > 400:
                admissible_pool.sort(key=lambda item: item[0], reverse=True)
                del admissible_pool[200:]
            if best_feasible is None or score > best_feasible[0]:
                is_new_best = True
                best_feasible = (score, params, result)
                convergence.append({
                    "t": round(elapsed_now, 2),
                    "tested": tested,
                    "score": round(float(score), 4),
                    "dx_025": round(float(result.dx_at_025_mm), 4) if result.dx_at_025_mm is not None else None,
                    "slope": round(float(result.flow_slope_mean), 3) if result.flow_slope_mean is not None else None,
                    "energy_cycle_mj": round(float(result.energy_cycle_mj), 2) if result.energy_cycle_mj is not None else None,
                })
        else:
            reasons = _classify_rejections(result)
            primary_reason = reasons[0] if reasons else "geometry"
            for r in reasons:
                rejection_counts[r] += 1
            if len(reasons) == 1:
                sole_blocker_counts[reasons[0]] += 1
            near_pool.append((score, params, result, z.copy(), side_base.pivot_inverted))
            if len(near_pool) > 120:
                near_pool.sort(key=lambda item: item[0], reverse=True)
                del near_pool[60:]

        if best_overall is None or score > best_overall[0]:
            best_overall = (score, params, result)

        # Curated preview frames for live visualization & GIF timeline
        want_timeline = False
        want_live = False
        if is_new_best:
            want_timeline = True
            want_live = True
        elif result.passes:
            if len(timeline_valid) < 36 or (feasible_count % max(1, feasible_count // 36) == 0):
                want_timeline = True
            if elapsed_now - last_live_valid_t >= 0.14 or feasible_count <= 4:
                want_live = True
        else:
            rejected_n = tested - feasible_count
            if len(timeline_invalid) < 44 or (rejected_n % max(1, rejected_n // 44) == 0):
                want_timeline = True
            if elapsed_now - last_live_invalid_t >= 0.08 or tested <= 6:
                want_live = True

        if want_timeline or want_live:
            pf = _make_preview_frame(tested, elapsed_now, params, result, score, is_new_best, primary_reason)
            if is_new_best:
                best_preview = pf
                timeline_best.append(pf)
                if len(timeline_best) > 64:
                    timeline_best[:] = _compact_timeline(timeline_best, 32)
            elif want_timeline and result.passes:
                timeline_valid.append(pf)
                if len(timeline_valid) > 72:
                    timeline_valid[:] = _compact_timeline(timeline_valid, 36)
            elif want_timeline:
                timeline_invalid.append(pf)
                if len(timeline_invalid) > 88:
                    timeline_invalid[:] = _compact_timeline(timeline_invalid, 44)
            if want_live:
                live_preview.append(pf)
                if len(live_preview) > 48:
                    del live_preview[:-24]
                if result.passes:
                    last_live_valid_t = elapsed_now
                else:
                    last_live_invalid_t = elapsed_now

        # Sample points for 2D scatter visualization (always keep feasible, subsample infeasible)
        keep_scatter = result.passes or len(scatter) < 120 or (tested % max(1, tested // 80) == 0)
        if keep_scatter and result.max_stress_mpa is not None and result.dx_at_025_mm is not None:
            scatter.append({
                "dx_025": round(float(result.dx_at_025_mm), 4),
                "stress": round(min(float(result.max_stress_mpa), base.member_strength_mpa * 4.0), 1),
                "slope": round(float(result.flow_slope_mean), 2) if result.flow_slope_mean is not None else 0.0,
                "feasible": bool(result.passes),
                "reason": primary_reason,
            })
            if len(scatter) > 350:
                # Keep all feasible up to 200 + recent infeasible
                feas_pts = [pt for pt in scatter if pt["feasible"]][-200:]
                infeas_pts = [pt for pt in scatter if not pt["feasible"]][-150:]
                scatter[:] = infeas_pts + feas_pts

        if on_progress is not None and (now - last_emit >= 0.35 or tested <= 2):
            last_emit = now
            on_progress(build_snapshot(final=False))

        return score, params, result

    def _sample_outside_interval(lo: float, hi: float, ex: Tuple[float, float]) -> Optional[float]:
        segs = []
        if ex[0] > lo + 1e-6:
            segs.append((lo, min(hi, ex[0])))
        if ex[1] < hi - 1e-6:
            segs.append((max(lo, ex[1]), hi))
        if not segs:
            return None
        widths = np.array([b - a for a, b in segs], dtype=float)
        probs = widths / widths.sum()
        pick = int(rng.choice(len(segs), p=probs))
        return float(rng.uniform(segs[pick][0], segs[pick][1]))

    def clamp_pinch_in_z(z: np.ndarray, side_base: CompliantParams) -> np.ndarray:
        """Keep random draws inside pinch margins and outside any forbidden Junction J zone."""
        z = z.copy()
        row = z_to_row(z, side_base)
        if free_mask[idx_pinch] and (c.pinch_ceiling_margin_mm > 0 or c.pinch_floor_margin_mm > 0):
            p_lo = max(lows[idx_pinch], c.pinch_floor_margin_mm)
            p_hi = min(highs[idx_pinch], 2.0 * row[idx_h0] - c.pinch_ceiling_margin_mm)
            if p_hi > p_lo:
                local_p = int(np.where(free_idx == idx_pinch)[0][0])
                z[local_p] = (rng.uniform(p_lo, p_hi) - lows[idx_pinch]) / span[idx_pinch]
        ex, ey = c.junction_exclude_x, c.junction_exclude_y
        in_x = ex is not None and (ex[0] < row[idx_jx] < ex[1])
        in_y = ey is not None and (ey[0] < row[idx_jy] < ey[1])
        if ex is not None and ey is not None:
            if in_x and in_y:
                if free_mask[idx_jx] and (not free_mask[idx_jy] or rng.random() < 0.5):
                    v = _sample_outside_interval(lows[idx_jx], highs[idx_jx], ex)
                    if v is not None:
                        local_x = int(np.where(free_idx == idx_jx)[0][0])
                        z[local_x] = (v - lows[idx_jx]) / span[idx_jx]
                elif free_mask[idx_jy]:
                    v = _sample_outside_interval(lows[idx_jy], highs[idx_jy], ey)
                    if v is not None:
                        local_y = int(np.where(free_idx == idx_jy)[0][0])
                        z[local_y] = (v - lows[idx_jy]) / span[idx_jy]
        elif in_x and free_mask[idx_jx]:
            v = _sample_outside_interval(lows[idx_jx], highs[idx_jx], ex)
            if v is not None:
                local_x = int(np.where(free_idx == idx_jx)[0][0])
                z[local_x] = (v - lows[idx_jx]) / span[idx_jx]
        elif in_y and free_mask[idx_jy]:
            v = _sample_outside_interval(lows[idx_jy], highs[idx_jy], ey)
            if v is not None:
                local_y = int(np.where(free_idx == idx_jy)[0][0])
                z[local_y] = (v - lows[idx_jy]) / span[idx_jy]
        return z

    def gradient_pattern_refine(z0: np.ndarray, sc0: float, side_base: CompliantParams, max_iters: int = 18):
        """Projected SPSA gradient ascent + adaptive coordinate pattern search."""
        z = z0.copy()
        sc = sc0
        step = 0.08
        for it in range(max_iters):
            if time_up() or d == 0:
                break
            improved = False
            # SPSA simultaneous perturbation gradient estimate (2 evals regardless of dimension d!)
            delta = rng.choice([-1.0, 1.0], size=d)
            ck = max(0.015, step * 0.5)
            zp = np.clip(z + ck * delta, 0.0, 1.0)
            zm = np.clip(z - ck * delta, 0.0, 1.0)
            sp, _, _ = evaluate(zp, side_base)
            if sp > sc:
                z, sc, improved = zp, sp, True
            if time_up():
                break
            sm, _, _ = evaluate(zm, side_base)
            if sm > sc:
                z, sc, improved = zm, sm, True
            if time_up():
                break
            # Take a projected gradient step along the estimated ascent direction
            g_est = (sp - sm) / (2.0 * ck) * delta
            gnorm = float(np.linalg.norm(g_est))
            if gnorm > 1e-12:
                direction = g_est / gnorm
                for mult in (1.5, 0.7):
                    if time_up():
                        break
                    zt = np.clip(z + step * mult * direction, 0.0, 1.0)
                    st, _, _ = evaluate(zt, side_base)
                    if st > sc:
                        z, sc, improved = zt, st, True
                        break
            # Every 3rd iteration, probe a few individual coordinates for axis-aligned ridges
            if not improved and (it % 2 == 1):
                axes = rng.permutation(d)[: min(d, 5)]
                for ax in axes:
                    if time_up():
                        break
                    for sgn in (1.0, -1.0):
                        zt = z.copy()
                        zt[ax] = float(np.clip(zt[ax] + sgn * step, 0.0, 1.0))
                        st, _, _ = evaluate(zt, side_base)
                        if st > sc:
                            z, sc, improved = zt, st, True
                            break
            if improved:
                step = min(0.18, step * 1.15)
            else:
                step *= 0.6
                if step < 0.004:
                    break
        return z, sc

    def nelder_mead_polish(z0: np.ndarray, sc0: float, side_base: CompliantParams, max_evals: int = 45):
        """Lightweight bounded Nelder-Mead simplex polish on up to 8 active dimensions."""
        if d == 0 or time_up():
            return z0, sc0
        # Work on a random/priority subset of up to 8 dims if d > 8 so simplex converges quickly
        sub_d = min(d, 8)
        sub_axes = rng.choice(d, size=sub_d, replace=False) if d > sub_d else np.arange(d)
        simplex = [z0.copy()]
        scores = [sc0]
        evals = 0
        for ax in sub_axes:
            if time_up() or evals >= max_evals:
                break
            v = z0.copy()
            v[ax] = float(np.clip(v[ax] + (0.05 if v[ax] < 0.9 else -0.05), 0.0, 1.0))
            s, _, _ = evaluate(v, side_base)
            evals += 1
            simplex.append(v)
            scores.append(s)

        while evals < max_evals and not time_up() and len(simplex) == sub_d + 1:
            order = np.argsort(scores)[::-1]  # descending (maximize)
            simplex = [simplex[i] for i in order]
            scores = [scores[i] for i in order]
            centroid = np.mean(simplex[:-1], axis=0)
            xr = np.clip(centroid + 1.0 * (centroid - simplex[-1]), 0.0, 1.0)
            sr, _, _ = evaluate(xr, side_base)
            evals += 1
            if sr > scores[0]:
                xe = np.clip(centroid + 2.0 * (xr - centroid), 0.0, 1.0)
                se, _, _ = evaluate(xe, side_base)
                evals += 1
                if se > sr:
                    simplex[-1], scores[-1] = xe, se
                else:
                    simplex[-1], scores[-1] = xr, sr
            elif sr > scores[-2]:
                simplex[-1], scores[-1] = xr, sr
            else:
                xc = np.clip(centroid + 0.5 * (simplex[-1] - centroid), 0.0, 1.0)
                sc_c, _, _ = evaluate(xc, side_base)
                evals += 1
                if sc_c > scores[-1]:
                    simplex[-1], scores[-1] = xc, sc_c
                else:
                    # Shrink toward best
                    best_v = simplex[0]
                    for i in range(1, len(simplex)):
                        if time_up() or evals >= max_evals:
                            break
                        simplex[i] = np.clip(best_v + 0.5 * (simplex[i] - best_v), 0.0, 1.0)
                        scores[i], _, _ = evaluate(simplex[i], side_base)
                        evals += 1
        best_i = int(np.argmax(scores))
        return simplex[best_i], scores[best_i]

    def cma_es_run(z0: np.ndarray, sigma0: float, lam: int, side_base: CompliantParams, label: str) -> None:
        """One (mu/mu_w, lambda)-CMA-ES run in the unit box, until it converges, stalls or the budget ends.

        Hansen's standard strategy parameters. A sample outside the box is scored at its nearest point
        inside, plus a penalty that grows with the distance, so the mean is pulled back in.
        """
        nonlocal phase, wave
        n = d
        mu = lam // 2
        w = np.log(mu + 0.5) - np.log(np.arange(1, mu + 1))
        w = w / np.sum(w)
        mueff = 1.0 / float(np.sum(w ** 2))
        cc = (4.0 + mueff / n) / (n + 4.0 + 2.0 * mueff / n)
        cs = (mueff + 2.0) / (n + mueff + 5.0)
        c1 = 2.0 / ((n + 1.3) ** 2 + mueff)
        cmu = min(1.0 - c1, 2.0 * (mueff - 2.0 + 1.0 / mueff) / ((n + 2.0) ** 2 + mueff))
        damps = 1.0 + 2.0 * max(0.0, np.sqrt((mueff - 1.0) / (n + 1.0)) - 1.0) + cs
        chi_n = np.sqrt(n) * (1.0 - 1.0 / (4.0 * n) + 1.0 / (21.0 * n * n))
        mean = np.clip(z0.astype(float), 0.0, 1.0)
        sigma = float(sigma0)
        pc, ps = np.zeros(n), np.zeros(n)
        b_mat, d_vec, c_mat = np.eye(n), np.ones(n), np.eye(n)
        inv_sqrt_c = np.eye(n)
        eigen_every = max(1, int(1.0 / ((c1 + cmu) * n * 10.0)))
        gen = 0
        gen_best: List[float] = []
        stall_window = 25 + int(30 * n / lam)
        while not time_up():
            wave += 1
            phase = f"{label}: generation {gen + 1} (λ = {lam}, step {sigma:.3f})"
            arz = rng.standard_normal((lam, n))
            arx = mean + sigma * (arz * d_vec) @ b_mat.T
            inside = np.clip(arx, 0.0, 1.0)
            scores = evaluate_many(inside, side_base)
            if len(scores) < lam:
                return                      # budget ended inside this generation
            fit = -np.array(scores) + 10.0 * np.sum((arx - inside) ** 2, axis=1)
            order = np.argsort(fit, kind="stable")
            old = mean
            chosen = arx[order[:mu]]
            mean = np.clip(w @ chosen, 0.0, 1.0)
            y_w = (mean - old) / sigma
            ps = (1.0 - cs) * ps + np.sqrt(cs * (2.0 - cs) * mueff) * (inv_sqrt_c @ y_w)
            hsig = float(np.linalg.norm(ps) / np.sqrt(1.0 - (1.0 - cs) ** (2.0 * (gen + 1))) / chi_n < 1.4 + 2.0 / (n + 1.0))
            pc = (1.0 - cc) * pc + hsig * np.sqrt(cc * (2.0 - cc) * mueff) * y_w
            steps = (chosen - old) / sigma
            c_mat = (
                (1.0 - c1 - cmu) * c_mat
                + c1 * (np.outer(pc, pc) + (1.0 - hsig) * cc * (2.0 - cc) * c_mat)
                + cmu * (steps.T * w) @ steps
            )
            sigma = float(min(0.5, sigma * np.exp((cs / damps) * (np.linalg.norm(ps) / chi_n - 1.0))))
            gen += 1
            if gen % eigen_every == 0:
                c_mat = np.triu(c_mat) + np.triu(c_mat, 1).T
                eig, b_mat = np.linalg.eigh(c_mat)
                d_vec = np.sqrt(np.maximum(eig, 1e-20))
                inv_sqrt_c = (b_mat / d_vec) @ b_mat.T
            gen_best.append(float(fit[order[0]]))
            if sigma * float(np.max(d_vec)) < 2e-4:
                return                      # converged: every direction is below 0.02 % of its range
            if float(np.max(d_vec)) > 1e7 * float(np.min(d_vec)):
                return                      # degenerate covariance
            if len(gen_best) >= 2 * stall_window:
                recent = min(gen_best[-stall_window:])
                before = min(gen_best[-2 * stall_window:-stall_window])
                if recent >= before - 1e-6 * max(1.0, abs(before)):
                    return                  # no gain over a whole window

    # ── Main time-budgeted loop dispatched by selected search method ────────
    # Evaluate starting point(s) first
    start_evals: List[Tuple[np.ndarray, float, bool]] = []
    for inv in sides:
        side_base = replace(base, pivot_inverted=inv)
        cur_row = np.array([getattr(side_base, k) for k in keys], dtype=float)
        z_cur = row_to_z(cur_row)
        sc_cur, _, _ = evaluate(z_cur, side_base)
        start_evals.append((z_cur, sc_cur, inv))

    if method == "cmaes":
        lam0 = int(float(mp.get("pop_size") or 0))
        if lam0 <= 0:
            lam0 = 2 * (4 + int(3.0 * np.log(max(d, 1))))
        lam0 = int(np.clip(lam0, 6, 200))
        sigma_start = float(np.clip(float(mp.get("sigma0") or 0.2), 0.02, 0.5))
        workers = int(float(mp.get("workers") or 0)) or _default_workers()
        if workers > 1 and d > 0 and not multiprocessing.current_process().daemon:
            # "spawn": the server runs threads, and a forked child would inherit their locks.
            pool = multiprocessing.get_context("spawn").Pool(int(min(workers, 32)))
        restart = 0
        lam_global = lam0
        try:
            while d > 0 and not time_up():
                if restart < len(start_evals):
                    # First, one run per pivot side from the design on screen.
                    z_from, _sc, inv = start_evals[restart]
                    cma_es_run(z_from, sigma_start, lam0, replace(base, pivot_inverted=inv), f"Run {restart + 1} from the current design")
                elif (restart - len(start_evals)) % 2 == 0 and admissible_pool:
                    # Then alternate: tighten around the leader...
                    admissible_pool.sort(key=lambda item: item[0], reverse=True)
                    _sc, prm_top, _res, z_top = admissible_pool[0]
                    cma_es_run(z_top, 0.3 * sigma_start, lam0, replace(base, pivot_inverted=prm_top.pivot_inverted), f"Run {restart + 1} around the leader")
                else:
                    # ...and look elsewhere with a larger population each time.
                    lam_global = int(min(200, lam_global * 2))
                    inv = sides[restart % len(sides)]
                    side_base = replace(base, pivot_inverted=inv)
                    z_far = clamp_pinch_in_z(rng.random(d), side_base)
                    cma_es_run(z_far, 0.3, lam_global, side_base, f"Run {restart + 1} from elsewhere")
                restart += 1
        finally:
            if pool is not None:
                pool.terminate()
                pool.join()
                pool = None

    elif method == "brute_force":
        conservative_rate = 45.0  # conservative eval/s floor so planned sweep fits inside time budget
        sampling = str(mp.get("sampling", "lhs"))
        if sampling == "grid" and d > 0:
            k_steps = int(np.clip(int(mp.get("steps_per_var", 3)), 2, 12))
            grid_vals = np.linspace(0.0, 1.0, k_steps)
            max_exact = 200_000
            total_per_side = k_steps ** d if d <= 20 else max_exact + 1
            total_planned = min(max_exact * len(sides), total_per_side * len(sides))
            wave = 1
            if total_per_side <= max_exact:
                # Shuffled full Cartesian grid interleaved across pivot sides for uniform coverage even on early stop
                order = rng.permutation(total_per_side)
                for step_i, flat_idx in enumerate(order):
                    if time_up():
                        break
                    phase = f"Cartesian grid ({k_steps} steps/var · {tested}/{total_planned})"
                    # Decode base-k coordinates
                    rem = int(flat_idx)
                    z = np.empty(d, dtype=float)
                    for ax in range(d):
                        z[ax] = grid_vals[rem % k_steps]
                        rem //= k_steps
                    for inv in sides:
                        if time_up():
                            break
                        side_base = replace(base, pivot_inverted=inv)
                        evaluate(clamp_pinch_in_z(z, side_base), side_base)
            else:
                # High-dimensional grid (k^d > 200k): random draws strictly on the k-step grid nodes
                while not time_up():
                    wave += 1
                    phase = f"Grid sample ({k_steps} steps/var · {tested} tested)"
                    idx_vec = rng.integers(0, k_steps, size=d)
                    z = grid_vals[idx_vec]
                    for inv in sides:
                        if time_up():
                            break
                        side_base = replace(base, pivot_inverted=inv)
                        evaluate(clamp_pinch_in_z(z, side_base), side_base)
        elif sampling == "lhs" and d > 0:
            # One single global stratified Latin Hypercube sized conservatively to fit time_budget_s
            n_target = int(np.clip(int(mp.get("target_evals") or round(time_budget_s * conservative_rate)), 16, 200_000))
            per_side = max(8, n_target // len(sides))
            wave = 1
            lhs_by_side = {inv: _latin_hypercube(per_side, d, rng) for inv in sides}
            for idx_pt in range(per_side):
                if time_up():
                    break
                phase = f"Calibrated LHS sweep ({tested}/{per_side * len(sides)} · {per_side} strata/axis)"
                for inv in sides:
                    if time_up():
                        break
                    side_base = replace(base, pivot_inverted=inv)
                    evaluate(clamp_pinch_in_z(lhs_by_side[inv][idx_pt], side_base), side_base)
        else:
            batch_size = int(np.clip(int(mp.get("batch_size", 64)), 12, 240))
            while not time_up() and d > 0:
                wave += 1
                phase = f"Wave {wave}: Brute-force Uniform sweep"
                per_side = max(4, batch_size // len(sides))
                for inv in sides:
                    if time_up():
                        break
                    side_base = replace(base, pivot_inverted=inv)
                    pts = rng.random((per_side, d))
                    for z in pts:
                        if time_up():
                            break
                        evaluate(clamp_pinch_in_z(z, side_base), side_base)

    elif method == "evolutionary":
        pop_size = int(np.clip(int(mp.get("pop_size", 28)), 10, 80))
        mut_f = float(np.clip(float(mp.get("mutation_f", 0.7)), 0.2, 1.4))
        cross_cr = float(np.clip(float(mp.get("crossover_cr", 0.8)), 0.1, 1.0))
        if d > 0:
            # Initialize population per side via LHS
            wave = 1
            phase = f"Gen 1: Initializing DE population ({pop_size})"
            pops: Dict[bool, Tuple[List[np.ndarray], List[float]]] = {}
            per_side = max(6, pop_size // len(sides))
            for inv in sides:
                side_base = replace(base, pivot_inverted=inv)
                zs = [clamp_pinch_in_z(z, side_base) for z in _latin_hypercube(per_side, d, rng)]
                scs = []
                for z in zs:
                    if time_up():
                        break
                    sc, _, _ = evaluate(z, side_base)
                    scs.append(sc)
                pops[inv] = (zs[: len(scs)], scs)
            while not time_up():
                wave += 1
                phase = f"Gen {wave}: Differential Evolution (F={mut_f:.2f}, CR={cross_cr:.2f})"
                for inv in sides:
                    if time_up():
                        break
                    side_base = replace(base, pivot_inverted=inv)
                    pop_z, pop_sc = pops[inv]
                    n_pop = len(pop_z)
                    if n_pop < 4:
                        continue
                    for i in range(n_pop):
                        if time_up():
                            break
                        idxs = [j for j in range(n_pop) if j != i]
                        a, b, c_idx = rng.choice(idxs, size=3, replace=False)
                        mutant = np.clip(pop_z[a] + mut_f * (pop_z[b] - pop_z[c_idx]), 0.0, 1.0)
                        mask = rng.random(d) < cross_cr
                        mask[int(rng.integers(0, d))] = True
                        trial = np.where(mask, mutant, pop_z[i])
                        trial = clamp_pinch_in_z(trial, side_base)
                        sc_t, _, _ = evaluate(trial, side_base)
                        if sc_t >= pop_sc[i]:
                            pop_z[i] = trial
                            pop_sc[i] = sc_t

    elif method == "local_refine":
        radius = float(np.clip(float(mp.get("search_radius", 0.15)), 0.02, 0.5))
        restarts = int(np.clip(int(mp.get("restarts", 4)), 1, 16))
        while not time_up() and d > 0:
            wave += 1
            # Start from best feasible if found, else from initial design
            if admissible_pool:
                admissible_pool.sort(key=lambda item: item[0], reverse=True)
                sc_base, prm_base, _, z_base = admissible_pool[0]
                inv_base = prm_base.pivot_inverted
            else:
                z_base, sc_base, inv_base = max(start_evals, key=lambda x: x[1])
            side_base = replace(base, pivot_inverted=inv_base)
            phase = f"Pass {wave}: Local gradient polish (r={radius:.2f})"
            z_cur, sc_cur = gradient_pattern_refine(z_base, sc_base, side_base, max_iters=18)
            if not time_up():
                phase = f"Pass {wave}: Nelder-Mead local simplex"
                nelder_mead_polish(z_cur, sc_cur, side_base, max_evals=50)
            # Perturbed local restarts around the current leader
            for r_i in range(restarts):
                if time_up():
                    break
                phase = f"Pass {wave}: Perturbed restart {r_i + 1}/{restarts}"
                inv_r = sides[r_i % len(sides)]
                sb_r = replace(base, pivot_inverted=inv_r)
                z_pert = np.clip(z_base + rng.normal(0.0, radius * 0.5, size=d), 0.0, 1.0)
                z_pert = clamp_pinch_in_z(z_pert, sb_r)
                sc_p, _, _ = evaluate(z_pert, sb_r)
                if not time_up():
                    gradient_pattern_refine(z_pert, sc_p, sb_r, max_iters=12)

    else:
        # Default: hybrid (LHS waves + projected gradient/pattern + Nelder-Mead)
        lhs_batch = int(np.clip(int(mp.get("lhs_batch_size", 48)), 12, 180))
        refine_seeds = int(np.clip(int(mp.get("refine_seeds", 3)), 1, 8))
        polish_evals = int(np.clip(int(mp.get("polish_evals", 40)), 10, 120))
        while not time_up():
            wave += 1
            phase = f"Wave {wave}: Global LHS exploration"
            n_lhs = lhs_batch if wave == 1 else max(16, int(lhs_batch * 0.7))
            per_side = max(4, n_lhs // len(sides))
            for inv in sides:
                if time_up():
                    break
                side_base = replace(base, pivot_inverted=inv)
                if d == 0:
                    break
                lhs = _latin_hypercube(per_side, d, rng)
                for z in lhs:
                    if time_up():
                        break
                    evaluate(clamp_pinch_in_z(z, side_base), side_base)

            if d == 0 or time_up():
                break

            phase = f"Wave {wave}: Gradient & pattern refinement"
            seeds: List[Tuple[np.ndarray, float, bool]] = []
            if admissible_pool:
                admissible_pool.sort(key=lambda item: item[0], reverse=True)
                for sc, prm, _res, z in admissible_pool[:16]:
                    if len(seeds) >= refine_seeds:
                        break
                    if all(float(np.linalg.norm(z - sz)) > 0.12 for sz, _, _ in seeds):
                        seeds.append((z.copy(), sc, prm.pivot_inverted))
            if len(seeds) < min(2, refine_seeds) and near_pool:
                near_pool.sort(key=lambda item: item[0], reverse=True)
                for sc, _prm, _res, z, inv in near_pool[:10]:
                    if len(seeds) >= refine_seeds:
                        break
                    if all(float(np.linalg.norm(z - sz)) > 0.12 for sz, _, _ in seeds):
                        seeds.append((z.copy(), sc, inv))

            for z_seed, sc_seed, inv in seeds:
                if time_up():
                    break
                side_base = replace(base, pivot_inverted=inv)
                gradient_pattern_refine(z_seed, sc_seed, side_base, max_iters=14)

            if admissible_pool and not time_up():
                phase = f"Wave {wave}: Nelder-Mead local polish"
                admissible_pool.sort(key=lambda item: item[0], reverse=True)
                sc_top, prm_top, _res_top, z_top = admissible_pool[0]
                side_base = replace(base, pivot_inverted=prm_top.pivot_inverted)
                nelder_mead_polish(z_top, sc_top, side_base, max_evals=polish_evals)

    # ── Final full-resolution verification ──────────────────────────────────
    phase = "Final verification"
    runners = _extract_runners()
    verified_runners: List[Tuple[float, CompliantParams, CompliantResult]] = []
    tail_runners: List[Tuple[float, CompliantParams, CompliantResult]] = []
    failed_full: Optional[Tuple[float, CompliantParams, CompliantResult]] = None
    full_checks = 0
    for sc_r, prm_r, res_r in runners:
        if len(verified_runners) < 8 and full_checks < 16:
            full_r = compute_compliant(prm_r, fast=False, constraints=c)
            full_checks += 1
            if full_r.passes:
                full_sc = admission_score(full_r, c, goal=goal, goal_weights=norm_weights)
                verified_runners.append((full_sc, prm_r, full_r))
            elif failed_full is None:
                failed_full = (sc_r, prm_r, full_r)
        else:
            tail_runners.append((sc_r, prm_r, res_r))
    # If all shortlisted runners sat on a knife-edge boundary and failed full-res, probe deeper in admissible_pool.
    if not verified_runners and admissible_pool:
        admissible_pool.sort(key=lambda item: item[0], reverse=True)
        for sc_p, prm_p, _res_p, _z in admissible_pool:
            if full_checks >= 24:
                break
            full_r = compute_compliant(prm_p, fast=False, constraints=c)
            full_checks += 1
            if full_r.passes:
                full_sc = admission_score(full_r, c, goal=goal, goal_weights=norm_weights)
                verified_runners.append((full_sc, prm_p, full_r))
                break
    verified_runners.sort(key=lambda item: item[0], reverse=True)
    full_runners = verified_runners + tail_runners
    winner = verified_runners[0] if verified_runners else failed_full
    full = winner[2] if winner else None
    snapshot = build_snapshot(final=True)
    if full_runners:
        snapshot["runners"] = [_runner_brief(p, r, s, keys) for s, p, r in full_runners]
    if verified_runners:
        best_sc0, _best_p0, best_r0 = verified_runners[0]
        snapshot["best_score"] = round(float(best_sc0), 4)
        snapshot["best_dx_at_025_mm"] = round(float(best_r0.dx_at_025_mm), 4) if best_r0.dx_at_025_mm is not None else None
        snapshot["best_slope"] = round(float(best_r0.flow_slope_mean), 3) if best_r0.flow_slope_mean is not None else None
        snapshot["best_y_90_mm"] = round(float(best_r0.y_90_mm), 3) if best_r0.y_90_mm is not None else None
        snapshot["best_attack_angle_deg"] = round(float(best_r0.attack_angle_deg), 1) if best_r0.attack_angle_deg is not None else None
        snapshot["best_stress_mpa"] = round(float(best_r0.max_stress_mpa), 1) if best_r0.max_stress_mpa is not None else None
        if best_r0.chamber_t100_ms is not None:
            snapshot["best_chamber_t100_ms"] = round(float(best_r0.chamber_t100_ms), 1)
        if best_r0.chamber_cycle_freq_hz is not None:
            snapshot["best_chamber_cycle_freq_hz"] = round(float(best_r0.chamber_cycle_freq_hz), 3)
        if best_r0.chamber_bandwidth_hz is not None:
            snapshot["best_chamber_bandwidth_hz"] = round(float(best_r0.chamber_bandwidth_hz), 3)
        if best_r0.energy_cycle_mj is not None:
            snapshot["best_energy_cycle_mj"] = round(float(best_r0.energy_cycle_mj), 2)
        if best_r0.peak_thrust_op_n is not None:
            snapshot["best_peak_thrust_op_n"] = round(float(best_r0.peak_thrust_op_n), 2)
        if best_r0.peak_torque_op_mnm is not None:
            snapshot["best_peak_torque_op_mnm"] = round(float(best_r0.peak_torque_op_mnm), 2)
        if best_r0.stall_y_mm is not None:
            snapshot["best_stall_y_mm"] = round(float(best_r0.stall_y_mm), 3)
    if on_progress is not None:
        on_progress(snapshot)

    fallback_msg = best_overall[2].message if best_overall is not None else "No candidate evaluated."
    found = bool(winner is not None and full is not None and full.passes)
    return {
        "found": found,
        "tested": tested,
        "feasible": feasible_count,
        "result": asdict(full) if full is not None else None,
        "params": asdict(winner[1]) if winner else None,
        "runners": snapshot["runners"],
        "summary": snapshot,
        "message": full.message if full is not None else fallback_msg,
    }


class CompliantSolveJobManager:
    """In-memory background job runner with SQLite persistence for finished solve experiments."""

    def __init__(self, exp_storage: CompliantExperimentStorage):
        self._storage = exp_storage
        self._lock = threading.Lock()
        self._jobs: Dict[str, dict] = {}
        self._cancels: Dict[str, threading.Event] = {}

    def start_job(
        self,
        params_dict: dict,
        bounds: Dict[str, Tuple[float, float]],
        constraints_dict: Optional[dict],
        pivot_side: str,
        goal: str,
        time_budget_s: float,
        goal_weights: Optional[Dict[str, float]] = None,
        method: str = "hybrid",
        method_params: Optional[Dict[str, Any]] = None,
        name: Optional[str] = None,
        note: str = "",
    ) -> dict:
        job_id = uuid.uuid4().hex[:12]
        now_label = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        method = method if method in SOLVER_METHODS else "hybrid"
        norm_w = normalize_goal_weights(goal, goal_weights)
        goal_label = " + ".join(f"{int(round(w * 100))}% {g}" for g, w in norm_w.items()) if len(norm_w) > 1 else next(iter(norm_w))
        exp_name = (name or "").strip() or f"[{method}] {goal_label} ({int(round(time_budget_s))}s) · {now_label}"
        cancel_ev = threading.Event()
        request_payload = {
            "params": params_dict,
            "bounds": {k: list(v) for k, v in bounds.items()},
            "constraints": constraints_dict or {},
            "pivot_side": pivot_side,
            "goal": goal,
            "goal_weights": norm_w,
            "method": method,
            "method_params": dict(method_params or {}),
            "time_budget_s": time_budget_s,
        }
        job_state = {
            "job_id": job_id,
            "experiment_id": job_id,
            "name": exp_name,
            "note": note,
            "status": "running",
            "goal": goal,
            "goal_weights": norm_w,
            "method": method,
            "method_params": dict(method_params or {}),
            "time_budget_s": time_budget_s,
            "summary": None,
            "found": False,
            "params": None,
            "result": None,
            "runners": [],
            "message": "Starting solver…",
            "error": None,
        }
        with self._lock:
            self._jobs[job_id] = job_state
            self._cancels[job_id] = cancel_ev

        def _worker():
            try:
                base_p = _params_from_mapping(params_dict)
                cons = _constraints_from_mapping(constraints_dict)

                def _on_progress(snap: dict):
                    with self._lock:
                        j = self._jobs.get(job_id)
                        if j is not None:
                            j["summary"] = snap
                            j["runners"] = snap.get("runners", [])

                outcome = run_time_budgeted_solve(
                    base=base_p,
                    bounds=bounds,
                    time_budget_s=time_budget_s,
                    goal=goal,
                    goal_weights=norm_w,
                    method=method,
                    method_params=method_params,
                    constraints=cons,
                    pivot_side=pivot_side,
                    seed=None,                      # method_params["seed"], when set, makes the run repeatable
                    cancel_event=cancel_ev,
                    on_progress=_on_progress,
                )
                final_status = "cancelled" if cancel_ev.is_set() else "completed"
                summary = outcome["summary"]
                self._storage.save_experiment(
                    exp_id=job_id,
                    name=exp_name,
                    note=note,
                    status=final_status,
                    goal=goal,
                    time_budget_s=time_budget_s,
                    elapsed_s=summary["elapsed_s"],
                    tested=outcome["tested"],
                    feasible=outcome["feasible"],
                    best_score=summary.get("best_score"),
                    request=request_payload,
                    summary=summary,
                    best_params=outcome["params"],
                    best_result=outcome["result"],
                )
                with self._lock:
                    j = self._jobs.get(job_id)
                    if j is not None:
                        j["status"] = final_status
                        j["found"] = outcome["found"]
                        j["params"] = outcome["params"]
                        j["result"] = outcome["result"]
                        j["runners"] = outcome["runners"]
                        j["summary"] = summary
                        j["message"] = outcome["message"]
            except Exception as exc:
                with self._lock:
                    j = self._jobs.get(job_id)
                    if j is not None:
                        j["status"] = "failed"
                        j["error"] = str(exc)
                        j["message"] = str(exc)

        thread = threading.Thread(target=_worker, name=f"compliant-solve-{job_id}", daemon=True)
        thread.start()
        return self.get_job(job_id)  # type: ignore[return-value]

    def get_job(self, job_id: str) -> Optional[dict]:
        with self._lock:
            j = self._jobs.get(job_id)
            if j is not None:
                return dict(j)
        return None

    def cancel_job(self, job_id: str) -> bool:
        with self._lock:
            ev = self._cancels.get(job_id)
            if ev is None:
                return False
            ev.set()
            return True
