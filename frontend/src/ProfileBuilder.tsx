import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Label
} from 'recharts';
import { Crosshair, ArrowRight, Loader2, Maximize2, Minimize2, OctagonX, Trash2, X, ChevronDown, ChevronRight, Cog, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SimulationParams, SimulationResult } from './components';
import {
  ParameterSlider,
  StatRow,
  Accordion,
  VerticalSystemView,
  apiUrl,
  apiFetch,
  defaultParams,
  DelayedHoverHint,
  ChartDomainSettingsModal,
} from './components';
import type { ChartDomainSettings } from './components';
import {
  builderMotorSpeed,
  builderTubeId,
  builderTubeOd,
  builderPressure,
  builderCompliance,
  builderThickness,
  builderChamberVolume,
  builderGapAtY0Margin,
  builderKSteps,
  builderHeightSteps,
  builderDefaultDistMargin,
  builderAggressivity,
  builderExperienceNote,
  builderTheoreticalGapStat,
  builderAcceptableGapStat,
  builderPressurizationTargetStat,
  builderLinearSpeedStat,
  builderCandidateRankEqualization,
  builderCandidateRankFlow2080,
  builderCandidateRankFlowExp,
  builderCandidateRankFlowAtY,
  builderCandidateRankFlowYPosition,
} from './parameterTooltips';
import SearchGridAxisControls from './SearchGridAxisControls';

/** Must match backend `candidate_rank_by` strings. */
export const CANDIDATE_RANK_BY_VALUES = ['equalization_rel_time', 'flow_rise_20_80', 'flow_exp', 'flow_at_y'] as const;
export type CandidateRankBy = (typeof CANDIDATE_RANK_BY_VALUES)[number];

function parseCandidateRankBy(raw: unknown): CandidateRankBy {
  if (
    raw === 'equalization_rel_time'
    || raw === 'flow_rise_20_80'
    || raw === 'flow_exp'
    || raw === 'flow_at_y'
  ) {
    return raw;
  }
  return 'flow_rise_20_80';
}

function formatCandidateRankByLabel(v: CandidateRankBy): string {
  if (v === 'equalization_rel_time') return 'Equalization Δt (after Y=0)';
  if (v === 'flow_exp') return 'Flow vs Y (exp. k)';
  if (v === 'flow_at_y') return 'Static flow @ Y';
  return 'Flow 5%–25%';
}

/** Short phrase for help text under the aggressivity slider (matches backend sort direction). */
function rankingGuidanceShort(rankBy: CandidateRankBy, rankFlowYmm: number): string {
  switch (rankBy) {
    case 'equalization_rel_time':
      return 'equalization time after Y=0 (longest → shortest)';
    case 'flow_exp':
      return 'exponential fit k on flow vs Y (lowest → highest)';
    case 'flow_at_y':
      return `static flow at Y=${rankFlowYmm.toFixed(3)} mm (lowest → highest)`;
    default:
      return 'static flow 5%–25% rise-rate (lowest → highest)';
  }
}

const CANDIDATE_RANK_OPTIONS: { value: CandidateRankBy; label: string; hint: ReactNode }[] = [
  { value: 'equalization_rel_time', label: formatCandidateRankByLabel('equalization_rel_time'), hint: builderCandidateRankEqualization },
  { value: 'flow_rise_20_80', label: formatCandidateRankByLabel('flow_rise_20_80'), hint: builderCandidateRankFlow2080 },
  { value: 'flow_exp', label: formatCandidateRankByLabel('flow_exp'), hint: builderCandidateRankFlowExp },
  { value: 'flow_at_y', label: formatCandidateRankByLabel('flow_at_y'), hint: builderCandidateRankFlowAtY },
];

const P_ATM_PA = 101325;
/** Matches backend: chamber_pressure_kpa is absolute kPa; subtract for gauge vs atmosphere. */
const P_ATM_KPA = P_ATM_PA / 1000;
/** Same as backend AXIS_BUSHING_PLAY_MM: subtract from (theoretical × factor) for CAD default_distance. */
const AXIS_BUSHING_PLAY_MM = 0.25;

