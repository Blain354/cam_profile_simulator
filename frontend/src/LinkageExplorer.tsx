import { Button, Input } from '@blain-projects/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { Settings, Target } from 'lucide-react';
import { Accordion, ParameterSlider, StatRow, apiFetch } from './components';

// ─── Types (mirror backend/linkage.py) ───────────────────────────

export type LinkageKind = 'elbow' | 'lever';

export interface LinkageParams {
  linkage_type: LinkageKind;
  bar1_length: number;
  bar2_length: number;
  lever_length: number;
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
  pivot_height_y0: number;
  wall_x: number;
  closed_gap: number;
  full_open_gap: number;
  y_min: number;
  y_max: number;
  y_full_open: number | null;
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
}

export type LinkageShared = Pick<LinkageParams, 'tube_id' | 'tube_od' | 'input_pressure_psi' | 'compliance' | 'motor_speed' | 'lead_screw_pitch'>;

const COMMON = {
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
};

// Both sets were measured on the concept sketches (about 30 px/mm).
const DEFAULT_PARAMS: Record<LinkageKind, LinkageParams> = {
  elbow: { ...COMMON, linkage_type: 'elbow', bar1_length: 13.0, bar2_length: 7.8, lever_length: 16.5, anchor_distance: 2.33, pivot_offset: 3.9, pin_diameter: 1.0 },
  lever: { ...COMMON, linkage_type: 'lever', bar1_length: 6.9, bar2_length: 6.9, lever_length: 16.5, anchor_distance: 5.05, pivot_offset: 3.97, pin_diameter: 0.4 },
};

const SEARCH_COMMON = { lever_min: 10, lever_max: 22, min_pivot_height: 3, max_pivot_height: 16, max_oversqueeze: 0.5 };
const DEFAULT_SEARCH: Record<LinkageKind, LinkageSearch> = {
  elbow: { ...SEARCH_COMMON, bar1_min: 6, bar1_max: 20, bar2_min: 3, bar2_max: 14, anchor_min: 0, anchor_max: 6 },
  lever: { ...SEARCH_COMMON, bar1_min: 3, bar1_max: 12, bar2_min: 3, bar2_max: 12, anchor_min: 2, anchor_max: 8 },
};

const storageKey = (kind: LinkageKind) => `cam-sim.linkage.${kind}.v2`;

