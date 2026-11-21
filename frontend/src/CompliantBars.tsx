import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Settings } from 'lucide-react';
import { Accordion, ParameterSlider, StatRow, apiFetch } from './components';
import type { ChartDomainSettings } from './components';
import { ChartCard } from './ChartCard';
import { chartDomain } from './lib/chartDomain';
import { TubeModelControls } from './TubeModel';
import type { TubeModel } from './lib/tubeModel';
import type { SubTab } from './SubTabs';

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
  member_modulus_mpa: 2500,
  member_strength_mpa: 40,
  carriage_pin_diameter: 1.5,
  tube_center_x: 8,
  tube_id: 2,
  tube_od: 3,
  input_pressure_kpa: 100,
  compliance: 0.7,
  tube_model: 'simple' as TubeModel,
  tube_shore_a: 50,
};

export type CompliantParams = typeof COMPLIANT_DEFAULTS;

const SHAPE_KEYS = [
  'anchor_distance', 'junction_x', 'junction_y', 'pinch_y',
  'l_u1', 'l_v1', 'l_u2', 'l_v2', 'r_u1', 'r_v1', 'r_u2', 'r_v2',
  'f_u1', 'f_v1', 'f_u2', 'f_v2', 'l_thickness', 'r_thickness', 'f_thickness',
] as const;

type ShapeKey = typeof SHAPE_KEYS[number];
type Member = 'l' | 'r' | 'f';
type Pt = [number, number];

const LIMITS: Record<ShapeKey, { min: number; max: number; step: number; label: string }> = {
  anchor_distance: { min: -2, max: 12, step: 0.05, label: 'Anchor distance' },
  junction_x: { min: -12, max: 8, step: 0.05, label: 'Junction x' },
  junction_y: { min: 2, max: 22, step: 0.05, label: 'Junction y' },
  pinch_y: { min: 1, max: 22, step: 0.05, label: 'Pinch height' },
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
  l_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness' },
  r_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness' },
  f_thickness: { min: 0.3, max: 3, step: 0.05, label: 'Thickness' },
};

const MEMBERS: { id: Member; title: string; color: string }[] = [
  { id: 'l', title: 'Member L', color: '#f59e0b' },
  { id: 'r', title: 'Member R', color: '#60a5fa' },
  { id: 'f', title: 'Foot', color: '#34d399' },
];

const STORE = 'cam-sim.compliant.v1';

interface Line {
  x: number[]; y: number[];
  x_per_y: number[]; y_per_y: number[];
  x_per_n: number[]; y_per_n: number[];
  thickness: number;
}

interface CompliantResult {
  feasible: boolean;
  passes: boolean;
  message: string;
  Y_positions: number[];
  flow_a: (number | null)[];
  flow_slope_mean: number | null;
  flow_slope_max: number | null;
  max_stress_mpa: number | null;
  stress_margin: number | null;
  plastic_ok: boolean;
  shell_ok: boolean;
  pivot_ok: boolean;
  shell_clearance_mm: number | null;
  pivot_clearance_mm: number | null;
  max_rotation_deg: number | null;
  wall_x: number;
  pivot_height_y0: number;
  pinch_x: number;
  travel_sign: number;
  force_a: (number | null)[];
  lines: Record<Member, Line>;
  anchor: Pt;
  junction: Pt;
  pinch: Pt;
  pivot: Pt;
}

interface Runner {
  slope: number | null;
  max_stress_mpa: number | null;
  shell_clearance_mm: number | null;
  pivot_clearance_mm: number | null;
  params: Partial<CompliantParams>;
}

function loadStore(): { params: CompliantParams; bounds: Record<ShapeKey, [number, number]> } {
  const bounds = defaultBounds();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (raw && typeof raw === 'object') {
      const params = { ...COMPLIANT_DEFAULTS, ...raw.params };
      params.tube_model = raw.params?.tube_model === 'fem' ? 'fem' : 'simple';
      for (const key of SHAPE_KEYS) {
        const pair = raw.bounds?.[key];
        if (Array.isArray(pair) && pair.length === 2) bounds[key] = [Number(pair[0]), Number(pair[1])];
      }
      return { params, bounds };
    }
  } catch { /* keep defaults */ }
  return { params: { ...COMPLIANT_DEFAULTS }, bounds };
}

