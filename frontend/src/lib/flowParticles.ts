import { useSyncExternalStore } from 'react';

/**
 * Flow particles: a fixed pool of particles per tube. Both their density (particles per unit of
 * tube length) and their speed are proportional to the tube's flow, normalised by a reference flow:
 * zero flow shows none and nothing moves, the reference flow shows the whole pool at full speed.
 */

/** Particles per tube at the reference flow. */
export const MAX_PARTICLES = 80;
/** Tube lengths travelled per second at the reference flow: side view along the tube, section view through the slice. */
export const FULL_SPEED = { side: 0.6, section: 1.2 } as const;

export type ParticleView = keyof typeof FULL_SPEED;

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const fract = (v: number) => v - Math.floor(v);

/** Flow as a share of the reference flow, in 0..1; 0 when either is missing. */
export function flowFraction(flow: number | null | undefined, reference: number | null | undefined): number {
  if (flow == null || reference == null || !Number.isFinite(flow) || !Number.isFinite(reference) || reference <= 0) return 0;
  return clamp01(flow / reference);
}

/**
 * Static flow through the full bore, pi (ID/2)^2, from a simulated flow-vs-area series: the static
 * model is linear in area, so any sample with an open area gives it. 0 when no sample is open.
 */
export function fullBoreFlow(flow: readonly number[], area: readonly number[], tubeId: number): number {
  let best = -1;
  for (let i = 0; i < Math.min(flow.length, area.length); i++) {
    if (area[i] > 0 && Number.isFinite(flow[i]) && (best < 0 || area[i] > area[best])) best = i;
  }
  return best < 0 ? 0 : flow[best] / area[best] * Math.PI * (tubeId / 2) ** 2;
}

/** How many of the pool are shown at flow fraction `f`: the density along the tube is this over the tube length. */
export function visibleCount(f: number): number {
  return clamp01(f) * MAX_PARTICLES;
}

/** Particle speed, in tube lengths per second, at flow fraction `f`. */
export function particleSpeed(f: number, view: ParticleView): number {
  return clamp01(f) * FULL_SPEED[view];
}

/** Opacity of particle `i` from the count: the first floor(n) are on, the next fades with the fraction, so the count changes smoothly. */
export function countOpacity(i: number, f: number): number {
  return clamp01(visibleCount(f) - i);
}

// Low-discrepancy (R2) placement: any first k particles are spread evenly along and across the tube.
const G = 1.324717957244746;
/** Fixed position of particle `i`: along the tube (0..1) at phase 0, across the open bore (0..1), and along the slot of a section (0..1). */
export function seed(i: number): { along: number; across: number; spread: number } {
  return { along: fract(0.5 + (i + 1) / G), across: fract(0.5 + (i + 1) / (G * G)), spread: fract(0.5 + (i + 1) * 0.6180339887498949) };
}

/** Bore samples along the tube, increasing `s`: [s, lo, hi] with lo..hi the open bore across the tube. */
export type Bore = ReadonlyArray<readonly [number, number, number]>;

/** Open bore lo..hi at `s`, interpolated between samples. */
export function boreAt(bore: Bore, s: number): [number, number] {
  const n = bore.length;
  if (n === 0) return [0, 0];
  if (s <= bore[0][0]) return [bore[0][1], bore[0][2]];
  if (s >= bore[n - 1][0]) return [bore[n - 1][1], bore[n - 1][2]];
  let a = 0, b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (bore[m][0] <= s) a = m; else b = m;
  }
  const span = bore[b][0] - bore[a][0];
  const t = span > 0 ? (s - bore[a][0]) / span : 0;
  return [bore[a][1] + (bore[b][1] - bore[a][1]) * t, bore[a][2] + (bore[b][2] - bore[a][2]) * t];
}

export interface Placed { x: number; y: number; r: number; fade: number }

/** Narrowest open bore over s0..s1: the largest lo and the smallest hi, at the ends and every sample between. */
function boreOver(bore: Bore, s0: number, s1: number): [number, number] {
  let [lo, hi] = boreAt(bore, s0);
  const [lo1, hi1] = boreAt(bore, s1);
  lo = Math.max(lo, lo1); hi = Math.min(hi, hi1);
  for (const [s, l, h] of bore) {
    if (s > s0 && s < s1) { lo = Math.max(lo, l); hi = Math.min(hi, h); }
  }
  return [lo, hi];
}

/**
 * Side view: the tube runs along y over the bore's s range; particle at `along` (0..1) sits across
 * the bore still open over its whole height (s +- radius), its radius cut to half that opening, so
 * it squeezes through a pinch and never cuts into a sloping wall or past the tube's ends.
 * Fades in and out over the last few percent at each end of the drawn tube.
 */
