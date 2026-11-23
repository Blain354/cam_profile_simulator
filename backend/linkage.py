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

Inverted pivot (pivot_inverted): B = (-pivot_offset, h0 + Y), on its own tube's side of the
screw axis instead of the far side, for all three types (the other linkage's pivot moves to the
far side with it, so the two pivots swap). The joint C stays on the side of the line A->B that
the closed pose at Y = 0 puts it on (_branch). Which side that is decides the link's load:
  C on the left of A->B (B outside the arm's line A-C, as always with the normal pivot): the
    link holds the pin back from the tube in compression, it pushes.
  C on the right (B on the tube side of the arm's line): the link holds it in tension, it
    pulls. The same carriage travel then moves the joint the other way, so the carriage runs
    the other way to open tube A: B = (x_B, h0 + travel_sign * Y) with travel_sign = -1 for a
    normal-frame type (elbow, lever) and +1 for the pendulum's upside-down frame.
  elbow: B stays above C and the arm rises from A to C, so B is always above the arm's line:
    the link pushes, from another angle.
  lever: B stays above C; it pulls only when B is further out than C and under the lever's line,
    which takes a short link and is rare.
  pendulum: B is between the anchor wall and C; when B is further out than the hanging arm at
    its height (the anchor nearer the screw than B), the link pulls.

Assembly (assembly_clearance): the two linkages sit in parallel planes linkage_plane_spacing
apart, so their members only meet if the slabs overlap; what does cross toward the other plane is
the carriage pivot rod and the carriage block. Each is checked in plane, against the members it
could hit, only when it comes within assembly_clearance of their slab across the planes (see the
section above _plane_gaps). compute_linkage reports the gap across the planes and, when something
is checked, the least clearance and where (_clearance_exact); the search ends a design's
travel where it is not met (_clearance_search). A member's clash with its own linkage, the tubes,
the walls or the screw is not checked.
"""

from dataclasses import asdict, dataclass, field, replace
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

import numpy as np

try:  # run from backend/ (uvicorn main:app) or as the backend package (tests)
    from simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate
    import tube_model as tube_law
except ImportError:
    from .simulation import P_ATM, R_AIR, T_AMB, _compute_orifice_mass_flow_rate
    from . import tube_model as tube_law

TYPE_ELBOW = "elbow"
TYPE_LEVER = "lever"
TYPE_PENDULUM = "pendulum"

OBJECTIVE_RESPONSE = "response"
OBJECTIVE_DEADBAND = "deadband"
OBJECTIVE_CHAMBER = "chamber"
OBJECTIVE_PROGRESSIVE = "progressive"
OBJECTIVE_TARGET = "target"
OBJECTIVES = (
    OBJECTIVE_RESPONSE,
    OBJECTIVE_DEADBAND,
    OBJECTIVE_CHAMBER,
    OBJECTIVE_PROGRESSIVE,
    OBJECTIVE_TARGET,
)

PIVOT_SIDES = {"normal": (False,), "inverted": (True,), "both": (False, True)}

LINK_CURVE_MODES = ("straight", "tangent", "radius")
LINK_CURVE_SEARCHES = ("current", "all", "straight", "tangent", "tangent_flip", "radius")

N_SAMPLES = 241
N_OPT_SAMPLES = 81   # fast odd grid used during one-piece screening; finalists run at full N_SAMPLES
N_SCORE = 60
N_RESPONSE = 121
N_TIME = 601
_EPS = 1e-9


def _is_auto_stroke(objective: str) -> bool:
    """Every objective except 'target' chooses the best usable stroke up to max_stroke."""
    return objective != OBJECTIVE_TARGET


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
    pivot_offset: float = 3.9        # mm, carriage pivot offset from the screw axis (far side; tube side when inverted)
    tube_center_x: float = 8.0       # mm, tube axis distance from the screw axis
    pin_diameter: float = 1.0        # mm, pinch pin
    preload: float = 0.1             # mm, extra squeeze past closure at Y = 0
    stroke: float = 3.0              # mm, carriage travel each way
    target_exponent: float = 1.0     # target opening = (Y / stroke) ** exponent
    tube_id: float = 2.0
    tube_od: float = 3.0
    input_pressure_kpa: float = 100.0
    compliance: float = 0.7          # mm/MPa, simple tube model only
    tube_model: str = tube_law.DEFAULT_TUBE_MODEL   # "fem": tube section solved by tube_fem; "simple": the compliance law
    tube_shore_a: float = tube_law.DEFAULT_SHORE_A  # silicone hardness, FEM only (Young's modulus by Gent's relation)
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
    link_curved: bool = False        # legacy toggle: True -> tangent arc when link_curve_mode is ""
    link_curve_mode: str = ""        # "" (follow link_curved) | "straight" | "tangent" | "radius" (pendulum only)
    link_curve_flip: bool = False    # tangent: opposite direction (+f vs -f); radius: outward (-1) vs inward (+1)
    link_radius: float = 10.0        # mm, arc radius when link_curve_mode == "radius" (clamped to >= l1 / 2)
    # One-piece flexure (pendulum only): arm, foot and link are a single part built into the
    # outer shell at the anchor. Nothing pivots; the part bends. See _Flexure.
    compliant: bool = False
    carriage_clamped: bool = False   # True: the link's carriage end is held in angle. False: it turns on the pivot rod
    carriage_pin_diameter: float = 1.5  # mm, steel rod the link turns on at the carriage
    carriage_pin_length: float = 8.0    # mm, that rod's length: half sits in the carriage, half in the link's eye
    member_strength_mpa: float = 40.0   # MPa, stress the material may see (assumed: about printed PETG at yield)
    carriage_pin_strength_mpa: float = 300.0  # MPa, bending the carriage rod may see (assumed: stainless steel)
    # Inverted pivot: the carriage pivot sits at x = -pivot_offset, on its own tube's side of the screw
    # axis, and the link reaches the joint from there. See _pivot_x and _branch.
    pivot_inverted: bool = False
    # Assembly: least gap kept between the two linkages over the stroke (assumed, not measured).
    assembly_clearance: float = 0.3
    # Where the two linkages sit across their planes, and the carriage block between them. Defaults
    # read from the pendulum's CAD (MINIVALVE, Part Studio "SMART_VALVE_MOTOR_V3_compliant links"):
    # tube holes at X = +-5.375 mm; carriage block X +-2.75, 17.5 mm long, 5 mm tall along the travel,
    # its centre 0.95 mm further from the anchor wall than the pivot rods. See _plane_gaps.
    linkage_plane_spacing: float = 10.75     # mm between the two linkages' mid-planes
    carriage_block_width: float = 5.5        # mm across the planes
    carriage_block_length: float = 17.5      # mm in the plane, square to the travel
    carriage_block_height: float = 5.0       # mm in the plane, along the travel
    carriage_block_offset: float = 0.95      # mm, block centre past the pivot rods, away from linkage A's anchor


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
    eye_limit_y: Optional[float] = None            # mm of travel where eye bearing passes member strength
    rod_limit_y: Optional[float] = None            # mm of travel where pivot rod bending passes rod strength
    flow_a: List[Optional[float]] = field(default_factory=list)
    flow_b: List[Optional[float]] = field(default_factory=list)
    flow_target: List[Optional[float]] = field(default_factory=list)
    anchor_x: float = 0.0
    anchor_on_top: bool = False      # the frame is the real mechanism upside down
    pivot_x: float = 0.0             # carriage pivot x in this frame: + far side of the screw axis, - tube side (inverted)
    travel_sign: float = 0.0         # the carriage pivot sits at h0 + travel_sign * Y in this frame
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
    # Assembly (_clearance_exact): clearance of what reaches the other linkage (in plane, and across the
    # planes when a gap is left there; see _with_across), None when nothing does.
    min_clearance: Optional[float] = None
    min_clearance_y: Optional[float] = None    # |Y| where it occurs
    min_clearance_where: Optional[str] = None  # "<member> A / <member> B": arm, foot or link
    collision_y: Optional[float] = None        # first |Y| where it is below assembly_clearance
    plane_gap: Optional[float] = None          # mm across the planes from the nearest crossing item to the slab it could hit
    plane_gap_where: Optional[str] = None      # "slabs" | "pivot rod" | "carriage"
    max_flow_l_min: float = 0.0
    max_flow_reached_l_min: float = 0.0            # highest static flow reached over 0..+stroke
    max_flow_reached_pct: float = 0.0              # share of full-bore max_flow_l_min reached (%)
    flow_slope_mean: Optional[float] = None        # mean dQ/dY (L/min per mm) over the rising open region
    flow_slope_max: Optional[float] = None         # peak dQ/dY (L/min per mm) over Y >= 0
    flow_accel_mean: Optional[float] = None        # mean d²Q/dY² (L/min per mm²) over the interior rising region
    flow_accel_max: Optional[float] = None         # peak d²Q/dY² (L/min per mm²) over the interior rising region
    rms_error: Optional[float] = None
    # Chamber cycle 0 -> +stroke -> 0 -> -stroke -> 0 at the motor's loaded linear speed.
    time_ms: List[float] = field(default_factory=list)
    y_time: List[float] = field(default_factory=list)
    flow_in_l_min: List[float] = field(default_factory=list)    # free air, supply -> chamber (tube A)
    flow_out_l_min: List[float] = field(default_factory=list)   # free air, chamber -> atmosphere (tube B)
    chamber_kpa: List[float] = field(default_factory=list)      # gauge
    volume_in_ml: float = 0.0
    volume_out_ml: float = 0.0
    chamber_t50_ms: Optional[float] = None         # time from Y = 0 to 50 % of supply pressure in the chamber
    chamber_t90_ms: Optional[float] = None         # time from Y = 0 to 90 % of supply pressure in the chamber
    # Forces and structure (see _forces). Empty / None when they cannot be computed.
    forces_message: str = ""
    force_a: List[Optional[float]] = field(default_factory=list)    # N, pin on tube A
    force_b: List[Optional[float]] = field(default_factory=list)
    thrust: List[Optional[float]] = field(default_factory=list)     # N, screw thrust that balances the two tubes
    flex_a: List[Optional[float]] = field(default_factory=list)     # mm, pin of tube A pushed back by bar flex
    flex_b: List[Optional[float]] = field(default_factory=list)
    flex_link_a: List[Optional[float]] = field(default_factory=list)  # share of flex_a from the link's stretch
    flex_bend_a: List[Optional[float]] = field(default_factory=list)  # share of flex_a from bending
    tube_modulus_mpa: Optional[float] = None       # wall modulus: implied by the compliance (simple), Young's modulus (FEM)
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


def _joint(l1, l2, xa, xb, h, branch=1.0):
    """Joint C for carriage pivot height h; NaN where the bars cannot reach.

    branch +1 puts C on the left of the line A->B (the tube side when the pivot is on the far
    side), -1 on its right. The assembly keeps the branch it is built in at Y = 0 (_branch).
    """
    dx = xb - xa
    d = np.sqrt(dx * dx + h * h)
    along = (l2 * l2 - l1 * l1 + d * d) / (2.0 * d)
    perp_sq = l2 * l2 - along * along
    perp = branch * np.sqrt(np.where(perp_sq >= 0.0, perp_sq, np.nan))
    return xa + (along * dx - perp * h) / d, (along * h + perp * dx) / d


def _pivot_x(p: LinkageParams, inverted=None):
    """Carriage pivot x: +pivot_offset on the far side of the screw axis, -pivot_offset when inverted."""
    inverted = p.pivot_inverted if inverted is None else inverted
    return np.where(inverted, -p.pivot_offset, p.pivot_offset) if isinstance(inverted, np.ndarray) else (-p.pivot_offset if inverted else p.pivot_offset)


def _branch(inverted, xa, xb, h0, cx0, cy0):
    """Side of the line A->B the joint is built on at Y = 0 (+1 left, -1 right), kept over the stroke.

    With the pivot on the far side the closed joint is always on the left (+1, as before the
    inverted pivot existed). With the pivot on the tube's side it can be on either side: the
    closed pose decides. The side also decides the link's load: on the left a link that holds
    the pin is in compression (it pushes), on the right in tension (it pulls); see _forces.
    """
    cross = (xb - xa) * cy0 - h0 * (cx0 - xa)
    return np.where(inverted, np.where(cross < 0.0, -1.0, 1.0), 1.0)


def _closure(p: LinkageParams) -> Tuple[float, float, float]:
    """wall_x, closed gap, full-open gap (all mm)."""
    wall_x = p.tube_center_x + p.tube_od / 2.0
    if tube_law.uses_fem(p):
        fem = tube_law.law(p)
        return wall_x, fem.closed_gap, fem.full_open_gap
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
    if tube_law.uses_fem(p):
        return tube_law.law(p).area(gap)
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


def _chamber_rise_times(t_ms: np.ndarray, p_g: np.ndarray, supply_kpa: float) -> Tuple[Optional[float], Optional[float]]:
    """Interpolated time (ms) from Y = 0 to 50 % and 90 % of supply pressure on the filling half-cycle."""
    if supply_kpa <= 0.0 or len(t_ms) < 2:
        return None, None
    half = max(len(t_ms) // 2, 2)
    t_fill, p_fill = t_ms[:half], p_g[:half]

    def cross(level: float) -> Optional[float]:
        idx = np.flatnonzero(p_fill >= level)
        if not idx.size:
            return None
        i = int(idx[0])
        if i == 0:
            return float(t_fill[0])
        dp = p_fill[i] - p_fill[i - 1]
        frac = (level - p_fill[i - 1]) / dp if dp > 1e-12 else 0.0
        return float(t_fill[i - 1] + frac * (t_fill[i] - t_fill[i - 1]))

    return cross(0.5 * supply_kpa), cross(0.9 * supply_kpa)


def _fast_chamber_t90_ms(
    p: LinkageParams, y_pos: np.ndarray, area_pos: np.ndarray, travel: float,
    volume_ml: Optional[float] = None,
) -> Optional[float]:
    """Fast implicit-Euler estimate of chamber 0 -> 90 % pressurisation time (ms) starting from Y = 0.

    Runs 0 -> travel at the motor's loaded linear speed, then holds at Y = travel for up to 2 s
    if 90 % was not yet reached so short-stroke designs with low flow are timed accurately.
    """
    vol = p.chamber_volume_ml if volume_ml is None else volume_ml
    if vol <= 0.0:
        vol = 50.0   # reference chamber when the chamber plot is disabled
    speed = p.motor_speed * p.speed_factor * p.lead_screw_pitch / 60.0
    if speed <= 0.0:
        speed = 1.0
    if p.input_pressure_kpa <= 0.0 or travel <= 0.0:
        return None
    p_up = P_ATM + p.input_pressure_kpa * 1000.0
    p_target = P_ATM + 0.90 * p.input_pressure_kpa * 1000.0
    k = vol * 1e-6 / (R_AIR * T_AMB)
    t_ramp = travel / speed
    t_hold = 2.0
    n_ramp, n_hold = 80, 40
    t_grid = np.concatenate([
        np.linspace(0.0, t_ramp, n_ramp + 1),
        np.linspace(t_ramp, t_ramp + t_hold, n_hold + 1)[1:],
    ])
    y_grid = np.minimum(t_grid * speed, travel)
    a_in = np.interp(y_grid, y_pos, area_pos)
    if float(a_in.max()) <= 1e-12:
        return None
    pc = P_ATM
    for i in range(1, len(t_grid)):
        ai = float(a_in[i])
        if ai <= 0.0:
            continue
        dt = float(t_grid[i] - t_grid[i - 1])
        prev = pc
        mass = pc * k
        lo, hi = pc, p_up
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            net = _compute_orifice_mass_flow_rate(ai, p_up, mid)
            if mid * k - mass - dt * net > 0.0:
                hi = mid
            else:
                lo = mid
        pc = 0.5 * (lo + hi)
        if pc >= p_target:
            dp = pc - prev
            frac = (p_target - prev) / dp if dp > 1e-12 else 0.0
            return float((t_grid[i - 1] + frac * dt) * 1000.0)
    return None


def _flow_derivatives(
    y_pos: np.ndarray, flow_pos: np.ndarray, q_max: float, y_open: Optional[float],
) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """(slope_mean, slope_max, accel_mean, accel_max) of static flow Q(Y) over Y >= 0.

    Slope is dQ/dY (L/min per mm); accel is d²Q/dY² (L/min per mm²), computed strictly on the
    interior of the rising open region so the corner at Y = y_open and the saturation plateau
    do not inject artificial finite-difference spikes.
    """
    valid = np.isfinite(flow_pos) & np.isfinite(y_pos)
    if valid.sum() < 4 or q_max <= 0.0:
        return None, None, None, None
    yp = y_pos[valid]
    qp = flow_pos[valid]
    if float(qp.max()) <= 1e-12:
        return None, None, None, None
    dq = np.gradient(qp, yp)
    d2q = np.gradient(dq, yp)
    rising = (qp > 0.02 * q_max) & (qp < 0.94 * q_max)
    if not np.any(rising):
        rising = qp > 0.0
    if not np.any(rising):
        return None, None, None, None
    slope_mean = float(np.mean(dq[rising]))
    slope_max = float(np.max(dq[rising]))
    # Interior of rising region: exclude boundary points touching the deadband kink or saturation.
    dy = float(yp[1] - yp[0]) if len(yp) > 1 else 0.0
    interior = rising.copy()
    interior[0] = False
    interior[-1] = False
    interior[1:-1] &= rising[:-2] & rising[2:]
    if y_open is not None and np.isfinite(y_open):
        interior &= yp > y_open + 1.5 * dy
    if np.any(interior):
        accel_mean = float(np.mean(d2q[interior]))
        accel_max = float(np.max(d2q[interior]))
    else:
        accel_mean = None
        accel_max = None
    return slope_mean, slope_max, accel_mean, accel_max


N_FOOT = 161
N_FOOT_FAST = 33

# ─── Assembly clearance between the two linkages ─────────────────
# The two linkages work in parallel planes linkage_plane_spacing apart (CAD X). Each is a slab
# member_thickness thick centred on its plane; in its plane each member is a capsule member_width
# wide around its centre line. Three things can still meet the other linkage (_plane_gaps):
#   "slabs"      the two slabs themselves, when they overlap across the planes: every member of
#                one against every member of the other, in plane;
#   "pivot rod"  the carriage pivot rod, half in the carriage, half in its link's eye: its carriage
#                end points at the other slab; in plane a disc carriage_pin_diameter across;
#   "carriage"   the carriage block, between the planes: in plane a rectangle that moves with the
#                carriage, against both linkages' members.
# Each is checked in plane only when its extent across the planes comes within assembly_clearance
# of the slab it could hit. Its clearance then counts both ways: with a gap g across the planes and
# d in plane (negative where the outlines overlap), the faces are hypot(g, max(d, 0)) apart, or d
# when nothing is left across the planes (g <= 0); see _with_across. The second linkage is the
# first turned half a turn about (0, h0) at -Y.
N_ARC_EXACT = 24    # chords of a curved link in the Explorer's check
N_ARC_SEARCH = 4    # and in the search; both subtract the chords' sag, so they never overstate the clearance
BOX_POSES = 16       # travel steps per box when skipping the pairs of items that stay apart


def _seg_dist(ax, ay, bx, by, cx, cy, dx, dy):
    """Distance between segments A-B and C-D (broadcast arrays); 0 where they cross."""
    ux, uy, vx, vy = bx - ax, by - ay, dx - cx, dy - cy
    lu, lv = ux * ux + uy * uy, vx * vx + vy * vy
    lu, lv = np.where(lu > 0.0, lu, 1.0), np.where(lv > 0.0, lv, 1.0)

    def to_seg_sq(px, py, x1, y1, wx, wy, lw):
        rx, ry = px - x1, py - y1
        t = np.clip((rx * wx + ry * wy) / lw, 0.0, 1.0)
        rx, ry = rx - t * wx, ry - t * wy
        return rx * rx + ry * ry

    d2 = np.minimum(np.minimum(to_seg_sq(ax, ay, cx, cy, vx, vy, lv), to_seg_sq(bx, by, cx, cy, vx, vy, lv)),
                    np.minimum(to_seg_sq(cx, cy, ax, ay, ux, uy, lu), to_seg_sq(dx, dy, ax, ay, ux, uy, lu)))
    o1 = ux * (cy - ay) - uy * (cx - ax)
    o2 = ux * (dy - ay) - uy * (dx - ax)
    o3 = vx * (ay - cy) - vy * (ax - cx)
    o4 = vx * (by - cy) - vy * (bx - cx)
    return np.where((o1 * o2 < 0.0) & (o3 * o4 < 0.0), 0.0, np.sqrt(d2))


def _arc_points(jx, jy, bx, by, l1, alpha, side, n, at=None):
    """n + 1 points of the link from the joint to the carriage pivot: the chord, or the arc of
    half angle alpha bulging to `side` (as _Flexure builds it). Also how far the arc may stray
    from each of the n chords (their sag) and from the whole chord. l1, alpha and side may be per
    design while the poses are many per design: `at` then gives each pose's design."""
    alpha = np.asarray(alpha, dtype=float)
    curved = alpha > 0.0
    a = np.where(curved, alpha, 1.0)
    radius = np.where(curved, l1 / (2.0 * np.sin(a)), 0.0)
    pick = (lambda v: np.asarray(v)[at]) if at is not None else (lambda v: v)
    ux, uy = (bx - jx) / pick(l1), (by - jy) / pick(l1)
    pts = []
    for i in range(n + 1):
        th = a * (2.0 * i / n - 1.0)
        along = pick(np.where(curved, l1 / 2.0 + radius * np.sin(th), l1 * i / n))
        off = pick(np.where(curved, side * radius * (np.cos(th) - np.cos(a)), 0.0))
        pts.append((jx + ux * along - uy * off, jy + uy * along + ux * off))
    sag, whole = (pick(np.where(curved, radius * (1.0 - np.cos(a / k)), 0.0)) for k in (n, 1))
    return pts, sag, whole


def _members(pendulum, xa, jx, jy, tx, ty, bx, by, l1, alpha, side, n_arc, at=None):
    """Centre-line segments (x1, y1, x2, y2) of one linkage, their names, and how far each may sit
    from the member it stands for (the sag of a curved link's chords, 0 for a straight one).
    Last, the link as its single chord and how far the link may stray from that.

    The arm runs from the anchor to the joint (the lever to its pinch point), the pendulum's foot
    from the joint to the pinch point, the link from the joint to the carriage pivot.
    """
    segs = [(xa + 0.0 * jx, 0.0 * jy, jx, jy) if pendulum else (xa + 0.0 * tx, 0.0 * ty, tx, ty)]
    names = ["arm"]
    if pendulum:
        segs.append((jx, jy, tx, ty))
        names.append("foot")
    curved = np.any(np.asarray(alpha) > 0.0)
    pts, sag, whole = _arc_points(jx, jy, bx, by, l1, alpha, side, n_arc if curved else 1, at)
    segs += [(x1, y1, x2, y2) for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:])]
    names += ["link"] * (len(pts) - 1)
    chord = (pts[0][0], pts[0][1], pts[-1][0], pts[-1][1])
    return segs, names, [0.0] * (len(names) - len(pts) + 1) + [sag] * (len(pts) - 1), (chord, whole)


