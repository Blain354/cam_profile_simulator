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

from dataclasses import dataclass, field
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


@dataclass
class LinkageResult:
    feasible: bool
    message: str
    Y_positions: List[float] = field(default_factory=list)
    joint_x: List[Optional[float]] = field(default_factory=list)
    joint_y: List[Optional[float]] = field(default_factory=list)
    tip_x: List[Optional[float]] = field(default_factory=list)
    tip_y: List[Optional[float]] = field(default_factory=list)
    gap_a: List[Optional[float]] = field(default_factory=list)
    gap_b: List[Optional[float]] = field(default_factory=list)
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
    seal_force: Optional[float] = None             # N per tube at Y = 0
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

    Statics of the hinged body about its anchor A: the tube pushes the pin away from the
    wall with F, the link (a two-force bar along B-C) holds it with a tension T. The
    second linkage is the first at -Y with its pull on the carriage reversed.
    Friction in the pivots and on the tube is left out.
    """
    if p.compliance <= 0:
        out.forces_message = "No forces: they are derived from the tube compliance, which is 0."
        return
    if p.pin_diameter <= 0 and half == 0.0:
        out.forces_message = "No forces: the pin has no diameter and no pad, so no contact area."
        return
    if min(p.member_modulus_mpa, p.member_width, p.member_thickness) <= 0:
        out.forces_message = "No forces: the bar section and modulus must be positive."
        return
    wall = p.tube_od - p.tube_id
    with np.errstate(invalid="ignore", divide="ignore"):
        tilt = np.arctan2(jy, jx - xa) + phi
        st, ct = np.abs(np.sin(tilt)), np.abs(np.cos(tilt))
        g = np.nan_to_num(gap, nan=1e9)
        parts = _pinch_force(p, g, np.nan_to_num(st), np.nan_to_num(ct, nan=1.0))
        force = np.where(ok, sum(parts), np.nan)
        stiff = (force - sum(_pinch_force(p, g + 1e-3, np.nan_to_num(st), np.nan_to_num(ct, nan=1.0)))) / 1e-3

        ux, uy = (xb - jx) / l1, (h0 + sgn * y - jy) / l1
        lever = (jx - xa) * uy - jy * ux
        t_unit = ty / lever                              # link tension per N on the pin
        l2 = np.hypot(jx - xa, jy)
        axial_unit = ((-1.0 - t_unit * ux) * (jx - xa) + (-t_unit * uy) * jy) / l2   # + = arm in compression
        arm = ty - jy                                    # moment arm of the pin force about the joint
        area = p.member_width * p.member_thickness
        inertia = p.member_thickness * p.member_width ** 3 / 12.0
        e = p.member_modulus_mpa
        c_link = t_unit ** 2 * l1 / (e * area)
        c_bend = arm ** 2 * (l2 + np.hypot(tx - jx, ty - jy)) / (3.0 * e * inertia)
        c_all = c_link + c_bend + axial_unit ** 2 * l2 / (e * area)   # mm of pin per N, from the strain energy
        flex = force * c_all / (1.0 + np.clip(stiff, 0.0, None) * c_all)
        pull = sgn * -t_unit * uy * force                # along +Y, linkage A on the carriage
    thrust = pull - pull[::-1]

    i0 = N_SAMPLES // 2
    out.force_a, out.force_b = _nan_to_none(force), _nan_to_none(force[::-1])
    out.thrust = _nan_to_none(np.abs(thrust))
    out.flex_a, out.flex_b = _nan_to_none(flex), _nan_to_none(flex[::-1])
    out.flex_link_a, out.flex_bend_a = _nan_to_none(flex * c_link / c_all), _nan_to_none(flex * c_bend / c_all)
    out.tube_modulus_mpa = wall / p.compliance
    if not ok[i0]:
        return
    out.seal_force = float(force[i0])
    out.seal_force_flatten, out.seal_force_squeeze, out.seal_force_pressure = (float(v[i0]) for v in parts)
    out.max_pinch_force = float(np.nanmax(force))
    out.max_wall_strain = float(np.clip(wall - np.nanmin(gap), 0.0, wall) / wall)
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
    out.max_bending_stress_mpa = float(np.nanmax(np.abs(arm) * force) * 6.0 / (p.member_thickness * p.member_width ** 2))
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
    gap_b = gap_a[::-1]
    area_a = np.where(ok, _area_mm2(p, np.nan_to_num(gap_a, nan=0.0), closed_gap), 0.0)
    area_b = area_a[::-1]
    p_up = P_ATM + p.input_pressure_psi * 6894.76
    # Static model: downstream at atmosphere, so flow is linear in area (same convention as the cam tab).
    per_mm2 = _compute_orifice_mass_flow_rate(1.0, p_up, P_ATM) / (p_up / (R_AIR * T_AMB)) * 60.0 * 1000.0
    flow_a = np.where(ok, area_a * per_mm2, np.nan)
    q_max = float(np.pi * (p.tube_id / 2.0) ** 2 * per_mm2)

    u = np.clip(y / p.stroke, 0.0, 1.0)
    target_gap = closed_gap + (full_open_gap - closed_gap) * u ** p.target_exponent
    flow_target = np.where(y >= 0.0, q_max * u ** p.target_exponent, np.nan)

    pos = y >= 0.0
    i0 = N_SAMPLES // 2
    lo = hi = i0
    while lo > 0 and ok[lo - 1]:
        lo -= 1
    while hi < N_SAMPLES - 1 and ok[hi + 1]:
        hi += 1
    with np.errstate(invalid="ignore", divide="ignore"):
        y_open = float(_crossing(y[pos], gap_a[pos][None, :], closed_gap)[0])
        y_full = float(_crossing(y[pos], gap_a[pos][None, :], full_open_gap)[0])
    speed = p.motor_speed * p.speed_factor * p.lead_screw_pitch / 60.0
    feasible = bool(np.all(ok))
    sens = float((gap_a[i0 + 1] - gap_a[i0]) / (y[1] - y[0])) if ok[i0] and ok[i0 + 1] else 0.0
    rms = None
    if bool(np.all(ok[pos])):
        rms = float(np.sqrt(np.mean(((np.minimum(gap_a[pos], full_open_gap) - target_gap[pos]) / (full_open_gap - closed_gap)) ** 2)))

    if not ok[i0]:
        msg = "Linkage cannot be assembled at Y = 0."
    elif hi < N_SAMPLES - 1:
        msg = "Bars reach full extension at Y = %.2f mm, before the end of the stroke." % y[hi]
    elif lo > 0:
        msg = "The linkage locks at Y = %.2f mm (hinged bar at dead centre) before -stroke: the closed tube cannot follow." % y[lo]
    else:
        msg = "ok"

    out = LinkageResult(
        feasible=feasible,
        message=msg,
        Y_positions=y.tolist(),
        joint_x=_nan_to_none(jx),
        joint_y=_nan_to_none(jy),
        tip_x=_nan_to_none(tx),
        tip_y=_nan_to_none(ty),
        gap_a=_nan_to_none(gap_a),
        gap_b=_nan_to_none(gap_b),
        flow_a=_nan_to_none(flow_a),
        flow_b=_nan_to_none(flow_a[::-1]),
        flow_target=_nan_to_none(flow_target),
        anchor_x=xa,
        anchor_on_top=sgn < 0.0,
        link_length=l1,
        pivot_height_y0=h0,
        wall_x=wall_x,
        closed_gap=closed_gap,
        full_open_gap=full_open_gap,
        y_min=float(y[lo]),
        y_max=float(y[hi]),
        y_full_open=y_full if np.isfinite(y_full) else None,
        y_open=y_open if np.isfinite(y_open) else None,
        response_time_ms=y_full / speed * 1000.0 if np.isfinite(y_full) and speed > 0 else None,
        sensitivity_y0=sens,
        pinch_slide=float(abs(ty[hi] - ty[i0])) if ok[i0] else 0.0,
        max_oversqueeze=float(max(closed_gap - np.nanmin(gap_a[~pos | (y == 0.0)]), 0.0)) if ok[i0] else 0.0,
        max_flow_l_min=q_max,
        rms_error=rms,
    )
    _forces(p, out, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap_a, closed_gap, half, phi)
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
    min_pivot_height: float = 3.0     # mm, carriage pivot above the anchor at Y = 0
    max_pivot_height: float = 16.0    # mm, carriage pivot above the anchor at the top of the stroke
    max_oversqueeze: float = 0.5      # mm, closed tube over the travel used
    objective: str = OBJECTIVE_RESPONSE
    max_stroke: float = 3.0           # mm, longest travel the response search may use to reach full bore


def _crossing(y: np.ndarray, gap: np.ndarray, level: float) -> np.ndarray:
    """First y (last axis, linear interpolation) where gap reaches level; inf where it never does."""
    above = gap >= level
    i1 = np.clip(np.argmax(above, axis=-1), 1, None)
    g0 = np.take_along_axis(gap, (i1 - 1)[..., None], axis=-1)[..., 0]
    g1 = np.take_along_axis(gap, i1[..., None], axis=-1)[..., 0]
    yc = y[i1 - 1] + (level - g0) / (g1 - g0) * (y[i1] - y[i1 - 1])
    yc = np.where(above[..., 0], y[0], yc)
    return np.where(np.any(above, axis=-1) & np.isfinite(yc), yc, np.inf)


def _score(p: LinkageParams, s: LinkageSearch, l1, l2, a, lever_length) -> np.ndarray:
    """Score for broadcastable arrays of candidates, lower is better; inf where infeasible.

    "target": RMS distance of the opening from (Y / stroke) ** exponent over the stroke.
    "response": carriage travel to full bore plus travel to first flow, i.e. the most
    sideways motion per mm of carriage: shortest response time and narrowest dead band.
    Only the travel actually needed (up to full bore) has to be reachable and gentle on
    the closed tube.
    """
    wall_x, closed_gap, full_open_gap = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)
    side, root, sgn = _layout(p)
    xa, xb = side * a, p.pivot_offset
    reach, delta = _body(p, l2, lever_length)
    delta_ = delta[..., None] if isinstance(delta, np.ndarray) else delta
    fast = s.objective == OBJECTIVE_RESPONSE
    with np.errstate(invalid="ignore", divide="ignore"):
        half, phi = _pad(p)
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
        gap = wall_x + _tip(xa_, jx, jy, ratio, delta_)[0] - _pad_reach(xa_, jx, jy, half, phi) - r_pin
        squeeze = closed_gap - (wall_x + _tip(xa_, cx, cy, ratio, delta_)[0] - _pad_reach(xa_, cx, cy, half, phi) - r_pin)
        pose_ok = np.isfinite(jx) & (jy >= 0.0) & np.isfinite(cx) & (cy >= 0.0)
        if fast:
            y_full = _crossing(y, gap, full_open_gap)
            score = y_full + _crossing(y, gap, closed_gap)
            # A little past full bore, so the stroke rounded up to 0.05 mm is covered too.
            used = y <= y_full[..., None] + 0.05
            travel = y_full + 0.05
        else:
            target = closed_gap + (full_open_gap - closed_gap) * (y / p.stroke) ** p.target_exponent
            err = (np.minimum(gap, full_open_gap) - target) / (full_open_gap - closed_gap)
            score = np.sqrt(np.mean(err * err, axis=-1))
            used = np.ones_like(gap, dtype=bool)
            travel = p.stroke
        ok = (
            np.isfinite(score)
            & ((reach >= l2) | (p.linkage_type != TYPE_LEVER))
            & (h0 > travel)
            & np.all(pose_ok | ~used, axis=-1)
            & (np.max(np.where(used & pose_ok, squeeze, -np.inf), axis=-1) <= s.max_oversqueeze)
        )
        if p.fixed_height > 0:
            ok &= (l1 >= min(s.bar1_min, s.bar1_max)) & (l1 <= max(s.bar1_min, s.bar1_max))
        else:
            ok &= (h0 >= s.min_pivot_height) & (h0 + travel <= s.max_pivot_height)
    return np.where(ok, score, np.inf)


def optimize_linkage(p: LinkageParams, s: LinkageSearch) -> Tuple[Optional[LinkageParams], int, int]:
    """Coarse grid over the bar lengths and anchor distance, then three zooms around the best cell.

    Returns (best params or None, feasible count on the coarse grid, coarse grid size).
    """
    lever = p.linkage_type == TYPE_LEVER
    names = ["bar1_length", "bar2_length", "anchor_distance"] + (["lever_length"] if lever else [])
    bounds = [(s.bar1_min, s.bar1_max), (s.bar2_min, s.bar2_max), (s.anchor_min, s.anchor_max)]
    if lever:
        bounds.append((s.lever_min, s.lever_max))
    bounds = [(min(lo, hi), max(lo, hi)) for lo, hi in bounds]
    n = 18 if lever else 36
    best, best_score, feasible, tested = None, np.inf, 0, 0
    window = bounds
    for level in range(4):
        axes = [np.linspace(lo, hi, n) for lo, hi in window]
        if p.fixed_height > 0:
            axes[0] = axes[0][:1]  # bar 1 is solved from the height, not searched
        if level == 0:
            tested = int(np.prod([len(ax) for ax in axes]))
        # One slice of the first axis at a time keeps the 4-D lever search within a few tens of MB.
        for v in axes[0]:
            rest = np.meshgrid(*axes[1:], indexing="ij")
            l2, a = rest[0], rest[1]
            score = _score(p, s, np.full_like(l2, v), l2, a, rest[2] if lever else None)
            if level == 0:
                feasible += int(np.isfinite(score).sum())
            idx = np.unravel_index(int(np.argmin(score)), score.shape)
            if score[idx] < best_score:
                best_score = float(score[idx])
                best = [float(v)] + [float(r[idx]) for r in rest]
        if best is None:
            return None, 0, tested
        window = []
        for ax, (blo, bhi), c in zip(axes, bounds, best):
            half = 1.5 * (ax[-1] - ax[0]) / (n - 1)
            window.append((max(blo, c - half), min(bhi, c + half)))
    values = {**p.__dict__, **{name: round(v, 3) for name, v in zip(names, best)}}
    out = LinkageParams(**values)
    if s.objective == OBJECTIVE_RESPONSE:
        # Show and run exactly the travel the design needs: full bore, rounded up to 0.05 mm.
        out.stroke = s.max_stroke
        y_full = compute_linkage(out).y_full_open
        if y_full is not None:
            out.stroke = min(s.max_stroke, round(float(np.ceil(y_full / 0.05 - 1e-9)) * 0.05, 2))
    if p.fixed_height > 0:
        out.bar1_length = round(compute_linkage(out).link_length, 3)
    return out, feasible, tested
