import { useMemo } from 'react';
import type { ReactElement } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { SlidersHorizontal } from 'lucide-react';
import type { ChartDomainSettings } from '../components';
import { ChartCard } from '../ChartCard';
import { TubeSectionCard } from '../TubeModel';
import { chartDomain, sameDomainSettings } from '../lib/chartDomain';
import {
  DEFAULT_CHART_SETTINGS, allowableStressMpa, interpNullable,
} from './types';
import type {
  ChartScaleSettings, CompliantChartKey, CompliantChartSettings, CompliantParams, CompliantResult, SolverConstraints,
} from './types';

const ORANGE = '#f59e0b';
const CYAN = '#22d3ee';
const VIOLET = '#a78bfa';
const TOOLTIP_STYLE = { backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' };
const MARGIN = { top: 6, right: 16, bottom: 18, left: 16 };

/** Same floor as LinkageExplorer so a 210 px grid row always renders the chart cleanly. */
function FitChart({ children }: { children: ReactElement }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={158}>{children}</ResponsiveContainer>;
}

export function CompliantCharts({
  params,
  result,
  constraints,
  yPose,
  chartSettings,
  chartScales,
  onChartSettingsChange,
  onChartScalesChange,
}: {
  params: CompliantParams;
  result: CompliantResult | null;
  constraints?: SolverConstraints;
  yPose: number;
  chartSettings: CompliantChartSettings;
  chartScales: ChartScaleSettings;
  onChartSettingsChange: (key: CompliantChartKey, next: ChartDomainSettings) => void;
  onChartScalesChange: (patch: Partial<ChartScaleSettings>) => void;
}) {
  const chartData = useMemo(() => {
    const ys = result?.Y_positions ?? [];
    return ys.map((y, i) => ({
      y,
      flowA: result?.flow_a?.[i] ?? null,
      flowB: result?.flow_b?.[i] ?? null,
      gapA: result?.gap_a?.[i] ?? null,
      gapB: result?.gap_b?.[i] ?? null,
      rigidA: result?.gap_rigid_a?.[i] ?? null,
      forceA: result?.force_a?.[i] != null && result.force_a[i]! > 0 ? result.force_a[i] : null,
      forceB: result?.force_b?.[i] != null && result.force_b[i]! > 0 ? result.force_b[i] : null,
      stressA: result?.stress_a?.[i] ?? null,
      stressB: result?.stress_b?.[i] ?? null,
    }));
  }, [result]);

  const cycleData = useMemo(() => {
    const ts = result?.time_ms ?? [];
    return ts.map((t, i) => ({
      t: t / 1000,
      flowIn: result?.flow_in_l_min?.[i] ?? 0,
      flowOut: result?.flow_out_l_min?.[i] ?? 0,
      kpa: result?.chamber_kpa?.[i] ?? 0,
      y: result?.y_time?.[i] ?? 0,
    }));
  }, [result]);

  const stroke = params.stroke;

  const xAxisY = (c: ChartDomainSettings) => {
    // Per-card manual X overrides shared X scale; otherwise shared lockX keeps all charts aligned.
    const useSharedX = c.autoX && chartScales.lockX && chartScales.xRangeMm > 0;
    const domain = useSharedX
      ? ([-chartScales.xRangeMm, chartScales.xRangeMm] as [number, number])
      : chartDomain(c, 'x', ['dataMin', 'dataMax']);
    return (
      <XAxis
        dataKey="y"
        type="number"
        domain={domain}
        allowDataOverflow={!c.autoX || useSharedX}
        stroke="#888"
        label={{ value: 'Carriage Y (mm)', position: 'bottom', fill: '#888', offset: 0 }}
        tickFormatter={(v) => Number(v).toFixed(1)}
      />
    );
  };

  const safeStrokeMarkers = () => (
    <>
      <ReferenceArea
        x1={-stroke}
        x2={stroke}
        fill="#10b981"
        fillOpacity={0.05}
        ifOverflow="extendDomain"
      />
      <ReferenceLine
        x={stroke}
        stroke="#10b981"
        strokeDasharray="4 3"
        strokeOpacity={0.65}
        label={{ value: `+${stroke.toFixed(2)}`, fill: '#10b981', fontSize: 10, position: 'insideTopRight' }}
      />
      <ReferenceLine
        x={-stroke}
        stroke="#10b981"
        strokeDasharray="4 3"
        strokeOpacity={0.65}
        label={{ value: `-${stroke.toFixed(2)}`, fill: '#10b981', fontSize: 10, position: 'insideTopLeft' }}
      />
    </>
  );

  const cardProps = (key: CompliantChartKey) => ({
    settings: chartSettings[key],
    onSettingsChange: (next: ChartDomainSettings) => onChartSettingsChange(key, next),
    modified: !sameDomainSettings(chartSettings[key], DEFAULT_CHART_SETTINGS[key]),
  });

  const gapAtPose = result && result.Y_positions.length > 0
    ? interpNullable(yPose, result.Y_positions, result.gap_a)
    : null;

  const flowYDomain = (c: ChartDomainSettings) => {
    if (!c.autoY) return chartDomain(c, 'y');
    if (chartScales.lockFlowY && chartScales.flowYMax > 0) return [0, chartScales.flowYMax] as [number, number];
    return ['auto', 'auto'] as [string, string];
  };

  const riseLabel = (() => {
    const parts: string[] = [];
    if (result?.chamber_t50_ms != null || result?.chamber_t90_ms != null) {
      parts.push(
        `t50 ${result?.chamber_t50_ms != null ? `${result.chamber_t50_ms.toFixed(0)} ms` : '—'} / t90 ${result?.chamber_t90_ms != null ? `${result.chamber_t90_ms.toFixed(0)} ms` : '—'}`,
      );
    }
    if (result?.chamber_t100_ms != null) {
      parts.push(`t100 ${result.chamber_t100_ms.toFixed(0)} ms`);
    }
    if (result?.chamber_cycle_freq_hz != null && result?.chamber_bandwidth_hz != null) {
      parts.push(`f ${result.chamber_cycle_freq_hz.toFixed(2)} Hz · BW ${result.chamber_bandwidth_hz.toFixed(2)} Hz`);
    }
    return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  })();

  return (
    <div data-pane="charts" className="lg:col-span-5 min-w-0 flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
      {/* Shared chart scale settings bar */}
      <div className="shrink-0 rounded-xl border border-neutral-700 bg-neutral-800/90 px-3 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs">
        <div className="flex items-center gap-1.5 text-neutral-300 font-semibold">
          <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />
          <span>Chart scales</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Operating X scale */}
          <label className="flex items-center gap-1.5 text-neutral-300 select-none">
            <input
              type="checkbox"
              checked={chartScales.lockX}
              onChange={(e) => onChartScalesChange({ lockX: e.target.checked })}
              className="accent-amber-500"
            />
            <span className="text-[11px] text-neutral-400">X ±mm</span>
            <input
              type="number"
              min={0.2}
              max={10}
              step={0.25}
              disabled={!chartScales.lockX}
              value={chartScales.xRangeMm}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v > 0) onChartScalesChange({ xRangeMm: v });
              }}
              className="w-16 rounded border border-neutral-600 bg-neutral-900 px-1.5 py-0.5 text-right font-mono text-[11px] text-white disabled:opacity-40"
              aria-label="Operating X scale in mm"
            />
          </label>

          {/* Constant Flow Y scale */}
          <label className="flex items-center gap-1.5 text-neutral-300 select-none">
            <input
              type="checkbox"
              checked={chartScales.lockFlowY}
              onChange={(e) => onChartScalesChange({ lockFlowY: e.target.checked })}
              className="accent-amber-500"
            />
            <span className="text-[11px] text-neutral-400">Flow Y max</span>
            <input
              type="number"
              min={1}
              max={200}
              step={1}
              disabled={!chartScales.lockFlowY}
              value={chartScales.flowYMax}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v > 0) onChartScalesChange({ flowYMax: v });
              }}
              className="w-16 rounded border border-neutral-600 bg-neutral-900 px-1.5 py-0.5 text-right font-mono text-[11px] text-white disabled:opacity-40"
              aria-label="Flow Y max in L/min"
            />
            <span className="text-[10px] text-neutral-500">L/min</span>
          </label>

          {/* Operational safe stroke badge */}
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono text-emerald-300"
            title="Operational safe carriage stroke (connected to main Stroke parameter)"
          >
            Safe stroke ±{stroke.toFixed(2)} mm
          </span>
        </div>
      </div>

      <div className="grid auto-rows-[minmax(210px,1fr)] gap-4">
        <ChartCard title="Static flow vs carriage Y" {...cardProps('flow')}>
          {({ settings: c }) => (
            <FitChart>
              <LineChart data={chartData} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxisY(c)}
                <YAxis
                  type="number"
                  stroke="#888"
                  domain={flowYDomain(c)}
                  allowDataOverflow={!c.autoY || chartScales.lockFlowY}
                  tickFormatter={(v) => Number(v).toFixed(0)}
                  label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                />
                {safeStrokeMarkers()}
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => `${Number(v).toFixed(3)} L/min`}
                  labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`}
                />
                <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Line type="linear" dataKey="flowA" name="Tube A (supply)" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="flowB" name="Tube B (exhaust)" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </FitChart>
          )}
        </ChartCard>

        {params.chamber_volume_ml > 0 && (
          <ChartCard
            title={`Chamber (${params.chamber_volume_ml} mL): inflation & deflation${riseLabel}`}
            {...cardProps('chamber')}
          >
            {({ settings: c }) => (
              <FitChart>
                <LineChart data={cycleData} margin={MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={chartDomain(c, 'x', ['dataMin', 'dataMax'])}
                    allowDataOverflow={!c.autoX}
                    stroke="#888"
                    label={{
                      value: `Time (s) · ±${stroke.toFixed(2)} mm stroke`,
                      position: 'bottom',
                      fill: '#888',
                      offset: 0,
                    }}
                    tickFormatter={(v) => Number(v).toFixed(1)}
                  />
                  <YAxis
                    yAxisId="q"
                    type="number"
                    stroke="#888"
                    domain={chartDomain(c, 'y')}
                    allowDataOverflow={!c.autoY}
                    tickFormatter={(v) => Number(v).toFixed(1)}
                    label={{ value: 'Free air (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                  />
                  <YAxis
                    yAxisId="p"
                    orientation="right"
                    type="number"
                    stroke={VIOLET}
                    domain={[0, Math.max(params.input_pressure_kpa, 10)]}
                    tickFormatter={(v) => Number(v).toFixed(0)}
                    label={{ value: 'Chamber (kPa g)', angle: 90, position: 'insideRight', fill: VIOLET, offset: 10 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v, name) => (name === 'Chamber pressure' ? `${Number(v).toFixed(1)} kPa` : `${Number(v).toFixed(3)} L/min`)}
                    labelFormatter={(l) => `t: ${Number(l).toFixed(2)} s`}
                  />
                  <Legend verticalAlign="top" align="right" height={28} iconSize={9} wrapperStyle={{ fontSize: 10, lineHeight: '13px' }} />
                  <Line yAxisId="q" type="linear" dataKey="flowIn" name="Inflate (tube A)" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                  <Line yAxisId="q" type="linear" dataKey="flowOut" name="Deflate (tube B)" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
                  <Line yAxisId="p" type="linear" dataKey="kpa" name="Chamber pressure" stroke={VIOLET} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </FitChart>
            )}
          </ChartCard>
        )}

        <ChartCard title="Pinch gap vs carriage Y" {...cardProps('gap')}>
          {({ settings: c }) => (
            <FitChart>
              <LineChart data={chartData} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxisY(c)}
                <YAxis
                  type="number"
                  stroke="#888"
                  domain={chartDomain(c, 'y', ['auto', 'auto'])}
                  allowDataOverflow={!c.autoY}
                  tickFormatter={(v) => Number(v).toFixed(1)}
                  label={{ value: 'Foot to wall (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                />
                {safeStrokeMarkers()}
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => `${Number(v).toFixed(3)} mm`}
                  labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`}
                />
                {result?.closed_gap != null && (
                  <ReferenceLine y={result.closed_gap} stroke="#ef4444" strokeDasharray="3 3"
                    label={{ value: 'closed', fill: '#ef4444', fontSize: 11, position: 'insideBottomRight' }} />
                )}
                {result?.full_open_gap != null && (
                  <ReferenceLine y={result.full_open_gap} stroke="#10b981" strokeDasharray="3 3"
                    label={{ value: 'full bore', fill: '#10b981', fontSize: 11, position: 'insideTopRight' }} />
                )}
                <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Line type="linear" dataKey="rigidA" name="Tube A, rigid" stroke={ORANGE} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="gapA" name="Tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="gapB" name="Tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </FitChart>
          )}
        </ChartCard>

        <TubeSectionCard
          tube={params}
          h={gapAtPose}
          where={`tube A at Y = ${yPose.toFixed(2)} mm`}
          {...cardProps('section')}
        />

        <ChartCard title="Pinch force vs carriage Y" {...cardProps('force')}>
          {({ settings: c }) => (
            <FitChart>
              <LineChart data={chartData} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxisY(c)}
                <YAxis
                  type="number"
                  stroke="#888"
                  scale="log"
                  domain={c.autoY ? [0.1, 'auto'] : [Math.max(c.yMin, 1e-3), c.yMax]}
                  allowDataOverflow
                  tickFormatter={(v) => String(Number(v))}
                  label={{ value: 'Force (N)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                />
                {safeStrokeMarkers()}
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => `${Number(v).toFixed(2)} N`}
                  labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`}
                />
                <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Line type="linear" dataKey="forceA" name="Foot on tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="forceB" name="Foot on tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </FitChart>
          )}
        </ChartCard>

        <ChartCard title="Worst stress in the part vs carriage Y" {...cardProps('stress')}>
          {({ settings: c }) => (
            <FitChart>
              <LineChart data={chartData} margin={MARGIN}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                {xAxisY(c)}
                <YAxis
                  type="number"
                  stroke="#888"
                  domain={chartDomain(c, 'y')}
                  allowDataOverflow={!c.autoY}
                  tickFormatter={(v) => Number(v).toFixed(0)}
                  label={{ value: 'Stress (MPa)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }}
                />
                {safeStrokeMarkers()}
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => `${Number(v).toFixed(1)} MPa`}
                  labelFormatter={(l) => `Y: ${Number(l).toFixed(3)} mm`}
                />
                <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine
                  y={params.member_strength_mpa}
                  stroke="#ef4444"
                  strokeDasharray="3 3"
                  label={{ value: 'strength', fill: '#ef4444', fontSize: 11, position: 'insideTopRight' }}
                />
                {(constraints?.stress_limit_factor ?? 1) < 0.999 && (
                  <ReferenceLine
                    y={allowableStressMpa(params.member_strength_mpa, constraints)}
                    stroke="#f59e0b"
                    strokeDasharray="4 2"
                    label={{
                      value: `limit (${Math.round((constraints?.stress_limit_factor ?? 1) * 100)}%)`,
                      fill: '#f59e0b',
                      fontSize: 10,
                      position: 'insideBottomRight',
                    }}
                  />
                )}
                <Line type="linear" dataKey="stressA" name="Part on tube A" stroke={ORANGE} strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="stressB" name="Part on tube B" stroke={CYAN} strokeWidth={3} dot={false} isAnimationActive={false} />
                <ReferenceLine x={yPose} stroke="var(--bui-text)" strokeDasharray="5 5" strokeWidth={2} />
              </LineChart>
            </FitChart>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
