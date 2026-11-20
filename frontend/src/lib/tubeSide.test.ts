import { expect, test } from 'vitest'
import { sideBore, tubeProfile } from './tubeSide'
import type { Pt } from './tubeSide'
import { syntheticSweep } from './tubeSweep.fixture'

const S = syntheticSweep()
const OD = 3, ID = 2

// A round pin of radius 0.5 whose face is 0.8 mm from the wall, at height 5, on a tube drawn from 0 to 10.
const pin: [Pt, Pt] = [[1.3, 5], [1.3, 5]]

test('with the FEM, the bore is shut where the section at the local h is shut and the full ID where the tube is free', () => {
  const profile = tubeProfile(pin, 0.5, OD, 0, 10, OD)
  const bore = sideBore(profile, OD, ID, S)
  profile.forEach(([h, v], i) => {
    const [s, lo, hi] = bore[i]
    expect(s).toBe(v)
    // Centred between the wall and the pin, never through the outer wall.
    expect((lo + hi) / 2).toBeCloseTo(h / 2, 12)
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(h + 1e-12)
    if (h <= 1) expect(hi - lo).toBe(0)
    if (h >= OD) expect(hi - lo).toBeCloseTo(ID, 12)
  })
  // Under the pin the wall still moves (h 0.8) while the bore has been shut since h = 1.
  const under = profile.findIndex(([, v]) => Math.abs(v - 5) < 0.04)
  expect(profile[under][0]).toBeCloseTo(0.8, 2)
  expect(bore[under][2] - bore[under][1]).toBe(0)
  // Far from the pin, the free tube and its free bore.
  expect(bore[0][2] - bore[0][1]).toBeCloseTo(ID, 12)
})

test('the FEM shoulder blends back to the free tube one OD from the contact', () => {
  const profile = tubeProfile(pin, 0.5, OD, 0, 10, OD)
  for (const [h, v] of profile) {
    if (Math.abs(v - 5) > 0.5 + OD + 1e-9) expect(h).toBe(OD)
  }
  expect(Math.min(...profile.map(([h]) => h))).toBeCloseTo(0.8, 2)
})

test('the simple model keeps its drawing: walls of constant thickness, sharing what is left once pressed through', () => {
  const profile = tubeProfile(pin, 0.5, OD, 0, 10)
  const bore = sideBore(profile, OD, ID, null)
  profile.forEach(([h], i) => {
    const [, lo, hi] = bore[i]
    expect(lo).toBeCloseTo(Math.min(0.5, h / 2), 12)
    expect(hi).toBeCloseTo(Math.max(h - 0.5, h / 2), 12)
  })
})
