import type { ChartDomainSettings } from '../components';
import type { TubeModel } from '../lib/tubeModel';

/** Shape knobs, in the same order and with the same defaults as backend/compliant_bars.py. */
export const COMPLIANT_DEFAULTS = {
  anchor_distance: 4.8,
  junction_x: -5.5,
  junction_y: 12,
  pinch_y: 10.5,
  l_u1: 0.35, l_v1: -0.8, l_u2: 0.65, l_v2: -0.8,
  r_u1: 0.35, r_v1: 0.6, r_u2: 0.65, r_v2: 0.4,
  f_u1: 0.35, f_v1: 0.45, f_u2: 0.65, f_v2: 0.35,
  l_thickness: 1, r_thickness: 0.9, f_thickness: 1,
  closed_carriage_height: 8,
  pivot_offset: 4,
  pivot_inverted: false,
  stroke: 1.5,
  preload: 0.1,
  member_depth: 3,
  member_modulus_mpa: 1950,
  member_strength_mpa: 75,
  carriage_pin_diameter: 1.5,
  tube_center_x: 8,
  tube_id: 2,
  tube_od: 3,
  input_pressure_kpa: 100,
  compliance: 0.7,
  tube_model: 'simple' as TubeModel,
  tube_shore_a: 50,
  chamber_volume_ml: 10,
  motor_torque_mnm: 30,
  screw_diameter: 3.0,
  screw_friction: 0.3,
  lead_screw_pitch: 0.5,
};

export type CompliantParams = typeof COMPLIANT_DEFAULTS;

export const SHAPE_KEYS = [
  'anchor_distance', 'junction_x', 'junction_y', 'pinch_y',
  'l_u1', 'l_v1', 'l_u2', 'l_v2', 'r_u1', 'r_v1', 'r_u2', 'r_v2',
  'f_u1', 'f_v1', 'f_u2', 'f_v2', 'l_thickness', 'r_thickness', 'f_thickness',
] as const;

export type ShapeKey = typeof SHAPE_KEYS[number];

/** Numeric context variables that the user can either fix or release to the solver. */
export const CONTEXT_VAR_KEYS = [
  'closed_carriage_height',
  'pivot_offset',
  'stroke',
  'preload',
  'member_depth',
] as const;

export type ContextVarKey = typeof CONTEXT_VAR_KEYS[number];
export type ContextToggleKey = ContextVarKey | 'pivot_inverted';
export type ContextFixedMap = Record<ContextToggleKey, boolean>;

export type Member = 'l' | 'r' | 'f';
export type Pt = [number, number];
export type Quadrant = 1 | 2 | 3 | 4;
export type QuadrantKey = 'l_1' | 'l_2' | 'r_1' | 'r_2' | 'f_1' | 'f_2';
export interface QuadrantConfig {
  quadrants: Quadrant[];
  radius: number;
}
export type QuadrantMap = Record<QuadrantKey, QuadrantConfig>;
export type HoveredBoundTarget =
  | 'anchor'
  | 'junction'
  | 'pinch'
  | 'l_1' | 'l_2'
  | 'r_1' | 'r_2'
  | 'f_1' | 'f_2'
  | 'l_thickness' | 'r_thickness' | 'f_thickness'
  | null;

export const QUADRANT_KEYS: QuadrantKey[] = ['l_1', 'l_2', 'r_1', 'r_2', 'f_1', 'f_2'];

/** World-space endpoints [start, end] for each compliant member at rest (Y = 0). */
export function memberChords(p: CompliantParams, constraints?: SolverConstraints | null): Record<Member, [Pt, Pt]> {
  const anchor: Pt = anchorPoint(p);
  const junction: Pt = [p.junction_x, p.junction_y];
  const pivot: Pt = [p.pivot_inverted ? -p.pivot_offset : p.pivot_offset, p.closed_carriage_height];
  const pinch: Pt = [pinchX(p), effectivePinchY(p, constraints)];
  return { l: [anchor, junction], r: [junction, pivot], f: [junction, pinch] };
}

/** Convert world-orthogonal quadrants + max radius R around a handle's endpoint into solver (u, v) bounds. */
export function worldQuadrantsToUV(
  s: Pt,
  e: Pt,
  index: 1 | 2,
  quadrants: Quadrant[],
  radius: number,
  curU: number,
  curV: number,
): { u: [number, number]; v: [number, number] } {
  if (quadrants.length === 0) {
    return { u: [curU, curU], v: [curV, curV] };
  }
  const { n, length } = leftNormal(s, e);
  if (length < 1e-6) return { u: [curU, curU], v: [curV, curV] };
  const tx = (e[0] - s[0]) / length;
  const ty = (e[1] - s[1]) / length;
  const center: Pt = index === 1 ? s : e;

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const addPt = (px: number, py: number) => {
    const dx = px - s[0], dy = py - s[1];
    const u = Math.min(0.95, Math.max(0.05, (dx * tx + dy * ty) / length));
    const v = Math.min(8, Math.max(-8, dx * n[0] + dy * n[1]));
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  };

  addPt(center[0], center[1]);
  for (const q of quadrants) {
    const sx = q === 1 || q === 4 ? 1 : -1;
    const sy = q === 1 || q === 2 ? 1 : -1;
    for (let k = 0; k <= 8; k++) {
      const ang = (k / 8) * (Math.PI / 2);
      addPt(center[0] + sx * radius * Math.cos(ang), center[1] + sy * radius * Math.sin(ang));
    }
  }
  return {
    u: [Number(uMin.toFixed(3)), Number(Math.max(uMin, uMax).toFixed(3))],
    v: [Number(vMin.toFixed(3)), Number(Math.max(vMin, vMax).toFixed(3))],
  };
}

