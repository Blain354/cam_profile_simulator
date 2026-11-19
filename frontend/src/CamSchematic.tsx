import { Button } from '@blain-projects/ui';
import { useEffect, useRef, useState } from 'react';
import { Cog, Pause, Play } from 'lucide-react';
import type { ChartDomainSettings, SimulationParams, SimulationResult } from './components';
import { ChartDomainSettingsModal, VerticalSystemSvgDiagram } from './components';

export interface CamTravel {
  y: number;
  setY: (y: number) => void;
  playing: boolean;
  toggle: () => void;
  /** Put on the card: the travel stops by itself once the card is hidden behind another tab. */
  ref: React.RefObject<HTMLDivElement | null>;
  min: number;
  max: number;
  speed: number;
}

/**
 * Carriage position over the simulated Y range, and Oscillate: Y_start to Y_end and back at the
 * simulation's own linear speed (motor speed x lead-screw pitch; the cam model has no load factor).
 */
export function useCamTravel(data: SimulationResult | null): CamTravel {
  const min = data?.Y_positions[0] ?? 0;
  const max = data?.Y_positions[data.Y_positions.length - 1] ?? 0;
  const speed = data?.linear_speed_mm_s ?? 0;
  const [rawY, setRawY] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ d: 0, speed, min, max });
  const y = Math.min(Math.max(rawY, min), max);

  useEffect(() => {
    live.current.speed = speed;
    live.current.min = min;
    live.current.max = max;
  }, [speed, min, max]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let shown = 0;
    const step = (now: number) => {
      const m = live.current;
      const span = m.max - m.min;
      if (m.speed <= 0 || span <= 0 || !ref.current || ref.current.offsetParent === null) { setPlaying(false); return; }
      if (last != null) m.d = (m.d + (now - last) / 1000 * m.speed) % (2 * span);
      last = now;
      if (now - shown > 30) {
        shown = now;
        setRawY(m.min + (m.d <= span ? m.d : 2 * span - m.d));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    // Resume from where the carriage is, on the way up.
    if (!playing) live.current.d = y - min;
    setPlaying(!playing);
  };
  const setY = (v: number) => { setPlaying(false); setRawY(v); };
  return { y, setY, playing, toggle, ref, min, max, speed };
}

/** The cam's schematic card: same header, carriage slider and Oscillate as the linkage tabs. */
export function CamSchematicCard({ id, data, params, travel, details, setDetails, speedNote, domain, onDomainChange }: {
  id: string;
  data: SimulationResult | null;
  params: SimulationParams;
  travel: CamTravel;
  details: boolean;
  setDetails: (on: boolean) => void;
  /** How the speed is obtained, shown next to it. */
  speedNote: string;
  /** View bounds of the drawing, editable behind a cog when `onDomainChange` is given. */
  domain?: ChartDomainSettings;
  onDomainChange?: (next: ChartDomainSettings) => void;
}) {
  const [domainOpen, setDomainOpen] = useState(false);
  return (
    <div ref={travel.ref} className="lg:col-span-4 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0 overflow-y-auto">
      <div className="flex items-center gap-3 mb-3 shrink-0 min-w-0">
        <h3 className="text-sm font-semibold text-neutral-300 min-w-0 flex-1 truncate">Schematic</h3>
        {domain && onDomainChange && (
          <>
            <Button variant="ghost" type="button" onClick={() => setDomainOpen(true)} title="View bounds" aria-label="View bounds"
              className="shrink-0 rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white">
              <Cog className="h-4 w-4" />
            </Button>
            <ChartDomainSettingsModal isOpen={domainOpen} title="Schematic view bounds" settings={domain} onClose={() => setDomainOpen(false)} onChange={onDomainChange} />
          </>
        )}
        <Button variant="ghost" type="button" onClick={() => setDetails(!details)}
          className={`shrink-0 px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}>
          {details ? 'Hide details' : 'Details'}
        </Button>
      </div>
      <div className="order-2 flex-1 min-h-[180px] w-full bg-neutral-900/60 rounded-lg border border-neutral-800/80 overflow-hidden relative">
        {data && data.Y_positions.length > 1
          ? <VerticalSystemSvgDiagram data={data} params={params} details={details} domainOverride={domain} y={travel.y} />
          : <div className="flex h-full items-center justify-center p-4 text-center text-sm text-neutral-400">Loading…</div>}
      </div>
      <div className="order-1 shrink-0 mb-3 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-sm">
          <label htmlFor={`cam-y-${id}`} className="font-medium text-neutral-300">Carriage Y</label>
          <span className="font-mono text-neutral-100">{travel.y.toFixed(2)} mm</span>
        </div>
        <div className="order-last flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={travel.toggle} disabled={travel.speed <= 0 || travel.max <= travel.min} aria-pressed={travel.playing}
            title="Run the carriage over the simulated travel and back at the motor speed"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold disabled:opacity-50 ${travel.playing ? 'border-amber-500 bg-amber-600 text-white' : 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'}`}>
            {travel.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} {travel.playing ? 'Stop' : 'Oscillate'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => travel.setY(0)} disabled={!travel.playing && travel.y === Math.min(Math.max(0, travel.min), travel.max)}
            title="Bring the carriage back to Y = 0"
            className="rounded-lg border border-neutral-700 px-3 py-1 text-xs font-bold text-neutral-200 hover:bg-neutral-700/40 disabled:opacity-50">
            Center
          </Button>
          <span className="text-xs text-neutral-400 text-right">{speedNote}, {travel.speed.toFixed(2)} mm/s</span>
        </div>
        <input id={`cam-y-${id}`} type="range" min={travel.min} max={travel.max} step={0.01} value={travel.y}
          onChange={(e) => travel.setY(parseFloat(e.target.value))} className="w-full accent-amber-500 cursor-pointer" />
      </div>
    </div>
  );
}
