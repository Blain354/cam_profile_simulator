"""
Two-bar linkage pinch valve: kinematics, static flow and geometry search.

Frame (mm): x from the lead-screw axis (base centre), y up from the fixed anchor.
  A = (-anchor_distance, 0)          fixed pivot on the base
  B = (+pivot_offset, h0 + Y)        pivot on the carriage, moves with the screw
  P = elbow joining bar 1 (B-P, length L1) and bar 2 (P-A, length L2): the pinch point
The tube runs vertically at x = -tube_center_x and rests on a wall at
x = -(tube_center_x + tube_od / 2). P squeezes it against that wall.

Y = 0 is *defined* as the carriage position where the tube is just closed (plus
the preload), so h0 is solved from the geometry rather than given.

The second tube is the mirror image. "symmetric": mirrored left/right, both tubes
open together. "opposed": mirrored through the carriage pivot at Y = 0, so the
second tube sees the first one's law at -Y (one opens while the other is squeezed).
"""

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

try:  # run from backend/ (uvicorn main:app) or as the backend package (tests)
    from simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate
except ImportError:
    from .simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate

MIRROR_SYMMETRIC = "symmetric"
MIRROR_OPPOSED = "opposed"

N_SAMPLES = 241
N_SCORE = 60
_EPS = 1e-9


@dataclass
class LinkageParams:
    bar1_length: float = 13.0        # mm, carriage pivot -> elbow
    bar2_length: float = 7.8         # mm, elbow -> fixed anchor
    anchor_distance: float = 2.33    # mm, anchor offset from the base centre (tube side)
    pivot_offset: float = 3.9        # mm, carriage pivot offset from the screw axis (far side)
    tube_center_x: float = 8.0       # mm, tube axis distance from the screw axis
    pin_diameter: float = 1.0        # mm, pinch pin at the elbow
    preload: float = 0.1             # mm, extra squeeze past closure at Y = 0
    stroke: float = 3.0              # mm, carriage travel shown / optimised
    mirror_mode: str = MIRROR_SYMMETRIC
    target_exponent: float = 1.0     # target opening = (Y / stroke) ** exponent
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_psi: float = 15.0
    compliance: float = 0.7          # mm/MPa


@dataclass
class LinkageResult:
    feasible: bool
    message: str
    Y_positions: List[float] = field(default_factory=list)
    elbow_x: List[float] = field(default_factory=list)
    elbow_y: List[float] = field(default_factory=list)
    gap_a: List[Optional[float]] = field(default_factory=list)
    gap_b: List[Optional[float]] = field(default_factory=list)
    flow_a: List[Optional[float]] = field(default_factory=list)
    flow_b: List[Optional[float]] = field(default_factory=list)
    flow_target: List[Optional[float]] = field(default_factory=list)
    pivot_height_y0: float = 0.0     # h0
    wall_x: float = 0.0
    closed_gap: float = 0.0          # pin-to-wall gap at which flow starts
    full_open_gap: float = 0.0       # pin-to-wall gap at which flow saturates
    y_min: float = 0.0               # reachable carriage range
    y_max: float = 0.0
    y_full_open: Optional[float] = None
    sensitivity_y0: float = 0.0      # d(gap)/dY at Y = 0
    pinch_slide: float = 0.0         # elbow travel along the tube over the stroke
    max_oversqueeze: float = 0.0     # worst squeeze past closure on either tube
    max_flow_l_min: float = 0.0
    rms_error: Optional[float] = None


def _elbow(l1, l2, xa, xb, h):
    """Elbow position for carriage pivot height h; NaN where the bars cannot reach."""
    dx = xb - xa
    d = np.sqrt(dx * dx + h * h)
    along = (l2 * l2 - l1 * l1 + d * d) / (2.0 * d)
    perp_sq = l2 * l2 - along * along
    perp = np.sqrt(np.where(perp_sq >= 0.0, perp_sq, np.nan))
    # Elbow on the tube side of the A->B line.
    return xa + (along * dx - perp * h) / d, (along * h + perp * dx) / d


def _closure(p: LinkageParams) -> Tuple[float, float, float, float]:
    """wall_x, closed gap, full-open gap, pressure opening (all mm)."""
    wall_x = p.tube_center_x + p.tube_od / 2.0
    opening = p.compliance * p.input_pressure_psi * 0.00689476
    closed_gap = (p.tube_od - p.tube_id) - opening
    # Same area law as the cam model: (pi/2 * ID) * inner_gap, capped at the bore.
    return wall_x, closed_gap, closed_gap + p.tube_id / 2.0, opening


def _pivot_height_y0(l1, l2, xa, xb, x_elbow_closed):
    """Carriage pivot height that puts the elbow at x_elbow_closed (elbow above the anchor, carriage above the elbow)."""
    c = (x_elbow_closed - xa) / l2
    s_sq = 1.0 - c * c
    y_elbow = l2 * np.sqrt(np.where(s_sq >= 0.0, s_sq, np.nan))
    reach_sq = l1 * l1 - (xb - x_elbow_closed) ** 2
    return y_elbow + np.sqrt(np.where(reach_sq >= 0.0, reach_sq, np.nan))


