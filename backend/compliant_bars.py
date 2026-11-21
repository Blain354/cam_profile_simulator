"""Compliant bars: three cubic Bézier members, one beam, overlap fused into rigid spans.

Rest shape is the Y = 0 pose (tube just closed). L is built into the shell at the anchor,
R is pinned to the carriage, the foot pushes the tube. Where two thicknesses overlap away
from the shared junction, those spans are tied by rigid links and stiffened, so bending
stays in the free lengths.

Small-deflection beam theory, same element as linkage._frame_solve, with a stiffness per
element. A rotation past about 15 degrees is reported; the linear model is then only a guide.
"""

from dataclasses import asdict, dataclass, fields, replace
from typing import Dict, List, Optional, Tuple

import numpy as np

try:  # uvicorn from backend/, or `python -m` from the repo root
    from linkage import (
        LinkageParams, _area_mm2, _chamber_cycle, _chamber_rise_times, _closure,
        _flow_derivatives, _nan_to_none, _pinch_force, _solve_contact_flex,
    )
    from simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate
except ImportError:
    from .linkage import (
        LinkageParams, _area_mm2, _chamber_cycle, _chamber_rise_times, _closure,
        _flow_derivatives, _nan_to_none, _pinch_force, _solve_contact_flex,
    )
    from .simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate

N_SPAN = 13          # samples per spline, including both ends
N_Y = 61
N_Y_FAST = 21
CLEARANCE_MIN = 0.05   # mm, closer than this counts as contact
ANCHOR_EMBED = 2.0     # mm, L may cross the shell at the anchor
RIGID = 40.0           # overlap spans: stiffness and section both scale, so stress stays honest
EYE_FACTOR = 1.6       # R nodes this many pin-diameters from the pivot are the eye
MIN_CHORD = 0.6        # mm


def _left_normal(s: np.ndarray, e: np.ndarray) -> Tuple[np.ndarray, float]:
    d = e - s
    length = float(np.hypot(d[0], d[1]))
    if length < 1e-9:
        return np.array([0.0, 1.0]), 0.0
    return np.array([-d[1] / length, d[0] / length]), length


def handle_point(s, e, u: float, v: float) -> np.ndarray:
    """Interior Bézier handle: fraction u along the chord, v mm to its left."""
    s, e = np.asarray(s, float), np.asarray(e, float)
    normal, _ = _left_normal(s, e)
    u = float(np.clip(u, 0.05, 0.95))
    return s + u * (e - s) + float(v) * normal


