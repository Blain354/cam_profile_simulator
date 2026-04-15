import * as Slider from '@radix-ui/react-slider';
import { ParameterSlider, DelayedHoverHint } from './components';

export type SearchSampleMode = 'count' | 'step';

export interface SearchGridAxisControlsProps {
  title: string;
  /** Tailwind accent for border / mode buttons when active */
  accent: 'emerald' | 'sky' | 'violet' | 'red';
  axisMin: number;
  axisMax: number;
  onAxisMin: (v: number) => void;
  onAxisMax: (v: number) => void;
  /** Hard limits for the min slider */
  limitMinLow: number;
  limitMinHigh: number;
  /** Hard limits for the max slider */
  limitMaxLow: number;
  limitMaxHigh: number;
  fix: boolean;
  onFix: (v: boolean) => void;
  fixedValue: number;
  onFixed: (v: number) => void;
  sampleMode: SearchSampleMode;
  onSampleMode: (m: SearchSampleMode) => void;
  countValue: number;
  onCount: (v: number) => void;
  countMin: number;
  countMax: number;
  stepValue: number;
  onStep: (v: number) => void;
  stepMin: number;
  stepMax: number;
  stepSliderStep: number;
  /** Step for min/max bound sliders */
  boundStep?: number;
  description?: React.ReactNode;
  /** Suffix for equivalent step text (e.g. " mm"); omit for unitless axes like K */
  axisUnit?: string;
}

/** Compact display for equivalent step / spacing. */
function trimNiceNumber(x: number, maxDecimals = 5): string {
  if (!Number.isFinite(x)) return '—';
  return parseFloat(x.toFixed(maxDecimals)).toString();
}

const accentRing: Record<SearchGridAxisControlsProps['accent'], string> = {
  emerald: 'border-emerald-700/50',
  sky: 'border-sky-700/50',
  violet: 'border-violet-700/50',
  red: 'border-red-700/50',
};

const accentBtn: Record<SearchGridAxisControlsProps['accent'], string> = {
  emerald: 'bg-emerald-600 text-white ring-1 ring-emerald-500/60',
  sky: 'bg-sky-600 text-white ring-1 ring-sky-500/60',
  violet: 'bg-violet-600 text-white ring-1 ring-violet-500/60',
  red: 'bg-red-600 text-white ring-1 ring-red-500/60',
};

const accentFill: Record<SearchGridAxisControlsProps['accent'], string> = {
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  red: 'bg-red-500',
};

/** Radix thumbs (track + range from the primitive — consistent alignment) */
const thumbClass: Record<SearchGridAxisControlsProps['accent'], string> = {
  emerald:
    'block h-3.5 w-3.5 cursor-grab rounded-full border-2 border-emerald-400 bg-emerald-500 shadow-md ring-neutral-900 hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 active:cursor-grabbing',
  sky: 'block h-3.5 w-3.5 cursor-grab rounded-full border-2 border-sky-400 bg-sky-500 shadow-md ring-neutral-900 hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/80 active:cursor-grabbing',
  violet:
    'block h-3.5 w-3.5 cursor-grab rounded-full border-2 border-violet-400 bg-violet-500 shadow-md ring-neutral-900 hover:bg-violet-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/80 active:cursor-grabbing',
  red: 'block h-3.5 w-3.5 cursor-grab rounded-full border-2 border-red-400 bg-red-500 shadow-md ring-neutral-900 hover:bg-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300/80 active:cursor-grabbing',
};