export function defaultQuadrantMap(
  params: CompliantParams,
  _bounds: Record<ShapeKey, [number, number]>,
): QuadrantMap {
  const chords = memberChords(params);
  const forHandle = (m: Member, idx: 1 | 2): QuadrantConfig => {
    const [s, e] = chords[m];
    const { n } = leftNormal(s, e);
    const u = params[`${m}_u${idx}` as ShapeKey] as number;
    const v = params[`${m}_v${idx}` as ShapeKey] as number;
    const hx = s[0] + u * (e[0] - s[0]) + v * n[0];
    const hy = s[1] + u * (e[1] - s[1]) + v * n[1];
    const center = idx === 1 ? s : e;
    const dx = hx - center[0];
    const dy = hy - center[1];
    const dist = Math.hypot(dx, dy);
    const q: Quadrant = dx >= 0 ? (dy >= 0 ? 1 : 4) : (dy >= 0 ? 2 : 3);
    const radius = Math.min(8, Math.max(1.5, Math.ceil((dist + 1.0) * 4) / 4));
    return { quadrants: [q], radius };
  };
  return {
    l_1: forHandle('l', 1),
    l_2: forHandle('l', 2),
    r_1: forHandle('r', 1),
    r_2: forHandle('r', 2),
    f_1: forHandle('f', 1),
    f_2: forHandle('f', 2),
  };
}

export interface SliderMeta {
  min: number;
  max: number;
  step: number;
  label: string;
  unit?: string;
  description?: string;
}

export const LIMITS: Record<ShapeKey, SliderMeta> = {
  anchor_distance: { min: -12, max: 12, step: 0.05, label: 'Anchor distance', unit: 'mm' },
  junction_x: { min: -12, max: 8, step: 0.05, label: 'Junction x', unit: 'mm' },
  junction_y: { min: 2, max: 22, step: 0.05, label: 'Junction y', unit: 'mm' },
  pinch_y: { min: 1, max: 22, step: 0.05, label: 'Pinch height', unit: 'mm' },
  l_u1: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 1 along' },
  l_v1: { min: -8, max: 8, step: 0.05, label: 'Handle 1 side' },
  l_u2: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 2 along' },
  l_v2: { min: -8, max: 8, step: 0.05, label: 'Handle 2 side' },
  r_u1: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 1 along' },
  r_v1: { min: -8, max: 8, step: 0.05, label: 'Handle 1 side' },
  r_u2: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 2 along' },
  r_v2: { min: -8, max: 8, step: 0.05, label: 'Handle 2 side' },
  f_u1: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 1 along' },
  f_v1: { min: -8, max: 8, step: 0.05, label: 'Handle 1 side' },
  f_u2: { min: 0.05, max: 0.95, step: 0.01, label: 'Handle 2 along' },
  f_v2: { min: -8, max: 8, step: 0.05, label: 'Handle 2 side' },
  l_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness', unit: 'mm' },
  r_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness', unit: 'mm' },
  f_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness', unit: 'mm' },
};

export const CONTEXT_LIMITS: Record<ContextVarKey, SliderMeta> = {
  closed_carriage_height: {
    min: 3, max: 16, step: 0.05, label: 'Carriage height at closure', unit: 'mm',
    description: 'Half the housing height (h₀). Total floor-to-ceiling height is 2·h₀.',
  },
  pivot_offset: {
    min: 0, max: 10, step: 0.05, label: 'Pivot offset', unit: 'mm',
    description: 'Carriage pivot distance from the lead screw axis.',
  },
  stroke: {
    min: 0.4, max: 6, step: 0.05, label: 'Stroke', unit: 'mm',
    description: 'Carriage travel each way from closed (Y = 0).',
  },
  preload: {
    min: 0, max: 0.5, step: 0.01, label: 'Preload', unit: 'mm',
    description: 'Extra squeeze past closure at Y = 0 as a sealing margin.',
  },
  member_depth: {
    min: 0.4, max: 8, step: 0.1, label: 'Depth, out of plane', unit: 'mm',
    description: 'Out-of-plane thickness of the compliant part.',
  },
};

export interface SolverConstraints {
  pinch_ceiling_margin_mm: number;
  pinch_floor_margin_mm: number;
  min_shell_clearance_mm: number;
  min_pivot_clearance_mm: number;
  min_tube_clearance_mm: number;
  max_y0_flex_mm: number;
  max_rotation_deg: number;
  stress_limit_factor: number;
  motor_limited_stress?: boolean;
  require_no_stall_in_stroke?: boolean;
  junction_exclude_x?: [number, number] | null;
  junction_exclude_y?: [number, number] | null;
  target_pinch_from_top_mm?: number | null;
  target_attack_angle_deg?: number;
  anchor_symmetric?: boolean;
}

export const DEFAULT_CONSTRAINTS: SolverConstraints = {
  pinch_ceiling_margin_mm: 2.0,
  pinch_floor_margin_mm: 1.0,
  min_shell_clearance_mm: 0.05,
  min_pivot_clearance_mm: 0.05,
  min_tube_clearance_mm: 0.5,
  max_y0_flex_mm: 0.05,
  max_rotation_deg: 15,
  stress_limit_factor: 0.85,
  motor_limited_stress: true,
  require_no_stall_in_stroke: true,
  junction_exclude_x: null,
  junction_exclude_y: null,
  target_pinch_from_top_mm: 5.5,
  target_attack_angle_deg: 0,
  anchor_symmetric: true,
};

export const DEFAULT_CONTEXT_FIXED: ContextFixedMap = {
  closed_carriage_height: true,
  pivot_offset: true,
  pivot_inverted: true,
  stroke: true,
  preload: true,
  member_depth: true,
};

export const MEMBERS: { id: Member; title: string; color: string }[] = [
  { id: 'l', title: 'Member L', color: '#f59e0b' },
  { id: 'r', title: 'Member R', color: '#60a5fa' },
  { id: 'f', title: 'Foot', color: '#34d399' },
];

export const STORE = 'cam-sim.compliant.v1';
/** Same motor the other tabs start from, so Oscillate runs at the same carriage speed. */
export const MOTOR_RPM = 100;
export const SCREW_PITCH_MM = 0.5;
export const LOAD_FACTOR = 0.85;
export const CARRIAGE_SPEED_MM_S = (MOTOR_RPM * LOAD_FACTOR * SCREW_PITCH_MM) / 60;

/** Constant-speed carriage pose Y(d) over one 4·stroke round trip: 0 -> +stroke -> -stroke -> 0. */
export function triangleWaveY(distanceMm: number, stroke: number): number {
  const s = Math.max(0, stroke);
  if (s === 0) return 0;
  const period = 4 * s;
  const d = ((distanceMm % period) + period) % period;
  return d <= s ? d : d <= 3 * s ? 2 * s - d : d - 4 * s;
}

export interface ConstantSpeedStep {
  y: number;
  /** Exact GIF-quantized frame duration in ms (multiple of 10 ms, >= 20 ms). */
  delayMs: number;
  /** Travel direction: +1 toward +stroke, -1 toward -stroke. */
  dir: 1 | -1;
}