def sample_bezier(s, e, u1, v1, u2, v2, n: int = N_SPAN) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Points [n, 2] plus the two handles. u1 > u2 is swapped."""
    s, e = np.asarray(s, float), np.asarray(e, float)
    if u1 > u2:
        u1, u2, v1, v2 = u2, u1, v2, v1
    p1 = handle_point(s, e, u1, v1)
    p2 = handle_point(s, e, u2, v2)
    t = np.linspace(0.0, 1.0, n)[:, None]
    omt = 1.0 - t
    pts = omt ** 3 * s + 3 * omt ** 2 * t * p1 + 3 * omt * t ** 2 * p2 + t ** 3 * e
    pts[0], pts[-1] = s, e
    return pts, p1, p2


def _nearest_on_polyline(pt: np.ndarray, poly: np.ndarray) -> Tuple[float, float]:
    """Distance from pt to poly, and distance along poly of the closest point from poly[0]."""
    best, along, walked = 1e9, 0.0, 0.0
    for a, b in zip(poly[:-1], poly[1:]):
        d = b - a
        span = float(np.hypot(d[0], d[1]))
        if span < 1e-12:
            dist = float(np.hypot(*(pt - a)))
            t = 0.0
        else:
            t = float(np.clip(np.dot(pt - a, d) / (span * span), 0.0, 1.0))
            dist = float(np.hypot(*(pt - (a + t * d))))
        if dist < best:
            best, along = dist, walked + t * span
        walked += span
    return best, along


@dataclass
class CompliantParams:
    anchor_distance: float = 4.8
    junction_x: float = -5.5
    junction_y: float = 12.0
    pinch_y: float = 10.5
    l_u1: float = 0.35
    l_v1: float = -0.8
    l_u2: float = 0.65
    l_v2: float = -0.8
    r_u1: float = 0.35
    r_v1: float = 0.6
    r_u2: float = 0.65
    r_v2: float = 0.4
    f_u1: float = 0.35
    f_v1: float = 0.45
    f_u2: float = 0.65
    f_v2: float = 0.35
    l_thickness: float = 1.0
    r_thickness: float = 0.9
    f_thickness: float = 1.0
    # Context. The solver does not vary these.
    closed_carriage_height: float = 8.0
    pivot_offset: float = 4.0
    pivot_inverted: bool = False
    stroke: float = 1.5
    preload: float = 0.1
    member_depth: float = 3.0          # mm, out of the plane, one stock for the part
    member_modulus_mpa: float = 1950.0
    member_strength_mpa: float = 75.0
    carriage_pin_diameter: float = 1.5
    tube_center_x: float = 8.0
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    compliance: float = 0.7
    tube_model: str = "simple"
    tube_shore_a: float = 50.0
    chamber_volume_ml: float = 10.0
    motor_speed: float = 100.0
    speed_factor: float = 0.85
    lead_screw_pitch: float = 0.5


SHAPE_KEYS = (
    "anchor_distance", "junction_x", "junction_y", "pinch_y",
    "l_u1", "l_v1", "l_u2", "l_v2",
    "r_u1", "r_v1", "r_u2", "r_v2",
    "f_u1", "f_v1", "f_u2", "f_v2",
    "l_thickness", "r_thickness", "f_thickness",
)

CONTEXT_SOLVER_KEYS = (
    "closed_carriage_height",
    "pivot_offset",
    "stroke",
    "preload",
    "member_depth",
)

ALL_SOLVER_KEYS = SHAPE_KEYS + CONTEXT_SOLVER_KEYS


@dataclass
class CompliantConstraints:
    pinch_ceiling_margin_mm: float = 0.0
    pinch_floor_margin_mm: float = 0.0
    min_shell_clearance_mm: float = CLEARANCE_MIN
    min_pivot_clearance_mm: float = CLEARANCE_MIN
    min_tube_clearance_mm: float = 0.0
    max_y0_flex_mm: float = 0.0
    max_rotation_deg: float = 0.0
    stress_limit_factor: float = 1.0
    junction_exclude_x: Optional[Tuple[float, float]] = None
    junction_exclude_y: Optional[Tuple[float, float]] = None
    target_pinch_from_top_mm: Optional[float] = None
    target_attack_angle_deg: float = 0.0


def _params_from_mapping(data: dict) -> CompliantParams:
    names = {f.name for f in fields(CompliantParams)}
    return CompliantParams(**{k: data[k] for k in names if k in data})


def _constraints_from_mapping(data: Optional[dict]) -> CompliantConstraints:
    if not isinstance(data, dict):
        return CompliantConstraints()
    scalar_names = {
        "pinch_ceiling_margin_mm", "pinch_floor_margin_mm",
        "min_shell_clearance_mm", "min_pivot_clearance_mm",
        "min_tube_clearance_mm", "max_y0_flex_mm", "max_rotation_deg",
    }
    cleaned: Dict[str, object] = {}
    for k in scalar_names:
        if k in data and data[k] is not None:
            cleaned[k] = max(0.0, float(data[k]))
    if "target_pinch_from_top_mm" in data and data["target_pinch_from_top_mm"] is not None:
        cleaned["target_pinch_from_top_mm"] = max(0.0, float(data["target_pinch_from_top_mm"]))
    if "target_attack_angle_deg" in data and data["target_attack_angle_deg"] is not None:
        cleaned["target_attack_angle_deg"] = float(np.clip(float(data["target_attack_angle_deg"]), -90.0, 90.0))
    if "stress_limit_factor" in data and data["stress_limit_factor"] is not None:
        cleaned["stress_limit_factor"] = float(np.clip(float(data["stress_limit_factor"]), 0.05, 1.0))
    for k in ("junction_exclude_x", "junction_exclude_y"):
        pair = data.get(k)
        if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[0] is not None and pair[1] is not None:
            lo, hi = float(pair[0]), float(pair[1])
            if hi > lo:
                cleaned[k] = (lo, hi)
    return CompliantConstraints(**cleaned)  # type: ignore[arg-type]


def _in_forbidden_junction(jx: float, jy: float, c: CompliantConstraints) -> bool:
    ex, ey = c.junction_exclude_x, c.junction_exclude_y
    if ex is not None and ey is not None:
        return (ex[0] < jx < ex[1]) and (ey[0] < jy < ey[1])
    if ex is not None:
        return ex[0] < jx < ex[1]
    if ey is not None:
        return ey[0] < jy < ey[1]
    return False


@dataclass
class CompliantResult:
    feasible: bool
    message: str
    Y_positions: List[float]
    flow_a: List[Optional[float]]
    flow_b: List[Optional[float]]
    gap_a: List[Optional[float]]
    gap_b: List[Optional[float]]
    gap_rigid_a: List[Optional[float]]
    closed_gap: float
    full_open_gap: float
    flow_slope_mean: Optional[float]
    flow_slope_max: Optional[float]
    max_stress_mpa: Optional[float]
    stress_margin: Optional[float]
    plastic_ok: bool
    shell_ok: bool
    pivot_ok: bool
    pinch_ok: bool
    rotation_ok: bool
    shell_clearance_mm: Optional[float]
    pivot_clearance_mm: Optional[float]
    pinch_ceiling_margin_mm: Optional[float]
    max_rotation_deg: Optional[float]
    wall_x: float
    pivot_height_y0: float
    anchor_x: float
    pivot_x: float
    pinch_x: float
    travel_sign: float
    force_a: List[Optional[float]]
    force_b: List[Optional[float]]
    stress_a: List[Optional[float]]
    stress_b: List[Optional[float]]
    lines: Dict[str, dict]
    handles: Dict[str, List[List[float]]]
    anchor: List[float]
    junction: List[float]
    pinch: List[float]
    pivot: List[float]
    passes: bool
    pinch_contact_x: float = 0.0
    junction_ok: bool = True
    tube_ok: bool = True
    tube_clearance_mm: Optional[float] = None
    kinematic_gain: Optional[float] = None
    attack_angle_deg: Optional[float] = None
    dx_at_025_mm: Optional[float] = None
    y_open_mm: Optional[float] = None
    y_90_mm: Optional[float] = None
    sealed_at_y0: bool = True
    flex_y0_mm: Optional[float] = None
    gap_y0_mm: Optional[float] = None
    time_ms: List[float] = None
    y_time: List[float] = None
    flow_in_l_min: List[float] = None
    flow_out_l_min: List[float] = None
    chamber_kpa: List[float] = None
    volume_in_ml: float = 0.0
    volume_out_ml: float = 0.0
    chamber_t50_ms: Optional[float] = None
    chamber_t90_ms: Optional[float] = None

    def __post_init__(self):
        if self.time_ms is None:
            self.time_ms = []
        if self.y_time is None:
            self.y_time = []
        if self.flow_in_l_min is None:
            self.flow_in_l_min = []
        if self.flow_out_l_min is None:
            self.flow_out_l_min = []
        if self.chamber_kpa is None:
            self.chamber_kpa = []


def _empty(message: str, **kw) -> CompliantResult:
    base = dict(
        feasible=False, message=message, Y_positions=[], flow_a=[], flow_b=[],
        gap_a=[], gap_b=[], gap_rigid_a=[], closed_gap=0.0, full_open_gap=0.0,
        flow_slope_mean=None, flow_slope_max=None, max_stress_mpa=None, stress_margin=None,
        plastic_ok=False, shell_ok=False, pivot_ok=False, pinch_ok=False, rotation_ok=False,
        shell_clearance_mm=None, pivot_clearance_mm=None, pinch_ceiling_margin_mm=None,
        max_rotation_deg=None, wall_x=0.0, pivot_height_y0=0.0, anchor_x=0.0, pivot_x=0.0,
        pinch_x=0.0, travel_sign=1.0, force_a=[], force_b=[], stress_a=[], stress_b=[],
        lines={}, handles={}, anchor=[0, 0], junction=[0, 0], pinch=[0, 0], pivot=[0, 0], passes=False,
    )
    base.update(kw)
    return CompliantResult(**base)


def _apply_pinch_goal(p: CompliantParams, c: CompliantConstraints) -> CompliantParams:
    """Lock pinch_y to the target P_goal height (2*h0 - target_pinch_from_top_mm) when set."""
    if c.target_pinch_from_top_mm is None:
        return p
    return replace(p, pinch_y=2.0 * p.closed_carriage_height - float(c.target_pinch_from_top_mm))


def _geometry(p: CompliantParams, tube: LinkageParams):
    """Rest polylines, handles, bottom-tangent anchor, and the pinch x that puts the foot contact face on the closed tube."""
    wall_x, closed_gap, full_open_gap = _closure(tube)
    pinch_contact_x = (closed_gap - p.preload) - wall_x
    pinch_x = pinch_contact_x + p.f_thickness / 2.0
    anchor = np.array([-p.anchor_distance, p.l_thickness / 2.0])
    junction = np.array([p.junction_x, p.junction_y])
    pinch = np.array([pinch_x, p.pinch_y])
    pivot_x = -p.pivot_offset if p.pivot_inverted else p.pivot_offset
    pivot = np.array([pivot_x, p.closed_carriage_height])
    chords = {"l": (anchor, junction), "r": (junction, pivot), "f": (junction, pinch)}
    samples, handles = {}, {}
    for name, (s, e) in chords.items():
        u1, v1 = getattr(p, f"{name}_u1"), getattr(p, f"{name}_v1")
        u2, v2 = getattr(p, f"{name}_u2"), getattr(p, f"{name}_v2")
        pts, h1, h2 = sample_bezier(s, e, u1, v1, u2, v2)
        samples[name] = pts
        handles[name] = [h1, h2]
    return wall_x, closed_gap, full_open_gap, pinch_contact_x, pinch_x, anchor, junction, pinch, pivot, samples, handles


def _overlap_nodes(samples: Dict[str, np.ndarray], thickness: Dict[str, float], junction: np.ndarray) -> Dict[str, np.ndarray]:
    """True where a sample (not the shared junction) sits inside another spline's thickness.

    The junction neighborhood, one thickness long, is not an overlap: the three curves
    are meant to meet there.
    """
    flags = {name: np.zeros(len(pts), dtype=bool) for name, pts in samples.items()}
    names = list(samples)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            reach = max(thickness[a], thickness[b])
            for ia, pt in enumerate(samples[a]):
                if float(np.hypot(*(pt - junction))) <= reach:
                    continue
                dist, _along = _nearest_on_polyline(pt, samples[b])
                if dist < (thickness[a] + thickness[b]) / 2.0 and dist > 1e-6:
                    flags[a][ia] = True
                    # Mark the nearest vertex of b as well, so the whole crossed span fuses.
                    ib = int(np.argmin(np.hypot(samples[b][:, 0] - pt[0], samples[b][:, 1] - pt[1])))
                    if float(np.hypot(*(samples[b][ib] - junction))) > reach:
                        flags[b][ib] = True
    for name in flags:
        flags[name][0] = False
        flags[name][-1] = False
    return flags


def _frame_solve(xy, elems, ea, ei, held, loads):
    """Plane frame. ea and ei are one value per element. Same layout as linkage._frame_solve."""
    n = len(xy)
    k = np.zeros((3 * n, 3 * n))
    local = []
    for e, (a, b) in enumerate(elems):
        dx, dy = xy[b] - xy[a]
        length = float(np.hypot(dx, dy))
        if length < 1e-6:
            raise np.linalg.LinAlgError("zero length element")
        c, s_ = dx / length, dy / length
        e1 = ea[e] / length
        e2, e3, e4 = 12.0 * ei[e] / length ** 3, 6.0 * ei[e] / length ** 2, ei[e] / length
        kl = np.array([
            [e1, 0, 0, -e1, 0, 0],
            [0, e2, e3, 0, -e2, e3],
            [0, e3, 4 * e4, 0, -e3, 2 * e4],
            [-e1, 0, 0, e1, 0, 0],
            [0, -e2, -e3, 0, e2, -e3],
            [0, e3, 2 * e4, 0, -e3, 4 * e4],
        ])
        t = np.zeros((6, 6))
        t[0, :2], t[1, :2], t[2, 2] = (c, s_), (-s_, c), 1.0
        t[3, 3:5], t[4, 3:5], t[5, 5] = (c, s_), (-s_, c), 1.0
        idx = np.r_[3 * a:3 * a + 3, 3 * b:3 * b + 3]
        k[np.ix_(idx, idx)] += t.T @ kl @ t
        local.append((idx, kl @ t))
    u = np.zeros(3 * n)
    fixed = np.array(sorted(held), dtype=int)
    free = np.setdiff1d(np.arange(3 * n), fixed)
    u[fixed] = [held[i] for i in fixed]
    rhs = np.zeros(3 * n)
    for i, v in loads.items():
        rhs[i] += v
    u[free] = np.linalg.solve(k[np.ix_(free, free)], rhs[free] - k[np.ix_(free, fixed)] @ u[fixed])
    ends = np.array([klt @ u[idx] for idx, klt in local])
    return u.reshape(n, 3), np.stack([ends[:, 3], ends[:, 2], ends[:, 5]], axis=1)


def _section(width: float, depth: float, modulus: float) -> Tuple[float, float, float, float]:
    area = width * depth
    inertia = depth * width ** 3 / 12.0
    modulus_s = depth * width ** 2 / 6.0
    return modulus * area, modulus * inertia, area, modulus_s


def _build_mesh(p: CompliantParams, samples, flags, pivot_index_hint=None):
    """Nodes shared at the junction. Returns xy, elems, per-element props, and index maps."""
    names = ("l", "r", "f")
    thickness = {name: getattr(p, f"{name}_thickness") for name in names}
    node_of = {}
    xy = []
    # L owns the junction node.
    for i in range(len(samples["l"])):
        node_of[("l", i)] = len(xy)
        xy.append(samples["l"][i])
    junction_i = node_of[("l", len(samples["l"]) - 1)]
    for name in ("r", "f"):
        node_of[(name, 0)] = junction_i
        for i in range(1, len(samples[name])):
            node_of[(name, i)] = len(xy)
            xy.append(samples[name][i])
    xy = np.array(xy, float)
    elems, ea, ei, area, section, rigid_elem, owner = [], [], [], [], [], [], []
    depth, modulus = p.member_depth, p.member_modulus_mpa
    for name in names:
        n = len(samples[name])
        w = thickness[name]
        ea_i, ei_i, area_i, sec_i = _section(w, depth, modulus)
        for i in range(n - 1):
            fused = bool(flags[name][i] or flags[name][i + 1])
            scale = RIGID if fused else 1.0
            elems.append((node_of[(name, i)], node_of[(name, i + 1)]))
            ea.append(ea_i * scale)
            ei.append(ei_i * scale)
            area.append(area_i * scale)
            section.append(sec_i * scale)
            rigid_elem.append(fused)
            owner.append(name)
    # Weld: a stiff link from each overlapped node to the nearest node on another spline.
    seen = set()
    for name in names:
        others = [o for o in names if o != name]
        for i, flag in enumerate(flags[name]):
            if not flag:
                continue
            a = node_of[(name, i)]
            for other in others:
                j = int(np.argmin(np.hypot(samples[other][:, 0] - samples[name][i, 0],
                                           samples[other][:, 1] - samples[name][i, 1])))
                b = node_of[(other, j)]
                if a == b:
                    continue
                key = (min(a, b), max(a, b))
                if key in seen:
                    continue
                dist = float(np.hypot(*(xy[a] - xy[b])))
                if dist < 1e-4 or dist > (thickness[name] + thickness[other]) / 2.0 + 0.2:
                    continue
                seen.add(key)
                ea_i, ei_i, _, _ = _section(max(thickness[name], thickness[other]), depth, modulus)
                elems.append((a, b))
                ea.append(ea_i * RIGID)
                ei.append(ei_i * RIGID)
                area.append(1e9)          # connectors are not material: stress ignored
                section.append(1e9)
                rigid_elem.append(True)
                owner.append("weld")
    return (xy, elems, np.array(ea), np.array(ei), np.array(area), np.array(section),
            np.array(rigid_elem), owner, node_of, junction_i)


def _housing_clearance(xy, radius, wall_x, ceiling, exempt) -> float:
    """Least gap from a material disk to the housing rectangle. Negative is a penetration."""
    left = xy[:, 0] - radius - (-wall_x)
    right = wall_x - (xy[:, 0] + radius)
    bottom = xy[:, 1] - radius
    top = ceiling - (xy[:, 1] + radius)
    gap = np.minimum(np.minimum(left, right), np.minimum(bottom, top))
    gap = np.where(exempt, np.inf, gap)
    return float(np.min(gap)) if gap.size else 0.0


def _tube_clearance_lr(xy, radius, wall_x: float, tube_od: float, lr_mask: np.ndarray) -> float:
    """Least horizontal gap from Member L/R material disks to Tube A (left) and Tube B (right)."""
    if not np.any(lr_mask):
        return 0.0
    x_lr = xy[lr_mask, 0]
    r_lr = radius[lr_mask]
    tube_inner_left = -wall_x + tube_od
    tube_inner_right = wall_x - tube_od
    gap_left = (x_lr - r_lr) - tube_inner_left
    gap_right = tube_inner_right - (x_lr + r_lr)
    return float(np.min(np.minimum(gap_left, gap_right)))


def _pivot_clearance(xy, radius, pivot, pin_r, exempt) -> float:
    dist = np.hypot(xy[:, 0] - pivot[0], xy[:, 1] - pivot[1]) - radius - pin_r
    dist = np.where(exempt, np.inf, dist)
    return float(np.min(dist)) if dist.size else 0.0


def compute_compliant(p: CompliantParams, fast: bool = False, constraints: Optional[CompliantConstraints] = None) -> CompliantResult:
    """Flow, stress and clearances for one shape. `passes` is the solver's hard constraints."""
    c = constraints or CompliantConstraints()
    p = _apply_pinch_goal(p, c)
    if min(p.stroke, p.tube_id, p.tube_od - p.tube_id, p.member_depth, p.member_modulus_mpa) <= 0:
        return _empty("Stroke, tube wall, depth and modulus must be positive.")
    if min(p.l_thickness, p.r_thickness, p.f_thickness) <= 0:
        return _empty("Each spline needs a thickness above zero.")
    tube = LinkageParams(
        tube_id=p.tube_id, tube_od=p.tube_od, tube_center_x=p.tube_center_x,
        input_pressure_kpa=p.input_pressure_kpa, compliance=p.compliance,
        tube_model=p.tube_model, tube_shore_a=p.tube_shore_a,
        pin_diameter=max(p.f_thickness, 0.2), preload=p.preload,
        stroke=p.stroke, chamber_volume_ml=p.chamber_volume_ml,
        motor_speed=p.motor_speed, speed_factor=p.speed_factor,
        lead_screw_pitch=p.lead_screw_pitch,
    )
    try:
        wall_x, closed_gap, full_open_gap, pinch_contact_x, pinch_x, anchor, junction, pinch, pivot, samples, handles = _geometry(p, tube)
    except Exception as exc:  # tube law can refuse a section
        return _empty(str(exc))
    for name, (s, e) in (("l", (anchor, junction)), ("r", (junction, pivot)), ("f", (junction, pinch))):
        _normal, length = _left_normal(s, e)
        if length < MIN_CHORD:
            return _empty(
                "A spline chord is shorter than %.1f mm: move the junction, the pinch height, or the carriage." % MIN_CHORD,
                wall_x=wall_x, pivot_height_y0=p.closed_carriage_height, anchor_x=float(anchor[0]),
                pivot_x=float(pivot[0]), pinch_x=pinch_x, pinch_contact_x=pinch_contact_x,
                anchor=anchor.tolist(), junction=junction.tolist(), pinch=pinch.tolist(), pivot=pivot.tolist(),
            )
    thickness = {name: getattr(p, f"{name}_thickness") for name in ("l", "r", "f")}
    flags = _overlap_nodes(samples, thickness, junction)
    xy, elems, ea, ei, area, section, _rigid, owner, node_of, _jc = _build_mesh(p, samples, flags)
    n = len(xy)
    i_anchor = node_of[("l", 0)]
    i_pivot = node_of[("r", len(samples["r"]) - 1)]
    foot_idx = [node_of[("f", i)] for i in range(len(samples["f"]))]
    i_tip = foot_idx[-1]
    foot_x = xy[foot_idx, 0] - thickness["f"] / 2.0
    min_foot_x = float(np.min(foot_x))
    if foot_x[-1] <= min_foot_x + 1e-6:
        i_contact = i_tip
    else:
        i_contact = foot_idx[int(np.argmin(foot_x))]
    tip_is_contact = bool(i_contact == i_tip or (xy[i_tip, 0] - xy[i_contact, 0]) <= 1e-3)
    radius = np.zeros(n)
    for name in ("l", "r", "f"):
        for i in range(len(samples[name])):
            radius[node_of[(name, i)]] = thickness[name] / 2.0
    held_base = {3 * i_anchor: 0.0, 3 * i_anchor + 1: 0.0, 3 * i_anchor + 2: 0.0, 3 * i_pivot: 0.0}
    try:
        u_up, s_up = _frame_solve(xy, elems, ea, ei, {**held_base, 3 * i_pivot + 1: 1.0}, {})
        u_n, s_n = _frame_solve(xy, elems, ea, ei, {**held_base, 3 * i_pivot + 1: 0.0}, {3 * i_contact: 1.0})
    except np.linalg.LinAlgError:
        return _empty("This shape cannot be solved as a beam.", wall_x=wall_x,
                      pivot_height_y0=float(pivot[1]), anchor_x=float(anchor[0]), pivot_x=float(pivot[0]),
                      pinch_x=pinch_x, anchor=anchor.tolist(), junction=junction.tolist(),
                      pinch=pinch.tolist(), pivot=pivot.tolist())
    gap0 = float(wall_x + xy[i_contact, 0] - radius[i_contact])
    gain = float(u_up[i_contact, 0])
    # Positive carriage Y opens tube A. Flip the solved +y shape when that direction closes it.
    sign = 1.0 if gain >= 0.0 else -1.0
    u_y = u_up * sign
    s_y = s_up * sign
    compliance = float(u_n[i_contact, 0])
    n_y = N_Y_FAST if fast else N_Y
    y = np.linspace(-p.stroke, p.stroke, n_y)
    gap_rigid = gap0 + u_y[i_contact, 0] * y
    ones = np.ones_like(y)
    parts0 = _pinch_force(tube, gap_rigid, ones, ones, fast=True)
    if p.member_modulus_mpa > 0 and compliance > 1e-9:
        c_safe = np.full_like(y, compliance)
        pushed, parts = _solve_contact_flex(tube, gap_rigid, ones, ones, c_safe, parts0, fast=True)
        force = sum(parts)
    else:
        pushed = np.zeros_like(y)
        force = sum(parts0)
    gap_air = gap_rigid + pushed
    # Stress along the real elements, over the whole stroke.
    real = np.array([o != "weld" for o in owner])
    axial = s_y[:, 0:1] * y[None, :] + s_n[:, 0:1] * force[None, :]
    m1 = s_y[:, 1:2] * y[None, :] + s_n[:, 1:2] * force[None, :]
    m2 = s_y[:, 2:3] * y[None, :] + s_n[:, 2:3] * force[None, :]
    stress = np.maximum(np.abs(m1), np.abs(m2)) / section[:, None] + np.abs(axial) / area[:, None]
    stress = np.where(real[:, None], stress, 0.0)
    stress_y = np.nanmax(stress, axis=0) if stress.size else np.zeros_like(y)
    max_stress = float(np.nanmax(stress_y)) if stress_y.size else 0.0
    stress_factor = float(np.clip(c.stress_limit_factor, 0.05, 1.0))
    allowable_stress = p.member_strength_mpa * stress_factor
    margin = (p.member_strength_mpa / max_stress) if max_stress > 1e-9 else None
    plastic_ok = bool(max_stress <= allowable_stress + 1e-9)
    rotation = np.max(np.abs(u_y[:, 2:3] * y[None, :] + u_n[:, 2:3] * force[None, :]))
    max_rot = float(np.degrees(rotation))

    exempt_anchor = np.zeros(n, dtype=bool)
    for i in range(len(samples["l"])):
        if float(np.hypot(*(samples["l"][i] - anchor))) <= ANCHOR_EMBED:
            exempt_anchor[node_of[("l", i)]] = True
    exempt_eye = np.zeros(n, dtype=bool)
    eye = max(p.carriage_pin_diameter * EYE_FACTOR, thickness["r"])
    for i in range(len(samples["r"])):
        if float(np.hypot(*(samples["r"][i] - pivot))) <= eye:
            exempt_eye[node_of[("r", i)]] = True
    ceiling = 2.0 * float(pivot[1])
    pin_r = p.carriage_pin_diameter / 2.0

    def pose(at_y, at_force):
        return xy + u_y[:, :2] * at_y + u_n[:, :2] * at_force

    i_open = int(np.argmin(np.abs(y - p.stroke)))
    i_rest = int(np.argmin(np.abs(y)))
    i_closed = int(np.argmin(np.abs(y + p.stroke)))
    shell_open = _housing_clearance(pose(y[i_open], force[i_open]), radius, wall_x, ceiling, exempt_anchor)
    shell_rest = _housing_clearance(pose(y[i_rest], force[i_rest]), radius, wall_x, ceiling, exempt_anchor)
    shell_closed = _housing_clearance(pose(y[i_closed], force[i_closed]), radius, wall_x, ceiling, exempt_anchor)
    shell_clearance = min(shell_open, shell_rest, shell_closed)
    shell_ok = bool(shell_clearance > c.min_shell_clearance_mm)
    lr_mask = np.zeros(n, dtype=bool)
    for name in ("l", "r"):
        for i in range(len(samples[name])):
            lr_mask[node_of[(name, i)]] = True
    tube_open = _tube_clearance_lr(pose(y[i_open], force[i_open]), radius, wall_x, p.tube_od, lr_mask)
    tube_rest = _tube_clearance_lr(pose(y[i_rest], force[i_rest]), radius, wall_x, p.tube_od, lr_mask)
    tube_closed = _tube_clearance_lr(pose(y[i_closed], force[i_closed]), radius, wall_x, p.tube_od, lr_mask)
    tube_clearance = min(tube_open, tube_rest, tube_closed)
    tube_ok = bool(c.min_tube_clearance_mm <= 0.0 or tube_clearance >= c.min_tube_clearance_mm - 1e-9)
    pivot_clear = min(
        _pivot_clearance(pose(yy, ff), radius, np.array([pivot[0], pivot[1] + sign * yy]), pin_r, exempt_eye)
        for yy, ff in zip(y[:: max(1, len(y) // 9)], force[:: max(1, len(force) // 9)])
    )
    pivot_ok = bool(pivot_clear > c.min_pivot_clearance_mm)
    pinch_ceiling_margin = float(ceiling - p.pinch_y)
    pinch_ok = bool(
        pinch_ceiling_margin >= c.pinch_ceiling_margin_mm - 1e-9
        and p.pinch_y >= c.pinch_floor_margin_mm - 1e-9
    )
    rotation_ok = bool(c.max_rotation_deg <= 0.0 or max_rot <= c.max_rotation_deg + 1e-9)
    junction_ok = not _in_forbidden_junction(p.junction_x, p.junction_y, c)

    area_a = _area_mm2(tube, np.nan_to_num(gap_air, nan=0.0), closed_gap)
    p_up = P_ATM + p.input_pressure_kpa * 1000.0
    per_mm2 = _compute_orifice_mass_flow_rate(1.0, p_up, P_ATM) / (p_up / (R_AIR * T_AMB)) * 60.0 * 1000.0
    flow = area_a * per_mm2
    q_max = float(np.pi * (p.tube_id / 2.0) ** 2 * per_mm2)
    pos = y >= 0.0
    y_pos = y[pos]
    flow_pos = flow[pos]
    slope_mean, slope_max, _a, _b = _flow_derivatives(y_pos, flow_pos, q_max, None)

    # Effective horizontal displacement ΔX of the pinch point from Y = 0 to Y = 0.25 mm (stroke-independent).
    y_probe = np.array([0.0, 0.25])
    gap_rigid_probe = gap0 + u_y[i_contact, 0] * y_probe
    ones_p = np.ones_like(y_probe)
    parts_p0 = _pinch_force(tube, gap_rigid_probe, ones_p, ones_p, fast=True)
    if p.member_modulus_mpa > 0 and compliance > 1e-9:
        pushed_p, _ = _solve_contact_flex(tube, gap_rigid_probe, ones_p, ones_p, np.full_like(y_probe, compliance), parts_p0, fast=True)
    else:
        pushed_p = np.zeros_like(y_probe)
    gap_air_probe = gap_rigid_probe + pushed_p
    gap_air_y0 = float(gap_air_probe[0])
    flex_y0_mm = float(pushed_p[0])
    dx_at_025_mm = float(gap_air_probe[1] - gap_air_probe[0])
    # Hard Y=0 contact & seal check:
    # 1. Real contact point must be at the foot tip P (no belly bowing past P toward the wall).
    # 2. Under tube pressure at Y = 0, gap_air_y0 <= closed_gap (no leak).
    # 3. If max_y0_flex_mm > 0, outward flex at Y = 0 must stay <= max_y0_flex_mm so the contact stays tight on (closed_gap - preload).
    y0_flex_ok = bool(c.max_y0_flex_mm <= 0.0 or flex_y0_mm <= c.max_y0_flex_mm + 1e-6)
    sealed_at_y0 = bool(gap_air_y0 <= closed_gap + 1e-4 and tip_is_contact and y0_flex_ok)
    kinematic_gain = float(abs(gain))
    # Actual loaded trajectory direction of the pinch point P as carriage moves Y: 0 -> +stroke.
    p_rest = pose(y[i_rest], force[i_rest])[i_contact]
    p_open = pose(y[i_open], force[i_open])[i_contact]
    dp_traj = p_open - p_rest
    if float(np.hypot(dp_traj[0], dp_traj[1])) > 1e-9:
        attack_angle_deg = float(np.degrees(np.arctan2(dp_traj[1], max(dp_traj[0], 1e-9))))
    else:
        attack_angle_deg = float(np.degrees(np.arctan2(u_y[i_contact, 1], max(abs(u_y[i_contact, 0]), 1e-9))))

    def _first_y_crossing(level: float) -> Optional[float]:
        if q_max <= 0.0 or len(y_pos) < 2:
            return None
        idx = np.flatnonzero(flow_pos >= level)
        if not idx.size:
            return None
        i = int(idx[0])
        if i == 0:
            return float(y_pos[0])
        dq = flow_pos[i] - flow_pos[i - 1]
        frac = (level - flow_pos[i - 1]) / dq if dq > 1e-12 else 0.0
        return float(y_pos[i - 1] + frac * (y_pos[i] - y_pos[i - 1]))

    y_open_mm = _first_y_crossing(0.02 * q_max)
    y_90_mm = _first_y_crossing(0.90 * q_max)

    # Chamber inflation / deflation cycle (only on full evaluation so solver stays fast).
    time_ms: List[float] = []
    y_time: List[float] = []
    flow_in_l_min: List[float] = []
    flow_out_l_min: List[float] = []
    chamber_kpa: List[float] = []
    volume_in_ml = 0.0
    volume_out_ml = 0.0
    chamber_t50_ms: Optional[float] = None
    chamber_t90_ms: Optional[float] = None
    if not fast and p.chamber_volume_ml > 0:
        cyc = _chamber_cycle(tube, y, area_a, area_a[::-1])
        if cyc is not None:
            t_arr, yt_arr, qin_arr, qout_arr, pg_arr, vin, vout = cyc
            time_ms = t_arr.tolist()
            y_time = yt_arr.tolist()
            flow_in_l_min = qin_arr.tolist()
            flow_out_l_min = qout_arr.tolist()
            chamber_kpa = pg_arr.tolist()
            volume_in_ml = vin
            volume_out_ml = vout
            chamber_t50_ms, chamber_t90_ms = _chamber_rise_times(t_arr, pg_arr, p.input_pressure_kpa)

    opens = bool(abs(gain) > 1e-4)
    notes = []
    if not opens:
        notes.append("The carriage motion does not open the tube.")
    if not plastic_ok:
        if stress_factor < 1.0 - 1e-9:
            notes.append(
                "Stress reaches %.1f MPa, above the %.1f MPa limit (%.0f%% of %g MPa)."
                % (max_stress, allowable_stress, stress_factor * 100.0, p.member_strength_mpa)
            )
        else:
            notes.append("Stress reaches %.0f MPa, above the %g MPa limit." % (max_stress, p.member_strength_mpa))
    if not shell_ok:
        where = (
            "closed (-stroke)"
            if shell_closed <= shell_open and shell_closed <= shell_rest
            else "open (+stroke)" if shell_open <= shell_rest else "at rest"
        )
        notes.append("The part comes within %.2f mm of the shell (%s)." % (shell_clearance, where))
    if not pivot_ok:
        notes.append("The part comes within %.2f mm of the pivot." % pivot_clear)
    if not pinch_ok:
        if pinch_ceiling_margin < c.pinch_ceiling_margin_mm - 1e-9:
            notes.append("Pinch is %.2f mm from the ceiling (min %.2f mm)." % (pinch_ceiling_margin, c.pinch_ceiling_margin_mm))
        if p.pinch_y < c.pinch_floor_margin_mm - 1e-9:
            notes.append("Pinch is %.2f mm from the floor (min %.2f mm)." % (p.pinch_y, c.pinch_floor_margin_mm))
    if not rotation_ok:
        notes.append("Rotation reaches %.1f°, above the %.0f° limit." % (max_rot, c.max_rotation_deg))
    elif max_rot > 15.0:
        notes.append("Rotation reaches %.0f°. The bending model is linear, so this is a guide." % max_rot)
    if not junction_ok:
        notes.append("Junction J lies inside the forbidden zone.")
    if not sealed_at_y0:
        if gap_air_y0 > closed_gap + 1e-4:
            notes.append(
                "Leaks at Y = 0: tube pushes foot to %.3f mm (above %.3f mm closed gap; preload %.2f mm overcome by flex)."
                % (gap_air_y0, closed_gap, p.preload)
            )
        elif not y0_flex_ok:
            notes.append(
                "Y = 0 flex reaches %.3f mm, above the %.3f mm limit (gap %.3f mm vs target %.3f mm)."
                % (flex_y0_mm, c.max_y0_flex_mm, gap_air_y0, closed_gap - p.preload)
            )
        else:
            notes.append("Foot bows past pinch point P toward the wall, violating preload geometry.")
    if not tube_ok:
        notes.append(
            "Member L/R comes within %.2f mm of the tube (min %.2f mm)." % (tube_clearance, c.min_tube_clearance_mm)
        )
    passes = bool(opens and plastic_ok and shell_ok and pivot_ok and pinch_ok and rotation_ok and junction_ok and sealed_at_y0 and tube_ok)
    message = "ok" if passes else " ".join(notes) or "This shape does not pass."

    def line(name):
        idx = [node_of[(name, i)] for i in range(len(samples[name]))]
        return {
            "x": xy[idx, 0].tolist(), "y": xy[idx, 1].tolist(),
            "x_per_y": u_y[idx, 0].tolist(), "y_per_y": u_y[idx, 1].tolist(),
            "x_per_n": u_n[idx, 0].tolist(), "y_per_n": u_n[idx, 1].tolist(),
            "thickness": thickness[name],
        }

    return CompliantResult(
        feasible=opens, message=message, Y_positions=y.tolist(),
        flow_a=_nan_to_none(flow), flow_b=_nan_to_none(flow[::-1]),
        gap_a=_nan_to_none(gap_air), gap_b=_nan_to_none(gap_air[::-1]),
        gap_rigid_a=_nan_to_none(gap_rigid),
        closed_gap=float(closed_gap), full_open_gap=float(full_open_gap),
        flow_slope_mean=slope_mean, flow_slope_max=slope_max,
        max_stress_mpa=max_stress, stress_margin=margin, plastic_ok=plastic_ok,
        shell_ok=shell_ok, pivot_ok=pivot_ok, pinch_ok=pinch_ok, rotation_ok=rotation_ok, junction_ok=junction_ok,
        shell_clearance_mm=shell_clearance, pivot_clearance_mm=pivot_clear,
        pinch_ceiling_margin_mm=pinch_ceiling_margin, max_rotation_deg=max_rot,
        wall_x=wall_x, pivot_height_y0=float(pivot[1]), anchor_x=float(anchor[0]),
        pivot_x=float(pivot[0]), pinch_x=pinch_x, pinch_contact_x=pinch_contact_x, travel_sign=sign,
        force_a=_nan_to_none(force), force_b=_nan_to_none(force[::-1]),
        stress_a=_nan_to_none(stress_y), stress_b=_nan_to_none(stress_y[::-1]),
        lines={name: line(name) for name in ("l", "r", "f")},
        handles={name: [h.tolist() for h in hs] for name, hs in handles.items()},
        anchor=anchor.tolist(), junction=junction.tolist(), pinch=pinch.tolist(), pivot=pivot.tolist(),
        passes=passes,
        tube_ok=tube_ok,
        tube_clearance_mm=tube_clearance,
        kinematic_gain=kinematic_gain,
        attack_angle_deg=attack_angle_deg,
        dx_at_025_mm=dx_at_025_mm,
        y_open_mm=y_open_mm,
        y_90_mm=y_90_mm,
        sealed_at_y0=sealed_at_y0,
        flex_y0_mm=flex_y0_mm,
        gap_y0_mm=gap_air_y0,
        time_ms=time_ms,
        y_time=y_time,
        flow_in_l_min=flow_in_l_min,
        flow_out_l_min=flow_out_l_min,
        chamber_kpa=chamber_kpa,
        volume_in_ml=volume_in_ml,
        volume_out_ml=volume_out_ml,
        chamber_t50_ms=chamber_t50_ms,
        chamber_t90_ms=chamber_t90_ms,
    )


SOLVER_GOALS = ("dx_at_025", "min_open_stroke", "flow_slope", "trajectory_target")


def _goal_utility(result: CompliantResult, c: CompliantConstraints, goal: str) -> float:
    """Normalized comparable utility (~0..2, higher is better) for combining multiple goals."""
    if goal == "dx_at_025":
        dx = result.dx_at_025_mm
        if dx is None or not np.isfinite(dx):
            return -1.0
        open_pen = 0.05 * (result.y_open_mm if result.y_open_mm is not None else 1.0)
        return float(dx) / 0.25 - open_pen
    if goal == "flow_slope":
        sl = result.flow_slope_mean
        if sl is None or not np.isfinite(sl):
            return -1.0
        return float(sl) / 15.0
    if goal == "min_open_stroke":
        if result.y_90_mm is not None and np.isfinite(result.y_90_mm):
            return 1.0 / (0.25 + max(0.0, float(result.y_90_mm)))
        dx = result.dx_at_025_mm if (result.dx_at_025_mm is not None and np.isfinite(result.dx_at_025_mm)) else 0.0
        return 0.15 * (float(dx) / 0.25)
    if goal == "trajectory_target":
        err_y = 0.0
        if c.target_pinch_from_top_mm is not None and result.pinch_ceiling_margin_mm is not None:
            err_y = abs(float(result.pinch_ceiling_margin_mm) - float(c.target_pinch_from_top_mm))
        err_ang = 0.0
        if result.attack_angle_deg is not None and np.isfinite(result.attack_angle_deg):
            err_ang = abs(float(result.attack_angle_deg) - float(c.target_attack_angle_deg))
        return 1.0 / (1.0 + err_y + err_ang / 15.0)
    return 0.0


def normalize_goal_weights(goal: str, goal_weights: Optional[Dict[str, float]]) -> Dict[str, float]:
    """Return a clean dict of {goal: weight} summing to 1.0 over valid SOLVER_GOALS."""
    if goal_weights:
        cleaned = {
            k: float(v)
            for k, v in goal_weights.items()
            if k in SOLVER_GOALS and v is not None and np.isfinite(float(v)) and float(v) > 0.0
        }
        total = sum(cleaned.values())
        if total > 0.0:
            return {k: v / total for k, v in cleaned.items()}
    g = goal if goal in SOLVER_GOALS else "dx_at_025"
    return {g: 1.0}


def admission_score(
    result: CompliantResult,
    constraints: Optional[CompliantConstraints] = None,
    goal: str = "flow_slope",
    goal_weights: Optional[Dict[str, float]] = None,
) -> float:
    """Higher is better. Inadmissible shapes stay below every admissible solution."""
    c = constraints or CompliantConstraints()
    if not result.feasible or not result.passes:
        pen = 0.0
        if not result.feasible:
            pen += 1000.0
        if result.max_stress_mpa is not None and not result.plastic_ok:
            pen += result.max_stress_mpa
        if result.shell_clearance_mm is not None and not result.shell_ok:
            pen += max(0.0, c.min_shell_clearance_mm - result.shell_clearance_mm) * 100.0
        if result.pivot_clearance_mm is not None and not result.pivot_ok:
            pen += max(0.0, c.min_pivot_clearance_mm - result.pivot_clearance_mm) * 100.0
        if not result.pinch_ok:
            if result.pinch_ceiling_margin_mm is not None:
                pen += max(0.0, c.pinch_ceiling_margin_mm - result.pinch_ceiling_margin_mm) * 100.0
            if len(result.pinch) == 2:
                pen += max(0.0, c.pinch_floor_margin_mm - result.pinch[1]) * 100.0
        if result.max_rotation_deg is not None and not result.rotation_ok and c.max_rotation_deg > 0:
            pen += max(0.0, result.max_rotation_deg - c.max_rotation_deg) * 10.0
        if not result.junction_ok:
            pen += 200.0
        if not result.tube_ok and result.tube_clearance_mm is not None:
            pen += max(0.0, c.min_tube_clearance_mm - result.tube_clearance_mm) * 200.0
        if not result.sealed_at_y0:
            # Penalize smoothly by both leak past closed_gap and excess Y=0 flex past max_y0_flex_mm.
            leak = 0.0
            if result.gap_y0_mm is not None:
                leak = max(0.0, float(result.gap_y0_mm) - float(result.closed_gap))
            flex_over = 0.0
            if c.max_y0_flex_mm > 0.0 and result.flex_y0_mm is not None:
                flex_over = max(0.0, float(result.flex_y0_mm) - float(c.max_y0_flex_mm))
            pen += 150.0 + (leak + flex_over) * 1000.0
        return -1.0e6 - pen

    if goal_weights:
        weights = normalize_goal_weights(goal, goal_weights)
        if len(weights) > 1:
            return float(sum(w * _goal_utility(result, c, g) for g, w in weights.items()))
        goal = next(iter(weights))

    if goal == "trajectory_target":
        # Minimize error to desired pinch depth from ceiling + desired attack angle (-90..+90 deg).
        err_y = 0.0
        if c.target_pinch_from_top_mm is not None and result.pinch_ceiling_margin_mm is not None:
            err_y = abs(float(result.pinch_ceiling_margin_mm) - float(c.target_pinch_from_top_mm))
        err_ang = 0.0
        if result.attack_angle_deg is not None and np.isfinite(result.attack_angle_deg):
            err_ang = abs(float(result.attack_angle_deg) - float(c.target_attack_angle_deg))
        dx_bonus = 0.05 * float(result.dx_at_025_mm) if (result.dx_at_025_mm is not None and np.isfinite(result.dx_at_025_mm)) else 0.0
        return -(err_y + err_ang / 15.0) + dx_bonus

    if goal == "dx_at_025":
        dx = result.dx_at_025_mm
        if dx is None or not np.isfinite(dx):
            return -10.0
        # Slight penalty if the foot leaks at Y = 0, and tie-break gently toward earlier opening.
        leak_pen = 0.0 if result.sealed_at_y0 else 0.25
        open_pen = 0.02 * (result.y_open_mm if result.y_open_mm is not None else 1.0)
        return float(dx) - leak_pen - open_pen

    if goal == "min_open_stroke":
        # Minimize Y required to reach 90% flow (negated so higher is better).
        if result.y_90_mm is not None and np.isfinite(result.y_90_mm):
            leak_pen = 0.0 if result.sealed_at_y0 else 1.0
            return 10.0 - float(result.y_90_mm) - leak_pen
        # Fallback if 90% flow wasn't reached within stroke: rank by max flow / dx_at_025 below any full-open design.
        dx = result.dx_at_025_mm if (result.dx_at_025_mm is not None and np.isfinite(result.dx_at_025_mm)) else 0.0
        return -5.0 + float(dx)

    if result.flow_slope_mean is None or not np.isfinite(result.flow_slope_mean):
        return -10.0
    return float(result.flow_slope_mean)


def _row_to_params(base: CompliantParams, row: np.ndarray, lows, highs, keys=ALL_SOLVER_KEYS) -> CompliantParams:
    values = {key: float(np.clip(val, lo, hi)) for key, val, lo, hi in zip(keys, row, lows, highs)}
    # Keep the two handles ordered along the chord.
    for prefix in ("l", "r", "f"):
        if values[f"{prefix}_u1"] > values[f"{prefix}_u2"]:
            values[f"{prefix}_u1"], values[f"{prefix}_u2"] = values[f"{prefix}_u2"], values[f"{prefix}_u1"]
            values[f"{prefix}_v1"], values[f"{prefix}_v2"] = values[f"{prefix}_v2"], values[f"{prefix}_v1"]
    return replace(base, **values)


def solve_compliant(
    base: CompliantParams,
    bounds: Dict[str, Tuple[float, float]],
    budget: int = 36,
    seed: int = 1,
    constraints: Optional[CompliantConstraints] = None,
    pivot_side: str = "current",
) -> dict:
    """Search the shape and optional context bounds. Best mean flow slope passing all constraints wins."""
    c = constraints or CompliantConstraints()
    budget = int(np.clip(budget, 1, 80))
    keys = ALL_SOLVER_KEYS
    lows, highs = [], []
    for key in keys:
        lo, hi = bounds.get(key, (getattr(base, key), getattr(base, key)))
        lo, hi = float(min(lo, hi)), float(max(lo, hi))
        lows.append(lo)
        highs.append(hi)
    lows, highs = np.array(lows), np.array(highs)
    span = highs - lows
    free = span > 1e-9
    idx_pinch = keys.index("pinch_y")
    idx_h0 = keys.index("closed_carriage_height")
    if c.target_pinch_from_top_mm is not None:
        free[idx_pinch] = False

    if pivot_side == "both":
        sides = [False, True]
    elif pivot_side == "normal":
        sides = [False]
    elif pivot_side == "inverted":
        sides = [True]
    else:
        sides = [base.pivot_inverted]

    rng = np.random.default_rng(seed)
    scored = []
    per_side_budget = max(1, budget // len(sides))

    for inv in sides:
        side_base = replace(base, pivot_inverted=inv)
        current = np.array([getattr(side_base, key) for key in keys])
        rows = [np.clip(current, lows, highs)]
        if np.any(free) and per_side_budget > 1:
            draw = rng.random((per_side_budget - 1, len(keys))) * span + lows
            # Clamp free pinch_y draws into the allowed floor/ceiling margin window when possible.
            if free[idx_pinch] and (c.pinch_ceiling_margin_mm > 0 or c.pinch_floor_margin_mm > 0):
                for r in draw:
                    p_lo = max(lows[idx_pinch], c.pinch_floor_margin_mm)
                    p_hi = min(highs[idx_pinch], 2.0 * r[idx_h0] - c.pinch_ceiling_margin_mm)
                    if p_hi > p_lo:
                        r[idx_pinch] = rng.uniform(p_lo, p_hi)
            rows.extend(list(draw))
        side_scored = []
        for row in rows:
            params = _apply_pinch_goal(_row_to_params(side_base, row, lows, highs, keys), c)
            result = compute_compliant(params, fast=True, constraints=c)
            side_scored.append((admission_score(result, c), params, result))
        side_scored.sort(key=lambda item: item[0], reverse=True)
        # One coordinate pass around the side leader, on the free dimensions only.
        best_score, best_params, best_result = side_scored[0]
        step = span * 0.15
        for i, key in enumerate(keys):
            if not free[i]:
                continue
            for direction in (-1.0, 1.0):
                trial = np.array([getattr(best_params, k) for k in keys])
                trial[i] = np.clip(trial[i] + direction * step[i], lows[i], highs[i])
                params = _apply_pinch_goal(_row_to_params(side_base, trial, lows, highs, keys), c)
                result = compute_compliant(params, fast=True, constraints=c)
                score = admission_score(result, c)
                side_scored.append((score, params, result))
                if score > best_score:
                    best_score, best_params, best_result = score, params, result
        scored.extend(side_scored)

    scored.sort(key=lambda item: item[0], reverse=True)
    admissible = [item for item in scored if item[2].passes]
    admissible.sort(key=lambda item: item[0], reverse=True)
    # Unique-ish runners: keep a shape when an anchor value differs.
    runners = []
    for score, params, result in admissible:
        if any(abs(params.anchor_distance - other.anchor_distance) < 1e-3
               and abs(params.junction_x - other.junction_x) < 1e-3
               and abs(params.junction_y - other.junction_y) < 1e-3
               and params.pivot_inverted == other.pivot_inverted for _s, other, _r in runners):
            continue
        runners.append((score, params, result))
        if len(runners) == 5:
            break
    winner = runners[0] if runners else None
    full = compute_compliant(winner[1], fast=False, constraints=c) if winner else None
    tested = len(scored)
    fallback_result = scored[0][2]

    def brief(params: CompliantParams, result: CompliantResult) -> dict:
        return {
            "slope": result.flow_slope_mean,
            "max_stress_mpa": result.max_stress_mpa,
            "shell_clearance_mm": result.shell_clearance_mm,
            "pivot_clearance_mm": result.pivot_clearance_mm,
            "pinch_ceiling_margin_mm": result.pinch_ceiling_margin_mm,
            "pivot_inverted": params.pivot_inverted,
            "params": {**{key: getattr(params, key) for key in keys}, "pivot_inverted": params.pivot_inverted},
        }

    return {
        "found": winner is not None and full is not None and full.passes,
        "tested": tested,
        "feasible": len(admissible),
        "result": asdict(full) if full is not None else None,
        "params": asdict(winner[1]) if winner else None,
        "runners": [brief(params, result) for _s, params, result in runners],
        "message": full.message if full is not None else fallback_result.message,
    }
