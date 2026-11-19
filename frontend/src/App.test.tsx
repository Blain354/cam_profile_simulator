import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('the site footer sits under the tool with the repo and the version', () => {
  const { container } = render(<App />)
  const footer = container.querySelector('.bui-site-footer') as HTMLElement
  expect(footer).toBeTruthy()
  expect(within(footer).getByRole('link', { name: 'cam_profile_simulator' }).getAttribute('href'))
    .toBe('https://github.com/Blain354/cam_profile_simulator')
  expect(within(footer).getByText(__APP_VERSION__)).toBeTruthy()
})

test('labels are in sentence case and the private tool stays sober', () => {
  const { container } = render(<App />)
  expect(container.querySelector('[class~=""]')).toBeNull()
  expect(container.querySelector('.bui-bp--currents')).toBeNull()
})

test('each tab has an Explorer and a Finder sub-tab, and the choice is kept', () => {
  const { getByRole, unmount } = render(<App />)
  const finder = getByRole('tab', { name: 'Finder' })
  expect(getByRole('tab', { name: 'Explorer' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(finder)
  expect(JSON.parse(localStorage.getItem('cam-sim.tabs.v1')!)).toEqual(
    { tab: 'cam', sub: { cam: 'finder', linkage: 'explorer', lever: 'explorer', pendulum: 'explorer' } })
  unmount()
  const again = render(<App />)
  expect(again.getByRole('tab', { name: 'Finder' }).getAttribute('aria-selected')).toBe('true')
})

function stubLinkage(optimize: unknown) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/simulate')) return new Response('{}', { status: 500 })
    if (url.endsWith('/api/linkage/optimize')) {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(optimize), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: { pendulum: 'finder' } }))
  return bodies
}

const minimalResult = {
  y_full_open: 1.2, response_time_ms: 300, y_open: 0.1, max_flow_l_min: 5, flow_a: [0, 5], rms_error: null,
  max_oversqueeze: 0.2, flexure: {}, max_stress_mpa: 20, thrust_needed: 4, carriage_bearing_mpa: 10, carriage_pin_bending_mpa: 120,
}

test('a fixed row is sent as min = max and its stored range is kept', async () => {
  const bodies = stubLinkage({ found: true, feasible: 3, tested: 30, params: { bar2_length: 12, bar1_length: 11, anchor_distance: 4, foot_length: 2, foot_angle_deg: 90, stroke: 1.5 }, result: minimalResult })
  const { getByRole, getAllByRole, findByText } = render(<App />)
  // The first row is the arm, L (bar2_length, 14.43 by default).
  fireEvent.click(getAllByRole('checkbox', { name: 'Fixed' })[0])
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('Found dimensions')
  expect(bodies[0].bar2_min).toBe(14.43)
  expect(bodies[0].bar2_max).toBe(14.43)
  expect(bodies[0].fixed).toBeUndefined()
  expect(bodies[0].bar1_min).toBe(6)
  const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
  expect(stored.search.fixed).toEqual(['bar2'])
  expect(stored.search.bar2_min).toBe(8)
  expect(stored.params.carriage_pin_strength_mpa).toBe(300)
  expect(stored.params.bar2_length).toBe(12)
  fireEvent.click(getByRole('button', { name: 'Open in Explorer' }))
  await waitFor(() => expect(getByRole('tab', { name: 'Explorer' }).getAttribute('aria-selected')).toBe('true'))
})

test('a search the limits rejected says why and keeps the design', async () => {
  stubLinkage({ found: false, feasible: 0, tested: 30, search_report: { model: 'one-piece', shortlist: 12, passed: 0, rejected: { stress: 7, thrust: 5 } } })
  const { getByRole, findByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('0 of 12 shortlisted designs passed the limits.')
  await findByText('Rejected for: part stress 7, screw thrust 5.')
  await findByText('No design passed the limits. The design on screen was kept.')
})