def _turned(segs, h0):
    """The same segments turned half a turn about (0, h0): the other linkage."""
    return [(-x1, 2.0 * h0 - y1, -x2, 2.0 * h0 - y2) for x1, y1, x2, y2 in segs]


def _plane_gaps(p: LinkageParams) -> dict:
    """Gap across the planes (CAD X, mm) between each item that reaches toward the other linkage and
    the slab it could hit; below p.assembly_clearance that item is checked in plane."""
    near = (p.linkage_plane_spacing - p.member_thickness) / 2.0   # each slab's near face, from the mid-plane
    gaps = {"slabs": 2.0 * near, "carriage": near - p.carriage_block_width / 2.0}
    if not (p.compliant and p.linkage_type == TYPE_PENDULUM and p.carriage_clamped) and p.carriage_pin_length > 0:
        # The rod sits half in the carriage from its face: its far end is that far past the mid-plane.
        gaps["pivot rod"] = near + p.carriage_block_width / 2.0 - p.carriage_pin_length / 2.0
    return gaps


def _checks(p: LinkageParams) -> dict:
    """The items of _plane_gaps that come within p.assembly_clearance across the planes, with their gap."""
    return {k: g for k, g in _plane_gaps(p).items() if g < p.assembly_clearance}


def _with_across(d, across):
    """Clearance of two parts d apart in plane (negative: their outlines overlap) and `across` apart
    across the planes: their faces are parallel to the planes, so hypot(across, max(d, 0)) when
    there is a gap across, d when there is none."""
    return np.hypot(across, np.maximum(d, 0.0)) if across > 0.0 else d


def _clearance_flat(p: LinkageParams, checks, seg_a, names, sag_a, seg_b, sag_b, pivot_x, pivot_y, starts, group):
    """Least clearance per pose (flat arrays, poses grouped by `starts` / `group`) over the checks
    asked ({item: gap across the planes}, _checks): linkage A's members seg_a, linkage B's seg_b (already turned),
    carriage pivots at (+-pivot_x, pivot_y). Returns (clearance, label per pose); +inf where no
    item comes near. A pair of items whose boxes over a group stay apart is not measured there."""
    n = np.shape(pivot_y)[0]
    flat = lambda v: np.broadcast_to(np.asarray(v, dtype=float), (n,))
    w = p.member_width / 2.0
    items = {}

    def item(key, segs, half, sags, label):
        prepared = []
        for seg, g, name in zip(segs, sags, label):
            seg = tuple(flat(v) for v in seg)
            box = (np.fmin.reduceat(np.fmin(seg[0], seg[2]), starts), np.fmax.reduceat(np.fmax(seg[0], seg[2]), starts),
                   np.fmin.reduceat(np.fmin(seg[1], seg[3]), starts), np.fmax.reduceat(np.fmax(seg[1], seg[3]), starts))
            prepared.append((seg, flat(g) + half, box, name))
        items[key] = prepared

    item("A", seg_a, w, sag_a, [nm + " A" for nm in names])
    item("B", seg_b, w, sag_b, [nm + " B" for nm in names])
    pairs = []
    if "slabs" in checks:
        pairs.append(("A", "B", checks["slabs"]))
    if "pivot rod" in checks:
        # Each linkage's rod, a disc in plane, against the other linkage's members.
        for sign, mine, other in ((-1.0, "B", "A"), (1.0, "A", "B")):
            rod = (sign * pivot_x + 0.0 * pivot_y, pivot_y, sign * pivot_x + 0.0 * pivot_y, pivot_y)
            item("rod " + mine, [rod], p.carriage_pin_diameter / 2.0, [0.0], ["pivot rod " + mine])
            pairs.append(("rod " + mine, other, checks["pivot rod"]))
    if "carriage" in checks:
        hx, cy, hy = p.carriage_block_length / 2.0, pivot_y + p.carriage_block_offset, p.carriage_block_height / 2.0
        corners = [(-hx, cy - hy), (hx, cy - hy), (hx, cy + hy), (-hx, cy + hy)]
        edges = [(x1 + 0.0 * cy, y1, x2 + 0.0 * cy, y2) for (x1, y1), (x2, y2) in zip(corners, corners[1:] + corners[:1])]
        item("carriage", edges, 0.0, [0.0] * 4, ["carriage"] * 4)
        pairs += [("carriage", "A", checks["carriage"]), ("carriage", "B", checks["carriage"])]
    best, label, labels = np.full(n, np.inf), np.full(n, -1), []
    need = p.assembly_clearance
    for key_x, key_y, across in pairs:
        for sx, gx, bx, nx in items[key_x]:
            for sy, gy, by, ny in items[key_y]:
                apart = np.hypot(np.fmax(np.fmax(by[0] - bx[1], bx[0] - by[1]), 0.0), np.fmax(np.fmax(by[2] - bx[3], bx[2] - by[3]), 0.0))
                margin = gx + gy
                at = np.flatnonzero((~(apart - margin[starts] >= need))[group])
                if not at.size:
                    continue
                d = _with_across(_seg_dist(*(v[at] for v in sx), *(v[at] for v in sy)) - margin[at], across)
                better = ~(d >= best[at])
                labels.append("%s / %s" % (nx.replace("carriage", "carriage block"), ny))
                best[at[better]], label[at[better]] = d[better], len(labels) - 1
    if "carriage" in checks:
        # A member with an end inside the block's outline overlaps it, edges or not.
        for key in ("A", "B"):
            for sy, gy, _, ny in items[key]:
                inside = np.zeros(n, dtype=bool)
                for px, py in ((sy[0], sy[1]), (sy[2], sy[3])):
                    inside |= (np.abs(px) <= hx) & (np.abs(py - cy) <= hy)
                d = np.where(inside, _with_across(-gy, checks["carriage"]), np.inf)
                better = d < best
                if np.any(better):
                    labels.append("carriage block / %s" % ny)
                    best[better], label[better] = d[better], len(labels) - 1
    return best, label, labels


def _clearance_exact(p: LinkageParams, out: "LinkageResult", y, segs, names, sag, xb, pivot_y, h0) -> None:
    """Assembly figures of compute_linkage from linkage A's pose at each Y (segs: arrays over all
    of y). Fills plane_gap(_where), and min_clearance(_y, _where) and collision_y when something
    reaches the other linkage's plane (or the carriage reaches a slab)."""
    gaps = _plane_gaps(p)
    out.plane_gap_where = min(gaps, key=gaps.get)
    out.plane_gap = float(gaps[out.plane_gap_where])
    checks = _checks(p)
    if not checks:
        return
    n = len(y)
    seg_b = _turned([tuple(np.broadcast_to(v, (n,))[::-1] for v in seg) for seg in segs], h0)
    chunk = np.arange(n) // BOX_POSES
    new_group = np.r_[True, chunk[1:] != chunk[:-1]]
    with np.errstate(invalid="ignore"):
        clear, label, labels = _clearance_flat(p, checks, segs, names, sag, seg_b, sag, xb, pivot_y,
                                               np.flatnonzero(new_group), np.cumsum(new_group) - 1)
    if not np.any(np.isfinite(clear)):
        return
    k = int(np.lexsort((np.abs(y), np.where(np.isfinite(clear), clear, np.inf)))[0])   # the least, nearest rest on a tie
    out.min_clearance, out.min_clearance_y = float(clear[k]), float(abs(y[k]))
    out.min_clearance_where = labels[label[k]]
    hit = np.abs(y[clear < p.assembly_clearance - 1e-9])
    out.collision_y = float(hit.min()) if hit.size else None


def _link_curve_mode(p: LinkageParams) -> str:
    """Effective link curve mode for a pendulum ('straight', 'tangent', or 'radius')."""
    if p.linkage_type != TYPE_PENDULUM:
        return "straight"
    if p.link_curve_mode in LINK_CURVE_MODES:
        return p.link_curve_mode
    return "tangent" if p.link_curved else "straight"


def _curve_option_name(p: LinkageParams) -> str:
    """Canonical curve option tag for reporting and deduplication."""
    mode = _link_curve_mode(p)
    if mode == "straight":
        return "straight"
    if mode == "tangent":
        return "tangent_flip" if p.link_curve_flip else "tangent"
    return "radius_out" if p.link_curve_flip else "radius_in"


def _with_curve(p: LinkageParams, mode: str, flip: bool = False, radius: Optional[float] = None) -> LinkageParams:
    """Return a copy of `p` with consistent link curve fields."""
    return replace(
        p,
        link_curved=(mode != "straight"),
        link_curve_mode=mode,
        link_curve_flip=bool(flip),
        link_radius=float(p.link_radius if radius is None else radius),
    )


