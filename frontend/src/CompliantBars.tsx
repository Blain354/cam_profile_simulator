import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Line, LineChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@blain-projects/ui';
import { Pause, Play, Settings } from 'lucide-react';
import { FlowParticles, FlowParticlesSwitch } from './FlowParticles';
import { sideBore, tubeProfile } from './lib/tubeSide';
import { useTubeSweep } from './lib/tubeSweep';
import type { TubeSweep } from './lib/tubeSweep';
import { Accordion, AccordionScope, ParameterSlider, StatRow, apiFetch } from './components';
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
/** Same motor the other tabs start from, so Oscillate runs at the same carriage speed. */
const MOTOR_RPM = 100;
const SCREW_PITCH_MM = 0.5;
const LOAD_FACTOR = 0.85;

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

/** The foot sample nearest that wall. A constant thickness makes the nearest centre the contact. */
function nearestToWall(pts: Pt[], sign: 1 | -1): Pt {
  return pts.reduce((best, p) => (sign * p[0] > sign * best[0] ? p : best));
}

/** Same side-view tube as the pendulum: the foot is a round pin, the silicone climbs back to its diameter beside it. */
function pinchedTube({
  sign, name, contact, rPin, wall, od, id, top, flow, maxFlow, sweep, stale,
}: {
  sign: 1 | -1; name: string; contact: Pt; rPin: number; wall: number; od: number; id: number;
  top: number; flow: number; maxFlow: number; sweep: TubeSweep | null; stale: boolean;
}) {
  const frac = maxFlow > 0 ? Math.min(Math.max(flow, 0) / maxFlow, 1) : 0;
  const fromWall = wall - sign * contact[0];
  const ends: [Pt, Pt] = [[fromWall, contact[1]], [fromWall, contact[1]]];
  const profile = tubeProfile(ends, rPin, od, -1, top + 1, sweep ? od : undefined);
  const bore = sideBore(profile, od, id, sweep);
  const xy = (u: number, v: number) => `${(sign * (wall - u)).toFixed(3)},${(-v).toFixed(3)}`;
  const ring = (inner: number[], outer: number[]) =>
    [...profile.map(([, v], i) => xy(outer[i], v)), ...profile.map(([, v], i) => xy(inner[i], v)).reverse()].join(' ');
  const cx = sign * (wall - od / 2);
  return (
    <g>
      {sweep && <title>{`Tube ${name.trim()[0]}, side view: the wall follows the foot, and the open bore at each station is the FEM section's at the local foot-to-wall distance, so it shuts before the wall stops moving. The shoulders on each side of the foot (about one OD) are schematic.${stale ? ' The previous tube, shown while the new one solves.' : ''}`}</title>}
      <polygon points={ring(profile.map(() => 0), profile.map(([h]) => h))} fill="var(--bui-text)" fillOpacity={0.16} stroke="var(--bui-text)" strokeWidth={0.05} strokeLinejoin="round" />
      <polygon points={ring(bore.map((b) => b[1]), bore.map((b) => b[2]))} fill={frac > 0 ? '#10b981' : '#ef4444'} fillOpacity={0.25 + 0.45 * frac} />
      <FlowParticles view="side" frac={frac} bore={bore} direction={sign < 0 ? -1 : 1}
        radius={Math.min(0.16, id / 6)} color="var(--bui-text)" transform={`matrix(${-sign} 0 0 -1 ${sign * wall} 0)`} />
      <line x1={cx} y1={-top - 1} x2={cx} y2={1} stroke="var(--bui-text)" strokeOpacity={0.5} strokeWidth={0.04} strokeDasharray="0.5 0.12 0.1 0.12" />
      <text x={cx} y={-(top + 1.1)} fill="var(--bui-text)" fontSize={0.62} fontWeight="bold" textAnchor="middle"
        stroke="var(--bui-surface)" strokeWidth={0.18} paintOrder="stroke">{name}</text>
    </g>
  );
}

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
  const [playing, setPlaying] = useState(false);
  const motion = useRef({ d: 0, speed: 0, stroke: COMPLIANT_DEFAULTS.stroke });
  const { drawn: tubeSweep, stale: tubeStale } = useTubeSweep(params);
  const yPose = Math.min(params.stroke, Math.max(-params.stroke, y));
  const loadedRpm = MOTOR_RPM * LOAD_FACTOR;
  const carriageSpeed = loadedRpm * SCREW_PITCH_MM / 60;
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

  useEffect(() => {
    motion.current.speed = carriageSpeed;
    motion.current.stroke = params.stroke;
  }, [carriageSpeed, params.stroke]);

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
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    if (!playing) motion.current.d = yPose >= 0 ? yPose : 2 * params.stroke - yPose;
    setPlaying(!playing);
  };

  const anchor: Pt = [-params.anchor_distance, 0];
  const junction: Pt = [params.junction_x, params.junction_y];
  const pivot: Pt = [params.pivot_inverted ? -params.pivot_offset : params.pivot_offset, params.closed_carriage_height];
  const pinch: Pt = [result?.pinch_x ?? pinchX(params), params.pinch_y];
  const wall = result?.wall_x ?? params.tube_center_x + params.tube_od / 2;
  const h0 = result?.pivot_height_y0 ?? params.closed_carriage_height;
  const ceiling = 2 * h0;
  const force = result ? interp(yPose, result.Y_positions, result.force_a) : 0;
  const restLines = useMemo(() => ({
    l: bezier(anchor, junction, params.l_u1, params.l_v1, params.l_u2, params.l_v2),
    r: bezier(junction, pivot, params.r_u1, params.r_v1, params.r_u2, params.r_v2),
    f: bezier(junction, pinch, params.f_u1, params.f_v1, params.f_u2, params.f_v2),
  }), [anchor[0], anchor[1], junction[0], junction[1], pivot[0], pivot[1], pinch[0], pinch[1], params]);
  const lines = useMemo(() => {
    if (!result?.lines) return restLines;
    return {
      l: deflected(result.lines.l, yPose, force),
      r: deflected(result.lines.r, yPose, force),
      f: deflected(result.lines.f, yPose, force),
    };
  }, [result, yPose, force, restLines]);

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

  const carriageY = h0 + (result?.travel_sign ?? 1) * yPose;
  const hw = params.pivot_offset + 1;
  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, yy]) => [-x, ceiling - yy]);

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0">
      <div className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-blue-500" />
          <h2 className="text-lg font-bold text-white tracking-tight">{mode === 'finder' ? 'Solver' : 'Splines'}</h2>
        </div>
        {mode === 'explorer' ? (
          <AccordionScope id="compliant:explorer">
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
          </AccordionScope>
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

      <div className="lg:col-span-5 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0 overflow-y-auto">
        <h3 className="mb-3 shrink-0 text-sm font-semibold text-neutral-300">Schematic</h3>
        <div className="mb-3 flex shrink-0 flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <label htmlFor="compliant-y" className="font-medium text-neutral-300">Carriage Y</label>
            {result != null && result.travel_sign < 0 && (
              <span className="text-[10px] text-neutral-400" title="Y is the travel that opens tube A, here and in the chart. This part pulls, so its carriage moves the other way from a part that pushes for the same Y: the motor turns the other way.">
                link pulls: carriage runs the other way
              </span>
            )}
            <span className="font-mono text-neutral-100">{yPose.toFixed(2)} mm</span>
          </div>
          <div className="order-last flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" type="button" onClick={togglePlay} disabled={carriageSpeed <= 0} aria-pressed={playing}
              title="Run the carriage back and forth over the full stroke at the loaded motor speed"
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold disabled:opacity-50 ${playing ? 'border-amber-500 bg-amber-600 text-white' : 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'}`}>
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} {playing ? 'Stop' : 'Oscillate'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => { setPlaying(false); setY(0); }} disabled={!playing && yPose === 0}
              title="Bring the carriage back to Y = 0"
              className="rounded-lg border border-neutral-700 px-3 py-1 text-xs font-bold text-neutral-200 hover:bg-neutral-700/40 disabled:opacity-50">
              Center
            </Button>
            <FlowParticlesSwitch note="Full density and speed at the flow through the full bore. The chamber is not drawn: it is taken as below the drawing, so the air runs down tube A (supply) and up tube B (exhaust)." />
            <span className="text-right text-xs text-neutral-400">
              {loadedRpm.toFixed(0)} RPM under load ({MOTOR_RPM} × {Math.round(LOAD_FACTOR * 100)} %), {carriageSpeed.toFixed(2)} mm/s
            </span>
          </div>
          <input id="compliant-y" type="range" min={-params.stroke} max={params.stroke} step={0.01} value={yPose}
            onChange={(e) => { setPlaying(false); setY(parseFloat(e.target.value)); }} className="w-full accent-amber-500 cursor-pointer" />
        </div>
        <div className="min-h-[180px] w-full flex-1 overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-900/60">
        <svg ref={svgRef} viewBox={`${-(wall + margin)} ${-ceiling - margin} ${2 * (wall + margin)} ${ceiling + 2 * margin}`}
          className="h-full w-full select-none touch-none" role="img" aria-label="Compliant bars"
          onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
          <rect x={-wall} y={-ceiling} width={2 * wall} height={ceiling} fill="var(--bui-muted)" fillOpacity={0.08} stroke="var(--bui-text)" strokeWidth={0.14} />
          {[-1, 1].map((side) => (
            <rect key={side} x={side < 0 ? -wall - 0.7 : wall} y={-ceiling - 1} width={0.7} height={ceiling + 2} fill="var(--bui-text)" fillOpacity={0.35} />
          ))}
          {(() => {
            const rPin = Math.max(params.f_thickness / 2, 0.18);
            const maxFlow = result ? Math.max(0, ...result.flow_a.map((f) => f ?? 0)) : 0;
            const footB = result
              ? mirror(deflected(result.lines.f, -yPose, interp(-yPose, result.Y_positions, result.force_a)))
              : mirror(lines.f);
            const tubeArgs = { rPin, wall, od: params.tube_od, id: params.tube_id, top: ceiling, maxFlow, sweep: tubeSweep, stale: tubeStale };
            return (
              <>
                {pinchedTube({ ...tubeArgs, sign: -1, name: 'A  supply', contact: nearestToWall(lines.f, -1), flow: result ? interp(yPose, result.Y_positions, result.flow_a) : 0 })}
                {pinchedTube({ ...tubeArgs, sign: 1, name: 'B  exhaust', contact: nearestToWall(footB, 1), flow: result ? interp(-yPose, result.Y_positions, result.flow_a) : 0 })}
              </>
            );
          })()}
          <rect x={-0.45} y={-ceiling - 0.4} width={0.9} height={ceiling + 0.8} rx={0.2} fill="#d4a94a" fillOpacity={0.85} />
          <polygon points={[[-hw, carriageY + 0.9], [-hw + 0.9, carriageY + 1.5], [hw - 0.9, carriageY + 1.5], [hw, carriageY + 0.9], [hw, carriageY - 0.9], [hw - 0.9, carriageY - 1.5], [-hw + 0.9, carriageY - 1.5], [-hw, carriageY - 0.9]].map(([px, py]) => `${px},${-py}`).join(' ')}
            fill="var(--bui-muted)" fillOpacity={0.75} stroke="var(--bui-text)" strokeWidth={0.06} />
          <line x1={-wall} y1={-h0} x2={wall} y2={-h0} stroke="#60a5fa" strokeWidth={0.04} strokeDasharray="0.2 0.2" />
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
                <polyline key={member.id} points={poly(mirror(deflected(result.lines[member.id], -yPose, interp(-yPose, result.Y_positions, result.force_a))))}
                  fill="none" stroke={member.color} strokeWidth={params[`${member.id}_thickness`]} strokeLinecap="round" />
              ))}
            </g>
          )}
          {dot(anchor, '#f59e0b', 'anchor', 'A')}
          {dot(junction, '#e5e5e5', 'junction', 'J')}
          {dot(pinch, '#34d399', 'pinch', 'P')}
        </svg>
        </div>
        {error && <p className="mt-2 shrink-0 text-xs text-red-300" role="alert">{error}</p>}
        {result && !result.passes && <p className="mt-2 shrink-0 text-xs text-amber-300">{result.message}</p>}
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
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
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