export default function SearchGridAxisControls({
  title,
  accent,
  axisMin,
  axisMax,
  onAxisMin,
  onAxisMax,
  limitMinLow,
  limitMinHigh,
  limitMaxLow,
  limitMaxHigh,
  fix,
  onFix,
  fixedValue,
  onFixed,
  sampleMode,
  onSampleMode,
  countValue,
  onCount,
  countMin,
  countMax,
  stepValue,
  onStep,
  stepMin,
  stepMax,
  stepSliderStep,
  boundStep = 0.05,
  description,
  axisUnit = '',
}: SearchGridAxisControlsProps) {
  const lo = Math.min(axisMin, axisMax);
  const hi = Math.max(axisMin, axisMax);
  const trackMin = limitMinLow;
  const trackMax = limitMaxHigh;
  /** Upper bound for the min thumb (logical max and limitMinHigh). */
  let loMax = Math.max(trackMin, Math.min(trackMax, hi - boundStep, limitMinHigh));
  /** Lower bound for the max thumb. */
  let hiMin = Math.min(trackMax, Math.max(trackMin, lo + boundStep, limitMaxLow));
  if (loMax < hiMin) {
    loMax = hiMin;
  }
  const loClamped = Math.max(trackMin, Math.min(lo, loMax));
  const hiClamped = Math.min(trackMax, Math.max(hi, hiMin));
  const span = hiClamped - loClamped;

  /** Step spacing implied by the current **count** (linspace). Shown under Step when Count mode is active. */
  const stepImpliedByCount =
    span <= 1e-12 || countValue <= 1 ? '—' : `≈ step ${trimNiceNumber(span / (countValue - 1))}${axisUnit}`;

  /** Sample count implied by the current **step**. Shown under Count when Step mode is active. */
  const countImpliedByStep = (() => {
    if (span <= 1e-12) return '≈ 1 pt';
    const st = Math.max(1e-12, stepValue);
    const n = Math.floor(span / st) + 1;
    return `≈ ${n} pts`;
  })();

  const handleRangeChange = (vals: number[]) => {
    const [a, b] = vals;
    let low = Math.min(a, b);
    let high = Math.max(a, b);
    low = Math.max(trackMin, Math.min(loMax, low));
    high = Math.min(trackMax, Math.max(hiMin, high));
    if (low > high - boundStep) {
      high = Math.min(trackMax, low + boundStep);
    }
    onAxisMin(low);
    onAxisMax(high);
  };

  const inner = (
    <div className={`rounded-lg border ${accentRing[accent]} bg-neutral-900/40 p-2.5 space-y-2.5`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">{title}</div>

      <div className={fix ? 'pointer-events-none opacity-45' : ''}>
        <div className="mb-0.5 flex items-center justify-between gap-2">
          <span className="text-xs text-neutral-400">Range (min → max)</span>
          <span className="font-mono text-[11px] text-neutral-400 tabular-nums">
            <span className="text-neutral-200">{loClamped.toFixed(2)}</span>
            <span className="mx-1 text-neutral-600">—</span>
            <span className="text-neutral-200">{hiClamped.toFixed(2)}</span>
          </span>
        </div>
        <Slider.Root
          className="relative flex w-full touch-none select-none items-center py-0.5"
          value={[loClamped, hiClamped]}
          onValueChange={handleRangeChange}
          min={trackMin}
          max={trackMax}
          step={boundStep}
          minStepsBetweenThumbs={1}
          disabled={fix}
          aria-label={title}
        >
          <Slider.Track className="relative h-1.5 w-full grow rounded-full bg-neutral-700">
            <Slider.Range className={`absolute h-full rounded-full opacity-95 ${accentFill[accent]}`} />
          </Slider.Track>
          <Slider.Thumb className={thumbClass[accent]} aria-label={`${title} — minimum`} />
          <Slider.Thumb className={thumbClass[accent]} aria-label={`${title} — maximum`} />
        </Slider.Root>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={fix}
          onChange={(e) => onFix(e.target.checked)}
          className="rounded border-neutral-600 bg-neutral-900 text-emerald-500 focus:ring-emerald-500"
        />
        Fix to a single value (within min–max)
      </label>

      {fix ? (
        <ParameterSlider
          label="Fixed value"
          value={fixedValue}
          min={lo}
          max={hi}
          step={0.05}
          onChange={(v) => onFixed(Math.min(hi, Math.max(lo, v)))}
        />
      ) : (
        <>
          <div className="flex rounded-lg bg-neutral-950/60 p-0.5 ring-1 ring-neutral-700/60">
            <button
              type="button"
              onClick={() => onSampleMode('count')}
              className={`flex min-h-[3.25rem] min-w-0 flex-1 flex-col items-center justify-center rounded-md px-1.5 py-1 text-center transition-all ${
                sampleMode === 'count'
                  ? accentBtn[accent]
                  : 'text-neutral-400 hover:bg-neutral-800/90 hover:text-neutral-200'
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider">Count</span>
              {sampleMode !== 'count' && (
                <span className="mt-0.5 max-w-full truncate px-0.5 text-[10px] leading-tight text-neutral-500">
                  ({countImpliedByStep})
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onSampleMode('step')}
              className={`flex min-h-[3.25rem] min-w-0 flex-1 flex-col items-center justify-center rounded-md px-1.5 py-1 text-center transition-all ${
                sampleMode === 'step'
                  ? accentBtn[accent]
                  : 'text-neutral-400 hover:bg-neutral-800/90 hover:text-neutral-200'
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider">Step</span>
              {sampleMode !== 'step' && (
                <span className="mt-0.5 max-w-full truncate px-0.5 text-[10px] leading-tight text-neutral-500">
                  ({stepImpliedByCount})
                </span>
              )}
            </button>
          </div>
          {sampleMode === 'count' ? (
            <ParameterSlider
              label="Points along axis"
              value={countValue}
              min={countMin}
              max={countMax}
              step={1}
              onChange={(v) => onCount(Math.round(v))}
            />
          ) : (
            <ParameterSlider
              label="Increment"
              value={stepValue}
              min={stepMin}
              max={stepMax}
              step={stepSliderStep}
              onChange={onStep}
            />
          )}
        </>
      )}
    </div>
  );

  if (description) {
    return <DelayedHoverHint content={description}>{inner}</DelayedHoverHint>;
  }
  return inner;
}