function formatDurationFromMs(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 1000) {
    return `${Math.round(safeMs)}ms`;
  }
  const totalSeconds = Math.floor(safeMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function formatClockFromMs(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getHours()}h ${d.getMinutes()}m ${d.getSeconds()}s`;
}

/** Payload sent to `/api/solve-stream` — only these inputs affect the solver (excl. chart UI, aggressivity). */
type SolveStreamRequestBody = {
  motor_speed: number;
  tube_id: number;
  tube_od: number;
  input_pressure_psi: number;
  chamber_volume_ml: number;
  compliance: number;
  thickness: number;
  gap_at_y0_margin_mm: number;
  k_min: number;
  k_max: number;
  k_sample_mode: 'count' | 'step';
  k_steps: number;
  k_step: number;
  fix_k: boolean;
  fixed_k: number;
  h_search_min: number;
  h_search_max: number;
  height_sample_mode: 'count' | 'step';
  height_steps: number;
  height_step: number;
  fix_height: boolean;
  fixed_height: number;
  deadband_min: number;
  deadband_max: number;
  deadband_sample_mode: 'count' | 'step';
  deadband_steps: number;
  deadband_step: number;
  fix_deadband: boolean;
  fixed_deadband: number;
  default_distance_safety_factor: number;
  optimize_default_distance: boolean;
  candidate_rank_by: CandidateRankBy;
  /** Cam Y (mm) for `flow_at_y` ranking (backend default 1). */
  candidate_rank_flow_y_mm: number;
};

function buildSolveStreamBody(i: {
  motorSpeed: number;
  tubeId: number;
  tubeOd: number;
  pressurePsi: number;
  chamberVolume: number;
  compliance: number;
  thickness: number;
  gapAtY0MarginMm: number;
  kMin: number;
  kMax: number;
  kSampleMode: 'count' | 'step';
  kSteps: number;
  kStep: number;
  fixK: boolean;
  fixedK: number;
  hSearchMin: number;
  hSearchMax: number;
  heightSampleMode: 'count' | 'step';
  heightSteps: number;
  heightStep: number;
  fixHeight: boolean;
  fixedHeight: number;
  deadbandSearchMin: number;
  deadbandSearchMax: number;
  deadbandSampleMode: 'count' | 'step';
  deadbandSteps: number;
  deadbandStep: number;
  fixDeadband: boolean;
  fixedDeadband: number;
  defaultDistSafetyFactor: number;
  optimizeDefaultDistance: boolean;
  candidateRankBy: CandidateRankBy;
  candidateRankFlowYmm: number;
}): SolveStreamRequestBody {
  return {
    motor_speed: i.motorSpeed,
    tube_id: i.tubeId,
    tube_od: i.tubeOd,
    input_pressure_psi: i.pressurePsi,
    chamber_volume_ml: i.chamberVolume,
    compliance: i.compliance,
    thickness: i.thickness,
    gap_at_y0_margin_mm: i.gapAtY0MarginMm,
    k_min: i.kMin,
    k_max: i.kMax,
    k_sample_mode: i.kSampleMode,
    k_steps: i.kSteps,
    k_step: i.kStep,
    fix_k: i.fixK,
    fixed_k: i.fixedK,
    h_search_min: i.hSearchMin,
    h_search_max: i.hSearchMax,
    height_sample_mode: i.heightSampleMode,
    height_steps: i.heightSteps,
    height_step: i.heightStep,
    fix_height: i.fixHeight,
    fixed_height: i.fixedHeight,
    deadband_min: i.deadbandSearchMin,
    deadband_max: i.deadbandSearchMax,
    deadband_sample_mode: i.deadbandSampleMode,
    deadband_steps: i.deadbandSteps,
    deadband_step: i.deadbandStep,
    fix_deadband: i.fixDeadband,
    fixed_deadband: i.fixedDeadband,
    default_distance_safety_factor: i.defaultDistSafetyFactor,
    optimize_default_distance: i.optimizeDefaultDistance,
    candidate_rank_by: i.candidateRankBy,
    candidate_rank_flow_y_mm: i.candidateRankFlowYmm,
  };
}

/** Rebuild solve body from saved `builder_params` (same defaults as ProfileBuilder initial state when a key is absent). */
function solveStreamBodyFromBuilderParams(p: Record<string, unknown>, complianceFallback: number): SolveStreamRequestBody {
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const bool = (k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
  const mode = (k: string, d: 'count' | 'step') => (p[k] === 'count' || p[k] === 'step' ? (p[k] as 'count' | 'step') : d);
  return buildSolveStreamBody({
    motorSpeed: num('motorSpeed', 100),
    tubeId: num('tubeId', 2),
    tubeOd: num('tubeOd', 3),
    pressurePsi: num('pressurePsi', 15),
    chamberVolume: num('chamberVolume', 50),
    compliance: num('compliance', complianceFallback),
    thickness: num('thickness', 2.5),
    gapAtY0MarginMm: num('gapAtY0MarginMm', 0.025),
    kMin: num('kMin', 0.5),
    kMax: num('kMax', 8),
    kSampleMode: mode('kSampleMode', 'step'),
    kSteps: num('kSteps', 10),
    kStep: num('kStep', 0.25),
    fixK: bool('fixK', false),
    fixedK: num('fixedK', 2),
    hSearchMin: num('hSearchMin', 0.1),
    hSearchMax: num('hSearchMax', 5),
    heightSampleMode: mode('heightSampleMode', 'step'),
    heightSteps: num('heightSteps', 20),
    heightStep: num('heightStep', 0.2),
    fixHeight: bool('fixHeight', false),
    fixedHeight: num('fixedHeight', 2),
    deadbandSearchMin: num('deadbandSearchMin', 0.1),
    deadbandSearchMax: num('deadbandSearchMax', 5),
    deadbandSampleMode: mode('deadbandSampleMode', 'step'),
    deadbandSteps: num('deadbandSteps', 10),
    deadbandStep: num('deadbandStep', 0.2),
    fixDeadband: bool('fixDeadband', false),
    fixedDeadband: num('fixedDeadband', 1.5),
    defaultDistSafetyFactor: num('defaultDistSafetyFactor', 0.9),
    optimizeDefaultDistance: bool('optimizeDefaultDistance', false),
    candidateRankBy: parseCandidateRankBy(p.candidateRankBy),
    candidateRankFlowYmm: num('candidateRankFlowYmm', 1),
  });
}

function solveRequestBodiesEqual(a: SolveStreamRequestBody, b: SolveStreamRequestBody): boolean {
  const keys = Object.keys(a) as (keyof SolveStreamRequestBody)[];
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const scale = Math.max(1, Math.abs(x), Math.abs(y));
        if (Math.abs(x - y) > 1e-9 * scale) return false;
        continue;
      }
    }
    if (x !== y) return false;
  }
  return true;
}

const SOLVE_INPUT_ROWS: { key: keyof SolveStreamRequestBody; label: string }[] = [
  { key: 'motor_speed', label: 'Motor speed (RPM)' },
  { key: 'tube_id', label: 'Tube ID (mm)' },
  { key: 'tube_od', label: 'Tube OD (mm)' },
  { key: 'input_pressure_psi', label: 'Pressure (psi)' },
  { key: 'chamber_volume_ml', label: 'Chamber volume (mL)' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'thickness', label: 'Thickness (mm)' },
  { key: 'gap_at_y0_margin_mm', label: 'Gap@Y0 margin (mm)' },
  { key: 'k_min', label: 'K search min' },
  { key: 'k_max', label: 'K search max' },
  { key: 'fix_k', label: 'Fix K' },
  { key: 'fixed_k', label: 'Fixed K' },
  { key: 'k_sample_mode', label: 'K sample mode' },
  { key: 'k_steps', label: 'K steps' },
  { key: 'k_step', label: 'K step' },
  { key: 'h_search_min', label: 'Height search min (mm)' },
  { key: 'h_search_max', label: 'Height search max (mm)' },
  { key: 'fix_height', label: 'Fix height' },
  { key: 'fixed_height', label: 'Fixed height (mm)' },
  { key: 'height_sample_mode', label: 'Height sample mode' },
  { key: 'height_steps', label: 'Height steps' },
  { key: 'height_step', label: 'Height step' },
  { key: 'deadband_min', label: 'Deadband min (mm)' },
  { key: 'deadband_max', label: 'Deadband max (mm)' },
  { key: 'fix_deadband', label: 'Fix deadband' },
  { key: 'fixed_deadband', label: 'Fixed deadband (mm)' },
  { key: 'deadband_sample_mode', label: 'Deadband sample mode' },
  { key: 'deadband_steps', label: 'Deadband steps' },
  { key: 'deadband_step', label: 'Deadband step' },
  { key: 'default_distance_safety_factor', label: 'Rest gap safety factor' },
  { key: 'optimize_default_distance', label: 'Optimize rest gap / cell' },
  { key: 'candidate_rank_by', label: 'Candidate rank by' },
  { key: 'candidate_rank_flow_y_mm', label: 'Rank flow Y (mm)' },
];

/** Restore persisted `/api/solve-stream` body from API JSON (snake_case). */
function tryParseLastSolveRequest(raw: unknown): SolveStreamRequestBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  for (const { key } of SOLVE_INPUT_ROWS) {
    const v = o[key as string];
    if (v === undefined && (key === 'candidate_rank_by' || key === 'candidate_rank_flow_y_mm')) {
      continue;
    }
    if (v === undefined) return null;
    if (key === 'candidate_rank_by') {
      if (
        v !== 'equalization_rel_time'
        && v !== 'flow_rise_20_80'
        && v !== 'flow_exp'
        && v !== 'flow_at_y'
      ) {
        return null;
      }
      continue;
    }
    if (
      key === 'optimize_default_distance' ||
      key === 'fix_k' ||
      key === 'fix_height' ||
      key === 'fix_deadband'
    ) {
      if (typeof v !== 'boolean') return null;
      continue;
    }
    if (key === 'k_sample_mode' || key === 'height_sample_mode' || key === 'deadband_sample_mode') {
      if (v !== 'count' && v !== 'step') return null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  const rank = parseCandidateRankBy(o.candidate_rank_by);
  return { ...(o as SolveStreamRequestBody), candidate_rank_by: rank };
}

function formatSolveCell(key: keyof SolveStreamRequestBody, v: SolveStreamRequestBody[keyof SolveStreamRequestBody]): string {
  if (typeof v === 'boolean') {
    if (key === 'optimize_default_distance') return v ? 'on' : 'off';
    return v ? 'yes' : 'no';
  }
  if (typeof v === 'string') {
    if (key === 'candidate_rank_by') return formatCandidateRankByLabel(v as CandidateRankBy);
    return v;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  if (key === 'candidate_rank_flow_y_mm') return v.toFixed(3);
  if (key === 'motor_speed' || key === 'k_steps' || key === 'height_steps' || key === 'deadband_steps') return String(Math.round(v));
  if (key === 'k_sample_mode' || key === 'height_sample_mode' || key === 'deadband_sample_mode') return String(v);
  return Math.abs(v) >= 50 && Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(3);
}

function SolverStaleDiffTable({ last, current }: { last: SolveStreamRequestBody; current: SolveStreamRequestBody }) {
  const differing = SOLVE_INPUT_ROWS.filter(({ key }) => {
    const a = last[key];
    const b = current[key];
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      return Math.abs(a - b) > 1e-9 * scale;
    }
    return a !== b;
  });
  return (
    <div className="max-w-[min(100vw-2rem,22rem)] space-y-2">
      <p className="text-[11px] leading-snug text-neutral-300">
        Ces réglages ne correspondent plus au dernier solve. Relancez <strong className="text-emerald-400">SOLVE</strong> pour mettre à jour les candidats et simulations.
      </p>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="border-b border-neutral-600 text-neutral-400">
            <th className="py-1 pr-2 text-left font-medium">Paramètre</th>
            <th className="px-1 py-1 text-right font-mono font-medium">Dernier solve</th>
            <th className="py-1 pl-2 text-right font-mono font-medium">Actuel</th>
          </tr>
        </thead>
        <tbody>
          {differing.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-2 text-[10px] text-amber-200/90">
                Écart détecté sans détail ligne à ligne (arrondis). Relancez SOLVE pour actualiser.
              </td>
            </tr>
          ) : (
            differing.map(({ key, label }) => (
              <tr key={key} className="border-b border-neutral-700/70">
                <td className="max-w-[9rem] py-1 pr-2 align-top text-neutral-300">{label}</td>
                <td className="px-1 py-1 text-right align-top font-mono text-amber-200/90">{formatSolveCell(key, last[key])}</td>
                <td className="py-1 pl-2 text-right align-top font-mono text-emerald-300">{formatSolveCell(key, current[key])}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Tooltip for Flow vs Y: identical to Explorer "Pneumatic Flow vs Y". */
function FlowVsYTooltipLikeExplorer() {
  return (
    <Tooltip
      contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '12px', padding: '12px 16px' }}
      separator=""
      formatter={(value: unknown, name?: unknown, props?: { payload?: { dynamicFlow?: number; gap: number; time: number } }) => {
        const nameStr = String(name ?? '');
        if (nameStr === 'Static Flow') {
          const payload = props?.payload;
          return [
            <div key="flow-tip" className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-6">
                <span className="text-amber-500 font-black text-2xl tracking-tight">{Number(value).toFixed(3)} L/min</span>
              </div>
              {payload && (
                <div className="text-base text-neutral-400 flex flex-col mt-2 border-t border-neutral-700/50 pt-2 space-y-1">
                  {payload.dynamicFlow !== undefined && (
                    <div className="flex justify-between gap-8">
                      <span className="uppercase text-[10px] items-center flex">Dynamic</span>
                      <span className="text-emerald-500 font-mono font-bold">{payload.dynamicFlow.toFixed(3)} L/min</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-8">
                    <span className="uppercase text-[10px] items-center flex">Gap</span>
                    <span className="text-blue-500 font-mono font-bold">{payload.gap.toFixed(3)} mm</span>
                  </div>
                  <div className="flex justify-between gap-8">
                    <span className="uppercase text-[10px] items-center flex">Time (rel @Y0)</span>
                    <span className="text-red-500 font-mono font-bold">{payload.time.toFixed(2)} ms</span>
                  </div>
                </div>
              )}
            </div>,
            null,
          ];
        }
        if (nameStr === 'gap' || nameStr === 'Dynamic Flow') return [null, null];
        return [String(value) as ReactNode, ''];
      }}
      labelFormatter={(label: unknown) => `Y: ${Number(label).toFixed(3)} mm`}
    />
  );
}

/** Flow vs Y series: same keys/names as Explorer pneumatic chart (hidden gap line feeds tooltip). */
function FlowVsYLinesExplorerStyle({ hasDynamicModel }: { hasDynamicModel: boolean }) {
  return (
    <>
      <Line type="monotone" dataKey="flow" name="Static Flow" stroke="#f59e0b" strokeWidth={hasDynamicModel ? 2 : 3} strokeDasharray={hasDynamicModel ? '4 2' : undefined} dot={false} isAnimationActive={false} />
      {hasDynamicModel && (
        <Line type="monotone" dataKey="dynamicFlow" name="Dynamic Flow" stroke="#10b981" strokeWidth={3} dot={false} isAnimationActive={false} />
      )}
      <Line type="monotone" dataKey="gap" name="gap" stroke="#3b82f6" strokeWidth={0} strokeOpacity={0} dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
    </>
  );
}

export interface SolverCandidate {
  height: number;
  K: number;
  deadband: number;
  default_distance: number;
  gap_at_Y0: number;
  volume_rel_error: number;
  volume_error_pct: number;
  flow_slope_l_per_mm: number;
  /** Present when solver ranked by equalization time (dynamic chamber). */
  equalization_time_rel_ms?: number;
  /** Present when solver ranked by exponential fit on static flow vs Y. */
  flow_exp_k_per_mm?: number;
  /** Present when solver ranked by static flow at fixed Y. */
  rank_flow_y_mm?: number;
  static_flow_at_rank_y_l_min?: number;
  total_volume_ml: number;
  simulation?: SimulationResult;
}

interface SolverResult {
  success: boolean;
  message: string;
  height: number;
  K: number;
  deadband: number;
  default_distance: number;
  gap_at_Y0?: number;
  theoretical_gap_mm?: number;
  simulation?: SimulationResult;
  candidates?: SolverCandidate[];
  selected_candidate_index?: number;
  solve_id?: string;
}

interface ProfileBuilderProps {
  onApplyToExplorer: (params: SimulationParams) => void;
  /** Matches Explorer tab params (including the registered default config on load). */
  explorerCompliance: number;
  guidanceEnabled?: boolean;
  onActiveExperienceNameChange?: (name: string) => void;
  /** Incrementing signal from App header to open the experience browser modal. */
  openExperienceBrowserSignal?: number;
  /** When true, header should show Save/Update (solvable result + not yet saved or params changed). */
  onDirtyStateChange?: (showSave: boolean) => void;
  /** Incrementing signal from App header to save/update current experience. */
  saveExperienceSignal?: number;
}

interface SavedExperienceEntry {
  filename: string;
  note: string;
}

interface BuilderExperiencePayload {
  filename: string;
  note: string;
  builder_params: Record<string, unknown>;
  solver_result: SolverResult;
  /** Inputs used for `solver_result` (same shape as `/api/solve-stream` body). Omitted on legacy saves. */
  last_solve_request?: unknown;
}

type BuilderMaxChart = 'flowY' | 'pressure' | 'vertical' | null;
type BuilderChartSettingsKey = 'flowY' | 'pressure' | 'vertical';
const CANDIDATE_CACHE_TTL_MS = 60_000;

const DEFAULT_BUILDER_DOMAIN: ChartDomainSettings = { autoX: true, autoY: true, xMin: -1, xMax: 1, yMin: -1, yMax: 1 };

/** Matches backend `MAX_RETURNED_CANDIDATES` — max rows in aggressivity list when more feasible triples exist. */
const MAX_RETURNED_BUILDER_CANDIDATES = 100;

function axisSampleCount(
  fix: boolean,
  sampleMode: 'count' | 'step',
  countValue: number,
  stepValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (fix) return 1;
  const lo = Math.min(minValue, maxValue);
  const hi = Math.max(minValue, maxValue);
  const span = Math.max(0, hi - lo);
  if (sampleMode === 'count') return Math.max(1, Math.round(countValue));
  const step = Math.max(1e-12, stepValue);
  return Math.max(1, Math.floor(span / step) + 1);
}

function readBuilderGridParams(p: Record<string, unknown>) {
  const bool = (key: string, def: boolean) => (typeof p[key] === 'boolean' ? p[key] as boolean : def);
  const num = (key: string, def: number) => (typeof p[key] === 'number' ? p[key] as number : def);
  const mode = (key: string): 'count' | 'step' =>
    p[key] === 'count' || p[key] === 'step' ? (p[key] as 'count' | 'step') : 'step';
  return {
    fixK: bool('fixK', false),
    kMin: num('kMin', 0.5),
    kMax: num('kMax', 8),
    kSampleMode: mode('kSampleMode'),
    kSteps: num('kSteps', 10),
    kStep: num('kStep', 0.25),
    fixedK: num('fixedK', 2),
    fixHeight: bool('fixHeight', false),
    hSearchMin: num('hSearchMin', 0.1),
    hSearchMax: num('hSearchMax', 5),
    heightSampleMode: mode('heightSampleMode'),
    heightSteps: num('heightSteps', 20),
    heightStep: num('heightStep', 0.2),
    fixedHeight: num('fixedHeight', 2),
    fixDeadband: bool('fixDeadband', false),
    deadbandSearchMin: num('deadbandSearchMin', 0.1),
    deadbandSearchMax: num('deadbandSearchMax', 5),
    deadbandSampleMode: mode('deadbandSampleMode'),
    deadbandSteps: num('deadbandSteps', 10),
    deadbandStep: num('deadbandStep', 0.2),
    fixedDeadband: num('fixedDeadband', 1.5),
    gapAtY0MarginMm: num('gapAtY0MarginMm', 0.025),
    optimizeDefaultDistance: bool('optimizeDefaultDistance', false),
    defaultDistSafetyFactor: num('defaultDistSafetyFactor', 0.9),
  };
}

function formatAxisLine(
  label: string,
  unitSuffix: string,
  fix: boolean,
  fixedVal: number,
  lo: number,
  hi: number,
  sampleMode: 'count' | 'step',
  countValue: number,
  stepValue: number,
  n: number,
): string {
  if (fix) return `${label}: fixed ${fixedVal.toFixed(3)}${unitSuffix} (1 point)`;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const range = `${a.toFixed(2)}–${b.toFixed(2)}${unitSuffix}`;
  if (sampleMode === 'count') {
    return `${label}: ${range} · count ${Math.round(countValue)} → ${n} pts`;
  }
  return `${label}: ${range} · step ${stepValue.toFixed(3)} → ${n} pts`;
}

function searchGridPreviewFromParams(p: Record<string, unknown>) {
  const g = readBuilderGridParams(p);
  const kN = axisSampleCount(g.fixK, g.kSampleMode, g.kSteps, g.kStep, g.kMin, g.kMax);
  const hN = axisSampleCount(g.fixHeight, g.heightSampleMode, g.heightSteps, g.heightStep, g.hSearchMin, g.hSearchMax);
  const dN = axisSampleCount(g.fixDeadband, g.deadbandSampleMode, g.deadbandSteps, g.deadbandStep, g.deadbandSearchMin, g.deadbandSearchMax);
  const triples = Math.max(1, kN * hN * dN);
  return {
    g,
    kN,
    hN,
    dN,
    triples,
    lines: {
      k: formatAxisLine('K', '', g.fixK, g.fixedK, g.kMin, g.kMax, g.kSampleMode, g.kSteps, g.kStep, kN),
      h: formatAxisLine('Height', ' mm', g.fixHeight, g.fixedHeight, g.hSearchMin, g.hSearchMax, g.heightSampleMode, g.heightSteps, g.heightStep, hN),
      d: formatAxisLine('Deadband', ' mm', g.fixDeadband, g.fixedDeadband, g.deadbandSearchMin, g.deadbandSearchMax, g.deadbandSampleMode, g.deadbandSteps, g.deadbandStep, dN),
    },
  };
}

export default function ProfileBuilder({
  onApplyToExplorer,
  explorerCompliance,
  guidanceEnabled = true,
  onActiveExperienceNameChange,
  openExperienceBrowserSignal,
  onDirtyStateChange,
  saveExperienceSignal,
}: ProfileBuilderProps) {
  const [maximizedChart, setMaximizedChart] = useState<BuilderMaxChart>(null);
  const [motorSpeed, setMotorSpeed] = useState(100);
  const [tubeId, setTubeId] = useState(2.0);
  const [tubeOd, setTubeOd] = useState(3.0);
  const [pressurePsi, setPressurePsi] = useState(15.0);
  const [chamberVolume, setChamberVolume] = useState(50.0);
  const [compliance, setCompliance] = useState(explorerCompliance);
  const [thickness, setThickness] = useState(2.5);
  /** 0 = gradual (low static d(flow)/dY for Y≥0), 1 = snappy; only used after solve with candidates[]. */
  const [profileAggressivity01, setProfileAggressivity01] = useState(0.5);
  /** Absolute band below theoretical: keep triples with gap@Y0 in [theoretical − margin, theoretical] (mm). */
  const [gapAtY0MarginMm, setGapAtY0MarginMm] = useState(0.025);

  const [kMin, setKMin] = useState(0.5);
  const [kMax, setKMax] = useState(8.0);
  const [fixK, setFixK] = useState(false);
  const [fixedK, setFixedK] = useState(2.0);
  const [kSampleMode, setKSampleMode] = useState<'count' | 'step'>('step');
  const [kSteps, setKSteps] = useState(10);
  const [kStep, setKStep] = useState(0.25);

  const [hSearchMin, setHSearchMin] = useState(0.1);
  const [hSearchMax, setHSearchMax] = useState(5.0);
  const [fixHeight, setFixHeight] = useState(false);
  const [fixedHeight, setFixedHeight] = useState(2.0);
  const [heightSampleMode, setHeightSampleMode] = useState<'count' | 'step'>('step');
  const [heightSteps, setHeightSteps] = useState(20);
  const [heightStep, setHeightStep] = useState(0.2);

  const [deadbandSearchMin, setDeadbandSearchMin] = useState(0.1);
  const [deadbandSearchMax, setDeadbandSearchMax] = useState(5.0);
  const [fixDeadband, setFixDeadband] = useState(false);
  const [fixedDeadband, setFixedDeadband] = useState(1.5);
  const [deadbandSampleMode, setDeadbandSampleMode] = useState<'count' | 'step'>('step');
  const [deadbandSteps, setDeadbandSteps] = useState(10);
  const [deadbandStep, setDeadbandStep] = useState(0.2);

  /** Scales theoretical opening → fixed rest gap (default_distance) when not optimizing per cell. */
  const [defaultDistSafetyFactor, setDefaultDistSafetyFactor] = useState(0.9);
  /** If true, solver searches max rest gap per (K, h, deadband) like before. If false (default), rest gap is fixed. */
  const [optimizeDefaultDistance, setOptimizeDefaultDistance] = useState(false);
  /** How feasible triples are ordered before subsampling to ≤100 candidates (must match backend `candidate_rank_by`). */
  const [candidateRankBy, setCandidateRankBy] = useState<CandidateRankBy>('flow_rise_20_80');
  /** Cam Y (mm) where static flow is read for `flow_at_y` ranking (sent to API as `candidate_rank_flow_y_mm`). */
  const [candidateRankFlowYmm, setCandidateRankFlowYmm] = useState(1.0);

  const [solving, setSolving] = useState(false);
  const [solveProgress, setSolveProgress] = useState<{
    percent: number;
    message: string;
    feasibleCount: number;
    testedCount: number;
    totalCount: number;
  } | null>(null);
  const [solveSummary, setSolveSummary] = useState<{ testedCount: number; totalDurationMs: number } | null>(null);
  /** Persisted average iteration time across solves in this session; null until first measured solve. */
  const [avgIterationMs, setAvgIterationMs] = useState<number | null>(null);
  const [timeTick, setTimeTick] = useState(0);
  const [result, setResult] = useState<SolverResult | null>(null);
  const [candidateSimByIndex, setCandidateSimByIndex] = useState<Record<number, SimulationResult>>({});
  const [displayedSim, setDisplayedSim] = useState<SimulationResult | null>(null);
  const [experienceNote, setExperienceNote] = useState('');
  const [activeExperienceName, setActiveExperienceName] = useState('Unsaved');
  const [experiences, setExperiences] = useState<SavedExperienceEntry[]>([]);
  const [showExperienceModal, setShowExperienceModal] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(true);
  const [chartSettingsTarget, setChartSettingsTarget] = useState<BuilderChartSettingsKey | null>(null);
  const [builderChartSettings, setBuilderChartSettings] = useState<Record<BuilderChartSettingsKey, ChartDomainSettings>>({
    flowY: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 25 },
    pressure: { autoX: true, autoY: true, xMin: 0, xMax: 100, yMin: 0, yMax: 300 },
    vertical: { autoX: true, autoY: true, xMin: -2, xMax: 6, yMin: -8, yMax: 8 },
  });
  const [selectedExperience, setSelectedExperience] = useState<string | null>(null);
  const [previewExperience, setPreviewExperience] = useState<BuilderExperiencePayload | null>(null);
  const [experienceQuery, setExperienceQuery] = useState('');
  const [savedExperienceSignature, setSavedExperienceSignature] = useState<string | null>(null);
  /** Inputs used for the last successful solve (or restored from a loaded experience). */
  const [lastSolveRequestBody, setLastSolveRequestBody] = useState<SolveStreamRequestBody | null>(null);
  const solveAbortRef = useRef<AbortController | null>(null);
  const solveStartedAtRef = useRef<number | null>(null);
  const solveLatestProgressRef = useRef<{ testedCount: number } | null>(null);
  const candidateCacheTimersRef = useRef<Record<number, number>>({});

  const clearCandidateCacheTimer = (idx: number) => {
    const id = candidateCacheTimersRef.current[idx];
    if (id !== undefined) {
      window.clearTimeout(id);
      delete candidateCacheTimersRef.current[idx];
    }
  };

  const touchCandidateCache = (idx: number) => {
    clearCandidateCacheTimer(idx);
    candidateCacheTimersRef.current[idx] = window.setTimeout(() => {
      setCandidateSimByIndex((prev) => {
        if (!(idx in prev)) return prev;
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      delete candidateCacheTimersRef.current[idx];
    }, CANDIDATE_CACHE_TTL_MS);
  };

  useEffect(() => {
    setCompliance(explorerCompliance);
  }, [explorerCompliance]);

  useEffect(() => {
    onActiveExperienceNameChange?.(activeExperienceName);
  }, [activeExperienceName, onActiveExperienceNameChange]);

  useEffect(() => {
    if (!openExperienceBrowserSignal) return;
    void (async () => {
      await fetchExperiences();
      setShowExperienceModal(true);
    })();
  }, [openExperienceBrowserSignal]);

  useEffect(() => {
    void fetchExperiences();
  }, []);

  useEffect(() => {
    setMaximizedChart(null);
  }, [result]);

  useEffect(() => {
    setDisplayedSim(null);
  }, [result]);

  useEffect(() => {
    return () => {
      for (const timeoutId of Object.values(candidateCacheTimersRef.current)) {
        window.clearTimeout(timeoutId);
      }
      candidateCacheTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!solving) return;
    const id = window.setInterval(() => setTimeTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [solving]);

  useEffect(() => {
    solveLatestProgressRef.current = solveProgress ? { testedCount: solveProgress.testedCount } : null;
  }, [solveProgress]);

  useEffect(() => {
    if (!solveSummary || solveSummary.testedCount <= 0) return;
    const avg = solveSummary.totalDurationMs / solveSummary.testedCount;
    if (Number.isFinite(avg) && avg > 0) {
      setAvgIterationMs(avg);
    }
  }, [solveSummary]);

  const candidateCount = result?.candidates?.length ?? 0;
  const activeIdx = useMemo(() => {
    if (candidateCount <= 1) return 0;
    return Math.min(
      candidateCount - 1,
      Math.max(0, Math.round(profileAggressivity01 * (candidateCount - 1))),
    );
  }, [candidateCount, profileAggressivity01]);

  const activeCandidate = useMemo((): SolverCandidate | null => {
    if (!result?.candidates?.length) return null;
    return result.candidates[activeIdx] ?? null;
  }, [result?.candidates, activeIdx]);

  /** Ranking axis used for the current result (persisted on last solve) or the UI selection before a solve. */
  const rankUsedForAggressivity: CandidateRankBy = lastSolveRequestBody?.candidate_rank_by ?? candidateRankBy;
  const rankFlowYUsed =
    lastSolveRequestBody?.candidate_rank_flow_y_mm ?? candidateRankFlowYmm;

  const sim = useMemo(() => {
    if (result?.candidates?.length) {
      return candidateSimByIndex[activeIdx] ?? activeCandidate?.simulation ?? null;
    }
    return result?.simulation ?? null;
  }, [result?.candidates, result?.simulation, candidateSimByIndex, activeIdx, activeCandidate]);

  const chartSim = sim ?? displayedSim;

  useEffect(() => {
    if (sim) setDisplayedSim(sim);
  }, [sim]);

  useEffect(() => {
    if (candidateSimByIndex[activeIdx]) {
      touchCandidateCache(activeIdx);
    }
  }, [activeIdx, candidateSimByIndex]);

  useEffect(() => {
    if (!result?.success || !activeCandidate) return;
    if (candidateSimByIndex[activeIdx] || activeCandidate.simulation) return;
    const ac = new AbortController();

    const loadViaSimulate = async () => {
      const req = {
        ...defaultParams,
        motor_speed: motorSpeed,
        height: activeCandidate.height,
        thickness,
        K: activeCandidate.K,
        deadband: activeCandidate.deadband,
        default_distance: activeCandidate.default_distance,
        tube_id: tubeId,
        tube_od: tubeOd,
        input_pressure_psi: pressurePsi,
        compliance,
        chamber_volume_ml: chamberVolume,
        note: '',
      };
      const res = await apiFetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      if (!res.ok) return false;
      const simulation = await res.json() as SimulationResult;
      setCandidateSimByIndex((prev) => ({ ...prev, [activeIdx]: simulation }));
      touchCandidateCache(activeIdx);
      return true;
    };

    const load = async () => {
      try {
        if (result.solve_id) {
          const res = await apiFetch(`/api/solve-candidate/${result.solve_id}/${activeIdx}`, { signal: ac.signal });
          if (res.ok) {
            const payload = await res.json() as { cached?: boolean; simulation?: SimulationResult | null };
            if (payload.cached && payload.simulation) {
              setCandidateSimByIndex((prev) => ({ ...prev, [activeIdx]: payload.simulation! }));
              touchCandidateCache(activeIdx);
              return;
            }
          }
        }
        await loadViaSimulate();
      } catch (e: unknown) {
        const aborted = (e instanceof DOMException && e.name === 'AbortError')
          || (e instanceof Error && e.name === 'AbortError');
        if (!aborted) {
          console.error('Failed to load candidate simulation:', e);
        }
      }
    };
    void load();
    return () => ac.abort();
  }, [
    result?.success,
    result?.solve_id,
    activeCandidate,
    activeIdx,
    candidateSimByIndex,
    motorSpeed,
    thickness,
    tubeId,
    tubeOd,
    pressurePsi,
    compliance,
    chamberVolume,
  ]);

  useEffect(() => {
    // Discreet prefetch for keyboard stepping around the current aggressivity index.
    if (!result?.success || !result.candidates?.length) return;
    const toPrefetch = [activeIdx - 1, activeIdx + 1].filter(
      (idx) => idx >= 0 && idx < result.candidates!.length && !candidateSimByIndex[idx],
    );
    if (toPrefetch.length === 0) return;
    const ac = new AbortController();
    const run = async () => {
      for (const idx of toPrefetch) {
        const cand = result.candidates?.[idx];
        if (!cand) continue;
        try {
          if (result.solve_id) {
            const res = await apiFetch(`/api/solve-candidate/${result.solve_id}/${idx}`, { signal: ac.signal });
            if (res.ok) {
              const payload = await res.json() as { cached?: boolean; simulation?: SimulationResult | null };
              if (payload.cached && payload.simulation) {
                setCandidateSimByIndex((prev) => ({ ...prev, [idx]: payload.simulation! }));
                touchCandidateCache(idx);
                continue;
              }
            }
          }
          const req = {
            ...defaultParams,
            motor_speed: motorSpeed,
            height: cand.height,
            thickness,
            K: cand.K,
            deadband: cand.deadband,
            default_distance: cand.default_distance,
            tube_id: tubeId,
            tube_od: tubeOd,
            input_pressure_psi: pressurePsi,
            compliance,
            chamber_volume_ml: chamberVolume,
            note: '',
          };
          const res = await apiFetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: ac.signal,
          });
          if (!res.ok) continue;
          const simulation = await res.json() as SimulationResult;
          setCandidateSimByIndex((prev) => ({ ...prev, [idx]: simulation }));
          touchCandidateCache(idx);
        } catch (e: unknown) {
          const aborted = (e instanceof DOMException && e.name === 'AbortError')
            || (e instanceof Error && e.name === 'AbortError');
          if (aborted) return;
        }
      }
    };
    void run();
    return () => ac.abort();
  }, [
    result?.success,
    result?.solve_id,
    result?.candidates,
    activeIdx,
    candidateSimByIndex,
    motorSpeed,
    thickness,
    tubeId,
    tubeOd,
    pressurePsi,
    compliance,
    chamberVolume,
  ]);

  /** Gap where inner_gap = 0 at Y=0 (no design margin) */
  const theoreticalGapMm = useMemo(() => {
    const pMpa = pressurePsi * 0.00689476;
    return tubeOd - tubeId - compliance * pMpa;
  }, [tubeOd, tubeId, compliance, pressurePsi]);

  const gapAcceptBand = useMemo(() => {
    const hi = theoreticalGapMm;
    const lo = Math.max(0, theoreticalGapMm - Math.max(0, gapAtY0MarginMm));
    return { lo, hi };
  }, [theoreticalGapMm, gapAtY0MarginMm]);

  /** Air added from atmosphere to reach line pressure (solver target internally). */
  const pressurizationDeltaMl = useMemo(() => {
    const pGaugePa = pressurePsi * 6894.76;
    return chamberVolume * (pGaugePa / P_ATM_PA);
  }, [chamberVolume, pressurePsi]);

  /** Absolute free-air equivalent in chamber at final pressure (more intuitive display). */
  const pressurizationAbsoluteMl = useMemo(() => {
    return chamberVolume + pressurizationDeltaMl;
  }, [chamberVolume, pressurizationDeltaMl]);

  const handleCancelSolve = () => {
    void apiFetch('/api/solve-cancel', { method: 'POST' });
    solveAbortRef.current?.abort();
  };

  const handleTerminateSolve = () => {
    void apiFetch('/api/solve-terminate', { method: 'POST' });
  };

  const collectBuilderParams = (): Record<string, unknown> => ({
    motorSpeed, tubeId, tubeOd, pressurePsi, chamberVolume, compliance, thickness,
    profileAggressivity01, gapAtY0MarginMm, kMin, kMax, fixK, fixedK, kSampleMode, kSteps, kStep,
    hSearchMin, hSearchMax, fixHeight, fixedHeight, heightSampleMode, heightSteps, heightStep,
    deadbandSearchMin, deadbandSearchMax, fixDeadband, fixedDeadband, deadbandSampleMode, deadbandSteps, deadbandStep,
    defaultDistSafetyFactor, optimizeDefaultDistance,
    candidateRankBy,
    candidateRankFlowYmm,
    builderChartSettings,
  });

  /** Excluded from "unsaved / Update" detection — slider is for quick comparison, not primary settings. Still saved in `collectBuilderParams()`. */
  const omitProfileAggressivityForDirtySignature = (params: Record<string, unknown>): Record<string, unknown> => {
    const { profileAggressivity01: _a, ...rest } = params;
    return rest;
  };

  const makeExperienceSignature = (note: string, builderParams: Record<string, unknown>) =>
    JSON.stringify({ note, builder_params: builderParams });

  const currentExperienceSignature = useMemo(
    () =>
      makeExperienceSignature(
        experienceNote,
        omitProfileAggressivityForDirtySignature(collectBuilderParams()),
      ),
    [
      experienceNote,
      motorSpeed, tubeId, tubeOd, pressurePsi, chamberVolume, compliance, thickness,
      gapAtY0MarginMm,
      kMin, kMax, fixK, fixedK, kSampleMode, kSteps, kStep,
      hSearchMin, hSearchMax, fixHeight, fixedHeight, heightSampleMode, heightSteps, heightStep,
      deadbandSearchMin, deadbandSearchMax, fixDeadband, fixedDeadband, deadbandSampleMode, deadbandSteps, deadbandStep,
      defaultDistSafetyFactor, optimizeDefaultDistance,
      candidateRankBy,
      candidateRankFlowYmm,
      builderChartSettings,
    ],
  );

  /** True when current params differ from last saved snapshot (excl. aggressivity in snapshot). */
  const builderHasUnsavedChanges = savedExperienceSignature !== null && currentExperienceSignature !== savedExperienceSignature;
  const canSaveExperience = !!result?.success && !!result?.candidates?.length;
  /** Show header Save/Update: solvable result + (never persisted this session yet, or params changed vs saved). */
  const showBuilderSaveExperienceButton =
    canSaveExperience && (savedExperienceSignature === null || builderHasUnsavedChanges);

  const currentSolveStreamBody = useMemo(
    () =>
      buildSolveStreamBody({
        motorSpeed,
        tubeId,
        tubeOd,
        pressurePsi,
        chamberVolume,
        compliance,
        thickness,
        gapAtY0MarginMm,
        kMin,
        kMax,
        kSampleMode,
        kSteps,
        kStep,
        fixK,
        fixedK,
        hSearchMin,
        hSearchMax,
        heightSampleMode,
        heightSteps,
        heightStep,
        fixHeight,
        fixedHeight,
        deadbandSearchMin,
        deadbandSearchMax,
        deadbandSampleMode,
        deadbandSteps,
        deadbandStep,
        fixDeadband,
        fixedDeadband,
        defaultDistSafetyFactor,
        optimizeDefaultDistance,
        candidateRankBy,
        candidateRankFlowYmm,
      }),
    [
      motorSpeed,
      tubeId,
      tubeOd,
      pressurePsi,
      chamberVolume,
      compliance,
      thickness,
      gapAtY0MarginMm,
      kMin,
      kMax,
      kSampleMode,
      kSteps,
      kStep,
      fixK,
      fixedK,
      hSearchMin,
      hSearchMax,
      heightSampleMode,
      heightSteps,
      heightStep,
      fixHeight,
      fixedHeight,
      deadbandSearchMin,
      deadbandSearchMax,
      deadbandSampleMode,
      deadbandSteps,
      deadbandStep,
      fixDeadband,
      fixedDeadband,
      defaultDistSafetyFactor,
      optimizeDefaultDistance,
      candidateRankBy,
      candidateRankFlowYmm,
    ],
  );

  const solverInputsStale = useMemo(() => {
    if (solving) return false;
    if (!result?.success || !result.candidates?.length) return false;
    if (!lastSolveRequestBody) return false;
    return !solveRequestBodiesEqual(currentSolveStreamBody, lastSolveRequestBody);
  }, [solving, result?.success, result?.candidates?.length, lastSolveRequestBody, currentSolveStreamBody]);

  const applyBuilderParams = (p: Record<string, unknown>) => {
    if (typeof p.motorSpeed === 'number') setMotorSpeed(p.motorSpeed);
    if (typeof p.tubeId === 'number') setTubeId(p.tubeId);
    if (typeof p.tubeOd === 'number') setTubeOd(p.tubeOd);
    if (typeof p.pressurePsi === 'number') setPressurePsi(p.pressurePsi);
    if (typeof p.chamberVolume === 'number') setChamberVolume(p.chamberVolume);
    if (typeof p.compliance === 'number') setCompliance(p.compliance);
    if (typeof p.thickness === 'number') setThickness(p.thickness);
    if (typeof p.profileAggressivity01 === 'number') setProfileAggressivity01(p.profileAggressivity01);
    if (typeof p.gapAtY0MarginMm === 'number') setGapAtY0MarginMm(p.gapAtY0MarginMm);
    if (typeof p.kMin === 'number') setKMin(p.kMin);
    if (typeof p.kMax === 'number') setKMax(p.kMax);
    if (typeof p.fixK === 'boolean') setFixK(p.fixK);
    if (typeof p.fixedK === 'number') setFixedK(p.fixedK);
    if (p.kSampleMode === 'count' || p.kSampleMode === 'step') setKSampleMode(p.kSampleMode);
    if (typeof p.kSteps === 'number') setKSteps(p.kSteps);
    if (typeof p.kStep === 'number') setKStep(p.kStep);
    if (typeof p.hSearchMin === 'number') setHSearchMin(p.hSearchMin);
    if (typeof p.hSearchMax === 'number') setHSearchMax(p.hSearchMax);
    if (typeof p.fixHeight === 'boolean') setFixHeight(p.fixHeight);
    if (typeof p.fixedHeight === 'number') setFixedHeight(p.fixedHeight);
    if (p.heightSampleMode === 'count' || p.heightSampleMode === 'step') setHeightSampleMode(p.heightSampleMode);
    if (typeof p.heightSteps === 'number') setHeightSteps(p.heightSteps);
    if (typeof p.heightStep === 'number') setHeightStep(p.heightStep);
    if (typeof p.deadbandSearchMin === 'number') setDeadbandSearchMin(p.deadbandSearchMin);
    if (typeof p.deadbandSearchMax === 'number') setDeadbandSearchMax(p.deadbandSearchMax);
    if (typeof p.fixDeadband === 'boolean') setFixDeadband(p.fixDeadband);
    if (typeof p.fixedDeadband === 'number') setFixedDeadband(p.fixedDeadband);
    if (p.deadbandSampleMode === 'count' || p.deadbandSampleMode === 'step') setDeadbandSampleMode(p.deadbandSampleMode);
    if (typeof p.deadbandSteps === 'number') setDeadbandSteps(p.deadbandSteps);
    if (typeof p.deadbandStep === 'number') setDeadbandStep(p.deadbandStep);
    if (typeof p.defaultDistSafetyFactor === 'number') setDefaultDistSafetyFactor(p.defaultDistSafetyFactor);
    if (typeof p.optimizeDefaultDistance === 'boolean') setOptimizeDefaultDistance(p.optimizeDefaultDistance);
    setCandidateRankBy(parseCandidateRankBy(p.candidateRankBy));
    if (typeof p.candidateRankFlowYmm === 'number') setCandidateRankFlowYmm(p.candidateRankFlowYmm);
    if (p.builderChartSettings && typeof p.builderChartSettings === 'object') {
      const s = p.builderChartSettings as Partial<Record<BuilderChartSettingsKey, Partial<ChartDomainSettings>>>;
      setBuilderChartSettings((prev) => ({
        flowY: { ...prev.flowY, ...(s.flowY ?? {}) },
        pressure: { ...prev.pressure, ...(s.pressure ?? {}) },
        vertical: { ...prev.vertical, ...(s.vertical ?? {}) },
      }));
    }
  };

  const fetchExperiences = async () => {
    const res = await apiFetch('/api/builder-experiences');
    const data = await res.json();
    const list = Array.isArray(data.experiences) ? data.experiences : [];
    setExperiences(list.map((e: SavedExperienceEntry) => ({ filename: e.filename, note: e.note ?? '' })));
  };

  const handleSaveExperience = async () => {
    if (!result?.success || !result.candidates?.length) return;
    const canUpdateCurrent = builderHasUnsavedChanges && activeExperienceName !== 'Unsaved';
    const endpoint = canUpdateCurrent
      ? apiUrl(`/api/builder-experiences/${activeExperienceName}`)
      : apiUrl('/api/builder-experiences');
    const res = await fetch(endpoint, { credentials: "include",
      method: canUpdateCurrent ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: experienceNote,
        builder_params: collectBuilderParams(),
        solver_result: result,
        last_solve_request: lastSolveRequestBody ?? undefined,
      }),
    });
    const data = await res.json();
    setActiveExperienceName(data.filename ?? activeExperienceName ?? 'Saved');
    setSavedExperienceSignature(currentExperienceSignature);
    await fetchExperiences();
  };

  useEffect(() => {
    onDirtyStateChange?.(showBuilderSaveExperienceButton);
  }, [showBuilderSaveExperienceButton, onDirtyStateChange]);

  useEffect(() => {
    if (!saveExperienceSignal) return;
    if (!canSaveExperience) return;
    void handleSaveExperience();
  }, [saveExperienceSignal, canSaveExperience]);

  const loadExperiencePreview = async (name: string) => {
    const res = await apiFetch(`/api/builder-experiences/${name}`);
    if (!res.ok) return;
    const payload = await res.json() as BuilderExperiencePayload;
    setPreviewExperience(payload);
  };

  const applyExperience = async () => {
    if (!selectedExperience) return;
    const res = await apiFetch(`/api/builder-experiences/${selectedExperience}`);
    if (!res.ok) return;
    const payload = await res.json() as BuilderExperiencePayload;
    applyBuilderParams(payload.builder_params);
    setResult(payload.solver_result);
    const loadedCandidates = payload.solver_result.candidates ?? [];
    const loadedAgg =
      typeof payload.builder_params.profileAggressivity01 === 'number'
        ? payload.builder_params.profileAggressivity01
        : 0.5;
    const loadedIdx = loadedCandidates.length <= 1
      ? 0
      : Math.min(
        loadedCandidates.length - 1,
        Math.max(0, Math.round(loadedAgg * (loadedCandidates.length - 1))),
      );
    const initial: Record<number, SimulationResult> = {};
    if (payload.solver_result.simulation) {
      initial[loadedIdx] = payload.solver_result.simulation;
      touchCandidateCache(loadedIdx);
    }
    for (const idx of Object.keys(candidateCacheTimersRef.current)) {
      clearCandidateCacheTimer(Number(idx));
    }
    setCandidateSimByIndex(initial);
    setExperienceNote(payload.note ?? '');
    setActiveExperienceName(payload.filename);
    setLastSolveRequestBody(
      tryParseLastSolveRequest(payload.last_solve_request) ??
        solveStreamBodyFromBuilderParams((payload.builder_params ?? {}) as Record<string, unknown>, explorerCompliance),
    );
    setSavedExperienceSignature(
      makeExperienceSignature(
        payload.note ?? '',
        omitProfileAggressivityForDirtySignature((payload.builder_params ?? {}) as Record<string, unknown>),
      ),
    );
    setShowExperienceModal(false);
  };

  const deleteExperience = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete experience ${name}?`)) return;
    await apiFetch(`/api/builder-experiences/${name}`, { method: 'DELETE' });
    if (selectedExperience === name) {
      setSelectedExperience(null);
      setPreviewExperience(null);
    }
    await fetchExperiences();
  };

  const filteredExperiences = useMemo(() => {
    const q = experienceQuery.trim().toLowerCase();
    if (!q) return experiences;
    return experiences.filter((exp) => {
      const name = exp.filename.toLowerCase();
      const note = (exp.note || '').toLowerCase();
      return name.includes(q) || note.includes(q);
    });
  }, [experiences, experienceQuery]);

  const handleSolve = async () => {
    solveAbortRef.current?.abort();
    const ac = new AbortController();
    solveAbortRef.current = ac;
    setSolving(true);
    setResult(null);
    for (const idx of Object.keys(candidateCacheTimersRef.current)) {
      clearCandidateCacheTimer(Number(idx));
    }
    setCandidateSimByIndex({});
    setActiveExperienceName('Unsaved');
    setSavedExperienceSignature(null);
    setSolveSummary(null);
    solveStartedAtRef.current = Date.now();
    solveLatestProgressRef.current = { testedCount: 0 };
    setSolveProgress({ percent: 0, message: 'Starting…', feasibleCount: 0, testedCount: 0, totalCount: 0 });
    const solveRequestSnapshot = buildSolveStreamBody({
      motorSpeed,
      tubeId,
      tubeOd,
      pressurePsi,
      chamberVolume,
      compliance,
      thickness,
      gapAtY0MarginMm,
      kMin,
      kMax,
      kSampleMode,
      kSteps,
      kStep,
      fixK,
      fixedK,
      hSearchMin,
      hSearchMax,
      heightSampleMode,
      heightSteps,
      heightStep,
      fixHeight,
      fixedHeight,
      deadbandSearchMin,
      deadbandSearchMax,
      deadbandSampleMode,
      deadbandSteps,
      deadbandStep,
      fixDeadband,
      fixedDeadband,
      defaultDistSafetyFactor,
      optimizeDefaultDistance,
      candidateRankBy,
      candidateRankFlowYmm,
    });
    const body = JSON.stringify(solveRequestSnapshot);
    try {
      const res = await apiFetch('/api/solve-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        setResult({
          success: false,
          message: `Solve failed (${res.status}): ${t || res.statusText}`,
          height: 0, K: 0, deadband: 0, default_distance: 0,
          gap_at_Y0: 0, theoretical_gap_mm: 0,
        });
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setResult({
          success: false, message: 'No response body from solver', height: 0, K: 0, deadband: 0, default_distance: 0,
          gap_at_Y0: 0, theoretical_gap_mm: 0,
        });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      /** Avoid RESULT_CODE_HUNG: backend can emit progress faster than React can paint. */
      const PROGRESS_UI_MIN_MS = 140;
      let lastProgressPaintAt = 0;
      let progressUiTimer: ReturnType<typeof setTimeout> | null = null;
      let latestProgressSnap: {
        percent: number;
        message: string;
        feasibleCount: number;
        testedCount: number;
        totalCount: number;
      } | null = null;
      const clearProgressUiTimer = () => {
        if (progressUiTimer !== null) {
          window.clearTimeout(progressUiTimer);
          progressUiTimer = null;
        }
      };
      const scheduleTrailingProgressPaint = () => {
        if (progressUiTimer !== null) return;
        progressUiTimer = window.setTimeout(() => {
          progressUiTimer = null;
          if (latestProgressSnap === null) return;
          lastProgressPaintAt = Date.now();
          setSolveProgress({ ...latestProgressSnap });
        }, PROGRESS_UI_MIN_MS);
      };
      const endSolveUi = () => {
        clearProgressUiTimer();
        setSolving(false);
        setSolveProgress(null);
      };
      const handleStreamLine = (obj: {
        type: string;
        percent?: number;
        message?: string;
        feasible_count?: number;
        tested_count?: number;
        total_count?: number;
        payload?: SolverResult;
      }) => {
        if (obj.type === 'progress') {
          const snap = {
            percent: Math.min(100, Math.max(0, obj.percent ?? 0)),
            message: obj.message ?? '',
            feasibleCount: typeof obj.feasible_count === 'number' ? obj.feasible_count : (latestProgressSnap?.feasibleCount ?? 0),
            testedCount: typeof obj.tested_count === 'number' ? obj.tested_count : (latestProgressSnap?.testedCount ?? 0),
            totalCount: typeof obj.total_count === 'number' ? obj.total_count : (latestProgressSnap?.totalCount ?? 0),
          };
          latestProgressSnap = snap;
          solveLatestProgressRef.current = { testedCount: snap.testedCount };
          const now = Date.now();
          if (now - lastProgressPaintAt >= PROGRESS_UI_MIN_MS) {
            lastProgressPaintAt = now;
            clearProgressUiTimer();
            setSolveProgress({ ...snap });
          } else {
            scheduleTrailingProgressPaint();
          }
        } else if (obj.type === 'result' && obj.payload) {
          clearProgressUiTimer();
          const p = obj.payload as SolverResult;
          setResult(p);
          setCandidateSimByIndex(() => {
            const initial: Record<number, SimulationResult> = {};
            if (p.simulation) {
              const sel = p.selected_candidate_index ?? 0;
              initial[sel] = p.simulation;
              touchCandidateCache(sel);
            }
            return initial;
          });
          const startedAt = solveStartedAtRef.current;
          setSolveSummary({
            testedCount: solveLatestProgressRef.current?.testedCount ?? 0,
            totalDurationMs: startedAt ? Date.now() - startedAt : 0,
          });
          if (p.success && p.candidates && p.candidates.length > 0) {
            setLastSolveRequestBody(solveRequestSnapshot);
            const n = p.candidates.length;
            const sel = Math.min(n - 1, Math.max(0, p.selected_candidate_index ?? Math.floor(n / 2)));
            setProfileAggressivity01(n <= 1 ? 0.5 : sel / (n - 1));
          }
          endSolveUi();
        } else if (obj.type === 'error') {
          clearProgressUiTimer();
          setResult({
            success: false,
            message: obj.message ?? 'Solver error',
            height: 0, K: 0, deadband: 0, default_distance: 0,
            gap_at_Y0: 0, theoretical_gap_mm: 0,
          });
          endSolveUi();
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        let parsedInChunk = 0;
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: {
            type: string;
            percent?: number;
            message?: string;
            feasible_count?: number;
            tested_count?: number;
            total_count?: number;
            payload?: SolverResult;
          };
          try {
            obj = JSON.parse(line) as typeof obj;
          } catch {
            continue;
          }
          handleStreamLine(obj);
          parsedInChunk += 1;
          if (parsedInChunk % 64 === 0) {
            await new Promise<void>((r) => {
              window.setTimeout(r, 0);
            });
          }
        }
      }
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer) as {
            type: string;
            percent?: number;
            message?: string;
            feasible_count?: number;
            tested_count?: number;
            total_count?: number;
            payload?: SolverResult;
          };
          handleStreamLine(obj);
        } catch {
          /* ignore trailing garbage */
        }
      }
    } catch (e: unknown) {
      const aborted =
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError');
      if (aborted) {
        setResult({
          success: false,
          message: 'Solve cancelled.',
          height: 0, K: 0, deadband: 0, default_distance: 0,
          gap_at_Y0: 0, theoretical_gap_mm: 0,
        });
      } else {
        setResult({
          success: false, message: `Network error: ${e}`, height: 0, K: 0, deadband: 0, default_distance: 0,
          gap_at_Y0: 0, theoretical_gap_mm: 0,
        });
      }
    } finally {
      const startedAt = solveStartedAtRef.current;
      if (startedAt && !solveSummary) {
        setSolveSummary({
          testedCount: solveLatestProgressRef.current?.testedCount ?? 0,
          totalDurationMs: Date.now() - startedAt,
        });
      }
      setSolving(false);
      setSolveProgress(null);
      solveAbortRef.current = null;
      solveStartedAtRef.current = null;
    }
  };

  const solveTiming = useMemo(() => {
    if (!solving || !solveProgress) return null;
    void timeTick;
    const startedAt = solveStartedAtRef.current;
    if (!startedAt) return null;
    const elapsedMs = Date.now() - startedAt;
    const tested = Math.max(0, solveProgress.testedCount);
    const total = Math.max(0, solveProgress.totalCount);
    const avgMs = tested > 0 ? elapsedMs / tested : 0;
    const remainingCount = Math.max(0, total - tested);
    const remainingMs = tested > 0 ? remainingCount * avgMs : 0;
    const etaMs = Date.now() + remainingMs;
    return { elapsedMs, avgMs, remainingMs, etaMs, tested, total };
  }, [solving, solveProgress, timeTick]);

  /**
   * Backend maps grid phase to pct ≈ 5 + int(83 * done / total) — staircase + not time-based.
   * Use a float from tested/total for the bar so it moves smoothly; keep raw % for phase ≥ 89.
   */
  const solveProgressDisplay = useMemo(() => {
    if (!solveProgress) return { barPct: 0, text: '0', inGridPhase: false };
    const { percent, testedCount, totalCount } = solveProgress;
    if (percent >= 89) {
      return { barPct: percent, text: String(Math.round(percent)), inGridPhase: false };
    }
    if (totalCount > 0 && percent >= 5 && percent <= 88) {
      const smooth = Math.min(88, 5 + (83 * testedCount) / totalCount);
      return { barPct: smooth, text: smooth.toFixed(1), inGridPhase: true };
    }
    return { barPct: percent, text: String(Math.round(percent)), inGridPhase: false };
  }, [solveProgress]);

  /** Estimated combinations from current grid/fix settings (same count/step logic as axis controls). */
  const estimatedCombinationCount = useMemo(() => {
    const axisCount = (
      fix: boolean,
      sampleMode: 'count' | 'step',
      countValue: number,
      stepValue: number,
      minValue: number,
      maxValue: number,
    ) => {
      if (fix) return 1;
      const lo = Math.min(minValue, maxValue);
      const hi = Math.max(minValue, maxValue);
      const span = Math.max(0, hi - lo);
      if (sampleMode === 'count') return Math.max(1, Math.round(countValue));
      const step = Math.max(1e-12, stepValue);
      return Math.max(1, Math.floor(span / step) + 1);
    };

    const kN = axisCount(fixK, kSampleMode, kSteps, kStep, kMin, kMax);
    const hN = axisCount(fixHeight, heightSampleMode, heightSteps, heightStep, hSearchMin, hSearchMax);
    const dN = axisCount(fixDeadband, deadbandSampleMode, deadbandSteps, deadbandStep, deadbandSearchMin, deadbandSearchMax);
    return kN * hN * dN;
  }, [
    fixK, kSampleMode, kSteps, kStep, kMin, kMax,
    fixHeight, heightSampleMode, heightSteps, heightStep, hSearchMin, hSearchMax,
    fixDeadband, deadbandSampleMode, deadbandSteps, deadbandStep, deadbandSearchMin, deadbandSearchMax,
  ]);

  /** Always show combos; append ETA only after avgIterationMs is known. */
  const solveButtonHint = useMemo(() => {
    const combosTxt = `~${estimatedCombinationCount} combos`;
    if (!avgIterationMs || avgIterationMs <= 0) return combosTxt;
    const estMs = estimatedCombinationCount * avgIterationMs;
    return `${combosTxt} · ~${formatDurationFromMs(estMs)}`;
  }, [estimatedCombinationCount, avgIterationMs]);

  const handleApply = () => {
    if (!result?.success || !sim) return;
    const experienceTag = activeExperienceName !== 'Unsaved'
      ? ` exp=${activeExperienceName}`
      : '';
    const params: SimulationParams = {
      ...defaultParams,
      motor_speed: motorSpeed,
      height: activeCandidate?.height ?? result.height,
      thickness,
      K: activeCandidate?.K ?? result.K,
      deadband: activeCandidate?.deadband ?? result.deadband,
      default_distance: activeCandidate?.default_distance ?? result.default_distance,
      tube_id: tubeId,
      tube_od: tubeOd,
      input_pressure_psi: pressurePsi,
      compliance,
      chamber_volume_ml: chamberVolume,
      note: `[Builder] candidate ${activeIdx + 1}/${Math.max(1, candidateCount)} vol=${chamberVolume}mL${experienceTag}`,
    };
    onApplyToExplorer(params);
  };

  const builderHasDynamicModel = !!chartSim && chamberVolume > 0;

  const pneumaticData = useMemo(() => {
    if (!chartSim) return [];
    let t0 = 0;
    const yArr = chartSim.Y_positions;
    const tArr = chartSim.time_axis_ms;
    for (let i = 0; i < yArr.length - 1; i++) {
      if ((yArr[i] <= 0 && yArr[i + 1] >= 0) || (yArr[i] >= 0 && yArr[i + 1] <= 0)) {
        const ratio = (0 - yArr[i]) / (yArr[i + 1] - yArr[i]);
        t0 = tArr[i] + ratio * (tArr[i + 1] - tArr[i]);
        break;
      }
    }
    return chartSim.Y_positions.map((y, i) => ({
      y,
      flow: chartSim.flow_l_min[i],
      dynamicFlow: chamberVolume > 0 ? chartSim.dynamic_flow_l_min[i] : undefined,
      gap: chartSim.min_gaps[i],
      time: tArr[i] - t0,
    }));
  }, [chartSim, chamberVolume]);

  const y0TimeMs = useMemo(() => {
    if (!chartSim) return 0;
    const yArr = chartSim.Y_positions;
    const tArr = chartSim.time_axis_ms;
    for (let i = 0; i < yArr.length - 1; i++) {
      if ((yArr[i] <= 0 && yArr[i + 1] >= 0) || (yArr[i] >= 0 && yArr[i + 1] <= 0)) {
        const ratio = (0 - yArr[i]) / (yArr[i + 1] - yArr[i]);
        return tArr[i] + ratio * (tArr[i + 1] - tArr[i]);
      }
    }
    return 0;
  }, [chartSim]);

  const pressureData = useMemo(() => {
    if (!chartSim) return [];
    return chartSim.time_axis_ms.map((t, i) => ({
      timeSec: (t - y0TimeMs) / 1000,
      /** Gauge vs atmosphere (kPa), same convention as the Pressure slider secondary readout */
      pressureGaugeKpa: chartSim.chamber_pressure_kpa[i] - P_ATM_KPA,
    }));
  }, [chartSim, y0TimeMs]);

  const equalizationTimeRelSec = useMemo(() => {
    if (!chartSim || chartSim.equalization_time_ms < 0) return -1;
    return (chartSim.equalization_time_ms - y0TimeMs) / 1000;
  }, [chartSim, y0TimeMs]);

  /** Slider secondary uses psi × 6.89476 kPa (gauge); aligns with pressureGaugeKpa on the chart */
  const supplyGaugeKpa = pressurePsi * 6.89476;

  const builderViewParams = useMemo((): SimulationParams | null => {
    if (!result?.success || !chartSim) return null;
    return {
      ...defaultParams,
      motor_speed: motorSpeed,
      height: activeCandidate?.height ?? result.height,
      thickness,
      K: activeCandidate?.K ?? result.K,
      deadband: activeCandidate?.deadband ?? result.deadband,
      default_distance: activeCandidate?.default_distance ?? result.default_distance,
      tube_id: tubeId,
      tube_od: tubeOd,
      input_pressure_psi: pressurePsi,
      compliance,
      chamber_volume_ml: chamberVolume,
    };
  }, [result, activeCandidate, chartSim, motorSpeed, thickness, tubeId, tubeOd, pressurePsi, compliance, chamberVolume]);

  const maximizedInfo = useMemo(() => {
    if (!maximizedChart || !chartSim || !builderViewParams) return null;
    switch (maximizedChart) {
      case 'flowY':
        return {
          title: 'Flow vs Y',
          comp: (
            <ResponsiveContainer width="100%" height="100%" minHeight={320}>
              <LineChart data={pneumaticData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="y"
                  type="number"
                  stroke="#888"
                  label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }}
                  tickFormatter={(v) => v.toFixed(3)}
                  domain={builderChartSettings.flowY.autoX ? ['dataMin', 'dataMax'] : [builderChartSettings.flowY.xMin, builderChartSettings.flowY.xMax]}
                  allowDataOverflow
                />
                <YAxis
                  type="number"
                  stroke="#888"
                  label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                  domain={builderChartSettings.flowY.autoY ? ['dataMin', 'dataMax'] : [builderChartSettings.flowY.yMin, builderChartSettings.flowY.yMax]}
                  allowDataOverflow={!builderChartSettings.flowY.autoY}
                  tickFormatter={(v) => v.toFixed(3)}
                />
                <FlowVsYTooltipLikeExplorer />
                <FlowVsYLinesExplorerStyle hasDynamicModel={builderHasDynamicModel} />
                <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
                  <Label value="BUSHING CENTER (0mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />
                </ReferenceLine>
              </LineChart>
            </ResponsiveContainer>
          ),
        };
      case 'pressure':
        return {
          title: 'Chamber Pressure vs Time',
          comp: (
            <ResponsiveContainer width="100%" height="100%" minHeight={320}>
              <LineChart data={pressureData} margin={{ top: 16, right: 20, bottom: 24, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="timeSec"
                  type="number"
                  stroke="#a3a3a3"
                  domain={builderChartSettings.pressure.autoX ? ['dataMin', 'dataMax'] : [builderChartSettings.pressure.xMin, builderChartSettings.pressure.xMax]}
                  allowDataOverflow
                  tick={{ fontSize: 12, fill: '#d4d4d8' }}
                  label={{ value: 'Time rel. Y=0 (s)', position: 'bottom', fill: '#d4d4d8', fontSize: 12, offset: 4 }}
                  tickFormatter={(v) => `${v.toFixed(1)}s`}
                />
                <YAxis
                  type="number"
                  stroke="#a3a3a3"
                  tick={{ fontSize: 12, fill: '#d4d4d8' }}
                  label={{ value: 'Gauge (kPa)', angle: -90, position: 'insideLeft', fill: '#d4d4d8', offset: 10, fontSize: 12 }}
                  domain={builderChartSettings.pressure.autoY ? ['dataMin', 'dataMax'] : [builderChartSettings.pressure.yMin, builderChartSettings.pressure.yMax]}
                  allowDataOverflow={!builderChartSettings.pressure.autoY}
                  tickFormatter={(v) => v.toFixed(0)}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
                  formatter={(value: unknown) => [`${Number(value).toFixed(1)} kPa gauge`, 'Chamber']}
                  labelFormatter={(l: unknown) => `t rel Y=0: ${Number(l).toFixed(3)} s`}
                />
                <ReferenceLine y={supplyGaugeKpa} stroke="#22d3ee" strokeDasharray="6 4" strokeWidth={2}>
                  <Label value="Supply (gauge)" position="insideRight" fill="#22d3ee" fontSize={10} />
                </ReferenceLine>
                <Line type="monotone" dataKey="pressureGaugeKpa" name="Chamber" stroke="#8b5cf6" strokeWidth={3} dot={false} isAnimationActive={false} />
                {equalizationTimeRelSec >= 0 && (
                  <ReferenceLine x={equalizationTimeRelSec} stroke="#d946ef" strokeDasharray="5 5" strokeWidth={2}>
                    <Label value="Equalized" position="insideTopRight" fill="#d946ef" fontSize={12} />
                  </ReferenceLine>
                )}
              </LineChart>
            </ResponsiveContainer>
          ),
        };
      case 'vertical':
        return {
          title: 'Vertical System',
          comp: (
            <div className="h-full min-h-[320px] w-full">
              <VerticalSystemView
                data={chartSim}
                params={builderViewParams}
                details={true}
                setDetails={() => {}}
                isPreview={true}
                allowInteractInPreview={true}
                domainOverride={builderChartSettings.vertical}
              />
            </div>
          ),
        };
      default:
        return null;
    }
  }, [maximizedChart, chartSim, builderViewParams, pneumaticData, pressureData, activeIdx, supplyGaugeKpa, builderChartSettings, builderHasDynamicModel]);

  return (
    <div className="flex-1 mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">
      {/* Left: Input Parameters */}
      <div className="lg:col-span-3 xl:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 shadow-xl flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-6 min-w-0">
          <Crosshair className="w-5 h-5 text-emerald-500 shrink-0" />
          <h2 className="text-lg font-bold text-white uppercase tracking-tight truncate">Profile Builder</h2>
        </div>
        <div className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-neutral-600 scrollbar-track-transparent">
          <DelayedHoverHint content={builderExperienceNote}>
            <div className="space-y-2 pb-2 border-b border-neutral-700/50">
              <label className="text-sm font-medium tracking-tight text-neutral-300">Experience note</label>
              <textarea
                value={experienceNote}
                onChange={(e) => setExperienceNote(e.target.value)}
                placeholder="Explain this solve context and why it is useful. Parameters are already saved and diplayed in the experience browser"
                rows={3}
                className="w-full resize-y min-h-[4.5rem] rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
            </div>
          </DelayedHoverHint>

          <Accordion title="System Parameters">
            <div className="space-y-5 pt-2">
              <ParameterSlider label="Motor Speed (RPM)" value={motorSpeed} min={10} max={1000} step={10} onChange={setMotorSpeed} description={builderMotorSpeed} />
              <ParameterSlider label="Tube ID (mm)" value={tubeId} min={1.0} max={12.0} step={0.1} onChange={setTubeId} description={builderTubeId} />
              <ParameterSlider label="Tube OD (mm)" value={tubeOd} min={1.0} max={16.0} step={0.1} onChange={setTubeOd} description={builderTubeOd} />
              <ParameterSlider label="Pressure (PSI)" value={pressurePsi} min={1} max={150} step={1} onChange={setPressurePsi}
                secondaryValue={`${(pressurePsi * 6.89476).toFixed(0)} kPa`} description={builderPressure} />
              <ParameterSlider label="Compliance (mm/MPa)" value={compliance} min={0.0} max={5.0} step={0.01} onChange={setCompliance} description={builderCompliance} />
              <ParameterSlider label="Thickness (mm)" value={thickness} min={0.1} max={5.0} step={0.1} onChange={setThickness} description={builderThickness} />
            </div>
          </Accordion>

          <Accordion title="Target">
            <div className="space-y-5 pt-2">
              <ParameterSlider label="Chamber Volume (mL)" value={chamberVolume} min={0.1} max={100} step={0.5} onChange={setChamberVolume} description={builderChamberVolume} />
              <p className="text-[10px] text-neutral-500 leading-snug -mt-2">
                Displayed target is <span className="text-neutral-300">absolute free-air equivalent at final pressure ≈ {pressurizationAbsoluteMl.toFixed(2)} mL</span>.
                {' '}Solver internals still match the added amount from atmosphere (
                <span className="text-neutral-400">≈ {pressurizationDeltaMl.toFixed(2)} mL</span>).
              </p>
            </div>
          </Accordion>

          <Accordion title="Gap @ Y=0 margin & search grid" defaultOpen={false} showBottomBorder={false}>
            <div className="space-y-5 pt-2">
              <ParameterSlider
                label="Gap @ Y=0 margin (mm)"
                value={gapAtY0MarginMm}
                min={0}
                max={0.2}
                step={0.001}
                onChange={setGapAtY0MarginMm}
                secondaryValue={`accept ${gapAcceptBand.lo.toFixed(3)}–${gapAcceptBand.hi.toFixed(3)} mm`}
                description={builderGapAtY0Margin}
              />

              <SearchGridAxisControls
                title="K (curve gain)"
                accent="sky"
                axisMin={kMin}
                axisMax={kMax}
                onAxisMin={setKMin}
                onAxisMax={setKMax}
                limitMinLow={0.1}
                limitMinHigh={8}
                limitMaxLow={0.5}
                limitMaxHigh={12}
                fix={fixK}
                onFix={(next) => {
                  setFixK(next);
                  if (next) {
                    const lo = Math.min(kMin, kMax);
                    const hi = Math.max(kMin, kMax);
                    setFixedK((f) => Math.min(hi, Math.max(lo, f)));
                  }
                }}
                fixedValue={fixedK}
                onFixed={setFixedK}
                sampleMode={kSampleMode}
                onSampleMode={setKSampleMode}
                countValue={kSteps}
                onCount={setKSteps}
                countMin={3}
                countMax={40}
                stepValue={kStep}
                onStep={setKStep}
                stepMin={0.05}
                stepMax={2}
                stepSliderStep={0.05}
                boundStep={0.05}
                description={builderKSteps}
              />

              <SearchGridAxisControls
                title="Cam height (mm)"
                accent="emerald"
                axisMin={hSearchMin}
                axisMax={hSearchMax}
                onAxisMin={setHSearchMin}
                onAxisMax={setHSearchMax}
                limitMinLow={0.05}
                limitMinHigh={9.5}
                limitMaxLow={0.1}
                limitMaxHigh={10}
                fix={fixHeight}
                onFix={(next) => {
                  setFixHeight(next);
                  if (next) {
                    const lo = Math.min(hSearchMin, hSearchMax);
                    const hi = Math.max(hSearchMin, hSearchMax);
                    setFixedHeight((f) => Math.min(hi, Math.max(lo, f)));
                  }
                }}
                fixedValue={fixedHeight}
                onFixed={setFixedHeight}
                sampleMode={heightSampleMode}
                onSampleMode={setHeightSampleMode}
                countValue={heightSteps}
                onCount={setHeightSteps}
                countMin={3}
                countMax={50}
                stepValue={heightStep}
                onStep={setHeightStep}
                stepMin={0.05}
                stepMax={8}
                stepSliderStep={0.05}
                boundStep={0.05}
                description={builderHeightSteps}
                axisUnit=" mm"
              />

              <SearchGridAxisControls
                title="Deadband (mm)"
                accent="red"
                axisMin={deadbandSearchMin}
                axisMax={deadbandSearchMax}
                onAxisMin={(v) => {
                  setDeadbandSearchMin(v);
                  if (v >= deadbandSearchMax) setDeadbandSearchMax(Math.min(10, v + 0.05));
                }}
                onAxisMax={(v) => {
                  setDeadbandSearchMax(v);
                  if (v <= deadbandSearchMin) setDeadbandSearchMin(Math.max(0.05, v - 0.05));
                }}
                limitMinLow={0.05}
                limitMinHigh={9.5}
                limitMaxLow={0.1}
                limitMaxHigh={10}
                fix={fixDeadband}
                onFix={(next) => {
                  setFixDeadband(next);
                  if (next) {
                    const lo = Math.min(deadbandSearchMin, deadbandSearchMax);
                    const hi = Math.max(deadbandSearchMin, deadbandSearchMax);
                    setFixedDeadband((f) => Math.min(hi, Math.max(lo, f)));
                  }
                }}
                fixedValue={fixedDeadband}
                onFixed={setFixedDeadband}
                sampleMode={deadbandSampleMode}
                onSampleMode={setDeadbandSampleMode}
                countValue={deadbandSteps}
                onCount={setDeadbandSteps}
                countMin={3}
                countMax={45}
                stepValue={deadbandStep}
                onStep={setDeadbandStep}
                stepMin={0.05}
                stepMax={3}
                stepSliderStep={0.05}
                boundStep={0.05}
                axisUnit=" mm"
              />

              <ParameterSlider
                label={optimizeDefaultDistance ? 'Rest gap margin (× max per cell)' : 'Rest gap factor (× theoretical opening)'}
                value={defaultDistSafetyFactor}
                min={0.5}
                max={1.0}
                step={0.005}
                onChange={setDefaultDistSafetyFactor}
                secondaryValue={
                  optimizeDefaultDistance
                    ? `${(100 * defaultDistSafetyFactor).toFixed(1)}% of max admissible dd per cell`
                    : `fixed rest gap (CAD) ≈ ${Math.max(0, theoreticalGapMm * defaultDistSafetyFactor - AXIS_BUSHING_PLAY_MM).toFixed(3)} mm`
                }
                description={builderDefaultDistMargin}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-400">
                <input
                  type="checkbox"
                  checked={optimizeDefaultDistance}
                  onChange={(e) => setOptimizeDefaultDistance(e.target.checked)}
                  className="rounded border-neutral-600 bg-neutral-900 text-sky-500 focus:ring-sky-500"
                />
                Maximize rest gap per grid cell (advanced)
              </label>
              <p className="text-[10px] text-neutral-500 leading-snug -mt-2">
                {optimizeDefaultDistance
                  ? 'For each (K, height, deadband), the solver searches the largest rest gap at or below the theoretical opening, then applies the factor above.'
                  : `Rest gap (default_distance) is fixed: (theoretical × factor) − ${AXIS_BUSHING_PLAY_MM} mm for CAD-centered bushing; the model adds that axis play in the gap. Only K, cam height, and deadband vary.`}
              </p>
            </div>
          </Accordion>

          <div className="space-y-2 pt-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-neutral-300">Candidate ranking</div>
            <p className="text-[10px] text-neutral-400 leading-snug">
              Feasible (K, height, deadband) triples are ordered along one axis before listing up to 100 evenly spaced candidates. Choose exactly one method below before <strong className="text-neutral-400">SOLVE</strong>.
            </p>
            <div className="flex flex-col gap-2">
              {CANDIDATE_RANK_OPTIONS.map(({ value, label, hint }) => (
                <DelayedHoverHint key={value} content={hint} delayMs={280}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-neutral-700/80 bg-neutral-900/40 px-3 py-2 text-sm text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800/50">
                    <input
                      type="radio"
                      name="candidate_rank_by"
                      className="mt-0.5 shrink-0 rounded-full border-neutral-600 bg-neutral-900 text-emerald-500 focus:ring-emerald-500/40"
                      checked={candidateRankBy === value}
                      onChange={() => setCandidateRankBy(value)}
                      disabled={solving}
                    />
                    <span className="min-w-0 leading-snug">{label}</span>
                  </label>
                </DelayedHoverHint>
              ))}
            </div>
            {candidateRankBy === 'flow_at_y' && (
              <DelayedHoverHint content={builderCandidateRankFlowYPosition} delayMs={280}>
                <div className="pt-1">
                  <ParameterSlider
                    label="Y for ranking (mm)"
                    value={candidateRankFlowYmm}
                    min={0.05}
                    max={15}
                    step={0.05}
                    onChange={setCandidateRankFlowYmm}
                    secondaryValue={`read at Y = ${candidateRankFlowYmm.toFixed(2)} mm`}
                    description={builderCandidateRankFlowYPosition}
                    disabled={solving}
                  />
                </div>
              </DelayedHoverHint>
            )}
          </div>
        </div>

        <div className="shrink-0 mt-4 pt-4 border-t border-neutral-700 space-y-4">
          <div className="rounded-xl border border-neutral-700/70 bg-neutral-900/35 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowInfoPanel((v) => !v)}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
              showInfoPanel
                ? 'text-neutral-200 bg-neutral-800/60 border-b border-neutral-700/70'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40'
            }`}
            title={showInfoPanel ? 'Hide context details' : 'Show context details'}
          >
            <span>Context & Metrics</span>
            {showInfoPanel ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>

          {showInfoPanel && (
            <div className="space-y-3 p-3">
              <DelayedHoverHint content={builderTheoreticalGapStat}>
                <div>
                  <StatRow
                    label="Theoretical opening gap"
                    value={<span className={theoreticalGapMm <= 0 ? 'text-red-400' : 'text-neutral-300'}>{theoreticalGapMm.toFixed(3)} mm</span>}
                    highlight={theoreticalGapMm <= 0}
                  />
                </div>
              </DelayedHoverHint>

              <DelayedHoverHint content={builderAcceptableGapStat}>
                <div>
                  <StatRow
                    label="Acceptable gap@Y=0"
                    value={
                      <span className={theoreticalGapMm <= 0 ? 'text-red-400' : 'text-cyan-400'}>
                        {gapAcceptBand.lo.toFixed(3)} – {gapAcceptBand.hi.toFixed(3)} mm
                      </span>
                    }
                    highlight={theoreticalGapMm <= 0}
                  />
                </div>
              </DelayedHoverHint>

              <DelayedHoverHint content={builderPressurizationTargetStat}>
                <div>
          <StatRow label="Pressurization target (absolute)" value={`≈ ${pressurizationAbsoluteMl.toFixed(2)} mL (equiv. @ amb.)`} />
                </div>
              </DelayedHoverHint>

              <DelayedHoverHint content={builderLinearSpeedStat}>
                <div>
                  <StatRow label="Linear Speed" value={`${(motorSpeed * 0.5 / 60).toFixed(2)} mm/s`} />
                </div>
              </DelayedHoverHint>
            </div>
          )}
          </div>

          <div className="relative space-y-2.5 pt-1">
            <button
              type="button"
              onClick={handleSolve}
              disabled={solving || theoreticalGapMm <= 0}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {solving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Solving...
                </>
              ) : (
                <span className="flex items-center gap-2">
                  <span>SOLVE</span>
                  <span className="text-[11px] font-medium text-emerald-100/90">({solveButtonHint})</span>
                </span>
              )}
            </button>
            {solverInputsStale && !solving && lastSolveRequestBody && (
              <DelayedHoverHint
                delayMs={350}
                content={<SolverStaleDiffTable last={lastSolveRequestBody} current={currentSolveStreamBody} />}
              >
                <span
                  role="status"
                  aria-label="Paramètres modifiés depuis le dernier solve — survoler pour le détail"
                  className="pointer-events-auto absolute -right-1 -top-1 z-10 flex h-6 w-6 cursor-help items-center justify-center rounded-md border border-amber-500/80 bg-amber-600 text-amber-50 shadow-md"
                >
                  <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} />
                </span>
              </DelayedHoverHint>
            )}
          </div>
          {solving && solveProgress && (
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-700">
                <div
                  className={`h-full rounded-full bg-emerald-500 ${solveProgressDisplay.inGridPhase ? '' : 'transition-[width] duration-300 ease-out'}`}
                  style={{ width: `${solveProgressDisplay.barPct}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-neutral-400">
                <span className="min-w-0 flex-1 truncate leading-snug" title={solveProgress.message}>
                  {solveProgress.message}
                </span>
                <span className="shrink-0 font-mono text-emerald-400">{solveProgressDisplay.text}%</span>
              </div>
              {solveProgressDisplay.inGridPhase && solveProgress.totalCount > 0 && (
                <p className="text-[9px] leading-snug text-neutral-500">
                  La barre (≈ 5–88 %) suit la part de triplets (K×h×deadband) déjà testés, pas le temps CPU.
                  Le coût par triplet varie (ex. recherche du rest gap max), et l’affichage est regroupé pour rester fluide — d’où parfois l’impression que ça « accélère » vers la fin.
                </p>
              )}
              <div className="text-center text-[11px] font-mono text-amber-400/95">
                {solveProgress.feasibleCount === 1
                  ? '1 combinaison trouvée'
                  : `${solveProgress.feasibleCount} combinaisons trouvées`}
              </div>
              {solveTiming && (
                <div className="space-y-1 rounded-md border border-neutral-700/60 bg-neutral-900/40 p-2 text-[10px] font-mono text-neutral-300">
                  <div className="flex justify-between"><span>Elapsed</span><span>{formatDurationFromMs(solveTiming.elapsedMs)}</span></div>
                  <div className="flex justify-between"><span>Avg / iteration</span><span>{formatDurationFromMs(solveTiming.avgMs)}</span></div>
                  <div className="flex justify-between"><span>Remaining</span><span>{formatDurationFromMs(solveTiming.remainingMs)}</span></div>
                  <div className="flex justify-between"><span>ETA end</span><span>{formatClockFromMs(solveTiming.etaMs)}</span></div>
                </div>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleTerminateSolve}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/50 bg-amber-950/35 py-2.5 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-900/50"
                >
                  Terminate now
                </button>
                <button
                  type="button"
                  onClick={handleCancelSolve}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/50 bg-red-950/40 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-900/50"
                >
                  <OctagonX className="h-4 w-4 shrink-0" />
                  Cancel simulation
                </button>
              </div>
            </div>
          )}
          {theoreticalGapMm <= 0 && (
            <p className="text-[10px] text-red-400 text-center">Theoretical gap ≤ 0. Adjust tube dimensions, pressure, or compliance.</p>
          )}
        </div>
      </div>

      {/* Right: Results & Preview */}
      <div className="lg:col-span-9 xl:col-span-9 min-w-0 flex flex-col gap-4 min-h-0">
        <AnimatePresence mode="wait">
          {solving && !result ? (
            <motion.div key="solving" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-neutral-700 bg-neutral-800/80 p-8 shadow-xl">
              <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
              <div className="w-full max-w-md space-y-3">
                <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-700">
                  <div
                    className={`h-full rounded-full bg-emerald-500 ${solveProgressDisplay.inGridPhase ? '' : 'transition-[width] duration-300 ease-out'}`}
                    style={{ width: `${solveProgress?.percent != null ? solveProgressDisplay.barPct : 0}%` }}
                  />
                </div>
                <p className="text-center text-xs text-neutral-300">{solveProgress?.message ?? '…'}</p>
                <p className="text-center font-mono text-sm text-amber-400/95">
                  {(solveProgress?.feasibleCount ?? 0) === 1
                    ? '1 combinaison trouvée'
                    : `${solveProgress?.feasibleCount ?? 0} combinaisons trouvées`}
                </p>
                {solveTiming && (
                  <div className="space-y-1 rounded-md border border-neutral-700/60 bg-neutral-900/40 p-2 text-[10px] font-mono text-neutral-300">
                    <div className="flex justify-between"><span>Elapsed</span><span>{formatDurationFromMs(solveTiming.elapsedMs)}</span></div>
                    <div className="flex justify-between"><span>Avg / iteration</span><span>{formatDurationFromMs(solveTiming.avgMs)}</span></div>
                    <div className="flex justify-between"><span>Remaining</span><span>{formatDurationFromMs(solveTiming.remainingMs)}</span></div>
                    <div className="flex justify-between"><span>ETA end</span><span>{formatClockFromMs(solveTiming.etaMs)}</span></div>
                  </div>
                )}
                <p className="text-center font-mono text-sm text-emerald-400">{solveProgress ? `${solveProgressDisplay.text}%` : '0%'}</p>
              </div>
              {solveProgressDisplay.inGridPhase && solveProgress && solveProgress.totalCount > 0 && (
                <p className="max-w-md text-center text-[9px] leading-snug text-neutral-500">
                  Progression ≈ triplets testés / total (pas le temps machine). Coût variable par case ; l’UI regroupe les mises à jour.
                </p>
              )}
              <p className="max-w-md text-center text-[10px] text-neutral-500">
                The (K × height × deadband) grid can take several minutes depending on resolution.
              </p>
              <div className="mt-2 grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={handleTerminateSolve}
                  className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/50 bg-amber-950/35 px-6 py-2.5 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-900/50"
                >
                  Terminate now
                </button>
                <button
                  type="button"
                  onClick={handleCancelSolve}
                  className="flex items-center justify-center gap-2 rounded-xl border border-red-500/50 bg-red-950/40 px-6 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-900/50"
                >
                  <OctagonX className="h-4 w-4 shrink-0" />
                  Cancel simulation
                </button>
              </div>
            </motion.div>
          ) : result ? (
            <motion.div key="results" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex flex-col gap-4 min-h-0 flex-1">

              {/* Top bar: found params + stats */}
              <div className={`shrink-0 p-4 rounded-xl border shadow-xl ${result.success ? 'bg-neutral-800 border-neutral-700' : 'bg-red-900/30 border-red-700/50'}`}>
                {result.success ? (
                  <div className="flex flex-wrap items-start gap-6">
                    <div>
                      <div className="text-[10px] text-neutral-500 uppercase font-bold mb-2">Found Parameters</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                        <div><div className="text-[10px] text-neutral-500">Height</div><div className="text-lg font-mono font-bold text-emerald-400">{(activeCandidate?.height ?? result.height).toFixed(3)} mm</div></div>
                        <div><div className="text-[10px] text-neutral-500">Curve Gain (K)</div><div className="text-lg font-mono font-bold text-emerald-400">{(activeCandidate?.K ?? result.K).toFixed(3)}</div></div>
                        <div><div className="text-[10px] text-neutral-500">Deadband</div><div className="text-lg font-mono font-bold text-emerald-400">{(activeCandidate?.deadband ?? result.deadband).toFixed(3)} mm</div></div>
                        <div><div className="text-[10px] text-neutral-500">Default Dist.</div><div className="text-lg font-mono font-bold text-blue-400">{(activeCandidate?.default_distance ?? result.default_distance).toFixed(3)} mm</div></div>
                        <div><div className="text-[10px] text-neutral-500">gap @ Y=0</div><div className="text-lg font-mono font-bold text-cyan-400">{(activeCandidate?.gap_at_Y0 ?? result.gap_at_Y0) !== undefined ? (activeCandidate?.gap_at_Y0 ?? result.gap_at_Y0)!.toFixed(4) : '—'} mm</div></div>
                        <div><div className="text-[10px] text-neutral-500">Theoretical gap</div><div className="text-lg font-mono font-bold text-neutral-300">{result.theoretical_gap_mm !== undefined ? result.theoretical_gap_mm.toFixed(4) : '—'} mm</div></div>
                      </div>
                      {candidateCount > 1 ? (
                        <DelayedHoverHint content={builderAggressivity}>
                          <div className="mt-4 max-w-2xl space-y-2 border-t border-neutral-700/60 pt-4">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-neutral-300">Aggressivity</span>
                              <span className="text-[10px] font-mono text-neutral-500">
                                {activeIdx + 1} / {candidateCount}
                                <span className="text-neutral-600"> · </span>
                                <span className={profileAggressivity01 <= 0.35 ? 'text-emerald-400' : profileAggressivity01 >= 0.65 ? 'text-amber-400' : 'text-neutral-400'}>
                                  {profileAggressivity01 <= 0.35 ? 'Gradual' : profileAggressivity01 >= 0.65 ? 'Snappy' : 'Balanced'}
                                </span>
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] text-neutral-500 uppercase shrink-0">Gradual</span>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={profileAggressivity01}
                                onChange={(e) => setProfileAggressivity01(parseFloat(e.target.value))}
                                className="min-w-0 flex-1 accent-amber-500 hover:accent-400 cursor-pointer"
                              />
                              <span className="text-[10px] text-neutral-500 uppercase shrink-0">Snappy</span>
                            </div>
                            <p className="text-[10px] text-neutral-500 leading-snug">
                              {rankUsedForAggressivity === 'equalization_rel_time' && (
                                <>
                                  Chamber eq. Δt (after Y=0) ≈{' '}
                                  <span className="font-mono text-amber-400/90">
                                    {activeCandidate?.equalization_time_rel_ms !== undefined && Number.isFinite(activeCandidate.equalization_time_rel_ms)
                                      ? `${activeCandidate.equalization_time_rel_ms.toFixed(1)} ms`
                                      : '—'}
                                  </span>
                                  {' '}· vol. err.{' '}
                                </>
                              )}
                              {rankUsedForAggressivity === 'flow_rise_20_80' && (
                                <>
                                  Flow rise-rate (5%→25%) ≈{' '}
                                  <span className="font-mono text-amber-400/90">{(activeCandidate?.flow_slope_l_per_mm ?? 0).toFixed(4)}</span> L/min/mm · vol. err.{' '}
                                </>
                              )}
                              {rankUsedForAggressivity === 'flow_exp' && (
                                <>
                                  Exp. fit <span className="font-mono text-neutral-500">k</span> ≈{' '}
                                  <span className="font-mono text-amber-400/90">
                                    {activeCandidate?.flow_exp_k_per_mm !== undefined && Number.isFinite(activeCandidate.flow_exp_k_per_mm)
                                      ? `${activeCandidate.flow_exp_k_per_mm.toFixed(4)}`
                                      : '—'}
                                  </span>
                                  {' '}
                                  /mm · vol. err.{' '}
                                </>
                              )}
                              {rankUsedForAggressivity === 'flow_at_y' && (
                                <>
                                  Static flow @ Y={rankFlowYUsed.toFixed(3)} mm ≈{' '}
                                  <span className="font-mono text-amber-400/90">
                                    {activeCandidate?.static_flow_at_rank_y_l_min !== undefined
                                    && Number.isFinite(activeCandidate.static_flow_at_rank_y_l_min)
                                      ? `${activeCandidate.static_flow_at_rank_y_l_min.toFixed(3)}`
                                      : '—'}
                                  </span>
                                  {' '}
                                  L/min · vol. err.{' '}
                                </>
                              )}
                              <span className="font-mono text-neutral-400">{(activeCandidate?.volume_error_pct ?? 0).toFixed(2)}%</span>
                            </p>
                            {guidanceEnabled && (
                              <p className="text-[10px] text-neutral-500 leading-snug">
                                {candidateCount < MAX_RETURNED_BUILDER_CANDIDATES ? (
                                  <>
                                    All <span className="font-mono text-neutral-400">{candidateCount}</span> feasible triple
                                    {candidateCount !== 1 ? 's are' : ' is'} ranked by{' '}
                                    <span className="text-neutral-400">{rankingGuidanceShort(rankUsedForAggressivity, rankFlowYUsed)}</span> and shown in full.
                                  </>
                                ) : (
                                  <>
                                    Every feasible triple is ranked by{' '}
                                    <span className="text-neutral-400">{rankingGuidanceShort(rankUsedForAggressivity, rankFlowYUsed)}</span>. When there are more than{' '}
                                    {MAX_RETURNED_BUILDER_CANDIDATES}, we keep {MAX_RETURNED_BUILDER_CANDIDATES} evenly spaced along that order, always including the two extremes.
                                  </>
                                )}
                              </p>
                            )}
                            {solveSummary && (
                              <p className="text-[10px] text-neutral-500 leading-snug">
                                Tested{' '}
                                <span className="font-mono text-neutral-300">{solveSummary.testedCount}</span>
                                {' '}combinaisons · solve time{' '}
                                <span className="font-mono text-neutral-300">{formatDurationFromMs(solveSummary.totalDurationMs)}</span>
                              </p>
                            )}
                          </div>
                        </DelayedHoverHint>
                      ) : candidateCount === 1 ? (
                        <p className="mt-3 text-[10px] text-neutral-500">Only one combination near the target volume in the acceptable gap band.</p>
                      ) : null}
                      {guidanceEnabled && (
                        <p className="text-[10px] text-neutral-500 mt-2 leading-snug max-w-3xl">{result.message}</p>
                      )}
                    </div>
                    {chartSim && (
                      <div className="border-l border-neutral-700 pl-6">
                        <div className="text-[10px] text-neutral-500 uppercase font-bold mb-2">Dynamic Stats</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div><div className="text-[10px] text-neutral-500">Total Volume</div><div className="text-sm font-mono font-bold text-amber-400">{chartSim.total_volume_ml.toFixed(2)} mL</div></div>
                          <div><div className="text-[10px] text-neutral-500">Equalization</div><div className="text-sm font-mono font-bold text-amber-400">{chartSim.equalization_time_ms >= 0 ? `${chartSim.equalization_time_ms.toFixed(1)} ms` : 'N/A'}</div></div>
                          <div><div className="text-[10px] text-neutral-500">Max Flow</div><div className="text-sm font-mono font-bold text-amber-400">{Math.max(...chartSim.dynamic_flow_l_min).toFixed(3)} L/min</div></div>
                        </div>
                      </div>
                    )}
                    <div className="ml-auto flex items-center">
                      <button onClick={handleApply}
                        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg flex items-center gap-2">
                        Apply to Explorer <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-red-300 text-sm">{result.message}</div>
                )}
              </div>

              {/* Charts — same layout / semi-fullscreen as Explorer */}
              {chartSim && builderViewParams && (
                <div className="relative min-h-0 flex-1 grid grid-rows-3 gap-4">
                  <AnimatePresence>
                    {maximizedChart && maximizedInfo && (
                      <>
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          onClick={() => setMaximizedChart(null)}
                          className="absolute -inset-4 z-40 rounded-xl bg-neutral-900/40"
                        />
                        <motion.div
                          layoutId={`builder-${maximizedChart}`}
                          className="absolute inset-0 z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-600 bg-neutral-800 shadow-2xl"
                        >
                          <div className="flex shrink-0 items-center justify-between border-b border-neutral-700/50 bg-neutral-800/80 p-6 pb-2 backdrop-blur">
                            <h3 className="text-xl font-bold text-neutral-100">{maximizedInfo.title}</h3>
                            <button
                              type="button"
                              onClick={() => setMaximizedChart(null)}
                              className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                              title="Exit fullscreen"
                            >
                              <Minimize2 className="h-6 w-6" />
                            </button>
                          </div>
                          <div className="min-h-0 w-full flex-1 overflow-hidden p-6">{maximizedInfo.comp}</div>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>

                  <motion.div
                    layoutId="builder-flowY"
                    className="row-span-2 flex min-h-0 flex-col items-stretch rounded-xl border border-neutral-700 bg-neutral-800 p-3 shadow-xl"
                  >
                    <div className="relative mb-2 flex shrink-0 items-center justify-between">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Flow vs Y</h3>
                      </div>
                      <div className="z-10 flex w-full justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setChartSettingsTarget('flowY')}
                          className={`rounded-md p-1.5 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'flowY' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                          title="Chart settings"
                        >
                          <Cog className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setMaximizedChart('flowY')}
                          className={`rounded-md p-1.5 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'flowY' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                          title="Expand chart"
                        >
                          <Maximize2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className={`min-h-0 w-full flex-1 ${maximizedChart === 'flowY' ? 'opacity-0' : 'opacity-100'}`}>
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={260}>
                        <LineChart data={pneumaticData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                          <XAxis
                            dataKey="y"
                            type="number"
                            stroke="#888"
                            label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }}
                            tickFormatter={(v) => v.toFixed(3)}
                            domain={builderChartSettings.flowY.autoX ? ['dataMin', 'dataMax'] : [builderChartSettings.flowY.xMin, builderChartSettings.flowY.xMax]}
                            allowDataOverflow
                          />
                          <YAxis
                            type="number"
                            stroke="#888"
                            label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                            domain={builderChartSettings.flowY.autoY ? ['dataMin', 'dataMax'] : [builderChartSettings.flowY.yMin, builderChartSettings.flowY.yMax]}
                            allowDataOverflow={!builderChartSettings.flowY.autoY}
                            tickFormatter={(v) => v.toFixed(3)}
                          />
                          <FlowVsYTooltipLikeExplorer />
                          <FlowVsYLinesExplorerStyle hasDynamicModel={builderHasDynamicModel} />
                          <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </motion.div>

                  <div className="row-span-1 flex min-h-0 flex-col gap-4 lg:flex-row">
                    <motion.div
                      layoutId="builder-pressure"
                      className="flex min-h-0 min-w-0 flex-1 flex-col items-stretch rounded-xl border border-neutral-700 bg-neutral-800 p-3 shadow-xl"
                    >
                      <div className="relative mb-2 flex shrink-0 items-center justify-between">
                        <div className="absolute inset-0 flex items-center justify-center">
                          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 lg:text-neutral-200">Chamber Pressure</h3>
                        </div>
                        <div className="z-10 flex w-full justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setChartSettingsTarget('pressure')}
                            className={`rounded-md p-1 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'pressure' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                            title="Chart settings"
                          >
                            <Cog className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setMaximizedChart('pressure')}
                            className={`rounded-md p-1 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'pressure' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                            title="Expand chart"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className={`min-h-0 w-full flex-1 ${maximizedChart === 'pressure' ? 'opacity-0' : 'opacity-100'}`}>
                        <ResponsiveContainer width="100%" height="100%" minHeight={160}>
                          <LineChart data={pressureData} margin={{ top: 10, right: 15, bottom: 20, left: 15 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                            <XAxis
                              dataKey="timeSec"
                              type="number"
                              stroke="#a3a3a3"
                              domain={builderChartSettings.pressure.autoX ? ['dataMin', 'dataMax'] : [builderChartSettings.pressure.xMin, builderChartSettings.pressure.xMax]}
                              allowDataOverflow
                              tick={{ fontSize: 11, fill: '#d4d4d8' }}
                              label={{ value: 'Time rel. Y=0 (s)', position: 'bottom', fill: '#d4d4d8', fontSize: 11, offset: 4 }}
                              tickFormatter={(v) => `${v.toFixed(1)}s`}
                            />
                            <YAxis
                              type="number"
                              stroke="#a3a3a3"
                              tick={{ fontSize: 11, fill: '#d4d4d8' }}
                              label={{ value: 'Gauge (kPa)', angle: -90, position: 'insideLeft', fill: '#d4d4d8', offset: 10, fontSize: 11 }}
                              domain={builderChartSettings.pressure.autoY ? ['dataMin', 'dataMax'] : [builderChartSettings.pressure.yMin, builderChartSettings.pressure.yMax]}
                              allowDataOverflow={!builderChartSettings.pressure.autoY}
                              tickFormatter={(v) => v.toFixed(0)}
                            />
                            <Tooltip
                              contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
                              formatter={(value: unknown) => [`${Number(value).toFixed(1)} kPa gauge`, 'Chamber']}
                              labelFormatter={(l: unknown) => `t rel Y=0: ${Number(l).toFixed(3)} s`}
                            />
                            <ReferenceLine y={supplyGaugeKpa} stroke="#22d3ee" strokeDasharray="6 4" strokeWidth={2} />
                            <Line type="monotone" dataKey="pressureGaugeKpa" name="Chamber" stroke="#8b5cf6" strokeWidth={3} dot={false} isAnimationActive={false} />
                            {equalizationTimeRelSec >= 0 && (
                              <ReferenceLine x={equalizationTimeRelSec} stroke="#d946ef" strokeDasharray="5 5" strokeWidth={2}>
                                <Label value="Equalized" position="insideTopRight" fill="#d946ef" fontSize={11} />
                              </ReferenceLine>
                            )}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </motion.div>

                    <motion.div
                      layoutId="builder-vertical"
                      className="flex min-h-0 min-w-0 flex-1 flex-col items-stretch rounded-xl border border-neutral-700 bg-neutral-800 p-3 shadow-xl"
                    >
                      <div className="relative mb-2 flex shrink-0 items-center justify-between">
                        <div className="absolute inset-0 flex items-center justify-center">
                          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-400 lg:text-neutral-200">Cam Profile</h3>
                        </div>
                        <div className="z-10 flex w-full justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setChartSettingsTarget('vertical')}
                            className={`rounded-md p-1 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'vertical' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                            title="Chart settings"
                          >
                            <Cog className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setMaximizedChart('vertical')}
                            className={`rounded-md p-1 transition-colors hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${maximizedChart === 'vertical' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                            title="Expand view"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className={`min-h-0 w-full flex-1 overflow-hidden ${maximizedChart === 'vertical' ? 'opacity-0' : 'opacity-100'}`}>
                        <VerticalSystemView
                          data={chartSim}
                          params={builderViewParams}
                          details={true}
                          setDetails={() => {}}
                          isPreview={true}
                          domainOverride={builderChartSettings.vertical}
                        />
                      </div>
                    </motion.div>
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-3">
                <Crosshair className="w-12 h-12 text-neutral-700 mx-auto" />
                <p className="text-neutral-500 text-sm">Configure parameters and click <strong className="text-emerald-400">SOLVE</strong> to find optimal cam profile.</p>
                <p className="text-neutral-600 text-xs max-w-md mx-auto">
                  The solver will find the height, curve gain (K), and deadband that make the tube open exactly at Y=0
                  and deliver the target volume to your chamber.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ChartDomainSettingsModal
        isOpen={chartSettingsTarget !== null}
        title={chartSettingsTarget ? `${chartSettingsTarget} domain settings` : 'Domain settings'}
        settings={chartSettingsTarget ? builderChartSettings[chartSettingsTarget] : DEFAULT_BUILDER_DOMAIN}
        onClose={() => setChartSettingsTarget(null)}
        onChange={(next) => {
          if (!chartSettingsTarget) return;
          setBuilderChartSettings((prev) => ({ ...prev, [chartSettingsTarget]: next }));
        }}
      />

      {showExperienceModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-5xl h-[72vh] flex overflow-hidden"
          >
            <div className="w-72 shrink-0 min-w-0 border-r border-neutral-800 flex flex-col bg-neutral-900/50">
              <div className="h-14 px-4 border-b border-neutral-800 flex justify-between items-center min-w-0">
                <h3 className="text-sm font-bold text-white uppercase tracking-tighter truncate">Builder Experiences</h3>
                <button onClick={() => setShowExperienceModal(false)} className="text-neutral-500 hover:text-white transition-colors shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-3 pt-3 pb-2 border-b border-neutral-800/70">
                <input
                  type="text"
                  value={experienceQuery}
                  onChange={(e) => setExperienceQuery(e.target.value)}
                  placeholder="Search"
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900/80 px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                />
              </div>
              <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-2 space-y-1">
                {filteredExperiences.map(({ filename, note }) => (
                  <div key={filename} className="group relative flex items-start min-w-0 max-w-full">
                    <button
                      type="button"
                      onMouseEnter={() => { void loadExperiencePreview(filename); }}
                      onClick={() => setSelectedExperience(filename)}
                      onDoubleClick={() => { setSelectedExperience(filename); void applyExperience(); }}
                      className={`min-w-0 w-full max-w-full text-left px-3 py-2 rounded-lg text-xs transition-all pr-10 ${selectedExperience === filename ? 'bg-emerald-600 text-white font-bold' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                    >
                      <span className="font-mono break-all [overflow-wrap:anywhere] text-left leading-snug">{filename}</span>
                      {note.trim() ? (
                        <p className={`mt-1 text-[10px] leading-snug line-clamp-2 font-normal break-words [overflow-wrap:anywhere] ${selectedExperience === filename ? 'text-emerald-100/90' : 'text-neutral-500 group-hover:text-neutral-400'}`}>{note.trim()}</p>
                      ) : null}
                    </button>
                    <button
                      onClick={(e) => { void deleteExperience(filename, e); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                      title="Delete experience"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {filteredExperiences.length === 0 && (
                  <div className="px-3 py-6 text-center text-[11px] text-neutral-500">
                    No matching experience
                  </div>
                )}
              </div>
              <div className="p-4 border-t border-neutral-800">
                <button
                  disabled={!selectedExperience}
                  onClick={() => { void applyExperience(); }}
                  className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold transition-all shadow-lg"
                >
                  LOAD EXPERIENCE
                </button>
              </div>
            </div>
            <div className="flex-1 bg-neutral-950 flex flex-col min-h-0">
              <div className="h-14 px-4 border-b border-neutral-800 bg-neutral-900/40 flex items-center">
                <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Experience Preview</h4>
              </div>
              <div className="flex-1 min-h-0 p-4 overflow-hidden">
                {previewExperience?.solver_result?.simulation ? (
                  <div className="h-full grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="md:col-span-1 min-h-0 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 overflow-auto">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-neutral-500 mb-3">Simplified Parameters</div>
                      {(() => {
                        const p = (previewExperience.builder_params ?? {}) as Record<string, unknown>;
                        const n = (key: string, fallback: number) => (typeof p[key] === 'number' ? p[key] as number : fallback);
                        const sim = previewExperience.solver_result.simulation;
                        const staticFlowAtHalfMm = (() => {
                          if (!sim) return null;
                          const ys = sim.Y_positions;
                          const vals = sim.flow_l_min;
                          const len = ys.length;
                          if (!len || len !== vals.length) return null;
                          if (len === 1) return vals[0];
                          for (let i = 0; i < len - 1; i++) {
                            const a = ys[i];
                            const b = ys[i + 1];
                            if (a === b) continue;
                            if ((0.5 - a) * (0.5 - b) <= 0) {
                              const t = (0.5 - a) / (b - a);
                              return vals[i] + t * (vals[i + 1] - vals[i]);
                            }
                          }
                          let best = 0;
                          let bestDist = Infinity;
                          for (let i = 0; i < len; i++) {
                            const d = Math.abs(ys[i] - 0.5);
                            if (d < bestDist) {
                              bestDist = d;
                              best = i;
                            }
                          }
                          return vals[best];
                        })();
                        const rows: Array<{ label: string; value: string; tone?: string }> = [
                          { label: 'Motor Speed', value: `${n('motorSpeed', 100).toFixed(0)} RPM` },
                          { label: 'Tube ID', value: `${n('tubeId', 2.0).toFixed(2)} mm` },
                          { label: 'Tube OD', value: `${n('tubeOd', 3.0).toFixed(2)} mm` },
                          { label: 'Pressure', value: `${n('pressurePsi', 15).toFixed(1)} PSI` },
                          { label: 'Compliance', value: `${n('compliance', 0.9).toFixed(3)} mm/MPa` },
                          { label: 'Thickness', value: `${n('thickness', 2.5).toFixed(2)} mm` },
                          { label: 'Chamber Volume', value: `${n('chamberVolume', 50).toFixed(1)} mL` },
                          {
                            label: 'Static flow @ Y=0.5 mm',
                            value: staticFlowAtHalfMm !== null ? `${staticFlowAtHalfMm.toFixed(3)} L/min` : 'N/A',
                            tone: 'text-amber-300',
                          },
                        ];
                        return (
                          <div className="space-y-2">
                            {rows.map((row) => (
                              <div key={row.label} className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-neutral-500">{row.label}</div>
                                <div className={`font-mono text-xs font-semibold ${row.tone ?? 'text-neutral-200'}`}>{row.value}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      {(() => {
                        const p = (previewExperience.builder_params ?? {}) as Record<string, unknown>;
                        const grid = searchGridPreviewFromParams(p);
                        const candLen = previewExperience.solver_result.candidates?.length ?? 0;
                        const terminatedEarly = previewExperience.solver_result.message?.startsWith('Terminated early');
                        return (
                          <div className="mt-4 border-t border-neutral-800 pt-3 space-y-2">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">Search grid</div>
                            <p className="text-[10px] text-sky-300/95 leading-snug font-mono">{grid.lines.k}</p>
                            <p className="text-[10px] text-emerald-300/95 leading-snug font-mono">{grid.lines.h}</p>
                            <p className="text-[10px] text-red-300/95 leading-snug font-mono">{grid.lines.d}</p>
                            <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-2 space-y-1.5">
                              <div className="text-[10px] uppercase tracking-wider text-neutral-500">Grid & solve</div>
                              <p className="text-[11px] text-neutral-200 leading-snug">
                                <span className="text-neutral-400">Triple product (K×H×D):</span>{' '}
                                <span className="font-mono font-semibold text-neutral-100">
                                  {grid.kN}×{grid.hN}×{grid.dN} = {grid.triples.toLocaleString()}
                                </span>
                                <span className="text-neutral-500"> planned evaluations</span>
                              </p>
                              <p className="text-[11px] text-neutral-200 leading-snug">
                                <span className="text-neutral-400">Gap @ Y=0 margin:</span>{' '}
                                <span className="font-mono text-neutral-100">{grid.g.gapAtY0MarginMm.toFixed(4)} mm</span>
                              </p>
                              <p className="text-[11px] text-neutral-200 leading-snug">
                                <span className="text-neutral-400">Rest gap:</span>{' '}
                                <span className="font-mono text-neutral-100">
                                  {grid.g.optimizeDefaultDistance ? 'max per cell (optimize)' : `fixed (×${grid.g.defaultDistSafetyFactor.toFixed(3)} − axis play)`}
                                </span>
                              </p>
                              <p className="text-[11px] text-neutral-200 leading-snug">
                                <span className="text-neutral-400">Feasible configs (aggressivity list):</span>{' '}
                                <span className="font-mono font-semibold text-amber-300/90">{candLen}</span>
                                <span className="text-neutral-500">
                                  {candLen < MAX_RETURNED_BUILDER_CANDIDATES
                                    ? ' — all feasible solutions'
                                    : ` — up to ${MAX_RETURNED_BUILDER_CANDIDATES} evenly spaced along flow rise-rate`}
                                </span>
                              </p>
                              {terminatedEarly ? (
                                <p className="text-[10px] text-amber-400/95 leading-snug">
                                  Solve ended before the full grid was evaluated — counts above are from saved settings; some triples may have been skipped.
                                </p>
                              ) : null}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <div className="md:col-span-2 min-h-0">
                      <VerticalSystemView
                        data={previewExperience.solver_result.simulation}
                        params={{
                          ...defaultParams,
                          ...(previewExperience.builder_params as Partial<SimulationParams>),
                          height: previewExperience.solver_result.height,
                          K: previewExperience.solver_result.K,
                          deadband: previewExperience.solver_result.deadband,
                          default_distance: previewExperience.solver_result.default_distance,
                        }}
                        details={true}
                        setDetails={() => {}}
                        isPreview={true}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-neutral-600 text-sm font-medium">
                    Hover an experience to preview...
                  </div>
                )}
              </div>
              {previewExperience && (
                <div className="p-4 bg-neutral-900 border-t border-neutral-800 space-y-2">
                  <div className="text-[10px] text-neutral-500 uppercase font-bold">Note</div>
                  <p className="text-xs text-neutral-200 leading-relaxed whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                    {previewExperience.note?.trim() || 'No note'}
                  </p>
                  <div className="text-[10px] text-neutral-500">
                    Candidates: <span className="font-mono text-neutral-300">{previewExperience.solver_result.candidates?.length ?? 0}</span>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
