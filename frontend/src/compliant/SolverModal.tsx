import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, PauseCircle, Play, RotateCcw, Save, Sliders, Sparkles, X,
} from 'lucide-react';
import type { TubeSweep } from '../lib/tubeSweep';
import {
  ALL_SOLVER_METHODS, BRUTE_FORCE_CONSERVATIVE_RATE, COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS,
  SOLVER_GOAL_META, SOLVER_METHOD_META, shapeLabel,
} from './types';
import type {
  CompliantParams, CompliantResult, Runner, ShapeKey, SolveJobState, SolverConstraints,
  SolverGoal, SolverGoalConfig, SolverMethod, SolverMethodConfig,
} from './types';
import { SolverGoalBudgetControls } from './CompliantControls';
import { RunnerMiniSchematic } from './RunnerMiniSchematic';
import { SolvePreviewPanel } from './SolvePreviewPanel';

const CONSTRAINT_LABELS: Record<string, string> = {
  stress: 'Stress > material strength',
  seal_y0: 'Not sealed at Y = 0 (preload lost)',
  tube: 'Member L/R hits tube (< clearance)',
  crossing: 'Members cross each other',
  shell: 'Shell housing clearance',
  pivot: 'Carriage pivot clearance',
  pinch: 'Pinch floor / ceiling margin',
  rotation: 'Beam rotation > max°',
  junction_forbidden: 'Junction in forbidden zone',
  no_open: 'Carriage does not open tube',
  geometry: 'Invalid geometry / short chord',
};

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function varLabel(key: string): string {
  try {
    return shapeLabel(key as ShapeKey);
  } catch {
    return key.replace(/_/g, ' ');
  }
}

type RankMetricKey = SolverGoal | 'low_stress';
type RankWeights = Record<RankMetricKey, number>;

const RANK_METRICS: { key: RankMetricKey; label: string; hint: string }[] = [
  { key: 'dx_at_025', label: 'ΔX @ 0.25', hint: 'Larger horizontal pinch opening at Y = 0.25 mm' },
  { key: 'trajectory_target', label: 'Target P & α', hint: 'Closer to target pinch depth and attack angle' },
  { key: 'min_open_stroke', label: 'Min Y₉₀', hint: 'Smaller carriage stroke to reach 90% full-bore flow' },
  { key: 'flow_slope', label: 'Flow slope', hint: 'Steeper static flow slope (L/m/mm)' },
  { key: 'low_stress', label: 'Low stress', hint: 'Lower peak von Mises stress vs material limit' },
];

function initialRankWeights(job: SolveJobState | null): RankWeights {
  const base: RankWeights = {
    dx_at_025: 0,
    trajectory_target: 0,
    min_open_stroke: 0,
    flow_slope: 0,
    low_stress: 0,
  };
  if (!job) {
    base.dx_at_025 = 100;
    return base;
  }
  const gw = job.summary?.goal_weights ?? job.goal_weights;
  let assigned = false;
  if (gw) {
    for (const k of ['dx_at_025', 'trajectory_target', 'min_open_stroke', 'flow_slope'] as const) {
      const w = gw[k];
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
        base[k] = Math.max(5, Math.round(w * 20) * 5);
        assigned = true;
      }
    }
  }
  if (!assigned) {
    const g = (job.goal in base ? job.goal : 'dx_at_025') as SolverGoal;
    base[g] = 100;
  }
  return base;
}

function runnerUtility(
  r: Runner,
  metric: RankMetricKey,
  constraints: SolverConstraints,
  strengthMpa: number,
): number {
  if (metric === 'dx_at_025') {
    if (r.dx_at_025_mm == null || !Number.isFinite(r.dx_at_025_mm)) return -1;
    const openPen = 0.05 * (r.y_open_mm != null && Number.isFinite(r.y_open_mm) ? r.y_open_mm : 1.0);
    return r.dx_at_025_mm / 0.25 - openPen;
  }
  if (metric === 'flow_slope') {
    if (r.slope == null || !Number.isFinite(r.slope)) return -1;
    return r.slope / 15.0;
  }
  if (metric === 'min_open_stroke') {
    if (r.y_90_mm != null && Number.isFinite(r.y_90_mm)) {
      return 1.0 / (0.25 + Math.max(0, r.y_90_mm));
    }
    const dx = r.dx_at_025_mm != null && Number.isFinite(r.dx_at_025_mm) ? r.dx_at_025_mm : 0;
    return 0.15 * (dx / 0.25);
  }
  if (metric === 'trajectory_target') {
    let errY = 0;
    if (constraints.target_pinch_from_top_mm != null && r.pinch_ceiling_margin_mm != null) {
      errY = Math.abs(r.pinch_ceiling_margin_mm - constraints.target_pinch_from_top_mm);
    }
    let errAng = 0;
    if (r.attack_angle_deg != null && Number.isFinite(r.attack_angle_deg)) {
      errAng = Math.abs(r.attack_angle_deg - (constraints.target_attack_angle_deg ?? 0));
    }
    return 1.0 / (1.0 + errY + errAng / 15.0);
  }
  // low_stress: normalized headroom [0..1]
  if (r.max_stress_mpa != null && Number.isFinite(r.max_stress_mpa) && strengthMpa > 0) {
    return Math.max(0, 1 - r.max_stress_mpa / strengthMpa);
  }
  return 0;
}