def _link_arc(p: LinkageParams, l1, cx, cy, bx, by, px, py) -> Tuple[float, float]:
    """Curved link: circular arc from the joint C to the carriage pivot B at the Y = 0 pose
    (pendulum only). Returns (alpha, side): alpha (rad, in (0, pi)) is the angle between the
    chord C->B and the arc's tangent at C, side (+1 / -1) the bulge side about C->B in this frame.

    Modes:
      "straight": straight bar from C to B (alpha = 0).
      "tangent":  arc tangent to the foot line C-P at C. link_curve_flip False continues the foot
                  smoothly past C (-f, G1 continuous with P->C); True leaves along +f (opposite tangent).
      "radius":   minor arc of radius link_radius (clamped to >= l1 / 2, semicircle). link_curve_flip
                  False bulges inward (+1, toward screw / away from tube); True bulges outward (-1, toward tube).

    On pivoted bars the link stays a pin-ended bar of chord l1, so kinematics do not change, while
    the pull T along the chord bends it. In one-piece mode the arc directly shapes the beam stiffness.
    """
    mode = _link_curve_mode(p)
    if mode == "straight" or not np.isfinite(l1) or l1 <= 1e-9:
        return 0.0, 0.0
    if mode == "radius":
        r = float(p.link_radius)
        if not np.isfinite(r) or r <= 0.0:
            return 0.0, 0.0
        ratio = min(float(l1) / (2.0 * r), 1.0)
        alpha = float(np.arcsin(ratio))
        if not np.isfinite(alpha) or alpha < 1e-4:
            return 0.0, 0.0
        return alpha, (-1.0 if p.link_curve_flip else 1.0)
    if p.foot_length <= 0:
        return 0.0, 0.0
    ux, uy = (bx - cx) / l1, (by - cy) / l1
    fx, fy = (px - cx) / p.foot_length, (py - cy) / p.foot_length
    tx, ty = (fx, fy) if p.link_curve_flip else (-fx, -fy)
    dot, cross = ux * tx + uy * ty, ux * ty - uy * tx
    alpha = float(np.arctan2(abs(cross), dot))
    if not np.isfinite(alpha) or alpha < 1e-4 or alpha > np.pi - 1e-2:
        return 0.0, 0.0
    return alpha, float(np.sign(cross))


@lru_cache(maxsize=128)
def _round_pin_force_table(
    tube_od: float, tube_id: float, input_pressure_kpa: float, compliance: float,
    tube_model: str, tube_shore_a: float, pin_diameter: float,
):
    """Cached 1D (gap -> flatten, squeeze, pressure) table for a round pin (pad_length == 0).

    With no flat pad the slice heights depend only on gap and pin_diameter, never on arm tilt,
    so tabulating the 161-slice integral once turns every equilibrium bisection into np.interp.
    """
    p = LinkageParams(
        tube_od=tube_od, tube_id=tube_id, input_pressure_kpa=input_pressure_kpa,
        compliance=compliance, tube_model=tube_model, tube_shore_a=tube_shore_a,
        pin_diameter=pin_diameter, pad_length=0.0,
    )
    wall = tube_od - tube_id
    r = pin_diameter / 2.0
    floor = 0.05 * wall
    g_lo = min(-r - 0.05, floor - 0.05)
    gs = np.unique(np.concatenate([
        np.linspace(g_lo, floor, 80),
        np.linspace(floor, wall, 450),
        np.linspace(wall, tube_od, 450),
        np.array([tube_od + 1e-6]),
    ]))
    zeros = np.zeros_like(gs)
    ones = np.ones_like(gs)
    parts = _pinch_force_slices(p, gs, zeros, ones, N_FOOT)
    return gs, parts[0], parts[1], parts[2]


def _pinch_force_slices(p: LinkageParams, gap: np.ndarray, st: np.ndarray, ct: np.ndarray, n_foot: int = N_FOOT):
    """Direct slice integration along the pin/pad footprint."""
    fem = tube_law.law(p) if tube_law.uses_fem(p) else None
    wall = p.tube_od - p.tube_id
    if fem is None:
        k_wall = 1.0 / p.compliance                       # MPa per mm of squeeze
        e_tube = wall / p.compliance
        t, r_mid = wall / 2.0, (p.tube_id + p.tube_od) / 4.0
        k_ring = e_tube * t ** 3 / (12.0 * 0.1488 * r_mid ** 3)   # N/mm of tube per mm, ring between two plates
        pressure = p.input_pressure_kpa * 1e-3
        w_flat = np.pi / 2.0 * p.tube_id + wall

    n = len(gap)
    out = [np.zeros(n, dtype=float), np.zeros(n, dtype=float), np.zeros(n, dtype=float)]
    active = np.isfinite(gap) & (gap < p.tube_od)
    if not np.any(active):
        return out
    ga, sta, cta = gap[active], st[active], np.maximum(ct[active], 1e-6)
    r = p.pin_diameter / 2.0
    half = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0
    ga_c, st_c, ct_c = ga[:, None], sta[:, None], cta[:, None]
    span = half * ct_c + r
    s = np.linspace(-1.0, 1.0, n_foot)[None, :] * span
    d0 = ga_c + half * st_c + r                          # pad centre to wall
    with np.errstate(invalid="ignore"):
        if half == 0.0:
            h = ga_c + r - np.sqrt(np.maximum(r * r - s * s, 0.0))
        else:
            face = np.where(np.abs(s - r * st_c) <= half * ct_c, d0 + (s - r * st_c) * st_c / ct_c - r * ct_c, np.inf)
            near = d0 - half * st_c - np.sqrt(r * r - (s + half * ct_c) ** 2)
            far = d0 + half * st_c - np.sqrt(r * r - (s - half * ct_c) ** 2)
            h = np.fmin(face, np.fmin(near, far))

    def slices(hv):
        if fem is not None:
            return fem.slices(hv)
        fold = np.clip(p.tube_od - hv, 0.0, p.tube_id)
        squeeze = np.clip(wall - hv, 0.0, 0.95 * wall)
        return (
            k_ring * fold * (1.0 + (fold / p.tube_id) ** 2),
            k_wall * squeeze / (1.0 - squeeze / wall) * w_flat,
            pressure * np.pi / 2.0 * fold - np.minimum(k_wall * squeeze, pressure) * np.pi / 2.0 * p.tube_id * (squeeze > 0.0),
        )

    ds = 2.0 * span[:, 0] / (n_foot - 1)
    parts = [np.nan_to_num(f, nan=0.0).sum(axis=1) * ds for f in slices(h)]
    deepest = slices(ga)
    parts[0] = parts[0] + deepest[0] * p.tube_od / 2.0
    parts[2] = parts[2] + deepest[2] * p.tube_od / 2.0
    for k in range(3):
        out[k][active] = parts[k]
    return out


