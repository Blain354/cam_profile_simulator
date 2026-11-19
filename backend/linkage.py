"""
Bar-linkage pinch valves: kinematics, static flow, chamber traces and geometry search.

Frame (mm): x from the lead-screw axis (base centre), y up from the fixed anchor.
  A = fixed pivot on the base, at y = 0
  B = (+pivot_offset, h0 + Y)   pivot on the carriage, moves with the screw
  C = joint between bar 1 (B-C, length bar1_length) and the bar hinged at A
      (A-C, length bar2_length)
  P = pinch point, on the line A-C at lever_length from A

Three linkage types share that geometry:
  "elbow": A = (-anchor_distance, 0) on the tube side, and P = C (two-bar toggle).
  "lever": A = (+anchor_distance, 0) on the far side; A-P is one long lever that
           reaches across to the tube, and bar 1 drives it at C part-way along.
  "pendulum": A = (-anchor_distance, 0) on the tube side; the arm A-C hangs along
           the tube and carries a rigid foot C-P (foot_length, at foot_angle from
           the arm) that pushes the tube sideways. The carriage sits between A and
           C, so this frame is the real mechanism upside down: its anchor is on the
           top wall, and the carriage height above A is h0 - Y.

The tube runs vertically at x = -tube_center_x and rests on a wall at
x = -(tube_center_x + tube_od / 2). P squeezes it against that wall.

Y = 0 is *defined* as the carriage position where the tube is just closed (plus
the preload), so h0 is solved from the geometry rather than given.

The second tube has the same linkage mirrored twice, left/right and top/bottom
(a half turn about the carriage pivot at Y = 0, its anchor on the top wall at
y = 2 * h0). It therefore sees the first tube's law at -Y: the carriage opens one
tube while it squeezes the other. Tube A feeds the chamber, tube B vents it.
"""

from dataclasses import dataclass, field, replace
from typing import List, Optional, Tuple

import numpy as np

try:  # run from backend/ (uvicorn main:app) or as the backend package (tests)
    from simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate
except ImportError:
    from .simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate

TYPE_ELBOW = "elbow"
TYPE_LEVER = "lever"
TYPE_PENDULUM = "pendulum"

OBJECTIVE_RESPONSE = "response"
OBJECTIVE_TARGET = "target"

N_SAMPLES = 241
N_SCORE = 60
N_RESPONSE = 121
N_TIME = 601
_EPS = 1e-9


@dataclass
class LinkageParams:
    linkage_type: str = TYPE_ELBOW
    bar1_length: float = 13.0        # mm, carriage pivot -> joint C
    bar2_length: float = 7.8         # mm, anchor -> joint C
    lever_length: float = 16.5       # mm, anchor -> pinch point (lever type only)
    foot_length: float = 1.5         # mm, joint C -> pinch point (pendulum type only)
    foot_angle_deg: float = 100.0    # deg between the arm A-C and the foot, toward the tube (pendulum only)
    pad_length: float = 0.0          # mm, flat contact segment centred on P, square to the foot (pendulum only)
    fixed_height: float = 0.0        # mm, imposed anchor-to-anchor height 2 * h0; bar 1 is then solved (0 = free)
    anchor_distance: float = 2.33    # mm from the base centre (elbow: tube side, lever: far side)
    pivot_offset: float = 3.9        # mm, carriage pivot offset from the screw axis (far side)
    tube_center_x: float = 8.0       # mm, tube axis distance from the screw axis
    pin_diameter: float = 1.0        # mm, pinch pin
    preload: float = 0.1             # mm, extra squeeze past closure at Y = 0
    stroke: float = 3.0              # mm, carriage travel each way
    target_exponent: float = 1.0     # target opening = (Y / stroke) ** exponent
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    compliance: float = 0.7          # mm/MPa
    chamber_volume_ml: float = 10.0  # mL, 0 disables the chamber traces
    motor_speed: float = 100.0       # RPM
    lead_screw_pitch: float = 0.5    # mm/rev
    speed_factor: float = 0.85       # share of the no-load speed kept under load and friction
    # Forces and structure. The four defaults below are assumed, not measured.
    motor_torque_mnm: float = 30.0   # mN.m the gearmotor gives at the firmware's current limit
    screw_diameter: float = 3.0      # mm, lead screw major diameter (M3)
    screw_friction: float = 0.3      # thread friction coefficient
    member_modulus_mpa: float = 2500.0  # MPa, bar material (printed plastic)
    member_width: float = 2.0        # mm, bar section in the plane of the mechanism (the bending direction)
    member_thickness: float = 3.0    # mm, bar section out of the plane
    contact_deformation: bool = True  # the tube pushes the pin back until bars and tube balance; False = rigid bars
    link_curved: bool = False        # link drawn as an arc that meets the joint along the foot (pendulum only)
    # One-piece flexure (pendulum only): arm, foot and link are a single part built into the
    # outer shell at the anchor. Nothing pivots; the part bends. See _Flexure.
    compliant: bool = False
    carriage_clamped: bool = False   # True: the link's carriage end is held in angle. False: it turns on the pivot rod
    carriage_pin_diameter: float = 1.5  # mm, steel rod the link turns on at the carriage
    carriage_pin_length: float = 8.0    # mm, that rod's length: half sits in the carriage, half in the link's eye
    member_strength_mpa: float = 40.0   # MPa, stress the material may see (assumed: about printed PETG at yield)
    carriage_pin_strength_mpa: float = 300.0  # MPa, bending the carriage rod may see (assumed: stainless steel)


@dataclass
class LinkageResult:
    feasible: bool
    message: str
    Y_positions: List[float] = field(default_factory=list)
    joint_x: List[Optional[float]] = field(default_factory=list)
    joint_y: List[Optional[float]] = field(default_factory=list)
    tip_x: List[Optional[float]] = field(default_factory=list)
    tip_y: List[Optional[float]] = field(default_factory=list)
    gap_a: List[Optional[float]] = field(default_factory=list)      # pin to wall from the bar geometry alone
    gap_b: List[Optional[float]] = field(default_factory=list)
    gap_loaded_a: List[Optional[float]] = field(default_factory=list)   # the same once the tube has pushed the pin back
    gap_loaded_b: List[Optional[float]] = field(default_factory=list)
    contact_solved: bool = False     # flow, dead band and response come from the loaded gap
    # Curved link (see _link_arc). Zero angle = straight bar.
    link_arc_half_angle_deg: float = 0.0   # angle between the chord B-C and the arc's tangent at the joint
    link_arc_radius: Optional[float] = None
    link_arc_sag: float = 0.0              # mm, arc's farthest point from the chord
    link_arc_side: float = 0.0             # +1 / -1: side of the chord C->B the arc bulges to, in this frame
    link_bending_stress_mpa: Optional[float] = None   # worst bending in the curved link
    # One-piece flexure. `flexure` holds the part's centre line at rest and its two bending
    # shapes, so a pose is rest + per_mm * (frame travel) + per_n * (pin force).
    flexure: Optional[dict] = None
    stress_a: List[Optional[float]] = field(default_factory=list)   # MPa, worst stress in the part on tube A
    stress_b: List[Optional[float]] = field(default_factory=list)
    max_stress_mpa: Optional[float] = None
    max_stress_where: Optional[str] = None         # "arm" | "foot" | "link"
    max_stress_spot: Optional[str] = None          # "shell" | "joint" | "carriage" | "span": where along it
    stress_margin: Optional[float] = None          # strength / worst stress
    stress_limit_y: Optional[float] = None         # mm of travel where the stress passes the strength
    spring_rate: Optional[float] = None            # N of screw thrust per mm of travel, bending the two parts, no tube
    max_rotation_deg: Optional[float] = None       # largest rotation along the part over the stroke
    # Pivot rod at the carriage (one-piece part, carriage end free to turn).
    carriage_load: Optional[float] = None          # N, worst load one part puts on the rod
    carriage_load_a: List[Optional[float]] = field(default_factory=list)  # N, that load over Y for tube A's part (B's is it reversed)
    carriage_bearing_mpa: Optional[float] = None   # that load over rod diameter x half the rod length: pressure in the eye
    carriage_pin_bending_mpa: Optional[float] = None  # rod bending where it leaves the carriage: load at the middle of the eye half
    flow_a: List[Optional[float]] = field(default_factory=list)
    flow_b: List[Optional[float]] = field(default_factory=list)
    flow_target: List[Optional[float]] = field(default_factory=list)
    anchor_x: float = 0.0
    anchor_on_top: bool = False      # the frame is the real mechanism upside down
    link_length: float = 0.0         # bar 1 actually used (solved when the height is fixed)
    pivot_height_y0: float = 0.0     # h0; the mirrored anchor sits at 2 * h0
    wall_x: float = 0.0
    closed_gap: float = 0.0          # pin-to-wall gap at which flow starts
    full_open_gap: float = 0.0       # pin-to-wall gap at which flow saturates
    y_min: float = 0.0               # reachable carriage range
    y_max: float = 0.0
    y_full_open: Optional[float] = None
    y_open: Optional[float] = None           # carriage travel to first flow: half the dead band
    response_time_ms: Optional[float] = None  # Y = 0 to full bore at the loaded motor speed
    sensitivity_y0: float = 0.0      # d(gap)/dY at Y = 0
    pinch_slide: float = 0.0         # pinch point travel along the tube over the stroke
    max_oversqueeze: float = 0.0     # worst squeeze past closure of the closed tube
    max_flow_l_min: float = 0.0
    rms_error: Optional[float] = None
    # Chamber cycle 0 -> +stroke -> 0 -> -stroke -> 0 at the motor's loaded linear speed.
    time_ms: List[float] = field(default_factory=list)
    y_time: List[float] = field(default_factory=list)
    flow_in_l_min: List[float] = field(default_factory=list)    # free air, supply -> chamber (tube A)
    flow_out_l_min: List[float] = field(default_factory=list)   # free air, chamber -> atmosphere (tube B)
    chamber_kpa: List[float] = field(default_factory=list)      # gauge
    volume_in_ml: float = 0.0
    volume_out_ml: float = 0.0
    # Forces and structure (see _forces). Empty / None when they cannot be computed.
    forces_message: str = ""
    force_a: List[Optional[float]] = field(default_factory=list)    # N, pin on tube A
    force_b: List[Optional[float]] = field(default_factory=list)
    thrust: List[Optional[float]] = field(default_factory=list)     # N, screw thrust that balances the two tubes
    flex_a: List[Optional[float]] = field(default_factory=list)     # mm, pin of tube A pushed back by bar flex
    flex_b: List[Optional[float]] = field(default_factory=list)
    flex_link_a: List[Optional[float]] = field(default_factory=list)  # share of flex_a from the link's stretch
    flex_bend_a: List[Optional[float]] = field(default_factory=list)  # share of flex_a from bending
    tube_modulus_mpa: Optional[float] = None       # wall modulus implied by the compliance
    seal_force_min: Optional[float] = None         # N per tube, pin just closed against the pressure (no preload)
    seal_force: Optional[float] = None             # N per tube at Y = 0, preload included
    jam_y: Optional[float] = None                  # mm of travel where the pin reaches the wall through the closed tube
    seal_force_flatten: Optional[float] = None     # of which: folding the tube flat
    seal_force_squeeze: Optional[float] = None     # of which: squeezing the two walls together
    seal_force_pressure: Optional[float] = None    # of which: air pressure on the pin
    max_pinch_force: Optional[float] = None        # N, worst pin force over the stroke
    max_wall_strain: Optional[float] = None        # worst wall squeeze / wall stack
    thrust_y0: Optional[float] = None              # N, the two tubes cancel at Y = 0
    thrust_needed: Optional[float] = None          # N, worst over the stroke
    thrust_available: Optional[float] = None       # N, from the motor torque through the screw
    motor_torque_needed_mnm: Optional[float] = None
    motor_margin: Optional[float] = None           # available / needed
    stall_y: Optional[float] = None                # mm of travel where the thrust needed passes the motor's
    screw_self_locking: Optional[bool] = None
    max_link_force: Optional[float] = None         # N, signed: + tension, - compression
    max_side_load: Optional[float] = None          # N, sideways on the carriage pivot
    max_bending_stress_mpa: Optional[float] = None
    max_axial_stress_mpa: Optional[float] = None
    buckling_factor: Optional[float] = None        # Euler load / worst compression, None without compression
    pin_stiffness: Optional[float] = None          # N/mm at the pin, bars only, at Y = 0
    flex_y0: Optional[float] = None                # mm
    seal_pressure_y0_kpa: Optional[float] = None   # pressure the seal at Y = 0 holds once the bars have flexed
    sealed_after_flex: Optional[bool] = None


