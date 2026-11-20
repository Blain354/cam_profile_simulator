import { FlowParticles, FlowParticlesSwitch } from './FlowParticles';
import { sideBore, tubeProfile } from './lib/tubeSide';
import type { Pt } from './lib/tubeSide';
import { useTubeSweep } from './lib/tubeSweep';
import { Button, Input, Modal } from '@blain-projects/ui';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { Pause, Play, RefreshCw, Save, Settings, Target, Trash2, UploadCloud } from 'lucide-react';
import { getProfile, stableJson, useReportProfileState } from './lib/profiles';
import type { ProfileHandle, ProfileState } from './lib/profiles';
import { Accordion, ParameterSlider, StatRow, apiFetch } from './components';
import type { SubTab } from './SubTabs';
import type { ChartDomainSettings } from './components';
import { ChartCard } from './ChartCard';
import { chartDomain, sameDomainSettings } from './lib/chartDomain';
import { formatKpa, legacyPsiToKpa } from './lib/pressure';
import { TubeModelControls, TubeSectionCard } from './TubeModel';
import { DEFAULT_SHORE_A, DEFAULT_TUBE_MODEL, cleanTubeModel } from './lib/tubeModel';
import type { TubeModel } from './lib/tubeModel';

// ─── Types (mirror backend/linkage.py) ───────────────────────────

export type LinkageKind = 'elbow' | 'lever' | 'pendulum';

export interface LinkageParams {
  linkage_type: LinkageKind;
  bar1_length: number;
  bar2_length: number;
  lever_length: number;
  foot_length: number;
  foot_angle_deg: number;
  pad_length: number;
  fixed_height: number;
  anchor_distance: number;
  pivot_offset: number;
  tube_center_x: number;
  pin_diameter: number;
  preload: number;
  stroke: number;
  target_exponent: number;
  tube_id: number;
  tube_od: number;
  input_pressure_kpa: number;
  compliance: number;
  tube_model: TubeModel;
  tube_shore_a: number;
  chamber_volume_ml: number;
  motor_speed: number;
  lead_screw_pitch: number;
  speed_factor: number;
  motor_torque_mnm: number;
  screw_diameter: number;
  screw_friction: number;
  member_modulus_mpa: number;
  member_width: number;
  member_thickness: number;
  contact_deformation: boolean;
  link_curved: boolean;
  compliant: boolean;
  carriage_clamped: boolean;
  carriage_pin_diameter: number;
  carriage_pin_length: number;
  member_strength_mpa: number;
  carriage_pin_strength_mpa: number;
}

/** A dimension the optimizer searches; its range is `${key}_min` to `${key}_max` in the search. */
type SearchVar = 'bar1' | 'bar2' | 'lever' | 'anchor' | 'foot' | 'foot_angle';
const SEARCH_VARS: SearchVar[] = ['bar1', 'bar2', 'lever', 'anchor', 'foot', 'foot_angle'];
const VAR_PARAM: Record<SearchVar, keyof LinkageParams> = {
  bar1: 'bar1_length', bar2: 'bar2_length', lever: 'lever_length', anchor: 'anchor_distance', foot: 'foot_length', foot_angle: 'foot_angle_deg',
};

interface LinkageSearch {
  bar1_min: number;
  bar1_max: number;
  bar2_min: number;
  bar2_max: number;
  lever_min: number;
  lever_max: number;
  anchor_min: number;
  anchor_max: number;
  foot_min: number;
  foot_max: number;
  foot_angle_min: number;
  foot_angle_max: number;
  min_pivot_height: number;
  max_pivot_height: number;
  max_oversqueeze: number;
  objective: 'response' | 'target';
  max_stroke: number;
  /** Dimensions kept at their current value: sent as min = max, their stored range left untouched. */
  fixed: SearchVar[];
}

/** Why the one-piece search turned candidates down; absent from older backends. */
interface SearchReport {
  model?: 'one-piece' | 'rigid';
  shortlist?: number;
  passed?: number;
  rejected?: Partial<Record<'stress' | 'thrust' | 'eye' | 'rod' | 'no_flow', number>>;
}

type Series = (number | null)[];
/** One line of the one-piece part: its points at rest, and how each moves per mm of travel and per N on the pin. */
interface FlexLine { x: number[]; y: number[]; x_per_mm: number[]; y_per_mm: number[]; x_per_n: number[]; y_per_n: number[] }

interface LinkageResult {
  feasible: boolean;
  message: string;
  Y_positions: number[];
  joint_x: Series;
  joint_y: Series;
  tip_x: Series;
  tip_y: Series;
  gap_a: Series;
  gap_b: Series;
  gap_loaded_a: Series;
  gap_loaded_b: Series;
  contact_solved: boolean;
  link_arc_half_angle_deg: number;
  link_arc_radius: number | null;
  link_arc_sag: number;
  link_arc_side: number;
  link_bending_stress_mpa: number | null;
  flexure: (Record<'arm' | 'foot' | 'link', FlexLine> & { travel_sign: number }) | null;
  stress_a: Series;
  stress_b: Series;
  max_stress_mpa: number | null;
  max_stress_where: 'arm' | 'foot' | 'link' | null;
  max_stress_spot: 'shell' | 'joint' | 'carriage' | 'span' | null;
  stress_margin: number | null;
  stress_limit_y: number | null;
  spring_rate: number | null;
  max_rotation_deg: number | null;
  flow_a: Series;
  flow_b: Series;
  flow_target: Series;
  anchor_x: number;
  anchor_on_top: boolean;
  link_length: number;
  pivot_height_y0: number;
  wall_x: number;
  closed_gap: number;
  full_open_gap: number;
  y_min: number;
  y_max: number;
  y_full_open: number | null;
  y_open: number | null;
  response_time_ms: number | null;
  sensitivity_y0: number;
  pinch_slide: number;
  max_oversqueeze: number;
  max_flow_l_min: number;
  rms_error: number | null;
  time_ms: number[];
  y_time: number[];
  flow_in_l_min: number[];
  flow_out_l_min: number[];
  chamber_kpa: number[];
  volume_in_ml: number;
  volume_out_ml: number;
  forces_message: string;
  force_a: Series;
  force_b: Series;
  thrust: Series;
  flex_a: Series;
  flex_b: Series;
  flex_link_a: Series;
  flex_bend_a: Series;
  tube_modulus_mpa: number | null;
  seal_force_min: number | null;
  seal_force: number | null;
  jam_y: number | null;
  seal_force_flatten: number | null;
  seal_force_squeeze: number | null;
  seal_force_pressure: number | null;
  max_pinch_force: number | null;
  max_wall_strain: number | null;
  thrust_y0: number | null;
  thrust_needed: number | null;
  thrust_available: number | null;
  motor_torque_needed_mnm: number | null;
  motor_margin: number | null;
  stall_y: number | null;
  screw_self_locking: boolean | null;
  max_link_force: number | null;
  max_side_load: number | null;
  carriage_load: number | null;
  carriage_bearing_mpa: number | null;
  carriage_pin_bending_mpa: number | null;
  max_bending_stress_mpa: number | null;
  max_axial_stress_mpa: number | null;
  buckling_factor: number | null;
  pin_stiffness: number | null;
  flex_y0: number | null;
  seal_pressure_y0_kpa: number | null;
  sealed_after_flex: boolean | null;
}

export type LinkageShared = Pick<LinkageParams, 'tube_id' | 'tube_od' | 'input_pressure_kpa' | 'compliance' | 'tube_model' | 'tube_shore_a' | 'motor_speed' | 'lead_screw_pitch'>;

const COMMON = {
  lever_length: 16.5,
  foot_length: 1.5,
  foot_angle_deg: 100,
  pad_length: 0,
  fixed_height: 0,
  tube_center_x: 8.0,
  preload: 0.1,
  stroke: 3.0,
  target_exponent: 1.0,
  tube_id: 2.0,
  tube_od: 3.0,
  input_pressure_kpa: 100,
  compliance: 0.7,
  tube_model: DEFAULT_TUBE_MODEL,
  tube_shore_a: DEFAULT_SHORE_A,
  chamber_volume_ml: 10.0,
  motor_speed: 100.0,
  lead_screw_pitch: 0.5,
  speed_factor: 0.85,
  // Assumed, not measured: set them to the real motor, screw and printed bars.
  motor_torque_mnm: 30,
  screw_diameter: 3.0,
  screw_friction: 0.3,
  member_modulus_mpa: 2500,
  member_width: 2.0,
  member_thickness: 3.0,
  contact_deformation: true,
  link_curved: false,
  compliant: false,
  // The real part: the link turns on a 1.5 x 8 mm stainless rod at the carriage.
  carriage_clamped: false,
  carriage_pin_diameter: 1.5,
  carriage_pin_length: 8,
  // Assumed: about printed PETG at yield.
  member_strength_mpa: 40,
  carriage_pin_strength_mpa: 300,
};

// All sets were measured on the concept sketches (about 30 px/mm).
const DEFAULT_PARAMS: Record<LinkageKind, LinkageParams> = {
  elbow: { ...COMMON, linkage_type: 'elbow', bar1_length: 13.0, bar2_length: 7.8, lever_length: 16.5, anchor_distance: 2.33, pivot_offset: 3.9, pin_diameter: 1.0 },
  lever: { ...COMMON, linkage_type: 'lever', bar1_length: 6.9, bar2_length: 6.9, lever_length: 16.5, anchor_distance: 5.05, pivot_offset: 3.97, pin_diameter: 0.4 },
  pendulum: { ...COMMON, linkage_type: 'pendulum', bar1_length: 11.95, bar2_length: 14.43, anchor_distance: 4.79, pivot_offset: 4.0, pin_diameter: 1.0, pad_length: 1.0, link_curved: true, compliant: true },
};

const SEARCH_COMMON = { lever_min: 10, lever_max: 22, foot_min: 1, foot_max: 6, foot_angle_min: 45, foot_angle_max: 135, min_pivot_height: 3, max_pivot_height: 16, max_oversqueeze: 0.5, objective: 'response' as const, max_stroke: 3, fixed: [] as SearchVar[] };
const DEFAULT_SEARCH: Record<LinkageKind, LinkageSearch> = {
  elbow: { ...SEARCH_COMMON, bar1_min: 6, bar1_max: 20, bar2_min: 3, bar2_max: 14, anchor_min: 0, anchor_max: 6, max_stroke: 5 },
  lever: { ...SEARCH_COMMON, bar1_min: 3, bar1_max: 12, bar2_min: 3, bar2_max: 12, anchor_min: 2, anchor_max: 8 },
  pendulum: { ...SEARCH_COMMON, bar1_min: 6, bar1_max: 16, bar2_min: 8, bar2_max: 18, anchor_min: -5, anchor_max: 8 },
};

interface Material { name: string; modulus_mpa: number; strength_mpa: number; builtin: boolean }
/** Shown until the server's list arrives; the server holds the same two plus the custom ones. */
const BUILTIN_MATERIALS: Material[] = [
  { name: 'PETG', modulus_mpa: 2500, strength_mpa: 40, builtin: true },
  { name: 'PLA', modulus_mpa: 3500, strength_mpa: 50, builtin: true },
];

const storageKey = (kind: LinkageKind) => `cam-sim.linkage.${kind}.v2`;

/** The dimensions each linkage type searches, in the order the panels show them. */
const SEARCH_VARS_OF: Record<LinkageKind, SearchVar[]> = {
  pendulum: ['bar2', 'bar1', 'anchor', 'foot', 'foot_angle'],
  lever: ['lever', 'bar2', 'bar1', 'anchor'],
  elbow: ['bar1', 'bar2', 'anchor'],
};
const VAR_LABEL: Record<LinkageKind, Record<SearchVar, string>> = {
  pendulum: { bar2: 'Arm, L', bar1: 'Link, r', anchor: 'Anchor, a', foot: 'Foot, f', foot_angle: 'Foot angle', lever: 'Lever, L' },
  lever: { lever: 'Lever, L', bar2: 'Attach point, c', bar1: 'Link, r', anchor: 'Anchor, a', foot: 'Foot, f', foot_angle: 'Foot angle' },
  elbow: { bar1: 'Bar 1, L1', bar2: 'Bar 2, L2', anchor: 'Anchor, a', lever: 'Lever, L', foot: 'Foot, f', foot_angle: 'Foot angle' },
};
const varUnit = (v: SearchVar) => (v === 'foot_angle' ? '°' : 'mm');

/** The stored list of fixed dimensions, or none when it is missing or not a list. */
const cleanFixed = (raw: unknown): SearchVar[] => (Array.isArray(raw) ? SEARCH_VARS.filter((v) => raw.includes(v)) : []);

type LinkageChartKey = 'flow' | 'gap' | 'force' | 'stress' | 'flex' | 'chamber' | 'section';
type LinkageChartSettings = Record<LinkageChartKey, ChartDomainSettings>;
const AUTO_DOMAIN: ChartDomainSettings = { autoX: true, autoY: true, xMin: -1, xMax: 1, yMin: 0, yMax: 1 };
const DEFAULT_CHART_SETTINGS: LinkageChartSettings = {
  flow: AUTO_DOMAIN,
  gap: AUTO_DOMAIN,
  // The force axis is logarithmic: its typed floor has to stay above zero.
  force: { ...AUTO_DOMAIN, yMin: 0.1, yMax: 100 },
  stress: AUTO_DOMAIN,
  flex: AUTO_DOMAIN,
  chamber: { ...AUTO_DOMAIN, xMin: 0 },
  section: AUTO_DOMAIN,
};

/** Every chart's settings, the stored ones over the defaults; a missing or partial map is fine. */
function resolveChartSettings(raw: unknown): LinkageChartSettings {
  const map = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<LinkageChartKey, Partial<ChartDomainSettings>>>;
  const out = {} as LinkageChartSettings;
  for (const key of Object.keys(DEFAULT_CHART_SETTINGS) as LinkageChartKey[]) out[key] = { ...DEFAULT_CHART_SETTINGS[key], ...map[key] };
  return out;
}

