import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Button } from '@blain-projects/ui';
import { RefreshCw, Settings, Target, UploadCloud } from 'lucide-react';
import { useTubeSweep } from './lib/tubeSweep';
import { sameDomainSettings } from './lib/chartDomain';
import { formatKpa } from './lib/pressure';
import { getProfile, stableJson, useReportProfileState } from './lib/profiles';
import type { ProfileHandle, ProfileState } from './lib/profiles';
import { Accordion, AccordionScope, ParameterSlider, apiFetch } from './components';
import type { ChartDomainSettings } from './components';
import type { SubTab } from './SubTabs';
import {
  BUILTIN_MATERIALS, COMPLIANT_DEFAULTS, CONTEXT_VAR_KEYS, LIMITS, LOAD_FACTOR,
  MEMBERS, MOTOR_RPM, SCREW_PITCH_MM, SHAPE_KEYS, SOLVER_METHOD_META, STORE, defaultQuadrantMap,
  effectivePinchY, fromCompliantProfilePayload, loadStore, mm,
} from './compliant/types';
import type {
  ChartScaleSettings, CompliantChartKey, CompliantChartSettings, CompliantParams, CompliantResult,
  ContextToggleKey, ContextVarKey, HoveredBoundTarget, Material, QuadrantConfig, QuadrantKey,
  QuadrantMap, Runner, ShapeKey, SolveExperimentSummary, SolveJobState, SolverConstraints,
  SolverGoalConfig, SolverMethodConfig,
} from './compliant/types';
import { CompliantCharts } from './compliant/CompliantCharts';
import { CompliantSchematic } from './compliant/CompliantSchematic';
import {
  ContextControls, FixedParametersSections, ResultsAccordion,
  SolveExperimentsList, SolverConstraintsContent,
  SolverRunners, SplineBoundsList,
} from './compliant/CompliantControls';
import type { MeasureState } from './compliant/CompliantControls';
import { SolverModal } from './compliant/SolverModal';
import { CompliantOnshapeModal } from './compliant/CompliantOnshapeModal';

export { COMPLIANT_DEFAULTS };
export type { CompliantParams };

interface MeasuredValue {
  key: keyof CompliantParams;
  variable: string;
  label: string;
  unit: string;
  value: number;
}

/** The import window's preview of a compliant bars profile: its main dimensions and solver constraints. */
export function CompliantProfilePreview({ payload }: { payload: Record<string, unknown> }) {
  const { params: p, constraints: c } = fromCompliantProfilePayload(payload);
  const rows: [string, string][] = [
    ['Anchor distance', mm(p.anchor_distance)],
    ['Junction', `${p.junction_x.toFixed(2)}, ${p.junction_y.toFixed(2)} mm`],
    ['Pinch height', mm(p.pinch_y)],
    ['Thickness L / R / Foot', `${p.l_thickness.toFixed(2)} / ${p.r_thickness.toFixed(2)} / ${p.f_thickness.toFixed(2)} mm`],
    ['Carriage height', mm(p.closed_carriage_height)],
    ['Pivot offset', mm(p.pivot_offset)],
    ['Pivot side', p.pivot_inverted ? 'Inverted (tube side)' : 'Normal (far side)'],
    ['Stroke', mm(p.stroke, 2)],
    ['Preload', mm(p.preload)],
    ['Depth', mm(p.member_depth)],
    ['Tube', `${p.tube_id.toFixed(2)} × ${p.tube_od.toFixed(2)} mm`],
    ['Pressure', `${formatKpa(p.input_pressure_kpa)} kPa`],
  ];
  const constraintRows: [string, string][] = [
    ['Material', `${p.member_modulus_mpa} / ${p.member_strength_mpa} MPa`],
    ['Ceiling margin', mm(c.pinch_ceiling_margin_mm)],
    ['Floor margin', mm(c.pinch_floor_margin_mm)],
    ['Shell clearance', mm(c.min_shell_clearance_mm)],
    ['Pivot clearance', mm(c.min_pivot_clearance_mm)],
    ['Max rotation', `${c.max_rotation_deg}°`],
    ['Max stress factor', `${Math.round((c.stress_limit_factor ?? 1) * 100)}% (${(p.member_strength_mpa * (c.stress_limit_factor ?? 1)).toFixed(1)} MPa)`],
    ['Motor & screw', `${p.motor_torque_mnm} mN·m · M${p.screw_diameter}×${p.lead_screw_pitch} (μ=${p.screw_friction})`],
    ['Stall-safe stress', c.motor_limited_stress !== false ? 'Yes (stall before yield)' : 'Off (infinite torque)'],
  ];
  const row = (label: string, value: string, tone = 'text-neutral-200') => (
    <div key={label} className="flex justify-between gap-4">
      <span className="text-[11px] text-neutral-400">{label}</span>
      <span className={`text-[11px] font-mono ${tone}`}>{value}</span>
    </div>
  );
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
      <div>
        <div className="text-[10px] text-neutral-500 font-bold mb-2">Dimensions</div>
        <div className="grid grid-cols-1 gap-2">{rows.map(([l, v]) => row(l, v))}</div>
      </div>
      <div>
        <div className="text-[10px] text-neutral-500 font-bold mb-2">Material & constraints</div>
        <div className="grid grid-cols-1 gap-2">{constraintRows.map(([l, v]) => row(l, v, 'text-amber-300'))}</div>
      </div>
    </div>
  );
}