/**
 * Sample one full constant-speed carriage cycle (0 -> +stroke -> -stroke -> 0) at real speed `speedMmS`.
 * Frame count is a multiple of 4 so 0, +stroke, 0, and -stroke are hit exactly, and cumulative
 * centisecond rounding keeps total GIF duration equal to `4 * stroke / speedMmS` within 10 ms.
 */
export function buildConstantSpeedCycle(
  stroke: number,
  speedMmS = CARRIAGE_SPEED_MM_S,
  maxFrames = 120,
): ConstantSpeedStep[] {
  const s = Math.max(0.05, stroke);
  const v = speedMmS > 0 ? speedMmS : CARRIAGE_SPEED_MM_S;
  const totalCs = Math.max(8, ((4 * s) / v) * 100);
  const maxFeasibleN = Math.max(4, Math.floor(totalCs / 2 / 4) * 4);
  const rawN = Math.round(totalCs / 6.5);
  const targetN = Math.max(4, Math.min(maxFrames, maxFeasibleN, Math.max(16, rawN)));
  const frameCount = Math.max(4, Math.min(maxFeasibleN, Math.round(targetN / 4) * 4));
  const quarter = frameCount / 4;

  const steps: ConstantSpeedStep[] = [];
  let prevCs = 0;
  for (let i = 0; i < frameCount; i++) {
    const idealNext = Math.round(((i + 1) * totalCs) / frameCount);
    const nextCs = i === frameCount - 1
      ? Math.max(prevCs + 2, Math.round(totalCs))
      : Math.max(prevCs + 2, idealNext);
    const delayMs = (nextCs - prevCs) * 10;
    prevCs = nextCs;

    const d = (i / frameCount) * 4 * s;
    const y = triangleWaveY(d, s);
    const dir: 1 | -1 = i < quarter || i >= 3 * quarter ? 1 : -1;
    steps.push({ y, delayMs, dir });
  }
  return steps;
}

export interface Line {
  x: number[]; y: number[];
  x_per_y: number[]; y_per_y: number[];
  x_per_n: number[]; y_per_n: number[];
  thickness: number;
}

export interface CompliantResult {
  feasible: boolean;
  passes: boolean;
  message: string;
  Y_positions: number[];
  flow_a: (number | null)[];
  flow_b?: (number | null)[];
  gap_a?: (number | null)[];
  gap_b?: (number | null)[];
  gap_rigid_a?: (number | null)[];
  closed_gap?: number;
  full_open_gap?: number;
  flow_slope_mean: number | null;
  flow_slope_max: number | null;
  max_stress_mpa: number | null;
  stress_margin: number | null;
  plastic_ok: boolean;
  shell_ok: boolean;
  pivot_ok: boolean;
  pinch_ok?: boolean;
  rotation_ok?: boolean;
  tube_ok?: boolean;
  crossing_ok?: boolean;
  shell_clearance_mm: number | null;
  pivot_clearance_mm: number | null;
  tube_clearance_mm?: number | null;
  pinch_ceiling_margin_mm?: number | null;
  max_rotation_deg: number | null;
  wall_x: number;
  pivot_height_y0: number;
  pinch_x: number;
  pinch_contact_x?: number;
  travel_sign: number;
  force_a: (number | null)[];
  force_b?: (number | null)[];
  stress_a?: (number | null)[];
  stress_b?: (number | null)[];
  lines: Record<Member, Line>;
  anchor: Pt;
  junction: Pt;
  pinch: Pt;
  pivot: Pt;
  kinematic_gain?: number | null;
  attack_angle_deg?: number | null;
  dx_at_025_mm?: number | null;
  y_open_mm?: number | null;
  y_90_mm?: number | null;
  sealed_at_y0?: boolean;
  flex_y0_mm?: number | null;
  gap_y0_mm?: number | null;
  time_ms?: number[];
  y_time?: number[];
  flow_in_l_min?: number[];
  flow_out_l_min?: number[];
  chamber_kpa?: number[];
  volume_in_ml?: number;
  volume_out_ml?: number;
  chamber_t50_ms?: number | null;
  chamber_t90_ms?: number | null;
  chamber_t100_ms?: number | null;
  chamber_cycle_freq_hz?: number | null;
  chamber_bandwidth_hz?: number | null;
  motor_ok?: boolean;
  thrust?: (number | null)[];
  thrust_available_n?: number | null;
  peak_thrust_op_n?: number | null;
  mean_thrust_op_n?: number | null;
  peak_torque_op_mnm?: number | null;
  motor_margin?: number | null;
  screw_self_locking?: boolean;
  stall_y_mm?: number | null;
  yield_y_mm?: number | null;
  thrust_to_yield_n?: number | null;
  torque_to_yield_mnm?: number | null;
  max_stress_op_mpa?: number | null;
  max_stress_to_stall_mpa?: number | null;
  energy_stroke_mj?: number | null;
  energy_cycle_mj?: number | null;
  overtravel_y?: number[];
  overtravel_thrust?: (number | null)[];
  overtravel_force_a?: (number | null)[];
  overtravel_force_b?: (number | null)[];
  overtravel_stress_a?: (number | null)[];
  overtravel_stress_b?: (number | null)[];
}

export interface Runner {
  score?: number | null;
  slope: number | null;
  dx_at_025_mm?: number | null;
  kinematic_gain?: number | null;
  attack_angle_deg?: number | null;
  y_open_mm?: number | null;
  y_90_mm?: number | null;
  sealed_at_y0?: boolean;
  flex_y0_mm?: number | null;
  gap_y0_mm?: number | null;
  max_stress_mpa: number | null;
  max_rotation_deg?: number | null;
  shell_clearance_mm: number | null;
  pivot_clearance_mm: number | null;
  pinch_ceiling_margin_mm?: number | null;
  chamber_t50_ms?: number | null;
  chamber_t90_ms?: number | null;
  chamber_t100_ms?: number | null;
  chamber_cycle_freq_hz?: number | null;
  chamber_bandwidth_hz?: number | null;
  energy_cycle_mj?: number | null;
  energy_stroke_mj?: number | null;
  peak_thrust_op_n?: number | null;
  peak_torque_op_mnm?: number | null;
  thrust_available_n?: number | null;
  thrust_to_yield_n?: number | null;
  torque_to_yield_mnm?: number | null;
  stall_y_mm?: number | null;
  yield_y_mm?: number | null;
  motor_margin?: number | null;
  motor_ok?: boolean;
  max_stress_op_mpa?: number | null;
  max_stress_to_stall_mpa?: number | null;
  stroke?: number;
  pivot_inverted?: boolean;
  params: Partial<CompliantParams>;
}

