import { useEffect, useState } from 'react';
import { apiFetch } from '../components';
import type { Bore } from './flowParticles';
import type { TubeSpec } from './tubeModel';

/**
 * The FEM tube over its whole sweep of plate distance h, fetched once per tube (POST /api/tube/sweep)
 * and kept here by tube, so the section card and both schematics read the same data and can
 * interpolate the section at any h on every frame without asking the server.
 */

export interface TubeSweep {
  od: number;
  id: number;
  e_mpa: number;
  pressure_kpa: number;
  bore_area_mm2: number;
  h_contact: number;
  h_closed: number;
  h_sealed: number;
  full_open_gap: number;
  h_min_solved: number;
  /** Points per quarter outline. */
  n: number;
  /** Solved plate distances, decreasing. */
  h: number[];
  force_per_mm: number[];
  pressure_share_per_mm: number[];
  open_area_mm2: number[];
  /** At each h, the quarter outline (x >= 0, y >= 0, from the x axis to the y axis) as [x0, y0, x1, y1, ...]. */
  outer: number[][];
  inner: number[][];
  /** Force below the deepest solved step (extrapolated by the backend, no shape). */
  deep: { h: number[]; force_per_mm: number[]; pressure_share_per_mm: number[] };
}

export type Pt = [number, number];

export interface SectionAt {
  h: number;
  /** The whole section, closed outlines (mm, y normal to the plates). */
  outer: Pt[];
  inner: Pt[];
  force_per_mm: number;
  pressure_share_per_mm: number;
  open_area_mm2: number;
  /** Below the deepest solved step: the deepest shape flattened to h, the force from the backend's extrapolation. */
  extrapolated: boolean;
}

/** Where h falls on the decreasing grid hs: blend (1 - t) * [i] + t * [i + 1], clamped to the ends. */
export function bracket(hs: readonly number[], h: number): { i: number; t: number } {
  const n = hs.length;
  if (n < 2 || h >= hs[0]) return { i: 0, t: 0 };
  if (h <= hs[n - 1]) return { i: Math.max(n - 2, 0), t: n < 2 ? 0 : 1 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (hs[m] >= h) lo = m; else hi = m;
  }
  const span = hs[lo] - hs[hi];
  return { i: lo, t: span > 0 ? (hs[lo] - h) / span : 0 };
}

const lerp = (a: readonly number[], i: number, t: number) => (t > 0 && i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * t : a[i]);

/** Quarter outline at h, blended point by point between the two solved steps around it. */
export function quarterAt(q: readonly number[][], hs: readonly number[], h: number): number[] {
  const { i, t } = bracket(hs, h);
  const a = q[i], b = q[Math.min(i + 1, q.length - 1)];
  return t > 0 ? a.map((v, k) => v + (b[k] - v) * t) : a.slice();
}

/** The whole closed outline from a quarter [x0, y0, ...] (x axis to y axis), mirrored on both axes; y scaled by `sy`. */
export function mirror(q: readonly number[], sy = 1): Pt[] {
  const n = q.length >> 1;
  const p = (k: number, fx: number, fy: number): Pt => [fx * q[2 * k], fy * sy * q[2 * k + 1]];
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) out.push(p(k, 1, 1));
  for (let k = n - 2; k >= 0; k--) out.push(p(k, -1, 1));
  for (let k = 1; k < n; k++) out.push(p(k, -1, -1));
  for (let k = n - 2; k > 0; k--) out.push(p(k, 1, -1));
  return out;
}

/** Force tables, solved then extrapolated, as one decreasing grid. */
function forceTable(s: TubeSweep) {
  return {
    h: [...s.h, ...s.deep.h],
    f: [...s.force_per_mm, ...s.deep.force_per_mm],
    p: [...s.pressure_share_per_mm, ...s.deep.pressure_share_per_mm],
  };
}

/** Per-sweep values computed once: the force table and the bore height at each solved step. */
interface Prepared { force: ReturnType<typeof forceTable>; boreH: number[] }
const prepared = new WeakMap<TubeSweep, Prepared>();
function prep(s: TubeSweep): Prepared {
  let p = prepared.get(s);
  if (!p) {
    // Bore height: twice the inner outline's largest y (its extent normal to the plates); 0 once the bore is shut.
    const boreH = s.inner.map((q, k) => {
      if (!(s.open_area_mm2[k] > 0)) return 0;
      let m = 0;
      for (let j = 1; j < q.length; j += 2) m = Math.max(m, q[j]);
      return 2 * m;
    });
    p = { force: forceTable(s), boreH };
    prepared.set(s, p);
  }
  return p;
}

/** The section at plate distance h: interpolated between solved steps, the free (first contact) shape above them, extrapolated below. */
export function sectionAt(s: TubeSweep, h: number): SectionAt {
  const hMin = s.h[s.h.length - 1];
  const extrapolated = h < hMin - 1e-9;
  const at = Math.max(h, hMin);
  const sy = extrapolated ? Math.max(h, 0) / hMin : 1;
  const { i, t } = bracket(s.h, at);
  const ft = prep(s).force;
  const fb = bracket(ft.h, h);
  return {
    h,
    outer: mirror(quarterAt(s.outer, s.h, at), sy),
    inner: mirror(quarterAt(s.inner, s.h, at), sy),
    force_per_mm: h >= s.h[0] ? 0 : lerp(ft.f, fb.i, fb.t),
    pressure_share_per_mm: h >= s.h[0] ? 0 : lerp(ft.p, fb.i, fb.t),
    open_area_mm2: extrapolated ? 0 : lerp(s.open_area_mm2, i, t),
    extrapolated,
  };
}