def _static_flow_l_min(p: LinkageParams, gap: np.ndarray, closed_gap: float) -> np.ndarray:
    inner = np.clip(gap - closed_gap, 0.0, None)
    area = np.minimum((np.pi / 2.0) * p.tube_id * inner, np.pi * (p.tube_id / 2.0) ** 2)
    p_up = P_ATM + p.input_pressure_psi * 6894.76
    rho_up = p_up / (R_AIR * T_AMB)
    # Static model: downstream at atmosphere, so mass flow is linear in area.
    per_mm2 = _compute_orifice_mass_flow_rate(1.0, p_up, P_ATM) / rho_up * 60.0 * 1000.0
    return area * per_mm2


def _nan_to_none(a: np.ndarray) -> List[Optional[float]]:
    return [None if not np.isfinite(v) else float(v) for v in a]


def compute_linkage(p: LinkageParams) -> LinkageResult:
    if min(p.bar1_length, p.bar2_length, p.stroke, p.tube_id) <= 0 or p.tube_od <= p.tube_id:
        return LinkageResult(False, "Lengths, stroke and tube sizes must be positive, with OD > ID.")
    l1, l2 = p.bar1_length, p.bar2_length
    xa, xb = -p.anchor_distance, p.pivot_offset
    wall_x, closed_gap, full_open_gap, _ = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)

    h0 = float(_pivot_height_y0(l1, l2, xa, xb, x_closed))
    if not np.isfinite(h0):
        return LinkageResult(
            False,
            "The elbow cannot reach the tube at Y = 0: bar 2 is too short for this anchor, or bar 1 too short for this pivot offset.",
            wall_x=wall_x, closed_gap=closed_gap, full_open_gap=full_open_gap,
        )

    y = np.linspace(-p.stroke, p.stroke, N_SAMPLES)
    ex, ey = _elbow(l1, l2, xa, xb, h0 + y)
    # Below the anchor line the elbow has gone through bar 2's dead centre: not a usable pose.
    ok = np.isfinite(ex) & (ey >= -_EPS) & (h0 + y > ey)
    ex, ey = np.where(ok, ex, np.nan), np.where(ok, ey, np.nan)
    gap_a = wall_x + ex - r_pin
    opposed = p.mirror_mode == MIRROR_OPPOSED
    gap_b = gap_a[::-1] if opposed else gap_a
    flow_a = np.where(ok, _static_flow_l_min(p, np.nan_to_num(gap_a, nan=0.0), closed_gap), np.nan)
    flow_b = flow_a[::-1] if opposed else flow_a
    q_max = float(_static_flow_l_min(p, np.array([full_open_gap]), closed_gap)[0])

    u = np.clip(y / p.stroke, 0.0, 1.0)
    target_gap = closed_gap + (full_open_gap - closed_gap) * u ** p.target_exponent
    flow_target = np.where(y >= 0.0, q_max * u ** p.target_exponent, np.nan)

    pos = y >= 0.0
    reach = np.where(ok)[0]
    # Contiguous reachable range around Y = 0.
    i0 = N_SAMPLES // 2
    lo = i0
    while lo > 0 and ok[lo - 1]:
        lo -= 1
    hi = i0
    while hi < N_SAMPLES - 1 and ok[hi + 1]:
        hi += 1
    full = np.where(pos & ok & (gap_a >= full_open_gap))[0]
    dy = y[1] - y[0]
    sens = float((gap_a[i0 + 1] - gap_a[i0]) / dy) if ok[i0 + 1] else 0.0
    stroke_ok = bool(np.all(ok[pos]))
    rms = None
    if stroke_ok:
        rms = float(np.sqrt(np.mean(((np.clip(gap_a[pos], None, full_open_gap) - target_gap[pos]) / (full_open_gap - closed_gap)) ** 2)))
    squeeze = closed_gap - np.nanmin(np.concatenate([gap_a[pos], gap_b[pos]])) if stroke_ok else 0.0

    if len(reach) == 0 or not ok[i0]:
        msg = "Linkage cannot be assembled at Y = 0."
    elif not stroke_ok:
        msg = "Bars reach full extension at Y = %.2f mm, before the end of the stroke." % y[hi]
    elif opposed and lo > 0:
        msg = "Opposed tube: the linkage locks at Y = %.2f mm (bar 2 passes dead centre) before -stroke." % y[lo]
    else:
        msg = "ok"

    return LinkageResult(
        feasible=stroke_ok and not (opposed and lo > 0),
        message=msg,
        Y_positions=y.tolist(),
        elbow_x=_nan_to_none(ex),
        elbow_y=_nan_to_none(ey),
        gap_a=_nan_to_none(gap_a),
        gap_b=_nan_to_none(gap_b),
        flow_a=_nan_to_none(flow_a),
        flow_b=_nan_to_none(flow_b),
        flow_target=_nan_to_none(flow_target),
        pivot_height_y0=h0,
        wall_x=wall_x,
        closed_gap=closed_gap,
        full_open_gap=full_open_gap,
        y_min=float(y[lo]),
        y_max=float(y[hi]),
        y_full_open=float(y[full[0]]) if len(full) else None,
        sensitivity_y0=sens,
        pinch_slide=float(abs(ey[hi] - ey[i0])) if stroke_ok else 0.0,
        max_oversqueeze=float(max(squeeze, 0.0)),
        max_flow_l_min=q_max,
        rms_error=rms,
    )