def _joint(l1, l2, xa, xb, h):
    """Joint C for carriage pivot height h; NaN where the bars cannot reach."""
    dx = xb - xa
    d = np.sqrt(dx * dx + h * h)
    along = (l2 * l2 - l1 * l1 + d * d) / (2.0 * d)
    perp_sq = l2 * l2 - along * along
    perp = np.sqrt(np.where(perp_sq >= 0.0, perp_sq, np.nan))
    # C on the tube side of the A->B line.
    return xa + (along * dx - perp * h) / d, (along * h + perp * dx) / d


def _closure(p: LinkageParams) -> Tuple[float, float, float]:
    """wall_x, closed gap, full-open gap (all mm)."""
    wall_x = p.tube_center_x + p.tube_od / 2.0
    opening = p.compliance * p.input_pressure_kpa * 1e-3
    closed_gap = (p.tube_od - p.tube_id) - opening
    # Same area law as the cam model: (pi/2 * ID) * inner_gap, capped at the bore.
    return wall_x, closed_gap, closed_gap + p.tube_id / 2.0


def _body(p: LinkageParams, l2, lever_length):
    """Pinch point on the hinged body: distance from A, and angle from the line A-C."""
    if p.linkage_type == TYPE_LEVER:
        return lever_length, 0.0
    if p.linkage_type == TYPE_PENDULUM:
        phi = np.radians(p.foot_angle_deg)
        fx, fy = l2 + p.foot_length * np.cos(phi), p.foot_length * np.sin(phi)
        return np.hypot(fx, fy), np.arctan2(fy, fx)
    return l2, 0.0


def _layout(p: LinkageParams) -> Tuple[float, float, float]:
    """Anchor side (+1 far side, -1 tube side), root sign of the carriage vs C, and sign of Y in the frame."""
    if p.linkage_type == TYPE_LEVER:
        return 1.0, 1.0, 1.0
    if p.linkage_type == TYPE_PENDULUM:
        return -1.0, -1.0, -1.0
    return -1.0, 1.0, 1.0


def _tip(xa, jx, jy, ratio, delta):
    dx = jx - xa
    c, s = np.cos(delta), np.sin(delta)
    return xa + ratio * (dx * c - jy * s), ratio * (dx * s + jy * c)


def _pad(p: LinkageParams) -> Tuple[float, float]:
    """Half length of the contact pad and the foot angle (rad); a point contact for the other types."""
    if p.linkage_type == TYPE_PENDULUM and p.pad_length > 0:
        return p.pad_length / 2.0, float(np.radians(p.foot_angle_deg))
    return 0.0, 0.0


def _pad_reach(xa, jx, jy, half, phi):
    """How much closer to the wall than its centre the pad's nearer end sits (the pad tilts with the arm)."""
    if half == 0.0:
        return 0.0
    return half * np.abs(np.sin(np.arctan2(jy, jx - xa) + phi))


def _closed_joint(l2, reach, delta, half, phi, xa, x_closed):
    """Joint C when the contact sits at x_closed (body above the anchor line)."""
    cc = (x_closed - xa) / reach
    theta = np.arccos(np.where(np.abs(cc) <= 1.0, cc, np.nan)) - delta
    if half:
        # Newton on the arm angle: the pad's nearer end moves with the tilt.
        for _ in range(8):
            s = np.sin(theta + phi)
            f = xa + reach * np.cos(theta + delta) - half * np.abs(s) - x_closed
            df = -reach * np.sin(theta + delta) - half * np.sign(s) * np.cos(theta + phi)
            theta = theta - f / df
    return xa + l2 * np.cos(theta), l2 * np.sin(theta)


def _pivot_height_y0(l1, root, xb, cx, cy):
    """Carriage pivot height that reaches the closed joint with bar 1."""
    reach_sq = l1 * l1 - (xb - cx) ** 2
    return cy + root * np.sqrt(np.where(reach_sq >= 0.0, reach_sq, np.nan))


def _area_mm2(p: LinkageParams, gap: np.ndarray, closed_gap: float) -> np.ndarray:
    inner = np.clip(gap - closed_gap, 0.0, None)
    return np.minimum((np.pi / 2.0) * p.tube_id * inner, np.pi * (p.tube_id / 2.0) ** 2)


def _nan_to_none(a: np.ndarray) -> List[Optional[float]]:
    return [None if not np.isfinite(v) else float(v) for v in a]


def _chamber_cycle(p: LinkageParams, y: np.ndarray, area_a: np.ndarray, area_b: np.ndarray):
    """Isothermal chamber fed by tube A and vented by tube B over one carriage cycle.

    Implicit Euler on the chamber pressure (bisection): the chamber settles in
    milliseconds while the carriage takes seconds, so an explicit step would ring.
    """
    speed = p.motor_speed * p.speed_factor * p.lead_screw_pitch / 60.0
    if p.chamber_volume_ml <= 0 or speed <= 0:
        return None
    s = p.stroke
    t = np.linspace(0.0, 4.0 * s / speed, N_TIME)
    y_t = np.interp(t * speed, [0.0, s, 2.0 * s, 3.0 * s, 4.0 * s], [0.0, s, 0.0, -s, 0.0])
    a_in = np.interp(y_t, y, area_a)
    a_out = np.interp(y_t, y, area_b)
    p_up = P_ATM + p.input_pressure_kpa * 1000.0
    k = p.chamber_volume_ml * 1e-6 / (R_AIR * T_AMB)   # kg per Pa
    to_l_min = 60.0 * 1000.0 * R_AIR * T_AMB / P_ATM   # kg/s -> free-air L/min
    dt = float(t[1] - t[0])
    pc = P_ATM
    q_in, q_out, p_g = np.zeros(N_TIME), np.zeros(N_TIME), np.zeros(N_TIME)
    for i in range(N_TIME):
        if i > 0:
            mass = pc * k
            lo, hi = P_ATM, max(p_up, pc)
            for _ in range(40):
                mid = 0.5 * (lo + hi)
                net = _compute_orifice_mass_flow_rate(a_in[i], p_up, mid) - _compute_orifice_mass_flow_rate(a_out[i], mid, P_ATM)
                if mid * k - mass - dt * net > 0.0:
                    hi = mid
                else:
                    lo = mid
            pc = 0.5 * (lo + hi)
        q_in[i] = _compute_orifice_mass_flow_rate(a_in[i], p_up, pc) * to_l_min
        q_out[i] = _compute_orifice_mass_flow_rate(a_out[i], pc, P_ATM) * to_l_min
        p_g[i] = (pc - P_ATM) / 1000.0
    to_ml = dt / 60.0 * 1000.0
    return t * 1000.0, y_t, q_in, q_out, p_g, float(q_in.sum() * to_ml), float(q_out.sum() * to_ml)


N_FOOT = 161


