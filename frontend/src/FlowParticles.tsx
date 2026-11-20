import { Button } from '@blain-projects/ui';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Bore, ParticleView } from './lib/flowParticles';
import {
  MAX_PARTICLES, countOpacity, onFrame, particleSpeed, placeSection, placeSide, seed,
  setFlowParticlesOn, useFlowParticlesOn, usePrefersReducedMotion,
} from './lib/flowParticles';

export type FlowParticlesProps = {
  /** Flow of this tube over its reference flow, 0..1: sets both the density and the speed. */
  frac: number;
  color: string;
  /** Largest particle radius, in drawing units; cut to half the open bore. */
  radius: number;
  /** Maps the particles' local frame into the drawing. */
  transform?: string;
} & (
  /** Along the tube: local y is the tube axis, local x across it; the air runs toward +y (direction 1) or -y (-1). */
  | { view: 'side'; bore: Bore; direction: 1 | -1 }
  /** Tube cross-section, air perpendicular to the screen: the open bore is |x| <= width/2, |y| <= length/2. */
  | { view: 'section'; width: number; length: number }
);

const SEEDS = Array.from({ length: MAX_PARTICLES }, (_, i) => seed(i));

/** Particles in an SVG tube, their density and speed proportional to the flow; nothing when the "Flow particles" switch is off. */
export function FlowParticles(props: FlowParticlesProps) {
  const on = useFlowParticlesOn();
  return on ? <ParticleLayer {...props} /> : null;
}

function ParticleLayer(props: FlowParticlesProps) {
  const reduced = usePrefersReducedMotion();
  const group = useRef<SVGGElement>(null);
  const latest = useRef(props);
  // How far the pool has moved, and what lets the loop run.
  const st = useRef({ phase: 0, inView: true, docVisible: true, reduced, stop: null as null | (() => void) });

  const draw = () => {
    const g = group.current;
    if (!g) return;
    const p = latest.current, s = st.current;
    const f = p.frac;
    const dots = g.children;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const c = dots[i];
      if (!c) break;
      const a = countOpacity(i, f);
      const along = ((SEEDS[i].along + s.phase) % 1 + 1) % 1;
      const at = a <= 0 ? null : p.view === 'side'
        ? placeSide(p.bore, along, SEEDS[i].across, p.radius)
        : placeSection(p.width, p.length, along, SEEDS[i].across, SEEDS[i].spread, p.radius);
      if (!at || at.fade <= 0) { c.setAttribute('opacity', '0'); continue; }
      c.setAttribute('cx', at.x.toFixed(4));
      c.setAttribute('cy', at.y.toFixed(4));
      c.setAttribute('r', at.r.toFixed(4));
      c.setAttribute('opacity', (0.85 * a * at.fade).toFixed(3));
    }
  };

  const tick = (dt: number) => {
    const p = latest.current, s = st.current;
    const view: ParticleView = p.view;
    const dir = p.view === 'side' ? p.direction : 1;
    s.phase = (s.phase + dir * particleSpeed(p.frac, view) * dt) % 1;
    draw();
    sync();
  };

  // The loop runs only while something moves and the drawing can be seen.
  const sync = () => {
    const s = st.current;
    const run = !s.reduced && s.inView && s.docVisible && latest.current.frac > 0;
    if (run && !s.stop) s.stop = onFrame(tick);
    else if (!run && s.stop) { s.stop(); s.stop = null; }
  };

  useLayoutEffect(() => {
    latest.current = props;
    st.current.reduced = reduced;
    draw();
    sync();
  });

  useEffect(() => {
    const s = st.current;
    const onVisibility = () => { s.docVisible = !document.hidden; sync(); };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    // A hidden tab or card (display: none, as the Cam Finder when another tab shows) stops the loop.
    const svg = group.current?.ownerSVGElement;
    const io = svg && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { s.inView = entries[entries.length - 1].isIntersecting; sync(); })
      : null;
    if (io && svg) io.observe(svg);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      io?.disconnect();
      s.stop?.();
      s.stop = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount and unmount only; the loop reads the latest props from refs
  }, []);

  return (
    <g ref={group} transform={props.transform} fill={props.color} pointerEvents="none" data-flow-particles={props.view}>
      {SEEDS.map((_, i) => <circle key={i} r={0} opacity={0} />)}
    </g>
  );
}

/** On/off switch for the flow particles of every schematic; `note` adds what the schematic's particles mean to its tooltip. */
export function FlowParticlesSwitch({ note }: { note?: string }) {
  const on = useFlowParticlesOn();
  return (
    <Button variant="ghost" type="button" role="switch" aria-checked={on} onClick={() => setFlowParticlesOn(!on)}
      title={`Particles in each tube, their density and speed proportional to the computed flow.${note ? ` ${note}` : ''}`}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-neutral-700 px-2 py-1 text-xs font-bold text-neutral-200 hover:bg-neutral-700/40">
      <span aria-hidden="true" className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-600' : 'bg-neutral-600'}`}>
        <span className={`h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3' : ''}`} />
      </span>
      Flow particles
    </Button>
  );
}