def _pinch_force(p: LinkageParams, gap: np.ndarray, st: np.ndarray, ct: np.ndarray, n_foot: int = N_FOOT, fast: bool = False):
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

    With tube_model "fem" the per-slice law is the finite-element section (tube_law.FemLaw.slices),
    and only the slicing along the tube axis and the OD / 2 drag-down allowance stay from above:
    the 2D section cannot see the tube bending along its axis beside a narrow pin, so the same
    allowance is kept, on the folding and pressure parts only (that length is folded, not squeezed).
    """
    half = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0
    if fast and half == 0.0 and p.pin_diameter > 0.0:
        uses_fem = tube_law.uses_fem(p)
        gs, f0, f1, f2 = _round_pin_force_table(
            float(p.tube_od), float(p.tube_id), float(p.input_pressure_kpa),
            0.0 if uses_fem else float(p.compliance),
            p.tube_model, float(p.tube_shore_a) if uses_fem else 0.0,
            float(p.pin_diameter),
        )
        return [
            np.interp(gap, gs, f0, left=float(f0[0]), right=0.0),
            np.interp(gap, gs, f1, left=float(f1[0]), right=0.0),
            np.interp(gap, gs, f2, left=float(f2[0]), right=0.0),
        ]
    return _pinch_force_slices(p, gap, st, ct, n_foot=n_foot)


def _solve_contact_flex(p: LinkageParams, g: np.ndarray, st: np.ndarray, ct: np.ndarray, c_safe: np.ndarray, parts0, n_foot: int = N_FOOT, fast: bool = False):
    """Solve flex = c_safe * F(g + flex) only on active unconverged points via safeguarded secant/bisection."""
    pushed = np.zeros_like(g)
    active = np.isfinite(g) & (g < p.tube_od) & (c_safe > 0.0)
    if not np.any(active):
        return pushed, parts0
    ga, sta, cta, ca = g[active], st[active], ct[active], c_safe[active]
    f0 = np.nan_to_num(sum(v[active] for v in parts0))
    lo = np.zeros_like(ga)
    hi = ca * f0
    r_lo = -hi.copy()   # residual at lo = 0 - c*F(g) <= 0
    half = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0
    if not fast and half == 0.0 and p.pin_diameter > 0.0:
        # Warm-start exact solve with the 1D cached table so exact secant converges in ~3 calls to 1e-13.
        x0, _ = _solve_contact_flex(p, ga, sta, cta, ca, parts0=[v[active] for v in parts0], n_foot=n_foot, fast=True)
        w0 = np.maximum(1e-4, 2e-3 * x0)
        cand_lo = np.maximum(0.0, x0 - w0)
        cand_hi = x0 + w0
        r_clo = cand_lo - ca * sum(_pinch_force(p, ga + cand_lo, sta, cta, n_foot=n_foot, fast=False))
        r_chi = cand_hi - ca * sum(_pinch_force(p, ga + cand_hi, sta, cta, n_foot=n_foot, fast=False))
        good_lo = r_clo <= 0.0
        good_hi = r_chi >= 0.0
        lo = np.where(good_lo, cand_lo, lo)
        r_lo = np.where(good_lo, r_clo, r_lo)
        hi = np.where(good_hi, cand_hi, hi)
        r_hi = np.where(good_hi, r_chi, -1.0)
        need_init = ~good_hi
        if np.any(need_init):
            idx = np.flatnonzero(need_init)
            r_hi[idx] = hi[idx] - ca[idx] * sum(_pinch_force(p, ga[idx] + hi[idx], sta[idx], cta[idx], n_foot=n_foot, fast=False))
    else:
        r_hi = hi - ca * sum(_pinch_force(p, ga + hi, sta, cta, n_foot=n_foot, fast=fast))
    for _ in range(8):
        need = r_hi < 0.0
        if not np.any(need):
            break
        hi = np.where(need, 2.0 * hi + 1e-6, hi)
        idx = np.flatnonzero(need)
        f_sub = sum(_pinch_force(p, ga[idx] + hi[idx], sta[idx], cta[idx], n_foot=n_foot, fast=fast))
        r_hi[idx] = hi[idx] - ca[idx] * f_sub

    tol = 1e-8 if fast else 1e-13
    max_it = 44 if fast else 52
    # Safeguarded secant-bisection (only evaluates unconverged points on each step).
    for it in range(max_it):
        still = (hi - lo) > tol
        if not np.any(still):
            break
        idx = np.flatnonzero(still)
        lo_s, hi_s = lo[idx], hi[idx]
        rlo_s, rhi_s = r_lo[idx], r_hi[idx]
        # Every 3rd step force pure bisection to guarantee fast worst-case bracket halving.
        if it % 3 == 2:
            x_s = 0.5 * (lo_s + hi_s)
        else:
            denom = rhi_s - rlo_s
            with np.errstate(invalid="ignore", divide="ignore"):
                sec = lo_s - rlo_s * (hi_s - lo_s) / denom
            margin = 0.05 * (hi_s - lo_s)
            good_sec = np.isfinite(sec) & (sec > lo_s + margin) & (sec < hi_s - margin)
            x_s = np.where(good_sec, sec, 0.5 * (lo_s + hi_s))
        f_s = sum(_pinch_force(p, ga[idx] + x_s, sta[idx], cta[idx], n_foot=n_foot, fast=fast))
        rx = x_s - ca[idx] * f_s
        short = rx < 0.0
        lo[idx] = np.where(short, x_s, lo_s)
        r_lo[idx] = np.where(short, rx, rlo_s)
        hi[idx] = np.where(short, hi_s, x_s)
        r_hi[idx] = np.where(short, rhi_s, rx)

    pushed_a = 0.5 * (lo + hi)
    pushed[active] = pushed_a
    parts_a = _pinch_force(p, ga + pushed_a, sta, cta, n_foot=n_foot, fast=fast)
    parts = [v.copy() for v in parts0]
    for k in range(3):
        parts[k][active] = parts_a[k]
    return pushed, parts


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


def _forces(p: LinkageParams, out: LinkageResult, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap, closed_gap, half, phi, fast: bool = False):
    """Pin forces, screw thrust and bar flex over the stroke; fills the force fields of `out`.

    Returns the pin-to-wall gap once the tube has pushed the pin back (None without forces).

    Statics of the hinged body about its anchor A: the tube pushes the pin away from the
    wall with F, the link (a two-force bar along B-C) holds it with a tension T. The
    second linkage is the first at -Y with its pull on the carriage reversed.
    Friction in the pivots and on the tube is left out.
    """
    fem = tube_law.law(p) if tube_law.uses_fem(p) else None
    if fem is None and p.compliance <= 0:
        out.forces_message = "No forces: they are derived from the tube compliance, which is 0."
        return None
    if p.pin_diameter <= 0 and half == 0.0:
        out.forces_message = "No forces: the pin has no diameter and no pad, so no contact area."
        return None
    if min(p.member_modulus_mpa, p.member_width, p.member_thickness) <= 0:
        out.forces_message = "No forces: the bar section and modulus must be positive."
        return None
    wall = p.tube_od - p.tube_id
    i0 = len(y) // 2
    n_foot = N_FOOT_FAST if fast else N_FOOT
    alpha, side = (0.0, 0.0)
    if ok[i0]:
        alpha, side = _link_arc(p, l1, jx[i0], jy[i0], xb, h0, tx[i0], ty[i0])
    with np.errstate(invalid="ignore", divide="ignore"):
        tilt = np.arctan2(jy, jx - xa) + phi
        st, ct = np.abs(np.sin(tilt)), np.abs(np.cos(tilt))
        g = np.nan_to_num(gap, nan=1e9)
        st0, ct0 = np.nan_to_num(st), np.nan_to_num(ct, nan=1.0)
        parts = _pinch_force(p, g, st0, ct0, n_foot=n_foot, fast=fast)
        force = np.where(ok, sum(parts), np.nan)
        stiff = (sum(_pinch_force(p, g - 0.02, st0, ct0, n_foot=n_foot, fast=fast)) - sum(_pinch_force(p, g + 0.02, st0, ct0, n_foot=n_foot, fast=fast))) / 0.04

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
            # flex = c_all * F(gap + flex).
            c_safe = np.where(np.isfinite(c_all) & ok, c_all, 0.0)
            pushed, parts = _solve_contact_flex(p, g, st0, ct0, c_safe, parts, n_foot=n_foot, fast=fast)
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
    out.tube_modulus_mpa = fem.e_mpa if fem is not None else wall / p.compliance
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
    if fem is not None:
        out.seal_pressure_y0_kpa = float(fem.held_kpa(gap[i0] + flex[i0]))
    else:
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

    def segments(self, y, force):
        """Centre-line segments of the bent part at each Y under the pin force, for the clearance check."""
        travel = self.sgn * y
        segs, names = [], []
        for name, idx in self.lines.items():
            pts = self.xy[idx][:, :, None] + self.u_mm[idx, :2][:, :, None] * travel + self.u_n[idx, :2][:, :, None] * force
            segs += [(pts[k, 0], pts[k, 1], pts[k + 1, 0], pts[k + 1, 1]) for k in range(len(idx) - 1)]
            names += [name] * (len(idx) - 1)
        return segs, names, [0.0] * len(names)

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

    def forces(self, out: LinkageResult, y, gap, closed_gap, fast: bool = False):
        """Pin force, screw thrust and stress in the part over the stroke. Returns the loaded gap."""
        p, sgn, i_p, i_b = self.p, self.sgn, self.i_p, self.i_b
        n_foot = N_FOOT_FAST if fast else N_FOOT
        if fast:
            out.flexure = {"travel_sign": sgn}
        else:
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
        fem = tube_law.law(p) if tube_law.uses_fem(p) else None
        if (fem is None and p.compliance <= 0) or (p.pin_diameter <= 0 and self.half == 0.0):
            out.forces_message = "No pin force: it needs a tube compliance above 0 and a pin diameter or a pad."
            force = np.zeros_like(y)
            pushed = np.zeros_like(y)
            parts = None
        else:
            tilt = self.tilt0 + self.u_mm[i_p, 2] * travel
            st, ct = np.abs(np.sin(tilt)), np.abs(np.cos(tilt))
            parts = _pinch_force(p, gap, st, ct, n_foot=n_foot, fast=fast)
            pushed = np.zeros_like(y)
            if p.contact_deformation:
                # Same balance as the pivoted linkages: the tube pushes the pin back until the
                # part's spring at the pin and the tube agree.
                c_safe = np.full_like(y, max(self.compliance, 0.0))
                pushed, parts = _solve_contact_flex(p, gap, st, ct, c_safe, parts, n_foot=n_foot, fast=fast)
            force = sum(parts)
        loaded = gap + pushed
        self.force = force

        # Pose under load, for the drawing.
        if not fast:
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
        i0 = len(y) // 2
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
            # Signed axial force where the link meets the carriage: + tension (it pulls), - compression.
            e = alpha_link[-1]
            axial_link = (self.s_mm[e, 0] * travel + self.s_n[e, 0] * force)[valid]
            out.max_link_force = float(axial_link[np.argmax(np.abs(axial_link))])
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
            eye_per_n = 1.0 / (d_rod * l_rod / 2.0)
            rod_per_n = 32.0 * (l_rod / 4.0) / (np.pi * d_rod ** 3)
            out.carriage_bearing_mpa = float(out.carriage_load * eye_per_n)
            out.carriage_pin_bending_mpa = float(out.carriage_load * rod_per_n)
            if p.member_strength_mpa > 0:
                over_eye = np.abs(y[valid & (rod_load * eye_per_n > p.member_strength_mpa)])
                out.eye_limit_y = float(over_eye.min()) if over_eye.size else None
            if p.carriage_pin_strength_mpa > 0:
                over_rod = np.abs(y[valid & (rod_load * rod_per_n > p.carriage_pin_strength_mpa)])
                out.rod_limit_y = float(over_rod.min()) if over_rod.size else None
        out.thrust_y0 = float(abs(thrust[i0]))
        out.thrust_needed = float(np.nanmax(np.abs(thrust_out)))
        _screw(p, out, y, thrust_out)
        out.pin_stiffness = float(1.0 / self.compliance) if self.compliance > 0 else None
        if parts is None:
            return None
        out.force_a, out.force_b = _nan_to_none(force_out), _nan_to_none(force_out[::-1])
        out.flex_a, out.flex_b = _nan_to_none(flex_out), _nan_to_none(flex_out[::-1])
        out.tube_modulus_mpa = fem.e_mpa if fem is not None else wall / p.compliance
        out.seal_force = float(force[i0])
        out.seal_force_min = float(sum(_pinch_force(p, np.array([closed_gap]), st[i0:i0 + 1], ct[i0:i0 + 1], n_foot=n_foot))[0])
        out.seal_force_flatten, out.seal_force_squeeze, out.seal_force_pressure = (float(v[i0]) for v in parts)
        out.max_pinch_force = float(np.nanmax(force_out))
        out.max_wall_strain = float(np.clip(wall - np.nanmin(np.where(np.isfinite(force_out), loaded, np.nan)), 0.0, wall) / wall)
        out.flex_y0 = float(pushed[i0])
        if fem is not None:
            out.seal_pressure_y0_kpa = float(fem.held_kpa(loaded[i0]))
        else:
            out.seal_pressure_y0_kpa = float(max((wall - loaded[i0]) / p.compliance, 0.0) * 1000.0)
        out.sealed_after_flex = bool(loaded[i0] <= closed_gap + 1e-12)
        return loaded


def compute_linkage(p: LinkageParams, _fast: bool = False) -> LinkageResult:
    if min(p.bar1_length, p.bar2_length, p.lever_length, p.stroke, p.tube_id) <= 0 or p.tube_od <= p.tube_id:
        return LinkageResult(False, "Lengths, stroke and tube sizes must be positive, with OD > ID.")
    n_samples = N_OPT_SAMPLES if _fast else N_SAMPLES
    l1, l2 = p.bar1_length, p.bar2_length
    side, root, sgn = _layout(p)
    xa, xb = side * p.anchor_distance, _pivot_x(p)
    reach, delta = _body(p, l2, p.lever_length)
    half, phi = _pad(p)
    try:
        wall_x, closed_gap, full_open_gap = _closure(p)
    except tube_law.TubeModelError as e:
        return LinkageResult(False, str(e))
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

    on_top = sgn < 0.0
    # A link built on the right of A->B (it pulls) moves the joint the other way for the same
    # carriage travel: Y keeps meaning "tube A opens", so the carriage runs the other way.
    branch = float(_branch(p.pivot_inverted, xa, xb, h0, cx0, cy0))
    sgn *= branch
    y = np.linspace(-p.stroke, p.stroke, n_samples)
    with np.errstate(invalid="ignore"):
        jx, jy = _joint(l1, l2, xa, xb, h0 + sgn * y, branch)
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
            return LinkageResult(False, flexure.error, anchor_x=xa, anchor_on_top=on_top, link_length=l1, pivot_height_y0=h0,
                                 wall_x=wall_x, closed_gap=closed_gap, full_open_gap=full_open_gap)
        ok = np.ones(n_samples, dtype=bool)
        jx, jy, tx, ty, gap_a = flexure.free_pose(y)
    i0 = n_samples // 2
    lo = hi = i0
    while lo > 0 and ok[lo - 1]:
        lo -= 1
    while hi < n_samples - 1 and ok[hi + 1]:
        hi += 1
    feasible = bool(np.all(ok))
    if not ok[i0]:
        msg = "Linkage cannot be assembled at Y = 0."
    elif hi < n_samples - 1:
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
        joint_x=[] if _fast else _nan_to_none(jx),
        joint_y=[] if _fast else _nan_to_none(jy),
        tip_x=[] if _fast else _nan_to_none(tx),
        tip_y=[] if _fast else _nan_to_none(ty),
        gap_a=_nan_to_none(gap_a),
        gap_b=[] if _fast else _nan_to_none(gap_a[::-1]),
        anchor_x=xa,
        anchor_on_top=on_top,
        pivot_x=xb,
        travel_sign=sgn,
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
        loaded = flexure.forces(out, y, gap_a, closed_gap, fast=_fast)
    else:
        loaded = _forces(p, out, y, ok, l1, xa, xb, h0, sgn, jx, jy, tx, ty, gap_a, closed_gap, half, phi, fast=_fast)
    if flexure is not None:
        segs = flexure.segments(y, flexure.force)
    elif ok[i0]:
        alpha, arc_side = _link_arc(p, l1, jx[i0], jy[i0], xb, h0, tx[i0], ty[i0])
        segs = _members(p.linkage_type == TYPE_PENDULUM, xa, jx, jy, tx, ty, xb, h0 + sgn * y, l1, alpha, arc_side, N_ARC_SEARCH if _fast else N_ARC_EXACT)[:3]
    if flexure is not None or ok[i0]:
        _clearance_exact(p, out, y, *segs, xb, h0 + sgn * y, h0)
    # What the air sees: the gap once the tube has pushed the pin back, when that is solved.
    out.contact_solved = bool(p.contact_deformation and loaded is not None)
    gap_air = np.where(ok, loaded, np.nan) if out.contact_solved else gap_a
    out.gap_loaded_a = _nan_to_none(gap_air)
    out.gap_loaded_b = [] if _fast else _nan_to_none(gap_air[::-1])

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
    out.flow_a = _nan_to_none(flow_a)
    out.flow_b = [] if _fast else _nan_to_none(flow_a[::-1])
    out.flow_target = [] if _fast else _nan_to_none(flow_target)
    out.y_full_open = y_full if np.isfinite(y_full) else None
    out.y_open = y_open if np.isfinite(y_open) else None
    out.response_time_ms = y_full / speed * 1000.0 if np.isfinite(y_full) and speed > 0 else None
    out.max_flow_l_min = q_max
    pos_flows = flow_a[pos]
    max_q_reached = float(np.nanmax(pos_flows)) if np.any(np.isfinite(pos_flows)) else 0.0
    out.max_flow_reached_l_min = max_q_reached
    out.max_flow_reached_pct = (100.0 * max_q_reached / q_max) if q_max > 0.0 else 0.0
    out.flow_slope_mean, out.flow_slope_max, out.flow_accel_mean, out.flow_accel_max = _flow_derivatives(
        y[pos], pos_flows, q_max, out.y_open,
    )
    if feasible and not _fast:
        cycle = _chamber_cycle(p, y, area_a, area_b)
        if cycle is not None:
            t_ms, y_t, q_in, q_out, p_g, v_in, v_out = cycle
            out.time_ms, out.y_time = t_ms.tolist(), y_t.tolist()
            out.flow_in_l_min, out.flow_out_l_min, out.chamber_kpa = q_in.tolist(), q_out.tolist(), p_g.tolist()
            out.volume_in_ml, out.volume_out_ml = v_in, v_out
            out.chamber_t50_ms, out.chamber_t90_ms = _chamber_rise_times(t_ms, p_g, p.input_pressure_kpa)
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
    # No-go zone for the anchor (assembly): designs with avoid_min < anchor < avoid_max are refused.
    # Equal ends mean no zone.
    anchor_avoid_min: float = 0.0
    anchor_avoid_max: float = 0.0
    # Pinch point (pin centre) height from the anchor plane (the top plane) at Y = 0, rigid pose.
    # min 0 and max 0 mean no limit; a max above 0 caps the height.
    pinch_height_min: float = 0.0
    pinch_height_max: float = 0.0
    foot_min: float = 1.0             # mm, pendulum foot; min = max keeps it as it is
    foot_max: float = 6.0
    foot_angle_min: float = 45.0      # deg
    foot_angle_max: float = 135.0
    min_pivot_height: float = 3.0     # mm, carriage pivot above the anchor at Y = 0
    max_pivot_height: float = 16.0    # mm, carriage pivot above the anchor at the top of the stroke
    max_oversqueeze: float = 0.5      # mm, closed tube over the travel used
    objective: str = OBJECTIVE_RESPONSE
    max_stroke: float = 3.0           # mm, longest travel auto-stroke searches may use
    min_flow_pct: float = 0.0         # minimum share of full-bore static flow required (0..95 %)
    pivot_side: str = "normal"        # carriage pivot: "normal" (far side), "inverted" (tube side) or "both"
    # Refuse a design whose closed tube leaks at Y = 0 once the parts flex (sealed_after_flex False).
    # A design with no force figures (no compliance, no pin or pad) has no verdict and is not refused.
    require_seal: bool = True
    # Link curve search (pendulum only): "current" keeps Explorer's shape; "all" compares straight,
    # tangent (both directions), and custom radius (both sides); or restrict to one family.
    link_curve_search: str = "current"
    link_radius_min: float = 5.0      # mm, custom arc radius lower bound when searching radius / all
    link_radius_max: float = 40.0     # mm, custom arc radius upper bound when searching radius / all


def _crossing(y: np.ndarray, gap: np.ndarray, level: float) -> np.ndarray:
    """First y (last axis, linear interpolation) where gap reaches level; inf where it never does."""
    above = gap >= level
    i1 = np.clip(np.argmax(above, axis=-1), 1, None)
    g0 = np.take_along_axis(gap, (i1 - 1)[..., None], axis=-1)[..., 0]
    g1 = np.take_along_axis(gap, i1[..., None], axis=-1)[..., 0]
    yc = y[i1 - 1] + (level - g0) / (g1 - g0) * (y[i1] - y[i1 - 1])
    yc = np.where(above[..., 0], y[0], yc)
    return np.where(np.any(above, axis=-1) & np.isfinite(yc), yc, np.inf)


def _anchor_allowed(s: LinkageSearch, a) -> np.ndarray:
    """False where the anchor falls strictly inside the no-go zone; its two ends are allowed."""
    lo, hi = sorted((s.anchor_avoid_min, s.anchor_avoid_max))
    a = np.asarray(a, dtype=float)
    return np.ones_like(a, dtype=bool) if hi <= lo else ~((a > lo) & (a < hi))


def _arc_angle(p: LinkageParams, l1, cx, cy, bx, by, px, py, foot, link_radius=None):
    """_link_arc for arrays of designs: the curved link's half angle and bulge side (0 when straight)."""
    mode = _link_curve_mode(p)
    l1 = np.asarray(l1, dtype=float)
    if mode == "straight":
        return np.zeros_like(l1), np.zeros_like(l1)
    if mode == "radius":
        r = np.asarray(p.link_radius if link_radius is None else link_radius, dtype=float)
        valid_r = np.isfinite(r) & (r > 0.0) & np.isfinite(l1) & (l1 > 1e-9)
        r_safe = np.where(valid_r, r, 1.0)
        ratio = np.clip(l1 / (2.0 * r_safe), 0.0, 1.0)
        alpha = np.arcsin(ratio)
        good = valid_r & np.isfinite(alpha) & (alpha >= 1e-4)
        side = -1.0 if p.link_curve_flip else 1.0
        return np.where(good, alpha, 0.0), np.where(good, side, 0.0)
    ux, uy = (bx - cx) / l1, (by - cy) / l1
    fx, fy = (px - cx) / foot, (py - cy) / foot
    tx, ty = (fx, fy) if p.link_curve_flip else (-fx, -fy)
    dot, cross = ux * tx + uy * ty, ux * ty - uy * tx
    alpha = np.arctan2(np.abs(cross), dot)
    good = np.isfinite(alpha) & (alpha >= 1e-4) & (alpha <= np.pi - 1e-2) & (foot > 0)
    return np.where(good, alpha, 0.0), np.where(good, np.sign(cross), 0.0)


def _objective_score(objective: str, flow_frac, y_open, y_full, travel, slope_norm, accel_norm, t90_ms=None):
    """Unified scalar or vectorized score for auto-stroke objectives (lower is better).

    flow_frac: share of full-open flow reached in (0, 1] (normalized so reaching full_open_gap = 1).
    y_open: mm of travel to first flow (half dead band).
    slope_norm: mean d(Q/Q_max)/dY (1/mm) over the rising open region.
    accel_norm: mean d²(Q/Q_max)/dY² (1/mm²) over the interior rising region.
    t90_ms: chamber 0 -> 90 % pressurisation time in ms (None during vectorized rigid pre-screening).
    """
    eff_rise = np.minimum(1.0 / np.maximum(slope_norm, 0.05), 20.0)
    travel_term = np.where(np.isfinite(y_full), y_full, travel)
    if objective == OBJECTIVE_DEADBAND:
        shortfall = np.maximum(0.35 - flow_frac, 0.0)
        return 8.0 * y_open + 0.8 * eff_rise + 12.0 * shortfall + 0.5 * (1.0 - flow_frac)
    if objective == OBJECTIVE_CHAMBER:
        if t90_ms is not None:
            if np.isfinite(t90_ms):
                return float(t90_ms) / 1000.0 + 0.05 * float(y_open)
            return 100.0 + 10.0 * (1.0 - float(flow_frac)) + float(y_open)
        return 4.0 * y_open + 1.2 * eff_rise + 2.5 * (1.0 - flow_frac) + 0.2 * travel_term
    if objective == OBJECTIVE_PROGRESSIVE:
        accel_term = np.clip(accel_norm, -5.0, 12.0)
        return 3.0 * y_open - 0.8 * accel_term + 2.5 * (1.0 - flow_frac) + 0.4 * eff_rise
    # OBJECTIVE_RESPONSE: fast balanced valve — mini deadband, steep flow rise, high flow, short travel.
    return 3.0 * y_open + 1.0 * eff_rise + 3.0 * (1.0 - flow_frac) + 0.25 * travel_term