def _link_arc(p: LinkageParams, l1, cx, cy, bx, by, px, py) -> Tuple[float, float]:
    """Curved link: the arc of a circle from the carriage pivot B to the joint C that meets C
    along the foot C-P, at the Y = 0 pose. Returns (alpha, side): alpha (rad) is the angle
    between the chord and the arc's tangent at C, side the sign of the bulge about C->B.

    The link stays a pin-ended bar of chord l1, so the kinematics do not change. What changes
    is that the pull T along the chord now bends it, by T times the offset from the chord.
    """
    if not (p.link_curved and p.linkage_type == TYPE_PENDULUM and p.foot_length > 0):
        return 0.0, 0.0
    ux, uy = (bx - cx) / l1, (by - cy) / l1
    fx, fy = (px - cx) / p.foot_length, (py - cy) / p.foot_length
    dot, cross = ux * fx + uy * fy, ux * fy - uy * fx
    if dot < 0.0:   # the link leaves the joint on the side of the foot line that faces the carriage
        dot, cross = -dot, -cross
    alpha = float(np.arctan2(abs(cross), dot))
    if not np.isfinite(alpha) or alpha < 1e-4:
        return 0.0, 0.0
    return alpha, float(np.sign(cross))


def _pinch_force(p: LinkageParams, gap: np.ndarray, st: np.ndarray, ct: np.ndarray):
    """Pin force (N) on one tube for a pin-to-wall gap, as (flatten, squeeze, pressure) parts.

    The tube is cut in slices along its axis; each slice is pressed to the local height h
    under the pin (round ends of the pin diameter, flat pad between them, tilted by
    st = sin, ct = cos of its angle to the tube axis). With W = OD - ID the two walls:
      h >= OD       no contact
      W < h < OD    the ring is being folded flat: ring stiffness, and the air pushes
                    on the flat width (pi / 2) * (OD - h)
      h <= W        walls squeezed by W - h. The compliance already in the model says a
                    squeeze of compliance * pressure seals that pressure, so the walls
                    answer with a stress of squeeze / compliance. Where that stress is
                    below the line pressure the bore still holds air, which makes up
                    the difference.
    Folding a tube under a narrow pin also drags down the tube on each side of it: that
    is counted as OD / 2 more length at the deepest slice.
    Rubber does not compress: the wall stress is divided by (1 - squeeze / W), capped at
    95 % squeeze, so a pin driven into the wall shows up as a force the motor cannot give
    rather than as a small linear one. Past roughly 25 % squeeze this is an order of
    magnitude, not a prediction.
    """
    wall = p.tube_od - p.tube_id
    k_wall = 1.0 / p.compliance                       # MPa per mm of squeeze
    e_tube = wall / p.compliance
    t, r_mid = wall / 2.0, (p.tube_id + p.tube_od) / 4.0
    k_ring = e_tube * t ** 3 / (12.0 * 0.1488 * r_mid ** 3)   # N/mm of tube per mm, ring between two plates
    pressure = p.input_pressure_kpa * 1e-3
    w_flat = np.pi / 2.0 * p.tube_id + wall

    r = p.pin_diameter / 2.0
    half = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0
    gap, st, ct = gap[:, None], st[:, None], np.maximum(ct, 1e-6)[:, None]
    span = half * ct + r
    s = np.linspace(-1.0, 1.0, N_FOOT)[None, :] * span
    d0 = gap + half * st + r                          # pad centre to wall
    with np.errstate(invalid="ignore"):
        face = np.where(np.abs(s - r * st) <= half * ct, d0 + (s - r * st) * st / ct - r * ct, np.inf)
        near = d0 - half * st - np.sqrt(r * r - (s + half * ct) ** 2)
        far = d0 + half * st - np.sqrt(r * r - (s - half * ct) ** 2)
    h = np.fmin(face, np.fmin(near, far))

    def slices(h):
        fold = np.clip(p.tube_od - h, 0.0, p.tube_id)
        squeeze = np.clip(wall - h, 0.0, 0.95 * wall)
        return (
            k_ring * fold * (1.0 + (fold / p.tube_id) ** 2),
            k_wall * squeeze / (1.0 - squeeze / wall) * w_flat,
            pressure * np.pi / 2.0 * fold - np.minimum(k_wall * squeeze, pressure) * np.pi / 2.0 * p.tube_id * (squeeze > 0.0),
        )

    ds = 2.0 * span[:, 0] / (N_FOOT - 1)
    parts = [np.nan_to_num(f, nan=0.0).sum(axis=1) * ds for f in slices(h)]
    deepest = slices(gap[:, 0])
    parts[0] = parts[0] + deepest[0] * p.tube_od / 2.0
    parts[2] = parts[2] + deepest[2] * p.tube_od / 2.0
    return parts


def _screw(p: LinkageParams, out: LinkageResult, y, thrust) -> None:
    """Thrust the motor can give through the screw, against out.thrust_needed."""
    d_m = p.screw_diameter - 0.6495 * p.lead_screw_pitch
    if d_m > 0:
        helix = np.arctan(p.lead_screw_pitch / (np.pi * d_m))
        friction = np.arctan(p.screw_friction / np.cos(np.radians(30.0)))   # 60 degree metric flank
        per_n = d_m / 2.0 * np.tan(helix + friction)     # N.mm of torque per N of thrust, pushing
        out.screw_self_locking = bool(friction > helix)
        if per_n > 0:
            out.thrust_available = float(p.motor_torque_mnm / per_n)
            out.motor_torque_needed_mnm = float(out.thrust_needed * per_n)
            out.motor_margin = out.thrust_available / out.thrust_needed if out.thrust_needed > 1e-9 else None
            over = np.abs(y[np.nan_to_num(np.abs(thrust)) > out.thrust_available])
            out.stall_y = float(over.min()) if over.size else None


def _forces(p: LinkageParams, out: LinkageResult, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap, closed_gap, half, phi):
    """Pin forces, screw thrust and bar flex over the stroke; fills the force fields of `out`.

    Returns the pin-to-wall gap once the tube has pushed the pin back (None without forces).

    Statics of the hinged body about its anchor A: the tube pushes the pin away from the
    wall with F, the link (a two-force bar along B-C) holds it with a tension T. The
    second linkage is the first at -Y with its pull on the carriage reversed.
    Friction in the pivots and on the tube is left out.
    """
    if p.compliance <= 0:
        out.forces_message = "No forces: they are derived from the tube compliance, which is 0."
        return None
    if p.pin_diameter <= 0 and half == 0.0:
        out.forces_message = "No forces: the pin has no diameter and no pad, so no contact area."
        return None
    if min(p.member_modulus_mpa, p.member_width, p.member_thickness) <= 0:
        out.forces_message = "No forces: the bar section and modulus must be positive."
        return None
    wall = p.tube_od - p.tube_id
    i0 = N_SAMPLES // 2
    alpha, side = (0.0, 0.0)
    if ok[i0]:
        alpha, side = _link_arc(p, l1, jx[i0], jy[i0], xb, h0, tx[i0], ty[i0])
    with np.errstate(invalid="ignore", divide="ignore"):
        tilt = np.arctan2(jy, jx - xa) + phi
        st, ct = np.abs(np.sin(tilt)), np.abs(np.cos(tilt))
        g = np.nan_to_num(gap, nan=1e9)
        parts = _pinch_force(p, g, np.nan_to_num(st), np.nan_to_num(ct, nan=1.0))
        force = np.where(ok, sum(parts), np.nan)
        st0, ct0 = np.nan_to_num(st), np.nan_to_num(ct, nan=1.0)
        stiff = (sum(_pinch_force(p, g - 0.02, st0, ct0)) - sum(_pinch_force(p, g + 0.02, st0, ct0))) / 0.04

        ux, uy = (xb - jx) / l1, (h0 + sgn * y - jy) / l1
        lever = (jx - xa) * uy - jy * ux
        t_unit = ty / lever                              # link tension per N on the pin
        l2 = np.hypot(jx - xa, jy)
        axial_unit = ((-1.0 - t_unit * ux) * (jx - xa) + (-t_unit * uy) * jy) / l2   # + = arm in compression
        arm = ty - jy                                    # moment arm of the pin force about the joint
        area = p.member_width * p.member_thickness
        inertia = p.member_thickness * p.member_width ** 3 / 12.0
        e = p.member_modulus_mpa
        if alpha > 0.0:
            # Pin-ended arc under a pull T along its chord: moment T * offset, so the chord
            # gives by T * integral(offset^2 ds) / (E I) on top of the stretch.
            radius = l1 / (2.0 * np.sin(alpha))
            sag = radius * (1.0 - np.cos(alpha))
            offset_sq = radius ** 3 * (alpha * (1.0 + 2.0 * np.cos(alpha) ** 2) - 3.0 * np.sin(alpha) * np.cos(alpha))
            c_chord = 2.0 * alpha * radius / (e * area) + offset_sq / (e * inertia)
            out.link_arc_half_angle_deg, out.link_arc_radius = float(np.degrees(alpha)), float(radius)
            out.link_arc_sag, out.link_arc_side = float(sag), side
        else:
            sag, c_chord = 0.0, l1 / (e * area)
        c_link = t_unit ** 2 * c_chord
        c_bend = arm ** 2 * (l2 + np.hypot(tx - jx, ty - jy)) / (3.0 * e * inertia)
        c_all = c_link + c_bend + axial_unit ** 2 * l2 / (e * area)   # mm of pin per N, from the strain energy
        if p.contact_deformation:
            # The tube pushes the pin back by `flex` until the bars' spring and the tube agree:
            # flex = c_all * F(gap + flex). F mostly falls as the gap opens, so the root is near
            # the push-back the rigid force would give; just at closure the air let back into
            # the bore makes F rise a little, hence the widening of the bracket.
            c_safe = np.where(np.isfinite(c_all) & ok, c_all, 0.0)
            lo, hi = np.zeros_like(g), c_safe * np.nan_to_num(sum(parts))
            for _ in range(8):
                hi = np.where(hi < c_safe * sum(_pinch_force(p, g + hi, st0, ct0)), 2.0 * hi + 1e-6, hi)
            for _ in range(40):
                mid = 0.5 * (lo + hi)
                short = mid < c_safe * sum(_pinch_force(p, g + mid, st0, ct0))
                lo, hi = np.where(short, mid, lo), np.where(short, hi, mid)
            pushed = 0.5 * (lo + hi)
            parts = _pinch_force(p, g + pushed, st0, ct0)
            force = np.where(ok, sum(parts), np.nan)
            flex = np.where(ok, pushed, np.nan)
        else:
            flex = force * c_all / (1.0 + np.clip(stiff, 0.0, None) * c_all)
        loaded = gap + flex
        pull = sgn * -t_unit * uy * force                # along +Y, linkage A on the carriage
    thrust = pull - pull[::-1]
    # Past the travel where a pin has crushed its tube to the wall nothing moves any more:
    # the figures stop there instead of reporting the capped wall law.
    crushed = np.abs(y[ok & (gap <= 0.05 * wall)])
    if crushed.size:
        out.jam_y = float(crushed.min())
        past = np.abs(y) >= out.jam_y
        force, flex, thrust = (np.where(past, np.nan, v) for v in (force, flex, thrust))

    out.force_a, out.force_b = _nan_to_none(force), _nan_to_none(force[::-1])
    out.thrust = _nan_to_none(np.abs(thrust))
    out.flex_a, out.flex_b = _nan_to_none(flex), _nan_to_none(flex[::-1])
    out.flex_link_a, out.flex_bend_a = _nan_to_none(flex * c_link / c_all), _nan_to_none(flex * c_bend / c_all)
    out.tube_modulus_mpa = wall / p.compliance
    if not ok[i0] or not np.isfinite(force[i0]):
        return loaded
    out.seal_force = float(force[i0])
    out.seal_force_min = float(sum(_pinch_force(p, np.array([closed_gap]), st0[i0:i0 + 1], ct0[i0:i0 + 1]))[0])
    out.seal_force_flatten, out.seal_force_squeeze, out.seal_force_pressure = (float(v[i0]) for v in parts)
    out.max_pinch_force = float(np.nanmax(force))
    squeezed_to = loaded if p.contact_deformation else gap
    out.max_wall_strain = float(np.clip(wall - np.nanmin(np.where(np.isfinite(force), squeezed_to, np.nan)), 0.0, wall) / wall)
    out.thrust_y0 = float(abs(thrust[i0]))
    out.thrust_needed = float(np.nanmax(np.abs(thrust))) if np.any(np.isfinite(thrust)) else out.thrust_y0

    _screw(p, out, y, thrust)

    tension = t_unit * force
    out.max_link_force = float(tension[np.nanargmax(np.abs(tension))])
    out.max_side_load = float(np.nanmax(np.abs(tension * ux)))
    section = p.member_thickness * p.member_width ** 2 / 6.0
    out.max_bending_stress_mpa = float(np.nanmax(np.abs(arm) * force) / section)
    if alpha > 0.0:
        out.link_bending_stress_mpa = float(np.nanmax(np.abs(tension)) * sag / section)
        out.max_bending_stress_mpa = max(out.max_bending_stress_mpa, out.link_bending_stress_mpa)
    compression = np.nanmax(np.stack([-tension, axial_unit * force]), axis=1)   # link, arm
    out.max_axial_stress_mpa = float(max(np.nanmax(np.abs(tension)), np.nanmax(np.abs(axial_unit * force))) / area)
    euler = np.pi ** 2 * e * min(inertia, p.member_width * p.member_thickness ** 3 / 12.0)
    factors = [euler / length ** 2 / c for length, c in zip((l1, float(np.nanmax(l2))), compression) if c > 1e-9]
    out.buckling_factor = float(min(factors)) if factors else None
    out.pin_stiffness = float(1.0 / c_all[i0]) if c_all[i0] > 0 else None
    out.flex_y0 = float(flex[i0])
    held = (wall - (gap[i0] + flex[i0])) / p.compliance          # MPa
    out.seal_pressure_y0_kpa = float(max(held, 0.0) * 1000.0)
    out.sealed_after_flex = bool(gap[i0] + flex[i0] <= closed_gap + 1e-12)
    return loaded