function loadStored(kind: LinkageKind, shared: LinkageShared): { params: LinkageParams; search: LinkageSearch } {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(kind)) ?? 'null');
    if (raw && typeof raw === 'object') {
      return { params: { ...DEFAULT_PARAMS[kind], ...raw.params, linkage_type: kind }, search: { ...DEFAULT_SEARCH[kind], ...raw.search } };
    }
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { params: { ...DEFAULT_PARAMS[kind], ...shared }, search: DEFAULT_SEARCH[kind] };
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
  const h0 = data.pivot_height_y0;
  const wall = data.wall_x;
  const rPin = Math.max(params.pin_diameter / 2, 0.18);
  const top = 2 * h0;
  const margin = 1.7;
  const hB = h0 + y;

  const at = (yy: number, xs: Series, ys: Series): [number, number] | null => {
    const px = interpAt(yy, data.Y_positions, xs), py = interpAt(yy, data.Y_positions, ys);
    return px == null || py == null ? null : [px, py];
  };
  // Tube B's linkage is tube A's turned half a turn about the carriage pivot at Y = 0: it sits at -Y.
  const flip = (pt: [number, number] | null): [number, number] | null => (pt ? [-pt[0], top - pt[1]] : null);
  const poseA: Pose = { anchor: [data.anchor_x, 0], pivotX: params.pivot_offset, joint: at(y, data.joint_x, data.joint_y), tip: at(y, data.tip_x, data.tip_y) };
  const poseB: Pose = { anchor: [-data.anchor_x, top], pivotX: -params.pivot_offset, joint: flip(at(-y, data.joint_x, data.joint_y)), tip: flip(at(-y, data.tip_x, data.tip_y)) };

  const gapA = interpAt(y, data.Y_positions, data.gap_a);
  const gapB = interpAt(y, data.Y_positions, data.gap_b);
  const flowA = interpAt(y, data.Y_positions, data.flow_a) ?? 0;
  const flowB = interpAt(y, data.Y_positions, data.flow_b) ?? 0;

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
        {label(cx, top + 1.1, name, 'var(--bui-text)')}
      </g>
    );
  };

  const label = (x: number, yy: number, text: string, color: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={-yy} fill={color} fontSize={0.62} fontWeight="bold" textAnchor={anchor} dominantBaseline="middle"
      stroke="var(--bui-surface)" strokeWidth={0.18} paintOrder="stroke">{text}</text>
  );

  const linkage = (pose: Pose, color: string) => {
    const [axx, ayy] = pose.anchor;
    return (
      <g>
        {/* Ground mark at the fixed anchor */}
        <line x1={axx - 0.6} y1={-ayy} x2={axx + 0.6} y2={-ayy} stroke="var(--bui-text)" strokeWidth={0.14} />
        {pose.joint && pose.tip && (
          <>
            <line x1={axx} y1={-ayy} x2={pose.tip[0]} y2={-pose.tip[1]} stroke={color} strokeWidth={0.22} strokeLinecap="round" />
            <line x1={pose.pivotX} y1={-hB} x2={pose.joint[0]} y2={-pose.joint[1]} stroke={color} strokeWidth={0.22} strokeLinecap="round" />
            {lever && <circle cx={pose.joint[0]} cy={-pose.joint[1]} r={0.2} fill={color} />}
            <circle cx={pose.tip[0]} cy={-pose.tip[1]} r={rPin} fill="var(--bui-surface)" stroke={color} strokeWidth={0.1} />
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
          {lever ? (
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
          <line x1={0} y1={0.75} x2={a.anchor[0]} y2={0.75} stroke={ORANGE} strokeWidth={0.06} />
          <line x1={0} y1={0.45} x2={0} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
          <line x1={a.anchor[0]} y1={0.45} x2={a.anchor[0]} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
          {label(a.anchor[0] / 2, -1.35, `a ${params.anchor_distance.toFixed(2)}`, ORANGE)}
          {label(-wall + 0.25, h0 + 0.55, `h₀ ${h0.toFixed(2)}`, BLUE, 'start')}
          {gapA != null && label(-wall + 0.2, a.tip[1] + 1.1, `gap ${gapA.toFixed(3)}`, 'var(--bui-text)', 'start')}
          {gapB != null && poseB.tip && label(wall - 0.2, poseB.tip[1] - 1.1, `gap ${gapB.toFixed(3)}`, 'var(--bui-text)', 'end')}
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

  const set = <K extends keyof LinkageParams>(key: K, value: LinkageParams[K]) => setParams((p) => ({ ...p, [key]: value }));
  const setS = (key: keyof LinkageSearch, value: number) => setSearch((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    try { localStorage.setItem(storageKey(kind), JSON.stringify({ params, search })); } catch { /* ignore */ }
  }, [kind, params, search]);

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
        setOptMessage({ ok: false, text: `No feasible geometry among ${out.tested} combinations. Widen the ranges, raise the pivot height limit or allow more over-squeeze.` });
        return;
      }
      const p: LinkageParams = out.params;
      setParams(p);
      const found = lever
        ? `L ${p.lever_length.toFixed(2)}, c ${p.bar2_length.toFixed(2)}, r ${p.bar1_length.toFixed(2)}, a ${p.anchor_distance.toFixed(2)}`
        : `L1 ${p.bar1_length.toFixed(2)}, L2 ${p.bar2_length.toFixed(2)}, a ${p.anchor_distance.toFixed(2)}`;
      setOptMessage({
        ok: true,
        text: `Applied ${found} mm: ${(out.result.rms_error * 100).toFixed(1)} % RMS from target, ${out.result.max_oversqueeze.toFixed(2)} mm over-squeeze (${out.feasible} of ${out.tested} coarse combinations feasible).`,
      });
    } catch {
      setOptMessage({ ok: false, text: 'Optimizer request failed.' });
    } finally {
      setOptimizing(false);
    }
  };

  const chartData = useMemo(() => (data?.Y_positions ?? []).map((yy, i) => ({
    y: yy, flowA: data!.flow_a[i], flowB: data!.flow_b[i], target: data!.flow_target[i], gapA: data!.gap_a[i], gapB: data!.gap_b[i],
  })), [data]);
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
          <h2 className="text-lg font-bold text-white tracking-tight truncate">{lever ? 'Lever linkage' : 'Bar linkage'}</h2>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-4">
          <Accordion title="Bars (design variables)">
            <div className="space-y-5 pt-2">
              {lever ? (
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
                description={lever
                  ? 'Fixed anchor offset from the centre of the base, on the side opposite its tube.'
                  : 'Fixed anchor offset from the centre of the base, toward the tube. Negative puts it on the far side of the screw.'} />
            </div>
          </Accordion>

          <Accordion title="Optimizer" defaultOpen={false}>
            <div className="space-y-3 pt-2">
              <ParameterSlider label="Target exponent" value={params.target_exponent} min={0.3} max={3} step={0.05} onChange={(v) => set('target_exponent', v)}
                secondaryValue={params.target_exponent === 1 ? 'linear' : undefined}
                description="Target opening = (Y / stroke)^exponent, closed at Y = 0 and full bore at the end of the stroke. 1 is strictly proportional; above 1 is finer near closure." />
              {lever && <RangeRow label="L range" min={search.lever_min} max={search.lever_max} onMin={(v) => setS('lever_min', v)} onMax={(v) => setS('lever_max', v)} />}
              <RangeRow label={lever ? 'c range' : 'L2 range'} min={search.bar2_min} max={search.bar2_max} onMin={(v) => setS('bar2_min', v)} onMax={(v) => setS('bar2_max', v)} />
              <RangeRow label={lever ? 'r range' : 'L1 range'} min={search.bar1_min} max={search.bar1_max} onMin={(v) => setS('bar1_min', v)} onMax={(v) => setS('bar1_max', v)} />
              <RangeRow label="a range" min={search.anchor_min} max={search.anchor_max} onMin={(v) => setS('anchor_min', v)} onMax={(v) => setS('anchor_max', v)} />
              <RangeRow label="Pivot height" min={search.min_pivot_height} max={search.max_pivot_height} onMin={(v) => setS('min_pivot_height', v)} onMax={(v) => setS('max_pivot_height', v)} />
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
                secondaryValue={`${(params.motor_speed * params.lead_screw_pitch / 60).toFixed(2)} mm/s`}
                description="Sets how fast the carriage runs the cycle 0, +stroke, 0, -stroke, 0." />
              <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1} max={12} step={0.1} onChange={(v) => set('tube_id', v)} />
              <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1} max={16} step={0.1} onChange={(v) => set('tube_od', v)} />
              <ParameterSlider label="Pressure (PSI)" value={params.input_pressure_psi} min={0} max={150} step={1} onChange={(v) => set('input_pressure_psi', v)}
                secondaryValue={`${(params.input_pressure_psi * 6.89476).toFixed(1)} kPa`} />
              <ParameterSlider label="Compliance" value={params.compliance} min={0} max={5} step={0.01} onChange={(v) => set('compliance', v)} />
            </div>
          </Accordion>

          {data && (
            <div className="space-y-2 pb-1">
              <h3 className="text-xs font-semibold text-neutral-400 mb-2">Derived</h3>
              <StatRow label="Pivot height at Y=0" value={`${data.pivot_height_y0.toFixed(3)} mm`} highlight />
              <StatRow label="Anchor to anchor height" value={`${(2 * data.pivot_height_y0).toFixed(2)} mm`} />
              <StatRow label="Gain at Y=0" value={`${data.sensitivity_y0.toFixed(3)} mm/mm`} />
              <StatRow label="Full flow at" value={data.y_full_open != null ? `Y = ${data.y_full_open.toFixed(2)} mm` : 'not reached'} />
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
      <div className="lg:col-span-4 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-3 shrink-0 min-w-0">
          <h3 className="text-sm font-semibold text-neutral-300 min-w-0 flex-1 truncate">Schematic</h3>
          <Button variant="ghost" type="button" onClick={() => setDetails(!details)}
            className={`shrink-0 px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}>
            {details ? 'Hide details' : 'Details'}
          </Button>
        </div>
        <div className="flex-1 min-h-[280px] w-full bg-neutral-900/60 rounded-lg border border-neutral-800/80 overflow-hidden">
          {data && data.Y_positions.length > 0
            ? <LinkageDiagram params={params} data={data} y={yPose} details={details} />
            : <div className="flex h-full items-center justify-center p-4 text-center text-sm text-neutral-400">{data ? data.message : 'Loading…'}</div>}
        </div>
        <div className="shrink-0 mt-3 space-y-1">
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={`linkage-y-${kind}`} className="font-medium text-neutral-300">Carriage Y</label>
            <span className="font-mono text-neutral-100">{yPose.toFixed(2)} mm</span>
          </div>
          <input id={`linkage-y-${kind}`} type="range" min={-params.stroke} max={params.stroke} step={0.01} value={yPose}
            onChange={(e) => setY(parseFloat(e.target.value))} className="w-full accent-amber-500 cursor-pointer" />
        </div>
        {data && !data.feasible && data.Y_positions.length > 0 && (
          <p className="shrink-0 mt-2 rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">{data.message}</p>
        )}
        {error && <p className="shrink-0 mt-2 text-xs text-red-400" role="alert">{error}</p>}
      </div>

      {/* Panel 3: charts */}
      <div className="lg:col-span-5 min-w-0 grid grid-rows-3 gap-4 min-h-0">
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
          </LineChart>
        </ChartCard>
      </div>
    </div>
  );
}
