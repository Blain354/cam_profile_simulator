import { Button, Input } from '@blain-projects/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { Pause, Play, Save, Settings, Target, Trash2 } from 'lucide-react';
import { Accordion, ParameterSlider, StatRow, apiFetch } from './components';

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
  input_pressure_psi: number;
  compliance: number;
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
}

interface LinkageSearch {
  bar1_min: number;
  bar1_max: number;
  bar2_min: number;
  bar2_max: number;
  lever_min: number;
  lever_max: number;
  anchor_min: number;
  anchor_max: number;
  min_pivot_height: number;
  max_pivot_height: number;
  max_oversqueeze: number;
  objective: 'response' | 'target';
  max_stroke: number;
}

type Series = (number | null)[];

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
  seal_force: number | null;
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
  max_bending_stress_mpa: number | null;
  max_axial_stress_mpa: number | null;
  buckling_factor: number | null;
  pin_stiffness: number | null;
  flex_y0: number | null;
  seal_pressure_y0_psi: number | null;
  sealed_after_flex: boolean | null;
}

export type LinkageShared = Pick<LinkageParams, 'tube_id' | 'tube_od' | 'input_pressure_psi' | 'compliance' | 'motor_speed' | 'lead_screw_pitch'>;

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
  input_pressure_psi: 15.0,
  compliance: 0.7,
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
};

// All sets were measured on the concept sketches (about 30 px/mm).
const DEFAULT_PARAMS: Record<LinkageKind, LinkageParams> = {
  elbow: { ...COMMON, linkage_type: 'elbow', bar1_length: 13.0, bar2_length: 7.8, lever_length: 16.5, anchor_distance: 2.33, pivot_offset: 3.9, pin_diameter: 1.0 },
  lever: { ...COMMON, linkage_type: 'lever', bar1_length: 6.9, bar2_length: 6.9, lever_length: 16.5, anchor_distance: 5.05, pivot_offset: 3.97, pin_diameter: 0.4 },
  pendulum: { ...COMMON, linkage_type: 'pendulum', bar1_length: 11.95, bar2_length: 14.43, anchor_distance: 4.79, pivot_offset: 4.0, pin_diameter: 1.0, pad_length: 1.0 },
};

const SEARCH_COMMON = { lever_min: 10, lever_max: 22, min_pivot_height: 3, max_pivot_height: 16, max_oversqueeze: 0.5, objective: 'response' as const, max_stroke: 3 };
const DEFAULT_SEARCH: Record<LinkageKind, LinkageSearch> = {
  elbow: { ...SEARCH_COMMON, bar1_min: 6, bar1_max: 20, bar2_min: 3, bar2_max: 14, anchor_min: 0, anchor_max: 6, max_stroke: 5 },
  lever: { ...SEARCH_COMMON, bar1_min: 3, bar1_max: 12, bar2_min: 3, bar2_max: 12, anchor_min: 2, anchor_max: 8 },
  pendulum: { ...SEARCH_COMMON, bar1_min: 6, bar1_max: 16, bar2_min: 8, bar2_max: 18, anchor_min: 0, anchor_max: 8 },
};

const storageKey = (kind: LinkageKind) => `cam-sim.linkage.${kind}.v2`;

function loadStored(kind: LinkageKind, shared: LinkageShared): { params: LinkageParams; search: LinkageSearch; profile: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(kind)) ?? 'null');
    if (raw && typeof raw === 'object') {
      return {
        params: { ...DEFAULT_PARAMS[kind], ...raw.params, linkage_type: kind },
        search: { ...DEFAULT_SEARCH[kind], ...raw.search },
        profile: typeof raw.profile === 'string' ? raw.profile : null,
      };
    }
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { params: { ...DEFAULT_PARAMS[kind], ...shared }, search: DEFAULT_SEARCH[kind], profile: null };
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

interface Pose { anchor: [number, number]; pivotX: number; joint: [number, number] | null; tip: [number, number] | null }