N_ARM, N_FOOT_EL, N_LINK = 16, 6, 28


def _frame_solve(xy, elems, ea, ei, held, loads):
    """Linear plane frame of Euler-Bernoulli beams, 3 freedoms per node (x, y, rotation).

    xy: node coordinates [n, 2]; elems: node pairs; held: {freedom index: imposed value};
    loads: {freedom index: force or moment}. Returns the displacements [n, 3], the forces the
    supports apply [n, 3], and for each element its (axial force, end moments) in its own axes.
    """
    n = len(xy)
    k = np.zeros((3 * n, 3 * n))
    local = []
    for a, b in elems:
        dx, dy = xy[b] - xy[a]
        length = float(np.hypot(dx, dy))
        c, s_ = dx / length, dy / length
        e1, e2, e3, e4 = ea / length, 12.0 * ei / length ** 3, 6.0 * ei / length ** 2, ei / length
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
    reactions = k @ u - rhs
    ends = np.array([klt @ u[idx] for idx, klt in local])       # [m, 6]: N1, V1, M1, N2, V2, M2
    return u.reshape(n, 3), reactions.reshape(n, 3), np.stack([ends[:, 3], ends[:, 2], ends[:, 5]], axis=1)


class _Flexure:
    """Pendulum built as one piece: arm, foot and link are a single beam structure.

    The arm is built into the outer shell at the anchor A (no pivot). The foot carries on from
    the arm at the foot angle, and the link runs from the joint C to the carriage B, where it turns
    on a steel rod (or is clamped). The part is made in its Y = 0 shape; the carriage then bends it.

    Small-deflection beam theory, so everything is a sum of two shapes: what 1 mm of carriage
    travel does with no tube, and what 1 N on the pin does with the carriage held. That is good
    for rotations of a few degrees; max_rotation_deg says how far a design goes.
    Fillets and stress concentration at the joints are not modelled.
    """

    def __init__(self, p, xa, xb, h0, sgn, l1, cx0, cy0, ratio, delta, half, phi, wall_x):
        self.p, self.sgn, self.half, self.wall_x = p, sgn, half, wall_x
        self.error = None
        w, t, e = p.member_width, p.member_thickness, p.member_modulus_mpa
        if min(w, t, e) <= 0:
            self.error = "The one-piece part needs a bar section and a modulus above zero."
            return
        tx0, ty0 = (float(v) for v in _tip(xa, cx0, cy0, ratio, delta))
        a_pt, c_pt, p_pt, b_pt = (np.array(v, dtype=float) for v in ((xa, 0.0), (cx0, cy0), (tx0, ty0), (xb, h0)))
        alpha, side = _link_arc(p, l1, cx0, cy0, xb, h0, tx0, ty0)
        self.alpha, self.side = alpha, side
        arm = [a_pt + (c_pt - a_pt) * i / N_ARM for i in range(N_ARM + 1)]
        has_foot = p.foot_length > 1e-6
        foot = [c_pt + (p_pt - c_pt) * i / N_FOOT_EL for i in range(1, N_FOOT_EL + 1)] if has_foot else []
        d = (b_pt - c_pt) / l1
        normal = np.array([-d[1], d[0]])
        link = []
        for i in range(1, N_LINK + 1):
            if alpha > 0.0:
                radius = l1 / (2.0 * np.sin(alpha))
                th = -alpha + 2.0 * alpha * i / N_LINK
                link.append(c_pt + d * (l1 / 2.0 + radius * np.sin(th)) + normal * side * radius * (np.cos(th) - np.cos(alpha)))
            else:
                link.append(c_pt + d * l1 * i / N_LINK)
        xy = np.array(arm + foot + link)
        i_c = N_ARM
        i_p = i_c + len(foot)
        i_b = len(xy) - 1
        elems = [(i, i + 1) for i in range(N_ARM)]
        elems += [(i_c if i == 0 else i_c + i, i_c + i + 1) for i in range(len(foot))]
        elems += [(i_c if i == 0 else i_p + i, i_p + i + 1) for i in range(N_LINK)]
        self.parts = ["arm"] * N_ARM + ["foot"] * len(foot) + ["link"] * N_LINK
        self.xy, self.i_c, self.i_p, self.i_b = xy, i_c, i_p, i_b
        self.lines = {"arm": list(range(N_ARM + 1)), "foot": [i_c] + list(range(i_c + 1, i_p + 1)),
                      "link": [i_c] + list(range(i_p + 1, i_b + 1))}

        ea, ei = e * w * t, e * t * w ** 3 / 12.0
        self.area, self.section = w * t, t * w ** 2 / 6.0
        held = {0: 0.0, 1: 0.0, 2: 0.0, 3 * i_b: 0.0}
        if p.carriage_clamped:
            held[3 * i_b + 2] = 0.0
        try:
            # 1 mm of frame travel of the carriage end, no tube; then 1 N on the pin, carriage held.
            self.u_mm, self.r_mm, self.s_mm = _frame_solve(xy, elems, ea, ei, {**held, 3 * i_b + 1: 1.0}, {})
            self.u_n, self.r_n, self.s_n = _frame_solve(xy, elems, ea, ei, {**held, 3 * i_b + 1: 0.0}, {3 * i_p: 1.0})
        except np.linalg.LinAlgError:
            self.error = "The one-piece part cannot be solved with these dimensions."
            return
        self.tilt0 = float(np.arctan2(cy0, cx0 - xa) + phi)
        self.gain = float(self.u_mm[i_p, 0] * sgn)      # mm of pin per mm of carriage travel Y, no tube
        self.compliance = float(self.u_n[i_p, 0])       # mm of pin per N on the pin
        self.r_pin = p.pin_diameter / 2.0

    def _reach(self, travel):
        """Pad's nearer end ahead of its centre; the foot turns with the part."""
        if self.half == 0.0:
            return 0.0
        return self.half * np.abs(np.sin(self.tilt0 + self.u_mm[self.i_p, 2] * travel))

    def free_pose(self, y):
        """Joint, pinch point and pin-to-wall gap with no tube pushing back."""
        travel = self.sgn * y
        (jx, jy), (tx, ty) = (self.xy[i][:, None] + self.u_mm[i, :2][:, None] * travel for i in (self.i_c, self.i_p))
        return jx, jy, tx, ty, self.wall_x + tx - self._reach(travel) - self.r_pin

    def forces(self, out: LinkageResult, y, gap, closed_gap):
        """Pin force, screw thrust and stress in the part over the stroke. Returns the loaded gap."""
        p, sgn, i_p, i_b = self.p, self.sgn, self.i_p, self.i_b
        out.flexure = {
            name: {"x": self.xy[idx, 0].tolist(), "y": self.xy[idx, 1].tolist(),
                   "x_per_mm": self.u_mm[idx, 0].tolist(), "y_per_mm": self.u_mm[idx, 1].tolist(),
                   "x_per_n": self.u_n[idx, 0].tolist(), "y_per_n": self.u_n[idx, 1].tolist()}
            for name, idx in self.lines.items()
        }
        out.flexure["travel_sign"] = sgn
        out.link_arc_half_angle_deg, out.link_arc_side = float(np.degrees(self.alpha)), self.side
        if self.alpha > 0.0:
            out.link_arc_radius = float(p.bar1_length if p.fixed_height <= 0 else out.link_length) / (2.0 * np.sin(self.alpha))
            out.link_arc_sag = float(out.link_arc_radius * (1.0 - np.cos(self.alpha)))
        travel = sgn * y
        # Screw thrust to bend the two parts with no tube in place: the same spring on both sides.
        out.spring_rate = float(2.0 * abs(self.r_mm[i_b, 1]))
        if p.compliance <= 0 or (p.pin_diameter <= 0 and self.half == 0.0):
            out.forces_message = "No pin force: it needs a tube compliance above 0 and a pin diameter or a pad."
            force = np.zeros_like(y)
            pushed = np.zeros_like(y)
            parts = None
        else:
            tilt = self.tilt0 + self.u_mm[i_p, 2] * travel
            st, ct = np.abs(np.sin(tilt)), np.abs(np.cos(tilt))
            parts = _pinch_force(p, gap, st, ct)
            pushed = np.zeros_like(y)
            if p.contact_deformation:
                # Same balance as the pivoted linkages: the tube pushes the pin back until the
                # part's spring at the pin and the tube agree.
                c = max(self.compliance, 0.0)
                lo, hi = np.zeros_like(y), c * sum(parts)
                for _ in range(8):
                    hi = np.where(hi < c * sum(_pinch_force(p, gap + hi, st, ct)), 2.0 * hi + 1e-6, hi)
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    short = mid < c * sum(_pinch_force(p, gap + mid, st, ct))
                    lo, hi = np.where(short, mid, lo), np.where(short, hi, mid)
                pushed = 0.5 * (lo + hi)
                parts = _pinch_force(p, gap + pushed, st, ct)
            force = sum(parts)
        loaded = gap + pushed

        # Pose under load, for the drawing.
        for name, i in (("joint", self.i_c), ("tip", i_p)):
            pos = self.xy[i][:, None] + self.u_mm[i, :2][:, None] * travel + self.u_n[i, :2][:, None] * force
            setattr(out, name + "_x", pos[0].tolist())
            setattr(out, name + "_y", pos[1].tolist())

        # Force the carriage must give along +Y for this part; the other part is this one at -Y, reversed.
        pull = sgn * (self.r_mm[i_b, 1] * travel + self.r_n[i_b, 1] * force)
        thrust = pull - pull[::-1]
        side_load = np.abs(self.r_mm[i_b, 0] * travel + self.r_n[i_b, 0] * force)
        rod_load = np.hypot(side_load, self.r_mm[i_b, 1] * travel + self.r_n[i_b, 1] * force)
        # Stress along the part: bending at the worse end of each element, plus the axial share.
        axial = np.abs(self.s_mm[:, 0][:, None] * travel + self.s_n[:, 0][:, None] * force)
        bending = np.maximum(np.abs(self.s_mm[:, 1][:, None] * travel + self.s_n[:, 1][:, None] * force),
                             np.abs(self.s_mm[:, 2][:, None] * travel + self.s_n[:, 2][:, None] * force))
        stress_all = bending / self.section + axial / self.area
        stress = stress_all.max(axis=0)
        rotation = np.abs(self.u_mm[:, 2][:, None] * travel + self.u_n[:, 2][:, None] * force).max(axis=0)

        wall = p.tube_od - p.tube_id
        force_out, flex_out, thrust_out, stress_out = force.astype(float), pushed.astype(float), thrust.astype(float), stress.astype(float)
        if parts is not None:
            # The part gives way, so what counts is the gap left once it has: the closed tube is
            # crushed to the wall only if the part is stiff enough to do it.
            crushed = np.abs(y[loaded <= 0.05 * wall])
            if crushed.size:
                out.jam_y = float(crushed.min())
                past = np.abs(y) >= out.jam_y
                force_out, flex_out, thrust_out, stress_out = (np.where(past, np.nan, v) for v in (force_out, flex_out, thrust_out, stress_out))
        i0 = N_SAMPLES // 2
        valid = np.isfinite(stress_out)
        out.thrust = _nan_to_none(np.abs(thrust_out))
        out.stress_a, out.stress_b = _nan_to_none(stress_out), _nan_to_none(stress_out[::-1])
        worst = int(np.nanargmax(np.where(valid, stress, -1.0)))
        out.max_stress_mpa = float(stress[worst])
        at = int(np.argmax(stress_all[:, worst]))
        out.max_stress_where = self.parts[at]
        first_of_part = at == 0 or self.parts[at - 1] != self.parts[at]
        last_of_part = at == len(self.parts) - 1 or self.parts[at + 1] != self.parts[at]
        if self.parts[at] == "arm":
            out.max_stress_spot = "shell" if first_of_part else "joint" if last_of_part else "span"
        elif self.parts[at] == "link":
            out.max_stress_spot = "joint" if first_of_part else "carriage" if last_of_part else "span"
        else:
            out.max_stress_spot = "joint" if first_of_part else "span"
        out.max_bending_stress_mpa = float((bending / self.section)[:, valid].max())
        out.max_axial_stress_mpa = float((axial / self.area)[:, valid].max())
        if alpha_link := [i for i, part in enumerate(self.parts) if part == "link"]:
            out.link_bending_stress_mpa = float((bending[alpha_link] / self.section)[:, valid].max())
        if p.member_strength_mpa > 0 and out.max_stress_mpa > 1e-9:
            out.stress_margin = float(p.member_strength_mpa / out.max_stress_mpa)
            over = np.abs(y[valid & (stress > p.member_strength_mpa)])
            out.stress_limit_y = float(over.min()) if over.size else None
        out.max_rotation_deg = float(np.degrees(rotation[valid].max()))
        out.max_side_load = float(side_load[valid].max())
        out.carriage_load = float(rod_load[valid].max())
        out.carriage_load_a = _nan_to_none(np.where(valid, rod_load, np.nan))
        d_rod, l_rod = p.carriage_pin_diameter, p.carriage_pin_length
        if not p.carriage_clamped and d_rod > 0 and l_rod > 0:
            # Half the rod is in the carriage, half in the eye. The eye's load sits at the middle
            # of its half, a quarter of the rod length from where the rod leaves the carriage.
            out.carriage_bearing_mpa = out.carriage_load / (d_rod * l_rod / 2.0)
            if True:
                out.carriage_pin_bending_mpa = float(32.0 * out.carriage_load * l_rod / 4.0 / (np.pi * d_rod ** 3))
        out.thrust_y0 = float(abs(thrust[i0]))
        out.thrust_needed = float(np.nanmax(np.abs(thrust_out)))
        _screw(p, out, y, thrust_out)
        out.pin_stiffness = float(1.0 / self.compliance) if self.compliance > 0 else None
        if parts is None:
            return None
        out.force_a, out.force_b = _nan_to_none(force_out), _nan_to_none(force_out[::-1])
        out.flex_a, out.flex_b = _nan_to_none(flex_out), _nan_to_none(flex_out[::-1])
        out.tube_modulus_mpa = wall / p.compliance
        out.seal_force = float(force[i0])
        out.seal_force_min = float(sum(_pinch_force(p, np.array([closed_gap]), st[i0:i0 + 1], ct[i0:i0 + 1]))[0])
        out.seal_force_flatten, out.seal_force_squeeze, out.seal_force_pressure = (float(v[i0]) for v in parts)
        out.max_pinch_force = float(np.nanmax(force_out))
        out.max_wall_strain = float(np.clip(wall - np.nanmin(np.where(np.isfinite(force_out), loaded, np.nan)), 0.0, wall) / wall)
        out.flex_y0 = float(pushed[i0])
        out.seal_pressure_y0_kpa = float(max((wall - loaded[i0]) / p.compliance, 0.0) * 1000.0)
        out.sealed_after_flex = bool(loaded[i0] <= closed_gap + 1e-12)
        return loaded