/** Height of the open bore (mm, normal to the plates) at plate distance h: 0 once shut, the free bore above first contact. */
export function boreHeightAt(s: TubeSweep, h: number): number {
  if (h < s.h[s.h.length - 1]) return 0;
  const { i, t } = bracket(s.h, h);
  return lerp(prep(s).boreH, i, t);
}

/** Largest |x| and the widest |y| over a whole sweep: the view that holds every section of this tube. */
export function sweepExtent(s: TubeSweep): { halfW: number; halfH: number } {
  let halfW = 0, halfH = 0;
  for (const q of s.outer) {
    for (let j = 0; j < q.length; j += 2) { halfW = Math.max(halfW, q[j]); halfH = Math.max(halfH, q[j + 1]); }
  }
  return { halfW, halfH };
}

/**
 * Open bore across the section, for the flow particles: samples [x, -c, c] along the plates, c the
 * bore's half-opening at x (the largest inner-outline y over the segments that span |x|).
 */
export function boreAcross(inner: readonly Pt[], samples = 25): Bore {
  let xMax = 0;
  for (const [x] of inner) xMax = Math.max(xMax, Math.abs(x));
  if (!(xMax > 0)) return [];
  const out: [number, number, number][] = [];
  for (let k = 0; k < samples; k++) {
    const x = -xMax + (2 * xMax * k) / (samples - 1);
    const ax = Math.abs(x);
    let c = 0;
    for (let j = 0; j < inner.length; j++) {
      const [x0, y0] = inner[j], [x1, y1] = inner[(j + 1) % inner.length];
      if (y0 < 0 && y1 < 0) continue;
      const a0 = Math.abs(x0), a1 = Math.abs(x1);
      if ((a0 - ax) * (a1 - ax) > 0) continue;
      const y = a1 !== a0 ? y0 + ((y1 - y0) * (ax - a0)) / (a1 - a0) : Math.max(y0, y1);
      c = Math.max(c, y);
    }
    out.push([x, -c, c]);
  }
  return out;
}

// ─── Fetch, once per tube ─────────────────────────────────────────

export const tubeKey = (t: Pick<TubeSpec, 'tube_od' | 'tube_id' | 'tube_shore_a' | 'input_pressure_kpa'>) =>
  `${t.tube_od}|${t.tube_id}|${t.tube_shore_a}|${t.input_pressure_kpa}`;

const CACHE_SIZE = 16;
const cache = new Map<string, Promise<TubeSweep>>();

/** The sweep of this tube: one request per tube, shared by every caller; a failed request is not kept. */
export function fetchTubeSweep(t: TubeSpec): Promise<TubeSweep> {
  const key = tubeKey(t);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { tube_od, tube_id, tube_shore_a, input_pressure_kpa } = t;
  const p = apiFetch('/api/tube/sweep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tube_od, tube_id, tube_shore_a, input_pressure_kpa }),
  }).then(async (res) => {
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.detail ? String(body.detail) : `HTTP ${res.status}`);
    if (!body || !Array.isArray(body.h) || !Array.isArray(body.outer) || body.outer.length !== body.h.length || body.h.length < 2) {
      throw new Error('No tube sweep in the answer');
    }
    return body as TubeSweep;
  });
  p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return p;
}

/** Forget every fetched sweep (tests). */
export function clearTubeSweeps() {
  cache.clear();
}

/**
 * The FEM sweep of `tube`, or null while it is fetched or when the model is simple. A sweep or an
 * error of another tube (OD, ID, hardness, pressure) is never returned: its shape would pass for
 * the new tube's while that one solves. A new tube is asked for once its values have settled.
 */
export function useTubeSweep(tube: TubeSpec): { sweep: TubeSweep | null; error: string | null } {
  const key = tubeKey(tube);
  const fem = tube.tube_model === 'fem';
  const [answer, setAnswer] = useState<{ key: string; sweep: TubeSweep | null; error: string | null } | null>(null);
  const { tube_od, tube_id, tube_shore_a, input_pressure_kpa, tube_model } = tube;
  useEffect(() => {
    if (!fem) return;
    let live = true;
    const run = () => fetchTubeSweep({ tube_od, tube_id, tube_shore_a, input_pressure_kpa, tube_model })
      .then((sweep) => { if (live) setAnswer({ key, sweep, error: null }); })
      .catch((e) => { if (live) setAnswer({ key, sweep: null, error: e instanceof Error ? e.message : String(e) }); });
    // Already asked for (a slider at rest, another card): no wait. Otherwise wait for the slider to settle.
    const timer = cache.has(key) ? (run(), null) : setTimeout(run, 150);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [fem, key, tube_od, tube_id, tube_shore_a, input_pressure_kpa, tube_model]);
  const current = fem && answer && answer.key === key ? answer : null;
  return { sweep: current?.sweep ?? null, error: current?.error ?? null };
}
