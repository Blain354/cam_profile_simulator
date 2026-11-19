import { Button, Input } from '@blain-projects/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Settings, Target } from 'lucide-react';
import { Accordion, ParameterSlider, StatRow, apiFetch } from './components';

// ─── Types (mirror backend/linkage.py) ───────────────────────────

type MirrorMode = 'symmetric' | 'opposed';

export interface LinkageParams {
  bar1_length: number;
  bar2_length: number;
  anchor_distance: number;
  pivot_offset: number;
  tube_center_x: number;
  pin_diameter: number;
  preload: number;
  stroke: number;
  mirror_mode: MirrorMode;
  target_exponent: number;
  tube_id: number;
  tube_od: number;
  input_pressure_psi: number;
  compliance: number;
}

interface LinkageSearch {
  bar1_min: number;
  bar1_max: number;
  bar2_min: number;
  bar2_max: number;
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
  elbow_x: Series;
  elbow_y: Series;
  gap_a: Series;
  gap_b: Series;
  flow_a: Series;
  flow_b: Series;
  flow_target: Series;
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
}

export type LinkagePneumatic = Pick<LinkageParams, 'tube_id' | 'tube_od' | 'input_pressure_psi' | 'compliance'>;

const DEFAULT_PARAMS: LinkageParams = {
  bar1_length: 13.0,
  bar2_length: 7.8,
  anchor_distance: 2.33,
  pivot_offset: 3.9,
  tube_center_x: 8.0,
  pin_diameter: 1.0,
  preload: 0.1,
  stroke: 3.0,
  mirror_mode: 'symmetric',
  target_exponent: 1.0,
  tube_id: 2.0,
  tube_od: 3.0,
  input_pressure_psi: 15.0,
  compliance: 0.7,
};

const DEFAULT_SEARCH: LinkageSearch = {
  bar1_min: 6,
  bar1_max: 20,
  bar2_min: 3,
  bar2_max: 14,
  anchor_min: 0,
  anchor_max: 6,
  min_pivot_height: 3,
  max_pivot_height: 16,
  max_oversqueeze: 0.5,
};

const STORAGE_KEY = 'cam-sim.linkage.v1';

function loadStored(pneumatic: LinkagePneumatic): { params: LinkageParams; search: LinkageSearch } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      return { params: { ...DEFAULT_PARAMS, ...raw.params }, search: { ...DEFAULT_SEARCH, ...raw.search } };
    }
  } catch { /* storage unavailable or corrupt: fall back to defaults */ }
  return { params: { ...DEFAULT_PARAMS, ...pneumatic }, search: DEFAULT_SEARCH };
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
const BLUE = '#3b82f6';
const SCREW_R = 1.5;