def compute_linkage(p: LinkageParams) -> LinkageResult:
    if min(p.bar1_length, p.bar2_length, p.lever_length, p.stroke, p.tube_id) <= 0 or p.tube_od <= p.tube_id:
        return LinkageResult(False, "Lengths, stroke and tube sizes must be positive, with OD > ID.")
    l1, l2 = p.bar1_length, p.bar2_length
    side, root, sgn = _layout(p)
    xa, xb = side * p.anchor_distance, p.pivot_offset
    reach, delta = _body(p, l2, p.lever_length)
    half, phi = _pad(p)
    wall_x, closed_gap, full_open_gap = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)

    with np.errstate(invalid="ignore", divide="ignore"):
        cx0, cy0 = _closed_joint(l2, reach, delta, half, phi, xa, x_closed)
        if p.fixed_height > 0:
            # Height imposed: bar 1 is whatever joins the carriage pivot to the closed joint.
            h0 = p.fixed_height / 2.0
            l1 = float(np.hypot(xb - cx0, h0 - cy0))
        else:
            h0 = float(_pivot_height_y0(l1, root, xb, cx0, cy0))
    if not (np.isfinite(h0) and np.isfinite(l1)):
        return LinkageResult(
            False,
            "The pinch point cannot reach the tube at Y = 0: the bar hinged at the anchor is too short, or bar 1 cannot reach its joint.",
            anchor_x=xa, wall_x=wall_x, closed_gap=closed_gap, full_open_gap=full_open_gap,
        )

    y = np.linspace(-p.stroke, p.stroke, N_SAMPLES)
    with np.errstate(invalid="ignore"):
        jx, jy = _joint(l1, l2, xa, xb, h0 + sgn * y)
        # Below the anchor line the hinged bar has gone through dead centre: not a usable pose.
        ok = np.isfinite(jx) & (jy >= -_EPS) & (h0 + sgn * y > 0.0)
    jx, jy = np.where(ok, jx, np.nan), np.where(ok, jy, np.nan)
    tx, ty = _tip(xa, jx, jy, reach / l2, delta)
    gap_a = wall_x + tx - _pad_reach(xa, jx, jy, half, phi) - r_pin
    flexure = None
    if p.compliant and p.linkage_type == TYPE_PENDULUM:
        # One piece that bends: the rest shape is the Y = 0 pose above, and the poses come from
        # the beam model instead of the pivots.
        flexure = _Flexure(p, xa, xb, h0, sgn, l1, float(cx0), float(cy0), reach / l2, delta, half, phi, wall_x)
        if flexure.error:
            return LinkageResult(False, flexure.error, anchor_x=xa, anchor_on_top=sgn < 0.0, link_length=l1, pivot_height_y0=h0,
                                 wall_x=wall_x, closed_gap=closed_gap, full_open_gap=full_open_gap)
        ok = np.ones(N_SAMPLES, dtype=bool)
        jx, jy, tx, ty, gap_a = flexure.free_pose(y)
    i0 = N_SAMPLES // 2
    lo = hi = i0
    while lo > 0 and ok[lo - 1]:
        lo -= 1
    while hi < N_SAMPLES - 1 and ok[hi + 1]:
        hi += 1
    feasible = bool(np.all(ok))
    if not ok[i0]:
        msg = "Linkage cannot be assembled at Y = 0."
    elif hi < N_SAMPLES - 1:
        msg = "Bars reach full extension at Y = %.2f mm, before the end of the stroke." % y[hi]
    elif lo > 0:
        msg = "The linkage locks at Y = %.2f mm (hinged bar at dead centre) before -stroke: the closed tube cannot follow." % y[lo]
    else:
        msg = "ok"
    if flexure is not None and flexure.gain <= 0.0:
        feasible, msg = False, "Moving the carriage this way presses the part onto its tube instead of lifting it: the tube never opens."
    pos = y >= 0.0
    out = LinkageResult(
        feasible=feasible,
        message=msg,
        Y_positions=y.tolist(),
        joint_x=_nan_to_none(jx),
        joint_y=_nan_to_none(jy),
        tip_x=_nan_to_none(tx),
        tip_y=_nan_to_none(ty),
        gap_a=_nan_to_none(gap_a),
        gap_b=_nan_to_none(gap_a[::-1]),
        anchor_x=xa,
        anchor_on_top=sgn < 0.0,
        link_length=l1,
        pivot_height_y0=h0,
        wall_x=wall_x,
        closed_gap=closed_gap,
        full_open_gap=full_open_gap,
        y_min=float(y[lo]),
        y_max=float(y[hi]),
        sensitivity_y0=float((gap_a[i0 + 1] - gap_a[i0]) / (y[1] - y[0])) if ok[i0] and ok[i0 + 1] else 0.0,
        pinch_slide=float(abs(ty[hi] - ty[i0])) if ok[i0] else 0.0,
        max_oversqueeze=float(max(closed_gap - np.nanmin(gap_a[~pos | (y == 0.0)]), 0.0)) if ok[i0] else 0.0,
    )
    if flexure is not None:
        loaded = flexure.forces(out, y, gap_a, closed_gap)
    else:
        loaded = _forces(p, out, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap_a, closed_gap, half, phi)
    # What the air sees: the gap once the tube has pushed the pin back, when that is solved.
    out.contact_solved = bool(p.contact_deformation and loaded is not None)
    gap_air = np.where(ok, loaded, np.nan) if out.contact_solved else gap_a
    out.gap_loaded_a, out.gap_loaded_b = _nan_to_none(gap_air), _nan_to_none(gap_air[::-1])

    area_a = np.where(ok, _area_mm2(p, np.nan_to_num(gap_air, nan=0.0), closed_gap), 0.0)
    area_b = area_a[::-1]
    p_up = P_ATM + p.input_pressure_kpa * 1000.0
    # Static model: downstream at atmosphere, so flow is linear in area (same convention as the cam tab).
    per_mm2 = _compute_orifice_mass_flow_rate(1.0, p_up, P_ATM) / (p_up / (R_AIR * T_AMB)) * 60.0 * 1000.0
    flow_a = np.where(ok, area_a * per_mm2, np.nan)
    q_max = float(np.pi * (p.tube_id / 2.0) ** 2 * per_mm2)

    u = np.clip(y / p.stroke, 0.0, 1.0)
    target_gap = closed_gap + (full_open_gap - closed_gap) * u ** p.target_exponent
    flow_target = np.where(y >= 0.0, q_max * u ** p.target_exponent, np.nan)

    with np.errstate(invalid="ignore", divide="ignore"):
        y_open = float(_crossing(y[pos], gap_air[pos][None, :], closed_gap)[0])
        y_full = float(_crossing(y[pos], gap_air[pos][None, :], full_open_gap)[0])
    speed = p.motor_speed * p.speed_factor * p.lead_screw_pitch / 60.0
    if bool(np.all(ok[pos])):
        out.rms_error = float(np.sqrt(np.mean(((np.minimum(gap_air[pos], full_open_gap) - target_gap[pos]) / (full_open_gap - closed_gap)) ** 2)))
    out.flow_a, out.flow_b = _nan_to_none(flow_a), _nan_to_none(flow_a[::-1])
    out.flow_target = _nan_to_none(flow_target)
    out.y_full_open = y_full if np.isfinite(y_full) else None
    out.y_open = y_open if np.isfinite(y_open) else None
    out.response_time_ms = y_full / speed * 1000.0 if np.isfinite(y_full) and speed > 0 else None
    out.max_flow_l_min = q_max
    if feasible:
        cycle = _chamber_cycle(p, y, area_a, area_b)
        if cycle is not None:
            t_ms, y_t, q_in, q_out, p_g, v_in, v_out = cycle
            out.time_ms, out.y_time = t_ms.tolist(), y_t.tolist()
            out.flow_in_l_min, out.flow_out_l_min, out.chamber_kpa = q_in.tolist(), q_out.tolist(), p_g.tolist()
            out.volume_in_ml, out.volume_out_ml = v_in, v_out
    return out


