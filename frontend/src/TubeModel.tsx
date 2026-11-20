import { ParameterSlider } from './components';
import type { ChartDomainSettings } from './components';
import { ChartCard } from './ChartCard';
import { SubTabs } from './SubTabs';
import { shoreToMpa, useSection } from './lib/tubeModel';
import type { Section, TubeModel, TubeSpec } from './lib/tubeModel';

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

function SectionDrawing({ s, settings, big }: { s: Section; settings: ChartDomainSettings; big: boolean }) {
  // View: fitted to the section and both plates, unless the cog sets the bounds.
  const halfW = Math.max(...s.outer.map((p) => Math.abs(p[0]))) * 1.12;
  const halfH = Math.max(...s.outer.map((p) => Math.abs(p[1])), s.h / 2) * 1.25 + 0.1;
  const x0 = settings.autoX ? -halfW : settings.xMin, x1 = settings.autoX ? halfW : settings.xMax;
  const y0 = settings.autoY ? -halfH : settings.yMin, y1 = settings.autoY ? halfH : settings.yMax;
  const plate = Math.max((y1 - y0) * 0.06, 0.05);
  const stroke = (x1 - x0) / 300;
  return (
    <svg viewBox={`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full"
      role="img" aria-label={`Tube section squeezed to ${s.h.toFixed(3)} mm`}>
      <rect x={x0} y={-(s.h / 2) - plate} width={x1 - x0} height={plate} fill="#737373" />
      <rect x={x0} y={s.h / 2} width={x1 - x0} height={plate} fill="#737373" />
      <path d={path(s.outer)} fill="#d4a373" fillOpacity={0.85} stroke="#f5d0a9" strokeWidth={stroke} />
      <path d={path(s.inner)} fill="#3b82f6" fillOpacity={0.55} stroke="#93c5fd" strokeWidth={stroke} />
      <line x1={x0} x2={x1} y1={0} y2={0} stroke="#525252" strokeWidth={stroke * 0.6} strokeDasharray={`${stroke * 6} ${stroke * 4}`} />
      {big && <text x={x0 + (x1 - x0) * 0.02} y={-y1 + (y1 - y0) * 0.06} fontSize={(y1 - y0) * 0.04} fill="#a3a3a3">plate</text>}
    </svg>
  );
}

/** The card: deformed section (outer and inner outline), the two plates, the open bore shaded. */
export function TubeSectionCard({ tube, h, where, settings, onSettingsChange, modified }: {
  tube: TubeSpec;
  /** Plate distance: pin (or cam) to wall, mm. */
  h: number | null;
  /** What h is, for the caption: "tube A at Y = 0.50 mm". */
  where: string;
  settings: ChartDomainSettings;
  onSettingsChange: (next: ChartDomainSettings) => void;
  modified?: boolean;
}) {
  const { section, error } = useSection(tube, h);
  const fem = tube.tube_model === 'fem';
  return (
    <ChartCard title="Tube section" maximizedTitle={`Tube section, ${where}`} settingsTitle="Tube section view bounds"
      settings={settings} onSettingsChange={onSettingsChange} modified={modified} maximizeLabel="Expand tube section">
      {({ maximized }) => (
        <div className="flex h-full min-h-[158px] flex-col gap-1">
          {!fem ? (
            <p className="m-auto max-w-xs text-center text-xs text-neutral-400">The section is drawn by the FEM tube model. Set Tube model to FEM to see it.</p>
          ) : error ? (
            <p className="m-auto max-w-xs text-center text-xs text-red-300" role="alert">{error}</p>
          ) : !section ? (
            <p className="m-auto text-xs text-neutral-400">Solving the tube…</p>
          ) : (
            <>
              <div className="min-h-0 flex-1"><SectionDrawing s={section} settings={settings} big={maximized} /></div>
              <div className={`grid shrink-0 grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-neutral-300 ${maximized ? 'text-sm' : 'text-[11px]'}`}>
                <span>h {section.h.toFixed(3)} mm <span className="text-neutral-500">({where})</span></span>
                <span>{section.force_per_mm.toFixed(3)} N/mm <span className="text-neutral-500">({section.pressure_share_per_mm.toFixed(3)} from air)</span></span>
                <span>bore {section.open_area_mm2.toFixed(3)} / {section.bore_area_mm2.toFixed(2)} mm²</span>
                <span>shuts at {section.h_sealed.toFixed(3)} mm <span className="text-neutral-500">({section.h_closed.toFixed(3)} at 0 kPa)</span></span>
              </div>
            </>
          )}
        </div>
      )}
    </ChartCard>
  );
}