def _clearance_search(p: LinkageParams, checks, measure, xa, xb, l1, h0, sgn, y, pose_a, pose_b, alpha, side) -> np.ndarray:
    """Clearance per design (rows) and per Y >= 0 (columns) where `measure` is True, over
    the checks _plane_gaps asks for; +inf elsewhere. pose_a: linkage A's (joint x, y, pinch x, y)
    at +Y; pose_b the same at -Y, which turned half a turn about (0, h0) is linkage B at +Y.
    A curved link is N_ARC_SEARCH chords less their sag."""
    out = np.full(pose_a[0].shape, np.inf)
    rows, cols = np.nonzero(measure)          # row-major: each design's poses are contiguous
    if rows.size == 0 or not checks:
        return out
    pend = p.linkage_type == TYPE_PENDULUM
    flat = rows * len(y) + cols
    yy, h, sg = y[cols], h0[rows], sgn[rows]
    xa_, l1_ = (np.broadcast_to(v, measure.shape[:1]) for v in (xa, l1))
    chunk = rows * len(y) + cols // BOX_POSES
    new_group = np.r_[True, chunk[1:] != chunk[:-1]]
    n_arc = max(N_ARC_SEARCH, 8) if np.any(np.asarray(alpha) > np.pi / 2.0) else N_ARC_SEARCH
    seg_a, names, sag, _ = _members(pend, xa_[rows], *(np.take(v, flat) for v in pose_a), xb, h + sg * yy, l1_, alpha, side, n_arc, rows)
    seg_b, _, _, _ = _members(pend, xa_[rows], *(np.take(v, flat) for v in pose_b), xb, h - sg * yy, l1_, alpha, side, n_arc, rows)
    clear, _, _ = _clearance_flat(p, checks, seg_a, names, sag, _turned(seg_b, h), sag, xb, h + sg * yy,
                                  np.flatnonzero(new_group), np.cumsum(new_group) - 1)
    out[rows, cols] = clear
    return out


def _score(p: LinkageParams, s: LinkageSearch, l1, l2, a, lever_length, foot=None, foot_angle_deg=None, stats=None, link_radius=None) -> np.ndarray:
    """Score for arrays of candidates (one per row), lower is better; inf where infeasible.

    "target": RMS distance of the opening from (Y / stroke) ** exponent over the stroke.
    Auto-stroke objectives ("response", "deadband", "chamber", "progressive"): the carriage may
    travel until the closed tube is squeezed past the limit, the bars lock, the two linkages
    come closer than p.assembly_clearance, or max_stroke. Scored on actual tube flow (FEM or
    simple), dead band, flow slope dQ/dY and acceleration d²Q/dY².
    stats (dict, optional): stats["collision"] counts the designs feasible but for the clearance.
    """
    if p.linkage_type == TYPE_PENDULUM and foot is not None:
        p = replace(p, foot_length=foot, foot_angle_deg=foot_angle_deg)
    wall_x, closed_gap, full_open_gap = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)
    side, root, sgn = _layout(p)
    xa, xb = side * a, _pivot_x(p)
    reach, delta = _body(p, l2, lever_length)
    delta_ = delta[..., None] if isinstance(delta, np.ndarray) else delta
    auto_stroke = _is_auto_stroke(s.objective)
    bore_area = float(np.pi * (p.tube_id / 2.0) ** 2)
    full_ref = tube_law.FULL_OPEN_FRACTION if tube_law.uses_fem(p) else 1.0
    with np.errstate(invalid="ignore", divide="ignore"):
        half, phi = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0, np.radians(p.foot_angle_deg)
        phi_ = phi[..., None] if isinstance(phi, np.ndarray) else phi
        cx0, cy0 = _closed_joint(l2, reach, delta, half, phi, xa, x_closed)
        if p.fixed_height > 0:
            h0 = np.full_like(l2, p.fixed_height / 2.0)
            l1 = np.hypot(xb - cx0, h0 - cy0)
        else:
            h0 = _pivot_height_y0(l1, root, xb, cx0, cy0)
        branch = _branch(p.pivot_inverted, xa, xb, h0, cx0, cy0)
        sgn = sgn * branch      # the carriage runs the way that opens tube A (see compute_linkage)
        y = np.linspace(0.0, s.max_stroke, N_RESPONSE) if auto_stroke else np.linspace(0.0, p.stroke, N_SCORE)
        ratio = (reach / l2)[..., None]
        xa_ = xa[..., None]
        # Tube A opening over the travel; the same linkage at -Y is what the closed tube sees.
        jx, jy = _joint(l1[..., None], l2[..., None], xa_, xb, h0[..., None] + sgn[..., None] * y, branch[..., None])
        cx, cy = _joint(l1[..., None], l2[..., None], xa_, xb, h0[..., None] - sgn[..., None] * y, branch[..., None])
        tip_x, tip_y = _tip(xa_, jx, jy, ratio, delta_)
        ctip_x, ctip_y = _tip(xa_, cx, cy, ratio, delta_)
        gap = wall_x + tip_x - _pad_reach(xa_, jx, jy, half, phi_) - r_pin
        pinch_height = tip_y[..., 0]   # Y = 0 is the first sample of the sweep
        squeeze = closed_gap - (wall_x + ctip_x - _pad_reach(xa_, cx, cy, half, phi_) - r_pin)
        pose_ok = np.isfinite(jx) & (jy >= 0.0) & np.isfinite(cx) & (cy >= 0.0)
        # What does not depend on the travel.
        row_ok = ((reach >= l2) | (p.linkage_type != TYPE_LEVER)) & _anchor_allowed(s, a)
        row_ok &= pinch_height >= s.pinch_height_min
        if s.pinch_height_max > 0:
            row_ok &= pinch_height <= s.pinch_height_max
        if p.fixed_height > 0:
            row_ok &= (l1 >= min(s.bar1_min, s.bar1_max)) & (l1 <= max(s.bar1_min, s.bar1_max))
        else:
            row_ok &= h0 >= s.min_pivot_height
        if _link_curve_mode(p) != "straight" and p.linkage_type == TYPE_PENDULUM:
            alpha, arc_side = _arc_angle(p, l1, cx0, cy0, xb, h0, *_tip(xa, cx0, cy0, reach / l2, delta), p.foot_length, link_radius)
        else:
            alpha, arc_side = np.zeros_like(l2), np.zeros_like(l2)

        checks = _checks(p)

        def clearance(measure):
            return _clearance_search(p, checks, measure, xa, xb, l1, h0, sgn, y, (jx, jy, tip_x, tip_y), (cx, cy, ctip_x, ctip_y), alpha, arc_side)

        if auto_stroke:
            # Travel the design can use: up to the first pose that locks, crushes the closed tube
            # or brings the two linkages closer than the clearance.
            base = pose_ok & (squeeze <= s.max_oversqueeze) & (h0[..., None] > y)
            if p.fixed_height <= 0:
                base &= h0[..., None] + y <= s.max_pivot_height
            # The clearance only matters where the travel may still go: within the poses that hold
            # and up to full bore plus the 0.05 mm look-ahead below; past that the score is the same.
            step = y[1] - y[0]
            ahead = min(int(np.ceil(0.05 / step - 1e-9)), N_RESPONSE - 1)
            reach_full = np.logical_or.accumulate(gap >= full_open_gap, axis=-1)
            past_full = np.concatenate([np.zeros_like(reach_full[..., :ahead + 1]), reach_full[..., :-ahead - 1]], axis=-1)
            measure = np.logical_and.accumulate(base, axis=-1) & ~past_full & row_ok[..., None]
            clear_ok = clearance(measure) >= p.assembly_clearance

            def travel_score(clear_ok):
                usable = np.logical_and.accumulate(base & clear_ok, axis=-1)
                # Credit a travel only if the design is still fine 0.05 mm further (the stroke is
                # rounded up to that) and the bars are still 0.2 mm short of locking: a design
                # that works right at dead centre does not survive a real assembly.
                dy = y[1] - y[0]
                for ahead_mm, good in ((0.05, usable), (0.2, np.logical_and.accumulate(pose_ok, axis=-1))):
                    k = min(int(np.ceil(ahead_mm / dy - 1e-9)), N_RESPONSE - 1)
                    usable = usable & np.concatenate([good[..., k:], np.repeat(good[..., -1:], k, axis=-1)], axis=-1)
                active_rows = usable[..., 0] & row_ok
                score = np.full(active_rows.shape, np.inf, dtype=float)
                ok_rows = np.zeros(active_rows.shape, dtype=bool)
                if not np.any(active_rows):
                    return score, ok_rows
                u_act = usable[active_rows]
                g_act = gap[active_rows]
                seen = np.where(u_act, g_act, -np.inf)
                area_act = np.where(u_act, _area_mm2(p, np.where(u_act, g_act, 0.0), closed_gap), 0.0)
                q_frac = area_act / bore_area
                q_peak = np.max(q_frac, axis=-1)
                flow_frac = np.minimum(q_peak / full_ref, 1.0)
                flow_pct = q_peak * 100.0
                y_open = np.minimum(_crossing(y, seen, closed_gap), s.max_stroke)
                y_full = _crossing(y, seen, full_open_gap)
                travel = np.where(np.isfinite(y_full), y_full, y[np.sum(u_act, axis=-1) - 1])
                # Vectorized d(Q/Q_max)/dY and interior d²(Q/Q_max)/dY² over the rising open region.
                dq = np.gradient(q_frac, dy, axis=-1)
                d2q = np.gradient(dq, dy, axis=-1)
                rising = u_act & (q_frac > 0.02) & (q_frac < 0.94)
                has_r = np.any(rising, axis=-1)
                rising2 = np.where(has_r[..., None], rising, u_act & (q_frac > 0.0))
                slope_norm = np.sum(np.where(rising2, dq, 0.0), axis=-1) / np.maximum(np.sum(rising2, axis=-1), 1)
                interior = np.zeros_like(rising2)
                interior[..., 1:-1] = rising2[..., 1:-1] & rising2[..., :-2] & rising2[..., 2:]
                i_cnt = np.sum(interior, axis=-1)
                accel_norm = np.where(i_cnt > 0, np.sum(np.where(interior, d2q, 0.0), axis=-1) / np.maximum(i_cnt, 1), 0.0)
                sc_act = _objective_score(s.objective, flow_frac, y_open, y_full, travel, slope_norm, accel_norm)
                ok_act = (flow_frac > 0.0) & (flow_pct >= s.min_flow_pct - 1e-9) & np.isfinite(sc_act)
                score[active_rows] = sc_act
                ok_rows[active_rows] = ok_act
                return score, ok_rows

            score, ok = travel_score(clear_ok)
            if stats is not None and checks:
                stats["collision"] = stats.get("collision", 0) + int(np.sum(travel_score(True)[1] & ~ok))
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
            ok &= np.isfinite(score) & row_ok
            clear_ok = np.all(clearance(np.broadcast_to(ok[..., None], gap.shape)) >= p.assembly_clearance, axis=-1)
            if stats is not None:
                stats["collision"] = stats.get("collision", 0) + int(np.sum(ok & ~clear_ok))
            ok &= clear_ok
    return np.where(ok, score, np.inf)


N_FIRST = 30000   # candidates drawn over the whole ranges
N_ROUND = 12000   # candidates per refinement round
N_ELITE = 24
# One-piece pendulum: designs go directly through the beam model. The first batch mixes the best
# distinct rigid designs, random rigid-feasible designs and fresh geometrically valid one-piece
# designs (since a flexing part can work well where rigid bars would lock or over-squeeze).
# Rounds of tighter draws around the best overall and Pareto-extreme designs follow.
N_SHORTLIST = 140
# Near-duplicates share a cell. The rigid share takes the best design of each coarse cell (a quarter
# of every searched range) first, for spread, then fills up with the best of each fine cell (1/25).
SHORTLIST_CELLS = (4, 25)
N_ONE_PIECE_ROUND = 45                          # beam solves per round around the best designs that hold
ONE_PIECE_ROUNDS = (0.18, 0.10, 0.05, 0.025)    # spread of each round, as a share of each searched range
ONE_PIECE_LIMITS = ("stress", "thrust", "eye", "rod", "no_flow", "collision", "seal")
MAX_PARETO_CANDIDATES = 10


def _crushed(r: LinkageResult, s: LinkageSearch, gap) -> np.ndarray:
    """|Y| where the closed tube is squeezed past max_oversqueeze, reading this pin-to-wall gap."""
    y, gap = np.array(r.Y_positions), np.array([np.nan if g is None else g for g in gap], dtype=float)
    return np.abs(y[np.isfinite(gap) & (r.closed_gap - gap > s.max_oversqueeze)])


def _stroke_used(r: LinkageResult, s: LinkageSearch, caps=(), gap=None) -> float:
    """Travel an auto-stroke design uses: full bore rounded up to 0.05 mm when that fits under
    max_stroke, every cap, the bars' reach both ways and the closed tube's squeeze, else as far
    as those allow (squeeze read on `gap`, default the bars' own gap_a), rounded down to 0.05 mm
    (can come out below 0.05)."""
    crushed = _crushed(r, s, r.gap_a if gap is None else gap)
    limit = min([s.max_stroke, r.y_max, -r.y_min] + ([float(crushed.min())] if crushed.size else []) + list(caps))
    if r.y_full_open is not None:
        full = min(s.max_stroke, round(float(np.ceil(r.y_full_open / 0.05 - 1e-9)) * 0.05, 2))
        if full <= limit + 1e-9:
            return full
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


