import { ParameterSlider } from './components';
import type { ChartDomainSettings } from './components';
import { ChartCard } from './ChartCard';
import { SubTabs } from './SubTabs';
import { shoreToMpa } from './lib/tubeModel';
import type { TubeModel, TubeSpec } from './lib/tubeModel';
import { sectionAt, sweepExtent, useTubeSweep } from './lib/tubeSweep';
import type { SectionAt } from './lib/tubeSweep';

/**
 * The tube model switch (finite-element section or the simple compliance law), the hardness the
 * FEM needs, and the card that draws the FEM section. All FEM-specific UI lives in this file and
 * in lib/tubeModel.ts (values and hooks).
 */


const MODEL_OPTIONS: { value: TubeModel; label: string }[] = [
  { value: 'fem', label: 'FEM' },
  { value: 'simple', label: 'Simple' },
];

export function TubeModelControls({ model, shore, onModel, onShore, modelModified, shoreModified }: {
  model: TubeModel;
  shore: number;
  onModel: (m: TubeModel) => void;
  onShore: (s: number) => void;
  modelModified?: boolean;
  shoreModified?: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3"
        title="FEM: the tube's squeezed section is solved by finite elements (silicone, plane strain). Simple: the empirical compliance law.">
        <span className={`text-sm font-medium tracking-tight ${modelModified ? 'text-amber-400' : 'text-neutral-300'}`}>Tube model</span>
        <SubTabs label="Tube model" value={model} options={MODEL_OPTIONS} onChange={onModel} />
      </div>
      <ParameterSlider label="Tube hardness (Shore A)" value={shore} min={10} max={90} step={1} onChange={onShore}
        disabled={model !== 'fem'} isModified={shoreModified}
        secondaryValue={model === 'fem' ? `E ${shoreToMpa(shore).toFixed(2)} MPa` : 'FEM only'}
        description="Silicone hardness. The FEM takes Young's modulus from it by Gent's relation, and treats it as nearly incompressible (Poisson ratio 0.4995)." />
    </>
  );
}

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(4)},${(-y).toFixed(4)}`).join(' ') + ' Z';

function SectionDrawing({ s, frame, settings, big }: { s: SectionAt; frame: { halfW: number; halfH: number }; settings: ChartDomainSettings; big: boolean }) {
  // View: one frame per tube (its widest squeeze and its free height), so the tube deforms in a still
  // frame as h moves, unless the cog sets the bounds. Past first contact the frame opens to keep the plates in.
  const halfW = frame.halfW * 1.08;
  const halfH = Math.max(frame.halfH * 1.25, s.h / 2 * 1.1) + 0.1;
  const x0 = settings.autoX ? -halfW : settings.xMin, x1 = settings.autoX ? halfW : settings.xMax;
  const y0 = settings.autoY ? -halfH : settings.yMin, y1 = settings.autoY ? halfH : settings.yMax;
  const plate = Math.max((y1 - y0) * 0.06, 0.05);
  const stroke = (x1 - x0) / 300;
  const shut = !(s.open_area_mm2 > 0);
  return (
    <svg viewBox={`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full"
      role="img" aria-label={`Tube section squeezed to ${s.h.toFixed(3)} mm${s.extrapolated ? ', extrapolated' : ''}`}>
      <line x1={x0} x2={x1} y1={0} y2={0} stroke="#737373" strokeWidth={stroke * 0.6} strokeDasharray={`${stroke * 6} ${stroke * 4}`} />
      <rect x={x0} y={-(s.h / 2) - plate} width={x1 - x0} height={plate} fill="#737373" />
      <rect x={x0} y={s.h / 2} width={x1 - x0} height={plate} fill="#737373" />
      <path d={path(s.outer)} fill="#d4a373" fillOpacity={0.85} stroke="#b07a45" strokeWidth={stroke} strokeLinejoin="round" />
      {/* Shut, the bore is the seam where the inner wall rests on itself: drawn as a line */}
      <path d={path(s.inner)} fill="#3b82f6" fillOpacity={0.55} stroke={shut ? '#dc2626' : '#2563eb'} strokeWidth={shut ? stroke * 1.5 : stroke} strokeLinejoin="round" />
      {big && <text x={x0 + (x1 - x0) * 0.01} y={-(s.h / 2) - plate - (y1 - y0) * 0.015} fontSize={(y1 - y0) * 0.035} fill="#737373">plate</text>}
    </svg>
  );
}