@dataclass
class LinkageSearch:
    bar1_min: float = 6.0
    bar1_max: float = 20.0
    bar2_min: float = 3.0
    bar2_max: float = 14.0
    lever_min: float = 10.0
    lever_max: float = 22.0
    anchor_min: float = 0.0
    anchor_max: float = 6.0
    foot_min: float = 1.0             # mm, pendulum foot; min = max keeps it as it is
    foot_max: float = 6.0
    foot_angle_min: float = 45.0      # deg
    foot_angle_max: float = 135.0
    min_pivot_height: float = 3.0     # mm, carriage pivot above the anchor at Y = 0
    max_pivot_height: float = 16.0    # mm, carriage pivot above the anchor at the top of the stroke
    max_oversqueeze: float = 0.5      # mm, closed tube over the travel used
    objective: str = OBJECTIVE_RESPONSE
    max_stroke: float = 3.0           # mm, longest travel the response search may use


def _crossing(y: np.ndarray, gap: np.ndarray, level: float) -> np.ndarray:
    """First y (last axis, linear interpolation) where gap reaches level; inf where it never does."""
    above = gap >= level
    i1 = np.clip(np.argmax(above, axis=-1), 1, None)
    g0 = np.take_along_axis(gap, (i1 - 1)[..., None], axis=-1)[..., 0]
    g1 = np.take_along_axis(gap, i1[..., None], axis=-1)[..., 0]
    yc = y[i1 - 1] + (level - g0) / (g1 - g0) * (y[i1] - y[i1 - 1])
    yc = np.where(above[..., 0], y[0], yc)
    return np.where(np.any(above, axis=-1) & np.isfinite(yc), yc, np.inf)