def _one_piece_eval(q: LinkageParams, s: LinkageSearch, fast: bool = False):
    """Beam-model evaluation of a one-piece design. Returns (score, travel, reason, meta).

    In auto-stroke objectives ("response", "deadband", "chamber", "progressive"), usable travel is
    capped by EVERY active limit — including part stress, motor thrust, eye bearing and rod bending —
    so a high-gain, low-deadband design that hits the stress limit at 0.65 mm is scored at 0.65 mm
    instead of being thrown out for overstressing at max_stroke.
    """
    r = compute_linkage(q, _fast=fast)
    if not r.feasible or r.flexure is None:
        return np.inf, 0.0, "no_flow", None
    if s.require_seal and r.sealed_after_flex is False:
        return np.inf, 0.0, "seal", None
    crushed = _crushed(r, s, r.gap_loaded_a)
    if not _is_auto_stroke(s.objective):
        if r.rms_error is None or r.jam_y is not None or crushed.size > 0:
            return np.inf, q.stroke, "no_flow", None
        if r.collision_y is not None:
            return np.inf, q.stroke, "collision", None
        broken = _one_piece_limit(q, r, q.stroke)
        if broken:
            return np.inf, q.stroke, broken, None
        meta = {"limiting_factor": "max_stroke", "y_open": r.y_open, "flow_pct": r.max_flow_reached_pct, "t90_ms": r.chamber_t90_ms}
        return r.rms_error, q.stroke, None, meta

    if r.collision_y is not None and r.collision_y < 0.05 - 1e-9:
        return np.inf, 0.0, "collision", None

    # Collect every active ceiling on travel with its cause so high-gain designs can stop cleanly
    # before exceeding stress, thrust, eye/rod strength, clearance, oversqueeze or jam.
    caps_named: List[Tuple[float, str]] = [
        (s.max_stroke, "max_stroke"),
        (r.pivot_height_y0 - 1e-6, "height"),
    ]
    if q.fixed_height <= 0:
        caps_named.append((s.max_pivot_height - r.pivot_height_y0, "height"))
    if r.jam_y is not None:
        caps_named.append((r.jam_y - 1e-6, "jam"))
    if crushed.size:
        caps_named.append((float(crushed.min()) - 1e-6, "oversqueeze"))
    if r.collision_y is not None:
        caps_named.append((r.collision_y - 1e-6, "collision"))
    if q.member_strength_mpa > 0 and r.stress_limit_y is not None:
        caps_named.append((r.stress_limit_y - 1e-6, "stress"))
    if r.thrust_available is not None and r.thrust_available > 0 and r.stall_y is not None:
        caps_named.append((r.stall_y - 1e-6, "thrust"))
    if r.eye_limit_y is not None:
        caps_named.append((r.eye_limit_y - 1e-6, "eye"))
    if r.rod_limit_y is not None:
        caps_named.append((r.rod_limit_y - 1e-6, "rod"))

    cap_y, cap_reason = min(caps_named, key=lambda t: t[0])
    travel = _stroke_used(r, s, [cap_y], r.gap_loaded_a)
    if r.y_full_open is not None and round(float(np.ceil(r.y_full_open / 0.05 - 1e-9)) * 0.05, 2) <= cap_y + 1e-9:
        limiting = "full_open"
    else:
        limiting = cap_reason

    if travel < 0.05 - 1e-9:
        fail = cap_reason if cap_reason in ONE_PIECE_LIMITS else "no_flow"
        return np.inf, travel, fail, None

    broken = _one_piece_limit(q, r, travel)
    if broken:
        return np.inf, travel, broken, None

    y = np.array(r.Y_positions)
    pos = y >= 0.0
    yp = y[pos]
    gap = np.array([np.nan if g is None else g for g in r.gap_loaded_a], dtype=float)[pos]
    flow_arr = np.array([0.0 if f is None else f for f in r.flow_a], dtype=float)[pos]
    in_tr = yp <= travel + 1e-9
    seen_gap = np.where(in_tr & np.isfinite(gap), gap, -np.inf)
    seen_flow = flow_arr[in_tr]
    q_max = r.max_flow_l_min
    if q_max <= 0.0 or seen_flow.size == 0:
        return np.inf, travel, "no_flow", None
    max_q = float(seen_flow.max())
    flow_pct = 100.0 * max_q / q_max
    if max_q <= 0.0 or flow_pct < s.min_flow_pct - 1e-9:
        fail = cap_reason if cap_reason in ONE_PIECE_LIMITS else "no_flow"
        return np.inf, travel, fail, None
    full_ref = tube_law.FULL_OPEN_FRACTION if tube_law.uses_fem(q) else 1.0
    flow_frac = min(max_q / (full_ref * q_max), 1.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        y_open = min(float(_crossing(yp, seen_gap[None, :], r.closed_gap)[0]), travel)
        y_full = float(_crossing(yp, seen_gap[None, :], r.full_open_gap)[0])
    slope_mean, _, accel_mean, _ = _flow_derivatives(yp[in_tr], seen_flow, q_max, y_open)
    slope_norm = (slope_mean / q_max) if (slope_mean is not None and q_max > 0) else 0.0
    accel_norm = (accel_mean / q_max) if (accel_mean is not None and q_max > 0) else 0.0
    t90_ms = None
    if s.objective == OBJECTIVE_CHAMBER:
        area_pos = _area_mm2(q, np.nan_to_num(gap, nan=0.0), r.closed_gap)
        t90_ms = _fast_chamber_t90_ms(q, yp, area_pos, travel)
    score = float(_objective_score(s.objective, flow_frac, y_open, y_full, travel, slope_norm, accel_norm, t90_ms))
    stress_in = np.array([0.0 if v is None else v for v in r.stress_a], dtype=float)
    peak_s = float(np.nanmax(stress_in[np.abs(y) <= travel + 1e-9])) if stress_in.size else 0.0
    stress_margin = (q.member_strength_mpa / peak_s) if (peak_s > 1e-9 and q.member_strength_mpa > 0) else None
    meta = {
        "limiting_factor": limiting,
        "y_open": y_open,
        "flow_pct": flow_pct,
        "slope_mean": slope_mean,
        "accel_mean": accel_mean,
        "t90_ms": t90_ms,
        "stress_margin": stress_margin,
    }
    return score, travel, None, meta


def _one_piece_score(q: LinkageParams, s: LinkageSearch):
    """Beam-model score of a one-piece design. Returns (score, travel, reason)."""
    score, travel, reason, _ = _one_piece_eval(q, s, fast=False)
    return score, travel, reason


def _one_piece_geom_ok(p: LinkageParams, s: LinkageSearch, names: List[str], x: np.ndarray) -> np.ndarray:
    """Fast geometric rest-pose check for one-piece candidates (independent of rigid bar locking/oversqueeze)."""
    if len(x) == 0:
        return np.zeros(0, dtype=bool)
    col = dict(zip(names, x.T))
    l1, l2, a = col["bar1_length"], col["bar2_length"], col["anchor_distance"]
    foot = col.get("foot_length", p.foot_length)
    ang = col.get("foot_angle_deg", p.foot_angle_deg)
    q = replace(p, foot_length=foot, foot_angle_deg=ang) if p.linkage_type == TYPE_PENDULUM else p
    wall_x, closed_gap, _ = _closure(p)
    r_pin = p.pin_diameter / 2.0
    x_closed = -(wall_x - (closed_gap - p.preload) - r_pin)
    side, root, _ = _layout(p)
    xa, xb = side * a, _pivot_x(p)
    reach, delta = _body(q, l2, col.get("lever_length", p.lever_length))
    half = p.pad_length / 2.0 if p.linkage_type == TYPE_PENDULUM else 0.0
    phi = np.radians(ang)
    with np.errstate(invalid="ignore", divide="ignore"):
        cx0, cy0 = _closed_joint(l2, reach, delta, half, phi, xa, x_closed)
        if p.fixed_height > 0:
            h0 = np.full_like(l2, p.fixed_height / 2.0)
            l1_use = np.hypot(xb - cx0, h0 - cy0)
        else:
            l1_use = l1
            h0 = _pivot_height_y0(l1, root, xb, cx0, cy0)
        _, tip_y = _tip(xa, cx0, cy0, reach / l2, delta)
    ok = np.isfinite(cx0) & np.isfinite(cy0) & (cy0 >= 0.0) & np.isfinite(h0) & (h0 > 0.05) & np.isfinite(l1_use)
    ok &= _anchor_allowed(s, a) & (tip_y >= s.pinch_height_min)
    if s.pinch_height_max > 0:
        ok &= tip_y <= s.pinch_height_max
    if p.fixed_height > 0:
        ok &= (l1_use >= min(s.bar1_min, s.bar1_max)) & (l1_use <= max(s.bar1_min, s.bar1_max))
    else:
        ok &= (h0 >= s.min_pivot_height) & (h0 <= s.max_pivot_height)
    return ok


def _candidate_record(out: LinkageParams, r: LinkageResult, score: float, limiting_factor: str) -> dict:
    """Compact summary of a verified design for the Pareto candidates table."""
    t90 = r.chamber_t90_ms
    if t90 is None and r.feasible and r.Y_positions:
        y = np.array(r.Y_positions)
        pos = y >= 0.0
        gap = np.array([np.nan if g is None else g for g in r.gap_loaded_a], dtype=float)[pos]
        area_pos = _area_mm2(out, np.nan_to_num(gap, nan=0.0), r.closed_gap)
        t90 = _fast_chamber_t90_ms(out, y[pos], area_pos, out.stroke)
    return {
        "params": asdict(out),
        "score": round(float(score), 4),
        "pivot_side": _side_name(out),
        "link_curve": _curve_option_name(out) if out.linkage_type == TYPE_PENDULUM else None,
        "limiting_factor": limiting_factor,
        "tags": [],
        "metrics": {
            "stroke": out.stroke,
            "y_open": r.y_open,
            "deadband": (2.0 * r.y_open) if r.y_open is not None else None,
            "y_full_open": r.y_full_open,
            "response_time_ms": r.response_time_ms,
            "chamber_t50_ms": r.chamber_t50_ms,
            "chamber_t90_ms": t90,
            "max_flow_l_min": r.max_flow_l_min,
            "max_flow_reached_l_min": r.max_flow_reached_l_min,
            "max_flow_reached_pct": r.max_flow_reached_pct,
            "flow_slope_mean": r.flow_slope_mean,
            "flow_slope_max": r.flow_slope_max,
            "flow_accel_mean": r.flow_accel_mean,
            "max_stress_mpa": r.max_stress_mpa,
            "stress_margin": r.stress_margin,
            "thrust_needed": r.thrust_needed,
            "motor_margin": r.motor_margin,
            "seal_pressure_y0_kpa": r.seal_pressure_y0_kpa,
            "sealed_after_flex": r.sealed_after_flex,
            "max_oversqueeze": r.max_oversqueeze,
            "min_clearance": r.min_clearance,
            "max_rotation_deg": r.max_rotation_deg,
            "rms_error": r.rms_error,
            "link_arc_radius": r.link_arc_radius,
            "link_arc_half_angle_deg": r.link_arc_half_angle_deg,
        },
    }


def _curate_candidates(records: List[dict], max_count: int = MAX_PARETO_CANDIDATES) -> List[dict]:
    """Select up to max_count diverse, Pareto-interesting designs, always keeping best overall first."""
    if not records:
        return []
    ordered = sorted(records, key=lambda c: c["score"])
    # Deduplicate near-identical designs (same side, same curve family, and close geometry OR tradeoff metrics).
    unique: List[dict] = []
    for rec in ordered:
        p = rec["params"]
        m = rec["metrics"]
        dup = False
        for kept in unique:
            kp = kept["params"]
            km = kept["metrics"]
            if rec["pivot_side"] != kept["pivot_side"] or rec.get("link_curve") != kept.get("link_curve"):
                continue
            rad_close = True
            if rec.get("link_curve") in ("radius_in", "radius_out"):
                r1, r2 = float(p.get("link_radius", 0.0)), float(kp.get("link_radius", 0.0))
                rad_close = abs(r1 - r2) < max(0.6, 0.12 * max(r1, r2))
            geom_close = (
                rad_close
                and abs(p["bar2_length"] - kp["bar2_length"]) < 0.25
                and abs(p["anchor_distance"] - kp["anchor_distance"]) < 0.25
                and abs(p["foot_length"] - kp["foot_length"]) < 0.2
                and abs(p["foot_angle_deg"] - kp["foot_angle_deg"]) < 2.0
                and abs(p["bar1_length"] - kp["bar1_length"]) < 0.25
                and abs(p["stroke"] - kp["stroke"]) < 0.08
            )
            metric_close = (
                rad_close
                and m["deadband"] is not None and km["deadband"] is not None
                and abs(m["deadband"] - km["deadband"]) < 0.008
                and abs((m["max_flow_reached_pct"] or 0.0) - (km["max_flow_reached_pct"] or 0.0)) < 2.0
                and abs(p["stroke"] - kp["stroke"]) < 0.06
                and abs((m["max_stress_mpa"] or 0.0) - (km["max_stress_mpa"] or 0.0)) < 2.0
            )
            if geom_close or metric_close:
                dup = True
                break
        if not dup:
            unique.append({**rec, "tags": []})

    if not unique:
        return []
    best_flow = max((c["metrics"]["max_flow_reached_pct"] or 0.0) for c in unique)
    viable = [c for c in unique if (c["metrics"]["max_flow_reached_pct"] or 0.0) >= max(0.45 * best_flow, 10.0)] or unique

    picked_idx: List[int] = []
    tags_by_idx: Dict[int, List[str]] = {}

    def mark(idx: int, tag: str) -> None:
        if idx not in picked_idx:
            picked_idx.append(idx)
        tags_by_idx.setdefault(idx, [])
        if tag not in tags_by_idx[idx]:
            tags_by_idx[idx].append(tag)

    # #0 is always the winner by active objective.
    mark(0, "Best overall")

    # Smallest deadband among designs with viable flow.
    db_cands = [(i, c["metrics"]["deadband"]) for i, c in enumerate(unique) if c in viable and c["metrics"]["deadband"] is not None]
    if db_cands:
        mark(min(db_cands, key=lambda t: (t[1], unique[t[0]]["score"]))[0], "Min deadband")

    # Fastest chamber 0->90 % rise time.
    t90_cands = [(i, c["metrics"]["chamber_t90_ms"]) for i, c in enumerate(unique) if c["metrics"]["chamber_t90_ms"] is not None]
    if t90_cands:
        mark(min(t90_cands, key=lambda t: (t[1], unique[t[0]]["score"]))[0], "Fastest chamber")

    # Highest max flow reached.
    flow_cands = [(i, c["metrics"]["max_flow_reached_pct"]) for i, c in enumerate(unique) if c["metrics"]["max_flow_reached_pct"] is not None]
    if flow_cands:
        mark(max(flow_cands, key=lambda t: (t[1], -unique[t[0]]["score"]))[0], "Highest flow")

    # Steepest flow slope dQ/dY.
    sl_cands = [(i, c["metrics"]["flow_slope_mean"]) for i, c in enumerate(unique) if c in viable and c["metrics"]["flow_slope_mean"] is not None]
    if sl_cands:
        mark(max(sl_cands, key=lambda t: (t[1], -unique[t[0]]["score"]))[0], "Steepest flow")

    # Best safety margin (one-piece stress margin among designs with >= 60 % of best flow).
    sm_cands = [
        (i, c["metrics"]["stress_margin"]) for i, c in enumerate(unique)
        if c["metrics"]["stress_margin"] is not None and (c["metrics"]["max_flow_reached_pct"] or 0.0) >= 0.6 * best_flow
    ]
    if sm_cands:
        best_sm = max(sm_cands, key=lambda t: (t[1], -unique[t[0]]["score"]))[0]
        if (unique[best_sm]["metrics"]["stress_margin"] or 0.0) >= 1.15:
            mark(best_sm, "Higher margin")

    # When multiple link curve options were explored, keep the best design of each curve family visible.
    seen_curves = {unique[i].get("link_curve") for i in picked_idx}
    for i, rec in enumerate(unique):
        if len(picked_idx) >= max_count:
            break
        ck = rec.get("link_curve")
        if ck is not None and ck not in seen_curves:
            seen_curves.add(ck)
            picked_idx.append(i)

    # Fill remaining slots with Pareto non-dominated designs on (deadband, -flow_pct), then next best scores.
    def dominated(i: int) -> bool:
        mi = unique[i]["metrics"]
        dbi = mi["deadband"] if mi["deadband"] is not None else 1e9
        fi = mi["max_flow_reached_pct"] or 0.0
        for j, cj in enumerate(unique):
            if j == i:
                continue
            mj = cj["metrics"]
            dbj = mj["deadband"] if mj["deadband"] is not None else 1e9
            fj = mj["max_flow_reached_pct"] or 0.0
            if dbj <= dbi + 1e-6 and fj >= fi - 1e-6 and (dbj < dbi - 1e-6 or fj > fi + 1e-6):
                return True
        return False

    for i in range(len(unique)):
        if len(picked_idx) >= max_count:
            break
        if i not in picked_idx and not dominated(i):
            picked_idx.append(i)
    for i in range(len(unique)):
        if len(picked_idx) >= max_count:
            break
        if i not in picked_idx:
            picked_idx.append(i)

    # Keep index 0 first, then tagged Pareto extremes, then remaining alternatives sorted by active score.
    rest = sorted([i for i in picked_idx if i != 0], key=lambda i: (not bool(tags_by_idx.get(i)), unique[i]["score"]))
    final_order = [0] + rest
    return [{**unique[i], "tags": tags_by_idx.get(i, [])} for i in final_order]


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


def _rigid_search(p: LinkageParams, s: LinkageSearch) -> dict:
    """Rigid-bar search of one carriage pivot side (p.pivot_inverted): a random draw over the
    ranges, then rounds of tighter draws around the best designs. Returns the columns searched
    and their ranges, every draw with its score (pool, first draw first), the scoring function,
    and the counts of the first draw: tested, feasible, and collision (refused only for the
    clearance between the two linkages)."""
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

    def evaluate(x, stats=None):
        col = dict(zip(names, x.T))
        return _score(p, s, col["bar1_length"], col["bar2_length"], col["anchor_distance"],
                      col.get("lever_length"), col.get("foot_length"), col.get("foot_angle_deg"), stats)

    # The design on screen competes too when it lies inside the ranges.
    start = np.clip(np.array([getattr(p, n) for n in names], dtype=float), lo, hi)
    x = np.vstack([start, lo + rng.random((N_FIRST, len(names))) * width])
    stats = {"collision": 0}
    score = evaluate(x, stats)
    ctx = {"p": p, "names": names, "lo": lo, "hi": hi, "evaluate": evaluate, "pool": [(x, score)],
           "tested": len(x), "feasible": int(np.isfinite(score).sum()), "collision": stats["collision"]}
    if ctx["feasible"] == 0:
        return ctx
    spread = 0.12
    for _ in range(6):
        order = np.argsort(score)[:N_ELITE]
        elite, elite_score = x[order], score[order]
        elite = elite[np.isfinite(elite_score)]
        draws = elite[rng.integers(0, len(elite), N_ROUND)] + rng.normal(0.0, spread, (N_ROUND, len(names))) * width
        x = np.vstack([elite, np.clip(draws, lo, hi)])
        score = evaluate(x)
        ctx["pool"].append((x, score))
        spread *= 0.5
    return ctx


def _curve_specs(p: LinkageParams, s: LinkageSearch) -> Optional[List[Tuple[str, bool]]]:
    """(link_curve_mode, link_curve_flip) specs explored for a pendulum search, or None for 'current'."""
    if p.linkage_type != TYPE_PENDULUM or s.link_curve_search == "current":
        return None
    if s.link_curve_search == "straight":
        return [("straight", False)]
    if s.link_curve_search == "tangent":
        return [("tangent", False)]
    if s.link_curve_search == "tangent_flip":
        return [("tangent", True)]
    if s.link_curve_search == "radius":
        return [("radius", False), ("radius", True)]
    return [("straight", False), ("tangent", False), ("tangent", True), ("radius", False), ("radius", True)]


def _radius_bounds(s: LinkageSearch) -> Tuple[float, float]:
    lo = max(float(s.link_radius_min), 0.1)
    hi = max(float(s.link_radius_max), 0.1)
    return (lo, hi) if lo <= hi else (hi, lo)


def _sample_radius(rng: np.random.Generator, l1: float, r_lo: float, r_hi: float) -> float:
    lo_eff = max(r_lo, 0.5 * l1) if np.isfinite(l1) and l1 > 0.0 else r_lo
    if r_hi <= lo_eff + 1e-9:
        return round(float(lo_eff), 2)
    return round(float(np.exp(rng.uniform(np.log(lo_eff), np.log(r_hi)))), 2)


def _perturb_radius(rng: np.random.Generator, r_cur: float, spread: float, l1: float, r_lo: float, r_hi: float) -> float:
    lo_eff = max(r_lo, 0.5 * l1) if np.isfinite(l1) and l1 > 0.0 else r_lo
    if r_hi <= lo_eff + 1e-9:
        return round(float(lo_eff), 2)
    log_lo, log_hi = np.log(lo_eff), np.log(r_hi)
    log_cur = float(np.clip(np.log(max(r_cur, lo_eff)), log_lo, log_hi))
    val = float(np.clip(log_cur + rng.normal(0.0, spread * (log_hi - log_lo)), log_lo, log_hi))
    return round(float(np.exp(val)), 2)


def _exact_objective_score(out: LinkageParams, r: LinkageResult, s: LinkageSearch, fallback: float) -> float:
    """Exact objective score computed on a full-resolution LinkageResult."""
    if not _is_auto_stroke(s.objective):
        return float(r.rms_error if r.rms_error is not None else fallback)
    full_ref = tube_law.FULL_OPEN_FRACTION if tube_law.uses_fem(out) else 1.0
    ff = min((r.max_flow_reached_pct / 100.0) / full_ref, 1.0)
    y_open_e = r.y_open if r.y_open is not None else out.stroke
    y_full_e = r.y_full_open if r.y_full_open is not None else np.inf
    slope_norm = (r.flow_slope_mean / r.max_flow_l_min) if (r.flow_slope_mean is not None and r.max_flow_l_min > 0) else 0.0
    accel_norm = (r.flow_accel_mean / r.max_flow_l_min) if (r.flow_accel_mean is not None and r.max_flow_l_min > 0) else 0.0
    t90_e = None
    if s.objective == OBJECTIVE_CHAMBER:
        yp = np.array(r.Y_positions)
        pos = yp >= 0.0
        g_arr = np.array([np.nan if g is None else g for g in r.gap_loaded_a], dtype=float)[pos]
        t90_e = _fast_chamber_t90_ms(out, yp[pos], _area_mm2(out, np.nan_to_num(g_arr, nan=0.0), r.closed_gap), out.stroke)
    return float(_objective_score(s.objective, ff, y_open_e, y_full_e, out.stroke, slope_norm, accel_norm, t90_e))


def _record_curve_stat(report: dict, curve_key: str, solved: int = 0, passed: int = 0, score: Optional[float] = None) -> None:
    entry = report["curves"].setdefault(curve_key, {"solved": 0, "passed": 0, "found": False, "score": None})
    entry["solved"] += solved
    entry["passed"] += passed
    if score is not None and np.isfinite(score):
        entry["found"] = True
        if entry["score"] is None or score < entry["score"]:
            entry["score"] = float(score)


def _rigid_pick(s: LinkageSearch, ctx: dict, side: dict, report: Optional[dict] = None) -> Tuple[Optional[LinkageParams], float, List[dict]]:
    """Best rigid designs that compute_linkage also finds clear of the other linkage over the travel
    it uses and, with s.require_seal, sealed at Y = 0 once the bars flex. Evaluates a diverse spread
    of finalists so Pareto alternatives are returned too. For 'chamber' or multi-curve pendulum
    searches, re-scores finalists on the exact loaded simulation."""
    p, names = ctx["p"], ctx["names"]
    auto_stroke = _is_auto_stroke(s.objective)
    specs = _curve_specs(p, s)
    multi_curve = specs is not None and (len(specs) > 1 or specs[0][0] == "radius")
    r_lo, r_hi = _radius_bounds(s)
    x, score = ctx["pool"][-1]
    order = np.argsort(score, kind="stable")[:N_ELITE]
    candidates = [(x[i], score[i]) for i in order if np.isfinite(score[i])]
    pool_x = np.vstack([v for v, _ in ctx["pool"]])
    pool_sc = np.concatenate([sc for _, sc in ctx["pool"]])
    spread = _shortlist(p, names, ctx["lo"], ctx["hi"], pool_x, pool_sc, N_ELITE)
    spread_sc = ctx["evaluate"](spread) if len(spread) else np.array([])
    if s.require_seal or s.objective == OBJECTIVE_CHAMBER or multi_curve:
        candidates = candidates[:2] + list(zip(spread, spread_sc))
    else:
        candidates = candidates[:1] + list(zip(spread, spread_sc)) + candidates[1:6]

    tried = set()
    verified: List[Tuple[float, LinkageParams, LinkageResult, str]] = []
    max_verify = (18 if multi_curve else 10) if (s.objective == OBJECTIVE_CHAMBER or auto_stroke or multi_curve) else 6
    max_geoms = 8 if multi_curve else len(candidates)
    geoms_checked = 0
    for v, sc in candidates:
        if len(verified) >= max_verify or geoms_checked >= max_geoms:
            break
        base = replace(p, **{name: round(float(val), 3) for name, val in zip(names, v)})
        key = tuple(getattr(base, n) for n in names)
        if key in tried or not np.isfinite(sc):
            continue
        tried.add(key)
        # Score the design as returned, rounded to 1 um: near a singular closed pose the rounding
        # can land on another pose, or on none (a pivot below the anchor line), that the search never saw.
        sc = float(ctx["evaluate"](np.array([key], dtype=float))[0])
        if not np.isfinite(sc):
            continue
        geoms_checked += 1

        if multi_curve and specs is not None:
            variants: List[LinkageParams] = []
            l1_est = base.bar1_length
            lo_eff = max(r_lo, 0.5 * l1_est)
            if r_hi <= lo_eff + 1e-9:
                radii = [round(lo_eff, 2)]
            else:
                radii = sorted({round(lo_eff, 2), round(float(np.sqrt(lo_eff * r_hi)), 2), round(r_hi, 2)})
            for mode, flip in specs:
                if mode == "radius":
                    for rad in radii:
                        variants.append(_with_curve(base, mode, flip, rad))
                else:
                    variants.append(_with_curve(base, mode, flip))
        else:
            variants = [base]

        for out in variants:
            ck = _curve_option_name(out) if out.linkage_type == TYPE_PENDULUM else None
            if report is not None and multi_curve and ck is not None:
                _record_curve_stat(report, ck, solved=1)
            if auto_stroke:
                out = replace(out, stroke=s.max_stroke)
            r = compute_linkage(replace(out, chamber_volume_ml=0.0))
            if s.require_seal and r.sealed_after_flex is False:
                side["seal"] += 1
                continue
            limiting = "max_stroke"
            if auto_stroke:
                if r.collision_y is not None and r.collision_y < 0.05 - 1e-9:
                    continue
                crushed = _crushed(r, s, r.gap_a)
                caps_named = [(s.max_stroke, "max_stroke"), (r.y_max, "reach"), (-r.y_min, "lock")]
                if crushed.size:
                    caps_named.append((float(crushed.min()), "oversqueeze"))
                if r.collision_y is not None:
                    caps_named.append((r.collision_y - 1e-6, "collision"))
                cap_y, cap_reason = min(caps_named, key=lambda t: t[0])
                caps = [r.collision_y - 1e-6] if r.collision_y is not None else []
                stroke_use = _stroke_used(r, s, caps) if r.y_full_open is not None else max(0.05, _stroke_used(r, s, caps))
                if stroke_use < 0.05 - 1e-9:
                    continue
                out = replace(out, stroke=stroke_use)
                if r.y_full_open is not None and round(float(np.ceil(r.y_full_open / 0.05 - 1e-9)) * 0.05, 2) <= cap_y + 1e-9:
                    limiting = "full_open"
                else:
                    limiting = cap_reason
            elif r.collision_y is not None:
                continue
            if p.fixed_height > 0:
                out = replace(out, bar1_length=round(r.link_length, 3))
            # Final simulation at its exact returned stroke (chamber cycle omitted here: _candidate_record computes t90 fast).
            r_final = compute_linkage(replace(out, chamber_volume_ml=0.0))
            if not r_final.feasible or (s.require_seal and r_final.sealed_after_flex is False):
                continue
            if auto_stroke and r_final.max_flow_reached_pct < s.min_flow_pct - 1e-9:
                continue
            sc_use = float(sc)
            if s.objective == OBJECTIVE_CHAMBER or multi_curve:
                sc_use = _exact_objective_score(out, r_final, s, sc_use)
            if report is not None and ck is not None and specs is not None:
                _record_curve_stat(report, ck, passed=1, score=sc_use)
            verified.append((sc_use, out, r_final, limiting))
    if not verified:
        return None, np.inf, []
    verified.sort(key=lambda t: t[0])
    best_sc, best_out, _, _ = verified[0]
    recs = [_candidate_record(out, r_fin, sc, lim) for sc, out, r_fin, lim in verified]
    return best_out, float(best_sc), recs


def optimize_linkage(p: LinkageParams, s: LinkageSearch) -> Tuple[Optional[LinkageParams], int, int, dict]:
    """Random draw over the ranges, then rounds of tighter draws around the best designs.

    Searched: the bar lengths and the anchor distance, plus the lever length (lever) or the
    foot length and angle (pendulum). With a fixed height bar 1 is solved, not searched.
    A range with min = max holds that value. The carriage pivot side (s.pivot_side) is "normal"
    (far side of the screw), "inverted" (its tube's side, see _pivot_x) or "both": each side has
    its own search with the same seeds, so a side searched within "both" finds exactly what it
    finds alone, and the better design of the two is kept (a tie keeps the normal side).

    For pendulum linkages, s.link_curve_search can keep the current link curve ("current"),
    restrict to one family ("straight", "tangent", "tangent_flip", "radius"), or search all
    options together ("all"), tuning custom arc radii within [link_radius_min, link_radius_max].

    In one-piece pendulum mode, usable travel is capped by every active structural and assembly
    limit (stress, thrust, eye bearing, rod bending, clearance, oversqueeze, jam) so fast,
    low-deadband designs stop cleanly at their safe stroke instead of being discarded.
    report["candidates"] holds a curated Pareto set of top verified alternatives.
    """
    if s.pivot_side not in PIVOT_SIDES:
        raise ValueError("pivot_side must be one of %s" % ", ".join(PIVOT_SIDES))
    if s.objective not in OBJECTIVES:
        raise ValueError("objective must be one of %s" % ", ".join(OBJECTIVES))
    if s.link_curve_search not in LINK_CURVE_SEARCHES:
        raise ValueError("link_curve_search must be one of %s" % ", ".join(LINK_CURVE_SEARCHES))
    one_piece = p.compliant and p.linkage_type == TYPE_PENDULUM
    specs = _curve_specs(p, s)
    # Single fixed curve override (straight / tangent / tangent_flip): apply directly to p.
    p_base = _with_curve(p, specs[0][0], specs[0][1]) if (specs is not None and len(specs) == 1 and specs[0][0] != "radius") else p
    # When searching multiple curves / radii, pre-screen rigid geometry with a straight chord so
    # clearance of one arbitrary curve does not drop geometries that work cleanly with another curve.
    p_rigid = _with_curve(p_base, "straight") if (specs is not None and (len(specs) > 1 or specs[0][0] == "radius")) else p_base
    report = {
        "model": "one-piece" if one_piece else "rigid",
        "shortlist": 0,
        "passed": 0,
        "rejected": {k: 0 for k in ONE_PIECE_LIMITS},
        "sides": {},
        "pivot_side": None,
        "curves": {},
        "link_curve": None,
        "limiting_factor": None,
        "candidates": [],
    }
    contexts = [_rigid_search(replace(p_rigid, pivot_inverted=inverted), s) for inverted in PIVOT_SIDES[s.pivot_side]]
    feasible, tested = sum(c["feasible"] for c in contexts), sum(c["tested"] for c in contexts)
    for c in contexts:
        report["sides"][_side_name(c["p"])] = {"feasible": c["feasible"], "collision": c["collision"],
                                               "solved": 0, "passed": 0, "seal": 0, "found": False, "score": None}
    live = [c for c in contexts if c["feasible"] > 0]
    if not live:
        return None, feasible, tested, report
    # Restore original curve settings on ctx["p"] for stage 2 when multi-curve is active (so current design competes).
    if p_rigid is not p_base:
        for c in live:
            c["p"] = replace(p_base, pivot_inverted=c["p"].pivot_inverted)
    picks = [
        _one_piece_pick(s, c, report) if one_piece else _rigid_pick(s, c, report["sides"][_side_name(c["p"])], report)
        for c in live
    ]
    best, best_score = None, np.inf
    all_candidates: List[dict] = []
    for out, score, cands in picks:
        all_candidates.extend(cands)
        if out is None:
            continue
        side = report["sides"][_side_name(out)]
        side["found"], side["score"] = True, float(score)
        if score < best_score:
            best, best_score = out, score
            report["pivot_side"] = _side_name(out)
            if out.linkage_type == TYPE_PENDULUM:
                report["link_curve"] = _curve_option_name(out)
    curated = _curate_candidates(all_candidates)
    report["candidates"] = curated
    if curated:
        report["limiting_factor"] = curated[0]["limiting_factor"]
    return best, feasible, tested, report


def _side_name(p: LinkageParams) -> str:
    return "inverted" if p.pivot_inverted else "normal"


def _one_piece_pick(s: LinkageSearch, ctx: dict, report: dict) -> Tuple[Optional[LinkageParams], float, List[dict]]:
    """Stage two for the one-piece pendulum: explore and refine directly on the beam model.
    Returns (best design or None, its score, curated candidate summaries)."""
    p, names, lo, hi, pool = (ctx[k] for k in ("p", "names", "lo", "hi", "pool"))
    side = report["sides"][_side_name(p)]
    rng = np.random.default_rng(1)   # its own stream: same answer for the same inputs
    width = np.where(np.isin(np.arange(len(names)), _searched(p, names, lo, hi)), hi - lo, 0.0)
    specs = _curve_specs(p, s)
    multi_curve = specs is not None and (len(specs) > 1 or specs[0][0] == "radius")
    r_lo, r_hi = _radius_bounds(s)
    i_bar1 = names.index("bar1_length")

    # Initial batch mixes: (1) current design on screen if valid, (2) diverse rigid shortlist,
    # (3) random rigid-feasible draws, and (4) fresh geometrically valid one-piece draws that
    # rigid _score may have rejected (e.g. high-gain flexures whose rigid bars would over-squeeze).
    geom_target = int(round(N_SHORTLIST * (1.5 if (multi_curve and specs and len(specs) > 2) else 1.2 if multi_curve else 1.0)))
    n_rigid = max(1, int(round(geom_target * 0.35)))
    n_spread = max(1, int(round(geom_target * 0.70)))
    geom_batch: List[np.ndarray] = []
    tried_geom = set()

    def add_geom(v: np.ndarray) -> bool:
        vr = np.round(v, 3)
        k = tuple(vr)
        if k in tried_geom:
            return False
        tried_geom.add(k)
        geom_batch.append(vr)
        return True

    # Current on-screen design competes when it sits inside the ranges and is geometrically valid.
    start = np.clip(np.array([getattr(p, n) for n in names], dtype=float), lo, hi)
    if _one_piece_geom_ok(p, s, names, start[None, :])[0]:
        add_geom(start)

    for v in _shortlist(p, names, lo, hi, np.vstack([x for x, _ in pool]), np.concatenate([sc for _, sc in pool]), n_rigid):
        if len(geom_batch) >= n_rigid:
            break
        add_geom(v)

    first_x, first_score = pool[0]
    spread_pool = np.round(first_x[np.isfinite(first_score)], 3)
    for i in rng.permutation(len(spread_pool)):
        if len(geom_batch) >= n_spread:
            break
        add_geom(spread_pool[i])

    # Fresh direct draws in the searched space, filtered only by one-piece rest-pose geometry.
    if len(geom_batch) < geom_target:
        need = geom_target - len(geom_batch)
        direct = lo + rng.random((max(need * 8, 64), len(names))) * width
        ok_direct = _one_piece_geom_ok(p, s, names, direct)
        for v in direct[ok_direct]:
            if len(geom_batch) >= geom_target:
                break
            add_geom(v)
        # Fallback to remaining rigid-feasible draws if direct draws were sparse.
        if len(geom_batch) < geom_target:
            for i in rng.permutation(len(spread_pool)):
                if len(geom_batch) >= geom_target:
                    break
                add_geom(spread_pool[i])

    auto_stroke = _is_auto_stroke(s.objective)
    stroke = s.max_stroke if auto_stroke else p.stroke
    ranked: List[Tuple[float, float, LinkageParams, dict]] = []
    tried_full = set()

    def cand_key(v: np.ndarray, mode: str, flip: bool, rad: float):
        return (tuple(v), mode, flip, rad if mode == "radius" else 0.0)

    def build_params(v: np.ndarray, mode: Optional[str], flip: bool, rad: float) -> LinkageParams:
        q = replace(p, **{n: float(val) for n, val in zip(names, v)}, stroke=stroke, chamber_volume_ml=0.0)
        if mode is not None:
            q = _with_curve(q, mode, flip, rad)
        return q

    def solve(designs: List[Tuple[np.ndarray, Optional[str], bool, float]]):
        for v, mode, flip, rad in designs:
            q = build_params(v, mode, flip, rad)
            sc, travel, broken, meta = _one_piece_eval(q, s, fast=True)
            report["shortlist"] += 1
            side["solved"] += 1
            ck = _curve_option_name(q)
            if specs is not None:
                _record_curve_stat(report, ck, solved=1)
            if broken:
                report["rejected"][broken] += 1
                side["seal"] += broken == "seal"
            else:
                if specs is not None:
                    _record_curve_stat(report, ck, passed=1)
                ranked.append((sc, travel, q, meta or {}))
        ranked.sort(key=lambda t: t[0])

    if not multi_curve:
        batch_items = [(v, None, False, p.link_radius) for v in geom_batch]
        for v in geom_batch:
            tried_full.add(cand_key(v, _link_curve_mode(p), p.link_curve_flip, p.link_radius))
    else:
        assert specs is not None
        batch_items = []
        batch_target = int(round(N_SHORTLIST * (1.7 if len(specs) > 2 else 1.25)))
        # Test the top distinct geometries across every curve family for direct apples-to-apples comparison.
        k_shared = max(1, min(len(geom_batch), N_SHORTLIST // (14 if len(specs) > 2 else 6)))
        for idx, v in enumerate(geom_batch[:k_shared]):
            l1_est = float(v[i_bar1])
            for mode, flip in specs:
                rad = _sample_radius(rng, l1_est, r_lo, r_hi) if mode == "radius" else p.link_radius
                if idx == 0 and mode == _link_curve_mode(p) and flip == p.link_curve_flip and mode == "radius":
                    rad = float(np.clip(p.link_radius, max(r_lo, 0.5 * l1_est), max(r_hi, 0.5 * l1_est)))
                ckey = cand_key(v, mode, flip, rad)
                if ckey not in tried_full:
                    tried_full.add(ckey)
                    batch_items.append((v, mode, flip, rad))
        # Spread remaining geometries across all curve families round-robin for broad spatial coverage.
        for idx, v in enumerate(geom_batch[k_shared:]):
            if len(batch_items) >= batch_target:
                break
            mode, flip = specs[idx % len(specs)]
            rad = _sample_radius(rng, float(v[i_bar1]), r_lo, r_hi) if mode == "radius" else p.link_radius
            ckey = cand_key(v, mode, flip, rad)
            if ckey not in tried_full:
                tried_full.add(ckey)
                batch_items.append((v, mode, flip, rad))

    def cross_test_top(n_top: int) -> None:
        """Evaluate the top distinct refined geometries across every searched curve family."""
        if not multi_curve or not ranked or specs is None:
            return
        seen_g: List[np.ndarray] = []
        cross_items: List[Tuple[np.ndarray, Optional[str], bool, float]] = []
        for _, _, q, _ in ranked:
            v = np.round(np.array([getattr(q, n) for n in names], dtype=float), 3)
            if any(np.allclose(v, sg, atol=0.15) for sg in seen_g):
                continue
            seen_g.append(v)
            l1_est = float(v[i_bar1])
            lo_eff = max(r_lo, 0.5 * l1_est)
            r_mid = round(float(np.sqrt(lo_eff * max(r_hi, lo_eff))), 2)
            for mode, flip in specs:
                rads = [r_mid] if mode == "radius" else [p.link_radius]
                for rad in rads:
                    ckey = cand_key(v, mode, flip, rad)
                    if ckey not in tried_full:
                        tried_full.add(ckey)
                        cross_items.append((v, mode, flip, rad))
            if len(seen_g) >= n_top:
                break
        if cross_items:
            solve(cross_items)

    solve(batch_items)
    round_budget = int(round(N_ONE_PIECE_ROUND * (1.45 if (multi_curve and specs and len(specs) > 2) else 1.15 if multi_curve else 1.0)))
    for r_idx, spread in enumerate(ONE_PIECE_ROUNDS):
        if not ranked:
            break
        # Seed refinement from best overall designs (weighted 2x in multi-curve mode so the winning
        # basin gets focused local refinement), best of each curve family, AND Pareto extremes.
        elite_qs: List[LinkageParams] = [q for _, _, q, _ in ranked[:4]]
        seen_e = {(tuple(getattr(q, n) for n in names), _curve_option_name(q), q.link_radius) for q in elite_qs}
        if multi_curve:
            seen_fam = {_curve_option_name(q) for q in elite_qs}
            for _, _, q, _ in ranked:
                fam = _curve_option_name(q)
                if fam not in seen_fam:
                    seen_fam.add(fam)
                    ek = (tuple(getattr(q, n) for n in names), fam, q.link_radius)
                    seen_e.add(ek)
                    elite_qs.append(q)
        for key_fn in (
            lambda t: (t[3].get("y_open") if t[3].get("y_open") is not None else 1e9, t[0]),
            lambda t: (-(t[3].get("flow_pct") or 0.0), t[0]),
        ):
            top = min(ranked, key=key_fn)
            ek = (tuple(getattr(top[2], n) for n in names), _curve_option_name(top[2]), top[2].link_radius)
            if ek not in seen_e:
                seen_e.add(ek)
                elite_qs.append(top[2])
        # Duplicate top-3 overall elites in the sampling table when multi-curve is active so they receive ~50% of draws.
        pool_qs = (elite_qs[:3] + elite_qs) if multi_curve else elite_qs
        elite = np.array([[getattr(q, n) for n in names] for q in pool_qs])
        parents = rng.integers(0, len(elite), 10 * round_budget)
        draws = elite[parents] + rng.normal(0.0, spread, (10 * round_budget, len(names))) * width
        draws = np.round(np.clip(draws, lo, hi), 3)
        ok_mask = _one_piece_geom_ok(p, s, names, draws)
        fresh: List[Tuple[np.ndarray, Optional[str], bool, float]] = []
        for idx in np.flatnonzero(ok_mask):
            if len(fresh) >= round_budget:
                break
            v = draws[idx]
            parent_q = pool_qs[int(parents[idx])]
            if not multi_curve:
                mode, flip, rad = None, p.link_curve_flip, p.link_radius
                ckey = cand_key(v, _link_curve_mode(p), p.link_curve_flip, p.link_radius)
            else:
                assert specs is not None
                if rng.random() < 0.12:
                    mode, flip = specs[int(rng.integers(0, len(specs)))]
                    rad = _sample_radius(rng, float(v[i_bar1]), r_lo, r_hi) if mode == "radius" else p.link_radius
                else:
                    mode = _link_curve_mode(parent_q)
                    flip = parent_q.link_curve_flip
                    rad = _perturb_radius(rng, parent_q.link_radius, spread, float(v[i_bar1]), r_lo, r_hi) if mode == "radius" else p.link_radius
                ckey = cand_key(v, mode, flip, rad)
            if ckey not in tried_full:
                tried_full.add(ckey)
                fresh.append((v, mode, flip, rad))
        solve(fresh)
        if multi_curve and r_idx in (1, len(ONE_PIECE_ROUNDS) - 1):
            cross_test_top(min(3, max(1, N_SHORTLIST // 12)))

    report["passed"] += len(ranked)
    side["passed"] += len(ranked)
    if not ranked:
        return None, np.inf, []

    # Build a compact, deduplicated pool of diverse finalists to verify with exact full-resolution
    # compute_linkage at each candidate's own stroke (without running full 601-pt chamber cycle per finalist).
    max_finalists = min(12 if multi_curve else 8, max(6 if multi_curve else 4, N_SHORTLIST // 2))
    finalist_indices: List[int] = []

    def add_finalist(idx: int) -> None:
        if idx in finalist_indices or len(finalist_indices) >= max_finalists:
            return
        q = ranked[idx][2]
        ck = _curve_option_name(q)
        for j in finalist_indices:
            qj = ranked[j][2]
            if ck != _curve_option_name(qj):
                continue
            rad_close = True
            if ck in ("radius_in", "radius_out"):
                rad_close = abs(q.link_radius - qj.link_radius) < max(0.5, 0.1 * max(q.link_radius, qj.link_radius))
            if (rad_close
                    and abs(q.bar2_length - qj.bar2_length) < 0.2
                    and abs(q.anchor_distance - qj.anchor_distance) < 0.2
                    and abs(q.foot_length - qj.foot_length) < 0.15
                    and abs(q.foot_angle_deg - qj.foot_angle_deg) < 2.0
                    and abs(ranked[idx][1] - ranked[j][1]) < 0.08):
                return
        finalist_indices.append(idx)

    # Always include the #1 design first, best of each curve family (when searching curves), then Pareto extremes.
    add_finalist(0)
    if multi_curve:
        seen_c = {_curve_option_name(ranked[0][2])}
        for i in range(1, len(ranked)):
            ck = _curve_option_name(ranked[i][2])
            if ck not in seen_c:
                seen_c.add(ck)
                add_finalist(i)
    best_flow_pct = max((t[3].get("flow_pct") or 0.0) for t in ranked)
    for key_fn in (
        lambda i: (ranked[i][3].get("y_open") if ranked[i][3].get("y_open") is not None else 1e9, ranked[i][0]),
        lambda i: (-(ranked[i][3].get("flow_pct") or 0.0), ranked[i][0]),
        lambda i: (-(ranked[i][3].get("slope_mean") or 0.0), ranked[i][0]),
        lambda i: (ranked[i][3].get("t90_ms") if ranked[i][3].get("t90_ms") is not None else 1e9, ranked[i][0]),
    ):
        for i in sorted(range(len(ranked)), key=key_fn)[:2]:
            add_finalist(i)
    margin_pool = [
        i for i in range(len(ranked))
        if (ranked[i][3].get("stress_margin") or 0.0) >= 1.15
        and (ranked[i][3].get("flow_pct") or 0.0) >= 0.55 * best_flow_pct
    ]
    if margin_pool:
        margin_pool.sort(key=lambda i: (-(ranked[i][3].get("stress_margin") or 0.0), ranked[i][0]))
        add_finalist(margin_pool[0])
    for i in range(1, len(ranked)):
        if len(finalist_indices) >= max_finalists:
            break
        add_finalist(i)

    verified: List[Tuple[float, LinkageParams, LinkageResult, str]] = []
    checked_indices = set()

    def verify_index(idx: int) -> Optional[Tuple[float, LinkageParams, LinkageResult, str]]:
        checked_indices.add(idx)
        score, travel, q, meta = ranked[idx]
        q_exact = replace(q, stroke=travel, chamber_volume_ml=0.0)
        r = compute_linkage(q_exact)
        # Keep it only on an exact solve of the returned design at its own stroke.
        unusable = not r.feasible or r.jam_y is not None or _crushed(r, s, r.gap_loaded_a).size > 0
        if not unusable and auto_stroke and (r.max_flow_reached_l_min <= 0.0 or r.max_flow_reached_pct < s.min_flow_pct - 1e-9):
            unusable = True
        broken = (
            "no_flow" if unusable
            else "collision" if r.collision_y is not None
            else "seal" if s.require_seal and r.sealed_after_flex is False
            else _one_piece_limit(q_exact, r, travel)
        )
        # If fine N_SAMPLES=241 nudged a boundary limit slightly above threshold on a structurally capped
        # design, step down by 0.05 mm once so a genuinely strong candidate isn't lost to grid discretization.
        if broken in ("stress", "thrust", "eye", "rod", "collision") and auto_stroke and travel >= 0.10 - 1e-9:
            stepped = round(travel - 0.05, 2)
            q_step = replace(q, stroke=stepped, chamber_volume_ml=0.0)
            r_step = compute_linkage(q_step)
            unusable_s = (
                not r_step.feasible or r_step.jam_y is not None
                or _crushed(r_step, s, r_step.gap_loaded_a).size > 0
                or r_step.max_flow_reached_l_min <= 0.0
                or r_step.max_flow_reached_pct < s.min_flow_pct - 1e-9
            )
            broken_s = (
                "no_flow" if unusable_s
                else "collision" if r_step.collision_y is not None
                else "seal" if s.require_seal and r_step.sealed_after_flex is False
                else _one_piece_limit(q_step, r_step, stepped)
            )
            if not broken_s:
                q_exact, r, travel, broken = q_step, r_step, stepped, None
        if broken:
            report["rejected"][broken] += 1
            report["passed"] -= 1
            side["passed"] -= 1
            if specs is not None:
                _record_curve_stat(report, _curve_option_name(q), passed=-1)
            return None
        q_out = replace(q_exact, chamber_volume_ml=p.chamber_volume_ml)
        if p.fixed_height > 0:
            q_out = replace(q_out, bar1_length=round(r.link_length, 3))
        # Recompute exact score on the full-resolution result so #1 ranking is 100 % exact.
        exact_score = _exact_objective_score(q_out, r, s, score)
        if specs is not None:
            _record_curve_stat(report, _curve_option_name(q_out), score=exact_score)
        limiting = meta.get("limiting_factor", "max_stroke")
        return exact_score, q_out, r, limiting

    for idx in finalist_indices:
        v = verify_index(idx)
        if v is not None:
            verified.append(v)
    if not verified:
        for idx in range(len(ranked)):
            if idx in checked_indices:
                continue
            v = verify_index(idx)
            if v is not None:
                verified.append(v)
                break
    if not verified:
        return None, np.inf, []
    verified.sort(key=lambda t: t[0])
    best_sc, best_out, _, _ = verified[0]
    recs = [_candidate_record(out, r_fin, sc, lim) for sc, out, r_fin, lim in verified]
    return best_out, float(best_sc), recs