function loadStored(kind: LinkageKind, shared: LinkageShared): { params: LinkageParams; search: LinkageSearch; profile: string | null; chart_settings: LinkageChartSettings } {
  try {
    // A state saved before pressures were in kPa comes back converted.
    const raw = legacyPsiToKpa(JSON.parse(localStorage.getItem(storageKey(kind)) ?? 'null'));
    if (raw && typeof raw === 'object') {
      return {
        // A state stored before the pivot rod existed had the carriage end clamped by default: the real part pivots there.
        params: { ...DEFAULT_PARAMS[kind], ...raw.params, ...(raw.params && raw.params.carriage_pin_diameter === undefined ? { carriage_clamped: false } : {}), tube_model: cleanTubeModel(raw.params?.tube_model), linkage_type: kind },
        // Ranges stored before the foot was searched kept the anchor on the tube side only: open them up once.
        search: { ...DEFAULT_SEARCH[kind], ...raw.search, ...(raw.search && raw.search.foot_min === undefined ? { anchor_min: Math.min(raw.search.anchor_min ?? 0, DEFAULT_SEARCH[kind].anchor_min) } : {}), fixed: cleanFixed(raw.search?.fixed) },
        profile: typeof raw.profile === 'string' ? raw.profile : null,
        chart_settings: resolveChartSettings(raw.chart_settings),
      };
    }
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { params: { ...DEFAULT_PARAMS[kind], ...shared }, search: DEFAULT_SEARCH[kind], profile: null, chart_settings: DEFAULT_CHART_SETTINGS };
}

/** A stored profile's parameters and ranges, completed for fields added since it was saved. */
function fromProfilePayload(kind: LinkageKind, raw: Record<string, unknown>): { params: LinkageParams; search: LinkageSearch; chart_settings: LinkageChartSettings } {
  const rp = (raw.params && typeof raw.params === 'object' ? raw.params : undefined) as Partial<LinkageParams> | undefined;
  const rs = (raw.search && typeof raw.search === 'object' ? raw.search : undefined) as (Partial<LinkageSearch> & { fixed?: unknown }) | undefined;
  return {
    // A profile saved before the curved link and the one-piece part existed was straight and pivoted: keep its figures as they were.
    params: { ...DEFAULT_PARAMS[kind], link_curved: false, compliant: false, ...rp, ...(rp && rp.carriage_pin_diameter === undefined ? { carriage_clamped: false } : {}), tube_model: cleanTubeModel(rp?.tube_model), linkage_type: kind },
    search: { ...DEFAULT_SEARCH[kind], ...rs, fixed: cleanFixed(rs?.fixed) },
    chart_settings: resolveChartSettings(raw.chart_settings),
  };
}

/** The import window's preview of a linkage profile: its main dimensions and the ranges the Finder searches. */
export function LinkageProfilePreview({ kind, payload }: { kind: LinkageKind; payload: Record<string, unknown> }) {
  const { params: p, search: s } = fromProfilePayload(kind, payload);
  const mm = (v: number, d = 2) => `${v.toFixed(d)} mm`;
  const rows: [string, string][] = [
    ...SEARCH_VARS_OF[kind].map((v): [string, string] => {
      const value = p[VAR_PARAM[v]] as number;
      return [VAR_LABEL[kind][v], v === 'foot_angle' ? `${value.toFixed(0)}°` : mm(value)];
    }),
    ['Stroke', mm(p.stroke, 1)],
    ['Pinch pin Ø', mm(p.pin_diameter, 1)],
    ['Preload', mm(p.preload)],
    ['Tube', `${p.tube_id.toFixed(2)} x ${p.tube_od.toFixed(2)} mm`],
    ['Pressure', `${formatKpa(p.input_pressure_kpa)} kPa`],
  ];
  if (kind === 'pendulum') rows.push(['Build', p.compliant ? 'One piece' : p.link_curved ? 'Curved link' : 'Pivoted bars']);
  const row = (label: string, value: string, tone = 'text-neutral-200') => (
    <div key={label} className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">{label}</span><span className={`text-[11px] font-mono ${tone}`}>{value}</span></div>
  );
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
      <div>
        <div className="text-[10px] text-neutral-500 font-bold mb-2">Dimensions</div>
        <div className="grid grid-cols-1 gap-2">{rows.map(([l, v]) => row(l, v))}</div>
      </div>
      <div>
        <div className="text-[10px] text-neutral-500 font-bold mb-2">Finder ranges</div>
        <div className="grid grid-cols-1 gap-2">
          {SEARCH_VARS_OF[kind].map((v) => row(
            VAR_LABEL[kind][v],
            s.fixed.includes(v) ? 'fixed' : `${s[`${v}_min` as const]} to ${s[`${v}_max` as const]} ${varUnit(v)}`,
            'text-amber-300',
          ))}
          {row('Objective', s.objective === 'target' ? 'Follow target' : 'Most flow, least dead band')}
        </div>
      </div>
    </div>
  );
}