@dataclass
class LinkageSearch:
    bar1_min: float = 6.0
    bar1_max: float = 20.0
    bar2_min: float = 3.0
    bar2_max: float = 14.0
    anchor_min: float = 0.0
    anchor_max: float = 6.0
    min_pivot_height: float = 3.0     # mm, carriage pivot above the anchor at Y = 0
    max_pivot_height: float = 16.0    # mm, carriage pivot above the anchor at the top of the stroke
    max_oversqueeze: float = 0.5      # mm, opposed mode only
    grid: int = 36


def _score_grid(p: LinkageParams, s: LinkageSearch, l1, l2, a) -> np.ndarray:
    """RMS opening error for broadcastable arrays of candidates; inf where infeasible."""
    wall_x, closed_gap, full_open_gap, _ = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)
    xa, xb = -a, p.pivot_offset
    with np.errstate(invalid="ignore", divide="ignore"):
        h0 = _pivot_height_y0(l1, l2, xa, xb, x_closed)
        y = np.linspace(0.0, p.stroke, N_SCORE)
        ex, ey = _elbow(l1[..., None], l2[..., None], xa[..., None], xb, h0[..., None] + y)
        gap = wall_x + ex - r_pin
        u = y / p.stroke
        target = closed_gap + (full_open_gap - closed_gap) * u ** p.target_exponent
        err = (np.minimum(gap, full_open_gap) - target) / (full_open_gap - closed_gap)
        rms = np.sqrt(np.mean(err * err, axis=-1))
        ok = (
            np.isfinite(rms)
            & (h0 >= s.min_pivot_height)
            & (h0 + p.stroke <= s.max_pivot_height)
            & np.all(ey >= 0.0, axis=-1)
            & np.all(h0[..., None] + y > ey, axis=-1)
        )
        if p.mirror_mode == MIRROR_OPPOSED:
            bx, by = _elbow(l1[..., None], l2[..., None], xa[..., None], xb, h0[..., None] - y)
            squeeze = closed_gap - (wall_x + bx - r_pin)
            ok &= np.all(np.isfinite(bx), axis=-1) & np.all(by >= 0.0, axis=-1)
            ok &= np.nanmax(np.where(np.isfinite(squeeze), squeeze, np.inf), axis=-1) <= s.max_oversqueeze
    return np.where(ok, rms, np.inf)


def optimize_linkage(
    p: LinkageParams, s: LinkageSearch
) -> Tuple[Optional[LinkageParams], int, int]:
    """Coarse grid over (L1, L2, anchor) then three zooms around the best cell.

    Returns (best params or None, feasible count on the coarse grid, coarse grid size).
    """
    n = int(min(max(s.grid, 8), 60))
    bounds = [(s.bar1_min, s.bar1_max), (s.bar2_min, s.bar2_max), (s.anchor_min, s.anchor_max)]
    bounds = [(min(lo, hi), max(lo, hi)) for lo, hi in bounds]
    best = None
    best_score = np.inf
    feasible = 0
    lo_hi = bounds
    for level in range(4):
        axes = [np.linspace(lo, hi, n) for lo, hi in lo_hi]
        l1, l2, a = np.meshgrid(*axes, indexing="ij")
        score = _score_grid(p, s, l1, l2, a)
        if level == 0:
            feasible = int(np.isfinite(score).sum())
            if feasible == 0:
                return None, 0, score.size
        idx = np.unravel_index(int(np.argmin(score)), score.shape)
        if score[idx] < best_score:
            best_score = float(score[idx])
            best = (float(l1[idx]), float(l2[idx]), float(a[idx]))
        # Zoom: +/- one and a half cells around the best point, clamped to the user's bounds.
        lo_hi = []
        for (lo, hi), (blo, bhi), c in zip([(ax[0], ax[-1]) for ax in axes], bounds, best):
            half = 1.5 * (hi - lo) / (n - 1) if n > 1 else 0.0
            lo_hi.append((max(blo, c - half), min(bhi, c + half)))
    out = LinkageParams(**{**p.__dict__, "bar1_length": round(best[0], 3), "bar2_length": round(best[1], 3), "anchor_distance": round(best[2], 3)})
    return out, feasible, n ** 3
