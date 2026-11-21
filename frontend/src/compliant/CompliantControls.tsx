import { useRef, useState } from 'react';
import { Button } from '@blain-projects/ui';
import { Clock, Eye, RefreshCw, Target, Trash2 } from 'lucide-react';
import { Accordion, ParameterSlider, StatRow } from '../components';
import { TubeModelControls } from '../TubeModel';
import {
  ALL_SOLVER_GOALS, CONTEXT_LIMITS, CONTEXT_VAR_KEYS, LIMITS, MEMBERS, SOLVER_GOAL_META,
  TIME_BUDGET_PRESETS, allowableStressMpa, anchorSymmetricRange, effectivePinchY, memberChords, mm, worldQuadrantsToUV,
} from './types';
import type {
  CompliantParams, CompliantResult, ContextFixedMap, ContextToggleKey, ContextVarKey,
  HoveredBoundTarget, Material, Member, Quadrant, QuadrantConfig, QuadrantKey, QuadrantMap,
  Runner, ShapeKey, SliderMeta, SolveExperimentSummary, SolverConstraints, SolverGoal,
  SolverGoalConfig,
} from './types';

export interface MeasureState {
  busy: boolean;
  ok: boolean;
  text: string | null;
}

/** Clean min/max slider pair for a variable released to the solver. */
function RangeSliderPair({
  meta,
  range,
  onChange,
}: {
  meta: SliderMeta;
  range: [number, number];
  onChange: (next: [number, number]) => void;
}) {
  const [lo, hi] = range;
  const unit = meta.unit ? ` ${meta.unit}` : '';
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-neutral-900/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-amber-300">{meta.label}</span>
        <span className="text-[11px] font-mono text-neutral-300">
          {`${lo.toFixed(meta.step < 0.05 ? 2 : 1)} – ${hi.toFixed(meta.step < 0.05 ? 2 : 1)}${unit}`}
        </span>
      </div>
      <ParameterSlider
        label="Min"
        value={lo}
        min={meta.min}
        max={meta.max}
        step={meta.step}
        onChange={(v) => onChange([v, Math.max(v, hi)])}
      />
      <ParameterSlider
        label="Max"
        value={hi}
        min={meta.min}
        max={meta.max}
        step={meta.step}
        onChange={(v) => onChange([Math.min(lo, v), v])}
      />
    </div>
  );
}