export function placeSide(bore: Bore, along: number, across: number, radius: number): Placed | null {
  const n = bore.length;
  if (n === 0) return null;
  // Centres kept one radius from the cut ends, so no particle sticks out of the drawn tube.
  const s0 = bore[0][0] + radius, s1 = bore[n - 1][0] - radius;
  if (!(s1 > s0)) return null;
  const s = s0 + (s1 - s0) * along;
  const [lo, hi] = boreOver(bore, s - radius, s + radius);
  const open = hi - lo;
  if (!(open > 1e-3)) return null;
  const r = Math.min(radius, open / 2);
  return { x: lo + r + (open - 2 * r) * across, y: s, r, fade: Math.min(1, along / 0.04, (1 - along) / 0.04) };
}

/**
 * Section view: the bore is the rectangle |x| <= width/2, |y| <= length/2 (corners rounded up to
 * width/2) and the air crosses it perpendicular to the screen. A particle at depth `along` (0..1)
 * through a thin slice of the tube fades in, then out, and shrinks as it moves away.
 */
export function placeSection(width: number, length: number, along: number, across: number, spread: number, radius: number): Placed | null {
  if (!(width > 1e-3) || !(length > 1e-3)) return null;
  const r = Math.min(radius, width / 2) * (1 - 0.4 * along);
  const my = Math.min(Math.max(r, width / 2), length / 2);
  return { x: -width / 2 + r + (width - 2 * r) * across, y: -length / 2 + my + (length - 2 * my) * spread, r, fade: Math.sin(Math.PI * along) };
}

/**
 * Section view through a real bore: `bore` samples the opening across the section, [s, lo, hi] with s
 * along the plates and lo..hi the open bore normal to them (from the FEM outline). The particle sits
 * at `spread` along s and `across` the opening still free over its own size, so it stays in the
 * open lobes of a closing bore; it fades in, then out, and shrinks with depth as placeSection.
 */
export function placeSectionBore(bore: Bore, along: number, across: number, spread: number, radius: number): Placed | null {
  const n = bore.length;
  if (n === 0) return null;
  const s0 = bore[0][0], s1 = bore[n - 1][0];
  if (!(s1 > s0)) return null;
  const s = s0 + (s1 - s0) * spread;
  const [lo, hi] = boreOver(bore, s - radius, s + radius);
  const open = hi - lo;
  if (!(open > 1e-3)) return null;
  const r = Math.min(radius, open / 2) * (1 - 0.4 * along);
  return { x: lo + r + (open - 2 * r) * across, y: s, r, fade: Math.sin(Math.PI * along) };
}

// ─── One shared animation loop ───────────────────────────────────

type Tick = (dt: number) => void;
const ticks = new Set<Tick>();
let frame = 0;
let last: number | null = null;

function run(now: number) {
  frame = 0;
  // A long gap (tab back in view, loop restarted) moves particles by one short step, not a jump.
  const dt = last == null ? 0 : Math.min((now - last) / 1000, 0.1);
  last = now;
  ticks.forEach((t) => t(dt));
  if (ticks.size > 0 && frame === 0) frame = requestAnimationFrame(run);
  if (ticks.size === 0) last = null;
}

/** Runs `tick` on every animation frame, all diagrams sharing one requestAnimationFrame loop; returns the stop. */
export function onFrame(tick: Tick): () => void {
  ticks.add(tick);
  if (frame === 0) frame = requestAnimationFrame(run);
  return () => {
    ticks.delete(tick);
    if (ticks.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = null;
    }
  };
}

/** Subscribers of the shared loop, for tests. */
export function runningTicks(): number {
  return ticks.size;
}

// ─── Settings ────────────────────────────────────────────────────

const KEY = 'cam-sim.flow-particles.v1';
let memory = true;
const listeners = new Set<() => void>();

function readOn(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v == null ? memory : v !== '0';
  } catch {
    return memory;
  }
}

export function setFlowParticlesOn(on: boolean) {
  memory = on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage blocked: kept for this page only */ }
  listeners.forEach((l) => l());
}

function subscribeOn(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The "Flow particles" switch, shared by every schematic and remembered in localStorage; on by default. */
export function useFlowParticlesOn(): boolean {
  return useSyncExternalStore(subscribeOn, readOn, () => true);
}

const REDUCE = '(prefers-reduced-motion: reduce)';

function reduceQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE) : null;
  } catch {
    return null;
  }
}

function subscribeReduce(l: () => void) {
  const q = reduceQuery();
  if (!q || typeof q.addEventListener !== 'function') return () => {};
  q.addEventListener('change', l);
  return () => q.removeEventListener('change', l);
}

/** The viewer asked for reduced motion: particles are then drawn still, at the same density. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => !!reduceQuery()?.matches, () => false);
}