export type SolverGoal = 'dx_at_025' | 'pass_freq_bw' | 'min_energy' | 'min_open_stroke' | 'flow_slope' | 'trajectory_target';

export const ALL_SOLVER_GOALS: SolverGoal[] = ['dx_at_025', 'pass_freq_bw', 'min_energy', 'trajectory_target', 'min_open_stroke', 'flow_slope'];

export type SolverMethod = 'hybrid' | 'brute_force' | 'evolutionary' | 'local_refine';

export const ALL_SOLVER_METHODS: SolverMethod[] = ['hybrid', 'brute_force', 'evolutionary', 'local_refine'];

export const BRUTE_FORCE_CONSERVATIVE_RATE = 45; // evals/s conservative floor for upper-bound time estimates

export const SOLVER_METHOD_META: Record<SolverMethod, {
  label: string;
  short: string;
  description: string;
  defaults: Record<string, number | string>;
}> = {
  hybrid: {
    label: 'Hybrid (LHS + Gradient + Nelder-Mead)',
    short: 'Hybrid',
    description: 'Global Latin Hypercube waves combined with multi-start projected gradient ascent and Nelder-Mead simplex polish. Best all-rounder.',
    defaults: { lhs_batch_size: 48, refine_seeds: 3, polish_evals: 40 },
  },
  brute_force: {
    label: 'Brute Force (Global Sweep)',
    short: 'Brute Force',
    description: 'Pre-calibrated unbiased space-filling sweep (single global LHS fitted to time budget, or exact k^d Cartesian grid).',
    defaults: { sampling: 'lhs', steps_per_var: 3 },
  },
  evolutionary: {
    label: 'Differential Evolution (DE/rand/1/bin)',
    short: 'Evolutionary',
    description: 'Population-based evolutionary search with vector mutation and crossover. Excels on multimodal, non-convex topologies.',
    defaults: { pop_size: 28, mutation_f: 0.7, crossover_cr: 0.8 },
  },
  local_refine: {
    label: 'Local Polish (from Current Design)',
    short: 'Local Polish',
    description: 'Starts directly from your current Explorer shape and dedicates 100% of the budget to local gradient + Nelder-Mead fine-tuning.',
    defaults: { search_radius: 0.15, restarts: 4 },
  },
};

export interface SolverMethodConfig {
  method: SolverMethod;
  params: Record<SolverMethod, Record<string, number | string>>;
}

export const DEFAULT_SOLVER_METHOD_CONFIG: SolverMethodConfig = {
  method: 'hybrid',
  params: {
    hybrid: { ...SOLVER_METHOD_META.hybrid.defaults },
    brute_force: { ...SOLVER_METHOD_META.brute_force.defaults },
    evolutionary: { ...SOLVER_METHOD_META.evolutionary.defaults },
    local_refine: { ...SOLVER_METHOD_META.local_refine.defaults },
  },
};

export interface SolverGoalConfig {
  selected: SolverGoal[];
  useWeights: boolean;
  weights: Record<SolverGoal, number>;
}

export const DEFAULT_SOLVER_GOAL_CONFIG: SolverGoalConfig = {
  selected: ['dx_at_025'],
  useWeights: false,
  weights: {
    dx_at_025: 50,
    pass_freq_bw: 50,
    min_energy: 50,
    trajectory_target: 50,
    min_open_stroke: 50,
    flow_slope: 50,
  },
};

export const SOLVER_GOAL_META: Record<SolverGoal, { label: string; short: string; description: string }> = {
  dx_at_025: {
    label: 'Max ΔX @ Y = 0.25 mm',
    short: 'ΔX @ 0.25',
    description: 'Maximizes effective horizontal pinch opening (mm) for 0.25 mm of carriage travel under tube load.',
  },
  pass_freq_bw: {
    label: 'Max Pass freq / BW (-3 dB)',
    short: 'Pass freq / BW',
    description: 'Maximizes full pneumatic chamber cycle frequency (1 / 2·T₁₀₀) and -3 dB bandwidth (0.35 / T₁₀₀) by minimizing 0 → 100% inflation time.',
  },
  min_energy: {
    label: 'Min actuation energy',
    short: 'Min energy',
    description: 'Minimizes motor shaft work per full valve cycle (mJ) over ±stroke from vertical screw thrust and lead-screw efficiency.',
  },
  trajectory_target: {
    label: 'Match pinch height & attack angle',
    short: 'Target P & α',
    description: 'Minimizes trajectory error to your target pinch depth from the top of the frame and attack angle (-90° to +90°).',
  },
  min_open_stroke: {
    label: 'Fastest full open (min Y₉₀)',
    short: 'Min Y₉₀',
    description: 'Minimizes carriage travel from Y = 0 to reach 90% of full bore flow (small deadband + steep slope).',
  },
  flow_slope: {
    label: 'Max mean flow slope',
    short: 'dQ/dY',
    description: 'Maximizes average static flow slope (L/min per mm) across the rising open region.',
  },
};

export const TIME_BUDGET_PRESETS: { label: string; seconds: number; hint: string }[] = [
  { label: '10 s', seconds: 10, hint: 'Quick preview' },
  { label: '1 min', seconds: 60, hint: 'Fast search' },
  { label: '5 min', seconds: 300, hint: 'Deep search' },
  { label: '15 min', seconds: 900, hint: 'Thorough' },
  { label: '1 h', seconds: 3600, hint: 'Exhaustive' },
];

export interface RejectionStat {
  key: string;
  count: number;
  pct_of_tested: number;
  pct_of_rejected: number;
  sole_blocker: number;
}

export interface BoundHit {
  key: string;
  side: 'min' | 'max';
  value: number;
  lo: number;
  hi: number;
}

export interface CoverageVar {
  key: string;
  lo: number;
  hi: number;
  tested_bins: number[];
  feasible_bins: number[];
  best_val: number | null;
}

export interface ScatterPoint {
  dx_025: number;
  stress: number;
  slope: number;
  feasible: boolean;
  reason: string | null;
}