/** Linear interpolation on the uniform Y grid returned by the backend. */
function interpAt(y: number, ys: number[], vals: Series): number | null {
  const n = ys.length;
  if (n < 2) return null;
  const f = Math.min(Math.max((y - ys[0]) / (ys[n - 1] - ys[0]), 0), 1) * (n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  const a = vals[i], b = vals[i + 1];
  if (a == null || b == null) return null;
  return a + (b - a) * (f - i);
}

// ─── Schematic ───────────────────────────────────────────────────

const ORANGE = '#f59e0b';
const CYAN = '#22d3ee';
const BLUE = '#3b82f6';
const SCREW_R = 1.5;

interface Pose { anchor: Pt; pivotX: number; joint: Pt | null; tip: Pt | null; lines?: Pt[][] }

/** The contact pad's two ends: a segment centred on the pinch point, square to the foot. A round pin is both ends at the tip. */
function padEnds(pose: Pose, padLength: number): [Pt, Pt] | null {
  if (!pose.tip) return null;
  if (padLength > 0 && pose.joint) {
    const dx = pose.tip[0] - pose.joint[0], dy = pose.tip[1] - pose.joint[1];
    const n = Math.hypot(dx, dy);
    if (n > 1e-6) {
      const k = padLength / 2 / n;
      return [[pose.tip[0] - dy * k, pose.tip[1] + dx * k], [pose.tip[0] + dy * k, pose.tip[1] - dx * k]];
    }
  }
  return [pose.tip, pose.tip];
}

/** Points of the curved link from the joint to the carriage pivot (an arc that meets the joint along the foot). */
function linkPath(joint: Pt, pivot: Pt, halfAngleDeg: number, side: number): string {
  const pts: Pt[] = [];
  const alpha = halfAngleDeg * Math.PI / 180;
  const dx = pivot[0] - joint[0], dy = pivot[1] - joint[1];
  const l = Math.hypot(dx, dy);
  if (alpha < 1e-4 || l < 1e-6) {
    pts.push(joint, pivot);
  } else {
    const radius = l / (2 * Math.sin(alpha));
    for (let i = 0; i <= 24; i++) {
      const th = -alpha + 2 * alpha * i / 24;
      const along = l / 2 + radius * Math.sin(th), off = side * radius * (Math.cos(th) - Math.cos(alpha));
      pts.push([joint[0] + (dx * along - dy * off) / l, joint[1] + (dy * along + dx * off) / l]);
    }
  }
  return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(3)},${(-py).toFixed(3)}`).join(' ');
}

function LinkageDiagram({ params, data, y, details }: { params: LinkageParams; data: LinkageResult; y: number; details: boolean }) {
  // FEM tube: the bore along each tube comes from its section; simple model: the schematic walls.
  // While a new tube solves, the last FEM tube stays drawn rather than the simple walls.
  const { drawn: sweep, stale } = useTubeSweep(params);
  const lever = params.linkage_type === 'lever';
  const pendulum = params.linkage_type === 'pendulum';
  const onTop = data.anchor_on_top;
  const h0 = data.pivot_height_y0;
  const wall = data.wall_x;
  const rPin = Math.max(params.pin_diameter / 2, 0.18);
  const top = 2 * h0;
  const margin = 1.7;
  const hB = h0 + y;

  // The backend frame has the anchor at y = 0; a top-anchored linkage is that frame upside down.
  const at = (yy: number, xs: Series, ys: Series): [number, number] | null => {
    const px = interpAt(yy, data.Y_positions, xs), py = interpAt(yy, data.Y_positions, ys);
    return px == null || py == null ? null : [px, onTop ? top - py : py];
  };
  // Tube B's linkage is tube A's turned half a turn about the carriage pivot at Y = 0: it sits at -Y.
  const flip = (pt: [number, number] | null): [number, number] | null => (pt ? [-pt[0], top - pt[1]] : null);
  // tip_x is the pose of rigid bars; once the tube pushes the pin back, the gap is gap_loaded. The pin
  // is drawn there, moved away from the wall by the difference (and drawn at its own radius, floor included).
  const pushedBack = (yy: number) => {
    const rigid = interpAt(yy, data.Y_positions, data.gap_a), loaded = interpAt(yy, data.Y_positions, data.gap_loaded_a);
    return (rigid == null || loaded == null ? 0 : loaded - rigid) + rPin - params.pin_diameter / 2;
  };
  const loadedTip = (pt: Pt | null, sign: 1 | -1, d: number): Pt | null => (pt ? [pt[0] - sign * d, pt[1]] : null);
  const poseA: Pose = { anchor: [data.anchor_x, onTop ? top : 0], pivotX: params.pivot_offset, joint: at(y, data.joint_x, data.joint_y), tip: loadedTip(at(y, data.tip_x, data.tip_y), -1, pushedBack(y)) };
  const poseB: Pose = { anchor: [-data.anchor_x, onTop ? 0 : top], pivotX: -params.pivot_offset, joint: flip(at(-y, data.joint_x, data.joint_y)), tip: loadedTip(flip(at(-y, data.tip_x, data.tip_y)), 1, pushedBack(-y)) };

  // One-piece part: its bent centre lines, from the rest shape and the two bending shapes.
  const flexLines = (yy: number, place: (pt: Pt) => Pt): Pt[][] | undefined => {
    const fx = data.flexure;
    if (!fx) return undefined;
    const travel = fx.travel_sign * yy, force = interpAt(yy, data.Y_positions, data.force_a) ?? 0;
    return (['arm', 'foot', 'link'] as const).map((name) => {
      const l = fx[name];
      return l.x.map((x0, i): Pt => place([x0 + l.x_per_mm[i] * travel + l.x_per_n[i] * force, l.y[i] + l.y_per_mm[i] * travel + l.y_per_n[i] * force]));
    });
  };
  const upright = (pt: Pt): Pt => [pt[0], onTop ? top - pt[1] : pt[1]];
  poseA.lines = flexLines(y, upright);
  poseB.lines = flexLines(-y, (pt) => { const q = upright(pt); return [-q[0], top - q[1]]; });

  const gapA = interpAt(y, data.Y_positions, data.gap_loaded_a);
  const gapB = interpAt(y, data.Y_positions, data.gap_loaded_b);
  // Bars drawn at their real width, kept readable on very thin or very wide sections.
  const barW = Math.min(Math.max(params.member_width, 0.3), 3);
  // A top-anchored frame is drawn mirrored, which turns the arc's bulge to the other side.
  const arcSide = data.link_arc_side * (onTop ? -1 : 1);
  const flowA = interpAt(y, data.Y_positions, data.flow_a) ?? 0;
  const flowB = interpAt(y, data.Y_positions, data.flow_b) ?? 0;
  const forceA = interpAt(y, data.Y_positions, data.force_a);
  const forceB = interpAt(y, data.Y_positions, data.force_b);
  const newtons = (f: number | null) => (f == null ? '' : `, ${f.toFixed(f < 10 ? 2 : 1)} N`);

  const hw = params.pivot_offset + 1.0;
  const carriage = [
    [-hw, hB + 0.9], [-hw + 0.9, hB + 1.5], [hw - 0.9, hB + 1.5], [hw, hB + 0.9],
    [hw, hB - 0.9], [hw - 0.9, hB - 1.5], [-hw + 0.9, hB - 1.5], [-hw, hB - 0.9],
  ].map(([px, py]) => `${px},${-py}`).join(' ');

  const tube = (sign: 1 | -1, flow: number, name: string, pose: Pose) => {
    const cx = sign * params.tube_center_x;
    const frac = data.max_flow_l_min > 0 ? Math.min(flow / data.max_flow_l_min, 1) : 0;
    const od = params.tube_od;
    // Work in (distance from the wall, height): the wall is at 0, the tube's free side at OD.
    const ends = padEnds(pose, pendulum ? params.pad_length : 0);
    const toWall = ends ? ends.map(([px, py]) => [wall - sign * px, py]) as [Pt, Pt] : null;
    // FEM: the shoulders on each side of the pin run one OD; simple model: the drawing it always had.
    const profile = tubeProfile(toWall, rPin, od, -1, top + 1, sweep ? od : undefined);
    const bore = sideBore(profile, od, params.tube_id, sweep);
    const xy = (u: number, v: number) => `${(sign * (wall - u)).toFixed(3)},${(-v).toFixed(3)}`;
    const ring = (inner: number[], outer: number[]) =>
      [...profile.map(([, v], i) => xy(outer[i], v)), ...profile.map(([, v], i) => xy(inner[i], v)).reverse()].join(' ');
    return (
      <g>
        {sweep && <title>{`Tube ${name.trim()[0]}, side view: the wall follows the pin, and the open bore at each station is the FEM section's at the local pin-to-wall distance, so it shuts before the wall stops moving. The shoulders on each side of the pin (about one OD) are schematic: the 2D section has no bending along the tube.${stale ? ' The previous tube, shown while the new one solves.' : ''}`}</title>}
        <polygon points={ring(profile.map(() => 0), profile.map(([h]) => h))} fill="var(--bui-text)" fillOpacity={0.16} stroke="var(--bui-text)" strokeWidth={0.05} strokeLinejoin="round" />
        <polygon points={ring(bore.map((b) => b[1]), bore.map((b) => b[2]))} fill={frac > 0 ? '#10b981' : '#ef4444'} fillOpacity={0.25 + 0.45 * frac} />
        {/* Air toward the chamber, taken below the drawing: down tube A, up tube B */}
        <FlowParticles view="side" frac={frac} bore={bore} direction={sign < 0 ? -1 : 1}
          radius={Math.min(0.16, params.tube_id / 6)} color="var(--bui-text)" transform={`matrix(${-sign} 0 0 -1 ${sign * wall} 0)`} />
        <line x1={cx} y1={-top - 1} x2={cx} y2={1} stroke="var(--bui-text)" strokeOpacity={0.5} strokeWidth={0.04} strokeDasharray="0.5 0.12 0.1 0.12" />
        {label(cx, onTop ? -1.1 : top + 1.1, name, 'var(--bui-text)')}
      </g>
    );
  };

  const label = (x: number, yy: number, text: string, color: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={-yy} fill={color} fontSize={0.62} fontWeight="bold" textAnchor={anchor} dominantBaseline="middle"
      stroke="var(--bui-surface)" strokeWidth={0.18} paintOrder="stroke">{text}</text>
  );

  const linkage = (pose: Pose, color: string) => {
    const [axx, ayy] = pose.anchor;
    const ends = pendulum && params.pad_length > 0 ? padEnds(pose, params.pad_length) : null;
    const link = pose.joint ? linkPath(pose.joint, [pose.pivotX, hB], data.link_arc_half_angle_deg, arcSide) : '';
    // The hinged body: the arm, and for the pendulum its foot, as one rigid piece.
    const body = pose.joint && pose.tip
      ? (pendulum ? [pose.anchor, pose.joint, pose.tip] : [pose.anchor, pose.tip]).map(([px, py]) => `${px},${-py}`).join(' ')
      : '';
    return (
      <g>
        {/* Ground mark at the fixed anchor */}
        <line x1={axx - 0.6} y1={-ayy} x2={axx + 0.6} y2={-ayy} stroke="var(--bui-text)" strokeWidth={0.14} />
        {pose.lines && pose.tip && (
          <>
            {/* One piece: no pivots, the centre lines bend */}
            {pose.lines.map((line, i) => {
              const pts = line.map(([px, py]) => `${px.toFixed(3)},${(-py).toFixed(3)}`).join(' ');
              return (
                <g key={i}>
                  <polyline points={pts} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={barW} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={pts} fill="none" stroke={color} strokeWidth={0.14} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              );
            })}
            {ends
              ? <line x1={ends[0][0]} y1={-ends[0][1]} x2={ends[1][0]} y2={-ends[1][1]} stroke={color} strokeWidth={2 * rPin} strokeLinecap="round" />
              : <circle cx={pose.tip[0]} cy={-pose.tip[1]} r={rPin} fill={color} />}
            {/* Built into the shell at the anchor */}
            <rect x={axx - barW / 2 - 0.25} y={-ayy - 0.45} width={barW + 0.5} height={0.9} fill={color} />
          </>
        )}
        {!pose.lines && pose.joint && pose.tip && (
          <>
            {/* Real section of the bars, then their centre lines */}
            <polyline points={body} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={barW} strokeLinecap="round" strokeLinejoin="round" />
            <path d={link} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={barW} strokeLinecap="round" />
            <polyline points={body} fill="none" stroke={color} strokeWidth={0.14} strokeLinecap="round" strokeLinejoin="round" />
            <path d={link} fill="none" stroke={color} strokeWidth={0.14} strokeLinecap="round" />
            {(lever || pendulum) && <circle cx={pose.joint[0]} cy={-pose.joint[1]} r={0.26} fill="var(--bui-surface)" stroke={color} strokeWidth={0.1} />}
            {ends
              ? <line x1={ends[0][0]} y1={-ends[0][1]} x2={ends[1][0]} y2={-ends[1][1]} stroke={color} strokeWidth={2 * rPin} strokeLinecap="round" />
              : <circle cx={pose.tip[0]} cy={-pose.tip[1]} r={rPin} fill={color} />}
          </>
        )}
        {!pose.lines && <circle cx={axx} cy={-ayy} r={0.3} fill="var(--bui-surface)" stroke={color} strokeWidth={0.12} />}
        {pose.lines && params.carriage_clamped
          ? <rect x={pose.pivotX - 0.45} y={-hB - 0.45} width={0.9} height={0.9} fill={BLUE} />
          : <circle cx={pose.pivotX} cy={-hB} r={pose.lines ? Math.max(params.carriage_pin_diameter / 2, 0.2) : 0.42} fill={BLUE} />}
      </g>
    );
  };

  const a = poseA;
  return (
    <svg viewBox={`${-(wall + margin)} ${-top - margin} ${2 * (wall + margin)} ${top + 2 * margin}`} preserveAspectRatio="xMidYMid meet"
      className="w-full h-full select-none" role="img" aria-label="Linkage schematic">
      {/* Fixed base: floor, ceiling and the two walls the tubes rest on */}
      <rect x={-wall} y={-top} width={2 * wall} height={top} fill="var(--bui-muted)" fillOpacity={0.08} stroke="var(--bui-text)" strokeWidth={0.14} />
      {[-1, 1].map((side) => (
        <rect key={side} x={side < 0 ? -wall - 0.7 : wall} y={-top - 1} width={0.7} height={top + 2} fill="var(--bui-text)" fillOpacity={0.35} />
      ))}
      {tube(-1, flowA, 'A  supply', poseA)}
      {tube(1, flowB, 'B  exhaust', poseB)}

      {/* Lead screw and carriage */}
      <rect x={-SCREW_R} y={-top - 0.6} width={2 * SCREW_R} height={top + 1.2} rx={0.2} fill="#d4a94a" fillOpacity={0.85} />
      <polygon points={carriage} fill="var(--bui-muted)" fillOpacity={0.75} stroke="var(--bui-text)" strokeWidth={0.06} />
      {/* Carriage pivot height at Y = 0 */}
      <line x1={-wall} y1={-h0} x2={wall} y2={-h0} stroke={BLUE} strokeWidth={0.04} strokeDasharray="0.2 0.2" />

      {linkage(poseB, CYAN)}
      {linkage(poseA, ORANGE)}

      {details && a.joint && a.tip && (
        <g>
          {pendulum ? (
            <>
              {label((a.anchor[0] + a.joint[0]) / 2 + 1.5, (a.anchor[1] + a.joint[1]) / 2, `L ${params.bar2_length.toFixed(2)}`, ORANGE)}
              {label((a.pivotX + a.joint[0]) / 2, (hB + a.joint[1]) / 2 - 0.9, `r ${data.link_length.toFixed(2)}`, ORANGE)}
            </>
          ) : lever ? (
            <>
              {label(a.anchor[0] + 0.75 * (a.tip[0] - a.anchor[0]), a.anchor[1] + 0.75 * (a.tip[1] - a.anchor[1]) - 0.9, `L ${params.lever_length.toFixed(2)}`, ORANGE)}
              {label((a.anchor[0] + a.joint[0]) / 2 + 0.3, (a.anchor[1] + a.joint[1]) / 2 - 0.9, `c ${params.bar2_length.toFixed(2)}`, ORANGE)}
              {label((a.pivotX + a.joint[0]) / 2 + 1.3, (hB + a.joint[1]) / 2, `r ${params.bar1_length.toFixed(2)}`, ORANGE)}
            </>
          ) : (
            <>
              {label(a.joint[0] + 0.3 * (a.pivotX - a.joint[0]), a.joint[1] + 0.3 * (hB - a.joint[1]) + 0.9, `L1 ${params.bar1_length.toFixed(2)}`, ORANGE)}
              {label((a.joint[0] + a.anchor[0]) / 2 + 0.4, a.joint[1] / 2 - 0.8, `L2 ${params.bar2_length.toFixed(2)}`, ORANGE)}
            </>
          )}
          <g transform={onTop ? `translate(0 ${-top - 1.5})` : undefined}>
            <line x1={0} y1={0.75} x2={a.anchor[0]} y2={0.75} stroke={ORANGE} strokeWidth={0.06} />
            <line x1={0} y1={0.45} x2={0} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
            <line x1={a.anchor[0]} y1={0.45} x2={a.anchor[0]} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
          </g>
          {label(a.anchor[0] / 2, onTop ? top + 1.35 : -1.35, `a ${params.anchor_distance.toFixed(2)}`, ORANGE)}
          {label(-wall + 0.25, h0 + 0.55, `h₀ ${h0.toFixed(2)}`, BLUE, 'start')}
          {gapA != null && label(-wall + 0.2, a.tip[1] + (onTop ? -1.1 : 1.1), `gap ${gapA.toFixed(3)}${newtons(forceA)}`, 'var(--bui-text)', 'start')}
          {gapB != null && poseB.tip && label(wall - 0.2, poseB.tip[1] + (onTop ? 1.1 : -1.1), `gap ${gapB.toFixed(3)}${newtons(forceB)}`, 'var(--bui-text)', 'end')}
          {sweep && (
            // Away from the anchor's dimension line, along the floor (or the ceiling when anchored on top).
            <text x={(a.anchor[0] > 0 ? -1 : 1) * (wall - 0.2)} y={onTop ? -top - 1.45 : 1.45} fill="var(--bui-text)" fillOpacity={0.7} fontSize={0.36}
              textAnchor={a.anchor[0] > 0 ? 'start' : 'end'} dominantBaseline="middle">Tubes: FEM bore, schematic shoulders</text>
          )}
        </g>
      )}
    </svg>
  );
}

// ─── Small inputs ────────────────────────────────────────────────

function RangeRow({ label, min, max, onMin, onMax }: { label: string; min: number; max: number; onMin: (v: number) => void; onMax: (v: number) => void }) {
  const field = (value: number, onChange: (v: number) => void, aria: string) => (
    <Input type="number" value={value} step={0.5} aria-label={aria}
      onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
      className="w-16 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-right text-neutral-100 font-mono" />
  );
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-neutral-300">{label}</span>
      <div className="flex items-center gap-1.5">
        {field(min, onMin, `${label} min`)}
        <span className="text-xs text-neutral-500">to</span>
        {field(max, onMax, `${label} max`)}
      </div>
    </div>
  );
}