function LinkageDiagram({ params, data, y, details }: { params: LinkageParams; data: LinkageResult; y: number; details: boolean }) {
  const opposed = params.mirror_mode === 'opposed';
  const h0 = data.pivot_height_y0;
  const wall = data.wall_x;
  const rPin = Math.max(params.pin_diameter / 2, 0.18);
  const top = Math.max(h0 + params.stroke + 2.2, opposed ? 2 * h0 + 1.4 : 0);
  const margin = 1.7;
  const hB = h0 + y;

  // Tube A linkage (left): anchor at the bottom.
  const ax = interpAt(y, data.Y_positions, data.elbow_x);
  const ay = interpAt(y, data.Y_positions, data.elbow_y);
  // Tube B linkage: mirror image (left/right, plus up/down through the pivot at Y = 0 when opposed).
  const yB = opposed ? -y : y;
  const bx0 = interpAt(yB, data.Y_positions, data.elbow_x);
  const by0 = interpAt(yB, data.Y_positions, data.elbow_y);
  const bx = bx0 == null ? null : -bx0;
  const by = by0 == null ? null : opposed ? 2 * h0 - by0 : by0;
  const anchorB = { x: params.anchor_distance, y: opposed ? 2 * h0 : 0 };

  const gapA = interpAt(y, data.Y_positions, data.gap_a);
  const gapB = interpAt(y, data.Y_positions, data.gap_b);
  const flowA = interpAt(y, data.Y_positions, data.flow_a) ?? 0;
  const flowB = interpAt(y, data.Y_positions, data.flow_b) ?? 0;

  const hw = params.pivot_offset + 1.0;
  const carriage = [
    [-hw, hB + 0.9], [hw, hB + 0.9], [hw, hB - 0.3], [hw - 1.4, hB - 1.6], [-hw + 1.4, hB - 1.6], [-hw, hB - 0.3],
  ].map(([px, py]) => `${px},${-py}`).join(' ');

  const tube = (sign: 1 | -1, flow: number) => {
    const cx = sign * params.tube_center_x;
    const frac = data.max_flow_l_min > 0 ? Math.min(flow / data.max_flow_l_min, 1) : 0;
    return (
      <g>
        <rect x={cx - params.tube_od / 2} y={-top} width={params.tube_od} height={top + 1}
          fill={frac > 0 ? '#10b981' : '#ef4444'} fillOpacity={0.1 + 0.3 * frac} />
        {[-params.tube_od / 2, 0, params.tube_od / 2].map((dx) => (
          <line key={dx} x1={cx + dx} y1={-top} x2={cx + dx} y2={1} stroke="var(--bui-text)" strokeWidth={0.05} strokeDasharray="0.5 0.12 0.1 0.12" />
        ))}
      </g>
    );
  };

  const linkage = (anchor: { x: number; y: number }, pivotX: number, ex: number | null, ey: number | null, opacity: number) => (
    <g opacity={opacity}>
      {/* Ground mark at the fixed anchor */}
      <line x1={anchor.x - 0.6} y1={-anchor.y} x2={anchor.x + 0.6} y2={-anchor.y} stroke="var(--bui-text)" strokeWidth={0.14} />
      {ex != null && ey != null && (
        <>
          <line x1={pivotX} y1={-hB} x2={ex} y2={-ey} stroke={ORANGE} strokeWidth={0.22} strokeLinecap="round" />
          <line x1={ex} y1={-ey} x2={anchor.x} y2={-anchor.y} stroke={ORANGE} strokeWidth={0.22} strokeLinecap="round" />
          <circle cx={ex} cy={-ey} r={rPin} fill="var(--bui-surface)" stroke={ORANGE} strokeWidth={0.1} />
        </>
      )}
      <circle cx={anchor.x} cy={-anchor.y} r={0.22} fill={ORANGE} />
      <circle cx={pivotX} cy={-hB} r={0.42} fill={BLUE} />
    </g>
  );

  const label = (x: number, yy: number, text: string, color: string, anchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text x={x} y={-yy} fill={color} fontSize={0.62} fontWeight="bold" textAnchor={anchor} dominantBaseline="middle"
      stroke="var(--bui-surface)" strokeWidth={0.18} paintOrder="stroke">{text}</text>
  );

  return (
    <svg viewBox={`${-(wall + margin)} ${-top} ${2 * (wall + margin)} ${top + margin}`} preserveAspectRatio="xMidYMid meet"
      className="w-full h-full select-none" role="img" aria-label="Bar linkage schematic">
      {/* Fixed base: floor and the two walls the tubes rest on */}
      <rect x={-wall} y={-top} width={2 * wall} height={top} fill="var(--bui-muted)" fillOpacity={0.08} />
      <line x1={-wall} y1={0} x2={wall} y2={0} stroke="var(--bui-text)" strokeWidth={0.1} />
      <line x1={-wall} y1={-top} x2={-wall} y2={0} stroke="var(--bui-text)" strokeWidth={0.16} />
      <line x1={wall} y1={-top} x2={wall} y2={0} stroke="var(--bui-text)" strokeWidth={0.16} />
      {tube(-1, flowA)}
      {tube(1, flowB)}

      {/* Lead screw and carriage */}
      <rect x={-SCREW_R} y={-top + 0.4} width={2 * SCREW_R} height={top + 0.6} rx={0.2} fill="#d4a94a" fillOpacity={0.85} />
      <polygon points={carriage} fill="var(--bui-muted)" fillOpacity={0.75} stroke="var(--bui-text)" strokeWidth={0.06} />
      {/* Carriage pivot height at Y = 0 */}
      <line x1={-wall} y1={-h0} x2={wall} y2={-h0} stroke={BLUE} strokeWidth={0.04} strokeDasharray="0.2 0.2" />

      {linkage(anchorB, -params.pivot_offset, bx, by, 0.5)}
      {linkage({ x: -params.anchor_distance, y: 0 }, params.pivot_offset, ax, ay, 1)}

      {details && ax != null && ay != null && (
        <g>
          {label(ax + 0.3 * (params.pivot_offset - ax), ay + 0.3 * (hB - ay) + 0.9, `L1 ${params.bar1_length.toFixed(2)}`, ORANGE)}
          {label((ax - params.anchor_distance) / 2 + 0.4, ay / 2 - 0.8, `L2 ${params.bar2_length.toFixed(2)}`, ORANGE)}
          <line x1={0} y1={0.75} x2={-params.anchor_distance} y2={0.75} stroke={ORANGE} strokeWidth={0.06} />
          <line x1={0} y1={0.45} x2={0} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
          <line x1={-params.anchor_distance} y1={0.45} x2={-params.anchor_distance} y2={1.05} stroke={ORANGE} strokeWidth={0.06} />
          {label(-params.anchor_distance / 2, -1.35, `a ${params.anchor_distance.toFixed(2)}`, ORANGE)}
          {label(-wall + 0.25, h0 + 0.55, `h₀ ${h0.toFixed(2)}`, BLUE, 'start')}
          {gapA != null && label(-wall + 0.2, ay + 1.1, `gap ${gapA.toFixed(3)}`, 'var(--bui-text)', 'start')}
          {gapB != null && by != null && label(wall - 0.2, by + (opposed ? -1.1 : 1.1), `gap ${gapB.toFixed(3)}`, 'var(--bui-text)', 'end')}
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

// ─── Tab ─────────────────────────────────────────────────────────

export default function LinkageExplorer({ initialPneumatic }: { initialPneumatic: LinkagePneumatic }) {
  const [stored] = useState(() => loadStored(initialPneumatic));
  const [params, setParams] = useState<LinkageParams>(stored.params);
  const [search, setSearch] = useState<LinkageSearch>(stored.search);
  const [data, setData] = useState<LinkageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [y, setY] = useState(0);
  const [details, setDetails] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [optMessage, setOptMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const opposed = params.mirror_mode === 'opposed';
  const set = <K extends keyof LinkageParams>(key: K, value: LinkageParams[K]) => setParams((p) => ({ ...p, [key]: value }));
  const setS = (key: keyof LinkageSearch, value: number) => setSearch((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ params, search })); } catch { /* ignore */ }
  }, [params, search]);

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

  const yLo = opposed ? -params.stroke : 0;
  const yPose = Math.min(Math.max(y, yLo), params.stroke);

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
        setOptMessage({ ok: false, text: `No feasible geometry among ${out.tested} combinations. Widen the ranges, raise the pivot height limit${opposed ? ' or allow more over-squeeze' : ''}.` });
        return;
      }
      setParams(out.params);
      setOptMessage({
        ok: true,
        text: `Applied L1 ${out.params.bar1_length.toFixed(2)}, L2 ${out.params.bar2_length.toFixed(2)}, a ${out.params.anchor_distance.toFixed(2)} mm: ${(out.result.rms_error * 100).toFixed(1)} % RMS from target (${out.feasible} of ${out.tested} coarse combinations feasible).`,
      });
    } catch {
      setOptMessage({ ok: false, text: 'Optimizer request failed.' });
    } finally {
      setOptimizing(false);
    }
  };

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.Y_positions
      .map((yy, i) => ({
        y: yy,
        flowA: data.flow_a[i],
        flowB: opposed ? data.flow_b[i] : undefined,
        target: data.flow_target[i],
        gapA: data.gap_a[i],
        gapB: opposed ? data.gap_b[i] : undefined,
      }))
      .filter((row) => opposed || row.y >= -1e-9);
  }, [data, opposed]);

  const tooltipStyle = { backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' };
  const xAxis = (
    <XAxis dataKey="y" type="number" domain={['dataMin', 'dataMax']} stroke="#888"
      label={{ value: 'Carriage Y (mm)', position: 'bottom', fill: '#888' }} tickFormatter={(v) => Number(v).toFixed(2)} />
  );

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">
      {/* Panel 1: parameters */}
      <div className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-4 min-w-0">
          <Settings className="w-5 h-5 text-amber-500 shrink-0" />
          <h2 className="text-lg font-bold text-white tracking-tight truncate">Bar linkage</h2>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-4">
          <Accordion title="Bars (design variables)">
            <div className="space-y-5 pt-2">
              <ParameterSlider label="Bar 1, L1 (mm)" value={params.bar1_length} min={2} max={30} step={0.05} onChange={(v) => set('bar1_length', v)}
                description="Carriage pivot (blue) to the elbow that pinches the tube." />
              <ParameterSlider label="Bar 2, L2 (mm)" value={params.bar2_length} min={1} max={20} step={0.05} onChange={(v) => set('bar2_length', v)}
                description="Elbow to the fixed anchor on the base." />
              <ParameterSlider label="Anchor dist, a (mm)" value={params.anchor_distance} min={-5} max={10} step={0.01} onChange={(v) => set('anchor_distance', v)}
                description="Fixed anchor offset from the centre of the base, toward the tube. Negative puts it on the far side of the screw." />
            </div>
          </Accordion>

          <Accordion title="Optimizer" defaultOpen={false}>
            <div className="space-y-3 pt-2">
              <ParameterSlider label="Target exponent" value={params.target_exponent} min={0.3} max={3} step={0.05} onChange={(v) => set('target_exponent', v)}
                secondaryValue={params.target_exponent === 1 ? 'linear' : undefined}
                description="Target opening = (Y / stroke)^exponent, closed at Y = 0 and full bore at the end of the stroke. 1 is strictly proportional; above 1 is finer near closure." />
              <RangeRow label="L1 range" min={search.bar1_min} max={search.bar1_max} onMin={(v) => setS('bar1_min', v)} onMax={(v) => setS('bar1_max', v)} />
              <RangeRow label="L2 range" min={search.bar2_min} max={search.bar2_max} onMin={(v) => setS('bar2_min', v)} onMax={(v) => setS('bar2_max', v)} />
              <RangeRow label="a range" min={search.anchor_min} max={search.anchor_max} onMin={(v) => setS('anchor_min', v)} onMax={(v) => setS('anchor_max', v)} />
              <RangeRow label="Pivot height" min={search.min_pivot_height} max={search.max_pivot_height} onMin={(v) => setS('min_pivot_height', v)} onMax={(v) => setS('max_pivot_height', v)} />
              {opposed && (
                <ParameterSlider label="Max over-squeeze" value={search.max_oversqueeze} min={0.05} max={2} step={0.05} onChange={(v) => setS('max_oversqueeze', v)}
                  description="How far past closure the closed tube may be crushed while the other one opens over the stroke." />
              )}
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
              <div className="space-y-1.5">
                <span className="text-sm font-medium text-neutral-300">Mirror</span>
                <div className="flex gap-1 rounded-lg border border-neutral-700 p-1">
                  {(['symmetric', 'opposed'] as const).map((mode) => (
                    <Button key={mode} variant="ghost" type="button" aria-pressed={params.mirror_mode === mode} onClick={() => set('mirror_mode', mode)}
                      className={`flex-1 rounded-md px-2 py-1 text-xs font-bold ${params.mirror_mode === mode ? 'bg-amber-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}>
                      {mode === 'symmetric' ? 'Both open' : 'Opposed'}
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] leading-snug text-neutral-400">
                  {opposed
                    ? 'Second linkage flipped top to bottom: tube A opens for Y > 0, tube B for Y < 0.'
                    : 'Second linkage mirrored left to right: both tubes open together for Y > 0.'}
                </p>
              </div>
              <ParameterSlider label="Stroke (mm)" value={params.stroke} min={0.5} max={10} step={0.1} onChange={(v) => set('stroke', v)}
                description="Carriage travel from closed (Y = 0) to the target full opening." />
              <ParameterSlider label="Pivot offset (mm)" value={params.pivot_offset} min={0} max={10} step={0.05} onChange={(v) => set('pivot_offset', v)}
                description="Carriage pivot distance from the screw axis, on the side opposite its tube." />
              <ParameterSlider label="Tube centre (mm)" value={params.tube_center_x} min={3} max={20} step={0.05} onChange={(v) => set('tube_center_x', v)}
                secondaryValue={data ? `wall ${data.wall_x.toFixed(2)}` : undefined}
                description="Tube axis distance from the screw axis. The tube rests on a wall half an OD further out." />
              <ParameterSlider label="Pinch pin Ø (mm)" value={params.pin_diameter} min={0} max={4} step={0.1} onChange={(v) => set('pin_diameter', v)}
                description="Diameter of the pin at the elbow that presses on the tube." />
              <ParameterSlider label="Preload (mm)" value={params.preload} min={0} max={0.5} step={0.01} onChange={(v) => set('preload', v)}
                description="Extra squeeze past the just-closed gap at Y = 0, as a sealing margin." />
            </div>
          </Accordion>

          <Accordion title="Pneumatic system" defaultOpen={false} showBottomBorder={false}>
            <div className="space-y-5 pt-2">
              <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1} max={12} step={0.1} onChange={(v) => set('tube_id', v)} />
              <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1} max={16} step={0.1} onChange={(v) => set('tube_od', v)} />
              <ParameterSlider label="Pressure (PSI)" value={params.input_pressure_psi} min={0} max={150} step={1} onChange={(v) => set('input_pressure_psi', v)}
                secondaryValue={`${(params.input_pressure_psi * 6.89476).toFixed(1)} kPa`} />
              <ParameterSlider label="Compliance" value={params.compliance} min={0} max={5} step={0.01} onChange={(v) => set('compliance', v)} />
            </div>
          </Accordion>
        </div>

        {data && (
          <div className="shrink-0 mt-4 pt-4 border-t border-neutral-700 space-y-2">
            <h3 className="text-xs font-semibold text-neutral-400 mb-2">Derived</h3>
            <StatRow label="Pivot height at Y=0" value={`${data.pivot_height_y0.toFixed(3)} mm`} highlight />
            <StatRow label="Gain at Y=0" value={`${data.sensitivity_y0.toFixed(3)} mm/mm`} />
            <StatRow label="Full flow at" value={data.y_full_open != null ? `Y = ${data.y_full_open.toFixed(2)} mm` : 'not reached'} />
            <StatRow label="Deviation from target" value={data.rms_error != null ? `${(data.rms_error * 100).toFixed(1)} % RMS` : 'N/A'} />
            <StatRow label="Max over-squeeze" value={`${data.max_oversqueeze.toFixed(3)} mm`} />
            <StatRow label="Pinch slide on tube" value={`${data.pinch_slide.toFixed(2)} mm`} />
            <StatRow label="Max flow (static)" value={`${data.max_flow_l_min.toFixed(2)} L/min`} />
          </div>
        )}
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
            <label htmlFor="linkage-y" className="font-medium text-neutral-300">Carriage Y</label>
            <span className="font-mono text-neutral-100">{yPose.toFixed(2)} mm</span>
          </div>
          <input id="linkage-y" type="range" min={yLo} max={params.stroke} step={0.01} value={yPose}
            onChange={(e) => setY(parseFloat(e.target.value))} className="w-full accent-amber-500 cursor-pointer" />
        </div>
        {data && !data.feasible && data.Y_positions.length > 0 && (
          <p className="shrink-0 mt-2 rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">{data.message}</p>
        )}
        {error && <p className="shrink-0 mt-2 text-xs text-red-400" role="alert">{error}</p>}
      </div>

      {/* Panel 3: charts */}
      <div className="lg:col-span-5 min-w-0 grid grid-rows-2 gap-4 min-h-0">
        <div className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 flex flex-col min-h-0">
          <h3 className="text-sm font-bold text-neutral-200 text-center mb-2 shrink-0">Static flow vs carriage Y</h3>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxis}
                <YAxis type="number" stroke="#888" tickFormatter={(v) => Number(v).toFixed(1)}
                  label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} L/min`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
                <Line type="linear" dataKey="target" name="Target" stroke="#9ca3af" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="flowA" name={opposed ? 'Tube A' : 'Each tube'} stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                {opposed && <Line type="linear" dataKey="flowB" name="Tube B" stroke="#22d3ee" strokeWidth={3} dot={false} isAnimationActive={false} />}
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 flex flex-col min-h-0">
          <h3 className="text-sm font-bold text-neutral-200 text-center mb-2 shrink-0">Pinch gap vs carriage Y</h3>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxis}
                <YAxis type="number" stroke="#888" domain={['auto', 'auto']} tickFormatter={(v) => Number(v).toFixed(2)}
                  label={{ value: 'Pin to wall (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(3)} mm`} labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`} />
                {data && <ReferenceLine y={data.closed_gap} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'closed', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />}
                {data && <ReferenceLine y={data.full_open_gap} stroke="#10b981" strokeDasharray="3 3" label={{ value: 'full bore', fill: '#10b981', fontSize: 11, position: 'insideTopRight' }} />}
                <Line type="linear" dataKey="gapA" name={opposed ? 'Tube A' : 'Each tube'} stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                {opposed && <Line type="linear" dataKey="gapB" name="Tube B" stroke="#22d3ee" strokeWidth={3} dot={false} isAnimationActive={false} />}
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