def _score(p: LinkageParams, s: LinkageSearch, l1, l2, a, lever_length, foot=None, foot_angle_deg=None) -> np.ndarray:
    """Score for arrays of candidates (one per row), lower is better; inf where infeasible.

    "target": RMS distance of the opening from (Y / stroke) ** exponent over the stroke.
    "response": most flow first, then the narrowest dead band, then the shortest travel.
    The carriage may travel until the closed tube is squeezed past the limit, the bars
    lock, or max_stroke. The flow is the best opening reached within that travel; a
    design that cannot reach full bore is ranked by how far it gets, not thrown out.
    """
    if p.linkage_type == TYPE_PENDULUM and foot is not None:
        p = replace(p, foot_length=foot, foot_angle_deg=foot_angle_deg)
    wall_x, closed_gap, full_open_gap = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)
    side, root, sgn = _layout(p)
    xa, xb = side * a, p.pivot_offset
    reach, delta = _body(p, l2, lever_length)
    delta_ = delta[..., None] if isinstance(delta, np.ndarray) else delta
    fast = s.objective == OBJECTIVE_RESPONSE
    with np.errstate(invalid="ignore", divide="ignore"):
        half, phi = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0, np.radians(p.foot_angle_deg)
        phi_ = phi[..., None] if isinstance(phi, np.ndarray) else phi
        cx0, cy0 = _closed_joint(l2, reach, delta, half, phi, xa, x_closed)
        if p.fixed_height > 0:
            h0 = np.full_like(l2, p.fixed_height / 2.0)
            l1 = np.hypot(xb - cx0, h0 - cy0)
        else:
            h0 = _pivot_height_y0(l1, root, xb, cx0, cy0)
        y = np.linspace(0.0, s.max_stroke, N_RESPONSE) if fast else np.linspace(0.0, p.stroke, N_SCORE)
        ratio = (reach / l2)[..., None]
        xa_ = xa[..., None]
        # Tube A opening over the travel; the same linkage at -Y is what the closed tube sees.
        jx, jy = _joint(l1[..., None], l2[..., None], xa_, xb, h0[..., None] + sgn * y)
        cx, cy = _joint(l1[..., None], l2[..., None], xa_, xb, h0[..., None] - sgn * y)
        gap = wall_x + _tip(xa_, jx, jy, ratio, delta_)[0] - _pad_reach(xa_, jx, jy, half, phi_) - r_pin
        squeeze = closed_gap - (wall_x + _tip(xa_, cx, cy, ratio, delta_)[0] - _pad_reach(xa_, cx, cy, half, phi_) - r_pin)
        pose_ok = np.isfinite(jx) & (jy >= 0.0) & np.isfinite(cx) & (cy >= 0.0)
        if fast:
            # Travel the design can use: up to the first pose that locks or crushes the closed tube.
            usable = np.logical_and.accumulate(pose_ok & (squeeze <= s.max_oversqueeze) & (h0[..., None] > y), axis=-1)
            if p.fixed_height <= 0:
                usable &= h0[..., None] + y <= s.max_pivot_height
            # Credit a travel only if the design is still fine 0.05 mm further (the stroke is
            # rounded up to that) and the bars are still 0.2 mm short of locking: a design
            # that works right at dead centre does not survive a real assembly.
            step = y[1] - y[0]
            for ahead, good in ((0.05, usable), (0.2, np.logical_and.accumulate(pose_ok, axis=-1))):
                k = min(int(np.ceil(ahead / step - 1e-9)), N_RESPONSE - 1)
                usable = usable & np.concatenate([good[..., k:], np.repeat(good[..., -1:], k, axis=-1)], axis=-1)
            seen = np.where(usable, gap, -np.inf)
            bore = full_open_gap - closed_gap
            flow = np.clip(np.max(seen, axis=-1) - closed_gap, 0.0, bore) / bore
            y_open = np.minimum(_crossing(y, seen, closed_gap), s.max_stroke)
            y_full = _crossing(y, seen, full_open_gap)
            travel = np.where(np.isfinite(y_full), y_full, y[np.sum(usable, axis=-1) - 1])
            score = 100.0 * (1.0 - flow) + 2.0 * y_open + 0.2 * travel
            ok = usable[..., 0] & (flow > 0.0)
        else:
            target = closed_gap + (full_open_gap - closed_gap) * (y / p.stroke) ** p.target_exponent
            err = (np.minimum(gap, full_open_gap) - target) / (full_open_gap - closed_gap)
            score = np.sqrt(np.mean(err * err, axis=-1))
            ok = (
                (h0 > p.stroke)
                & np.all(pose_ok, axis=-1)
                & (np.max(np.where(pose_ok, squeeze, -np.inf), axis=-1) <= s.max_oversqueeze)
            )
            if p.fixed_height <= 0:
                ok &= h0 + p.stroke <= s.max_pivot_height
        ok &= np.isfinite(score) & ((reach >= l2) | (p.linkage_type != TYPE_LEVER))
        if p.fixed_height > 0:
            ok &= (l1 >= min(s.bar1_min, s.bar1_max)) & (l1 <= max(s.bar1_min, s.bar1_max))
        else:
            ok &= h0 >= s.min_pivot_height
    return np.where(ok, score, np.inf)


N_FIRST = 30000   # candidates drawn over the whole ranges
N_ROUND = 12000   # candidates per refinement round
N_ELITE = 24
# One-piece pendulum: designs from the rigid search go through the beam model. The rigid ranking
# is a poor guide for a part that bends (on the default pendulum about 1 random design in 7 beat
# the best of the 50 best rigid ones), so the first batch is half the best rigid designs and half
# designs drawn at random among those the first rigid draw found feasible. Rounds of draws around
# the best designs that hold follow.
N_SHORTLIST = 50
# Near-duplicates share a cell. The rigid half takes the best design of each coarse cell (a quarter
# of every searched range) first, for spread, then fills up with the best of each fine cell (1/25).
SHORTLIST_CELLS = (4, 25)
N_ONE_PIECE_ROUND = 20                 # beam solves per round around the best designs that hold
ONE_PIECE_ROUNDS = (0.15, 0.08, 0.04)  # spread of each round, as a share of each searched range
ONE_PIECE_LIMITS = ("stress", "thrust", "eye", "rod", "no_flow")


def _crushed(r: LinkageResult, s: LinkageSearch, gap) -> np.ndarray:
    """|Y| where the closed tube is squeezed past max_oversqueeze, reading this pin-to-wall gap."""
    y, gap = np.array(r.Y_positions), np.array([np.nan if g is None else g for g in gap], dtype=float)
    return np.abs(y[np.isfinite(gap) & (r.closed_gap - gap > s.max_oversqueeze)])


def _stroke_used(r: LinkageResult, s: LinkageSearch, caps=(), gap=None) -> float:
    """Travel a response design uses: full bore rounded up to 0.05 mm when that fits under
    max_stroke and every cap, else as far as the closed tube (squeeze read on `gap`, default
    the bars' own gap_a) and the caps allow, rounded down to 0.05 mm (can come out below 0.05)."""
    if r.y_full_open is not None:
        full = min(s.max_stroke, round(float(np.ceil(r.y_full_open / 0.05 - 1e-9)) * 0.05, 2))
        if not caps or full <= min(caps):
            return full
    crushed = _crushed(r, s, r.gap_a if gap is None else gap)
    limit = min([s.max_stroke, r.y_max, -r.y_min] + ([float(crushed.min())] if crushed.size else []) + list(caps))
    return round(float(np.floor(limit / 0.05 + 1e-9)) * 0.05, 2)


def _worst(values, used) -> Optional[float]:
    v = np.array([np.nan if x is None else x for x in values], dtype=float)
    v = v[used & np.isfinite(v)] if v.size == used.size else v[:0]
    return float(v.max()) if v.size else None


def _one_piece_limit(p: LinkageParams, r: LinkageResult, travel: float) -> Optional[str]:
    """First limit (ONE_PIECE_LIMITS order) the one-piece part breaks for |Y| <= travel, both parts."""
    used = np.abs(np.array(r.Y_positions)) <= travel + 1e-9
    stress = _worst(r.stress_a, used)
    if p.member_strength_mpa > 0 and stress is not None and stress > p.member_strength_mpa:
        return "stress"
    thrust = _worst(r.thrust, used)
    if r.thrust_available is not None and r.thrust_available > 0 and thrust is not None and thrust > r.thrust_available:
        return "thrust"
    load = _worst(r.carriage_load_a, used)
    if not p.carriage_clamped and load is not None and r.carriage_load and r.carriage_bearing_mpa is not None:
        # Eye pressure and rod bending are both in proportion to the rod load.
        share = load / r.carriage_load
        if p.member_strength_mpa > 0 and r.carriage_bearing_mpa * share > p.member_strength_mpa:
            return "eye"
        if p.carriage_pin_strength_mpa > 0 and r.carriage_pin_bending_mpa * share > p.carriage_pin_strength_mpa:
            return "rod"
    return None


def _one_piece_score(q: LinkageParams, s: LinkageSearch):
    """Beam-model score of a one-piece design, mirroring _score. q.stroke covers the travel to score.

    Returns (score, travel, reason). reason is "no_flow" when the part has no travel to use: the
    solve fails, the pin presses onto its tube, or (response) the tube does not open before the
    closed one jams, is squeezed past max_oversqueeze or the carriage height runs out, or (target)
    the whole stroke does not run without that jam or squeeze. Otherwise it is the first limit
    broken over that travel (_one_piece_limit), else None.
    """
    r = compute_linkage(q)
    if not r.feasible or r.flexure is None:
        return np.inf, 0.0, "no_flow"
    # The part gives way, so the closed tube's squeeze is read on the loaded gap, as jam_y is.
    crushed = _crushed(r, s, r.gap_loaded_a)
    if s.objective != OBJECTIVE_RESPONSE:
        if r.rms_error is None or r.jam_y is not None or crushed.size > 0:
            return np.inf, q.stroke, "no_flow"
        return r.rms_error, q.stroke, _one_piece_limit(q, r, q.stroke)
    # Travel: as for the pivoted design, stopping short of crushing or jamming the closed tube
    # and within the carriage height limits of _score.
    caps = [r.pivot_height_y0 - 1e-6] + [v - 1e-6 for v in (r.jam_y, float(crushed.min()) if crushed.size else None) if v is not None]
    if q.fixed_height <= 0:
        caps.append(s.max_pivot_height - r.pivot_height_y0)
    travel = _stroke_used(r, s, caps, r.gap_loaded_a)
    if travel < 0.05 - 1e-9:
        return np.inf, travel, "no_flow"
    y = np.array(r.Y_positions)
    pos = y >= 0.0
    gap = np.array([np.nan if g is None else g for g in r.gap_loaded_a], dtype=float)[pos]
    seen = np.where((y[pos] <= travel + 1e-9) & np.isfinite(gap), gap, -np.inf)
    bore = r.full_open_gap - r.closed_gap
    flow = float(np.clip(seen.max() - r.closed_gap, 0.0, bore) / bore)
    if flow <= 0.0:
        return np.inf, travel, "no_flow"
    with np.errstate(invalid="ignore", divide="ignore"):
        y_open = min(float(_crossing(y[pos], seen[None, :], r.closed_gap)[0]), s.max_stroke)
        y_full = float(_crossing(y[pos], seen[None, :], r.full_open_gap)[0])
    score = 100.0 * (1.0 - flow) + 2.0 * y_open + 0.2 * (y_full if np.isfinite(y_full) else travel)
    return score, travel, _one_piece_limit(q, r, travel)


