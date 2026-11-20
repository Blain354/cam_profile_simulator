import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TubeModelControls, TubeSectionCard } from './TubeModel'
import { cleanTubeModel, shoreToMpa } from './lib/tubeModel'
import type { TubeSpec } from './lib/tubeModel'

const AUTO = { autoX: true, autoY: true, xMin: -1, xMax: 1, yMin: -1, yMax: 1 }
const ring = (r: number, n = 9): [number, number][] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / (n - 1)), 0.6 * r * Math.sin((2 * Math.PI * i) / (n - 1))])
const SECTION = {
  h: 1.5, outer: ring(1.6), inner: ring(1.1), force_per_mm: 0.123, pressure_share_per_mm: 0.05, open_area_mm2: 1.64, bore_area_mm2: 3.14,
  h_contact: 3.19, h_closed: 0.949, h_sealed: 0.922, max_stretch: 1.3,
}
const tube: TubeSpec = { tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 100, tube_model: 'fem' }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SECTION), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('Gent: Shore 50 is about 2.46 MPa; an unknown stored model falls back to FEM', () => {
  expect(shoreToMpa(50)).toBeCloseTo(2.456, 3)
  expect(cleanTubeModel(undefined)).toBe('fem')
  expect(cleanTubeModel('simple')).toBe('simple')
})

test('the section card asks the FEM for the section at h and draws plates, wall and bore', async () => {
  const { findByRole, getByText } = render(<TubeSectionCard tube={tube} h={1.5} where="tube A at Y = 0.50 mm" settings={AUTO} onSettingsChange={() => {}} />)
  const svg = await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  expect(svg.querySelectorAll('rect').length).toBe(2)
  expect(svg.querySelectorAll('path').length).toBe(2)
  expect(getByText(/0\.123 N\/mm/)).toBeTruthy()
  const call = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
  expect(call[0]).toMatch(/\/api\/tube\/section$/)
  expect(JSON.parse(String(call[1].body))).toEqual({ tube_od: 3, tube_id: 2, tube_shore_a: 50, input_pressure_kpa: 100, h: 1.5 })
})

test('with the simple model the card says where the section comes from and asks nothing', () => {
  const { getByText } = render(<TubeSectionCard tube={{ ...tube, tube_model: 'simple' }} h={1.5} where="x" settings={AUTO} onSettingsChange={() => {}} />)
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

test('a section solved for another tube is not shown while the new tube solves, and the card expands', async () => {
  const props = { h: 1.5, where: 'tube A at Y = 0.50 mm', settings: AUTO, onSettingsChange: () => {} }
  const { findByRole, getByText, getByRole, rerender } = render(<TubeSectionCard tube={tube} {...props} />)
  await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  rerender(<TubeSectionCard tube={{ ...tube, tube_shore_a: 60 }} {...props} />)
  expect(getByText('Solving the tube…')).toBeTruthy()
  await findByRole('img', { name: 'Tube section squeezed to 1.500 mm' })
  fireEvent.click(getByRole('button', { name: 'Expand tube section' }))
  expect(getByText('Tube section, tube A at Y = 0.50 mm')).toBeTruthy()
})