export default function CompliantBars({ mode, onOpenExplorer, onProfileStateChange, profileRef }: {
  mode: SubTab;
  onOpenExplorer: () => void;
  /** The header pill's view of the loaded profile (type = 'compliant'). */
  onProfileStateChange?: (state: ProfileState) => void;
  profileRef?: Ref<ProfileHandle>;
}) {
  const [initial] = useState(loadStore);
  const [params, setParams] = useState<CompliantParams>(initial.params);
  const [bounds, setBounds] = useState(initial.bounds);
  const [quadrantMap, setQuadrantMap] = useState<QuadrantMap>(initial.quadrantMap);
  const [contextBounds, setContextBounds] = useState(initial.contextBounds);
  const [contextFixed, setContextFixed] = useState(initial.contextFixed);
  const [constraints, setConstraints] = useState<SolverConstraints>(initial.constraints);
  const [chartSettings, setChartSettings] = useState(initial.chartSettings);
  const [chartScales, setChartScales] = useState<ChartScaleSettings>(initial.chartScales);
  const [activeProfile, setActiveProfile] = useState<string | null>(initial.profile);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedChartSettings, setSavedChartSettings] = useState<CompliantChartSettings | null>(null);
  const [solverOpenSignal, setSolverOpenSignal] = useState(0);

  const [result, setResult] = useState<CompliantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [goalConfig, setGoalConfig] = useState<SolverGoalConfig>(initial.goalConfig);
  const [methodConfig, setMethodConfig] = useState<SolverMethodConfig>(initial.methodConfig);
  const [timeBudgetS, setTimeBudgetS] = useState<number>(initial.timeBudgetS);
  const [activeJob, setActiveJob] = useState<SolveJobState | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'setup' | 'live'>('setup');
  const [experiments, setExperiments] = useState<SolveExperimentSummary[]>([]);
  const [hoveredBound, setHoveredBound] = useState<HoveredBoundTarget>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [solveNote, setSolveNote] = useState<string | null>(null);

  const [materials, setMaterials] = useState<Material[]>(BUILTIN_MATERIALS);
  const [measure, setMeasure] = useState<MeasureState>({ busy: false, ok: true, text: null });
  const [onshapeOpen, setOnshapeOpen] = useState(false);

  const [y, setY] = useState(0);
  const [playing, setPlaying] = useState(false);
  const motion = useRef({ d: 0, speed: 0, stroke: COMPLIANT_DEFAULTS.stroke });
  const { drawn: tubeSweep, stale: tubeStale } = useTubeSweep(params);

  const yPose = Math.min(params.stroke, Math.max(-params.stroke, y));
  const loadedRpm = MOTOR_RPM * LOAD_FACTOR;
  const carriageSpeed = loadedRpm * (params.lead_screw_pitch || SCREW_PITCH_MM) / 60;
  const wallX = result?.wall_x && result.wall_x > 0 ? result.wall_x : params.tube_center_x + params.tube_od / 2;

  const hasFreeContext = CONTEXT_VAR_KEYS.some((k) => !contextFixed[k]) || !contextFixed.pivot_inverted;

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        params, bounds, quadrantMap, goalConfig, methodConfig, timeBudgetS,
        contextBounds, contextFixed, constraints, chartSettings, chartScales, profile: activeProfile,
      }));
    } catch { /* ignore */ }
  }, [params, bounds, quadrantMap, goalConfig, methodConfig, timeBudgetS, contextBounds, contextFixed, constraints, chartSettings, chartScales, activeProfile]);

  const snapshot = stableJson({ params, bounds, contextBounds, contextFixed, constraints });
  const chartSettingsDirty = savedChartSettings != null
    && (Object.keys(savedChartSettings) as CompliantChartKey[]).some((k) => !sameDomainSettings(chartSettings[k], savedChartSettings[k]));
  const profileDirty = activeProfile != null && ((savedSnapshot != null && savedSnapshot !== snapshot) || chartSettingsDirty);

  useReportProfileState({ name: activeProfile, dirty: profileDirty, canSave: true }, onProfileStateChange);

  useEffect(() => {
    const name = initial.profile;
    if (!name) return;
    let live = true;
    getProfile('compliant', name).then((p) => {
      if (!live) return;
      const f = fromCompliantProfilePayload(p.payload);
      setSavedSnapshot((prev) => prev ?? stableJson({
        params: f.params, bounds: f.bounds, contextBounds: f.contextBounds, contextFixed: f.contextFixed, constraints: f.constraints,
      }));
      setSavedChartSettings((prev) => prev ?? f.chartSettings);
    }).catch(() => { /* unknown: no marker */ });
    return () => { live = false; };
  }, [initial.profile]);

  useImperativeHandle(profileRef, () => ({
    type: 'compliant' as const,
    getPayload: () => ({ params, bounds, quadrantMap, contextBounds, contextFixed, constraints, chartSettings, chartScales }),
    apply: (profile) => {
      const f = fromCompliantProfilePayload(profile.payload);
      setPlaying(false);
      setParams(f.params);
      setBounds(f.bounds);
      setQuadrantMap(f.quadrantMap ?? defaultQuadrantMap(f.params, f.bounds));
      setContextBounds(f.contextBounds);
      setContextFixed(f.contextFixed);
      setConstraints(f.constraints);
      setChartSettings(f.chartSettings);
      if (f.chartScales) setChartScales(f.chartScales);
      setSavedChartSettings(f.chartSettings);
      setActiveProfile(profile.name);
      setSavedSnapshot(stableJson({
        params: f.params, bounds: f.bounds, contextBounds: f.contextBounds, contextFixed: f.contextFixed, constraints: f.constraints,
      }));
    },
    markSaved: (name, _note, payload) => {
      const f = fromCompliantProfilePayload(payload);
      setActiveProfile(name);
      setSavedSnapshot(stableJson({
        params: f.params, bounds: f.bounds, contextBounds: f.contextBounds, contextFixed: f.contextFixed, constraints: f.constraints,
      }));
      setSavedChartSettings(f.chartSettings);
    },
    detach: () => {
      setActiveProfile(null);
      setSavedSnapshot(null);
      setSavedChartSettings(null);
    },
  }));

  useEffect(() => {
    apiFetch('/api/linkage/materials')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (Array.isArray(data?.materials)) setMaterials(data.materials); })
      .catch(() => { /* keep built-in materials */ });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      apiFetch('/api/compliant/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, constraints }),
        signal: ctrl.signal,
      }).then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.lines) {
          setError(typeof data?.detail === 'string' ? data.detail : 'The shape could not be solved.');
          return;
        }
        setError(null);
        setResult(data as CompliantResult);
      }).catch((err) => {
        if (err?.name !== 'AbortError') setError('The shape could not be solved.');
      });
    }, 160);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [params, constraints]);

  const setShape = useCallback((key: ShapeKey, value: number) => {
    setParams((prev) => {
      if (key === 'pinch_y') {
        const nextFromTop = Math.max(0, Number((2 * prev.closed_carriage_height - value).toFixed(2)));
        setConstraints((c) => (c.target_pinch_from_top_mm != null ? { ...c, target_pinch_from_top_mm: nextFromTop } : c));
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const patchParams = useCallback((patch: Partial<CompliantParams>) => {
    setParams((prev) => {
      const next = { ...prev, ...patch };
      if (patch.closed_carriage_height !== undefined && constraints.target_pinch_from_top_mm != null) {
        next.pinch_y = Number((2 * patch.closed_carriage_height - constraints.target_pinch_from_top_mm).toFixed(2));
      }
      return next;
    });
  }, [constraints.target_pinch_from_top_mm]);

  const toggleContextFixed = useCallback((key: ContextToggleKey, fixed: boolean) => {
    setContextFixed((prev) => ({ ...prev, [key]: fixed }));
    if (!fixed) setSolverOpenSignal((n) => n + 1);
  }, []);

  const setContextRange = useCallback((key: ContextVarKey, next: [number, number]) => {
    setContextBounds((prev) => ({ ...prev, [key]: next }));
  }, []);

  const patchConstraints = useCallback((patch: Partial<SolverConstraints>) => {
    setConstraints((prev) => ({ ...prev, ...patch }));
    if (patch.target_pinch_from_top_mm !== undefined && patch.target_pinch_from_top_mm !== null) {
      const fromTop = patch.target_pinch_from_top_mm;
      setParams((prev) => ({
        ...prev,
        pinch_y: Number((2 * prev.closed_carriage_height - fromTop).toFixed(2)),
      }));
    }
  }, []);

  const setChartSetting = useCallback((key: CompliantChartKey, next: ChartDomainSettings) => {
    setChartSettings((prev) => ({ ...prev, [key]: next }));
  }, []);

  const patchChartScales = useCallback((patch: Partial<ChartScaleSettings>) => {
    setChartScales((prev) => ({ ...prev, ...patch }));
  }, []);

  const refreshExperiments = useCallback(() => {
    apiFetch('/api/compliant/experiments')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (Array.isArray(data?.experiments)) setExperiments(data.experiments); })
      .catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    refreshExperiments();
  }, [refreshExperiments]);

  const syncMeasured = useCallback(async (onlyKey?: keyof CompliantParams) => {
    setMeasure({ busy: true, ok: true, text: null });
    try {
      const res = await apiFetch('/api/compliant/onshape/measured', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`);
      }
      const allValues: MeasuredValue[] = Array.isArray(data?.values) ? data.values : [];
      const values = onlyKey ? allValues.filter((v) => v.key === onlyKey) : allValues;
      if (!data?.configured || values.length === 0) {
        setMeasure({ busy: false, ok: false, text: 'No measured input is set up in Onshape.' });
        return;
      }
      const patch = Object.fromEntries(values.map((v) => [v.key, Math.round(v.value * 1e4) / 1e4]));
      setParams((prev) => ({ ...prev, ...patch }));
      setMeasure({
        busy: false,
        ok: true,
        text: values.map((v) => `${v.value.toFixed(4)} ${v.unit} from #${v.variable}`).join(', '),
      });
    } catch (err) {
      setMeasure({ busy: false, ok: false, text: err instanceof Error ? err.message : 'Could not read Onshape.' });
    }
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

  // Poll active background solve job while running
  useEffect(() => {
    if (!activeJob || activeJob.status !== 'running') return;
    let alive = true;
    const id = activeJob.job_id;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/compliant/solve/jobs/${id}`);
        if (!res.ok || !alive) return;
        const data = (await res.json()) as SolveJobState;
        if (!alive) return;
        setActiveJob(data);
        if (data.status !== 'running') {
          setSolving(false);
          setRunners(data.runners ?? []);
          const s = data.summary;
          setSolveNote(data.found
            ? `Tested ${s?.tested ?? 0}. ${s?.feasible ?? 0} valid. Best ΔX₀.₂₅ ${s?.best_dx_at_025_mm?.toFixed(3) ?? '—'} mm.`
            : `Tested ${s?.tested ?? 0}. None passed. ${data.message ?? ''}`);
          if (data.found && data.params) {
            setParams((prev) => ({ ...prev, ...data.params }));
            if (data.result) setResult(data.result);
          }
          refreshExperiments();
        }
      } catch { /* retry next tick */ }
    }, 500);
    return () => { alive = false; clearInterval(interval); };
  }, [activeJob?.job_id, activeJob?.status, refreshExperiments]);

  const openSolveSetup = () => {
    setModalMode(solving ? 'live' : 'setup');
    setModalOpen(true);
  };

  const launchSolve = async (customName?: string, customNote?: string) => {
    setSolving(true);
    setSolveNote(null);
    try {
      const boundPayload: Record<string, [number, number]> = {};
      for (const key of SHAPE_KEYS) boundPayload[key] = bounds[key];
      const yGoal = effectivePinchY(params, constraints);
      if (constraints.target_pinch_from_top_mm != null) {
        boundPayload.pinch_y = [yGoal, yGoal];
      }
      for (const key of CONTEXT_VAR_KEYS) {
        boundPayload[key] = contextFixed[key] ? [params[key], params[key]] : contextBounds[key];
      }
      const pivotSide = contextFixed.pivot_inverted ? 'current' : 'both';
      const activeGoals = goalConfig.selected.length > 0 ? goalConfig.selected : ['dx_at_025' as const];
      const goalWeightsPayload: Record<string, number> = {};
      for (const g of activeGoals) {
        goalWeightsPayload[g] = goalConfig.useWeights ? Math.max(1, goalConfig.weights[g]) : 1;
      }
      const res = await apiFetch('/api/compliant/solve/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: { ...params, pinch_y: yGoal },
          bounds: boundPayload,
          constraints,
          pivot_side: pivotSide,
          goal: activeGoals[0],
          goal_weights: goalWeightsPayload,
          method: methodConfig.method,
          method_params: methodConfig.params[methodConfig.method] ?? {},
          time_budget_s: timeBudgetS,
          name: customName?.trim() || undefined,
          note: customNote?.trim() || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSolveNote(typeof data?.detail === 'string' ? data.detail : 'The solver failed to start.');
        setSolving(false);
        return;
      }
      setActiveJob(data as SolveJobState);
      setModalMode('live');
      setModalOpen(true);
    } catch {
      setSolveNote('The solver failed to start.');
      setSolving(false);
    }
  };

  const cancelSolve = async () => {
    if (!activeJob) return;
    await apiFetch(`/api/compliant/solve/jobs/${activeJob.job_id}/cancel`, { method: 'POST' }).catch(() => {});
  };

  const openExperiment = async (expId: string) => {
    try {
      const res = await apiFetch(`/api/compliant/solve/jobs/${expId}`);
      if (!res.ok) return;
      const data = (await res.json()) as SolveJobState;
      setActiveJob(data);
      setRunners(data.runners ?? []);
      setModalMode('live');
      setModalOpen(true);
    } catch { /* ignore */ }
  };

  const deleteExperiment = async (expId: string) => {
    await apiFetch(`/api/compliant/experiments/${expId}`, { method: 'DELETE' }).catch(() => {});
    refreshExperiments();
  };

  const saveExperimentMeta = async (expId: string, name: string, note: string) => {
    await apiFetch(`/api/compliant/experiments/${expId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, note }),
    });
    setActiveJob((prev) => (prev && prev.experiment_id === expId ? { ...prev, name, note } : prev));
    refreshExperiments();
  };

  const applyRunner = (runner: Runner) => {
    setParams((prev) => ({ ...prev, ...runner.params }));
    setModalOpen(false);
    onOpenExplorer();
  };

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0">
      {/* Panel 1: parameters & solver */}
      <div data-pane="controls" className="lg:col-span-3 min-w-0 bg-neutral-800 p-3 sm:p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-3 min-w-0 shrink-0">
          <Settings className="w-5 h-5 text-amber-500 shrink-0" />
          <h2 className="text-lg font-bold text-white tracking-tight truncate">
            {mode === 'finder' ? 'Solver' : 'Splines'}
          </h2>
        </div>

        <div className="shrink-0 mb-3 space-y-1">
          <Button
            variant="ghost"
            type="button"
            onClick={() => syncMeasured()}
            disabled={measure.busy}
            title="Load measured CAD values from the Onshape Part Studio (tube centre, depth)"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-600 px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${measure.busy ? 'animate-spin' : ''}`} />
            {measure.busy ? 'Loading from Onshape…' : 'Load CAD values from Onshape'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setOnshapeOpen(true)}
            title="Write this design to the Onshape variable tables (cam_sim_compliant, cam_sim_carriage, cam_sim_pinch)"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-600 px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-amber-500/60 hover:text-amber-300"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            Write to Onshape variables
          </Button>
          <CompliantOnshapeModal open={onshapeOpen} onClose={() => setOnshapeOpen(false)} params={params} constraints={constraints}
            onSyncMeasured={() => { void syncMeasured(); }} />
          {measure.text && (
            <p className={`text-[10px] leading-snug ${measure.ok ? 'text-emerald-400' : 'text-red-300'}`} role="status">
              {measure.text}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-1">
          {mode === 'explorer' ? (
            <AccordionScope id="compliant:explorer">
              <Accordion title="Skeleton" defaultOpen={true}>
                <div className="space-y-4 pt-2">
                  {(['anchor_distance', 'junction_x', 'junction_y', 'pinch_y'] as ShapeKey[]).map((key) => (
                    <ParameterSlider
                      key={key}
                      value={key === 'pinch_y' ? effectivePinchY(params, constraints) : (params[key] as number)}
                      {...LIMITS[key]}
                      onChange={(v) => setShape(key, v)}
                    />
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
                    <ParameterSlider
                      value={params[`${member.id}_thickness`] as number}
                      {...LIMITS[`${member.id}_thickness` as ShapeKey]}
                      onChange={(v) => setShape(`${member.id}_thickness` as ShapeKey, v)}
                    />
                  </div>
                </Accordion>
              ))}
              <Accordion title="Context" defaultOpen={false}>
                <ContextControls
                  params={params}
                  contextFixed={contextFixed}
                  measure={measure}
                  onPatchParams={patchParams}
                  onToggleFixed={toggleContextFixed}
                  onSyncMeasured={syncMeasured}
                />
              </Accordion>
              {hasFreeContext && (
                <Accordion title="Solver" defaultOpen={true} openSignal={solverOpenSignal}>
                  <SolverConstraintsContent
                    contextFixed={contextFixed}
                    contextBounds={contextBounds}
                    constraints={constraints}
                    memberStrengthMpa={params.member_strength_mpa}
                    onContextBoundsChange={setContextRange}
                    onConstraintsChange={patchConstraints}
                    onSolve={openSolveSetup}
                    solving={solving}
                    solveNote={solveNote}
                    showSolveButton={true}
                  />
                </Accordion>
              )}
              <FixedParametersSections
                params={params}
                wallX={wallX}
                materials={materials}
                measure={measure}
                onPatchParams={patchParams}
                onSyncMeasured={syncMeasured}
              />
              <ResultsAccordion params={params} result={result} constraints={constraints} />
            </AccordionScope>
          ) : (
            <AccordionScope id="compliant:solver">
              <div className="space-y-3">
                <p className="text-xs text-neutral-400 leading-snug">
                  Configure constraints, unlocked context, and spline bounds below, then click <strong className="text-amber-300">Solve…</strong> to choose your search method, goals, weights, and time budget.
                </p>
                <Accordion title="Solver" defaultOpen={true} openSignal={solverOpenSignal}>
                  <SolverConstraintsContent
                    contextFixed={contextFixed}
                    contextBounds={contextBounds}
                    constraints={constraints}
                    memberStrengthMpa={params.member_strength_mpa}
                    onContextBoundsChange={setContextRange}
                    onConstraintsChange={patchConstraints}
                  />
                </Accordion>
                <Accordion title="Context" defaultOpen={false}>
                  <ContextControls
                    params={params}
                    contextFixed={contextFixed}
                    measure={measure}
                    onPatchParams={patchParams}
                    onToggleFixed={toggleContextFixed}
                    onSyncMeasured={syncMeasured}
                  />
                </Accordion>
                <Accordion title="Spline bounds" defaultOpen={false}>
                  <SplineBoundsList
                    params={params}
                    bounds={bounds}
                    quadrantMap={quadrantMap}
                    constraints={constraints}
                    onPatchBounds={(patch) => setBounds((prev) => ({ ...prev, ...patch }))}
                    onQuadrantChange={(key: QuadrantKey, next: QuadrantConfig) =>
                      setQuadrantMap((prev) => ({ ...prev, [key]: next }))
                    }
                    onConstraintsChange={patchConstraints}
                    onHover={setHoveredBound}
                  />
                </Accordion>
                <FixedParametersSections
                  params={params}
                  wallX={wallX}
                  materials={materials}
                  measure={measure}
                  onPatchParams={patchParams}
                  onSyncMeasured={syncMeasured}
                />
                <div className="pt-2 space-y-2">
                  <div className="flex items-center justify-between text-[10px] text-neutral-400 px-0.5">
                    <span>Method: <strong className="text-neutral-200">{SOLVER_METHOD_META[methodConfig.method].short}</strong></span>
                    <span className="font-mono text-amber-300">
                      {timeBudgetS < 60
                        ? `${timeBudgetS}s`
                        : timeBudgetS < 3600
                          ? (timeBudgetS % 60 === 0 ? `${timeBudgetS / 60}m` : `${Math.floor(timeBudgetS / 60)}m${timeBudgetS % 60}s`)
                          : (timeBudgetS % 3600 === 0 ? `${timeBudgetS / 3600}h` : `${Math.floor(timeBudgetS / 3600)}h${Math.round((timeBudgetS % 3600) / 60)}m`)}
                      {' '}· {goalConfig.selected.length} goal{goalConfig.selected.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={openSolveSetup}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-2 text-sm font-bold text-amber-300 hover:bg-amber-500/30"
                  >
                    <Target className="w-4 h-4" /> {solving ? 'View live solve…' : 'Solve…'}
                  </Button>
                  {activeJob && !solving && (
                    <button
                      type="button"
                      onClick={() => { setModalMode('live'); setModalOpen(true); }}
                      className="w-full rounded-lg border border-neutral-600 bg-neutral-900/60 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:border-amber-500/50 hover:text-amber-200"
                    >
                      Open last solve report
                    </button>
                  )}
                  {solveNote && <p className="text-xs text-neutral-300 leading-snug">{solveNote}</p>}
                  <SolverRunners runners={runners} onApply={applyRunner} />
                </div>
                <Accordion title={`Solve history (${experiments.length})`} defaultOpen={experiments.length > 0}>
                  <SolveExperimentsList
                    experiments={experiments}
                    onOpen={openExperiment}
                    onDelete={deleteExperiment}
                  />
                </Accordion>
              </div>
            </AccordionScope>
          )}
        </div>
      </div>

      {/* Panel 2: schematic */}
      <CompliantSchematic
        params={params}
        result={result}
        constraints={constraints}
        bounds={bounds}
        quadrantMap={quadrantMap}
        hoveredBound={hoveredBound}
        yPose={yPose}
        playing={playing}
        loadedRpm={loadedRpm}
        carriageSpeed={carriageSpeed}
        tubeSweep={tubeSweep}
        tubeStale={tubeStale}
        error={error}
        onYChange={(next) => { setPlaying(false); setY(next); }}
        onTogglePlay={togglePlay}
        onCenter={() => { setPlaying(false); setY(0); }}
        onSetShape={setShape}
        onPatchParams={patchParams}
      />

      {/* Panel 3: charts */}
      <CompliantCharts
        params={params}
        result={result}
        constraints={constraints}
        yPose={yPose}
        chartSettings={chartSettings}
        chartScales={chartScales}
        onChartSettingsChange={setChartSetting}
        onChartScalesChange={patchChartScales}
      />

      <SolverModal
        open={modalOpen}
        modalMode={modalMode}
        job={activeJob}
        baseParams={params}
        constraints={constraints}
        tubeSweep={tubeSweep}
        goalConfig={goalConfig}
        methodConfig={methodConfig}
        timeBudgetS={timeBudgetS}
        spaceSummary={(() => {
          let freeCount = 0;
          let lockedCount = 0;
          for (const key of SHAPE_KEYS) {
            if (key === 'pinch_y' && constraints.target_pinch_from_top_mm != null) {
              lockedCount += 1;
            } else if (
              key === 'anchor_distance'
              && constraints.anchor_symmetric
              && Math.max(Math.abs(bounds.anchor_distance[0]), Math.abs(bounds.anchor_distance[1])) > 1e-9
            ) {
              freeCount += 1;
            } else if (Math.abs(bounds[key][1] - bounds[key][0]) > 1e-9) {
              freeCount += 1;
            } else {
              lockedCount += 1;
            }
          }
          for (const key of CONTEXT_VAR_KEYS) {
            if (!contextFixed[key] && Math.abs(contextBounds[key][1] - contextBounds[key][0]) > 1e-9) freeCount += 1;
            else lockedCount += 1;
          }
          const pivotBoth = !contextFixed.pivot_inverted;
          if (pivotBoth) freeCount += 1;
          else lockedCount += 1;
          return { freeCount, lockedCount, pivotBoth };
        })()}
        onGoalConfigChange={setGoalConfig}
        onMethodConfigChange={setMethodConfig}
        onTimeBudgetChange={setTimeBudgetS}
        onLaunch={launchSolve}
        onSwitchToSetup={() => setModalMode('setup')}
        onClose={() => setModalOpen(false)}
        onCancel={cancelSolve}
        onApplyRunner={applyRunner}
        onSaveMeta={saveExperimentMeta}
      />
    </div>
  );
}