function Switch({ label, on, onChange, title }: { label: string; on: boolean; onChange: (on: boolean) => void; title?: string }) {
  return (
    <Button variant="ghost" type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} title={title}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${on ? 'border-amber-500/50 text-amber-300' : 'border-neutral-700 text-neutral-300'}`}>
      <span className="text-left">{label}</span>
      <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-amber-600' : 'bg-neutral-600'}`}>
        <span className={`h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
    </Button>
  );
}

// The card header with its buttons is 12px taller than the old bare title: the chart's floor gives it back, so a 210px row still holds the card.
function FitChart({ children }: { children: ReactElement }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={158}>{children}</ResponsiveContainer>;
}

// ─── Onshape variable table ──────────────────────────────────────

interface OnshapeRow {
  name: string;
  key: string;
  label: string;
  new_expression: string;
  current_expression: string | null;
  status: 'update' | 'same' | 'new' | 'written' | 'created' | 'skipped' | 'error';
  detail: string;
}
/** One input the CAD decides, as a measured variable of the Part Studio computes it (backend `read_measured`). */
interface MeasuredValue { key: keyof LinkageParams; variable: string; label: string; unit: string; value: number }
interface MeasuredInputs { configured: boolean; values: MeasuredValue[]; api_calls: number; part_studio_url: string | null }
interface InputCheck {
  configured: boolean; valid: boolean; error: string | null; part_studio_url: string | null;
  rows: (MeasuredValue & { simulator: number; ok: boolean })[];
}
interface OnshapeTable {
  rows: OnshapeRow[]; api_calls: number; table_name: string; table_exists: boolean; table_created: boolean;
  element_id: string | null; table_url: string | null; write_error?: string | null; input_check?: InputCheck;
}

/** Inputs of each kind that the CAD measures (same keys as DEFAULT_MEASURED in backend/onshape_variables.py). */
const ONSHAPE_MEASURED: Partial<Record<LinkageKind, (keyof LinkageParams)[]>> = { pendulum: ['tube_center_x'] };

async function readMeasured(params: LinkageParams): Promise<MeasuredInputs> {
  const res = await apiFetch('/api/linkage/onshape/measured', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  if (!res.ok) {
    const detail = await res.json().then((j) => (typeof j.detail === 'string' ? j.detail : null)).catch(() => null);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** The measured values as a params patch, rounded to the micrometre like what the table receives. */
const measuredPatch = (values: MeasuredValue[]): Partial<LinkageParams> =>
  Object.fromEntries(values.map((v) => [v.key, Math.round(v.value * 1e4) / 1e4]));

async function onshapeCall(path: string, body: unknown): Promise<OnshapeTable> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.json().then((j) => (typeof j.detail === 'string' ? j.detail : null)).catch(() => null);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Same rule as `table_name_for` in backend/onshape_variables.py. */
const TABLE_NAME = /^[A-Za-z0-9 _-]{1,60}$/;
const tableNameKey = (kind: LinkageKind) => `cam-sim.onshape-table.${kind}`;
function storedTableName(kind: LinkageKind): string {
  try {
    const v = localStorage.getItem(tableNameKey(kind));
    if (v && TABLE_NAME.test(v)) return v;
  } catch { /* ignore */ }
  return `cam_sim_${kind}`;
}

/** Shows what the simulator's own Variable Studio holds against the values on screen, then writes the ticked rows (creating the table if needed). */
function OnshapeVariablesModal({ open, onClose, params, onSyncMeasured }: {
  open: boolean; onClose: () => void; params: LinkageParams;
  /** Puts the values Onshape measures into the design; the window then checks again with them. */
  onSyncMeasured: (patch: Partial<LinkageParams>) => void;
}) {
  const kind = params.linkage_type;
  const [table, setTable] = useState<OnshapeTable | null>(null);
  const [nameInput, setNameInput] = useState(() => storedTableName(kind));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'read' | 'write' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const staleRef = useRef(0);
  const writingRef = useRef(false);   // busy state lags a render: this stops a double click sending two writes
  const recheckRef = useRef(false);   // after a sync, read again once the new values are on screen

  const name = nameInput.trim();
  const nameOk = TABLE_NAME.test(name);

  // One read per opening or per explicit name check, never per keystroke: each read costs Onshape API calls.
  const read = (tableName: string) => {
    const ticket = ++staleRef.current;
    setTable(null); setError(null); setDone(false); setBusy('read');
    onshapeCall('/api/linkage/onshape/preview', { ...params, table_name: tableName })
      .then((t) => {
        if (ticket !== staleRef.current) return;
        setTable(t);
        setPicked(new Set(t.rows.filter((r) => r.status === 'update' || r.status === 'new').map((r) => r.name)));
        try { localStorage.setItem(tableNameKey(kind), t.table_name); } catch { /* ignore */ }
      })
      .catch((e) => { if (ticket === staleRef.current) setError(e instanceof Error ? e.message : 'Could not read the Onshape table.'); })
      .finally(() => { if (ticket === staleRef.current) setBusy(null); });
  };

  useEffect(() => {
    if (!open) { staleRef.current++; return; }
    const stored = storedTableName(kind);
    setNameInput(stored);
    read(stored);
    // Read once per opening: the values are those on screen when the button was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && recheckRef.current) { recheckRef.current = false; read(table?.table_name ?? name); }
    // Only a sync sets recheckRef; the values to check are the synced ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const check = table?.input_check;
  const blocked = check != null && check.configured && !check.valid;
  const syncAndCheck = () => {
    if (!check || check.rows.length === 0) return;
    recheckRef.current = true;
    onSyncMeasured(measuredPatch(check.rows));
  };

  const checkName = () => { if (nameOk && busy == null && name !== table?.table_name) read(name); };
  const canPick = (r: OnshapeRow) => r.status === 'update' || r.status === 'new' || r.status === 'error';
  // The write goes to the table that was read: a name edited since must be checked first.
  const current = table != null && name === table.table_name;
  const chosen = table && current ? table.rows.filter((r) => canPick(r) && picked.has(r.name)) : [];
  const toggle = (n: string) => setPicked((p) => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; });

  const write = async () => {
    if (!table || writingRef.current) return;
    writingRef.current = true;
    setBusy('write'); setError(null);
    try {
      const t = await onshapeCall('/api/linkage/onshape/apply', { ...params, table_name: table.table_name, names: chosen.map((r) => r.name) });
      setTable(t);
      if (t.write_error) {
        setError(`${t.table_created ? `The table ${t.table_name} was created and now exists, but the` : 'The'} write did not go through: ${t.write_error}. Writing again reads the same table first, then writes.`);
      } else {
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The write to Onshape failed.');
    } finally {
      writingRef.current = false;
      setBusy(null);
    }
  };

  const statusText: Record<OnshapeRow['status'], [string, string]> = {
    update: ['will change', 'text-amber-300'], same: ['already equal', 'text-neutral-500'], new: ['will be added', 'text-amber-300'],
    written: ['written', 'text-emerald-400'], created: ['added', 'text-emerald-400'], skipped: ['left as is', 'text-neutral-500'], error: ['failed', 'text-red-400'],
  };
  const n = chosen.length;
  const plural = n > 1 ? 's' : '';

  return (
    <Modal open={open} onClose={onClose} size="lg" closeOnOverlayClick={busy == null} closeOnEsc={busy == null} showClose={busy == null}
      title="Write these dimensions to an Onshape variable table">
      <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <label htmlFor={`onshape-table-${kind}`} className="text-xs text-neutral-400">Variable table name</label>
          <div className="flex items-center gap-2">
            <Input id={`onshape-table-${kind}`} type="text" value={nameInput} maxLength={60} disabled={busy != null}
              onChange={(e) => setNameInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') checkName(); }}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm text-neutral-100" />
            <Button variant="ghost" type="button" onClick={checkName} disabled={!nameOk || busy != null || current}
              className="shrink-0 rounded-lg border border-neutral-700 px-2 py-1 text-xs text-neutral-200 disabled:opacity-40">
              Look up
            </Button>
          </div>
          {!nameOk && <p className="text-xs text-red-300" role="alert">1 to 60 characters: letters, digits, space, dash or underscore.</p>}
          <p className="text-xs leading-snug text-neutral-500">
            The table is a Variable Studio tab of the Onshape document. A Part Studio uses these values only once the table is
            referenced there (Insert &gt; Variable Studio reference), which you do once by hand. A new name gives a new table.
          </p>
        </div>
        {busy === 'read' && <p className="text-neutral-400" role="status">Looking for the table in Onshape…</p>}
        {error && <p className="rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">{error}</p>}
        {table && (
          <>
            <p className="text-xs leading-snug text-neutral-400">
              {done
                ? `Done${table.table_created ? `: the table ${table.table_name} was created` : ''}. Parts change once a Part Studio references this table.`
                : table.table_exists
                  ? `${table.table_name} exists. Only the ticked variables change; every other variable in it, yours included, is kept as it is.`
                  : `There is no table called ${table.table_name} in the document yet. Writing creates it with the ticked variables.`}
            </p>
            {!current && !done && <p className="text-xs text-amber-300">The name changed: press Look up before writing.</p>}
            {check?.configured && (
              <div className={`rounded-lg border p-2 text-xs ${check.valid ? 'border-emerald-600/60 bg-emerald-900/20 text-emerald-200' : 'border-red-500/50 bg-red-900/30 text-red-200'}`} role="status">
                <p className="font-bold">
                  {check.valid ? 'Valid export: the simulation starts from the inputs Onshape measures now.' : 'Export not valid: the simulation does not start from the inputs Onshape measures now.'}
                </p>
                {check.error && <p className="mt-1">{check.error}</p>}
                {check.rows.map((r) => (
                  <p key={r.key} className="mt-1 font-mono">
                    {r.label}: simulator {r.simulator.toFixed(4)} {r.unit}, Onshape #{r.variable} {r.value.toFixed(4)} {r.unit} {r.ok ? '✓' : '✗'}
                  </p>
                ))}
                {!check.valid && check.rows.some((r) => !r.ok) && (
                  <Button variant="ghost" type="button" onClick={syncAndCheck} disabled={busy != null}
                    className="mt-2 rounded-lg border border-red-400/60 px-2 py-1 text-xs font-bold text-red-100 disabled:opacity-40">
                    Sync from Onshape and check again
                  </Button>
                )}
              </div>
            )}
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-neutral-700">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-neutral-900 text-left text-neutral-400">
                  <tr><th className="p-2" /><th className="p-2">Onshape variable</th><th className="p-2">In the table now</th><th className="p-2">From the simulator</th><th className="p-2">Status</th></tr>
                </thead>
                <tbody>
                  {table.rows.map((r) => (
                    <tr key={r.name} className="border-t border-neutral-800">
                      <td className="p-2">
                        {!done && <input type="checkbox" aria-label={`Write ${r.name}`} checked={canPick(r) && picked.has(r.name)} disabled={!canPick(r) || busy != null}
                          onChange={() => toggle(r.name)} className="accent-amber-500" />}
                      </td>
                      <td className="p-2"><span className="font-mono text-neutral-100">#{r.name}</span><span className="block text-[10px] text-neutral-500">{r.label}</span></td>
                      <td className="p-2 font-mono text-neutral-300">{r.current_expression ?? '—'}</td>
                      <td className="p-2 font-mono text-neutral-100">{r.new_expression}</td>
                      <td className={`p-2 ${statusText[r.status][1]}`} title={r.detail || undefined}>
                        {statusText[r.status][0]}{r.status === 'error' && r.detail ? `: ${r.detail}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3">
              {table.table_url
                ? <a href={table.table_url} target="_blank" rel="noopener noreferrer" className="text-xs text-amber-300 underline">Open the table in Onshape</a>
                : <span />}
              <div className="flex gap-2">
                <Button variant="ghost" type="button" onClick={onClose} disabled={busy != null} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-bold text-neutral-300">
                  {done ? 'Close' : 'Cancel'}
                </Button>
                {!done && (
                  <Button variant="ghost" type="button" onClick={write} disabled={busy != null || n === 0 || blocked}
                    title={blocked ? 'Sync the measured inputs from Onshape first' : undefined}
                    className="flex items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-500 px-3 py-1.5 text-xs font-bold text-neutral-900 disabled:opacity-40">
                    <UploadCloud className="w-3.5 h-3.5" />
                    {busy === 'write' ? 'Writing…'
                      : blocked ? 'Export not valid'
                        : n === 0 ? 'Nothing to write'
                        : table.table_exists ? `Overwrite ${n} variable${plural} in ${table.table_name}`
                          : `Create the table and write ${n} variable${plural}`}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────

export default function LinkageExplorer({ kind, shared, mode, onOpenExplorer, onProfileStateChange, profileRef }: {
  kind: LinkageKind; shared: LinkageShared; mode: SubTab; onOpenExplorer: () => void;
  /** The header pill's view of the loaded profile (type = kind). */
  onProfileStateChange?: (state: ProfileState) => void;
  profileRef?: Ref<ProfileHandle>;
}) {
  const lever = kind === 'lever';
  const pendulum = kind === 'pendulum';
  const [stored] = useState(() => loadStored(kind, shared));
  const [params, setParams] = useState<LinkageParams>(stored.params);
  const [search, setSearch] = useState<LinkageSearch>(stored.search);
  const [chartSettings, setChartSettings] = useState<LinkageChartSettings>(stored.chart_settings);
  /** Chart settings the loaded profile holds; unknown after a page reload, like `savedSnapshot`. */
  const [savedChartSettings, setSavedChartSettings] = useState<LinkageChartSettings | null>(null);
  const [data, setData] = useState<LinkageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [y, setY] = useState(0);
  const [details, setDetails] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [optMessage, setOptMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** The last search's answer, with what was fixed and searched when it was sent. */
  const [optOut, setOptOut] = useState<{ found: boolean; report?: SearchReport; params?: LinkageParams; result?: LinkageResult; vars: SearchVar[]; fixed: SearchVar[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeProfile, setActiveProfile] = useState<string | null>(stored.profile);
  /** What the active profile holds on the server, to flag unsaved changes. Unknown after a page reload. */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [onshapeOpen, setOnshapeOpen] = useState(false);
  const [materials, setMaterials] = useState<Material[]>(BUILTIN_MATERIALS);
  const [materialName, setMaterialName] = useState('');
  const [materialMessage, setMaterialMessage] = useState<string | null>(null);
  /** Time into the cycle 0, +stroke, 0, -stroke, 0 while oscillating (s). */
  const [cycleT, setCycleT] = useState<number | null>(null);
  /** Distance run in the current cycle (mm), plus the live speed and stroke for the animation loop. */
  const motion = useRef({ d: 0, speed: 0, stroke: 1 });

  const set = <K extends keyof LinkageParams>(key: K, value: LinkageParams[K]) => setParams((p) => ({ ...p, [key]: value }));
  const [measure, setMeasure] = useState<{ busy: boolean; ok: boolean; text: string | null }>({ busy: false, ok: true, text: null });
  /** Overwrites the inputs the CAD decides with what Onshape measures now (one read-only API call per value). */
  const syncMeasured = async () => {
    setMeasure({ busy: true, ok: true, text: null });
    try {
      const m = await readMeasured(params);
      if (!m.configured || m.values.length === 0) {
        setMeasure({ busy: false, ok: false, text: 'No measured input is set up in Onshape for this linkage.' });
        return;
      }
      setParams((p) => ({ ...p, ...measuredPatch(m.values) }));
      setMeasure({ busy: false, ok: true, text: m.values.map((v) => `${v.value.toFixed(4)} ${v.unit} from #${v.variable}`).join(', ') });
    } catch (e) {
      setMeasure({ busy: false, ok: false, text: e instanceof Error ? e.message : 'Could not read Onshape.' });
    }
  };
  const setS = (key: Exclude<keyof LinkageSearch, 'objective' | 'fixed'>, value: number) => setSearch((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    try { localStorage.setItem(storageKey(kind), JSON.stringify({ params, search, profile: activeProfile, chart_settings: chartSettings })); } catch { /* ignore */ }
  }, [kind, params, search, activeProfile, chartSettings]);

  const refreshMaterials = useCallback(async () => {
    try {
      const res = await apiFetch('/api/linkage/materials');
      if (res.ok) setMaterials((await res.json()).materials ?? BUILTIN_MATERIALS);
    } catch { /* the built-in ones stay */ }
  }, []);
  useEffect(() => { refreshMaterials(); }, [refreshMaterials]);
  /** The material whose two values are the ones on screen, if any. */
  const material = materials.find((m) => m.modulus_mpa === params.member_modulus_mpa && m.strength_mpa === params.member_strength_mpa) ?? null;
  const pickMaterial = (name: string) => {
    const m = materials.find((item) => item.name === name);
    if (m) setParams((p) => ({ ...p, member_modulus_mpa: m.modulus_mpa, member_strength_mpa: m.strength_mpa }));
    setMaterialMessage(null);
  };
  const saveMaterial = async () => {
    const name = materialName.trim();
    if (!name) { setMaterialMessage('Give the material a name first.'); return; }
    try {
      const res = await apiFetch(`/api/linkage/materials/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modulus_mpa: params.member_modulus_mpa, strength_mpa: params.member_strength_mpa }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
      setMaterialName('');
      setMaterialMessage(null);
      refreshMaterials();
    } catch (e) { setMaterialMessage(`Not saved: ${e instanceof Error ? e.message : e}`); }
  };
  const deleteMaterial = async () => {
    if (!material || material.builtin || !window.confirm(`Delete the material "${material.name}"?`)) return;
    try {
      const res = await apiFetch(`/api/linkage/materials/${encodeURIComponent(material.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refreshMaterials();
    } catch (e) { setMaterialMessage(`Not deleted: ${e instanceof Error ? e.message : e}`); }
  };

  // Key order free: a profile read back from the server compares equal to the same values on screen.
  const snapshot = stableJson({ params, search });
  const chartSettingsDirty = savedChartSettings != null
    && (Object.keys(savedChartSettings) as LinkageChartKey[]).some((k) => !sameDomainSettings(chartSettings[k], savedChartSettings[k]));
  const profileDirty = activeProfile != null && ((savedSnapshot != null && savedSnapshot !== snapshot) || chartSettingsDirty);

  // No note field here: an update keeps the note stored with the profile.
  useReportProfileState({ name: activeProfile, dirty: profileDirty, canSave: true }, onProfileStateChange);
  // After a reload the profile named in localStorage is read once, without touching the values on screen,
  // so the unsaved marker and Update work against what it holds on the server.
  useEffect(() => {
    const name = stored.profile;
    if (!name) return;
    let live = true;
    getProfile(kind, name).then((p) => {
      if (!live) return;
      const f = fromProfilePayload(kind, p.payload);
      setSavedSnapshot((prev) => prev ?? stableJson({ params: f.params, search: f.search }));
      setSavedChartSettings((prev) => prev ?? f.chart_settings);
    }).catch(() => { /* unknown, as before: no marker */ });
    return () => { live = false; };
  }, [kind, stored.profile]);

  useImperativeHandle(profileRef, () => ({
    type: kind,
    getPayload: () => ({ params, search, chart_settings: chartSettings }),
    apply: (profile) => {
      const { params: p, search: s, chart_settings: c } = fromProfilePayload(kind, profile.payload);
      setPlaying(false);
      setParams(p);
      setSearch(s);
      setChartSettings(c);
      setSavedChartSettings(c);
      setActiveProfile(profile.name);
      setSavedSnapshot(stableJson({ params: p, search: s }));
    },
    markSaved: (name, _note, payload) => {
      setActiveProfile(name);
      setSavedSnapshot(stableJson({ params: payload.params, search: payload.search }));
      setSavedChartSettings(payload.chart_settings as LinkageChartSettings);
    },
    detach: () => {
      setActiveProfile(null);
      setSavedSnapshot(null);
      setSavedChartSettings(null);
    },
  }));

  const simulate = useCallback(async (p: LinkageParams) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await apiFetch('/api/linkage/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p), signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError('Failed to reach the backend for the linkage simulation.');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { simulate(params); }, 100);
    return () => clearTimeout(t);
  }, [params, simulate]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const yPose = Math.min(Math.max(y, -params.stroke), params.stroke);
  const heightFixed = params.fixed_height > 0;
  const fast = search.objective === 'response';

  // What the motor really turns under load and friction, and the carriage speed that gives.
  const loadedRpm = params.motor_speed * params.speed_factor;
  const speed = loadedRpm * params.lead_screw_pitch / 60;
  useEffect(() => {
    motion.current.speed = speed;
    motion.current.stroke = params.stroke;
  }, [speed, params.stroke]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let shown = 0;
    const step = (now: number) => {
      const m = motion.current;
      if (m.speed <= 0) { setPlaying(false); return; }
      if (last != null) m.d = (m.d + (now - last) / 1000 * m.speed) % (4 * m.stroke);
      last = now;
      if (now - shown > 30) {
        shown = now;
        const s = m.stroke;
        setY(m.d <= s ? m.d : m.d <= 3 * s ? 2 * s - m.d : m.d - 4 * s);
        setCycleT(m.d / m.speed);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    // Resume from where the carriage is: on the way up if Y >= 0, on the way down otherwise.
    if (!playing) motion.current.d = yPose >= 0 ? yPose : 2 * params.stroke - yPose;
    setPlaying(!playing);
  };

  /** The dimensions this linkage type's optimizer searches, most influential first (as in backend optimize_linkage). */
  const searchVars = SEARCH_VARS_OF[kind];
  // With the total height fixed the link length is computed and its range only filters: pinning it would reject almost everything.
  const canFix = (v: SearchVar) => !(v === 'bar1' && heightFixed);
  const fixedVars = searchVars.filter((v) => canFix(v) && search.fixed.includes(v));
  const onePiece = pendulum && params.compliant;

  const optimize = async () => {
    setOptimizing(true);
    setOptMessage(null);
    setOptOut(null);
    const ranges: Partial<LinkageSearch> = { ...search };
    delete ranges.fixed;
    const pinned: Record<string, number> = {};
    for (const v of fixedVars) {
      const value = params[VAR_PARAM[v]] as number;
      pinned[`${v}_min`] = value;
      pinned[`${v}_max`] = value;
    }
    const sentVars = searchVars, sentFixed = fixedVars;
    try {
      const res = await apiFetch('/api/linkage/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, ...ranges, ...pinned }),
      });
      if (res.status === 422) {
        // The tube model refused these inputs (the FEM tube balloons at this pressure, for example).
        const body = await res.json().catch(() => null);
        if (typeof body?.detail === 'string') { setOptMessage({ ok: false, text: body.detail }); return; }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      const report: SearchReport | undefined = out.search_report && typeof out.search_report === 'object' ? out.search_report : undefined;
      if (!out.found) {
        setOptOut({ found: false, report, vars: sentVars, fixed: sentFixed });
        const widen = `No feasible geometry among ${out.tested} combinations. Widen the ranges, ${heightFixed ? 'change the total height' : 'raise the pivot height limit'}${fast ? ', allow more travel' : ''} or allow more over-squeeze (it must be above the preload).`;
        setOptMessage({ ok: false, text: !report ? widen
          : (report.shortlist ?? 0) > 0 ? 'No design passed the limits. The design on screen was kept.'
          : `${widen} The design on screen was kept.` });
        return;
      }
      // An older backend returns params without the newer fields: keep those from the screen.
      const p: LinkageParams = { ...params, ...out.params, linkage_type: kind };
      setParams(p);
      setOptOut({ found: true, report, params: p, result: out.result, vars: sentVars, fixed: sentFixed });
      setOptMessage({ ok: true, text: `Applied (${out.feasible} of ${out.tested} first draws feasible).` });
    } catch {
      setOptMessage({ ok: false, text: 'Optimizer request failed.' });
    } finally {
      setOptimizing(false);
    }
  };

  const chartData = useMemo(() => (data?.Y_positions ?? []).map((yy, i) => ({
    y: yy, flowA: data!.flow_a[i], flowB: data!.flow_b[i], target: data!.flow_target[i], gapA: data!.gap_loaded_a[i], gapB: data!.gap_loaded_b[i], rigidA: data!.gap_a[i],
    forceA: data!.force_a[i] ?? null, forceB: data!.force_b[i] ?? null, thrust: data!.thrust[i] ?? null,
    stressA: data!.stress_a[i] ?? null, stressB: data!.stress_b[i] ?? null,
    flexA: data!.flex_a[i] ?? null, flexB: data!.flex_b[i] ?? null, flexLink: data!.flex_link_a[i] ?? null, flexBend: data!.flex_bend_a[i] ?? null,
  })), [data]);
  const forces = data != null && data.seal_force != null;
  /** Travel where a pin reaches the wall through its closed tube: the force figures stop there. */
  const jamY = data?.jam_y ?? null;
  const n2 = (v: number | null | undefined, unit: string, digits = 2) => (v == null ? 'N/A' : `${v.toFixed(digits)} ${unit}`);
  const cycleData = useMemo(() => (data?.time_ms ?? []).map((t, i) => ({
    t: t / 1000, flowIn: data!.flow_in_l_min[i], flowOut: data!.flow_out_l_min[i], kpa: data!.chamber_kpa[i], y: data!.y_time[i],
  })), [data]);

  const tooltipStyle = { backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' };
  const margin = { top: 6, right: 16, bottom: 18, left: 16 };
  const xAxisY = (c: ChartDomainSettings) => (
    <XAxis dataKey="y" type="number" domain={chartDomain(c, 'x', ['dataMin', 'dataMax'])} allowDataOverflow={!c.autoX} stroke="#888"
      label={{ value: 'Carriage Y (mm)', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(v) => Number(v).toFixed(1)} />
  );
  const cardProps = (key: LinkageChartKey) => ({
    settings: chartSettings[key],
    onSettingsChange: (next: ChartDomainSettings) => setChartSettings((prev) => ({ ...prev, [key]: next })),
    // Against the loaded profile, or the defaults with no profile; a profile reloaded from storage is unknown, so not flagged.
    modified: activeProfile == null ? !sameDomainSettings(chartSettings[key], DEFAULT_CHART_SETTINGS[key])
      : savedChartSettings != null && !sameDomainSettings(chartSettings[key], savedChartSettings[key]),
  });

  const varLabel = VAR_LABEL[kind];
  const toggleFixed = (v: SearchVar, on: boolean) => setSearch((s) => ({ ...s, fixed: SEARCH_VARS.filter((f) => (f === v ? on : s.fixed.includes(f))) }));

  // ─── Control groups shared by both menus: one state, two places ───

  const heightControls = pendulum && (
    <>
      <Switch label="Fix total height (2·h₀)" on={heightFixed}
        onChange={() => setParams((p) => (heightFixed
          ? { ...p, fixed_height: 0, bar1_length: data ? Math.round(data.link_length * 1000) / 1000 : p.bar1_length }
          : { ...p, fixed_height: data ? Math.round(data.pivot_height_y0 * 200) / 100 : 20 }))}
        title="Impose the height between the two anchors. The link length is then computed so that the tube is still just closed at Y = 0." />
      {heightFixed && (
        <ParameterSlider label="Total height (mm)" value={params.fixed_height} min={4} max={40} step={0.05} onChange={(v) => set('fixed_height', v)}
          secondaryValue={`h₀ ${(params.fixed_height / 2).toFixed(2)}`}
          description="Distance between the top anchor of tube A's arm and the bottom anchor of tube B's arm. The carriage pivot sits halfway at Y = 0." />
      )}
    </>
  );

  const padSlider = pendulum && (
    <ParameterSlider label="Contact pad (mm)" value={params.pad_length} min={0} max={6} step={0.05} onChange={(v) => set('pad_length', v)}
      secondaryValue={params.pad_length === 0 ? 'point' : undefined}
      description="Length of the flat segment that touches the tube, centred on the end of the foot and square to it. Its ends are rounded with the pinch pin diameter. As the arm tilts, the end nearer the wall does the pinching. 0 is a round pin." />
  );

  const pneumaticControls = (
    <div className="space-y-5 pt-2">
      <ParameterSlider label="Pressure (kPa)" value={params.input_pressure_kpa} min={0} max={1050} step={1} inputDecimals={1} onChange={(v) => set('input_pressure_kpa', v)} />
      <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1} max={12} step={0.1} onChange={(v) => set('tube_id', v)} />
      <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1} max={16} step={0.1} onChange={(v) => set('tube_od', v)} />
      <TubeModelControls model={params.tube_model} shore={params.tube_shore_a} onModel={(m) => set('tube_model', m)} onShore={(v) => set('tube_shore_a', v)} />
      <ParameterSlider label="Compliance" value={params.compliance} min={0} max={5} step={0.01} onChange={(v) => set('compliance', v)}
        disabled={params.tube_model !== 'simple'} secondaryValue={params.tube_model !== 'simple' ? 'Simple model only' : undefined} />
      <ParameterSlider label="Chamber vol (mL)" value={params.chamber_volume_ml} min={0} max={200} step={0.5} onChange={(v) => set('chamber_volume_ml', v)}
        secondaryValue={params.chamber_volume_ml === 0 ? 'no traces' : undefined}
        description="Chamber fed by tube A and vented by tube B, for the in / out traces." />
    </div>
  );

  const layoutControls = (
    <>
      <ParameterSlider label="Stroke (mm)" value={params.stroke} min={0.5} max={10} step={0.1} onChange={(v) => set('stroke', v)}
        description="Carriage travel each way from closed (Y = 0) to the target full opening." />
      <ParameterSlider label="Pivot offset (mm)" value={params.pivot_offset} min={0} max={10} step={0.05} onChange={(v) => set('pivot_offset', v)}
        description="Carriage pivot distance from the screw axis, on the side opposite its tube." />
      <ParameterSlider label="Tube centre (mm)" value={params.tube_center_x} min={3} max={20} step={0.05} onChange={(v) => set('tube_center_x', v)}
        secondaryValue={data ? `wall ${data.wall_x.toFixed(2)}` : undefined}
        description="Tube axis distance from the screw axis. The tube rests on a wall half an OD further out." />
      {ONSHAPE_MEASURED[kind]?.includes('tube_center_x') && (
        <div className="-mt-1 flex flex-wrap items-center gap-2">
          <Button variant="ghost" type="button" onClick={syncMeasured} disabled={measure.busy}
            title="Overwrite the tube centre with the value the Onshape Part Studio measures now. The CAD decides this input."
            className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-40">
            <RefreshCw className={`w-3 h-3 ${measure.busy ? 'animate-spin' : ''}`} /> {measure.busy ? 'Reading Onshape…' : 'Sync from Onshape'}
          </Button>
          {measure.text && <span className={`text-[10px] ${measure.ok ? 'text-emerald-400' : 'text-red-300'}`} role="status">{measure.text}</span>}
        </div>
      )}
      <ParameterSlider label="Pinch pin Ø (mm)" value={params.pin_diameter} min={0} max={4} step={0.1} onChange={(v) => set('pin_diameter', v)}
        description="Diameter of the pin that presses on the tube." />
      <ParameterSlider label="Preload (mm)" value={params.preload} min={0} max={0.5} step={0.01} onChange={(v) => set('preload', v)}
        description="Extra squeeze past the just-closed gap at Y = 0, as a sealing margin. It is also the dead band around Y = 0." />
    </>
  );

  // ─── Explorer menu ───

  const geometrySliders: Record<SearchVar, ReactElement | null> = {
    bar2: pendulum
      ? <ParameterSlider key="bar2" label="Arm, L (mm)" value={params.bar2_length} min={2} max={30} step={0.05} onChange={(v) => set('bar2_length', v)}
          description="Fixed anchor on the opposite wall to the joint where the link pulls. The arm hangs along the tube." />
      : lever
      ? <ParameterSlider key="bar2" label="Attach point, c (mm)" value={params.bar2_length} min={1} max={25} step={0.05} onChange={(v) => set('bar2_length', v)}
          description="Distance along the lever from the anchor to the joint where the link pulls. L / c is the lever's amplification." />
      : <ParameterSlider key="bar2" label="Bar 2, L2 (mm)" value={params.bar2_length} min={1} max={20} step={0.05} onChange={(v) => set('bar2_length', v)}
          description="Elbow to the fixed anchor on the base." />,
    bar1: pendulum
      ? <ParameterSlider key="bar1" label="Link, r (mm)" value={heightFixed && data ? Math.round(data.link_length * 1000) / 1000 : params.bar1_length}
          min={2} max={30} step={0.05} onChange={(v) => set('bar1_length', v)} disabled={heightFixed}
          secondaryValue={heightFixed ? 'from height' : undefined}
          description="Carriage pivot (blue) to the joint at the end of the arm. Computed when the total height is fixed." />
      : lever
      ? <ParameterSlider key="bar1" label="Link, r (mm)" value={params.bar1_length} min={1} max={25} step={0.05} onChange={(v) => set('bar1_length', v)}
          description="Carriage pivot (blue) to the joint on the lever." />
      : <ParameterSlider key="bar1" label="Bar 1, L1 (mm)" value={params.bar1_length} min={2} max={30} step={0.05} onChange={(v) => set('bar1_length', v)}
          description="Carriage pivot (blue) to the elbow that pinches the tube." />,
    lever: <ParameterSlider key="lever" label="Lever, L (mm)" value={params.lever_length} min={4} max={30} step={0.05} onChange={(v) => set('lever_length', v)}
      description="Fixed anchor to the tip that pinches the tube. The lever reaches across the screw." />,
    anchor: <ParameterSlider key="anchor" label="Anchor dist, a (mm)" value={params.anchor_distance} min={-5} max={10} step={0.01} onChange={(v) => set('anchor_distance', v)}
      description={pendulum
        ? 'Fixed anchor offset from the centre of the base, toward its tube, on the wall opposite the carriage side it starts from.'
        : lever
        ? 'Fixed anchor offset from the centre of the base, on the side opposite its tube.'
        : 'Fixed anchor offset from the centre of the base, toward the tube. Negative puts it on the far side of the screw.'} />,
    foot: <ParameterSlider key="foot" label="Foot, f (mm)" value={params.foot_length} min={0} max={8} step={0.05} onChange={(v) => set('foot_length', v)}
      description="Rigid foot from the joint to the centre of the pin that presses on the tube." />,
    foot_angle: <ParameterSlider key="foot_angle" label="Foot angle (deg)" value={params.foot_angle_deg} min={0} max={180} step={1} onChange={(v) => set('foot_angle_deg', v)}
      description="Angle between the arm and the foot: 90 is square to the arm, toward the tube." />,
  };

  const explorerMenu = (
    <>
      <Accordion title="Geometry">
        <div className="space-y-5 pt-2">
          {searchVars.map((v) => geometrySliders[v])}
          {padSlider}
          {pendulum && (
            <>
              <div className="space-y-1.5">{heightControls}</div>
              <div className="space-y-1.5">
                <Switch label="One piece, built into the shell" on={params.compliant} onChange={(v) => set('compliant', v)}
                  title="Arm, foot and link are a single part fixed to the outer shell at the anchor. Nothing pivots: the carriage bends the part. Off: three rigid bars on pivots." />
                {params.compliant && (
                  <>
                    <Switch label="Carriage end clamped (no pivot rod)" on={params.carriage_clamped} onChange={(v) => set('carriage_clamped', v)}
                      title="Off: the link turns on the steel rod in the carriage (blue dot), the only real pivot. On: the link is clamped in the carriage and cannot turn there." />
                    {!params.carriage_clamped && (
                      <>
                        <ParameterSlider label="Pivot rod diameter" value={params.carriage_pin_diameter} min={0.5} max={4} step={0.1} onChange={(v) => set('carriage_pin_diameter', v)}
                          description="Steel rod the link turns on at the carriage." />
                        <ParameterSlider label="Pivot rod length" value={params.carriage_pin_length} min={2} max={20} step={0.5} onChange={(v) => set('carriage_pin_length', v)}
                          description="Half of it sits in the carriage, half in the link's eye." />
                      </>
                    )}
                    <p className="text-[10px] leading-snug text-neutral-400">
                      The part is made in its Y = 0 shape and only bends. Its section, modulus and strength are under Material and section. Small-deflection beam model: trust it up to about 10° of rotation.
                    </p>
                  </>
                )}
              </div>
              <div className="space-y-1.5">
                <Switch label="Curved link, tangent to the foot" on={params.link_curved} onChange={(v) => set('link_curved', v)}
                  title="The link becomes an arc of a circle from the carriage pivot to the joint, arriving along the foot at Y = 0. On pivots the opening law is the same and the arc bends under the pull. In one piece the arc is a softer spring than a straight link: less thrust and less stress for the same travel." />
                {params.link_curved && data && data.link_arc_radius != null && (
                  <p className="text-[10px] leading-snug text-neutral-400">
                    {`Arc radius ${data.link_arc_radius.toFixed(2)} mm, ${data.link_arc_sag.toFixed(2)} mm off the straight line, meeting the joint at ${data.link_arc_half_angle_deg.toFixed(0)}° from it.`}
                  </p>
                )}
                {params.link_curved && data && data.link_arc_radius == null && (
                  <p className="text-[10px] leading-snug text-neutral-400">The foot is already in line with the link, or has no length: the link stays straight.</p>
                )}
              </div>
            </>
          )}
        </div>
      </Accordion>

      <Accordion title="Layout" defaultOpen={false}>
        <div className="space-y-5 pt-2">
          <p className="text-[10px] leading-snug text-neutral-400">
            The second linkage is this one mirrored left to right and top to bottom, so the carriage opens one tube while it squeezes the other.
          </p>
          {layoutControls}
        </div>
      </Accordion>

      <Accordion title="Pneumatic system" defaultOpen={false}>
        {pneumaticControls}
      </Accordion>

      <Accordion title="Motor and screw" defaultOpen={false}>
        <div className="space-y-5 pt-2">
          <p className="text-[10px] leading-snug text-neutral-400">
            Forces are for the pressure set under Pneumatic system, taken as the maximum the seal must hold. The defaults here are assumed: set them to the real motor and screw.
          </p>
          <ParameterSlider label="Motor torque (mN·m)" value={params.motor_torque_mnm} min={1} max={300} step={1} onChange={(v) => set('motor_torque_mnm', v)}
            secondaryValue={`${(params.motor_torque_mnm / 98.0665).toFixed(2)} kg·cm`}
            description="Torque the gearmotor gives at its output shaft at the firmware's current limit (150 mA on the 100 RPM profile), not its stall torque." />
          <ParameterSlider label="Motor speed (RPM)" value={params.motor_speed} min={10} max={1000} step={10} onChange={(v) => set('motor_speed', v)}
            secondaryValue="no load"
            description="Rated no-load speed of the motor. With the load factor it sets how fast the carriage runs the cycle 0, +stroke, 0, -stroke, 0." />
          <ParameterSlider label="Load factor (%)" value={Math.round(params.speed_factor * 100)} min={10} max={100} step={1} onChange={(v) => set('speed_factor', v / 100)}
            secondaryValue={`${loadedRpm.toFixed(0)} RPM, ${speed.toFixed(2)} mm/s`}
            description="Share of the no-load speed the motor keeps under load and friction: 85 % makes a 100 RPM motor run at 85 RPM. Used by the Oscillate button and by the chamber traces." />
          <ParameterSlider label="Screw Ø (mm)" value={params.screw_diameter} min={1} max={12} step={0.1} onChange={(v) => set('screw_diameter', v)}
            secondaryValue={`pitch ${params.lead_screw_pitch}`}
            description="Major diameter of the lead screw: 3 for M3." />
          <ParameterSlider label="Thread friction" value={params.screw_friction} min={0.05} max={0.6} step={0.01} onChange={(v) => set('screw_friction', v)}
            description="Friction coefficient between the screw and the nut. It sets how much of the motor torque becomes thrust, and whether the screw holds its position with the motor off." />
        </div>
      </Accordion>

      <Accordion title="Material and section" defaultOpen={false}>
        <div className="space-y-5 pt-2">
          <div className="space-y-1.5 rounded-lg border border-neutral-700 p-2">
            <div className="flex items-center gap-2">
              <label htmlFor={`linkage-material-${kind}`} className="shrink-0 text-xs font-semibold text-neutral-400">Material</label>
              <select id={`linkage-material-${kind}`} value={material?.name ?? ''} onChange={(e) => pickMaterial(e.target.value)}
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100">
                {!material && <option value="">Custom values</option>}
                {materials.map((m) => <option key={m.name} value={m.name}>{`${m.name} (${(m.modulus_mpa / 1000).toFixed(1)} GPa, ${m.strength_mpa} MPa)`}</option>)}
              </select>
              <Button variant="ghost" type="button" onClick={deleteMaterial} disabled={!material || material.builtin}
                title={material?.builtin ? 'A built-in material cannot be deleted' : 'Delete this material'} aria-label="Delete this material"
                className="shrink-0 rounded-lg border border-neutral-700 p-1.5 text-neutral-400 hover:text-red-400 disabled:opacity-40">
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            {!material && (
              <div className="flex items-center gap-2">
                <Input type="text" value={materialName} maxLength={60} placeholder="Name these values" aria-label="Material name"
                  onChange={(e) => setMaterialName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveMaterial(); }}
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100" />
                <Button variant="ghost" type="button" onClick={saveMaterial}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-neutral-700 px-2 py-1 text-xs text-neutral-200">
                  <Save className="w-3.5 h-3.5" /> Save material
                </Button>
              </div>
            )}
            {materialMessage && <p className="text-[10px] leading-snug text-red-400" role="alert">{materialMessage}</p>}
            <p className="text-[10px] leading-snug text-neutral-400">
              A material is the modulus and the strength below. PETG and PLA are indicative values for printed parts. To add your own, set the two sliders, name them and save.
            </p>
          </div>
          <ParameterSlider label="Bar modulus (MPa)" value={params.member_modulus_mpa} min={500} max={210000} step={100} onChange={(v) => set('member_modulus_mpa', v)}
            secondaryValue={`${(params.member_modulus_mpa / 1000).toFixed(1)} GPa`}
            description="Young's modulus of the bars: about 2 500 for printed PETG, 3 500 for PLA, 70 000 for aluminium." />
          <ParameterSlider label="Material strength (MPa)" value={params.member_strength_mpa} min={5} max={1000} step={1} onChange={(v) => set('member_strength_mpa', v)}
            description="Stress the material may see; the one-piece pendulum is checked against it. Assumed 40 for printed PETG at yield; use less for a part that must flex many times, about 30 to 60 for PLA, 20 to 30 for TPU-like or nylon parts in fatigue." />
          <ParameterSlider label="Bar width (mm)" value={params.member_width} min={0.5} max={10} step={0.1} onChange={(v) => set('member_width', v)}
            description="Bar section in the plane of the mechanism. Bending stiffness goes with its cube." />
          <ParameterSlider label="Bar thickness (mm)" value={params.member_thickness} min={0.5} max={15} step={0.1} onChange={(v) => set('member_thickness', v)}
            description="Bar section out of the plane of the mechanism." />
          {onePiece && !params.carriage_clamped && (
            <ParameterSlider label="Pivot rod strength (MPa)" value={params.carriage_pin_strength_mpa} min={50} max={2000} step={10} onChange={(v) => set('carriage_pin_strength_mpa', v)}
              description="Bending stress the steel pivot rod may see. Assumed 300." />
          )}
          <div className="space-y-1.5">
            <Switch label="Tube pushes the pin back" on={params.contact_deformation} onChange={(v) => set('contact_deformation', v)}
              title="On: at each position the crushed tube and the flexing bars are balanced, and the flow, the dead band and the response use the gap that results. Off: rigid bars, the gap is the bar geometry alone." />
            <p className="text-[10px] leading-snug text-neutral-400">
              {params.contact_deformation
                ? 'Flow, dead band and response use the gap left once the crushed tube and the flexing bars balance. The search still uses rigid bars.'
                : 'Rigid bars: the gap is the bar geometry alone.'}
            </p>
          </div>
        </div>
      </Accordion>

      <Accordion title="Results">
        <div className="space-y-4 pt-2">
          {data && data.forces_message && (
            <p className="rounded-lg border border-neutral-700 p-2 text-xs text-neutral-400" role="status">{data.forces_message}</p>
          )}
          {data && data.flexure && data.max_stress_mpa != null && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">One-piece part{jamY != null ? `, up to Y = ±${jamY.toFixed(2)} mm` : ''}</h3>
              <StatRow label={`Worst stress (${data.max_stress_where}${data.max_stress_spot === 'shell' ? ', at the shell' : data.max_stress_spot === 'joint' ? ', at the joint' : data.max_stress_spot === 'carriage' ? ', at the carriage' : ''})`} highlight value={
                <span className={data.stress_margin != null && data.stress_margin < 1 ? 'text-red-400' : data.stress_margin != null && data.stress_margin < 2 ? 'text-amber-400' : undefined}>
                  {`${data.max_stress_mpa.toFixed(0)} MPa${data.stress_margin != null ? `, × ${data.stress_margin.toFixed(2)} of ${params.member_strength_mpa} MPa` : ''}`}
                </span>} />
              {data.stress_limit_y != null && <StatRow label="Past the strength from" value={<span className="text-red-400">{`Y = ±${data.stress_limit_y.toFixed(2)} mm`}</span>} />}
              {data.carriage_bearing_mpa != null && (
                <>
                  <StatRow label="Pressure in the link's eye" value={
                    <span className={params.member_strength_mpa > 0 && data.carriage_bearing_mpa > params.member_strength_mpa ? 'text-red-400' : undefined}>
                      {`${data.carriage_bearing_mpa.toFixed(1)} MPa`}
                    </span>} />
                  {data.carriage_pin_bending_mpa != null && <StatRow label="Rod bending at the carriage face" value={
                    <span className={params.carriage_pin_strength_mpa > 0 && data.carriage_pin_bending_mpa > params.carriage_pin_strength_mpa ? 'text-red-400' : undefined}>
                      {`${data.carriage_pin_bending_mpa.toFixed(0)} MPa`}
                    </span>} />}
                </>
              )}
              <StatRow label="Largest rotation" value={data.max_rotation_deg == null ? 'N/A'
                : <span className={data.max_rotation_deg > 10 ? 'text-amber-400' : undefined}>{`${data.max_rotation_deg.toFixed(1)}°`}</span>} />
              <StatRow label="Thrust to bend both parts, no tube" value={n2(data.spring_rate, 'N/mm', 1)} />
              <StatRow label="Pin moves, per mm of carriage" value={`${data.sensitivity_y0.toFixed(3)} mm`} />
              {data.carriage_bearing_mpa != null && <StatRow label="Worst load on the pivot rod" value={n2(data.carriage_load, 'N', 1)} />}
              {data.stress_margin != null && data.stress_margin < 1 && (
                <p className="text-[10px] leading-snug text-red-400" role="alert">
                  The part is stressed past its strength within this stroke. Make it thinner in the plane (bar width), longer, softer (modulus), or shorten the stroke.
                </p>
              )}
              <p className="text-[10px] leading-snug text-neutral-400">
                One section for arm, foot and link. Fillets at the joints are not modelled: a generous radius there lowers the real peak, a sharp corner raises it.
                {data.carriage_bearing_mpa != null && ' The rod sits half in the carriage, half in the eye of the link: the eye pressure is the load over rod diameter × half the rod length, and the rod bends where it leaves the carriage, with the load at the middle of the eye. The eye itself is not drawn, the pressure in the carriage bore is not checked, and friction on the rod is ignored.'}
              </p>
            </div>
          )}
          {data && forces && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">Forces at {formatKpa(params.input_pressure_kpa)} kPa{jamY != null ? `, up to Y = ±${jamY.toFixed(2)} mm` : ''}</h3>
              <StatRow label="Seal at Y=0 holds" highlight value={data.seal_pressure_y0_kpa == null ? 'N/A'
                : <span className={data.sealed_after_flex ? undefined : 'text-red-400'}>{`${data.seal_pressure_y0_kpa.toFixed(1)} kPa${data.sealed_after_flex ? '' : ', leaks'}`}</span>} />
              <StatRow label="Motor margin" highlight value={data.motor_margin == null ? 'N/A'
                : <span className={data.motor_margin < 1 ? 'text-red-400' : undefined}>{`× ${data.motor_margin.toFixed(1)} (${n2(data.motor_torque_needed_mnm, 'mN·m', 1)})`}</span>} />
              {jamY != null && <StatRow label="Pin hits the wall at" value={<span className="text-red-400">{`Y = ±${jamY.toFixed(2)} mm`}</span>} />}
              {data.stall_y != null && <StatRow label="Motor stalls from" value={<span className="text-red-400">{`Y = ±${data.stall_y.toFixed(2)} mm`}</span>} />}
              <StatRow label="Screw holds with motor off" value={data.screw_self_locking == null ? 'N/A' : data.screw_self_locking ? 'yes' : 'no'} />
              {data.buckling_factor != null && (
                <StatRow label="Buckling margin" value={<span className={data.buckling_factor < 3 ? 'text-amber-400' : undefined}>{`× ${data.buckling_factor.toFixed(1)}`}</span>} />
              )}
              <StatRow label={`Least force to seal ${formatKpa(params.input_pressure_kpa)} kPa`} value={`${n2(data.seal_force_min, 'N')} per tube`} highlight />
              <StatRow label="Pin force at Y=0, with preload" value={`${n2(data.seal_force, 'N')} per tube`} highlight />
              <StatRow label="Fold flat / squeeze / air" value={`${data.seal_force_flatten!.toFixed(2)} / ${data.seal_force_squeeze!.toFixed(2)} / ${data.seal_force_pressure!.toFixed(2)} N`} />
              <StatRow label="Tube wall modulus" value={n2(data.tube_modulus_mpa, 'MPa')} />
              <StatRow label="Worst pin force" value={n2(data.max_pinch_force, 'N', 1)} />
              <StatRow label="Worst wall squeeze" value={<span className={data.max_wall_strain! > 0.25 ? 'text-amber-400' : undefined}>{(data.max_wall_strain! * 100).toFixed(0)} %</span>} />
              <StatRow label="Screw thrust at Y=0" value={n2(data.thrust_y0, 'N')} />
              <StatRow label="Worst screw thrust" value={n2(data.thrust_needed, 'N', 1)} />
              <StatRow label="Motor thrust available" value={n2(data.thrust_available, 'N', 1)} />
              <StatRow label="Pin pushed back at Y=0" value={n2(data.flex_y0, 'mm', 4)} />
              <StatRow label="Bar stiffness at the pin" value={n2(data.pin_stiffness, 'N/mm', 0)} />
              {!data.flexure && <StatRow label="Worst link force" value={data.max_link_force == null ? 'N/A' : `${Math.abs(data.max_link_force).toFixed(1)} N ${data.max_link_force < 0 ? 'push' : 'pull'}`} />}
              <StatRow label="Worst side load on carriage" value={n2(data.max_side_load, 'N', 1)} />
              {data.link_bending_stress_mpa != null && (
                <StatRow label="Curved link bending" value={`${data.link_bending_stress_mpa.toFixed(1)} MPa, ${data.link_arc_sag.toFixed(2)} mm off line`} />
              )}
              <StatRow label="Worst bending / axial stress" value={data.max_bending_stress_mpa == null || data.max_axial_stress_mpa == null ? 'N/A' : `${data.max_bending_stress_mpa.toFixed(1)} / ${data.max_axial_stress_mpa.toFixed(1)} MPa`} />
              {jamY != null ? (
                <p className="text-[10px] leading-snug text-red-400" role="alert">
                  {`The pin reaches the wall through the closed tube at Y = ±${jamY.toFixed(2)} mm${data.y_full_open != null && data.y_full_open > jamY ? `, before the other tube is fully open (${data.y_full_open.toFixed(2)} mm)` : ''}: the mechanism jams there whatever the motor. Forces, margin and flex are given up to that travel only.`}
                </p>
              ) : data.max_wall_strain! > 0.25 && (
                <p className="text-[10px] leading-snug text-amber-400">
                  The closed tube is squeezed past 25 % of its walls within this stroke: worst-case figures there are an order of magnitude.
                </p>
              )}
            </div>
          )}
          {data && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">Derived</h3>
              <StatRow label="Full flow at" value={data.y_full_open != null ? `Y = ${data.y_full_open.toFixed(2)} mm` : 'not reached'} />
              <StatRow label="Time to full flow" value={data.response_time_ms != null ? `${data.response_time_ms.toFixed(0)} ms` : 'N/A'} highlight />
              <StatRow label="Dead band (both ways)" value={data.y_open != null ? `${(2 * data.y_open).toFixed(3)} mm` : 'N/A'} />
              <StatRow label="Closed-tube over-squeeze" value={`${data.max_oversqueeze.toFixed(3)} mm`} />
              <StatRow label="Deviation from target" value={data.rms_error != null ? `${(data.rms_error * 100).toFixed(1)} % RMS` : 'N/A'} />
              <StatRow label="Pivot height at Y=0" value={`${data.pivot_height_y0.toFixed(3)} mm`} highlight />
              <StatRow label="Anchor to anchor height" value={`${(2 * data.pivot_height_y0).toFixed(2)} mm`} />
              <StatRow label="Gain at Y=0" value={`${data.sensitivity_y0.toFixed(3)} mm/mm`} />
              <StatRow label="Pinch slide on tube" value={`${data.pinch_slide.toFixed(2)} mm`} />
              <StatRow label="Max flow (static)" value={`${data.max_flow_l_min.toFixed(2)} L/min`} />
              {data.time_ms.length > 0 && (
                <StatRow label="Air in / out per cycle" value={`${data.volume_in_ml.toFixed(1)} / ${data.volume_out_ml.toFixed(1)} mL`} />
              )}
            </div>
          )}
        </div>
      </Accordion>
    </>
  );

  // ─── Finder menu ───

  const res = optOut?.result;
  const report = optOut?.report;
  const rejected = report?.rejected;
  const rejectedText = rejected
    ? ([['stress', 'part stress'], ['thrust', 'screw thrust'], ['eye', 'eye pressure'], ['rod', 'rod bending'], ['no_flow', 'no flow']] as const)
      .filter(([k]) => typeof rejected[k] === 'number' && rejected[k]! > 0)
      .map(([k, name]) => `${name} ${rejected[k]}`).join(', ')
    : '';

  const finderMenu = (
    <>
      <Accordion title="Goal">
        <div className="space-y-3 pt-2">
          {/* Plain buttons with the kit's tab classes: a kit ghost Button paints over the selected state. */}
          <div className="bui-tablist flex w-full">
            {(['response', 'target'] as const).map((goal) => (
              <button key={goal} type="button" aria-pressed={search.objective === goal}
                onClick={() => setSearch((s) => ({ ...s, objective: goal }))}
                className={`bui-tab flex-1 px-2 py-1 text-xs${search.objective === goal ? ' bui-tab--active' : ''}`}>
                {goal === 'response' ? 'Most flow, least dead band' : 'Follow target'}
              </button>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-neutral-400">
            {fast
              ? 'Most flow first, then the narrowest dead band, then the shortest travel, without squeezing the closed tube past the limit. The stroke is then set to the travel used.'
              : 'Opening as close as possible to the target curve over the stroke.'}
          </p>
          {fast && (
            <ParameterSlider label="Max travel (mm)" value={search.max_stroke} min={0.5} max={10} step={0.1} onChange={(v) => setS('max_stroke', v)}
              description="Longest carriage travel each way the search may use to reach full flow." />
          )}
          {!fast && <ParameterSlider label="Target exponent" value={params.target_exponent} min={0.3} max={3} step={0.05} onChange={(v) => set('target_exponent', v)}
            secondaryValue={params.target_exponent === 1 ? 'linear' : undefined}
            description="Target opening = (Y / stroke)^exponent, closed at Y = 0 and full bore at the end of the stroke. 1 is strictly proportional; above 1 is finer near closure." />}
        </div>
      </Accordion>

      <Accordion title="Imposed: pneumatic" defaultOpen={false}>
        {pneumaticControls}
      </Accordion>

      <Accordion title="Imposed: layout" defaultOpen={false}>
        <div className="space-y-5 pt-2">
          {heightControls && <div className="space-y-1.5">{heightControls}</div>}
          {layoutControls}
          {padSlider}
        </div>
      </Accordion>

      <Accordion title="Geometry to search">
        <div className="space-y-3 pt-2">
          {searchVars.map((v) => {
            const fixable = canFix(v);
            const fixed = fixable && search.fixed.includes(v);
            const current = v === 'bar1' && heightFixed && data ? data.link_length : params[VAR_PARAM[v]] as number;
            return (
              <div key={v} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-300">{varLabel[v]}</span>
                  {fixable ? (
                    <label className="flex items-center gap-1.5 text-xs text-neutral-400">
                      <input type="checkbox" checked={fixed} onChange={(e) => toggleFixed(v, e.target.checked)} className="accent-amber-500" />
                      Fixed
                    </label>
                  ) : <span className="text-xs text-neutral-500">from height</span>}
                </div>
                {fixed
                  ? <p className="text-xs text-neutral-400">{`Kept at ${current.toFixed(v === 'foot_angle' ? 0 : 2)} ${varUnit(v)}`}</p>
                  : <RangeRow label={`${varLabel[v]} range`} min={search[`${v}_min` as const]} max={search[`${v}_max` as const]} onMin={(x) => setS(`${v}_min` as const, x)} onMax={(x) => setS(`${v}_max` as const, x)} />}
              </div>
            );
          })}
          <p className="text-[10px] leading-snug text-neutral-400">A fixed dimension keeps its value on screen; the others are searched between their two ends.</p>
        </div>
      </Accordion>

      <Accordion title="Limits">
        <div className="space-y-3 pt-2">
          <ParameterSlider label="Max over-squeeze" value={search.max_oversqueeze} min={0.05} max={2} step={0.05} onChange={(v) => setS('max_oversqueeze', v)}
            description="How far past closure the closed tube may be crushed while the other one opens over the stroke." />
          {!heightFixed && <RangeRow label="Pivot height" min={search.min_pivot_height} max={search.max_pivot_height} onMin={(v) => setS('min_pivot_height', v)} onMax={(v) => setS('max_pivot_height', v)} />}
          {onePiece && (
            <div className="space-y-2 rounded-lg border border-neutral-700 p-2">
              <StatRow label="Part stress under" value={`${params.member_strength_mpa} MPa`} />
              <StatRow label="Screw thrust under" value={data?.thrust_available != null ? `${data.thrust_available.toFixed(1)} N` : 'motor thrust'} />
              {!params.carriage_clamped && (
                <>
                  <StatRow label="Eye pressure under" value={`${params.member_strength_mpa} MPa`} />
                  <StatRow label="Rod bending under" value={`${params.carriage_pin_strength_mpa} MPa`} />
                </>
              )}
              <p className="text-[10px] leading-snug text-neutral-400">
                These apply to the one-piece part only. Strengths and the motor are set in Explorer.
              </p>
            </div>
          )}
        </div>
      </Accordion>

      <div className="space-y-3">
        <Button variant="ghost" type="button" onClick={optimize} disabled={optimizing}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-2 text-sm font-bold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
          <Target className="w-4 h-4" /> {optimizing ? 'Searching…' : 'Find dimensions'}
        </Button>
        {optimizing && (
          <p className="text-xs text-neutral-400" role="status">
            {onePiece ? 'Checking the one-piece part can take about ten seconds.' : 'Searching…'}
          </p>
        )}
        {optMessage && (
          <p className={`text-xs leading-snug ${optMessage.ok ? 'text-emerald-400' : 'text-red-400'}`} role="status">{optMessage.text}</p>
        )}
        {report?.model === 'one-piece' && typeof report.passed === 'number' && typeof report.shortlist === 'number' && report.shortlist > 0 && (
          <p className="text-xs text-neutral-300">{`${report.passed} of ${report.shortlist} shortlisted designs passed the limits.`}</p>
        )}
        {optOut?.found && onePiece && !report && (
          <p className="text-[10px] leading-snug text-amber-400">
            This search worked on the pivoted version of this linkage. Check what it found against the one-piece figures.
          </p>
        )}
        {optOut && !optOut.found && rejectedText && (
          <p className="text-xs text-neutral-400">{`Rejected for: ${rejectedText}.`}</p>
        )}
        {optOut?.found && optOut.params && res && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-neutral-400">Found dimensions</h3>
            {optOut.vars.map((v) => (
              <StatRow key={v} label={`${varLabel[v]}${optOut.fixed.includes(v) ? ' (fixed)' : ''}`}
                value={`${(optOut.params![VAR_PARAM[v]] as number).toFixed(v === 'foot_angle' ? 0 : 2)} ${varUnit(v)}`} />
            ))}
            <h3 className="text-xs font-semibold text-neutral-400 pt-1">Outputs</h3>
            <StatRow label="Flow" highlight value={res.y_full_open != null
              ? `full at ${res.y_full_open.toFixed(2)} mm${res.response_time_ms != null ? `, ${res.response_time_ms.toFixed(0)} ms` : ''}`
              : res.max_flow_l_min > 0 ? `${(100 * Math.max(0, ...res.flow_a.map((f) => f ?? 0)) / res.max_flow_l_min).toFixed(0)} % of full` : 'N/A'} />
            <StatRow label="Dead band (both ways)" value={res.y_open != null ? `${(2 * res.y_open).toFixed(2)} mm` : 'N/A'} />
            <StatRow label="Travel used" value={`${optOut.params.stroke.toFixed(2)} mm`} />
            {!fast && <StatRow label="Deviation from target" value={res.rms_error != null ? `${(res.rms_error * 100).toFixed(1)} % RMS` : 'N/A'} />}
            <StatRow label="Over-squeeze" value={`${res.max_oversqueeze.toFixed(2)} mm`} />
            {res.flexure && (
              <>
                <StatRow label="Worst stress" value={n2(res.max_stress_mpa, 'MPa', 0)} />
                <StatRow label="Worst screw thrust" value={n2(res.thrust_needed, 'N', 1)} />
                {res.carriage_bearing_mpa != null && <StatRow label="Eye pressure" value={n2(res.carriage_bearing_mpa, 'MPa', 1)} />}
                {res.carriage_pin_bending_mpa != null && <StatRow label="Rod bending" value={n2(res.carriage_pin_bending_mpa, 'MPa', 0)} />}
              </>
            )}
            <Button variant="ghost" type="button" onClick={onOpenExplorer}
              className="w-full rounded-lg border border-neutral-600 px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-amber-500/60 hover:text-amber-300">
              Open in Explorer
            </Button>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">
      {/* Panel 1: parameters */}
      <div className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-4 min-w-0">
          <Settings className="w-5 h-5 text-amber-500 shrink-0" />
          <h2 className="text-lg font-bold text-white tracking-tight truncate">{pendulum ? 'Pendulum linkage' : lever ? 'Lever linkage' : 'Bar linkage'}</h2>
        </div>

        <div className="shrink-0 mb-4">
          <Button variant="ghost" type="button" onClick={() => setOnshapeOpen(true)} disabled={!data || data.Y_positions.length === 0}
            title="Compare these dimensions with the Onshape variable table, then overwrite the variables there"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-600 px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40">
            <UploadCloud className="w-3.5 h-3.5" /> Write to Onshape variables
          </Button>
          <OnshapeVariablesModal open={onshapeOpen} onClose={() => setOnshapeOpen(false)} params={params}
            onSyncMeasured={(patch) => setParams((p) => ({ ...p, ...patch }))} />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-4">
          {mode === 'finder' ? finderMenu : explorerMenu}
        </div>
      </div>

      {/* Panel 2: schematic */}
      <div className="lg:col-span-4 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0 overflow-y-auto">
        <div className="flex items-center gap-3 mb-3 shrink-0 min-w-0">
          <h3 className="text-sm font-semibold text-neutral-300 min-w-0 flex-1 truncate">Schematic</h3>
          <Button variant="ghost" type="button" onClick={() => setDetails(!details)}
            className={`shrink-0 px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}>
            {details ? 'Hide details' : 'Details'}
          </Button>
        </div>
        <div className="order-2 flex-1 min-h-[180px] w-full bg-neutral-900/60 rounded-lg border border-neutral-800/80 overflow-hidden">
          {data && data.Y_positions.length > 0
            ? <LinkageDiagram params={params} data={data} y={yPose} details={details} />
            : <div className="flex h-full items-center justify-center p-4 text-center text-sm text-neutral-400">{data ? data.message : 'Loading…'}</div>}
        </div>
        <div className="order-1 shrink-0 mb-3 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <label htmlFor={`linkage-y-${kind}`} className="font-medium text-neutral-300">Carriage Y</label>
            <span className="font-mono text-neutral-100">{yPose.toFixed(2)} mm</span>
          </div>
          <div className="order-last flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" type="button" onClick={togglePlay} disabled={speed <= 0} aria-pressed={playing}
              title="Run the carriage back and forth over the full stroke at the loaded motor speed"
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold disabled:opacity-50 ${playing ? 'border-amber-500 bg-amber-600 text-white' : 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'}`}>
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} {playing ? 'Stop' : 'Oscillate'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => { setPlaying(false); setCycleT(null); setY(0); }} disabled={!playing && yPose === 0}
              title="Bring the carriage back to Y = 0"
              className="rounded-lg border border-neutral-700 px-3 py-1 text-xs font-bold text-neutral-200 hover:bg-neutral-700/40 disabled:opacity-50">
              Center
            </Button>
            <FlowParticlesSwitch note="Full density and speed at the flow through the full bore. The chamber is not drawn: it is taken as below the drawing, so the air runs down tube A (supply) and up tube B (exhaust)." />
            <span className="text-xs text-neutral-400 text-right">
              {loadedRpm.toFixed(0)} RPM under load ({params.motor_speed} × {Math.round(params.speed_factor * 100)} %), {speed.toFixed(2)} mm/s
            </span>
          </div>
          <input id={`linkage-y-${kind}`} type="range" min={-params.stroke} max={params.stroke} step={0.01} value={yPose}
            onChange={(e) => { setPlaying(false); setCycleT(null); setY(parseFloat(e.target.value)); }} className="w-full accent-amber-500 cursor-pointer" />
        </div>
        {data && !data.feasible && data.Y_positions.length > 0 && (
          <p className="order-3 shrink-0 mt-2 rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">{data.message}</p>
        )}
        {error && <p className="order-3 shrink-0 mt-2 text-xs text-red-400" role="alert">{error}</p>}
      </div>

      {/* Panel 3: charts */}
      <div className="lg:col-span-5 min-w-0 grid auto-rows-[minmax(210px,1fr)] gap-4 min-h-0 overflow-y-auto pr-1">
        <ChartCard title="Static flow vs carriage Y" {...cardProps('flow')}>
          {({ settings: c }) => (<FitChart>
          <LineChart data={chartData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            {xAxisY(c)}
            <YAxis type="number" stroke="#888" domain={chartDomain(c, 'y')} allowDataOverflow={!c.autoY} tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} L/min`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
            <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
            <Line type="linear" dataKey="target" name="Target" stroke="#9ca3af" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="flowA" name="Tube A (supply)" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="flowB" name="Tube B (exhaust)" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
            <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
          </LineChart>
          </FitChart>)}
        </ChartCard>
        <ChartCard title="Pinch gap vs carriage Y" {...cardProps('gap')}>
          {({ settings: c }) => (<FitChart>
          <LineChart data={chartData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            {xAxisY(c)}
            <YAxis type="number" stroke="#888" domain={chartDomain(c, 'y', ['auto', 'auto'])} allowDataOverflow={!c.autoY} tickFormatter={(v) => Number(v).toFixed(1)}
              label={{ value: 'Pin to wall (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} mm`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
            {data && <ReferenceLine y={data.closed_gap} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'closed', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />}
            {data && <ReferenceLine y={data.full_open_gap} stroke="#10b981" strokeDasharray="3 3" label={{ value: 'full bore', fill: '#10b981', fontSize: 11, position: 'insideTopRight' }} />}
            <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
            {data?.contact_solved && <Line type="linear" dataKey="rigidA" name="Tube A, rigid bars" stroke={ORANGE} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />}
            <Line type="linear" dataKey="gapA" name="Tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="gapB" name="Tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
            <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
          </LineChart>
          </FitChart>)}
        </ChartCard>
        <TubeSectionCard tube={params} h={data && data.Y_positions.length > 0 ? interpAt(yPose, data.Y_positions, data.gap_loaded_a) : null}
          where={`tube A at Y = ${yPose.toFixed(2)} mm`} {...cardProps('section')} />
        {forces && (
          <ChartCard title="Pin force and screw thrust vs carriage Y" {...cardProps('force')}>
            {({ settings: c }) => (<FitChart>
            <LineChart data={chartData} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              {xAxisY(c)}
              <YAxis type="number" stroke="#888" scale="log" domain={c.autoY ? [0.1, 'auto'] : [Math.max(c.yMin, 1e-3), c.yMax]} allowDataOverflow tickFormatter={(v) => String(Number(v))}
                label={{ value: 'Force (N)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(2)} N`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
              <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Line type="linear" dataKey="forceA" name="Pin on tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="forceB" name="Pin on tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="thrust" name="Screw thrust needed" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
              {data!.thrust_available != null && <ReferenceLine y={data!.thrust_available} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'motor limit', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />}
              <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
            </LineChart>
            </FitChart>)}
          </ChartCard>
        )}
        {data?.flexure && data.max_stress_mpa != null && (
          <ChartCard title="Worst stress in the one-piece part vs carriage Y" {...cardProps('stress')}>
            {({ settings: c }) => (<FitChart>
            <LineChart data={chartData} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              {xAxisY(c)}
              <YAxis type="number" stroke="#888" domain={chartDomain(c, 'y')} allowDataOverflow={!c.autoY} tickFormatter={(v) => Number(v).toFixed(0)}
                label={{ value: 'Stress (MPa)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(1)} MPa`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
              <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={params.member_strength_mpa} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'strength', fill: '#ef4444', fontSize: 11, position: 'insideTopRight' }} />
              <Line type="linear" dataKey="stressA" name="Part on tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="stressB" name="Part on tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
              <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
            </LineChart>
            </FitChart>)}
          </ChartCard>
        )}
        {forces && (
          <ChartCard title="Pin pushed back by bar flex vs carriage Y" {...cardProps('flex')}>
            {({ settings: c }) => (<FitChart>
            <LineChart data={chartData} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              {xAxisY(c)}
              <YAxis type="number" stroke="#888" domain={chartDomain(c, 'y')} allowDataOverflow={!c.autoY} tickFormatter={(v) => Number(v).toFixed(3)}
                label={{ value: 'Flex (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 0 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(4)} mm`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
              <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={params.preload} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'preload', fill: '#ef4444', fontSize: 11, position: 'insideTopRight' }} />
              <Line type="linear" dataKey="flexA" name="Tube A pin" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexB" name="Tube B pin" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexBend" name="A: from bending" stroke="#f472b6" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexLink" name="A: from the link" stroke="#a3e635" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
            </LineChart>
            </FitChart>)}
          </ChartCard>
        )}
        <ChartCard title={`Chamber (${params.chamber_volume_ml} mL): air in vs out over one cycle`} {...cardProps('chamber')}>
          {({ settings: c }) => (<FitChart>
          <LineChart data={cycleData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="t" type="number" domain={chartDomain(c, 'x', ['dataMin', 'dataMax'])} allowDataOverflow={!c.autoX} stroke="#888"
              label={{ value: 'Time (s): Y goes 0, +stroke, 0, -stroke, 0', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(v) => Number(v).toFixed(1)} />
            <YAxis yAxisId="q" type="number" stroke="#888" domain={chartDomain(c, 'y')} allowDataOverflow={!c.autoY} tickFormatter={(v) => Number(v).toFixed(1)}
              label={{ value: 'Free air (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
            <YAxis yAxisId="p" orientation="right" type="number" stroke="#a78bfa" tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: 'Chamber (kPa g)', angle: 90, position: 'insideRight', fill: '#a78bfa', offset: 10 }} />
            <Tooltip contentStyle={tooltipStyle}
              formatter={(v, name) => (name === 'Chamber pressure' ? `${Number(v).toFixed(1)} kPa` : `${Number(v).toFixed(3)} L/min`)}
              labelFormatter={(l) => `t: ${Number(l).toFixed(2)} s`} />
            <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
            <Line yAxisId="q" type="linear" dataKey="flowIn" name="Air in (tube A)" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line yAxisId="q" type="linear" dataKey="flowOut" name="Air out (tube B)" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line yAxisId="p" type="linear" dataKey="kpa" name="Chamber pressure" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
            {cycleT != null && <ReferenceLine yAxisId="q" x={cycleT} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />}
          </LineChart>
          </FitChart>)}
        </ChartCard>
      </div>
    </div>
  );
}