export interface ConvergencePoint {
  t: number;
  tested: number;
  score: number;
  dx_025: number | null;
  slope: number | null;
  energy_cycle_mj?: number | null;
}

export interface PreviewFrame {
  n: number;
  t: number;
  ok: boolean;
  best: boolean;
  reason: string | null;
  dx: number | null;
  stress: number | null;
  score: number | null;
  wall_x: number;
  h0: number;
  tube_od: number;
  tube_id: number;
  piv_off: number;
  a: [number, number];
  j: [number, number];
  v: [number, number];
  p: [number, number];
  hl: [number, number, number, number];
  hr: [number, number, number, number];
  hf: [number, number, number, number];
  th: [number, number, number];
}

export interface SolveSummary {
  phase: string;
  wave: number;
  method?: SolverMethod;
  method_params?: Record<string, number | string>;
  goal: SolverGoal;
  goal_weights?: Record<string, number>;
  tested: number;
  feasible: number;
  rejected: number;
  elapsed_s: number;
  time_budget_s: number;
  progress: number;
  evals_per_sec: number;
  best_score: number | null;
  best_dx_at_025_mm: number | null;
  best_slope: number | null;
  best_y_90_mm: number | null;
  best_attack_angle_deg?: number | null;
  best_stress_mpa: number | null;
  best_chamber_t100_ms?: number | null;
  best_chamber_cycle_freq_hz?: number | null;
  best_chamber_bandwidth_hz?: number | null;
  best_energy_cycle_mj?: number | null;
  best_peak_thrust_op_n?: number | null;
  best_peak_torque_op_mnm?: number | null;
  best_stall_y_mm?: number | null;
  rejection_stats: RejectionStat[];
  bound_hits: BoundHit[];
  free_vars: string[];
  fixed_vars: string[];
  pivot_sides: boolean[];
  active_constraints: {
    member_strength_mpa: number;
    stress_limit_factor?: number;
    allowable_stress_mpa?: number;
    motor_limited_stress?: boolean;
    require_no_stall_in_stroke?: boolean;
    motor_torque_mnm?: number;
    thrust_available_n?: number | null;
    min_shell_clearance_mm: number;
    min_pivot_clearance_mm: number;
    min_tube_clearance_mm?: number;
    pinch_ceiling_margin_mm: number;
    pinch_floor_margin_mm: number;
    max_rotation_deg: number;
    stroke_fixed: boolean;
    stroke_mm: number;
    anchor_symmetric?: boolean;
  };
  coverage: CoverageVar[];
  scatter: ScatterPoint[];
  convergence: ConvergencePoint[];
  runners: Runner[];
  preview_frames?: PreviewFrame[];
  preview_timeline?: PreviewFrame[];
  best_preview?: PreviewFrame | null;
}

export interface SolveJobState {
  job_id: string;
  experiment_id: string;
  name: string;
  note: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  goal: SolverGoal;
  goal_weights?: Record<string, number>;
  method?: SolverMethod;
  method_params?: Record<string, number | string>;
  time_budget_s: number;
  summary: SolveSummary | null;
  found: boolean;
  params: Partial<CompliantParams> | null;
  result: CompliantResult | null;
  runners: Runner[];
  message: string;
  error: string | null;
}

export interface SolveExperimentSummary {
  id: string;
  name: string;
  note: string;
  status: string;
  goal: SolverGoal;
  time_budget_s: number;
  elapsed_s: number;
  tested: number;
  feasible: number;
  best_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChartScaleSettings {
  lockX: boolean;
  xRangeMm: number;
  lockFlowY: boolean;
  flowYMax: number;
}

export const DEFAULT_CHART_SCALES: ChartScaleSettings = {
  lockX: true,
  xRangeMm: 2.0,
  lockFlowY: true,
  flowYMax: 15,
};

export interface Material {
  name: string;
  modulus_mpa: number;
  strength_mpa: number;
  builtin: boolean;
}

export const BUILTIN_MATERIALS: Material[] = [
  { name: 'PETG Basic (bamb)', modulus_mpa: 1950, strength_mpa: 75, builtin: true },
  { name: 'PETG Translucent (bamb)', modulus_mpa: 1610, strength_mpa: 68, builtin: true },
  { name: 'PLA Basic (bamb)', modulus_mpa: 2750, strength_mpa: 76, builtin: true },
  { name: 'ABS (bamb)', modulus_mpa: 1880, strength_mpa: 62, builtin: true },
];

export type CompliantChartKey = 'flow' | 'gap' | 'force' | 'stress' | 'chamber' | 'section';
export type CompliantChartSettings = Record<CompliantChartKey, ChartDomainSettings>;

const AUTO_DOMAIN: ChartDomainSettings = { autoX: true, autoY: true, xMin: -2, xMax: 2, yMin: 0, yMax: 12 };
export const DEFAULT_CHART_SETTINGS: CompliantChartSettings = {
  flow: AUTO_DOMAIN,
  gap: AUTO_DOMAIN,
  force: { ...AUTO_DOMAIN, yMin: 0.1, yMax: 100 },
  stress: AUTO_DOMAIN,
  chamber: { ...AUTO_DOMAIN, xMin: 0 },
  section: AUTO_DOMAIN,
};

export function defaultBounds(): Record<ShapeKey, [number, number]> {
  const out = {} as Record<ShapeKey, [number, number]>;
  for (const key of SHAPE_KEYS) {
    const value = COMPLIANT_DEFAULTS[key] as number;
    const { min, max } = LIMITS[key];
    const span = key.endsWith('thickness') ? 0.4 : key.includes('_u') ? 0.15 : key.includes('_v') ? 1.5 : 1.5;
    out[key] = [Math.max(min, value - span), Math.min(max, value + span)];
  }
  return out;
}

export function defaultContextBounds(): Record<ContextVarKey, [number, number]> {
  return {
    closed_carriage_height: [6, 12],
    pivot_offset: [2.5, 6],
    stroke: [0.8, 3.0],
    preload: [0.05, 0.25],
    member_depth: [1.5, 5.0],
  };
}

export interface CompliantProfileData {
  params: CompliantParams;
  bounds: Record<ShapeKey, [number, number]>;
  contextBounds: Record<ContextVarKey, [number, number]>;
  contextFixed: ContextFixedMap;
  constraints: SolverConstraints;
  chartSettings: CompliantChartSettings;
  chartScales?: ChartScaleSettings;
  quadrantMap?: QuadrantMap;
}

export interface StoredCompliantState extends CompliantProfileData {
  profile: string | null;
  chartScales: ChartScaleSettings;
  quadrantMap: QuadrantMap;
  goalConfig: SolverGoalConfig;
  methodConfig: SolverMethodConfig;
  timeBudgetS: number;
}

function resolveMethodConfig(raw: unknown): SolverMethodConfig {
  const base: SolverMethodConfig = {
    method: DEFAULT_SOLVER_METHOD_CONFIG.method,
    params: {
      hybrid: { ...SOLVER_METHOD_META.hybrid.defaults },
      brute_force: { ...SOLVER_METHOD_META.brute_force.defaults },
      evolutionary: { ...SOLVER_METHOD_META.evolutionary.defaults },
      local_refine: { ...SOLVER_METHOD_META.local_refine.defaults },
    },
  };
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  if (ALL_SOLVER_METHODS.includes(obj.method as SolverMethod)) base.method = obj.method as SolverMethod;
  if (obj.params && typeof obj.params === 'object') {
    const pm = obj.params as Record<string, unknown>;
    for (const m of ALL_SOLVER_METHODS) {
      if (pm[m] && typeof pm[m] === 'object') {
        base.params[m] = { ...base.params[m], ...(pm[m] as Record<string, number | string>) };
      }
    }
  }
  return base;
}

function resolveGoalConfig(raw: unknown): SolverGoalConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOLVER_GOAL_CONFIG, weights: { ...DEFAULT_SOLVER_GOAL_CONFIG.weights } };
  const obj = raw as Record<string, unknown>;
  const sel = Array.isArray(obj.selected)
    ? obj.selected.filter((g): g is SolverGoal => ALL_SOLVER_GOALS.includes(g as SolverGoal))
    : DEFAULT_SOLVER_GOAL_CONFIG.selected;
  const weights = { ...DEFAULT_SOLVER_GOAL_CONFIG.weights };
  if (obj.weights && typeof obj.weights === 'object') {
    const wm = obj.weights as Record<string, unknown>;
    for (const g of ALL_SOLVER_GOALS) {
      if (typeof wm[g] === 'number' && Number.isFinite(wm[g]) && wm[g] >= 0) weights[g] = wm[g] as number;
    }
  }
  return {
    selected: sel.length > 0 ? sel : ['dx_at_025'],
    useWeights: typeof obj.useWeights === 'boolean' ? obj.useWeights : false,
    weights,
  };
}

