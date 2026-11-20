import type { Bore } from './flowParticles';
import { boreHeightAt } from './tubeSweep';
import type { TubeSweep } from './tubeSweep';

/** Side view of a tube against its wall: (distance from the wall, height along the tube). */
export type Pt = [number, number];

/**
 * Tube thickness (wall to pin side, mm) along its axis once the pin has pressed into it.
 * Under the pin the tube takes the pin's shape; on each side the silicone climbs back to its
 * full diameter along a smooth shoulder. `shoulder` sets that shoulder's length: by default about
 * three quarters of a diameter for a tube pressed flat (the simple model's drawing); the FEM
 * drawing passes one tube OD. `ends` are in (distance from the wall, height) coordinates.
 */
export function tubeProfile(ends: [Pt, Pt] | null, r: number, od: number, y0: number, y1: number, shoulder?: number): Pt[] {
  if (!ends) return [[od, y0], [od, y1]];
  const [[u1, v1], [u2, v2]] = ends;
  const len = Math.hypot(u2 - u1, v2 - v1);
  // Unit normal of the pad that faces the wall.
  let nu = len > 1e-9 ? -(v2 - v1) / len : -1, nv = len > 1e-9 ? (u2 - u1) / len : 0;
  if (nu > 0) { nu = -nu; nv = -nv; }
  const indenter = (v: number) => {
    let u = Infinity;
    for (const [cu, cv] of ends) {
      const d = v - cv;
      if (Math.abs(d) < r) u = Math.min(u, cu - Math.sqrt(r * r - d * d));
    }
    if (Math.abs(v2 - v1) > 1e-9) {
      const t = (v - v1 - r * nv) / (v2 - v1);
      if (t >= 0 && t <= 1) u = Math.min(u, u1 + t * (u2 - u1) + r * nu);
    }
    return u;
  };
  const reach = shoulder ?? od;
  const lo = Math.max(y0, Math.min(v1, v2) - r - reach), hi = Math.min(y1, Math.max(v1, v2) + r + reach);
  if (hi <= lo) return [[od, y0], [od, y1]];
  const n = 140;
  const vs = Array.from({ length: n + 1 }, (_, i) => lo + (hi - lo) * i / n);
  const pressed = vs.map((v) => Math.max(indenter(v), 0.04));
  const pts: Pt[] = [[od, y0]];
  vs.forEach((v, i) => {
    let h = od;
    for (let j = 0; j <= n; j++) {
      const depth = od - pressed[j];
      if (depth <= 0) continue;
      const span = shoulder ?? Math.max(0.25 * od, 0.75 * Math.sqrt(depth * od));
      const t = Math.min(Math.abs(v - vs[j]) / span, 1);
      h = Math.min(h, pressed[j] + depth * t * t * (3 - 2 * t));
    }
    pts.push([i === 0 || i === n ? od : h, v]);
  });
  pts.push([od, y1]);
  return pts;
}

/**
 * Open bore along the tube, [height, lo, hi] measured from the wall, for each profile station [h, height].
 * With the FEM sweep: the bore at each station is the FEM section's bore at the local plate distance h,
 * centred between the wall and the pin (the section is symmetric), its height capped at ID (the free
 * tube's bore, drawn without the pressure's few percent of inflation) and 0 once the section is shut.
 * Without (simple model): the walls keep their thickness and share what is left where the tube is
 * pressed thinner than its two walls.
 */
export function sideBore(profile: readonly Pt[], od: number, id: number, sweep: TubeSweep | null): Bore {
  const skin = (od - id) / 2;
  return profile.map(([h, v]) => {
    if (!sweep) return [v, Math.min(skin, h / 2), Math.max(h - skin, h / 2)] as const;
    const b = h >= od ? id : Math.min(boreHeightAt(sweep, h), id, h);
    return [v, (h - b) / 2, (h + b) / 2] as const;
  });
}
