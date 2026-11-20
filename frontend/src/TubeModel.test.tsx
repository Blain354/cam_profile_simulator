import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TubeModelControls, TubeSectionCard } from './TubeModel'
import { cleanTubeModel, shoreToMpa } from './lib/tubeModel'
import type { TubeSpec } from './lib/tubeModel'
import { clearTubeSweeps } from './lib/tubeSweep'
import { syntheticSweep } from './lib/tubeSweep.fixture'

const AUTO = { autoX: true, autoY: true, xMin: -1, xMax: 1, yMin: -1, yMax: 1 }
const SWEEP = syntheticSweep()
const tube: TubeSpec = { tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 100, tube_model: 'fem' }
const calls = () => (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls

beforeEach(() => {
  clearTubeSweeps()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SWEEP), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const props = { where: 'tube A at Y = 0.50 mm', settings: AUTO, onSettingsChange: () => {} }

test('Gent: Shore 50 is about 2.46 MPa; an unknown stored model falls back to FEM', () => {
  expect(shoreToMpa(50)).toBeCloseTo(2.456, 3)
  expect(cleanTubeModel(undefined)).toBe('fem')
  expect(cleanTubeModel('simple')).toBe('simple')
})

test('the section card asks the FEM sweep once and draws plates, wall and bore at h', async () => {
  const { findByRole, getByText } = render(<TubeSectionCard tube={tube} h={1.5} {...props} />)
  const svg = await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  expect(svg.querySelectorAll('rect').length).toBe(2)
  expect(svg.querySelectorAll('path').length).toBe(2)
  expect(getByText(/3\.000 N\/mm/)).toBeTruthy()
  expect(calls().length).toBe(1)
  expect(calls()[0][0]).toMatch(/\/api\/tube\/sweep$/)
  expect(JSON.parse(String(calls()[0][1].body))).toEqual({ tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 100 })
})

// Regression: the card asked the server for each h after it had been still for 120 ms, so during
// Oscillate (a new h every frame) it kept the shape from before the run.
test('the card follows h on every render, with no request per h', async () => {
  const { findByRole, rerender, getByRole } = render(<TubeSectionCard tube={tube} h={2} {...props} />)
  await findByRole('img', { name: 'Tube section squeezed to 2.000 mm' })
  const box = getByRole('img').getAttribute('viewBox')
  for (const h of [1.9, 1.7, 1.3, 1.1, 0.9]) {
    rerender(<TubeSectionCard tube={tube} h={h} {...props} />)
    // Same render, no wait: the section is interpolated from the sweep already there.
    const svg = getByRole('img', { name: `Tube section squeezed to ${h.toFixed(3)} mm` })
    // Regression: the view was fitted to each section, so the tube zoomed instead of deforming.
    expect(svg.getAttribute('viewBox')).toBe(box)
  }
  expect(calls().length).toBe(1)
})

// Regression: below the deepest solved step the deepest shape was drawn as is, through the plates
// at h, and the force came with no word that it is extrapolated.
test('below the solved range the section fits between the plates and is marked extrapolated', async () => {
  const { findByRole, getByText } = render(<TubeSectionCard tube={tube} h={0.3} {...props} />)
  const svg = await findByRole('img', { name: 'Tube section squeezed to 0.300 mm, extrapolated' })
  const outer = svg.querySelectorAll('path')[0].getAttribute('d')!
  const ys = [...outer.matchAll(/[ML]-?[\d.]+,(-?[\d.]+)/g)].map((m) => Math.abs(parseFloat(m[1])))
  expect(Math.max(...ys)).toBeLessThanOrEqual(0.15 + 1e-4)
  expect(getByText(/extrapolated below 0\.600 mm/)).toBeTruthy()
  expect(getByText('bore shut')).toBeTruthy()
})

test('with the simple model the card says where the section comes from and asks nothing', () => {
  const { getByText } = render(<TubeSectionCard tube={{ ...tube, tube_model: 'simple' }} h={1.5} {...props} />)
  expect(getByText(/Set Tube model to FEM/)).toBeTruthy()
  expect(fetch).not.toHaveBeenCalled()
})

test('the controls switch the model, and the hardness only matters to the FEM', () => {
  const onModel = vi.fn()
  const { getByRole, getByText, rerender } = render(<TubeModelControls model="fem" shore={50} onModel={onModel} onShore={() => {}} />)
  fireEvent.click(getByRole('tab', { name: 'Simple' }))
  expect(onModel).toHaveBeenCalledWith('simple')
  expect(getByText(/E 2\.46 MPa/)).toBeTruthy()
  rerender(<TubeModelControls model="simple" shore={50} onModel={onModel} onShore={() => {}} />)
  expect(getByText(/FEM only/)).toBeTruthy()
})

test('a sweep solved for another tube is not shown while the new tube solves, and the card expands', async () => {
  const p = { h: 1.5, ...props }
  const { findByRole, getByText, getByRole, rerender } = render(<TubeSectionCard tube={tube} {...p} />)
  await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  rerender(<TubeSectionCard tube={{ ...tube, tube_shore_a: 60 }} {...p} />)
  expect(getByText('Solving the tube…')).toBeTruthy()
  await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  expect(calls().length).toBe(2)
  fireEvent.click(getByRole('button', { name: 'Expand tube section' }))
  expect(getByText('Tube section, tube A at Y = 0.50 mm')).toBeTruthy()
})

test('an error from the FEM is shown in the card', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Tube FEM: the tube balloons' }), { status: 422 })))
  const { findByRole } = render(<TubeSectionCard tube={tube} h={1.5} {...props} />)
  expect((await findByRole('alert')).textContent).toMatch(/the tube balloons/)
})