function resolveQuadrantMap(
  raw: unknown,
  params: CompliantParams,
  bounds: Record<ShapeKey, [number, number]>,
): QuadrantMap {
  const fallback = defaultQuadrantMap(params, bounds);
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const out = { ...fallback };
  for (const key of QUADRANT_KEYS) {
    const entry = obj[key];
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const qs = Array.isArray(e.quadrants)
        ? e.quadrants.map(Number).filter((q): q is Quadrant => q === 1 || q === 2 || q === 3 || q === 4)
        : fallback[key].quadrants;
      const r = typeof e.radius === 'number' && Number.isFinite(e.radius) && e.radius > 0
        ? e.radius
        : fallback[key].radius;
      out[key] = { quadrants: qs, radius: r };
    }
  }
  return out;
}

function resolveChartScales(raw: unknown): ChartScaleSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChartScaleSettings>;
  return {
    lockX: typeof obj.lockX === 'boolean' ? obj.lockX : DEFAULT_CHART_SCALES.lockX,
    xRangeMm: typeof obj.xRangeMm === 'number' && obj.xRangeMm > 0 ? obj.xRangeMm : DEFAULT_CHART_SCALES.xRangeMm,
    lockFlowY: typeof obj.lockFlowY === 'boolean' ? obj.lockFlowY : DEFAULT_CHART_SCALES.lockFlowY,
    flowYMax: typeof obj.flowYMax === 'number' && obj.flowYMax > 0 ? obj.flowYMax : DEFAULT_CHART_SCALES.flowYMax,
  };
}

function resolveChartSettings(raw: unknown): CompliantChartSettings {
  const map = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<CompliantChartKey, Partial<ChartDomainSettings>>>;
  const out = {} as CompliantChartSettings;
  for (const key of Object.keys(DEFAULT_CHART_SETTINGS) as CompliantChartKey[]) {
    out[key] = { ...DEFAULT_CHART_SETTINGS[key], ...map[key] };
  }
  return out;
}