/** The card: deformed section (outer and inner outline), the two plates, the open bore shaded. */
export function TubeSectionCard({ tube, h, where, settings, onSettingsChange, modified, className }: {
  tube: TubeSpec;
  /** Plate distance: pin (or cam) to wall, mm. */
  h: number | null;
  /** What h is, for the caption: "tube A at Y = 0.50 mm". */
  where: string;
  settings: ChartDomainSettings;
  onSettingsChange: (next: ChartDomainSettings) => void;
  modified?: boolean;
  className?: string;
}) {
  // The sweep is fetched once per tube; the section at h is interpolated on every render, so the card
  // follows the slider and Oscillate frame by frame.
  const { sweep, error } = useTubeSweep(tube);
  const fem = tube.tube_model === 'fem';
  const section = sweep && h != null && Number.isFinite(h) ? sectionAt(sweep, h) : null;
  const frame = sweep ? sweepExtent(sweep) : null;
  return (
    <ChartCard title="Tube section" maximizedTitle={`Tube section, ${where}`} settingsTitle="Tube section view bounds"
      settings={settings} onSettingsChange={onSettingsChange} modified={modified} maximizeLabel="Expand tube section" className={className}>
      {({ maximized }) => (
        <div className="flex h-full min-h-[120px] flex-col gap-1">
          {!fem ? (
            <p className="m-auto max-w-xs text-center text-xs text-neutral-400">The section is drawn by the FEM tube model. Set Tube model to FEM to see it.</p>
          ) : error ? (
            <p className="m-auto max-w-xs text-center text-xs text-red-300" role="alert">{error}</p>
          ) : !sweep ? (
            <p className="m-auto text-xs text-neutral-400">Solving the tube…</p>
          ) : !section || !frame ? (
            <p className="m-auto text-xs text-neutral-400">No gap at this carriage position.</p>
          ) : (
            <>
              <div className="min-h-0 flex-1"><SectionDrawing s={section} frame={frame} settings={settings} big={maximized} /></div>
              <div className={`grid shrink-0 grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 font-mono leading-tight text-neutral-300 ${maximized ? 'text-sm' : 'text-[11px]'}`}>
                <span className="truncate" title={where}>h {section.h.toFixed(3)} mm <span className="text-neutral-500">({where})</span></span>
                <span className="truncate">{section.force_per_mm.toFixed(3)} N/mm <span className="text-neutral-500">({section.pressure_share_per_mm.toFixed(3)} from air)</span></span>
                <span className="truncate">{section.open_area_mm2 > 0 ? `bore ${section.open_area_mm2.toFixed(3)} / ${sweep.bore_area_mm2.toFixed(2)} mm²` : 'bore shut'}</span>
                <span className="truncate">shuts at {sweep.h_sealed.toFixed(3)} mm <span className="text-neutral-500">({sweep.h_closed.toFixed(3)} at 0 kPa)</span></span>
                {section.extrapolated && (
                  <span className="sm:col-span-2 truncate text-amber-400" title={`The FEM is solved down to h = ${sweep.h_min_solved.toFixed(3)} mm. Below, the shape is its deepest one flattened to h and the force follows a nearly incompressible strip (F ~ 1/h³).`}>
                    extrapolated below {sweep.h_min_solved.toFixed(3)} mm
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </ChartCard>
  );
}
