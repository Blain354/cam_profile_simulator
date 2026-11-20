import type { TubeSweep } from './tubeSweep';

/**
 * A synthetic FEM sweep for tests: a 3 x 2 mm tube whose section, at plate distance h, is an outer
 * ellipse of height h and an inner ellipse of height h - 1 (the two walls), shut at h <= 1.
 * Solved from h = 3 down to 0.6, n points per quarter.
 */
export function syntheticSweep(n = 9): TubeSweep {
  const h = [3, 2.5, 2, 1.5, 1.2, 1, 0.8, 0.6];
  const ellipse = (a: number, b: number) => Array.from({ length: n }, (_, k) => {
    const t = (Math.PI / 2) * k / (n - 1);
    return [a * Math.cos(t), b * Math.sin(t)];
  }).flat();
  const outer = h.map((v) => ellipse(1.5 * 3 / (v + 1.5), v / 2));
  const inner = h.map((v) => ellipse(1.5 * 3 / (v + 1.5) - 0.5, Math.max(v / 2 - 0.5, 0)));
  return {
    od: 3, id: 2, e_mpa: 2.46, pressure_kpa: 0, bore_area_mm2: Math.PI,
    h_contact: 3, h_closed: 1, h_sealed: 1, full_open_gap: 2.5, h_min_solved: 0.6,
    n, h,
    force_per_mm: h.map((v) => (3 - v) * 2),
    pressure_share_per_mm: h.map(() => 0),
    open_area_mm2: h.map((v) => (v > 1 ? Math.PI * (v - 1) / 2 : 0)),
    outer, inner,
    deep: { h: [0.4, 0.2], force_per_mm: [20, 100], pressure_share_per_mm: [0, 0] },
  };
}