def _searched(p: LinkageParams, names, lo, hi) -> List[int]:
    """Columns the search moves: a range with min < max, and bar 1 only with a free height."""
    return [i for i, n in enumerate(names) if hi[i] > lo[i] and not (n == "bar1_length" and p.fixed_height > 0)]


def _shortlist(p: LinkageParams, names, lo, hi, x, score, n) -> np.ndarray:
    """Up to n best rigid designs, one per cell of the searched ranges, best first (rounded to 1 um)."""
    good = np.isfinite(score)
    x = np.round(x[good][np.argsort(score[good], kind="stable")], 3)
    searched = _searched(p, names, lo, hi)
    if not searched:
        return x[:1]
    unit = (x[:, searched] - lo[searched]) / (hi - lo)[searched]
    picked = []
    for cells in SHORTLIST_CELLS:
        first = np.sort(np.unique(np.floor(unit * cells).astype(np.int64), axis=0, return_index=True)[1])
        picked += [int(i) for i in first if i not in picked][:n - len(picked)]
    return x[np.sort(picked)]


def optimize_linkage(p: LinkageParams, s: LinkageSearch) -> Tuple[Optional[LinkageParams], int, int, dict]:
    """Random draw over the ranges, then rounds of tighter draws around the best designs.

    Searched: the bar lengths and the anchor distance, plus the lever length (lever) or the
    foot length and angle (pendulum). With a fixed height bar 1 is solved, not searched.
    A range with min = max holds that value.

    The draws use rigid bars. A one-piece pendulum (compliant) bends instead, so designs from
    the rigid search are then run through the beam model: N_SHORTLIST of them (half the best
    distinct rigid designs, half drawn at random among the rigid-feasible ones of the first
    draw), then ONE_PIECE_ROUNDS rounds of N_ONE_PIECE_ROUND draws around the best that hold.
    They are ranked by the same objective on the loaded gap (also for the closed tube's squeeze,
    as jam_y is; the result's max_oversqueeze stays the unloaded figure) and kept only if the part
    holds over the travel it uses: stress, screw thrust, and with a free carriage end the rod's
    eye and the rod itself. A limit whose strength is 0 is not checked.

    Returns (best params or None, feasible, tested, report). feasible is how many designs of the
    first draw the rigid model accepts, tested the size of that draw: in one-piece mode feasible
    can be above 0 with no design returned, when the beam model rejects every one it solved.
    report = {"model": "one-piece" | "rigid", "shortlist", "passed", "rejected"}: shortlist is
    how many designs the beam model solved, passed how many of those hold every limit, rejected
    counts each other one once under the first reason it fails ("no_flow" first: no travel that
    opens the tube, see _one_piece_score; then "stress", "thrust", "eye", "rod" over that
    travel). shortlist = passed + sum(rejected). All zero in rigid mode.
    """
    one_piece = p.compliant and p.linkage_type == TYPE_PENDULUM
    report = {"model": "one-piece" if one_piece else "rigid", "shortlist": 0, "passed": 0,
              "rejected": {k: 0 for k in ONE_PIECE_LIMITS}}
    names = ["bar1_length", "bar2_length", "anchor_distance"]
    bounds = [(s.bar1_min, s.bar1_max), (s.bar2_min, s.bar2_max), (s.anchor_min, s.anchor_max)]
    if p.linkage_type == TYPE_LEVER:
        names.append("lever_length")
        bounds.append((s.lever_min, s.lever_max))
    if p.linkage_type == TYPE_PENDULUM:
        names += ["foot_length", "foot_angle_deg"]
        bounds += [(s.foot_min, s.foot_max), (s.foot_angle_min, s.foot_angle_max)]
    lo = np.array([min(b) for b in bounds], dtype=float)
    hi = np.array([max(b) for b in bounds], dtype=float)
    width = hi - lo
    rng = np.random.default_rng(0)   # same answer for the same inputs

    def evaluate(x):
        col = dict(zip(names, x.T))
        return _score(p, s, col["bar1_length"], col["bar2_length"], col["anchor_distance"],
                      col.get("lever_length"), col.get("foot_length"), col.get("foot_angle_deg"))

    # The design on screen competes too when it lies inside the ranges.
    start = np.clip(np.array([getattr(p, n) for n in names], dtype=float), lo, hi)
    x = np.vstack([start, lo + rng.random((N_FIRST, len(names))) * width])
    score = evaluate(x)
    tested, feasible = len(x), int(np.isfinite(score).sum())
    if feasible == 0:
        return None, 0, tested, report
    pool = [(x, score)]
    spread = 0.12
    for _ in range(6):
        order = np.argsort(score)[:N_ELITE]
        elite, elite_score = x[order], score[order]
        elite = elite[np.isfinite(elite_score)]
        draws = elite[rng.integers(0, len(elite), N_ROUND)] + rng.normal(0.0, spread, (N_ROUND, len(names))) * width
        x = np.vstack([elite, np.clip(draws, lo, hi)])
        score = evaluate(x)
        pool.append((x, score))
        spread *= 0.5
    if one_piece:
        return _one_piece_pick(p, s, names, lo, hi, pool, evaluate, report), feasible, tested, report
    best = x[int(np.argmin(score))]
    out = replace(p, **{name: round(float(v), 3) for name, v in zip(names, best)})
    if s.objective == OBJECTIVE_RESPONSE:
        # Show and run exactly the travel the design uses: full bore, or as far as the closed
        # tube allows, rounded to 0.05 mm.
        out.stroke = s.max_stroke
        r = compute_linkage(out)
        out.stroke = _stroke_used(r, s) if r.y_full_open is not None else max(0.05, _stroke_used(r, s))
    if p.fixed_height > 0:
        out.bar1_length = round(compute_linkage(out).link_length, 3)
    return out, feasible, tested, report


def _one_piece_pick(p, s, names, lo, hi, pool, evaluate, report) -> Optional[LinkageParams]:
    """Stage two for the one-piece pendulum: rank designs from the rigid search with the beam model."""
    rng = np.random.default_rng(1)   # its own stream: same answer for the same inputs
    n_rigid = N_SHORTLIST - N_SHORTLIST // 2
    batch = list(_shortlist(p, names, lo, hi, np.vstack([x for x, _ in pool]), np.concatenate([sc for _, sc in pool]), n_rigid))
    first_x, first_score = pool[0]
    spread_pool = np.round(first_x[np.isfinite(first_score)], 3)
    tried = {tuple(v) for v in batch}
    for i in rng.permutation(len(spread_pool)):
        if len(batch) >= N_SHORTLIST:
            break
        if tuple(spread_pool[i]) not in tried:
            tried.add(tuple(spread_pool[i]))
            batch.append(spread_pool[i])
    # One solve per design over the longest travel it may use; the chamber cycle does not score.
    stroke = s.max_stroke if s.objective == OBJECTIVE_RESPONSE else p.stroke
    ranked = []

    def solve(designs):
        for v in designs:
            q = replace(p, **{n: float(val) for n, val in zip(names, v)}, stroke=stroke, chamber_volume_ml=0.0)
            sc, travel, broken = _one_piece_score(q, s)
            report["shortlist"] += 1
            if broken:
                report["rejected"][broken] += 1
            else:
                ranked.append((sc, travel, q))
        ranked.sort(key=lambda t: t[0])

    solve(batch)
    width = np.where(np.isin(np.arange(len(names)), _searched(p, names, lo, hi)), hi - lo, 0.0)
    for spread in ONE_PIECE_ROUNDS:
        if not ranked:
            break
        # Draws around the best few that hold, kept only where the rigid search accepts the
        # geometry (carriage height, closed pose reachable), and not solved before.
        elite = np.array([[getattr(q, n) for n in names] for _, _, q in ranked[:3]])
        draws = elite[rng.integers(0, len(elite), 8 * N_ONE_PIECE_ROUND)] + rng.normal(0.0, spread, (8 * N_ONE_PIECE_ROUND, len(names))) * width
        draws = np.round(np.clip(draws, lo, hi), 3)
        fresh = []
        for v in draws[np.isfinite(evaluate(draws))]:
            if len(fresh) < N_ONE_PIECE_ROUND and tuple(v) not in tried:
                tried.add(tuple(v))
                fresh.append(v)
        solve(fresh)
    report["passed"] = len(ranked)
    for _, travel, q in ranked:
        q = replace(q, stroke=travel)
        r = compute_linkage(q)
        # Keep it only on a solve of exactly the design returned, at its own stroke.
        unusable = not r.feasible or r.jam_y is not None or _crushed(r, s, r.gap_loaded_a).size > 0
        broken = "no_flow" if unusable else _one_piece_limit(q, r, travel)
        if broken:
            report["rejected"][broken] += 1
            report["passed"] -= 1
            continue
        out = replace(q, chamber_volume_ml=p.chamber_volume_ml)
        if p.fixed_height > 0:
            out.bar1_length = round(r.link_length, 3)
        return out
    return None