/** Fixable context parameters: check Fixed to pin the value, uncheck to let the solver vary it. */
export function ContextControls({
  params,
  contextFixed,
  measure,
  onPatchParams,
  onToggleFixed,
  onSyncMeasured,
}: {
  params: CompliantParams;
  contextFixed: ContextFixedMap;
  measure: MeasureState;
  onPatchParams: (patch: Partial<CompliantParams>) => void;
  onToggleFixed: (key: ContextToggleKey, fixed: boolean) => void;
  onSyncMeasured: (onlyKey?: keyof CompliantParams) => void;
}) {
  const renderToggle = (key: ContextToggleKey, label: string) => {
    const isFixed = contextFixed[key];
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-neutral-400">
          {isFixed ? 'Pinned' : <span className="text-amber-300">Varied by solver</span>}
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300 select-none">
          <input
            type="checkbox"
            checked={isFixed}
            aria-label={`Fix ${label}`}
            onChange={(e) => onToggleFixed(key, e.target.checked)}
            className="accent-amber-500"
          />
          Fixed
        </label>
      </div>
    );
  };

  return (
    <div className="space-y-4 pt-2">
      <p className="text-[10px] leading-snug text-neutral-400">
        Uncheck Fixed on any variable to let the solver vary it and configure its range in the Solver section.
      </p>
      {CONTEXT_VAR_KEYS.map((key) => {
        const meta = CONTEXT_LIMITS[key];
        return (
          <div key={key} className="space-y-1">
            {renderToggle(key, meta.label)}
            <ParameterSlider
              label={meta.unit ? `${meta.label} (${meta.unit})` : meta.label}
              value={params[key]}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              description={meta.description}
              onChange={(v) => onPatchParams({ [key]: v })}
            />
            {key === 'member_depth' && (
              <div className="pt-0.5 flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => onSyncMeasured('member_depth')}
                  disabled={measure.busy}
                  title="Load out-of-plane depth from Onshape (#pend_bar_thickness)"
                  className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-40"
                >
                  <RefreshCw className={`w-3 h-3 ${measure.busy ? 'animate-spin' : ''}`} />
                  {measure.busy ? 'Reading Onshape…' : 'Sync depth from Onshape'}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <div className="space-y-1.5">
        {renderToggle('pivot_inverted', 'Pivot side')}
        <span className="block text-sm text-neutral-300">Pivot side</span>
        <div className="bui-tablist flex w-full" role="group" aria-label="Pivot side">
          {([false, true] as const).map((inv) => (
            <button
              key={String(inv)}
              type="button"
              aria-pressed={params.pivot_inverted === inv}
              onClick={() => onPatchParams({ pivot_inverted: inv })}
              className={`bui-tab flex-1 px-2 py-1 text-xs${params.pivot_inverted === inv ? ' bui-tab--active' : ''}`}
            >
              {inv ? 'Tube side' : 'Far side'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Interactive semicircular arc slider (-90° to +90°, default 0°) for tube pinch attack angle. */
function AttackAngleArcSlider({
  angleDeg,
  onChange,
}: {
  angleDeg: number;
  onChange: (nextDeg: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cx = 24;
  const cy = 54;
  const r = 40;

  const angleFromPointer = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 96;
    const y = ((clientY - rect.top) / rect.height) * 108;
    const dx = Math.max(0.001, x - cx);
    const dy = cy - y; // +up in math coords
    const deg = Math.round(Math.max(-90, Math.min(90, (Math.atan2(dy, dx) * 180) / Math.PI)));
    onChange(deg);
  };

  const rad = (angleDeg * Math.PI) / 180;
  const hx = cx + r * Math.cos(rad);
  const hy = cy - r * Math.sin(rad);

  return (
    <div className="flex items-center gap-3">
      <svg
        ref={svgRef}
        viewBox="0 0 96 108"
        className="w-24 h-24 shrink-0 select-none touch-none cursor-pointer"
        role="slider"
        aria-label="Attack angle arc slider"
        aria-valuemin={-90}
        aria-valuemax={90}
        aria-valuenow={angleDeg}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          angleFromPointer(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) angleFromPointer(e.clientX, e.clientY);
        }}
      >
        {/* Vertical tube wall reference on the left */}
        <rect x={10} y={8} width={10} height={92} rx={2} fill="#ef4444" fillOpacity={0.18} stroke="#ef4444" strokeOpacity={0.45} strokeWidth={1} />
        <line x1={cx} y1={10} x2={cx} y2={98} stroke="#525252" strokeWidth={1} strokeDasharray="3 2" />
        {/* Horizontal 0° reference */}
        <line x1={cx} y1={cy} x2={cx + r + 8} y2={cy} stroke="#525252" strokeWidth={1} strokeDasharray="2 2" />
        {/* Semicircular arc from +90° (top) to -90° (bottom) */}
        <path
          d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`}
          fill="none"
          stroke="#404040"
          strokeWidth={4}
          strokeLinecap="round"
        />
        {/* Active arc from 0° to angleDeg */}
        {angleDeg !== 0 && (
          <path
            d={`M ${cx + r} ${cy} A ${r} ${r} 0 0 ${angleDeg > 0 ? 0 : 1} ${hx} ${hy}`}
            fill="none"
            stroke="#f59e0b"
            strokeWidth={4}
            strokeLinecap="round"
          />
        )}
        {/* Ticks at -90, -45, 0, +45, +90 */}
        {[-90, -45, 0, 45, 90].map((t) => {
          const tr = (t * Math.PI) / 180;
          return (
            <line
              key={t}
              x1={cx + (r - 4) * Math.cos(tr)}
              y1={cy - (r - 4) * Math.sin(tr)}
              x2={cx + (r + 3) * Math.cos(tr)}
              y2={cy - (r + 3) * Math.sin(tr)}
              stroke="#737373"
              strokeWidth={1}
            />
          );
        })}
        {/* Attack vector line */}
        <line x1={cx} y1={cy} x2={hx} y2={hy} stroke="#f59e0b" strokeWidth={2} />
        {/* Pinch center */}
        <circle cx={cx} cy={cy} r={3.5} fill="#34d399" stroke="#0a0a0a" strokeWidth={1} />
        {/* Draggable handle */}
        <circle cx={hx} cy={hy} r={6} fill="#f59e0b" stroke="#ffffff" strokeWidth={1.5} />
        <text x={cx + 6} y={13} fill="#737373" fontSize="8">+90°</text>
        <text x={cx + r + 4} y={cy + 3} fill="#a3a3a3" fontSize="8">0°</text>
        <text x={cx + 6} y={102} fill="#737373" fontSize="8">-90°</text>
      </svg>

      <div className="flex-1 space-y-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-neutral-400">Attack angle</span>
          <span className="font-mono font-bold text-amber-300">
            {angleDeg > 0 ? `+${angleDeg}°` : `${angleDeg}°`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            aria-label="Target attack angle degrees"
            type="number"
            min={-90}
            max={90}
            step={1}
            value={angleDeg}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(Math.max(-90, Math.min(90, Math.round(v))));
            }}
            className="w-16 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-right font-mono text-xs text-white"
          />
          <button
            type="button"
            onClick={() => onChange(0)}
            className="rounded border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-amber-500/60 hover:text-amber-200"
          >
            0°
          </button>
        </div>
        <p className="text-[10px] leading-snug text-neutral-500">
          0° = purely horizontal pinch opening (no vertical shear on tube).
        </p>
      </div>
    </div>
  );
}

/** Dynamic solver bounds (for unlocked context variables) + special geometric/structural constraints. */
export function SolverConstraintsContent({
  contextFixed,
  contextBounds,
  constraints,
  memberStrengthMpa,
  onContextBoundsChange,
  onConstraintsChange,
  onSolve,
  solving,
  solveNote,
  showSolveButton = false,
}: {
  contextFixed: ContextFixedMap;
  contextBounds: Record<ContextVarKey, [number, number]>;
  constraints: SolverConstraints;
  memberStrengthMpa?: number;
  onContextBoundsChange: (key: ContextVarKey, next: [number, number]) => void;
  onConstraintsChange: (patch: Partial<SolverConstraints>) => void;
  onSolve?: () => void;
  solving?: boolean;
  solveNote?: string | null;
  showSolveButton?: boolean;
}) {
  const freeVars = CONTEXT_VAR_KEYS.filter((k) => !contextFixed[k]);
  const freePivot = !contextFixed.pivot_inverted;

  return (
    <div className="space-y-4 pt-2">
      {(freeVars.length > 0 || freePivot) && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-neutral-300">Context ranges</div>
          {freeVars.map((key) => (
            <RangeSliderPair
              key={key}
              meta={CONTEXT_LIMITS[key]}
              range={contextBounds[key]}
              onChange={(next) => onContextBoundsChange(key, next)}
            />
          ))}
          {freePivot && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
              Pivot side unlocked: solver will evaluate both far side and tube side.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-neutral-900/50 p-3">
        <div className="text-xs font-semibold text-emerald-300">Pinch target &amp; attack angle</div>
        <ParameterSlider
          label="Pinch from top of frame (mm)"
          value={constraints.target_pinch_from_top_mm ?? 5.5}
          min={0.5}
          max={16}
          step={0.1}
          secondaryValue={`${(constraints.target_pinch_from_top_mm ?? 5.5).toFixed(1)} mm`}
          description="Locks the closed pinch point P at Y = 0 to this distance below the ceiling (2·h₀). X adjusts dynamically with foot thickness so the real contact face stays aligned."
          onChange={(v) => onConstraintsChange({ target_pinch_from_top_mm: v })}
        />
        <AttackAngleArcSlider
          angleDeg={constraints.target_attack_angle_deg ?? 0}
          onChange={(deg) => onConstraintsChange({ target_attack_angle_deg: deg })}
        />
      </div>

      <div className="space-y-3">
        <div className="text-xs font-semibold text-neutral-300">Special constraints</div>
        <ParameterSlider
          label="Pinch ceiling margin (mm)"
          value={constraints.pinch_ceiling_margin_mm}
          min={0}
          max={8}
          step={0.1}
          secondaryValue={constraints.pinch_ceiling_margin_mm === 0 ? 'off' : `≥ ${constraints.pinch_ceiling_margin_mm.toFixed(1)} mm`}
          description="Minimum distance below the ceiling (2·h₀) for the pinch point, preventing solutions that pinch too high."
          onChange={(v) => onConstraintsChange({ pinch_ceiling_margin_mm: v })}
        />
        <ParameterSlider
          label="Pinch floor margin (mm)"
          value={constraints.pinch_floor_margin_mm}
          min={0}
          max={8}
          step={0.1}
          secondaryValue={constraints.pinch_floor_margin_mm === 0 ? 'off' : `≥ ${constraints.pinch_floor_margin_mm.toFixed(1)} mm`}
          description="Minimum height above the floor (y = 0) for the pinch point."
          onChange={(v) => onConstraintsChange({ pinch_floor_margin_mm: v })}
        />
        <ParameterSlider
          label="Min shell clearance (mm)"
          value={constraints.min_shell_clearance_mm}
          min={0.05}
          max={2}
          step={0.05}
          description="Least gap kept between the compliant part and the housing walls."
          onChange={(v) => onConstraintsChange({ min_shell_clearance_mm: v })}
        />
        <ParameterSlider
          label="Min pivot clearance (mm)"
          value={constraints.min_pivot_clearance_mm}
          min={0.05}
          max={2}
          step={0.05}
          description="Least gap kept between non-eye spans and the carriage pivot pin."
          onChange={(v) => onConstraintsChange({ min_pivot_clearance_mm: v })}
        />
        <ParameterSlider
          label="Min tube clearance L/R (mm)"
          value={constraints.min_tube_clearance_mm}
          min={0}
          max={3}
          step={0.05}
          secondaryValue={constraints.min_tube_clearance_mm === 0 ? 'off' : `≥ ${constraints.min_tube_clearance_mm.toFixed(2)} mm`}
          description="Minimum horizontal clearance kept between Member L/R and Tube A/B across the full stroke."
          onChange={(v) => onConstraintsChange({ min_tube_clearance_mm: v })}
        />
        <ParameterSlider
          label="Max Y=0 gap flex (mm)"
          value={constraints.max_y0_flex_mm}
          min={0}
          max={0.3}
          step={0.01}
          secondaryValue={constraints.max_y0_flex_mm === 0 ? 'seal only' : `≤ ${constraints.max_y0_flex_mm.toFixed(2)} mm`}
          description="Tight tolerance on outward flex at Y = 0 under tube pressure relative to the precalculated (closed_gap − preload) fixed contact point."
          onChange={(v) => onConstraintsChange({ max_y0_flex_mm: v })}
        />
        <ParameterSlider
          label="Max rotation (°)"
          value={constraints.max_rotation_deg}
          min={0}
          max={45}
          step={1}
          secondaryValue={constraints.max_rotation_deg === 0 ? 'no cap' : `≤ ${constraints.max_rotation_deg}°`}
          description="Cap peak beam rotation (linear beam theory is most accurate under ~15°). 0 disables the cap."
          onChange={(v) => onConstraintsChange({ max_rotation_deg: v })}
        />
        <ParameterSlider
          label="Max stress factor"
          value={constraints.stress_limit_factor}
          min={0.1}
          max={1}
          step={0.05}
          secondaryValue={
            memberStrengthMpa != null
              ? `${Math.round(constraints.stress_limit_factor * 100)}% (≤ ${allowableStressMpa(memberStrengthMpa, constraints).toFixed(1)} MPa)`
              : `${Math.round(constraints.stress_limit_factor * 100)}%`
          }
          description="Safety factor on the material max strength (e.g. 0.85 caps allowable stress at 85% of MPa max for solver filtering and pass checks)."
          onChange={(v) => onConstraintsChange({ stress_limit_factor: v })}
        />
      </div>

      {showSolveButton && onSolve && (
        <div className="space-y-2 pt-1">
          <Button
            variant="ghost"
            type="button"
            onClick={onSolve}
            disabled={solving}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/20 px-3 py-2 text-sm font-bold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
          >
            <Target className="w-4 h-4" /> {solving ? 'Solving…' : 'Run solver'}
          </Button>
          {solveNote && <p className="text-xs leading-snug text-neutral-300">{solveNote}</p>}
        </div>
      )}
    </div>
  );
}

/** Mandatory fixed parameters: always pinned by CAD, tubing, or material — never varied by the solver. */
export function FixedParametersSections({
  params,
  wallX,
  materials,
  measure,
  onPatchParams,
  onSyncMeasured,
}: {
  params: CompliantParams;
  wallX: number;
  materials: Material[];
  measure: MeasureState;
  onPatchParams: (patch: Partial<CompliantParams>) => void;
  onSyncMeasured: (onlyKey?: keyof CompliantParams) => void;
}) {
  const activeMaterial = materials.find(
    (m) => m.modulus_mpa === params.member_modulus_mpa && m.strength_mpa === params.member_strength_mpa,
  ) ?? null;

  return (
    <>
      <Accordion title="Fixed: pneumatic & CAD" defaultOpen={false}>
        <div className="space-y-4 pt-2">
          <p className="text-[10px] leading-snug text-neutral-400">
            Imposed by the CAD housing and silicone tube. Never varied by the solver.
          </p>
          <ParameterSlider
            label="Tube centre (mm)"
            value={params.tube_center_x}
            min={3}
            max={16}
            step={0.05}
            secondaryValue={`wall ${wallX.toFixed(2)}`}
            description="Tube axis distance from the screw axis. The tube rests on a wall half an OD further out."
            onChange={(v) => onPatchParams({ tube_center_x: v })}
          />
          <div className="-mt-1 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => onSyncMeasured('tube_center_x')}
              disabled={measure.busy}
              title="Overwrite the tube centre with the value the Onshape Part Studio measures now. The CAD decides this input."
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${measure.busy ? 'animate-spin' : ''}`} />
              {measure.busy ? 'Reading Onshape…' : 'Sync from Onshape'}
            </Button>
            {measure.text && (
              <span className={`text-[10px] ${measure.ok ? 'text-emerald-400' : 'text-red-300'}`} role="status">
                {measure.text}
              </span>
            )}
          </div>
          <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={0.4} max={8} step={0.05} onChange={(v) => onPatchParams({ tube_id: v })} />
          <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={0.6} max={12} step={0.05} onChange={(v) => onPatchParams({ tube_od: v })} />
          <ParameterSlider label="Pressure (kPa)" value={params.input_pressure_kpa} min={0} max={400} step={5} onChange={(v) => onPatchParams({ input_pressure_kpa: v })} secondaryValue="kPa" />
          <ParameterSlider
            label="Chamber vol (mL)"
            value={params.chamber_volume_ml}
            min={0}
            max={200}
            step={0.5}
            secondaryValue={params.chamber_volume_ml === 0 ? 'no traces' : 'mL'}
            description="Volume of the downstream pneumatic chamber used for the inflation & deflation cycle chart."
            onChange={(v) => onPatchParams({ chamber_volume_ml: v })}
          />
          <TubeModelControls
            model={params.tube_model}
            shore={params.tube_shore_a}
            onModel={(tube_model) => onPatchParams({ tube_model })}
            onShore={(tube_shore_a) => onPatchParams({ tube_shore_a })}
          />
          <ParameterSlider
            label="Compliance"
            value={params.compliance}
            min={0.05}
            max={3}
            step={0.05}
            onChange={(v) => onPatchParams({ compliance: v })}
            disabled={params.tube_model !== 'simple'}
            secondaryValue={params.tube_model !== 'simple' ? 'Simple model only' : undefined}
          />
        </div>
      </Accordion>

      <Accordion title="Fixed: material & hardware" defaultOpen={false}>
        <div className="space-y-4 pt-2">
          <p className="text-[10px] leading-snug text-neutral-400">
            Physical properties of the printed material and steel pivot pin. Never varied by the solver.
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="compliant-material" className="shrink-0 text-xs font-semibold text-neutral-400">Material</label>
            <select
              id="compliant-material"
              value={activeMaterial?.name ?? ''}
              onChange={(e) => {
                const chosen = materials.find((m) => m.name === e.target.value);
                if (chosen) onPatchParams({ member_modulus_mpa: chosen.modulus_mpa, member_strength_mpa: chosen.strength_mpa });
              }}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
            >
              {!activeMaterial && <option value="">Custom values</option>}
              {materials.map((m) => (
                <option key={m.name} value={m.name}>{`${m.name} (${(m.modulus_mpa / 1000).toFixed(2)} GPa, ${m.strength_mpa} MPa)`}</option>
              ))}
            </select>
          </div>
          <ParameterSlider label="Modulus (MPa)" value={params.member_modulus_mpa} min={200} max={20000} step={10} onChange={(v) => onPatchParams({ member_modulus_mpa: v })} secondaryValue={`${(params.member_modulus_mpa / 1000).toFixed(2)} GPa`} />
          <ParameterSlider label="Strength (MPa)" value={params.member_strength_mpa} min={1} max={200} step={1} onChange={(v) => onPatchParams({ member_strength_mpa: v })} secondaryValue="MPa" />
          <ParameterSlider label="Pivot pin Ø (mm)" value={params.carriage_pin_diameter} min={0.4} max={4} step={0.05} onChange={(v) => onPatchParams({ carriage_pin_diameter: v })} />
        </div>
      </Accordion>
    </>
  );
}

/** Interactive 2x2 Cartesian quadrant selector (Q2 | Q1 on top, Q3 | Q4 on bottom) + max radius input. */
function QuadrantBoundCard({
  title,
  accent,
  selected,
  radius,
  maxRadius = 8,
  onToggleQuadrant,
  onRadiusChange,
  onHover,
}: {
  title: string;
  accent: string;
  selected: Set<Quadrant>;
  radius: number;
  maxRadius?: number;
  onToggleQuadrant: (q: Quadrant) => void;
  onRadiusChange: (r: number) => void;
  onHover: (active: boolean) => void;
}) {
  const order: Quadrant[] = [2, 1, 3, 4]; // visual Cartesian order: top-left Q2, top-right Q1, bottom-left Q3, bottom-right Q4
  const pinned = selected.size === 0;
  return (
    <div
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-2 space-y-1.5 hover:border-amber-500/60 transition-colors"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] font-semibold truncate" style={{ color: accent }}>{title}</span>
        {pinned && <span className="text-[9px] font-mono text-neutral-500 uppercase">Pinned</span>}
      </div>

      {/* Mini Cartesian 4-quadrant pad */}
      <div className="relative grid grid-cols-2 gap-0.5 rounded bg-neutral-950 p-0.5 border border-neutral-800">
        {order.map((q) => {
          const on = selected.has(q);
          return (
            <button
              key={q}
              type="button"
              aria-pressed={on}
              aria-label={`${title} quadrant Q${q}`}
              onClick={() => onToggleQuadrant(q)}
              className={`h-6 rounded-sm text-[10px] font-mono font-bold transition ${
                on
                  ? 'text-neutral-950 shadow-inner'
                  : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300'
              }`}
              style={on ? { backgroundColor: accent } : undefined}
            >
              Q{q}
            </button>
          );
        })}
        {/* Center pivot dot */}
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white ring-1 ring-neutral-950"
        />
      </div>

      {/* Max radius (hypotenuse) */}
      <div className="flex items-center justify-between gap-1 text-[10px]">
        <span className="text-neutral-400">R max</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            aria-label={`${title} max radius`}
            min={0.1}
            max={maxRadius}
            step={0.25}
            disabled={pinned}
            value={Number(radius.toFixed(2))}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) onRadiusChange(Math.min(maxRadius, v));
            }}
            className="w-12 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-neutral-100 disabled:opacity-40"
          />
          <span className="text-neutral-500">mm</span>
        </div>
      </div>
    </div>
  );
}

/** Compact min/max card for 1D scalar bounds (Anchor, Pinch Y, Thicknesses), with schematic hover. */
function ScalarBoundCell({
  label,
  accent,
  range,
  step,
  unit,
  onChange,
  onHover,
}: {
  label: string;
  accent?: string;
  range: [number, number];
  step: number;
  unit?: string;
  onChange: (next: [number, number]) => void;
  onHover: (active: boolean) => void;
}) {
  return (
    <div
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-2 space-y-1 hover:border-amber-500/60 transition-colors"
    >
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-semibold truncate" style={accent ? { color: accent } : undefined}>
          {label}
        </span>
        {unit && <span className="text-neutral-500">{unit}</span>}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <input
          aria-label={`${label} min`}
          type="number"
          value={range[0]}
          step={step}
          onChange={(e) => onChange([Number(e.target.value), range[1]])}
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-[10px] text-neutral-100"
        />
        <input
          aria-label={`${label} max`}
          type="number"
          value={range[1]}
          step={step}
          onChange={(e) => onChange([range[0], Number(e.target.value)])}
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-[10px] text-neutral-100"
        />
      </div>
    </div>
  );
}

const HANDLE_ANCHOR_LABEL: Record<QuadrantKey, string> = {
  l_1: 'L · H1 (at A)',
  l_2: 'L · H2 (at J)',
  r_1: 'R · H1 (at J)',
  r_2: 'R · H2 (at Pivot)',
  f_1: 'Foot · H1 (at J)',
  f_2: 'Foot · H2 (at P)',
};

/** Quadrant + max-radius grid for spline & skeleton bounds, with live schematic hover highlighting. */
export function SplineBoundsList({
  params,
  bounds,
  quadrantMap,
  constraints,
  onPatchBounds,
  onQuadrantChange,
  onConstraintsChange,
  onHover,
}: {
  params: CompliantParams;
  bounds: Record<ShapeKey, [number, number]>;
  quadrantMap: QuadrantMap;
  constraints: SolverConstraints;
  onPatchBounds: (patch: Partial<Record<ShapeKey, [number, number]>>) => void;
  onQuadrantChange: (key: QuadrantKey, next: QuadrantConfig) => void;
  onConstraintsChange: (patch: Partial<SolverConstraints>) => void;
  onHover: (target: HoveredBoundTarget) => void;
}) {
  const chords = memberChords(params, constraints);
  // Absolute center of the mechanism: X = 0 (screw axis), Y_world = h0 (carriage Y = 0).
  const cxAbs = 0;
  const cyAbs = params.closed_carriage_height;
  const jDx = Number(Math.max(Math.abs(bounds.junction_x[0] - cxAbs), Math.abs(bounds.junction_x[1] - cxAbs)).toFixed(2));
  const jDy = Number(Math.max(Math.abs(bounds.junction_y[0] - cyAbs), Math.abs(bounds.junction_y[1] - cyAbs)).toFixed(2));

  const setJunctionDelta = (dx: number, dy: number) => {
    const xLo = Math.max(LIMITS.junction_x.min, Number((cxAbs - dx).toFixed(2)));
    const xHi = Math.min(LIMITS.junction_x.max, Number((cxAbs + dx).toFixed(2)));
    const yLo = Math.max(LIMITS.junction_y.min, Number((cyAbs - dy).toFixed(2)));
    const yHi = Math.min(LIMITS.junction_y.max, Number((cyAbs + dy).toFixed(2)));
    onPatchBounds({ junction_x: [xLo, Math.max(xLo, xHi)], junction_y: [yLo, Math.max(yLo, yHi)] });
  };

  const exclX = constraints.junction_exclude_x ?? null;
  const exclY = constraints.junction_exclude_y ?? null;

  const handleCard = (member: { id: Member; title: string; color: string }, idx: 1 | 2) => {
    const qKey = `${member.id}_${idx}` as QuadrantKey;
    const uKey = `${member.id}_u${idx}` as ShapeKey;
    const vKey = `${member.id}_v${idx}` as ShapeKey;
    const cfg = quadrantMap[qKey];
    const sel = new Set<Quadrant>(cfg.quadrants);
    const [s, e] = chords[member.id];

    const applyHandle = (nextSel: Set<Quadrant>, r: number) => {
      const quadrants = ([1, 2, 3, 4] as Quadrant[]).filter((q) => nextSel.has(q));
      onQuadrantChange(qKey, { quadrants, radius: r });
      const { u, v } = worldQuadrantsToUV(s, e, idx, quadrants, r, params[uKey] as number, params[vKey] as number);
      onPatchBounds({ [uKey]: u, [vKey]: v });
    };

    const toggleQ = (q: Quadrant) => {
      const next = new Set(sel);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      applyHandle(next, cfg.radius);
    };

    return (
      <QuadrantBoundCard
        key={qKey}
        title={HANDLE_ANCHOR_LABEL[qKey]}
        accent={member.color}
        selected={sel}
        radius={cfg.radius}
        onToggleQuadrant={toggleQ}
        onRadiusChange={(r) => applyHandle(sel, r)}
        onHover={(active) => onHover(active ? qKey : null)}
      />
    );
  };

  return (
    <div className="space-y-3 pt-2">
      <p className="text-[10px] leading-snug text-neutral-400">
        Handles use world-aligned quadrants centered on their endpoint + max radius <span className="font-mono text-neutral-300">R</span> (0 = pinned). Hover any card to preview on the schematic.
      </p>

      {/* Skeleton grid: Junction ±ΔX / ±ΔY centered on (0, h0) + forbidden zone, then Anchor & Pinch */}
      <div className="space-y-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Skeleton</div>
        <div
          onMouseEnter={() => onHover('junction')}
          onMouseLeave={() => onHover(null)}
          className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-2.5 space-y-2 hover:border-amber-500/60 transition-colors"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-neutral-200">Junction (J)</span>
            <span className="text-[9px] font-mono text-neutral-400">
              center (0, {cyAbs.toFixed(1)} mm)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="flex items-center justify-between gap-1">
              <span className="text-neutral-400">±ΔX</span>
              <div className="flex items-center gap-1">
                <input
                  aria-label="Junction plus minus X"
                  type="number"
                  min={0}
                  max={12}
                  step={0.25}
                  value={jDx}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0) setJunctionDelta(v, jDy);
                  }}
                  className="w-12 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-neutral-100"
                />
                <span className="text-neutral-500">mm</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="text-neutral-400">±ΔY</span>
              <div className="flex items-center gap-1">
                <input
                  aria-label="Junction plus minus Y"
                  type="number"
                  min={0}
                  max={14}
                  step={0.25}
                  value={jDy}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v >= 0) setJunctionDelta(jDx, v);
                  }}
                  className="w-12 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-neutral-100"
                />
                <span className="text-neutral-500">mm</span>
              </div>
            </div>
          </div>
          <div className="text-[9px] font-mono text-neutral-500 flex justify-between">
            <span>X [{bounds.junction_x[0]}..{bounds.junction_x[1]}]</span>
            <span>Y [{bounds.junction_y[0]}..{bounds.junction_y[1]}]</span>
          </div>

          {/* Optional forbidden zone (splits search grid into sub-zones) */}
          <div className="border-t border-neutral-800 pt-2 space-y-1.5 text-[10px]">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-red-300/90">
              Forbidden zone (split grid)
            </div>
            <div className="flex items-center justify-between gap-1.5">
              <label className="flex items-center gap-1 text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={exclX !== null}
                  onChange={(e) => onConstraintsChange({ junction_exclude_x: e.target.checked ? [-2.0, 2.0] : null })}
                  className="accent-red-500"
                />
                <span>Forbid X</span>
              </label>
              {exclX && (
                <div className="flex items-center gap-1">
                  <input
                    aria-label="Forbidden X min"
                    type="number"
                    step={0.25}
                    value={exclX[0]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v)) onConstraintsChange({ junction_exclude_x: [v, Math.max(v + 0.1, exclX[1])] });
                    }}
                    className="w-12 rounded border border-red-500/40 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-red-200"
                  />
                  <span className="text-neutral-500">..</span>
                  <input
                    aria-label="Forbidden X max"
                    type="number"
                    step={0.25}
                    value={exclX[1]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v)) onConstraintsChange({ junction_exclude_x: [Math.min(exclX[0], v - 0.1), v] });
                    }}
                    className="w-12 rounded border border-red-500/40 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-red-200"
                  />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-1.5">
              <label className="flex items-center gap-1 text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={exclY !== null}
                  onChange={(e) => onConstraintsChange({
                    junction_exclude_y: e.target.checked ? [Number((cyAbs - 2).toFixed(1)), Number((cyAbs + 2).toFixed(1))] : null,
                  })}
                  className="accent-red-500"
                />
                <span>Forbid Y</span>
              </label>
              {exclY && (
                <div className="flex items-center gap-1">
                  <input
                    aria-label="Forbidden Y min"
                    type="number"
                    step={0.25}
                    value={exclY[0]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v)) onConstraintsChange({ junction_exclude_y: [v, Math.max(v + 0.1, exclY[1])] });
                    }}
                    className="w-12 rounded border border-red-500/40 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-red-200"
                  />
                  <span className="text-neutral-500">..</span>
                  <input
                    aria-label="Forbidden Y max"
                    type="number"
                    step={0.25}
                    value={exclY[1]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v)) onConstraintsChange({ junction_exclude_y: [Math.min(exclY[0], v - 0.1), v] });
                    }}
                    className="w-12 rounded border border-red-500/40 bg-neutral-950 px-1 py-0.5 text-right font-mono text-[10px] text-red-200"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(() => {
            const sym = constraints.anchor_symmetric === true;
            const [aLo, aHi] = anchorSymmetricRange(bounds.anchor_distance);
            const fmtN = (n: number) => Number(n.toFixed(2));
            return (
              <div
                onMouseEnter={() => onHover('anchor')}
                onMouseLeave={() => onHover(null)}
                className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-2 space-y-1 hover:border-amber-500/60 transition-colors"
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold truncate" style={{ color: '#f59e0b' }}>
                    Anchor (A)
                  </span>
                  <span className="text-neutral-500">mm</span>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <input
                    aria-label="Anchor (A) min"
                    type="number"
                    value={bounds.anchor_distance[0]}
                    step={LIMITS.anchor_distance.step}
                    onChange={(e) => onPatchBounds({ anchor_distance: [Number(e.target.value), bounds.anchor_distance[1]] })}
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-[10px] text-neutral-100"
                  />
                  <input
                    aria-label="Anchor (A) max"
                    type="number"
                    value={bounds.anchor_distance[1]}
                    step={LIMITS.anchor_distance.step}
                    onChange={(e) => onPatchBounds({ anchor_distance: [bounds.anchor_distance[0], Number(e.target.value)] })}
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-[10px] text-neutral-100"
                  />
                </div>
                <label className="flex items-center gap-1 pt-0.5 text-[10px] text-neutral-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    aria-label="Symmetric anchor range around center"
                    checked={sym}
                    onChange={(e) => onConstraintsChange({ anchor_symmetric: e.target.checked })}
                    className="accent-amber-500"
                  />
                  <span>Symmetric (±)</span>
                </label>
                {sym && aHi > 0 && (
                  <div className="text-[9px] font-mono text-amber-300/80 leading-tight">
                    {aLo > 0
                      ? `[${fmtN(-aHi)}..${fmtN(-aLo)}] & [${fmtN(aLo)}..${fmtN(aHi)}]`
                      : `[${fmtN(-aHi)}..${fmtN(aHi)}]`}
                  </div>
                )}
              </div>
            );
          })()}
          {constraints.target_pinch_from_top_mm != null ? (
            <div
              onMouseEnter={() => onHover('pinch')}
              onMouseLeave={() => onHover(null)}
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2 space-y-1 transition-colors hover:border-emerald-400/70"
            >
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-semibold text-emerald-300 truncate">Pinch Y (P)</span>
                <span className="font-mono text-[9px] uppercase text-emerald-400">Locked</span>
              </div>
              <div className="font-mono text-[11px] font-semibold text-neutral-100">
                {effectivePinchY(params, constraints).toFixed(2)} mm
              </div>
              <div className="text-[9px] leading-tight text-neutral-400">
                Fixed to P_goal at Y = 0
              </div>
            </div>
          ) : (
            <ScalarBoundCell
              label="Pinch Y (P)"
              accent="#34d399"
              range={bounds.pinch_y}
              step={LIMITS.pinch_y.step}
              unit="mm"
              onChange={(next) => onPatchBounds({ pinch_y: next })}
              onHover={(active) => onHover(active ? 'pinch' : null)}
            />
          )}
        </div>
      </div>

      {/* Bézier Handles grid (2 columns × 3 members = 6 compact cards) */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Bézier handles</div>
        <div className="grid grid-cols-2 gap-2">
          {MEMBERS.flatMap((member) => ([1, 2] as const).map((idx) => handleCard(member, idx)))}
        </div>
      </div>

      {/* Thicknesses grid */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Thicknesses</div>
        <div className="grid grid-cols-3 gap-1.5">
          {MEMBERS.map((member) => {
            const key = `${member.id}_thickness` as ShapeKey;
            const target = `${member.id}_thickness` as HoveredBoundTarget;
            return (
              <ScalarBoundCell
                key={key}
                label={member.title.replace('Member ', '')}
                accent={member.color}
                range={bounds[key]}
                step={LIMITS[key].step}
                onChange={(next) => onPatchBounds({ [key]: next })}
                onHover={(active) => onHover(active ? target : null)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Runners list returned by the solver. */
export function SolverRunners({
  runners,
  onApply,
}: {
  runners: Runner[];
  onApply: (runner: Runner) => void;
}) {
  if (runners.length <= 1) return null;
  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-xs font-semibold text-neutral-400">Alternative solutions</div>
      {runners.slice(1).map((runner, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onApply(runner)}
          className="w-full text-left text-xs px-2.5 py-1.5 rounded-lg border border-neutral-700 bg-neutral-900/50 text-neutral-300 hover:border-amber-500/60 hover:text-neutral-100"
        >
          {`Slope ${runner.slope == null ? '—' : runner.slope.toFixed(2)} · stress ${runner.max_stress_mpa == null ? '—' : runner.max_stress_mpa.toFixed(0)} MPa`}
          {runner.chamber_t100_ms != null ? ` · t100 ${runner.chamber_t100_ms.toFixed(0)} ms (${runner.chamber_cycle_freq_hz?.toFixed(2) ?? '—'} Hz)` : ''}
          {runner.pinch_ceiling_margin_mm != null ? ` · ceil ${runner.pinch_ceiling_margin_mm.toFixed(1)} mm` : ''}
        </button>
      ))}
    </div>
  );
}

/** Multi-goal & optional weight-distribution + time-budget selector for the compliant solver. */
export function SolverGoalBudgetControls({
  goalConfig,
  timeBudgetS,
  onGoalConfigChange,
  onTimeBudgetChange,
}: {
  goalConfig: SolverGoalConfig;
  timeBudgetS: number;
  onGoalConfigChange: (next: SolverGoalConfig) => void;
  onTimeBudgetChange: (seconds: number) => void;
}) {
  const [editingBudget, setEditingBudget] = useState(false);
  const [draftSec, setDraftSec] = useState(String(timeBudgetS));
  const { selected, useWeights, weights } = goalConfig;
  const multi = selected.length > 1;
  const rawSum = selected.reduce((acc, g) => acc + (useWeights ? Math.max(0, weights[g]) : 1), 0) || 1;

  const fmtBudget = (sec: number) => {
    if (sec < 60) return `${sec} s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const r = sec % 60;
      return r === 0 ? `${m} min` : `${m}m${r}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m === 0 ? `${h} h` : `${h}h${m}m`;
  };

  const commitDraft = () => {
    const v = parseFloat(draftSec);
    if (Number.isFinite(v) && v >= 1) {
      onTimeBudgetChange(Math.min(3600, Math.round(v)));
    }
    setEditingBudget(false);
  };

  const isCustomBudget = !TIME_BUDGET_PRESETS.some((p) => p.seconds === timeBudgetS);
  const budgetOptions = [
    ...TIME_BUDGET_PRESETS.map((p) => ({ ...p, custom: false })),
    ...(isCustomBudget
      ? [{ label: fmtBudget(timeBudgetS), seconds: timeBudgetS, hint: 'Custom duration', custom: true }]
      : []),
  ].sort((a, b) => a.seconds - b.seconds);

  const toggleGoal = (g: SolverGoal) => {
    const has = selected.includes(g);
    if (has && selected.length === 1) return; // keep at least one goal
    const nextSel = has ? selected.filter((x) => x !== g) : [...selected, g];
    onGoalConfigChange({ ...goalConfig, selected: nextSel });
  };

  const setWeight = (g: SolverGoal, val: number) => {
    onGoalConfigChange({
      ...goalConfig,
      weights: { ...weights, [g]: Math.max(1, Math.min(100, val)) },
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-neutral-700 bg-neutral-900/50 p-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-neutral-300">
            Solving goals ({selected.length})
          </span>
          {multi && (
            <label className="flex items-center gap-1.5 text-[11px] text-amber-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useWeights}
                onChange={(e) => onGoalConfigChange({ ...goalConfig, useWeights: e.target.checked })}
                className="accent-amber-500"
              />
              <span>Custom weights</span>
            </label>
          )}
        </div>

        <div className="space-y-1.5">
          {ALL_SOLVER_GOALS.map((g) => {
            const on = selected.includes(g);
            const sharePct = on
              ? Math.round(((useWeights ? Math.max(0, weights[g]) : 1) / rawSum) * 100)
              : 0;
            return (
              <div
                key={g}
                className={`rounded-lg border px-2 py-1.5 transition-colors ${
                  on ? 'border-amber-500/40 bg-amber-500/10' : 'border-neutral-800 bg-neutral-950/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleGoal(g)}
                      className="accent-amber-500 shrink-0"
                    />
                    <span className={`truncate ${on ? 'text-neutral-100 font-medium' : 'text-neutral-400'}`}>
                      {SOLVER_GOAL_META[g].label}
                    </span>
                  </label>
                  {on && multi && (
                    <span className="font-mono text-[10px] font-bold text-amber-300 shrink-0">
                      {sharePct}%
                    </span>
                  )}
                </div>
                {on && multi && useWeights && (
                  <div className="mt-1.5 flex items-center gap-2 pl-5">
                    <input
                      aria-label={`Weight for ${SOLVER_GOAL_META[g].label}`}
                      type="range"
                      min={5}
                      max={100}
                      step={5}
                      value={weights[g]}
                      onChange={(e) => setWeight(g, Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer h-1.5"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {selected.length === 1 && (
          <p className="text-[10px] leading-snug text-neutral-400">
            {SOLVER_GOAL_META[selected[0]].description}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-neutral-300 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-amber-400" /> Time budget
          </span>
          {editingBudget ? (
            <div className="flex items-center gap-1">
              <input
                aria-label="Custom time budget in seconds"
                type="number"
                min={1}
                max={3600}
                step={5}
                autoFocus
                value={draftSec}
                onChange={(e) => setDraftSec(e.target.value)}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft();
                  if (e.key === 'Escape') setEditingBudget(false);
                }}
                className="w-16 rounded border border-amber-500/70 bg-neutral-950 px-1.5 py-0.5 text-right font-mono text-[11px] text-amber-200 focus:outline-none"
              />
              <span className="font-mono text-[10px] text-neutral-400">s</span>
            </div>
          ) : (
            <button
              type="button"
              title="Click to enter a custom duration in seconds"
              onClick={() => { setDraftSec(String(timeBudgetS)); setEditingBudget(true); }}
              className="rounded border border-dashed border-neutral-700 px-1.5 py-0.5 font-mono text-[11px] text-amber-300 hover:border-amber-500/70 hover:bg-amber-500/10 transition"
            >
              {fmtBudget(timeBudgetS)}
            </button>
          )}
        </div>
        <div className={`grid gap-1 ${budgetOptions.length > 5 ? 'grid-cols-6' : 'grid-cols-5'}`}>
          {budgetOptions.map((preset) => {
            const active = timeBudgetS === preset.seconds;
            return (
              <button
                key={`${preset.custom ? 'custom-' : ''}${preset.seconds}`}
                type="button"
                title={preset.hint}
                onClick={() => onTimeBudgetChange(preset.seconds)}
                className={`rounded border px-1 py-1 text-[11px] font-semibold transition truncate ${
                  preset.custom ? 'border-dashed ' : ''
                }${
                  active
                    ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Saved solving experiments history. */
export function SolveExperimentsList({
  experiments,
  onOpen,
  onDelete,
}: {
  experiments: SolveExperimentSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (experiments.length === 0) {
    return (
      <p className="text-[11px] text-neutral-500 pt-1">
        No saved solving experiments yet. Every solve run is saved here automatically.
      </p>
    );
  }
  return (
    <div className="space-y-1.5 pt-2">
      {experiments.map((exp) => (
        <div
          key={exp.id}
          className="flex items-center justify-between gap-2 rounded-lg border border-neutral-700 bg-neutral-900/60 px-2.5 py-2 text-xs"
        >
          <button
            type="button"
            onClick={() => onOpen(exp.id)}
            className="min-w-0 flex-1 text-left hover:text-amber-200"
          >
            <div className="font-semibold text-neutral-200 truncate">{exp.name}</div>
            <div className="text-[10px] font-mono text-neutral-400 truncate">
              {SOLVER_GOAL_META[exp.goal]?.short ?? exp.goal} · {exp.feasible}/{exp.tested} valid · {exp.elapsed_s.toFixed(0)}s
            </div>
            {exp.note && <div className="text-[10px] text-neutral-500 truncate">{exp.note}</div>}
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onOpen(exp.id)}
              title="Inspect experiment"
              className="rounded border border-neutral-700 p-1 text-neutral-300 hover:border-amber-500/60 hover:text-amber-300"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(exp.id)}
              title="Delete experiment"
              className="rounded border border-neutral-700 p-1 text-neutral-400 hover:border-red-500/60 hover:text-red-300"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Results summary accordion, matching LinkageExplorer's Results panel. */
export function ResultsAccordion({
  params,
  result,
  constraints,
}: {
  params: CompliantParams;
  result: CompliantResult | null;
  constraints?: SolverConstraints;
}) {
  const maxAllowed = allowableStressMpa(params.member_strength_mpa, constraints);
  const factorPct = Math.round((constraints?.stress_limit_factor ?? 1) * 100);
  return (
    <Accordion title="Results" defaultOpen={true}>
      <div className="space-y-2 pt-2">
        <StatRow
          label="ΔX @ Y = 0.25 mm"
          value={result?.dx_at_025_mm == null ? '—' : `${result.dx_at_025_mm.toFixed(3)} mm`}
          highlight
        />
        <StatRow
          label="Attack angle (α)"
          value={result?.attack_angle_deg == null ? '—' : `${result.attack_angle_deg > 0 ? '+' : ''}${result.attack_angle_deg.toFixed(1)}°`}
        />
        <StatRow label="Flow slope" value={result?.flow_slope_mean == null ? '—' : `${result.flow_slope_mean.toFixed(2)} L/min/mm`} />
        <StatRow label="Peak slope" value={result?.flow_slope_max == null ? '—' : `${result.flow_slope_max.toFixed(2)} L/min/mm`} />
        <StatRow
          label="Open / 90% Y"
          value={`${result?.y_open_mm != null ? result.y_open_mm.toFixed(2) : '—'} / ${result?.y_90_mm != null ? result.y_90_mm.toFixed(2) : '—'} mm`}
        />
        {(result?.chamber_t50_ms != null || result?.chamber_t90_ms != null) && (
          <StatRow
            label="Chamber 50% / 90%"
            value={`${result.chamber_t50_ms != null ? result.chamber_t50_ms.toFixed(0) : '—'} / ${result.chamber_t90_ms != null ? result.chamber_t90_ms.toFixed(0) : '—'} ms`}
          />
        )}
        <StatRow
          label="Inflate 0 → 100%"
          value={
            result?.chamber_t100_ms != null
              ? `${result.chamber_t100_ms.toFixed(0)} ms (${(result.chamber_t100_ms / 1000).toFixed(2)} s)`
              : '—'
          }
          highlight={result?.chamber_t100_ms != null}
        />
        <StatRow
          label="Pass freq / BW (-3 dB)"
          value={
            result?.chamber_cycle_freq_hz != null && result?.chamber_bandwidth_hz != null
              ? `${result.chamber_cycle_freq_hz.toFixed(2)} Hz / ${result.chamber_bandwidth_hz.toFixed(2)} Hz`
              : '—'
          }
          highlight={result?.chamber_cycle_freq_hz != null}
        />
        <StatRow
          label="Worst stress"
          value={
            result?.max_stress_mpa == null
              ? '—'
              : factorPct < 100
                ? `${result.max_stress_mpa.toFixed(1)} / ${maxAllowed.toFixed(1)} MPa (${factorPct}%)`
                : `${result.max_stress_mpa.toFixed(1)} / ${params.member_strength_mpa} MPa`
          }
          highlight={result ? !result.plastic_ok : false}
        />
        <StatRow label="Shell clearance" value={mm(result?.shell_clearance_mm)} highlight={result ? !result.shell_ok : false} />
        <StatRow label="Tube clearance (L/R)" value={mm(result?.tube_clearance_mm)} highlight={result?.tube_ok === false} />
        {result?.crossing_ok === false && (
          <StatRow label="Member crossing" value="Crossing detected" highlight={true} />
        )}
        <StatRow
          label="Y=0 gap / flex"
          value={result?.gap_y0_mm == null ? '—' : `${result.gap_y0_mm.toFixed(3)} mm (+${(result.flex_y0_mm ?? 0).toFixed(3)})`}
          highlight={result?.sealed_at_y0 === false}
        />
        <StatRow label="Pivot clearance" value={mm(result?.pivot_clearance_mm)} highlight={result ? !result.pivot_ok : false} />
        <StatRow label="Pinch ceiling margin" value={mm(result?.pinch_ceiling_margin_mm)} highlight={result?.pinch_ok === false} />
        <StatRow
          label="Largest rotation"
          value={result?.max_rotation_deg == null ? '—' : `${result.max_rotation_deg.toFixed(1)}°`}
          highlight={result?.rotation_ok === false}
        />
      </div>
    </Accordion>
  );
}
