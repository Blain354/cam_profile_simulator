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
    input_pressure_psi: float = 15.0
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
    seal_pressure_y0_psi: Optional[float] = None   # pressure the seal at Y = 0 holds once the bars have flexed
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
    opening = p.compliance * p.input_pressure_psi * 0.00689476
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
    p_up = P_ATM + p.input_pressure_psi * 6894.76
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
    pressure = p.input_pressure_psi * 0.00689476
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
    out.seal_pressure_y0_psi = float(max(held, 0.0) / 0.00689476)
    out.sealed_after_flex = bool(gap[i0] + flex[i0] <= closed_gap + 1e-12)
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
    loaded = _forces(p, out, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap_a, closed_gap, half, phi)
    # What the air sees: the gap once the tube has pushed the pin back, when that is solved.
    out.contact_solved = bool(p.contact_deformation and loaded is not None)
    gap_air = np.where(ok, loaded, np.nan) if out.contact_solved else gap_a
    out.gap_loaded_a, out.gap_loaded_b = _nan_to_none(gap_air), _nan_to_none(gap_air[::-1])

    area_a = np.where(ok, _area_mm2(p, np.nan_to_num(gap_air, nan=0.0), closed_gap), 0.0)
    area_b = area_a[::-1]
    p_up = P_ATM + p.input_pressure_psi * 6894.76
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


def optimize_linkage(p: LinkageParams, s: LinkageSearch) -> Tuple[Optional[LinkageParams], int, int]:
    """Random draw over the ranges, then rounds of tighter draws around the best designs.

    Searched: the bar lengths and the anchor distance, plus the lever length (lever) or the
    foot length and angle (pendulum). With a fixed height bar 1 is solved, not searched.
    Returns (best params or None, feasible count in the first draw, size of the first draw).
    """
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
        return None, 0, tested
    spread = 0.12
    for _ in range(6):
        order = np.argsort(score)[:N_ELITE]
        elite, elite_score = x[order], score[order]
        elite = elite[np.isfinite(elite_score)]
        draws = elite[rng.integers(0, len(elite), N_ROUND)] + rng.normal(0.0, spread, (N_ROUND, len(names))) * width
        x = np.vstack([elite, np.clip(draws, lo, hi)])
        score = evaluate(x)
        spread *= 0.5
    best = x[int(np.argmin(score))]
    out = replace(p, **{name: round(float(v), 3) for name, v in zip(names, best)})
    if s.objective == OBJECTIVE_RESPONSE:
        # Show and run exactly the travel the design uses: full bore, or as far as the closed
        # tube allows, rounded to 0.05 mm.
        out.stroke = s.max_stroke
        r = compute_linkage(out)
        if r.y_full_open is not None:
            out.stroke = min(s.max_stroke, round(float(np.ceil(r.y_full_open / 0.05 - 1e-9)) * 0.05, 2))
        else:
            y, gap = np.array(r.Y_positions), np.array([np.nan if g is None else g for g in r.gap_a])
            crushed = np.abs(y[np.isfinite(gap) & (r.closed_gap - gap > s.max_oversqueeze)])
            limit = min([s.max_stroke, r.y_max, -r.y_min] + ([float(crushed.min())] if crushed.size else []))
            out.stroke = max(0.05, round(float(np.floor(limit / 0.05 + 1e-9)) * 0.05, 2))
    if p.fixed_height > 0:
        out.bar1_length = round(compute_linkage(out).link_length, 3)
    return out, feasible, tested