function rankRunnerScore(
  r: Runner,
  weights: RankWeights,
  constraints: SolverConstraints,
  strengthMpa: number,
): number {
  let totalW = 0;
  let sum = 0;
  for (const m of RANK_METRICS) {
    const w = weights[m.key];
    if (w > 0) {
      totalW += w;
      sum += w * runnerUtility(r, m.key, constraints, strengthMpa);
    }
  }
  if (totalW <= 0) return r.score ?? 0;
  return sum / totalW;
}

function runnerSignature(r: Runner): string {
  const p = r.params ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : String(v ?? ''));
  return [
    n(p.anchor_distance), n(p.junction_x), n(p.junction_y), n(p.pinch_y),
    n(p.l_thickness), n(p.r_thickness), n(p.f_thickness), n(p.stroke),
    String(p.pivot_inverted ?? r.pivot_inverted ?? false),
  ].join('|');
}

/** Dynamic parameter inputs tailored to the chosen search method. */
function MethodParamsPanel({
  methodConfig,
  timeBudgetS,
  spaceSummary,
  onChange,
}: {
  methodConfig: SolverMethodConfig;
  timeBudgetS: number;
  spaceSummary: { freeCount: number; lockedCount: number; pivotBoth: boolean };
  onChange: (next: SolverMethodConfig) => void;
}) {
  const m = methodConfig.method;
  const p = methodConfig.params[m] ?? SOLVER_METHOD_META[m].defaults;
  const setParam = (key: string, val: number | string) => {
    onChange({
      ...methodConfig,
      params: {
        ...methodConfig.params,
        [m]: { ...p, [key]: val },
      },
    });
  };

  const numField = (key: string, label: string, min: number, max: number, step: number, hint?: string) => (
    <div key={key} className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className="font-mono text-amber-300">{String(p[key] ?? SOLVER_METHOD_META[m].defaults[key])}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number(p[key] ?? SOLVER_METHOD_META[m].defaults[key])}
        onChange={(e) => setParam(key, Number(e.target.value))}
        className="w-full accent-amber-500 cursor-pointer h-1.5"
      />
      {hint && <p className="text-[10px] text-neutral-500">{hint}</p>}
    </div>
  );

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">
          {SOLVER_METHOD_META[m].short} parameters
        </span>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...methodConfig,
              params: { ...methodConfig.params, [m]: { ...SOLVER_METHOD_META[m].defaults } },
            })
          }
          className="inline-flex items-center gap-1 text-[10px] text-neutral-400 hover:text-amber-300"
        >
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
      </div>

      {m === 'hybrid' && (
        <div className="space-y-3">
          {numField('lhs_batch_size', 'Global LHS samples / wave', 16, 160, 8, 'Space-filling points drawn each wave before local refinement.')}
          {numField('refine_seeds', 'Diverse basins refined / wave', 1, 8, 1, 'How many top distinct regions get SPSA gradient ascent.')}
          {numField('polish_evals', 'Nelder-Mead polish evals', 10, 120, 5, 'Simplex evaluations dedicated to sharpening the leading basin.')}
        </div>
      )}

      {m === 'brute_force' && (() => {
        const mode = String(p.sampling ?? 'lhs');
        const sidesCount = spaceSummary.pivotBoth ? 2 : 1;
        const dNumeric = Math.max(1, spaceSummary.freeCount - (spaceSummary.pivotBoth ? 1 : 0));
        const budgetEvals = Math.max(16, Math.round(timeBudgetS * BRUTE_FORCE_CONSERVATIVE_RATE));
        const perSideLhs = Math.max(8, Math.floor(budgetEvals / sidesCount));
        const kSteps = Math.max(2, Math.min(10, Number(p.steps_per_var ?? 3)));
        const gridRaw = dNumeric <= 16 ? sidesCount * Math.pow(kSteps, dNumeric) : Number.POSITIVE_INFINITY;
        const gridEstSec = Number.isFinite(gridRaw) ? gridRaw / BRUTE_FORCE_CONSERVATIVE_RATE : Number.POSITIVE_INFINITY;
        const gridFits = gridEstSec <= timeBudgetS * 1.05;
        // Highest integer k >= 2 that fits conservatively inside timeBudgetS
        const maxFittingK = Math.floor(Math.pow(budgetEvals / sidesCount, 1 / dNumeric));
        const fmtCount = (n: number) => (!Number.isFinite(n) || n > 1e9 ? '> 1B' : n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.round(n).toLocaleString());

        return (
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="block text-xs text-neutral-300">Sweep granularity mode</span>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { id: 'lhs', label: 'Calibrated LHS (Auto-fit)' },
                  { id: 'grid', label: 'Exact Cartesian Grid (kᵈ)' },
                ] as const).map((opt) => {
                  const active = mode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setParam('sampling', opt.id)}
                      className={`rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
                        active
                          ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                          : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {mode === 'lhs' ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 space-y-1 text-[11px]">
                <div className="flex items-center justify-between text-emerald-200 font-semibold">
                  <span>Planned sweep (conservative)</span>
                  <span className="font-mono">{fmtCount(perSideLhs * sidesCount)} evals</span>
                </div>
                <div className="flex items-center justify-between text-neutral-300">
                  <span>Strata per free axis ({dNumeric}D{sidesCount === 2 ? ' × 2 pivots' : ''})</span>
                  <span className="font-mono text-amber-300">{perSideLhs.toLocaleString()} slices</span>
                </div>
                <div className="flex items-center justify-between text-neutral-400">
                  <span>Upper-bound est. time (@ {BRUTE_FORCE_CONSERVATIVE_RATE} eval/s)</span>
                  <span className="font-mono text-emerald-300">≤ {fmtDuration(timeBudgetS)}</span>
                </div>
                <p className="text-[10px] text-neutral-400 pt-0.5 leading-snug">
                  Generates one single global Latin Hypercube fitted to your time budget so every axis is swept equally with zero redundant overlap.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-neutral-300">Steps per variable (k)</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-amber-300">{kSteps}</span>
                      {maxFittingK >= 2 && maxFittingK !== kSteps && (
                        <button
                          type="button"
                          onClick={() => setParam('steps_per_var', Math.min(10, maxFittingK))}
                          className="rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/25"
                        >
                          Auto-fit (k={Math.min(10, maxFittingK)})
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={10}
                    step={1}
                    value={kSteps}
                    onChange={(e) => setParam('steps_per_var', Number(e.target.value))}
                    className="w-full accent-amber-500 cursor-pointer h-1.5"
                  />
                </div>

                <div className={`rounded-lg border p-2.5 space-y-1 text-[11px] ${
                  gridFits
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : 'border-amber-500/40 bg-amber-500/10'
                }`}>
                  <div className="flex items-center justify-between font-semibold">
                    <span className={gridFits ? 'text-emerald-200' : 'text-amber-200'}>
                      Grid size ({sidesCount === 2 ? '2 × ' : ''}{kSteps}
                      <sup>{dNumeric}</sup>)
                    </span>
                    <span className="font-mono text-white">{fmtCount(gridRaw)} evals</span>
                  </div>
                  <div className="flex items-center justify-between text-neutral-300">
                    <span>Conservative est. time</span>
                    <span className={`font-mono font-bold ${gridFits ? 'text-emerald-300' : 'text-red-300'}`}>
                      {Number.isFinite(gridEstSec) ? `~${fmtDuration(gridEstSec)}` : '> 1000 h'}
                    </span>
                  </div>
                  {!gridFits && (
                    <p className="text-[10px] text-amber-200/90 pt-0.5 leading-snug">
                      Exceeds your {fmtDuration(timeBudgetS)} budget ({dNumeric} free dims).
                      {maxFittingK >= 2
                        ? ` Use Auto-fit (k=${Math.min(10, maxFittingK)}) or lock more variables.`
                        : ' Lock more variables or switch to Calibrated LHS for uniform coverage in high dimensions.'}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {m === 'evolutionary' && (
        <div className="space-y-3">
          {numField('pop_size', 'Population size', 12, 80, 4, 'Number of candidate designs evolved in parallel per generation.')}
          {numField('mutation_f', 'Differential weight (F)', 0.2, 1.2, 0.05, 'Higher F explores larger jumps between population members.')}
          {numField('crossover_cr', 'Crossover rate (CR)', 0.2, 1.0, 0.05, 'Probability of inheriting mutated coordinates.')}
        </div>
      )}

      {m === 'local_refine' && (
        <div className="space-y-3">
          {numField('search_radius', 'Local search radius (fraction)', 0.03, 0.5, 0.01, 'Fraction of each variable range explored around your current design.')}
          {numField('restarts', 'Perturbed local restarts', 1, 12, 1, 'Small Gaussian restarts around the current leader per pass.')}
        </div>
      )}
    </div>
  );
}

export function SolverModal({
  open,
  modalMode,
  job,
  baseParams = COMPLIANT_DEFAULTS,
  constraints = DEFAULT_CONSTRAINTS,
  tubeSweep = null,
  goalConfig,
  methodConfig,
  timeBudgetS,
  spaceSummary,
  onGoalConfigChange,
  onMethodConfigChange,
  onTimeBudgetChange,
  onLaunch,
  onSwitchToSetup,
  onClose,
  onCancel,
  onApplyRunner,
  onSaveMeta,
}: {
  open: boolean;
  modalMode: 'setup' | 'live';
  job: SolveJobState | null;
  baseParams?: CompliantParams;
  constraints?: SolverConstraints;
  tubeSweep?: TubeSweep | null;
  goalConfig: SolverGoalConfig;
  methodConfig: SolverMethodConfig;
  timeBudgetS: number;
  spaceSummary: { freeCount: number; lockedCount: number; pivotBoth: boolean };
  onGoalConfigChange: (next: SolverGoalConfig) => void;
  onMethodConfigChange: (next: SolverMethodConfig) => void;
  onTimeBudgetChange: (seconds: number) => void;
  onLaunch: (customName?: string, customNote?: string) => void;
  onSwitchToSetup: () => void;
  onClose: () => void;
  onCancel: () => void;
  onApplyRunner: (runner: Runner) => void;
  onSaveMeta: (expId: string, name: string, note: string) => Promise<void>;
}) {
  const [setupName, setSetupName] = useState('');
  const [setupNote, setSetupNote] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [savedFlag, setSavedFlag] = useState(false);
  const [rankWeights, setRankWeights] = useState<RankWeights>(() => initialRankWeights(job));
  const simCacheRef = useRef<Map<string, CompliantResult>>(new Map());

  useEffect(() => {
    if (job) {
      setNameInput(job.name ?? '');
      setNoteInput(job.note ?? '');
      setSavedFlag(false);
      setRankWeights(initialRankWeights(job));
      simCacheRef.current.clear();
    }
  }, [job?.experiment_id]);

  const rawRunners = job?.runners ?? [];
  const strengthLimit =
    job?.summary?.active_constraints.allowable_stress_mpa
    ?? job?.summary?.active_constraints.member_strength_mpa
    ?? (baseParams.member_strength_mpa ?? 40) * (constraints.stress_limit_factor ?? 1);
  const defaultWeights = useMemo(() => initialRankWeights(job), [job?.experiment_id, job?.goal, job?.goal_weights, job?.summary?.goal_weights]);
  const rankWeightSum = useMemo(
    () => RANK_METRICS.reduce((acc, m) => acc + Math.max(0, rankWeights[m.key]), 0),
    [rankWeights],
  );
  const weightsModified = useMemo(
    () => RANK_METRICS.some((m) => rankWeights[m.key] !== defaultWeights[m.key]),
    [rankWeights, defaultWeights],
  );
  const topRunners = useMemo(() => {
    if (rawRunners.length === 0) return [];
    const scored = rawRunners.map((r, origIdx) => ({
      runner: r,
      key: runnerSignature(r),
      rankScore: rankRunnerScore(r, rankWeights, constraints, strengthLimit),
      origIdx,
    }));
    scored.sort((a, b) => (b.rankScore - a.rankScore) || (a.origIdx - b.origIdx));
    return scored.slice(0, 4);
  }, [rawRunners, rankWeights, constraints, strengthLimit]);

  if (!open) return null;

  // ── SETUP / CONFIGURE MODE ────────────────────────────────────────────────
  if (modalMode === 'setup' || !job) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Configure Compliant Bars Solver"
      >
        <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-950/60 px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-5 h-5 text-amber-400" />
              <div>
                <h3 className="text-sm font-bold text-white">Configure Solve</h3>
                <p className="text-[11px] text-neutral-400">
                  {spaceSummary.freeCount} varied · {spaceSummary.lockedCount} locked
                  {spaceSummary.pivotBoth ? ' · Pivot: Far & Tube' : ' · Pivot: locked'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-neutral-700 p-1.5 text-neutral-400 hover:border-neutral-500 hover:text-white"
              aria-label="Close solver setup modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body: 2-column setup */}
          <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Left column: Search Method + Method-specific params */}
            <div className="space-y-4">
              <div className="space-y-2">
                <span className="block text-xs font-bold uppercase tracking-wider text-neutral-300">
                  Search method
                </span>
                <div className="space-y-1.5">
                  {ALL_SOLVER_METHODS.map((m) => {
                    const meta = SOLVER_METHOD_META[m];
                    const active = methodConfig.method === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => onMethodConfigChange({ ...methodConfig, method: m })}
                        className={`w-full text-left rounded-xl border p-3 transition ${
                          active
                            ? 'border-amber-500 bg-amber-500/15'
                            : 'border-neutral-800 bg-neutral-950/50 hover:border-neutral-600'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-xs font-bold ${active ? 'text-amber-200' : 'text-neutral-200'}`}>
                            {meta.label}
                          </span>
                          {active && (
                            <span className="rounded-full bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-300">
                              Selected
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-neutral-400">
                          {meta.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <MethodParamsPanel
                methodConfig={methodConfig}
                timeBudgetS={timeBudgetS}
                spaceSummary={spaceSummary}
                onChange={onMethodConfigChange}
              />
            </div>

            {/* Right column: Goals & Weights + Time Budget + Experiment Tag */}
            <div className="space-y-4">
              <SolverGoalBudgetControls
                goalConfig={goalConfig}
                timeBudgetS={timeBudgetS}
                onGoalConfigChange={onGoalConfigChange}
                onTimeBudgetChange={onTimeBudgetChange}
              />

              {/* Optional experiment name & note */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-3.5 space-y-2.5">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                  Experiment metadata (optional)
                </span>
                <input
                  type="text"
                  placeholder="Auto-generated name if left empty…"
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-white"
                />
                <input
                  type="text"
                  placeholder="Notes: hypothesis, constraints tested…"
                  value={setupNote}
                  onChange={(e) => setSetupNote(e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-white"
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-950/60 px-5 py-3">
            <span className="text-[11px] text-neutral-400">
              Method: <strong className="text-neutral-200">{SOLVER_METHOD_META[methodConfig.method].short}</strong> ·
              Budget: <strong className="text-amber-300 font-mono">{fmtDuration(timeBudgetS)}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onLaunch(setupName, setupNote)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500 bg-amber-500/25 px-4 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/35"
              >
                <Play className="w-3.5 h-3.5" />
                Launch Solve
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── LIVE / REPORT MODE ────────────────────────────────────────────────────
  const s = job.summary;
  const runners = job.runners ?? [];
  const running = job.status === 'running';
  const pct = Math.round((s?.progress ?? 0) * 100);
  const tested = s?.tested ?? 0;
  const feasible = s?.feasible ?? 0;
  const passRate = tested > 0 ? ((100 * feasible) / tested).toFixed(1) : '0.0';
  const topBlocker = s?.rejection_stats?.find((r) => r.count > 0) ?? null;
  const activeMethod: SolverMethod = (s?.method ?? job.method ?? 'hybrid') as SolverMethod;

  // Scatter plot bounds
  const scatterPts = s?.scatter ?? [];
  const maxDx = Math.max(0.25, ...scatterPts.map((p) => Math.abs(p.dx_025)));
  const minDx = Math.min(0, ...scatterPts.map((p) => p.dx_025));
  const dxSpan = Math.max(0.1, maxDx - minDx);
  const strength = s?.active_constraints.allowable_stress_mpa ?? s?.active_constraints.member_strength_mpa ?? 40;
  const maxStressPlot = Math.max(strength * 1.5, ...scatterPts.map((p) => p.stress));

  const handleSaveMeta = async () => {
    setSavingMeta(true);
    try {
      await onSaveMeta(job.experiment_id, nameInput, noteInput);
      setSavedFlag(true);
    } finally {
      setSavingMeta(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Compliant Bars Solver"
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-950/60 px-5 py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className={`w-5 h-5 shrink-0 ${running ? 'text-amber-400 animate-pulse' : 'text-emerald-400'}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white truncate">{job.name}</h3>
                <span className="rounded-full bg-neutral-800 border border-neutral-600 px-2 py-0.5 text-[10px] font-semibold text-neutral-200">
                  {SOLVER_METHOD_META[activeMethod]?.short ?? activeMethod}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    running
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : job.status === 'completed'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : job.status === 'cancelled'
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          : 'bg-red-500/20 text-red-300 border border-red-500/40'
                  }`}
                >
                  {job.status}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 truncate">
                Goal:{' '}
                <span className="text-neutral-200">
                  {(() => {
                    const gw = s?.goal_weights ?? job.goal_weights;
                    const entries = gw ? Object.entries(gw).filter(([, w]) => w > 0) : [];
                    if (entries.length > 1) {
                      return entries
                        .map(([k, w]) => `${Math.round(w * 100)}% ${SOLVER_GOAL_META[k as keyof typeof SOLVER_GOAL_META]?.short ?? k}`)
                        .join(' + ');
                    }
                    return SOLVER_GOAL_META[job.goal]?.label ?? job.goal;
                  })()}
                </span>
                {s ? ` · ${s.phase}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {running ? (
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/30"
              >
                <PauseCircle className="w-3.5 h-3.5" />
                Stop &amp; keep best
              </button>
            ) : (
              <button
                type="button"
                onClick={onSwitchToSetup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25"
              >
                <Sliders className="w-3.5 h-3.5" />
                New solve
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-neutral-700 p-1.5 text-neutral-400 hover:border-neutral-500 hover:text-white"
              aria-label="Close solver modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Progress bar + KPI strip */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-neutral-300">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span className="font-mono">
                  {fmtDuration(s?.elapsed_s ?? 0)} / {fmtDuration(job.time_budget_s)}
                </span>
                <span className="text-neutral-500">({pct}%)</span>
              </div>
              <div className="font-mono text-neutral-400">
                {s ? `${s.evals_per_sec.toFixed(0)} eval/s · wave ${s.wave}` : 'initializing…'}
              </div>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-950">
              <div
                className={`h-full transition-all duration-300 ${running ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 pt-1">
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">Tested</div>
                <div className="text-base font-mono font-bold text-white">{tested}</div>
              </div>
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">Valid ({passRate}%)</div>
                <div className={`text-base font-mono font-bold ${feasible > 0 ? 'text-emerald-400' : 'text-neutral-400'}`}>
                  {feasible}
                </div>
              </div>
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">Best ΔX @ 0.25</div>
                <div className="text-base font-mono font-bold text-amber-300">
                  {s?.best_dx_at_025_mm != null ? `${s.best_dx_at_025_mm.toFixed(3)} mm` : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">Best slope</div>
                <div className="text-base font-mono font-bold text-white">
                  {s?.best_slope != null ? `${s.best_slope.toFixed(2)}` : '—'}
                  <span className="text-[10px] font-normal text-neutral-400"> L/m/mm</span>
                </div>
              </div>
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">Best Y₉₀ / Stress</div>
                <div className="text-sm font-mono font-bold text-neutral-200">
                  {s?.best_y_90_mm != null ? `${s.best_y_90_mm.toFixed(2)} mm` : '—'}
                  <span className="text-neutral-500"> · </span>
                  {s?.best_stress_mpa != null ? `${s.best_stress_mpa.toFixed(0)} MPa` : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-neutral-900/80 px-3 py-2 border border-neutral-800">
                <div className="text-[10px] uppercase text-neutral-400">0→100% / Freq · BW</div>
                <div className="text-xs font-mono font-bold text-emerald-300">
                  {s?.best_chamber_t100_ms != null ? `${s.best_chamber_t100_ms.toFixed(0)} ms` : '—'}
                  {s?.best_chamber_cycle_freq_hz != null && s?.best_chamber_bandwidth_hz != null && (
                    <span className="text-neutral-300">
                      {` · ${s.best_chamber_cycle_freq_hz.toFixed(2)} / ${s.best_chamber_bandwidth_hz.toFixed(2)} Hz`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Live / Replay preview of tested configurations + GIF export */}
          <SolvePreviewPanel job={job} />

          {/* 2-column analytics: Rejection Breakdown + Design Space Scatter */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Constraint Rejection Breakdown */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-800/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-300">
                  Constraints &amp; Rejection Breakdown
                </h4>
                {topBlocker && (
                  <span className="text-[10px] font-semibold text-amber-300">
                    #1 blocker: {CONSTRAINT_LABELS[topBlocker.key] ?? topBlocker.key}
                  </span>
                )}
              </div>

              {s && (
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                    Stress ≤ {(s.active_constraints.allowable_stress_mpa ?? s.active_constraints.member_strength_mpa).toFixed(1)} MPa
                    {(s.active_constraints.stress_limit_factor ?? 1) < 0.999
                      ? ` (${Math.round((s.active_constraints.stress_limit_factor ?? 1) * 100)}% of ${s.active_constraints.member_strength_mpa})`
                      : ''}
                  </span>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                    Shell ≥ {s.active_constraints.min_shell_clearance_mm} mm
                  </span>
                  {(s.active_constraints.min_tube_clearance_mm ?? 0) > 0 && (
                    <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                      Tube L/R ≥ {s.active_constraints.min_tube_clearance_mm} mm
                    </span>
                  )}
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                    Pivot ≥ {s.active_constraints.min_pivot_clearance_mm} mm
                  </span>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                    Rot ≤ {s.active_constraints.max_rotation_deg || '∞'}°
                  </span>
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-neutral-300 border border-neutral-700">
                    Stroke {s.active_constraints.stroke_fixed ? `= ${s.active_constraints.stroke_mm} mm` : 'varied'}
                  </span>
                </div>
              )}

              <div className="space-y-2 pt-1">
                {(s?.rejection_stats ?? []).map((item) => (
                  <div key={item.key} className="space-y-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-neutral-300">{CONSTRAINT_LABELS[item.key] ?? item.key}</span>
                      <span className="font-mono text-neutral-400">
                        {item.count} ({item.pct_of_tested}%)
                        {item.sole_blocker > 0 && (
                          <span className="text-amber-400/90"> · {item.sole_blocker} sole</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-neutral-950 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          item === topBlocker ? 'bg-red-400' : 'bg-neutral-500'
                        }`}
                        style={{ width: `${Math.min(100, item.pct_of_tested)}%` }}
                      />
                    </div>
                  </div>
                ))}
                {!s && <p className="text-xs text-neutral-500">Waiting for first evaluations…</p>}
              </div>
            </div>

            {/* Design Space Map (ΔX @ 0.25 mm vs Max Stress) */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-800/40 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-300">
                  Explored Space: ΔX @ 0.25 mm vs Stress
                </h4>
                <div className="flex items-center gap-3 text-[10px] text-neutral-400">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" /> Valid
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-400/60" /> Rejected
                  </span>
                </div>
              </div>
              <svg viewBox="0 0 360 190" className="w-full h-44 rounded-lg bg-neutral-950 border border-neutral-800">
                {(() => {
                  const yLim = 165 - (Math.min(strength, maxStressPlot) / maxStressPlot) * 145;
                  return (
                    <>
                      <line x1={38} y1={yLim} x2={346} y2={yLim} stroke="#ef4444" strokeDasharray="4 3" strokeWidth={1} />
                      <text x={344} y={yLim - 3} textAnchor="end" fill="#ef4444" fontSize="9">
                        {strength} MPa limit
                      </text>
                    </>
                  );
                })()}
                <line x1={38} y1={20} x2={38} y2={165} stroke="#525252" strokeWidth={1} />
                <line x1={38} y1={165} x2={346} y2={165} stroke="#525252" strokeWidth={1} />
                <text x={192} y={184} textAnchor="middle" fill="#a3a3a3" fontSize="9">
                  ΔX @ Y = 0.25 mm ({minDx.toFixed(2)} → {maxDx.toFixed(2)} mm)
                </text>
                <text x={12} y={95} textAnchor="middle" fill="#a3a3a3" fontSize="9" transform="rotate(-90 12 95)">
                  Stress (MPa)
                </text>
                {scatterPts.map((pt, idx) => {
                  const cx = 42 + ((pt.dx_025 - minDx) / dxSpan) * 300;
                  const cy = 162 - (Math.min(pt.stress, maxStressPlot) / maxStressPlot) * 140;
                  return (
                    <circle
                      key={idx}
                      cx={cx}
                      cy={cy}
                      r={pt.feasible ? 3.2 : 2.1}
                      fill={pt.feasible ? '#34d399' : '#f87171'}
                      fillOpacity={pt.feasible ? 0.85 : 0.35}
                    />
                  );
                })}
                {s?.best_dx_at_025_mm != null && s?.best_stress_mpa != null && (
                  <circle
                    cx={42 + ((s.best_dx_at_025_mm - minDx) / dxSpan) * 300}
                    cy={162 - (Math.min(s.best_stress_mpa, maxStressPlot) / maxStressPlot) * 140}
                    r={5.5}
                    fill="#f59e0b"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                  />
                )}
              </svg>
              {s && s.bound_hits.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                  <div>
                    <span className="font-semibold">Best solution hits grid bounds: </span>
                    {s.bound_hits.map((h) => `${varLabel(h.key)} (${h.side}=${h.value})`).join(', ')}.
                    <span className="text-amber-300/80"> Widening these bounds may unlock better designs.</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Per-variable coverage & locked variables */}
          {s && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-800/40 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-300">
                  Search Grid Coverage ({s.free_vars.length} varied · {s.fixed_vars.length} locked)
                </h4>
                <span className="text-[10px] text-neutral-400">
                  Gray = tested · Green = valid · Amber dot = best
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
                {s.coverage.map((cov) => {
                  const isPivot = cov.key === 'pivot_inverted';
                  const maxBin = Math.max(1, ...cov.tested_bins);
                  const bestPct = isPivot
                    ? (cov.best_val != null ? (cov.best_val >= 0.5 ? 75 : 25) : null)
                    : (cov.best_val != null && cov.hi > cov.lo
                      ? Math.max(0, Math.min(100, ((cov.best_val - cov.lo) / (cov.hi - cov.lo)) * 100))
                      : null);
                  return (
                    <div key={cov.key} className="space-y-0.5">
                      <div className="flex justify-between text-[10px]">
                        <span className="text-neutral-300 truncate">
                          {isPivot ? 'Pivot side' : varLabel(cov.key)}
                        </span>
                        <span className="font-mono text-neutral-500">
                          {isPivot
                            ? `Far (${cov.feasible_bins[0] ?? 0}/${cov.tested_bins[0] ?? 0}) · Tube (${cov.feasible_bins[1] ?? 0}/${cov.tested_bins[1] ?? 0})`
                            : `${cov.lo}..${cov.hi}`}
                        </span>
                      </div>
                      <div className="relative flex h-3 w-full items-end gap-px rounded bg-neutral-950 p-0.5">
                        {cov.tested_bins.map((cnt, bi) => {
                          const fCnt = cov.feasible_bins[bi] ?? 0;
                          const hT = Math.round((cnt / maxBin) * 100);
                          const hF = Math.round((fCnt / maxBin) * 100);
                          return (
                            <div key={bi} className="relative flex-1 h-full flex items-end bg-neutral-900/60">
                              <div className="w-full bg-neutral-600/70" style={{ height: `${hT}%` }} />
                              {hF > 0 && (
                                <div className="absolute bottom-0 inset-x-0 bg-emerald-400/90" style={{ height: `${hF}%` }} />
                              )}
                            </div>
                          );
                        })}
                        {bestPct != null && (
                          <div
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-amber-400 ring-1 ring-white"
                            style={{ left: `${bestPct}%` }}
                            title={`Best: ${isPivot ? ((cov.best_val ?? 0) >= 0.5 ? 'Tube side' : 'Far side') : cov.best_val}`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {s.fixed_vars.length > 0 && (
                <p className="text-[10px] text-neutral-500 pt-1">
                  <span className="font-semibold text-neutral-400">Not explored (locked): </span>
                  {s.fixed_vars.map(varLabel).join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Top 4 Valid Solutions with interactive ranking weights & miniature schematics */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-800/40 p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-300">
                  Best Valid Solutions
                </h4>
                <span className="rounded-full bg-neutral-900 border border-neutral-700 px-2 py-0.5 font-mono text-[10px] text-neutral-300">
                  Top {topRunners.length}{runners.length > 4 ? ` of ${runners.length}` : ''}
                </span>
              </div>
              {runners.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-neutral-500">
                    Click a label to solo · drag sliders to blend ranking weights
                  </span>
                  {weightsModified && (
                    <button
                      type="button"
                      onClick={() => setRankWeights(defaultWeights)}
                      className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold text-neutral-300 hover:border-amber-500/60 hover:text-amber-300"
                    >
                      <RotateCcw className="w-2.5 h-2.5" /> Reset
                    </button>
                  )}
                </div>
              )}
            </div>

            {runners.length > 1 && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
                {RANK_METRICS.map((m) => {
                  const val = rankWeights[m.key];
                  const sharePct = rankWeightSum > 0 ? Math.round((val / rankWeightSum) * 100) : 0;
                  const active = val > 0;
                  return (
                    <div key={m.key} className="space-y-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={() =>
                            setRankWeights({
                              dx_at_025: 0,
                              trajectory_target: 0,
                              min_open_stroke: 0,
                              flow_slope: 0,
                              low_stress: 0,
                              [m.key]: 100,
                            })
                          }
                          title={`${m.hint}. Click to rank 100% by ${m.label}.`}
                          className={`truncate text-left font-medium transition hover:text-amber-300 ${
                            active ? 'text-neutral-100' : 'text-neutral-500'
                          }`}
                        >
                          {m.label}
                        </button>
                        <span className={`font-mono text-[10px] font-bold shrink-0 ${active ? 'text-amber-300' : 'text-neutral-600'}`}>
                          {sharePct}%
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label={`Rank weight for ${m.label}`}
                        min={0}
                        max={100}
                        step={5}
                        value={val}
                        onChange={(e) =>
                          setRankWeights((prev) => ({ ...prev, [m.key]: Number(e.target.value) }))
                        }
                        className="w-full accent-amber-500 cursor-pointer h-1.5"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {topRunners.length === 0 ? (
              <p className="text-xs text-neutral-400">
                {running
                  ? 'Searching for valid solutions…'
                  : `No valid solution passed all constraints. ${job.message}`}
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {topRunners.map(({ runner: r, key }, idx) => {
                  const isFirst = idx === 0;
                  const stressPct = r.max_stress_mpa != null && strengthLimit > 0
                    ? Math.round((r.max_stress_mpa / strengthLimit) * 100)
                    : null;
                  const pivotLabel = (r.params?.pivot_inverted ?? r.pivot_inverted) ? 'Tube' : 'Far';
                  return (
                    <div
                      key={`${key}-${idx}`}
                      data-testid={`best-solution-card-${idx + 1}`}
                      className={`flex flex-col sm:flex-row gap-3 rounded-xl border p-2.5 transition ${
                        isFirst
                          ? 'border-amber-500/50 bg-neutral-900/95'
                          : 'border-neutral-700/80 bg-neutral-900/75'
                      }`}
                    >
                      <RunnerMiniSchematic
                        runner={r}
                        runnerKey={key}
                        baseParams={baseParams}
                        constraints={constraints}
                        tubeSweep={tubeSweep}
                        resultCache={simCacheRef}
                      />

                      <div className="flex-1 min-w-0 flex flex-col justify-between gap-2">
                        {/* Card header: rank + pivot + Apply */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                                isFirst
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-neutral-800 text-neutral-300 border border-neutral-700'
                              }`}
                            >
                              #{idx + 1}
                            </span>
                            <span className="rounded bg-neutral-800/90 border border-neutral-700/80 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
                              Pivot: {pivotLabel}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => onApplyRunner(r)}
                            className="shrink-0 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-bold text-emerald-300 hover:bg-emerald-500/25"
                          >
                            Apply
                          </button>
                        </div>

                        {/* Structured 2-column metrics */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">ΔX @ 0.25</div>
                            <div className="font-mono font-bold text-amber-300">
                              {r.dx_at_025_mm != null ? `${r.dx_at_025_mm.toFixed(3)} mm` : '—'}
                            </div>
                          </div>
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">Flow slope</div>
                            <div className="font-mono font-bold text-white">
                              {r.slope != null ? `${r.slope.toFixed(2)}` : '—'}
                              <span className="text-[9px] font-normal text-neutral-500"> L/m/mm</span>
                            </div>
                          </div>
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">Open Y₉₀</div>
                            <div className="font-mono font-semibold text-neutral-200">
                              {r.y_90_mm != null ? `${r.y_90_mm.toFixed(2)} mm` : '—'}
                            </div>
                          </div>
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">Stress</div>
                            <div className="font-mono font-semibold text-neutral-200">
                              {r.max_stress_mpa != null ? `${r.max_stress_mpa.toFixed(0)} MPa` : '—'}
                              {stressPct != null && (
                                <span className="text-[9px] text-neutral-500"> ({stressPct}%)</span>
                              )}
                            </div>
                          </div>
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">Inflate 0→100%</div>
                            <div className="font-mono font-semibold text-emerald-300">
                              {r.chamber_t100_ms != null ? `${r.chamber_t100_ms.toFixed(0)} ms` : '—'}
                            </div>
                          </div>
                          <div className="rounded bg-neutral-950/70 px-2 py-1 border border-neutral-800/80">
                            <div className="text-[9px] uppercase tracking-wide text-neutral-500">Freq / BW (-3 dB)</div>
                            <div className="font-mono font-semibold text-neutral-200">
                              {r.chamber_cycle_freq_hz != null && r.chamber_bandwidth_hz != null
                                ? `${r.chamber_cycle_freq_hz.toFixed(2)} / ${r.chamber_bandwidth_hz.toFixed(2)} Hz`
                                : '—'}
                            </div>
                          </div>
                        </div>

                        {/* Compact footer stats */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                          <span>Rot {r.max_rotation_deg != null ? `${r.max_rotation_deg.toFixed(1)}°` : '—'}</span>
                          <span className="text-neutral-600">·</span>
                          <span>Stroke {r.stroke != null ? `${r.stroke.toFixed(2)}mm` : '—'}</span>
                          {r.shell_clearance_mm != null && (
                            <>
                              <span className="text-neutral-600">·</span>
                              <span>Clr {r.shell_clearance_mm.toFixed(2)}mm</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Experiment metadata save bar */}
          {!running && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3.5 flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[180px] space-y-1">
                <label className="block text-[10px] uppercase text-neutral-400">Experiment name</label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => { setNameInput(e.target.value); setSavedFlag(false); }}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-white"
                />
              </div>
              <div className="flex-[1.4] min-w-[200px] space-y-1">
                <label className="block text-[10px] uppercase text-neutral-400">Notes</label>
                <input
                  type="text"
                  placeholder="Observations, target stroke, what to try next…"
                  value={noteInput}
                  onChange={(e) => { setNoteInput(e.target.value); setSavedFlag(false); }}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-white"
                />
              </div>
              <button
                type="button"
                disabled={savingMeta}
                onClick={handleSaveMeta}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/25 disabled:opacity-40"
              >
                {savedFlag ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Save className="w-3.5 h-3.5" />}
                {savedFlag ? 'Saved' : 'Save note'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