function LinkageDiagram({ params, data, y, details }: { params: LinkageParams; data: LinkageResult; y: number; details: boolean }) {
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
  const poseA: Pose = { anchor: [data.anchor_x, onTop ? top : 0], pivotX: params.pivot_offset, joint: at(y, data.joint_x, data.joint_y), tip: at(y, data.tip_x, data.tip_y) };
  const poseB: Pose = { anchor: [-data.anchor_x, onTop ? 0 : top], pivotX: -params.pivot_offset, joint: flip(at(-y, data.joint_x, data.joint_y)), tip: flip(at(-y, data.tip_x, data.tip_y)) };

  const gapA = interpAt(y, data.Y_positions, data.gap_a);
  const gapB = interpAt(y, data.Y_positions, data.gap_b);
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

  const tube = (sign: 1 | -1, flow: number, name: string) => {
    const cx = sign * params.tube_center_x;
    const frac = data.max_flow_l_min > 0 ? Math.min(flow / data.max_flow_l_min, 1) : 0;
    return (
      <g>
        <rect x={cx - params.tube_od / 2} y={-top - 1} width={params.tube_od} height={top + 2}
          fill={frac > 0 ? '#10b981' : '#ef4444'} fillOpacity={0.1 + 0.3 * frac} />
        {[-params.tube_od / 2, 0, params.tube_od / 2].map((dx) => (
          <line key={dx} x1={cx + dx} y1={-top - 1} x2={cx + dx} y2={1} stroke="var(--bui-text)" strokeWidth={0.05} strokeDasharray="0.5 0.12 0.1 0.12" />
        ))}
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
    // Contact pad: a segment centred on the pinch point, square to the foot.
    let pad: number[] | null = null;
    if (pendulum && params.pad_length > 0 && pose.joint && pose.tip) {
      const dx = pose.tip[0] - pose.joint[0], dy = pose.tip[1] - pose.joint[1];
      const n = Math.hypot(dx, dy);
      if (n > 1e-6) {
        const k = params.pad_length / 2 / n;
        pad = [pose.tip[0] - dy * k, pose.tip[1] + dx * k, pose.tip[0] + dy * k, pose.tip[1] - dx * k];
      }
    }
    return (
      <g>
        {/* Ground mark at the fixed anchor */}
        <line x1={axx - 0.6} y1={-ayy} x2={axx + 0.6} y2={-ayy} stroke="var(--bui-text)" strokeWidth={0.14} />
        {pose.joint && pose.tip && (
          <>
            {pendulum ? (
              <>
                <line x1={axx} y1={-ayy} x2={pose.joint[0]} y2={-pose.joint[1]} stroke={color} strokeWidth={0.22} strokeLinecap="round" />
                <line x1={pose.joint[0]} y1={-pose.joint[1]} x2={pose.tip[0]} y2={-pose.tip[1]} stroke={color} strokeWidth={0.5} strokeLinecap="round" />
              </>
            ) : (
              <line x1={axx} y1={-ayy} x2={pose.tip[0]} y2={-pose.tip[1]} stroke={color} strokeWidth={0.22} strokeLinecap="round" />
            )}
            <line x1={pose.pivotX} y1={-hB} x2={pose.joint[0]} y2={-pose.joint[1]} stroke={color} strokeWidth={0.22} strokeLinecap="round" />
            {(lever || pendulum) && <circle cx={pose.joint[0]} cy={-pose.joint[1]} r={0.2} fill={color} />}
            {pad
              ? <line x1={pad[0]} y1={-pad[1]} x2={pad[2]} y2={-pad[3]} stroke={color} strokeWidth={2 * rPin} strokeLinecap="round" />
              : <circle cx={pose.tip[0]} cy={-pose.tip[1]} r={rPin} fill="var(--bui-surface)" stroke={color} strokeWidth={0.1} />}
          </>
        )}
        <circle cx={axx} cy={-ayy} r={0.22} fill={color} />
        <circle cx={pose.pivotX} cy={-hB} r={0.42} fill={BLUE} />
      </g>
    );
  };

  const a = poseA;
  return (
    <svg viewBox={`${-(wall + margin)} ${-top - margin} ${2 * (wall + margin)} ${top + 2 * margin}`} preserveAspectRatio="xMidYMid meet"
      className="w-full h-full select-none" role="img" aria-label="Linkage schematic">
      {/* Fixed base: floor, ceiling and the two walls the tubes rest on */}
      <rect x={-wall} y={-top} width={2 * wall} height={top} fill="var(--bui-muted)" fillOpacity={0.08} stroke="var(--bui-text)" strokeWidth={0.14} />
      {tube(-1, flowA, 'A  supply')}
      {tube(1, flowB, 'B  exhaust')}

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

function ChartCard({ title, children }: { title: string; children: ReactElement }) {
  return (
    <div className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 flex flex-col min-h-0">
      <h3 className="text-sm font-bold text-neutral-200 text-center mb-1 shrink-0">{title}</h3>
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={170}>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────

export default function LinkageExplorer({ kind, shared }: { kind: LinkageKind; shared: LinkageShared }) {
  const lever = kind === 'lever';
  const pendulum = kind === 'pendulum';
  const [stored] = useState(() => loadStored(kind, shared));
  const [params, setParams] = useState<LinkageParams>(stored.params);
  const [search, setSearch] = useState<LinkageSearch>(stored.search);
  const [data, setData] = useState<LinkageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [y, setY] = useState(0);
  const [details, setDetails] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [optMessage, setOptMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [profiles, setProfiles] = useState<{ name: string }[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | null>(stored.profile);
  const [profileName, setProfileName] = useState(stored.profile ?? '');
  /** What the active profile holds on the server, to flag unsaved changes. Unknown after a page reload. */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Time into the cycle 0, +stroke, 0, -stroke, 0 while oscillating (s). */
  const [cycleT, setCycleT] = useState<number | null>(null);
  /** Distance run in the current cycle (mm), plus the live speed and stroke for the animation loop. */
  const motion = useRef({ d: 0, speed: 0, stroke: 1 });

  const set = <K extends keyof LinkageParams>(key: K, value: LinkageParams[K]) => setParams((p) => ({ ...p, [key]: value }));
  const setS = (key: Exclude<keyof LinkageSearch, 'objective'>, value: number) => setSearch((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    try { localStorage.setItem(storageKey(kind), JSON.stringify({ params, search, profile: activeProfile })); } catch { /* ignore */ }
  }, [kind, params, search, activeProfile]);

  const refreshProfiles = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/linkage/profiles?kind=${kind}`);
      if (res.ok) setProfiles((await res.json()).profiles ?? []);
    } catch { /* the list stays as it was */ }
  }, [kind]);
  useEffect(() => { refreshProfiles(); }, [refreshProfiles]);

  const profileUrl = (name: string) => `/api/linkage/profiles/${kind}/${encodeURIComponent(name)}`;
  const snapshot = JSON.stringify({ params, search });
  const profileDirty = activeProfile != null && savedSnapshot != null && savedSnapshot !== snapshot;

  const loadProfile = async (name: string) => {
    setProfileMessage(null);
    try {
      const res = await apiFetch(profileUrl(name));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const p: LinkageParams = { ...DEFAULT_PARAMS[kind], ...raw.params, linkage_type: kind };
      const s: LinkageSearch = { ...DEFAULT_SEARCH[kind], ...raw.search };
      setPlaying(false);
      setParams(p);
      setSearch(s);
      setActiveProfile(name);
      setProfileName(name);
      setSavedSnapshot(JSON.stringify({ params: p, search: s }));
    } catch {
      setProfileMessage({ ok: false, text: `Could not load "${name}".` });
      refreshProfiles();
    }
  };

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) { setProfileMessage({ ok: false, text: 'Give the profile a name first.' }); return; }
    if (name.includes('/')) { setProfileMessage({ ok: false, text: 'A profile name cannot contain a slash.' }); return; }
    if (name !== activeProfile && profiles.some((p) => p.name === name) && !confirm(`Overwrite the saved profile "${name}"?`)) return;
    try {
      const res = await apiFetch(profileUrl(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      setActiveProfile(out.name);
      setProfileName(out.name);
      setSavedSnapshot(snapshot);
      setProfileMessage({ ok: true, text: out.status === 'updated' ? `"${out.name}" updated.` : `"${out.name}" saved.` });
      refreshProfiles();
    } catch {
      setProfileMessage({ ok: false, text: 'Save failed.' });
    }
  };

  const deleteProfile = async () => {
    if (!activeProfile || !confirm(`Delete the saved profile "${activeProfile}"? The current values stay on screen.`)) return;
    try {
      const res = await apiFetch(profileUrl(activeProfile), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setProfileMessage({ ok: true, text: `"${activeProfile}" deleted.` });
      setActiveProfile(null);
      setSavedSnapshot(null);
      refreshProfiles();
    } catch {
      setProfileMessage({ ok: false, text: 'Delete failed.' });
    }
  };

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

  const optimize = async () => {
    setOptimizing(true);
    setOptMessage(null);
    try {
      const res = await apiFetch('/api/linkage/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, ...search }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      if (!out.found) {
        setOptMessage({ ok: false, text: `No feasible geometry among ${out.tested} combinations. Widen the ranges, ${heightFixed ? 'change the total height' : 'raise the pivot height limit'}${fast ? ', allow more travel' : ''} or allow more over-squeeze.` });
        return;
      }
      const p: LinkageParams = out.params;
      setParams(p);
      const found = pendulum
        ? `L ${p.bar2_length.toFixed(2)}, r ${p.bar1_length.toFixed(2)}, a ${p.anchor_distance.toFixed(2)}`
        : lever
        ? `L ${p.lever_length.toFixed(2)}, c ${p.bar2_length.toFixed(2)}, r ${p.bar1_length.toFixed(2)}, a ${p.anchor_distance.toFixed(2)}`
        : `L1 ${p.bar1_length.toFixed(2)}, L2 ${p.bar2_length.toFixed(2)}, a ${p.anchor_distance.toFixed(2)}`;
      setOptMessage({
        ok: true,
        text: fast
          ? `Applied ${found} mm: full flow in ${out.result.y_full_open.toFixed(2)} mm of travel (${out.result.response_time_ms != null ? `${out.result.response_time_ms.toFixed(0)} ms` : 'motor stopped'}), dead band ${(2 * (out.result.y_open ?? 0)).toFixed(2)} mm, ${out.result.max_oversqueeze.toFixed(2)} mm over-squeeze. Stroke set to ${p.stroke.toFixed(2)} mm (${out.feasible} of ${out.tested} coarse combinations feasible).`
          : `Applied ${found} mm: ${(out.result.rms_error * 100).toFixed(1)} % RMS from target, ${out.result.max_oversqueeze.toFixed(2)} mm over-squeeze (${out.feasible} of ${out.tested} coarse combinations feasible).`,
      });
    } catch {
      setOptMessage({ ok: false, text: 'Optimizer request failed.' });
    } finally {
      setOptimizing(false);
    }
  };

  const chartData = useMemo(() => (data?.Y_positions ?? []).map((yy, i) => ({
    y: yy, flowA: data!.flow_a[i], flowB: data!.flow_b[i], target: data!.flow_target[i], gapA: data!.gap_a[i], gapB: data!.gap_b[i],
    forceA: data!.force_a[i] ?? null, forceB: data!.force_b[i] ?? null, thrust: data!.thrust[i] ?? null,
    flexA: data!.flex_a[i] ?? null, flexB: data!.flex_b[i] ?? null, flexLink: data!.flex_link_a[i] ?? null, flexBend: data!.flex_bend_a[i] ?? null,
  })), [data]);
  const forces = data != null && data.seal_force != null;
  const n2 = (v: number | null | undefined, unit: string, digits = 2) => (v == null ? 'N/A' : `${v.toFixed(digits)} ${unit}`);
  const cycleData = useMemo(() => (data?.time_ms ?? []).map((t, i) => ({
    t: t / 1000, flowIn: data!.flow_in_l_min[i], flowOut: data!.flow_out_l_min[i], kpa: data!.chamber_kpa[i], y: data!.y_time[i],
  })), [data]);

  const tooltipStyle = { backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' };
  const margin = { top: 6, right: 16, bottom: 18, left: 16 };
  const xAxisY = (
    <XAxis dataKey="y" type="number" domain={['dataMin', 'dataMax']} stroke="#888"
      label={{ value: 'Carriage Y (mm)', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(v) => Number(v).toFixed(1)} />
  );

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">
      {/* Panel 1: parameters */}
      <div className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-4 min-w-0">
          <Settings className="w-5 h-5 text-amber-500 shrink-0" />
          <h2 className="text-lg font-bold text-white tracking-tight truncate">{pendulum ? 'Pendulum linkage' : lever ? 'Lever linkage' : 'Bar linkage'}</h2>
        </div>

        {/* Saved profiles: parameters and optimizer ranges, one list per linkage type */}
        <div className="shrink-0 mb-4 space-y-2 rounded-lg border border-neutral-700 p-2">
          <div className="flex items-center gap-2">
            <label htmlFor={`linkage-profile-${kind}`} className="shrink-0 text-xs font-semibold text-neutral-400">Profile</label>
            <select id={`linkage-profile-${kind}`} value={activeProfile ?? ''} onChange={(e) => { if (e.target.value) loadProfile(e.target.value); }}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100">
              <option value="">{profiles.length ? 'Load a saved profile…' : 'No saved profile yet'}</option>
              {activeProfile && !profiles.some((p) => p.name === activeProfile) && <option value={activeProfile}>{activeProfile}</option>}
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <Button variant="ghost" type="button" onClick={deleteProfile} disabled={!activeProfile} title="Delete the loaded profile" aria-label="Delete the loaded profile"
              className="shrink-0 rounded-lg border border-neutral-700 p-1.5 text-neutral-400 hover:text-red-400 disabled:opacity-40">
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input type="text" value={profileName} maxLength={60} placeholder="Profile name" aria-label="Profile name"
              onChange={(e) => setProfileName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveProfile(); }}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100" />
            <Button variant="ghost" type="button" onClick={saveProfile}
              className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold ${profileDirty ? 'border-amber-400 bg-amber-500 text-neutral-900' : 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'}`}>
              <Save className="w-3.5 h-3.5" /> {activeProfile && profileName.trim() === activeProfile ? 'Update' : 'Save'}
            </Button>
          </div>
          {(profileMessage || profileDirty) && (
            <p className={`text-xs leading-snug ${profileMessage && !profileMessage.ok ? 'text-red-400' : profileDirty ? 'text-amber-400' : 'text-emerald-400'}`} role="status">
              {profileDirty ? `Unsaved changes to "${activeProfile}".` : profileMessage?.text}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-4">
          <Accordion title="Bars (design variables)">
            <div className="space-y-5 pt-2">
              {pendulum ? (
                <>
                  <div className="space-y-1.5">
                    <Button variant="ghost" type="button" role="switch" aria-checked={heightFixed}
                      onClick={() => setParams((p) => (heightFixed
                        ? { ...p, fixed_height: 0, bar1_length: data ? Math.round(data.link_length * 1000) / 1000 : p.bar1_length }
                        : { ...p, fixed_height: data ? Math.round(data.pivot_height_y0 * 200) / 100 : 20 }))}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${heightFixed ? 'border-amber-500/50 text-amber-300' : 'border-neutral-700 text-neutral-300'}`}
                      title="Impose the height between the two anchors. The link length is then computed so that the tube is still just closed at Y = 0.">
                      <span>Fix total height (2·h₀)</span>
                      <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${heightFixed ? 'bg-amber-600' : 'bg-neutral-600'}`}>
                        <span className={`h-4 w-4 rounded-full bg-white transition-transform ${heightFixed ? 'translate-x-4' : ''}`} />
                      </span>
                    </Button>
                  </div>
                  {heightFixed && (
                    <ParameterSlider label="Total height (mm)" value={params.fixed_height} min={4} max={40} step={0.05} onChange={(v) => set('fixed_height', v)}
                      secondaryValue={`h₀ ${(params.fixed_height / 2).toFixed(2)}`}
                      description="Distance between the top anchor of tube A's arm and the bottom anchor of tube B's arm. The carriage pivot sits halfway at Y = 0." />
                  )}
                  <ParameterSlider label="Arm, L (mm)" value={params.bar2_length} min={2} max={30} step={0.05} onChange={(v) => set('bar2_length', v)}
                    description="Fixed anchor on the opposite wall to the joint where the link pulls. The arm hangs along the tube." />
                  <ParameterSlider label="Link, r (mm)" value={heightFixed && data ? Math.round(data.link_length * 1000) / 1000 : params.bar1_length}
                    min={2} max={30} step={0.05} onChange={(v) => set('bar1_length', v)} disabled={heightFixed}
                    secondaryValue={heightFixed ? 'from height' : undefined}
                    description="Carriage pivot (blue) to the joint at the end of the arm. Computed when the total height is fixed." />
                  <ParameterSlider label="Foot, f (mm)" value={params.foot_length} min={0} max={8} step={0.05} onChange={(v) => set('foot_length', v)}
                    description="Rigid foot from the joint to the centre of the pin that presses on the tube. Not searched by the optimizer." />
                  <ParameterSlider label="Foot angle (deg)" value={params.foot_angle_deg} min={0} max={180} step={1} onChange={(v) => set('foot_angle_deg', v)}
                    description="Angle between the arm and the foot: 90 is square to the arm, toward the tube. Not searched by the optimizer." />
                  <ParameterSlider label="Contact pad (mm)" value={params.pad_length} min={0} max={6} step={0.05} onChange={(v) => set('pad_length', v)}
                    secondaryValue={params.pad_length === 0 ? 'point' : undefined}
                    description="Length of the flat segment that touches the tube, centred on the end of the foot and square to it. Its ends are rounded with the pinch pin diameter. As the arm tilts, the end nearer the wall does the pinching. 0 is a round pin." />
                </>
              ) : lever ? (
                <>
                  <ParameterSlider label="Lever, L (mm)" value={params.lever_length} min={4} max={30} step={0.05} onChange={(v) => set('lever_length', v)}
                    description="Fixed anchor to the tip that pinches the tube. The lever reaches across the screw." />
                  <ParameterSlider label="Attach point, c (mm)" value={params.bar2_length} min={1} max={25} step={0.05} onChange={(v) => set('bar2_length', v)}
                    description="Distance along the lever from the anchor to the joint where the link pulls. L / c is the lever's amplification." />
                  <ParameterSlider label="Link, r (mm)" value={params.bar1_length} min={1} max={25} step={0.05} onChange={(v) => set('bar1_length', v)}
                    description="Carriage pivot (blue) to the joint on the lever." />
                </>
              ) : (
                <>
                  <ParameterSlider label="Bar 1, L1 (mm)" value={params.bar1_length} min={2} max={30} step={0.05} onChange={(v) => set('bar1_length', v)}
                    description="Carriage pivot (blue) to the elbow that pinches the tube." />
                  <ParameterSlider label="Bar 2, L2 (mm)" value={params.bar2_length} min={1} max={20} step={0.05} onChange={(v) => set('bar2_length', v)}
                    description="Elbow to the fixed anchor on the base." />
                </>
              )}
              <ParameterSlider label="Anchor dist, a (mm)" value={params.anchor_distance} min={-5} max={10} step={0.01} onChange={(v) => set('anchor_distance', v)}
                description={pendulum
                  ? 'Fixed anchor offset from the centre of the base, toward its tube, on the wall opposite the carriage side it starts from.'
                  : lever
                  ? 'Fixed anchor offset from the centre of the base, on the side opposite its tube.'
                  : 'Fixed anchor offset from the centre of the base, toward the tube. Negative puts it on the far side of the screw.'} />
            </div>
          </Accordion>

          <Accordion title="Optimizer" defaultOpen={false}>
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <span className="text-sm font-medium text-neutral-300">Goal</span>
                <div className="flex gap-1 rounded-lg border border-neutral-700 p-1">
                  {(['response', 'target'] as const).map((goal) => (
                    <Button key={goal} variant="ghost" type="button" aria-pressed={search.objective === goal}
                      onClick={() => setSearch((s) => ({ ...s, objective: goal }))}
                      className={`flex-1 rounded-md px-2 py-1 text-xs font-bold ${search.objective === goal ? 'bg-amber-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}>
                      {goal === 'response' ? 'Fastest response' : 'Follow target'}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] leading-snug text-neutral-400">
                  {fast
                    ? 'Most sideways pinch travel per mm of carriage: shortest travel to full flow and narrowest dead band, within the over-squeeze limit. The stroke is then set to the travel needed.'
                    : 'Opening as close as possible to the target curve over the stroke.'}
                </p>
              </div>
              {fast && (
                <ParameterSlider label="Max travel (mm)" value={search.max_stroke} min={0.5} max={10} step={0.1} onChange={(v) => setS('max_stroke', v)}
                  description="Longest carriage travel each way the search may use to reach full flow." />
              )}
              {!fast && <ParameterSlider label="Target exponent" value={params.target_exponent} min={0.3} max={3} step={0.05} onChange={(v) => set('target_exponent', v)}
                secondaryValue={params.target_exponent === 1 ? 'linear' : undefined}
                description="Target opening = (Y / stroke)^exponent, closed at Y = 0 and full bore at the end of the stroke. 1 is strictly proportional; above 1 is finer near closure." />}
              {lever && <RangeRow label="L range" min={search.lever_min} max={search.lever_max} onMin={(v) => setS('lever_min', v)} onMax={(v) => setS('lever_max', v)} />}
              <RangeRow label={pendulum ? 'L range' : lever ? 'c range' : 'L2 range'} min={search.bar2_min} max={search.bar2_max} onMin={(v) => setS('bar2_min', v)} onMax={(v) => setS('bar2_max', v)} />
              <RangeRow label={lever || pendulum ? 'r range' : 'L1 range'} min={search.bar1_min} max={search.bar1_max} onMin={(v) => setS('bar1_min', v)} onMax={(v) => setS('bar1_max', v)} />
              <RangeRow label="a range" min={search.anchor_min} max={search.anchor_max} onMin={(v) => setS('anchor_min', v)} onMax={(v) => setS('anchor_max', v)} />
              {!heightFixed && <RangeRow label="Pivot height" min={search.min_pivot_height} max={search.max_pivot_height} onMin={(v) => setS('min_pivot_height', v)} onMax={(v) => setS('max_pivot_height', v)} />}
              <ParameterSlider label="Max over-squeeze" value={search.max_oversqueeze} min={0.05} max={2} step={0.05} onChange={(v) => setS('max_oversqueeze', v)}
                description="How far past closure the closed tube may be crushed while the other one opens over the stroke." />
              <Button variant="ghost" type="button" onClick={optimize} disabled={optimizing}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-2 text-sm font-bold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50">
                <Target className="w-4 h-4" /> {optimizing ? 'Searching…' : 'Find optimal bars'}
              </Button>
              {optMessage && (
                <p className={`text-xs leading-snug ${optMessage.ok ? 'text-emerald-400' : 'text-red-400'}`} role="status">{optMessage.text}</p>
              )}
            </div>
          </Accordion>

          <Accordion title="Fixed layout" defaultOpen={false}>
            <div className="space-y-5 pt-2">
              <p className="text-[10px] leading-snug text-neutral-400">
                The second linkage is this one mirrored left to right and top to bottom, so the carriage opens one tube while it squeezes the other.
              </p>
              <ParameterSlider label="Stroke (mm)" value={params.stroke} min={0.5} max={10} step={0.1} onChange={(v) => set('stroke', v)}
                description="Carriage travel each way from closed (Y = 0) to the target full opening." />
              <ParameterSlider label="Pivot offset (mm)" value={params.pivot_offset} min={0} max={10} step={0.05} onChange={(v) => set('pivot_offset', v)}
                description="Carriage pivot distance from the screw axis, on the side opposite its tube." />
              <ParameterSlider label="Tube centre (mm)" value={params.tube_center_x} min={3} max={20} step={0.05} onChange={(v) => set('tube_center_x', v)}
                secondaryValue={data ? `wall ${data.wall_x.toFixed(2)}` : undefined}
                description="Tube axis distance from the screw axis. The tube rests on a wall half an OD further out." />
              <ParameterSlider label="Pinch pin Ø (mm)" value={params.pin_diameter} min={0} max={4} step={0.1} onChange={(v) => set('pin_diameter', v)}
                description="Diameter of the pin that presses on the tube." />
              <ParameterSlider label="Preload (mm)" value={params.preload} min={0} max={0.5} step={0.01} onChange={(v) => set('preload', v)}
                description="Extra squeeze past the just-closed gap at Y = 0, as a sealing margin. It is also the dead band around Y = 0." />
            </div>
          </Accordion>

          <Accordion title="Pneumatic system" defaultOpen={false}>
            <div className="space-y-5 pt-2">
              <ParameterSlider label="Chamber vol (mL)" value={params.chamber_volume_ml} min={0} max={200} step={0.5} onChange={(v) => set('chamber_volume_ml', v)}
                secondaryValue={params.chamber_volume_ml === 0 ? 'no traces' : undefined}
                description="Chamber fed by tube A and vented by tube B, for the in / out traces." />
              <ParameterSlider label="Motor speed (RPM)" value={params.motor_speed} min={10} max={1000} step={10} onChange={(v) => set('motor_speed', v)}
                secondaryValue="no load"
                description="Rated no-load speed of the motor. With the load factor it sets how fast the carriage runs the cycle 0, +stroke, 0, -stroke, 0." />
              <ParameterSlider label="Load factor (%)" value={Math.round(params.speed_factor * 100)} min={10} max={100} step={1} onChange={(v) => set('speed_factor', v / 100)}
                secondaryValue={`${loadedRpm.toFixed(0)} RPM, ${speed.toFixed(2)} mm/s`}
                description="Share of the no-load speed the motor keeps under load and friction: 85 % makes a 100 RPM motor run at 85 RPM. Used by the Oscillate button and by the chamber traces." />
              <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1} max={12} step={0.1} onChange={(v) => set('tube_id', v)} />
              <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1} max={16} step={0.1} onChange={(v) => set('tube_od', v)} />
              <ParameterSlider label="Pressure (PSI)" value={params.input_pressure_psi} min={0} max={150} step={1} onChange={(v) => set('input_pressure_psi', v)}
                secondaryValue={`${(params.input_pressure_psi * 6.89476).toFixed(1)} kPa`} />
              <ParameterSlider label="Compliance" value={params.compliance} min={0} max={5} step={0.01} onChange={(v) => set('compliance', v)} />
            </div>
          </Accordion>

          <Accordion title="Forces and structure" defaultOpen={false}>
            <div className="space-y-5 pt-2">
              <p className="text-[10px] leading-snug text-neutral-400">
                Forces are for the pressure set under Pneumatic system, taken as the maximum the seal must hold. The defaults here are assumed: set them to the real motor and bars.
              </p>
              <ParameterSlider label="Motor torque (mN·m)" value={params.motor_torque_mnm} min={1} max={300} step={1} onChange={(v) => set('motor_torque_mnm', v)}
                secondaryValue={`${(params.motor_torque_mnm / 98.0665).toFixed(2)} kg·cm`}
                description="Torque the gearmotor gives at its output shaft at the firmware's current limit (150 mA on the 100 RPM profile), not its stall torque." />
              <ParameterSlider label="Screw Ø (mm)" value={params.screw_diameter} min={1} max={12} step={0.1} onChange={(v) => set('screw_diameter', v)}
                secondaryValue={`pitch ${params.lead_screw_pitch}`}
                description="Major diameter of the lead screw: 3 for M3." />
              <ParameterSlider label="Thread friction" value={params.screw_friction} min={0.05} max={0.6} step={0.01} onChange={(v) => set('screw_friction', v)}
                description="Friction coefficient between the screw and the nut. It sets how much of the motor torque becomes thrust, and whether the screw holds its position with the motor off." />
              <ParameterSlider label="Bar modulus (MPa)" value={params.member_modulus_mpa} min={500} max={210000} step={100} onChange={(v) => set('member_modulus_mpa', v)}
                secondaryValue={`${(params.member_modulus_mpa / 1000).toFixed(1)} GPa`}
                description="Young's modulus of the bars: about 2 500 for printed PETG, 3 500 for PLA, 70 000 for aluminium." />
              <ParameterSlider label="Bar width (mm)" value={params.member_width} min={0.5} max={10} step={0.1} onChange={(v) => set('member_width', v)}
                description="Bar section in the plane of the mechanism. Bending stiffness goes with its cube." />
              <ParameterSlider label="Bar thickness (mm)" value={params.member_thickness} min={0.5} max={15} step={0.1} onChange={(v) => set('member_thickness', v)}
                description="Bar section out of the plane of the mechanism." />
            </div>
          </Accordion>

          {data && data.forces_message && (
            <p className="rounded-lg border border-neutral-700 p-2 text-xs text-neutral-400" role="status">{data.forces_message}</p>
          )}
          {data && forces && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">Forces at {params.input_pressure_psi} PSI</h3>
              <StatRow label="Force to seal at Y=0" value={`${n2(data.seal_force, 'N')} per tube`} highlight />
              <StatRow label="Fold flat / squeeze / air" value={`${data.seal_force_flatten!.toFixed(2)} / ${data.seal_force_squeeze!.toFixed(2)} / ${data.seal_force_pressure!.toFixed(2)} N`} />
              <StatRow label="Tube wall modulus" value={n2(data.tube_modulus_mpa, 'MPa')} />
              <StatRow label="Worst pin force" value={n2(data.max_pinch_force, 'N', 1)} />
              <StatRow label="Worst wall squeeze" value={<span className={data.max_wall_strain! > 0.25 ? 'text-amber-400' : undefined}>{(data.max_wall_strain! * 100).toFixed(0)} %</span>} />
              <StatRow label="Screw thrust at Y=0" value={n2(data.thrust_y0, 'N')} />
              <StatRow label="Worst screw thrust" value={n2(data.thrust_needed, 'N', 1)} />
              <StatRow label="Motor thrust available" value={n2(data.thrust_available, 'N', 1)} />
              <StatRow label="Motor margin" highlight value={data.motor_margin == null ? 'N/A'
                : <span className={data.motor_margin < 1 ? 'text-red-400' : undefined}>{`× ${data.motor_margin.toFixed(1)} (${n2(data.motor_torque_needed_mnm, 'mN·m', 1)})`}</span>} />
              {data.stall_y != null && <StatRow label="Motor stalls from" value={<span className="text-red-400">{`Y = ±${data.stall_y.toFixed(2)} mm`}</span>} />}
              <StatRow label="Screw holds with motor off" value={data.screw_self_locking == null ? 'N/A' : data.screw_self_locking ? 'yes' : 'no'} />
              <StatRow label="Pin pushed back at Y=0" value={n2(data.flex_y0, 'mm', 4)} />
              <StatRow label="Seal at Y=0 holds" highlight value={data.seal_pressure_y0_psi == null ? 'N/A'
                : <span className={data.sealed_after_flex ? undefined : 'text-red-400'}>{`${data.seal_pressure_y0_psi.toFixed(1)} PSI${data.sealed_after_flex ? '' : ', leaks'}`}</span>} />
              <StatRow label="Bar stiffness at the pin" value={n2(data.pin_stiffness, 'N/mm', 0)} />
              <StatRow label="Worst link force" value={data.max_link_force == null ? 'N/A' : `${Math.abs(data.max_link_force).toFixed(1)} N ${data.max_link_force < 0 ? 'push' : 'pull'}`} />
              <StatRow label="Worst side load on carriage" value={n2(data.max_side_load, 'N', 1)} />
              <StatRow label="Worst bending / axial stress" value={`${data.max_bending_stress_mpa!.toFixed(1)} / ${data.max_axial_stress_mpa!.toFixed(1)} MPa`} />
              {data.buckling_factor != null && (
                <StatRow label="Buckling margin" value={<span className={data.buckling_factor < 3 ? 'text-amber-400' : undefined}>{`× ${data.buckling_factor.toFixed(1)}`}</span>} />
              )}
              {data.max_wall_strain! > 0.25 && (
                <p className="text-[10px] leading-snug text-amber-400">
                  The closed tube is squeezed past 25 % of its walls within this stroke: worst-case figures there are an order of magnitude, and the real mechanism jams when the pin reaches the wall. Shorten the stroke to the travel needed for full flow.
                </p>
              )}
            </div>
          )}

          {data && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">Derived</h3>
              <StatRow label="Pivot height at Y=0" value={`${data.pivot_height_y0.toFixed(3)} mm`} highlight />
              <StatRow label="Anchor to anchor height" value={`${(2 * data.pivot_height_y0).toFixed(2)} mm`} />
              <StatRow label="Gain at Y=0" value={`${data.sensitivity_y0.toFixed(3)} mm/mm`} />
              <StatRow label="Full flow at" value={data.y_full_open != null ? `Y = ${data.y_full_open.toFixed(2)} mm` : 'not reached'} />
              <StatRow label="Time to full flow" value={data.response_time_ms != null ? `${data.response_time_ms.toFixed(0)} ms` : 'N/A'} highlight />
              <StatRow label="Dead band (both ways)" value={data.y_open != null ? `${(2 * data.y_open).toFixed(3)} mm` : 'N/A'} />
              <StatRow label="Deviation from target" value={data.rms_error != null ? `${(data.rms_error * 100).toFixed(1)} % RMS` : 'N/A'} />
              <StatRow label="Closed-tube over-squeeze" value={`${data.max_oversqueeze.toFixed(3)} mm`} />
              <StatRow label="Pinch slide on tube" value={`${data.pinch_slide.toFixed(2)} mm`} />
              <StatRow label="Max flow (static)" value={`${data.max_flow_l_min.toFixed(2)} L/min`} />
              {data.time_ms.length > 0 && (
                <StatRow label="Air in / out per cycle" value={`${data.volume_in_ml.toFixed(1)} / ${data.volume_out_ml.toFixed(1)} mL`} />
              )}
            </div>
          )}
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
        <ChartCard title="Static flow vs carriage Y">
          <LineChart data={chartData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            {xAxisY}
            <YAxis type="number" stroke="#888" tickFormatter={(v) => Number(v).toFixed(0)}
              label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} L/min`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
            <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
            <Line type="linear" dataKey="target" name="Target" stroke="#9ca3af" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="flowA" name="Tube A (supply)" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="flowB" name="Tube B (exhaust)" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
            <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
          </LineChart>
        </ChartCard>
        <ChartCard title="Pinch gap vs carriage Y">
          <LineChart data={chartData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            {xAxisY}
            <YAxis type="number" stroke="#888" domain={['auto', 'auto']} tickFormatter={(v) => Number(v).toFixed(1)}
              label={{ value: 'Pin to wall (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} mm`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
            {data && <ReferenceLine y={data.closed_gap} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'closed', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />}
            {data && <ReferenceLine y={data.full_open_gap} stroke="#10b981" strokeDasharray="3 3" label={{ value: 'full bore', fill: '#10b981', fontSize: 11, position: 'insideTopRight' }} />}
            <Line type="linear" dataKey="gapA" name="Tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="gapB" name="Tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
            <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
          </LineChart>
        </ChartCard>
        {forces && (
          <ChartCard title="Pin force and screw thrust vs carriage Y">
            <LineChart data={chartData} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              {xAxisY}
              <YAxis type="number" stroke="#888" scale="log" domain={[0.1, 'auto']} allowDataOverflow tickFormatter={(v) => String(Number(v))}
                label={{ value: 'Force (N, log)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(2)} N`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
              <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Line type="linear" dataKey="forceA" name="Pin on tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="forceB" name="Pin on tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="thrust" name="Screw thrust needed" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
              {data!.thrust_available != null && <ReferenceLine y={data!.thrust_available} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'motor limit', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />}
              <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
            </LineChart>
          </ChartCard>
        )}
        {forces && (
          <ChartCard title="Pin pushed back by bar flex vs carriage Y">
            <LineChart data={chartData} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              {xAxisY}
              <YAxis type="number" stroke="#888" tickFormatter={(v) => Number(v).toFixed(3)}
                label={{ value: 'Deflection (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 0 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(4)} mm`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
              <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={params.preload} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'preload', fill: '#ef4444', fontSize: 11, position: 'insideTopRight' }} />
              <Line type="linear" dataKey="flexA" name="Tube A pin" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexB" name="Tube B pin" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexBend" name="A: from bending" stroke="#f472b6" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="flexLink" name="A: from the link" stroke="#a3e635" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
            </LineChart>
          </ChartCard>
        )}
        <ChartCard title={`Chamber (${params.chamber_volume_ml} mL): air in vs out over one cycle`}>
          <LineChart data={cycleData} margin={margin}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} stroke="#888"
              label={{ value: 'Time (s): Y goes 0, +stroke, 0, -stroke, 0', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(v) => Number(v).toFixed(1)} />
            <YAxis yAxisId="q" type="number" stroke="#888" tickFormatter={(v) => Number(v).toFixed(1)}
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
        </ChartCard>
      </div>
    </div>
  );
}