/** A stored compliant profile's parameters, bounds, constraints and chart settings, completed for fields added since it was saved. */
export function fromCompliantProfilePayload(raw: Record<string, unknown>): CompliantProfileData {
  const bounds = defaultBounds();
  const contextBounds = defaultContextBounds();
  const contextFixed: ContextFixedMap = { ...DEFAULT_CONTEXT_FIXED };
  const constraints: SolverConstraints = { ...DEFAULT_CONSTRAINTS };
  const rawParams = raw.params && typeof raw.params === 'object' ? raw.params as Partial<CompliantParams> : {};
  const params: CompliantParams = { ...COMPLIANT_DEFAULTS, ...rawParams };
  params.tube_model = rawParams.tube_model === 'fem' ? 'fem' : 'simple';
  const rawBounds = raw.bounds && typeof raw.bounds === 'object' ? raw.bounds as Record<string, unknown> : {};
  for (const key of SHAPE_KEYS) {
    const pair = rawBounds[key];
    if (Array.isArray(pair) && pair.length === 2) bounds[key] = [Number(pair[0]), Number(pair[1])];
  }
  const rawContextBounds = raw.contextBounds && typeof raw.contextBounds === 'object' ? raw.contextBounds as Record<string, unknown> : {};
  for (const key of CONTEXT_VAR_KEYS) {
    const pair = rawContextBounds[key];
    if (Array.isArray(pair) && pair.length === 2) contextBounds[key] = [Number(pair[0]), Number(pair[1])];
  }
  if (raw.contextFixed && typeof raw.contextFixed === 'object') {
    const map = raw.contextFixed as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_CONTEXT_FIXED) as ContextToggleKey[]) {
      if (typeof map[key] === 'boolean') contextFixed[key] = map[key] as boolean;
    }
  }
  if (raw.constraints && typeof raw.constraints === 'object') {
    const map = raw.constraints as Record<string, unknown>;
    const numKeys = [
      'pinch_ceiling_margin_mm', 'pinch_floor_margin_mm',
      'min_shell_clearance_mm', 'min_pivot_clearance_mm', 'min_tube_clearance_mm', 'max_y0_flex_mm', 'max_rotation_deg',
      'stress_limit_factor',
      'target_pinch_from_top_mm', 'target_attack_angle_deg',
    ] as const;
    for (const key of numKeys) {
      if (typeof map[key] === 'number' && Number.isFinite(map[key])) {
        constraints[key] = map[key] as number;
      }
    }
    for (const key of ['junction_exclude_x', 'junction_exclude_y'] as const) {
      const pair = map[key];
      if (Array.isArray(pair) && pair.length === 2 && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1]))) {
        constraints[key] = [Number(pair[0]), Number(pair[1])];
      }
    }
    if (typeof map.anchor_symmetric === 'boolean') {
      constraints.anchor_symmetric = map.anchor_symmetric;
    }
    if (typeof map.motor_limited_stress === 'boolean') {
      constraints.motor_limited_stress = map.motor_limited_stress;
    }
    if (typeof map.require_no_stall_in_stroke === 'boolean') {
      constraints.require_no_stall_in_stroke = map.require_no_stall_in_stroke;
    }
  }
  const chartSettings = resolveChartSettings(raw.chartSettings ?? raw.chart_settings);
  const chartScales = resolveChartScales(raw.chartScales ?? raw.chart_scales);
  const quadrantMap = resolveQuadrantMap(raw.quadrantMap ?? raw.quadrant_map, params, bounds);
  return { params, bounds, contextBounds, contextFixed, constraints, chartSettings, chartScales, quadrantMap };
}

export function loadStore(): StoredCompliantState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const parsed = fromCompliantProfilePayload(obj);
      return {
        ...parsed,
        chartScales: parsed.chartScales ?? { ...DEFAULT_CHART_SCALES },
        quadrantMap: parsed.quadrantMap ?? defaultQuadrantMap(parsed.params, parsed.bounds),
        goalConfig: resolveGoalConfig(obj.goalConfig),
        methodConfig: resolveMethodConfig(obj.methodConfig),
        timeBudgetS: typeof obj.timeBudgetS === 'number' && Number.isFinite(obj.timeBudgetS) && obj.timeBudgetS >= 1 ? obj.timeBudgetS : 60,
        profile: typeof obj.profile === 'string' ? obj.profile : null,
      };
    }
  } catch { /* keep defaults */ }
  const params = { ...COMPLIANT_DEFAULTS };
  const bounds = defaultBounds();
  return {
    params,
    bounds,
    contextBounds: defaultContextBounds(),
    contextFixed: { ...DEFAULT_CONTEXT_FIXED },
    constraints: { ...DEFAULT_CONSTRAINTS },
    chartSettings: DEFAULT_CHART_SETTINGS,
    chartScales: { ...DEFAULT_CHART_SCALES },
    quadrantMap: defaultQuadrantMap(params, bounds),
    goalConfig: { ...DEFAULT_SOLVER_GOAL_CONFIG, weights: { ...DEFAULT_SOLVER_GOAL_CONFIG.weights } },
    methodConfig: resolveMethodConfig(null),
    timeBudgetS: 60,
    profile: null,
  };
}

export function leftNormal(s: Pt, e: Pt): { n: Pt; length: number } {
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { n: [0, 1], length: 0 };
  return { n: [-dy / length, dx / length], length };
}

export function bezier(s: Pt, e: Pt, u1: number, v1: number, u2: number, v2: number, n = 13): Pt[] {
  const { n: normal } = leftNormal(s, e);
  const h = (u: number, v: number): Pt => [
    s[0] + u * (e[0] - s[0]) + v * normal[0],
    s[1] + u * (e[1] - s[1]) + v * normal[1],
  ];
  let a = u1, b = u2, va = v1, vb = v2;
  if (a > b) { a = u2; b = u1; va = v2; vb = v1; }
  const p1 = h(a, va), p2 = h(b, vb);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), o = 1 - t;
    pts.push([
      o ** 3 * s[0] + 3 * o ** 2 * t * p1[0] + 3 * o * t ** 2 * p2[0] + t ** 3 * e[0],
      o ** 3 * s[1] + 3 * o ** 2 * t * p1[1] + 3 * o * t ** 2 * p2[1] + t ** 3 * e[1],
    ]);
  }
  return pts;
}

/** Centerline Y of the anchor A at rest (Y = 0), shifted by l_thickness / 2 so its contour is tangent to the bottom surface (y = 0). */
export function anchorY(p: CompliantParams): number {
  return p.l_thickness / 2;
}

/** World-space anchor center A at rest (Y = 0), tangent to the bottom surface (y = 0). */
export function anchorPoint(p: CompliantParams): Pt {
  return [-p.anchor_distance, anchorY(p)];
}

/** Return [aLo, aHi] with 0 <= aLo <= aHi representing [-aHi, -aLo] U [aLo, aHi] around center. */
export function anchorSymmetricRange(range: [number, number]): [number, number] {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  if (lo >= 0) return [lo, hi];
  if (hi <= 0) return [-hi, -lo];
  return [0, Math.max(-lo, hi)];
}

/** Allowable stress limit in MPa after applying the solver safety factor (default 1.0 when unset). */
export function allowableStressMpa(memberStrengthMpa: number, constraints?: SolverConstraints | null): number {
  const factor = constraints?.stress_limit_factor ?? 1;
  return memberStrengthMpa * Math.min(1, Math.max(0.05, factor));
}

/** Max vertical lead-screw thrust (N) before motor stall, matching backend `_screw_factors`. */
export function screwThrustAvailableN(
  p: Pick<CompliantParams, 'motor_torque_mnm' | 'screw_diameter' | 'lead_screw_pitch' | 'screw_friction'>,
): number | null {
  const dm = p.screw_diameter - 0.6495 * p.lead_screw_pitch;
  if (dm <= 0 || p.lead_screw_pitch <= 0 || p.motor_torque_mnm < 0) return null;
  const helix = Math.atan(p.lead_screw_pitch / (Math.PI * dm));
  const friction = Math.atan(Math.max(p.screw_friction, 0) / Math.cos(Math.PI / 6));
  const angleRaise = Math.min(helix + friction, Math.PI / 2 - 1e-4);
  const kRaise = (dm / 2) * Math.tan(angleRaise);
  return kRaise > 1e-12 ? p.motor_torque_mnm / kRaise : null;
}