function defaultBounds(): Record<ShapeKey, [number, number]> {
  const out = {} as Record<ShapeKey, [number, number]>;
  for (const key of SHAPE_KEYS) {
    const value = COMPLIANT_DEFAULTS[key] as number;
    const { min, max } = LIMITS[key];
    const span = key.endsWith('thickness') ? 0.4 : key.includes('_u') ? 0.15 : key.includes('_v') ? 1.5 : 1.5;
    out[key] = [Math.max(min, value - span), Math.min(max, value + span)];
  }
  return out;
}

function leftNormal(s: Pt, e: Pt): { n: Pt; length: number } {
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { n: [0, 1], length: 0 };
  return { n: [-dy / length, dx / length], length };
}

function bezier(s: Pt, e: Pt, u1: number, v1: number, u2: number, v2: number, n = 13): Pt[] {
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

function pinchX(p: CompliantParams): number {
  const wall = p.tube_center_x + p.tube_od / 2;
  const opening = p.tube_model === 'simple' ? p.compliance * p.input_pressure_kpa * 1e-3 : 0;
  const closed = (p.tube_od - p.tube_id) - opening;
  return (closed - p.preload) - wall + p.f_thickness / 2;
}

function interp(y: number, ys: number[], vs: (number | null)[]): number {
  if (!ys.length) return 0;
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

function deflected(line: Line, y: number, force: number): Pt[] {
  return line.x.map((x, i) => [
    x + line.x_per_y[i] * y + line.x_per_n[i] * force,
    line.y[i] + line.y_per_y[i] * y + line.y_per_n[i] * force,
  ] as Pt);
}

const mm = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} mm`);

function shapeLabel(key: ShapeKey): string {
  const who = key.startsWith('l_') ? 'L' : key.startsWith('r_') ? 'R' : key.startsWith('f_') ? 'foot' : '';
  return who ? `${LIMITS[key].label}, ${who}` : LIMITS[key].label;
}

export default function CompliantBars({ mode, onOpenExplorer }: { mode: SubTab; onOpenExplorer: () => void }) {
  const [initial] = useState(loadStore);
  const [params, setParams] = useState<CompliantParams>(initial.params);
  const [bounds, setBounds] = useState(initial.bounds);
  const [result, setResult] = useState<CompliantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [solveNote, setSolveNote] = useState<string | null>(null);
  const [y, setY] = useState(0);
  const [domain, setDomain] = useState<ChartDomainSettings>({ autoX: true, autoY: true, xMin: 0, xMax: 2, yMin: 0, yMax: 12 });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<null | { kind: 'anchor' } | { kind: 'junction' } | { kind: 'pinch' } | { kind: 'handle'; member: Member; index: 0 | 1 }>(null);

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ params, bounds })); } catch { /* ignore */ }
  }, [params, bounds]);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      apiFetch('/api/compliant/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params), signal: ctrl.signal,
      }).then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.lines) {
          setError(typeof data?.detail === 'string' ? data.detail : 'The shape could not be solved.');
          return;
        }
        setError(null);
        setResult(data as CompliantResult);
      }).catch((err) => { if (err?.name !== 'AbortError') setError('The shape could not be solved.'); });
    }, 160);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [params]);

  const setShape = useCallback((key: ShapeKey, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const anchor: Pt = [-params.anchor_distance, 0];
  const junction: Pt = [params.junction_x, params.junction_y];
  const pivot: Pt = [params.pivot_inverted ? -params.pivot_offset : params.pivot_offset, params.closed_carriage_height];
  const pinch: Pt = [result?.pinch_x ?? pinchX(params), params.pinch_y];
  const wall = result?.wall_x ?? params.tube_center_x + params.tube_od / 2;
  const h0 = result?.pivot_height_y0 ?? params.closed_carriage_height;
  const ceiling = 2 * h0;
  const force = result ? interp(y, result.Y_positions, result.force_a) : 0;
  const restLines = useMemo(() => ({
    l: bezier(anchor, junction, params.l_u1, params.l_v1, params.l_u2, params.l_v2),
    r: bezier(junction, pivot, params.r_u1, params.r_v1, params.r_u2, params.r_v2),
    f: bezier(junction, pinch, params.f_u1, params.f_v1, params.f_u2, params.f_v2),
  }), [anchor[0], anchor[1], junction[0], junction[1], pivot[0], pivot[1], pinch[0], pinch[1], params]);
  const lines = useMemo(() => {
    if (!result?.lines) return restLines;
    return {
      l: deflected(result.lines.l, y, force),
      r: deflected(result.lines.r, y, force),
      f: deflected(result.lines.f, y, force),
    };
  }, [result, y, force, restLines]);

  const chords: Record<Member, [Pt, Pt]> = { l: [anchor, junction], r: [junction, pivot], f: [junction, pinch] };
  const handleOf = (member: Member, index: 0 | 1): Pt => {
    const [s, e] = chords[member];
    const { n } = leftNormal(s, e);
    const u = params[`${member}_u${index + 1}` as ShapeKey] as number;
    const v = params[`${member}_v${index + 1}` as ShapeKey] as number;
    return [s[0] + u * (e[0] - s[0]) + v * n[0], s[1] + u * (e[1] - s[1]) + v * n[1]];
  };

  const toWorld = (event: React.PointerEvent): Pt | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, -p.y];
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const what = drag.current;
    if (!what) return;
    const p = toWorld(event);
    if (!p) return;
    if (what.kind === 'anchor') setShape('anchor_distance', Math.min(12, Math.max(-2, -p[0])));
    else if (what.kind === 'junction') setParams((prev) => ({ ...prev, junction_x: p[0], junction_y: Math.max(1, p[1]) }));
    else if (what.kind === 'pinch') setShape('pinch_y', Math.max(0.5, p[1]));
    else {
      const [s, e] = chords[what.member];
      const { n, length } = leftNormal(s, e);
      if (length < 1e-6) return;
      const dx = e[0] - s[0], dy = e[1] - s[1];
      const u = Math.min(0.95, Math.max(0.05, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (length * length)));
      const v = (p[0] - s[0]) * n[0] + (p[1] - s[1]) * n[1];
      setParams((prev) => ({ ...prev, [`${what.member}_u${what.index + 1}`]: u, [`${what.member}_v${what.index + 1}`]: v }));
    }
  };

  const flowRows = (result?.Y_positions ?? []).map((yy, i) => ({ y: yy, flow: result?.flow_a[i] }))
    .filter((row) => row.y >= -1e-9 && row.flow != null);

  const solve = async () => {
    setSolving(true);
    setSolveNote(null);
    try {
      const boundPayload = Object.fromEntries(SHAPE_KEYS.map((key) => [key, bounds[key]]));
      const res = await apiFetch('/api/compliant/solve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params, bounds: boundPayload, budget: 36 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSolveNote(typeof data?.detail === 'string' ? data.detail : 'The solver failed.');
        return;
      }
      setRunners(data.runners ?? []);
      setSolveNote(data.found
        ? `Tested ${data.tested}. ${data.feasible} passed. Best slope ${Number(data.result?.flow_slope_mean).toFixed(2)} L/min per mm.`
        : `Tested ${data.tested}. None passed. ${data.message ?? ''}`);
      if (data.found && data.params) {
        setParams((prev) => ({ ...prev, ...data.params }));
        setResult(data.result);
      }
    } catch {
      setSolveNote('The solver failed.');
    } finally {
      setSolving(false);
    }
  };

  const applyRunner = (runner: Runner) => {
    setParams((prev) => ({ ...prev, ...runner.params }));
    onOpenExplorer();
  };

  const margin = 2;
  const poly = (pts: Pt[]) => pts.map(([x, yy]) => `${x.toFixed(3)},${(-yy).toFixed(3)}`).join(' ');
  const dot = (p: Pt, color: string, kind: 'anchor' | 'junction' | 'pinch', label: string) => (
    <g className="cursor-grab" onPointerDown={(e) => { drag.current = { kind }; svgRef.current?.setPointerCapture(e.pointerId); }}>
      <circle cx={p[0]} cy={-p[1]} r={0.45} fill="var(--bui-surface)" stroke={color} strokeWidth={0.12} />
      <text x={p[0] + 0.5} y={-p[1] - 0.45} fill={color} fontSize={0.55} fontWeight="bold">{label}</text>
    </g>
  );

  const carriageY = h0 + (result?.travel_sign ?? 1) * y;
  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, yy]) => [-x, ceiling - yy]);

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0">
      <div className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-blue-500" />
          <h2 className="text-lg font-bold text-white tracking-tight">{mode === 'finder' ? 'Solver' : 'Splines'}</h2>
        </div>
        {mode === 'explorer' ? (
          <div className="space-y-1">
            <Accordion title="Skeleton">
              <div className="space-y-4 pt-2">
                {(['anchor_distance', 'junction_x', 'junction_y', 'pinch_y'] as ShapeKey[]).map((key) => (
                  <ParameterSlider key={key} value={params[key] as number} {...LIMITS[key]} onChange={(v) => setShape(key, v)} />
                ))}
              </div>
            </Accordion>
            {MEMBERS.map((member) => (
              <Accordion key={member.id} title={member.title}>
                <div className="space-y-4 pt-2">
                  {([1, 2] as const).flatMap((n) => (['u', 'v'] as const).map((axis) => {
                    const key = `${member.id}_${axis}${n}` as ShapeKey;
                    return <ParameterSlider key={key} value={params[key] as number} {...LIMITS[key]} onChange={(v) => setShape(key, v)} />;
                  }))}
                  <ParameterSlider value={params[`${member.id}_thickness`] as number} {...LIMITS[`${member.id}_thickness` as ShapeKey]} onChange={(v) => setShape(`${member.id}_thickness` as ShapeKey, v)} />
                </div>
              </Accordion>
            ))}
            <Accordion title="Context" defaultOpen={false}>
              <div className="space-y-4 pt-2">
                <div className="flex gap-2">
                  {([['PETG', 2500, 40], ['PLA', 3500, 50]] as const).map(([name, modulus, strength]) => (
                    <button key={name} type="button" onClick={() => setParams((prev) => ({ ...prev, member_modulus_mpa: modulus, member_strength_mpa: strength }))}
                      className="px-2 py-1 text-xs rounded border border-neutral-600 text-neutral-200 hover:bg-neutral-700">{name}</button>
                  ))}
                </div>
                <ParameterSlider label="Modulus" value={params.member_modulus_mpa} min={200} max={20000} step={50} onChange={(v) => setParams((p) => ({ ...p, member_modulus_mpa: v }))} secondaryValue="MPa" />
                <ParameterSlider label="Strength" value={params.member_strength_mpa} min={1} max={200} step={1} onChange={(v) => setParams((p) => ({ ...p, member_strength_mpa: v }))} secondaryValue="MPa" />
                <ParameterSlider label="Depth, out of plane" value={params.member_depth} min={0.4} max={8} step={0.1} onChange={(v) => setParams((p) => ({ ...p, member_depth: v }))} />
                <ParameterSlider label="Carriage height at closure" value={params.closed_carriage_height} min={3} max={16} step={0.05} onChange={(v) => setParams((p) => ({ ...p, closed_carriage_height: v }))} />
                <ParameterSlider label="Pivot offset" value={params.pivot_offset} min={0} max={10} step={0.05} onChange={(v) => setParams((p) => ({ ...p, pivot_offset: v }))} />
                <button type="button" onClick={() => setParams((p) => ({ ...p, pivot_inverted: !p.pivot_inverted }))}
                  className={`w-full text-left text-sm px-2 py-1.5 rounded border ${params.pivot_inverted ? 'border-blue-500 text-blue-300' : 'border-neutral-600 text-neutral-300'}`}>
                  {params.pivot_inverted ? 'Pivot on the tube side' : 'Pivot on the far side'}
                </button>
                <ParameterSlider label="Pivot diameter" value={params.carriage_pin_diameter} min={0.4} max={4} step={0.05} onChange={(v) => setParams((p) => ({ ...p, carriage_pin_diameter: v }))} />
                <ParameterSlider label="Stroke" value={params.stroke} min={0.4} max={6} step={0.05} onChange={(v) => setParams((p) => ({ ...p, stroke: v }))} />
                <ParameterSlider label="Tube center" value={params.tube_center_x} min={3} max={16} step={0.05} onChange={(v) => setParams((p) => ({ ...p, tube_center_x: v }))} />
                <ParameterSlider label="Tube ID" value={params.tube_id} min={0.4} max={8} step={0.05} onChange={(v) => setParams((p) => ({ ...p, tube_id: v }))} />
                <ParameterSlider label="Tube OD" value={params.tube_od} min={0.6} max={12} step={0.05} onChange={(v) => setParams((p) => ({ ...p, tube_od: v }))} />
                <ParameterSlider label="Pressure" value={params.input_pressure_kpa} min={0} max={400} step={5} onChange={(v) => setParams((p) => ({ ...p, input_pressure_kpa: v }))} secondaryValue="kPa" />
                <TubeModelControls model={params.tube_model} shore={params.tube_shore_a}
                  onModel={(tube_model) => setParams((p) => ({ ...p, tube_model }))}
                  onShore={(tube_shore_a) => setParams((p) => ({ ...p, tube_shore_a }))} />
                <ParameterSlider label="Compliance" value={params.compliance} min={0.05} max={3} step={0.05} onChange={(v) => setParams((p) => ({ ...p, compliance: v }))} disabled={params.tube_model !== 'simple'} />
              </div>
            </Accordion>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-neutral-400 leading-snug">The solver varies the splines inside these ranges. It keeps a shape only when the stress stays under the material limit, and the part clears the pivot and the shell. The winner is the steepest static-flow slope.</p>
            {SHAPE_KEYS.map((key) => (
              <div key={key} className="grid grid-cols-[1fr_4.5rem_4.5rem] gap-2 items-center">
                <span className="text-xs text-neutral-300 truncate">{shapeLabel(key)}</span>
                <input aria-label={`${shapeLabel(key)} min`} type="number" value={bounds[key][0]} step={LIMITS[key].step}
                  onChange={(e) => setBounds((prev) => ({ ...prev, [key]: [Number(e.target.value), prev[key][1]] }))}
                  className="bg-neutral-900 border border-neutral-700 rounded px-1 py-1 text-xs text-neutral-100 font-mono" />
                <input aria-label={`${shapeLabel(key)} max`} type="number" value={bounds[key][1]} step={LIMITS[key].step}
                  onChange={(e) => setBounds((prev) => ({ ...prev, [key]: [prev[key][0], Number(e.target.value)] }))}
                  className="bg-neutral-900 border border-neutral-700 rounded px-1 py-1 text-xs text-neutral-100 font-mono" />
              </div>
            ))}
            <button type="button" onClick={solve} disabled={solving}
              className="w-full mt-2 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-semibold text-white">
              {solving ? 'Solving…' : 'Solve'}
            </button>
            {solveNote && <p className="text-xs text-neutral-300 leading-snug">{solveNote}</p>}
            {runners.length > 1 && (
              <div className="space-y-1">
                {runners.slice(1).map((runner, i) => (
                  <button key={i} type="button" onClick={() => applyRunner(runner)}
                    className="w-full text-left text-xs px-2 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-700">
                    Slope {runner.slope == null ? '—' : runner.slope.toFixed(2)} · stress {runner.max_stress_mpa == null ? '—' : runner.max_stress_mpa.toFixed(0)} MPa
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="lg:col-span-5 min-w-0 bg-neutral-800 rounded-xl border border-neutral-700 flex flex-col min-h-0 p-3">
        <svg ref={svgRef} viewBox={`${-(wall + margin)} ${-ceiling - margin} ${2 * (wall + margin)} ${ceiling + 2 * margin}`}
          className="w-full flex-1 min-h-[240px] select-none touch-none" role="img" aria-label="Compliant bars"
          onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
          <rect x={-wall} y={-ceiling} width={2 * wall} height={ceiling} fill="var(--bui-muted)" fillOpacity={0.08} stroke="var(--bui-text)" strokeWidth={0.14} />
          {[-1, 1].map((side) => (
            <rect key={side} x={side < 0 ? -wall - 0.7 : wall} y={-ceiling - 1} width={0.7} height={ceiling + 2} fill="var(--bui-text)" fillOpacity={0.35} />
          ))}
          <rect x={-0.45} y={-ceiling - 0.4} width={0.9} height={ceiling + 0.8} rx={0.2} fill="#d4a94a" fillOpacity={0.85} />
          <circle cx={pivot[0]} cy={-carriageY} r={Math.max(params.carriage_pin_diameter / 2, 0.2)} fill="#60a5fa" />
          {MEMBERS.map((member) => (
            <g key={member.id}>
              <polyline points={poly(lines[member.id])} fill="none" stroke={member.color} strokeOpacity={0.35} strokeWidth={params[`${member.id}_thickness`]} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={poly(lines[member.id])} fill="none" stroke={member.color} strokeWidth={0.12} strokeLinecap="round" />
              {([0, 1] as const).map((index) => {
                const h = handleOf(member.id, index);
                const end = index === 0 ? chords[member.id][0] : chords[member.id][1];
                return (
                  <g key={index} className="cursor-grab" onPointerDown={(e) => { drag.current = { kind: 'handle', member: member.id, index }; svgRef.current?.setPointerCapture(e.pointerId); }}>
                    <line x1={end[0]} y1={-end[1]} x2={h[0]} y2={-h[1]} stroke={member.color} strokeOpacity={0.7} strokeWidth={0.06} />
                    <circle cx={h[0]} cy={-h[1]} r={0.32} fill={member.color} />
                  </g>
                );
              })}
            </g>
          ))}
          {result && (
            <g opacity={0.35}>
              {MEMBERS.map((member) => (
                <polyline key={member.id} points={poly(mirror(deflected(result.lines[member.id], -y, interp(-y, result.Y_positions, result.force_a))))}
                  fill="none" stroke={member.color} strokeWidth={params[`${member.id}_thickness`]} strokeLinecap="round" />
              ))}
            </g>
          )}
          {dot(anchor, '#f59e0b', 'anchor', 'A')}
          {dot(junction, '#e5e5e5', 'junction', 'J')}
          {dot(pinch, '#34d399', 'pinch', 'P')}
        </svg>
        <label className="mt-2 flex items-center gap-3 text-xs text-neutral-400">
          Carriage Y
          <input type="range" min={-params.stroke} max={params.stroke} step={0.01} value={Math.min(params.stroke, Math.max(-params.stroke, y))}
            onChange={(e) => setY(Number(e.target.value))} className="flex-1 accent-blue-500" aria-label="Carriage Y" />
          <span className="font-mono text-neutral-200 w-14 text-right">{y.toFixed(2)}</span>
        </label>
        {error && <p className="text-xs text-red-300 mt-1">{error}</p>}
        {result && !result.passes && <p className="text-xs text-amber-300 mt-1">{result.message}</p>}
      </div>

      <div className="lg:col-span-4 min-w-0 flex flex-col gap-4 min-h-0 overflow-y-auto">
        <ChartCard title="Static flow vs carriage Y" settings={domain} onSettingsChange={setDomain}>
          {() => (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={flowRows} margin={{ top: 16, right: 12, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
                <XAxis dataKey="y" type="number" domain={chartDomain(domain, 'x', [0, params.stroke])} stroke="#a3a3a3" tick={{ fontSize: 11 }}
                  label={{ value: 'Y (mm)', position: 'insideBottom', offset: -2, fill: '#a3a3a3', fontSize: 11 }} />
                <YAxis domain={chartDomain(domain, 'y')} stroke="#a3a3a3" tick={{ fontSize: 11 }} width={48}
                  label={{ value: 'L/min', angle: -90, position: 'insideLeft', fill: '#a3a3a3', fontSize: 11 }} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(3)} L/min`, 'Flow']} labelFormatter={(label) => `Y ${Number(label).toFixed(2)} mm`} />
                <Line type="monotone" dataKey="flow" name="Static flow" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <div className="bg-neutral-800 rounded-xl border border-neutral-700 p-3 space-y-2">
          <StatRow label="Flow slope" value={result?.flow_slope_mean == null ? '—' : `${result.flow_slope_mean.toFixed(2)} L/min/mm`} highlight />
          <StatRow label="Peak slope" value={result?.flow_slope_max == null ? '—' : `${result.flow_slope_max.toFixed(2)}`} />
          <StatRow label="Worst stress" value={result?.max_stress_mpa == null ? '—' : `${result.max_stress_mpa.toFixed(1)} / ${params.member_strength_mpa} MPa`} highlight={result ? !result.plastic_ok : false} />
          <StatRow label="Shell clearance" value={mm(result?.shell_clearance_mm)} highlight={result ? !result.shell_ok : false} />
          <StatRow label="Pivot clearance" value={mm(result?.pivot_clearance_mm)} highlight={result ? !result.pivot_ok : false} />
          <StatRow label="Largest rotation" value={result?.max_rotation_deg == null ? '—' : `${result.max_rotation_deg.toFixed(1)}°`} />
        </div>
      </div>
    </div>
  );
}
