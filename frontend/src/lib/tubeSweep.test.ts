import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { boreAcross, boreHeightAt, bracket, clearTubeSweeps, fetchTubeSweep, mirror, quarterAt, sectionAt, sweepExtent } from './tubeSweep'
import { syntheticSweep } from './tubeSweep.fixture'
import { placeSectionBore } from './flowParticles'

const S = syntheticSweep()
const maxY = (pts: [number, number][]) => Math.max(...pts.map((p) => p[1]))
const maxX = (pts: [number, number][]) => Math.max(...pts.map((p) => p[0]))

test('the grid bracket is exact at every tabulated h and clamped at both ends', () => {
  S.h.forEach((h, i) => {
    const b = bracket(S.h, h)
    expect(b.i + b.t).toBeCloseTo(i, 12)
  })
  expect(bracket(S.h, 5)).toEqual({ i: 0, t: 0 })
  expect(bracket(S.h, 0.1)).toEqual({ i: S.h.length - 2, t: 1 })
  expect(bracket(S.h, 2.25)).toEqual({ i: 1, t: 0.5 })
})

test('the outline is the tabulated one at a solved h, and a point-by-point blend between two', () => {
  expect(quarterAt(S.outer, S.h, 2)).toEqual(S.outer[2])
  const mid = quarterAt(S.outer, S.h, 2.25)
  mid.forEach((v, k) => expect(v).toBeCloseTo((S.outer[1][k] + S.outer[2][k]) / 2, 12))
  const s = sectionAt(S, 1.5)
  expect(s.outer).toEqual(mirror(S.outer[3]))
  expect(maxY(s.outer)).toBeCloseTo(0.75, 12)
  expect(s.extrapolated).toBe(false)
})

test('the section is continuous in h, across the solved steps', () => {
  for (const h of [2.5, 2, 1.5, 1.2, 1, 0.8]) {
    const a = sectionAt(S, h + 1e-6), b = sectionAt(S, h - 1e-6)
    a.outer.forEach((p, k) => { expect(Math.abs(p[0] - b.outer[k][0])).toBeLessThan(1e-4); expect(Math.abs(p[1] - b.outer[k][1])).toBeLessThan(1e-4) })
    expect(Math.abs(a.force_per_mm - b.force_per_mm)).toBeLessThan(1e-4)
  }
})

test('mirror closes the quarter into the whole section, symmetric on both axes', () => {
  const pts = mirror(S.outer[0])
  expect(pts.length).toBe(4 * (S.n - 1))
  for (const [x, y] of pts) {
    expect(pts.some(([u, v]) => Math.abs(u + x) < 1e-12 && Math.abs(v - y) < 1e-12)).toBe(true)
    expect(pts.some(([u, v]) => Math.abs(u - x) < 1e-12 && Math.abs(v + y) < 1e-12)).toBe(true)
  }
})

test('below the solved range the deepest shape is flattened to h and marked extrapolated', () => {
  const s = sectionAt(S, 0.3)
  expect(s.extrapolated).toBe(true)
  // The section fits between the plates at h, its width is the deepest solved one's.
  expect(maxY(s.outer)).toBeCloseTo(0.15, 12)
  expect(maxX(s.outer)).toBeCloseTo(maxX(mirror(S.outer[S.h.length - 1])), 12)
  expect(s.open_area_mm2).toBe(0)
  // Force from the backend's extrapolated samples, between 0.4 (20 N/mm) and 0.2 (100 N/mm).
  expect(s.force_per_mm).toBeCloseTo(60, 9)
  expect(sectionAt(S, 0.6).extrapolated).toBe(false)
})

test('above first contact the free tube is drawn, with no force', () => {
  const s = sectionAt(S, 4)
  expect(s.outer).toEqual(mirror(S.outer[0]))
  expect(s.force_per_mm).toBe(0)
  expect(s.open_area_mm2).toBeCloseTo(S.open_area_mm2[0], 12)
})

test('bore height: the free bore at first contact, 0 once the section is shut, and below the solved range', () => {
  expect(boreHeightAt(S, 3)).toBeCloseTo(2, 12)
  expect(boreHeightAt(S, 2)).toBeCloseTo(1, 12)
  expect(boreHeightAt(S, 1)).toBe(0)
  expect(boreHeightAt(S, 0.7)).toBe(0)
  expect(boreHeightAt(S, 0.3)).toBe(0)
})

test('the view frame holds every section of the sweep, so it does not move with h', () => {
  const f = sweepExtent(S)
  expect(f.halfH).toBeCloseTo(1.5, 12)
  expect(f.halfW).toBeCloseTo(1.5 * 3 / 2.1, 12)
})

test('section particles stay inside the FEM bore and none sit in a shut bore', () => {
  const open = boreAcross(sectionAt(S, 2).inner)
  expect(open.length).toBeGreaterThan(3)
  for (let i = 0; i < 40; i++) {
    const p = placeSectionBore(open, (i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13) % 1, 0.06)
    if (!p) continue
    // Inner ellipse at h = 2: semi-axes 4.5 / 3.5 - 0.5 along the plates, 0.5 normal to them.
    const a = 1.5 * 3 / 3.5 - 0.5, b = 0.5
    expect((p.y / a) ** 2 + (p.x / b) ** 2).toBeLessThanOrEqual(1 + 1e-6)
  }
  const shut = boreAcross(sectionAt(S, 0.8).inner)
  for (let i = 0; i < 20; i++) expect(placeSectionBore(shut, 0.5, i / 20, i / 20, 0.06)).toBeNull()
})

beforeEach(() => clearTubeSweeps())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('one request per tube, shared by every caller; a failed one is asked again', async () => {
  const tube = { tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 0, tube_model: 'fem' as const }
  const ok = () => new Response(JSON.stringify(S), { status: 200 })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: 'the tube balloons' }), { status: 422 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(fetchTubeSweep(tube)).rejects.toThrow('the tube balloons')
  fetchMock.mockImplementation(async () => ok())
  const [a, b] = await Promise.all([fetchTubeSweep(tube), fetchTubeSweep(tube)])
  expect(a).toBe(b)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const call = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
  expect(call[0]).toMatch(/\/api\/tube\/sweep$/)
  expect(JSON.parse(String(call[1].body))).toEqual({ tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 0 })
})