/** Outer contact surface X of the foot facing the left wall (-wall_x) at rest (Y = 0). */
export function pinchContactX(p: CompliantParams): number {
  const wall = p.tube_center_x + p.tube_od / 2;
  const opening = p.tube_model === 'simple' ? p.compliance * p.input_pressure_kpa * 1e-3 : 0;
  const closed = (p.tube_od - p.tube_id) - opening;
  return (closed - p.preload) - wall;
}

/** Centerline X of the foot tip P at rest (Y = 0), shifted by f_thickness / 2 so the contact face aligns. */
export function pinchX(p: CompliantParams): number {
  return pinchContactX(p) + p.f_thickness / 2;
}

/** Effective pinch height Y at Y = 0: locked to 2·h₀ - target_pinch_from_top_mm when a target is active. */
export function effectivePinchY(p: CompliantParams, constraints?: SolverConstraints | null): number {
  if (constraints?.target_pinch_from_top_mm != null && Number.isFinite(constraints.target_pinch_from_top_mm)) {
    return 2 * p.closed_carriage_height - constraints.target_pinch_from_top_mm;
  }
  return p.pinch_y;
}

export function interp(y: number, ys: number[], vs: (number | null)[] | undefined): number {
  if (!ys.length || !vs || !vs.length) return 0;
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    if ((y - a) * (y - b) <= 0 && a !== b) {
      const t = (y - a) / (b - a);
      const va = vs[i] ?? 0, vb = vs[i + 1] ?? 0;
      return va + t * (vb - va);
    }
  }
  return vs[0] ?? 0;
}

export function interpNullable(y: number, ys: number[], vs: (number | null)[] | undefined): number | null {
  if (!ys.length || !vs || !vs.length) return null;
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    if ((y - a) * (y - b) <= 0 && a !== b) {
      const va = vs[i], vb = vs[i + 1];
      if (va == null || vb == null) return null;
      return va + ((y - a) / (b - a)) * (vb - va);
    }
  }
  return vs[0] ?? null;
}

export function deflected(line: Line, y: number, force: number): Pt[] {
  return line.x.map((x, i) => [
    x + line.x_per_y[i] * y + line.x_per_n[i] * force,
    line.y[i] + line.y_per_y[i] * y + line.y_per_n[i] * force,
  ] as Pt);
}

export const mm = (v: number | null | undefined, digits = 2) =>
  (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} mm`);

/** The foot sample nearest that wall. A constant thickness makes the nearest centre the contact. */
export function nearestToWall(pts: Pt[], sign: 1 | -1): Pt {
  return pts.reduce((best, p) => (sign * p[0] > sign * best[0] ? p : best));
}

export function shapeLabel(key: ShapeKey): string {
  const who = key.startsWith('l_') ? 'L' : key.startsWith('r_') ? 'R' : key.startsWith('f_') ? 'foot' : '';
  return who ? `${LIMITS[key].label}, ${who}` : LIMITS[key].label;
}

/** Sample a cubic Bézier curve from s -> e with control points [h1x, h1y, h2x, h2y]. */
export function sampleCubicBezier(
  s: Pt,
  h: [number, number, number, number],
  e: Pt,
  n = 15,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const o = 1 - t;
    pts.push([
      o ** 3 * s[0] + 3 * o ** 2 * t * h[0] + 3 * o * t ** 2 * h[2] + t ** 3 * e[0],
      o ** 3 * s[1] + 3 * o ** 2 * t * h[1] + 3 * o * t ** 2 * h[3] + t ** 3 * e[1],
    ]);
  }
  return pts;
}

/**
 * Closed rounded-cap outer contour polygon around a polyline of given `thickness`.
 * Used to render hollow dashed outlines of compliant bar members without filling their interior.
 */
export function strokeOutlinePath(rawPts: Pt[], thickness: number, capSteps = 6): Pt[] {
  const r = thickness / 2;
  if (rawPts.length < 2 || r <= 1e-6) return [];
  const pts: Pt[] = [rawPts[0]];
  for (let i = 1; i < rawPts.length; i++) {
    const prev = pts[pts.length - 1];
    if (Math.hypot(rawPts[i][0] - prev[0], rawPts[i][1] - prev[1]) > 1e-5) {
      pts.push(rawPts[i]);
    }
  }
  const n = pts.length;
  if (n < 2) return [];

  const unit = (dx: number, dy: number): Pt => {
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? [dx / len, dy / len] : [1, 0];
  };

  const normals: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let tx = 0;
    let ty = 0;
    if (i === 0) {
      [tx, ty] = unit(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    } else if (i === n - 1) {
      [tx, ty] = unit(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]);
    } else {
      const t1 = unit(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const t2 = unit(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      [tx, ty] = unit(t1[0] + t2[0], t1[1] + t2[1]);
    }
    normals.push([-ty, tx]);
  }

  const out: Pt[] = [];
  // Left boundary forward
  for (let i = 0; i < n; i++) {
    out.push([pts[i][0] + r * normals[i][0], pts[i][1] + r * normals[i][1]]);
  }
  // End cap arc (+normal -> +tangent -> -normal)
  const endN = normals[n - 1];
  const endAng0 = Math.atan2(endN[1], endN[0]);
  for (let k = 1; k < capSteps; k++) {
    const ang = endAng0 - (k / capSteps) * Math.PI;
    out.push([pts[n - 1][0] + r * Math.cos(ang), pts[n - 1][1] + r * Math.sin(ang)]);
  }
  // Right boundary backward
  for (let i = n - 1; i >= 0; i--) {
    out.push([pts[i][0] - r * normals[i][0], pts[i][1] - r * normals[i][1]]);
  }
  // Start cap arc (-normal -> -tangent -> +normal)
  const startN = normals[0];
  const startAng0 = Math.atan2(-startN[1], -startN[0]);
  for (let k = 1; k < capSteps; k++) {
    const ang = startAng0 - (k / capSteps) * Math.PI;
    out.push([pts[0][0] + r * Math.cos(ang), pts[0][1] + r * Math.sin(ang)]);
  }
  return out;
}
