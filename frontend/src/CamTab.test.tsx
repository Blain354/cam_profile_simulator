import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { VerticalSystemSvgDiagram, defaultParams } from './components'
import { interpAt } from './lib/camTravel'
import { PSI_TO_KPA } from './lib/pressure'
import { simulateDefault } from './simulate.fixture'

// The fixture was simulated at 103.42 kPa.
const params = { ...defaultParams, input_pressure_kpa: 15 * PSI_TO_KPA }

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.endsWith('/api/simulate') ? simulateDefault : url.endsWith('/api/profiles/cam/default') ? { default: null } : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('the static drawing used by the previews has no tube and no live gap label', () => {
  const { container } = render(<VerticalSystemSvgDiagram data={simulateDefault} params={params} details={false} isPreview />)
  expect(container.querySelectorAll('rect[rx]').length).toBe(0)
  expect(container.textContent).not.toMatch(/Gap .* mm/)
})

test('the live drawing shows the tube and the simulated gap at the carriage position', () => {
  const y = 0.8
  const { container } = render(<VerticalSystemSvgDiagram data={simulateDefault} params={params} details={false} y={y} />)
  const gap = interpAt(y, simulateDefault.Y_positions, simulateDefault.min_gaps)
  expect(container.textContent).toContain(`Gap ${gap.toFixed(3)} mm`)
  expect(container.querySelectorAll('rect[rx]').length).toBeGreaterThan(0)
  // The cam is drawn shifted by -Y.
  expect(container.querySelector(`g[transform="translate(0 ${-y})"] polyline`)).toBeTruthy()
})

test('the carriage values come from the simulated arrays, clamped at both ends of the range', () => {
  const ys = simulateDefault.Y_positions, gaps = simulateDefault.min_gaps
  expect(interpAt(ys[0] - 1, ys, gaps)).toBe(gaps[0])
  expect(interpAt(ys[ys.length - 1] + 1, ys, gaps)).toBe(gaps[gaps.length - 1])
  expect(interpAt(ys[10], ys, gaps)).toBeCloseTo(gaps[10], 12)
  expect(interpAt(1.5, [0, 1, 3], [0, 10, 30])).toBeCloseTo(15, 12)
})

test('the drawn bore is the model slot: flow area over (pi/2) x tube ID', () => {
  const y = 1.5
  const { container } = render(<VerticalSystemSvgDiagram data={simulateDefault} params={params} details y={y} />)
  const area = interpAt(y, simulateDefault.Y_positions, simulateDefault.flow_area)
  const bore = area / ((Math.PI / 2) * params.tube_id)
  expect(container.textContent).toContain(`bore ${bore.toFixed(3)} mm`)
})

test('the Cam Explorer menu lists every control once, most important first, then the results', async () => {
  const { findByText, getByText, getByLabelText, getByRole } = render(<App />)
  await findByText('Open Latency')
  const panel = getByText('Configuration').closest('.lg\\:col-span-3') as HTMLElement
  const text = panel.textContent ?? ''
  const order = [
    'Note', 'Geometry', 'Height (mm)', 'Curve Gain (K)', 'Deadband (mm)', 'Default Dist (mm)', 'Closure ramp', 'Thickness (mm)',
    'Pneumatic system', 'Pressure (kPa)', 'Tube ID (mm)', 'Tube OD (mm)', 'Compliance', 'Chamber Vol (mL)',
    'Motor and screw', 'Motor Speed', 'Results', 'Open Latency', 'Gap at Y=0', 'Max Flow (static)', 'Static flow @ Y=0.5 mm',
  ]
  let last = -1
  for (const label of order) {
    expect(text.split(label).length - 1, label).toBe(1)
    const at = text.indexOf(label)
    expect(at, label).toBeGreaterThan(last)
    last = at
  }
  expect(within(panel).getAllByRole('spinbutton').length).toBe(11)

  const slider = getByLabelText('Carriage Y') as HTMLInputElement
  expect(Number(slider.min)).toBe(simulateDefault.Y_positions[0])
  expect(Number(slider.max)).toBe(simulateDefault.Y_positions[simulateDefault.Y_positions.length - 1])
  fireEvent.change(slider, { target: { value: '1' } })
  expect(getByText('1.00 mm')).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Center' }))
  expect(getByText('0.00 mm')).toBeTruthy()
  expect(getByRole('button', { name: /Oscillate/ })).toBeTruthy()

  const titles = [...document.querySelectorAll('h3')].map((h) => h.textContent)
  expect(titles.filter((t) => ['Pneumatic Flow vs Y', 'Gap vs Y', 'Gap vs Time'].includes(t ?? ''))).toEqual(['Pneumatic Flow vs Y', 'Gap vs Y', 'Gap vs Time'])
})

test('the active top-level tab carries the selected tab look', () => {
  const { getByRole } = render(<App />)
  expect(getByRole('button', { name: 'Cam' }).className).toContain('bui-tab--active')
  fireEvent.click(getByRole('button', { name: 'Bar Linkage' }))
  expect(getByRole('button', { name: 'Bar Linkage' }).className).toContain('bui-tab--active')
  expect(getByRole('button', { name: 'Cam' }).className).not.toContain('bui-tab--active')
})

test('the Cam Finder menu reads target, imposed inputs, search, ranking, Solve, then context', () => {
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'cam', sub: { cam: 'finder' } }))
  const { getByText } = render(<App />)
  const panel = getByText('Profile Builder').closest('.lg\\:col-span-3') as HTMLElement
  const text = panel.textContent ?? ''
  const order = ['Experience note', 'Target', 'Chamber Volume (mL)', 'System parameters', 'Motor Speed (RPM)', 'Closure ramp', 'Search grid', 'Candidate ranking', 'Solve', 'Context & Metrics']
  let last = -1
  for (const label of order) {
    const at = text.indexOf(label, last + 1)
    expect(at, label).toBeGreaterThan(last)
    last = at
  }
})
