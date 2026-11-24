import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('the tool fills the viewport and has no site footer', () => {
  const { container } = render(<App />)
  expect(container.querySelector('.bui-site-footer')).toBeNull()
  const shell = container.querySelector('.cam-workspace') as HTMLElement
  expect(shell).toBeTruthy()
  expect(shell.className).toContain('overflow-hidden')
  expect(container.querySelector('.bui-header-fx')).toBeNull()
})

test('labels are in sentence case and the private tool stays sober', () => {
  const { container } = render(<App />)
  expect(container.querySelector('[class~=""]')).toBeNull()
  expect(container.querySelector('.bui-bp--currents')).toBeNull()
})

test('an accordion starts closed and stays as the session left it across tabs', () => {
  const { getByRole, getByText, queryByText } = render(<App />)
  expect(queryByText('Height (mm)')).toBeNull()
  fireEvent.click(getByRole('button', { name: 'Geometry' }))
  expect(getByText('Height (mm)')).toBeTruthy()

  fireEvent.click(getByRole('button', { name: 'Bar Linkage' }))
  expect(queryByText('Bar 2, L2 (mm)')).toBeNull()
  fireEvent.click(getByRole('button', { name: 'Cam' }))
  expect(getByText('Height (mm)')).toBeTruthy()

  fireEvent.click(getByRole('tab', { name: 'Finder' }))
  fireEvent.click(getByRole('tab', { name: 'Explorer' }))
  expect(getByText('Height (mm)')).toBeTruthy()
  expect(JSON.parse(sessionStorage.getItem('cam-sim.accordions.v1')!)).toEqual({ 'cam:explorer:Geometry': true })
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
  fireEvent.click(getByRole('button', { name: 'Geometry to search' }))
  // The first row is the arm, L (bar2_length, 14.43 by default).
  fireEvent.click(getAllByRole('checkbox', { name: 'Fixed' })[0])
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('Found dimensions')
  expect(bodies[0].bar2_min).toBe(14.43)
  expect(bodies[0].bar2_max).toBe(14.43)
  expect(bodies[0].fixed).toBeUndefined()
  expect(bodies[0].bar1_min).toBe(6)
  // The state is written to localStorage by an effect that may run after the result is on screen.
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.search.fixed).toEqual(['bar2'])
    expect(stored.search.bar2_min).toBe(8)
    expect(stored.params.carriage_pin_strength_mpa).toBe(300)
    expect(stored.params.bar2_length).toBe(12)
  })
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

test('a rigid search whose designs all leak at rest says so, not that nothing was feasible', async () => {
  const bodies = stubLinkage({ found: false, feasible: 40, tested: 300, search_report: { model: 'rigid', shortlist: 0, passed: 0, rejected: {}, sides: { normal: { feasible: 40, collision: 0, solved: 0, passed: 0, seal: 12, found: false, score: null } }, pivot_side: null } })
  const { getByRole, findByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('40 of 300 first draws were feasible, but the 12 best tried all leak at rest. Turn off Seal at rest under Limits to see them. The design on screen was kept.')
  await findByText('Normal: 40 feasible, 0 refused for the clearance, 12 leaking at rest, nothing found.')
  expect(bodies[0].require_seal).toBe(true)
  expect(bodies[0].pivot_side).toBe('normal')
})

test('a rigid search does not print an empty shortlist count', async () => {
  stubLinkage({ found: true, feasible: 3, tested: 30, search_report: { model: 'rigid', shortlist: 0, passed: 0, rejected: { stress: 0, thrust: 0, eye: 0, rod: 0, no_flow: 0 } }, params: { bar2_length: 12, stroke: 1.5 }, result: minimalResult })
  const { getByRole, findByText, queryByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('Found dimensions')
  expect(queryByText(/shortlisted designs passed/)).toBeNull()
})

test('selecting a goal and min flow sends them, and clicking Top candidates + Revert switches params', async () => {
  const candidates = [
    {
      score: 10, pivot_side: 'normal', limiting_factor: 'stress', tags: ['Best overall', 'Highest flow'],
      params: { bar2_length: 14.9, bar1_length: 9.3, anchor_distance: -2.6, foot_length: 5.8, foot_angle_deg: 72, stroke: 0.65 },
      metrics: { stroke: 0.65, y_open: 0.13, deadband: 0.26, y_full_open: null, response_time_ms: null, chamber_t50_ms: 460, chamber_t90_ms: 590, max_flow_l_min: 23.2, max_flow_reached_l_min: 14.5, max_flow_reached_pct: 62.5, flow_slope_mean: 28.8, flow_slope_max: 41.0, flow_accel_mean: -24.9, max_stress_mpa: 39.8, stress_margin: 1.01, thrust_needed: 19.2, motor_margin: 1.9, seal_pressure_y0_kpa: 195, sealed_after_flex: true, max_oversqueeze: 0.4, min_clearance: null, max_rotation_deg: 8.5, rms_error: null },
    },
    {
      score: 14, pivot_side: 'normal', limiting_factor: 'stress', tags: ['Min deadband', 'Fastest chamber'],
      params: { bar2_length: 15.0, bar1_length: 9.4, anchor_distance: -2.4, foot_length: 6.0, foot_angle_deg: 60, stroke: 0.4 },
      metrics: { stroke: 0.4, y_open: 0.12, deadband: 0.24, y_full_open: null, response_time_ms: null, chamber_t50_ms: 430, chamber_t90_ms: 544, max_flow_l_min: 23.2, max_flow_reached_l_min: 9.65, max_flow_reached_pct: 41.6, flow_slope_mean: 36.9, flow_slope_max: 44.4, flow_accel_mean: -39.5, max_stress_mpa: 37.9, stress_margin: 1.06, thrust_needed: 22.1, motor_margin: 1.7, seal_pressure_y0_kpa: 190, sealed_after_flex: true, max_oversqueeze: 0.35, min_clearance: null, max_rotation_deg: 5.3, rms_error: null },
    },
  ]
  const bodies = stubLinkage({
    found: true, feasible: 20, tested: 300,
    params: candidates[0].params,
    result: { ...minimalResult, max_flow_reached_l_min: 14.5, max_flow_reached_pct: 62.5, flow_slope_mean: 28.8, flow_slope_max: 41.0, flow_accel_mean: -24.9, chamber_t50_ms: 460, chamber_t90_ms: 590 },
    search_report: { model: 'one-piece', shortlist: 12, passed: 8, rejected: { stress: 3, no_flow: 1 }, limiting_factor: 'stress', candidates },
    candidates,
  })
  const { getByRole, getByText, findByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Goal' }))
  fireEvent.click(getByRole('button', { name: 'Min deadband' }))
  const minFlowInput = getByText('Min flow reached (%)').closest('.space-y-2')!.querySelector('input[type=number]') as HTMLInputElement
  fireEvent.change(minFlowInput, { target: { value: '40' } })
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('Found dimensions')
  expect(bodies[0].objective).toBe('deadband')
  expect(bodies[0].min_flow_pct).toBe(40)
  // Rejection breakdown and limiting factor remain visible even when a solution is found.
  await findByText('Rejected for: part stress 3, no flow 1.')
  await findByText('0.65 mm (part stress)')
  await findByText('Top candidates (2)')
  // Selecting candidate #2 applies its parameters; clicking Revert restores the pre-search arm length (14.43).
  fireEvent.click(getByRole('button', { name: /#2/ }))
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.params.foot_angle_deg).toBe(60)
    expect(stored.params.stroke).toBe(0.4)
  })
  fireEvent.click(getByRole('button', { name: 'Revert' }))
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.params.bar2_length).toBe(14.43)
  })
})

test('pendulum link shape controls toggle straight, tangent flip, and custom radius, and Finder searches them', async () => {
  const candidates = [
    {
      score: 8, pivot_side: 'inverted', link_curve: 'radius_out', limiting_factor: 'stress', tags: ['Best overall'],
      params: { bar2_length: 14.5, bar1_length: 9.5, anchor_distance: 2.0, foot_length: 2.5, foot_angle_deg: 80, stroke: 0.4, pivot_inverted: true, link_curved: true, link_curve_mode: 'radius', link_curve_flip: true, link_radius: 12.5 },
      metrics: { stroke: 0.4, y_open: 0.02, deadband: 0.04, y_full_open: null, response_time_ms: null, chamber_t50_ms: 300, chamber_t90_ms: 420, max_flow_l_min: 23.2, max_flow_reached_l_min: 18.0, max_flow_reached_pct: 77.6, flow_slope_mean: 40.0, flow_slope_max: 50.0, flow_accel_mean: -10.0, max_stress_mpa: 35.0, stress_margin: 1.14, thrust_needed: 12.0, motor_margin: 3.0, seal_pressure_y0_kpa: 180, sealed_after_flex: true, max_oversqueeze: 0.3, min_clearance: null, max_rotation_deg: 6.0, rms_error: null, link_arc_radius: 12.5 },
    },
    {
      score: 9, pivot_side: 'inverted', link_curve: 'straight', limiting_factor: 'stress', tags: ['Higher margin'],
      params: { bar2_length: 14.8, bar1_length: 9.8, anchor_distance: 2.2, foot_length: 2.2, foot_angle_deg: 75, stroke: 0.35, pivot_inverted: true, link_curved: false, link_curve_mode: 'straight', link_curve_flip: false, link_radius: 10.0 },
      metrics: { stroke: 0.35, y_open: 0.03, deadband: 0.06, y_full_open: null, response_time_ms: null, chamber_t50_ms: 320, chamber_t90_ms: 450, max_flow_l_min: 23.2, max_flow_reached_l_min: 16.5, max_flow_reached_pct: 71.1, flow_slope_mean: 36.0, flow_slope_max: 45.0, flow_accel_mean: -12.0, max_stress_mpa: 26.0, stress_margin: 1.54, thrust_needed: 14.0, motor_margin: 2.6, seal_pressure_y0_kpa: 195, sealed_after_flex: true, max_oversqueeze: 0.25, min_clearance: null, max_rotation_deg: 5.0, rms_error: null, link_arc_radius: null },
    },
  ]
  const bodies = stubLinkage({
    found: true, feasible: 25, tested: 300,
    params: candidates[0].params,
    result: { ...minimalResult, link_arc_radius: 12.5 },
    search_report: {
      model: 'one-piece', shortlist: 20, passed: 10, rejected: { stress: 10 },
      curves: { straight: { solved: 4, passed: 3, found: true, score: 9 }, radius_out: { solved: 4, passed: 4, found: true, score: 8 } },
      link_curve: 'radius_out', limiting_factor: 'stress', candidates,
    },
    candidates,
  })
  const { getByRole, findByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Geometry to search' }))
  // In Finder, select Search all link shapes and run search.
  fireEvent.click(getByRole('button', { name: 'Search all' }))
  fireEvent.click(getByRole('button', { name: /Find dimensions/ }))
  await findByText('Found dimensions')
  expect(bodies[0].link_curve_search).toBe('all')
  expect(bodies[0].link_radius_min).toBe(5)
  expect(bodies[0].link_radius_max).toBe(40)
  await findByText('Radius 12.5 mm (outward)')
  await findByText('Radius (out): 4 of 4 passed (best).')
  // Clicking candidate #2 switches to Straight link mode and persists it.
  fireEvent.click(getByRole('button', { name: /#2/ }))
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.params.link_curve_mode).toBe('straight')
    expect(stored.params.link_curved).toBe(false)
  })
  // Switch to Explorer and test toggling Tangent -> Opposite and Custom radius -> Outward.
  fireEvent.click(getByRole('button', { name: 'Open in Explorer' }))
  fireEvent.click(getByRole('button', { name: 'Geometry' }))
  fireEvent.click(getByRole('button', { name: 'Tangent' }))
  fireEvent.click(getByRole('button', { name: 'Opposite' }))
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.params.link_curve_mode).toBe('tangent')
    expect(stored.params.link_curve_flip).toBe(true)
    expect(stored.params.link_curved).toBe(true)
  })
  fireEvent.click(getByRole('button', { name: 'Custom radius' }))
  fireEvent.click(getByRole('button', { name: 'Outward (tube)' }))
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(stored.params.link_curve_mode).toBe('radius')
    expect(stored.params.link_curve_flip).toBe(true)
  })
})

test('a linkage state saved in psi comes back in kPa, shown with one decimal', async () => {
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: {} }))
  localStorage.setItem('cam-sim.linkage.pendulum.v2', JSON.stringify({ params: { input_pressure_psi: 15 }, search: {} }))
  const { getByText } = render(<App />)
  fireEvent.click(getByText('Pneumatic system'))
  const box = getByText('Pressure (kPa)').closest('.space-y-2')!.querySelector('input[type=number]') as HTMLInputElement
  expect(box.value).toBe('103.4')
  expect(box.validity.valid).toBe(true)
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!)
    expect(saved.params.input_pressure_kpa).toBeCloseTo(103.42, 2)
    expect('input_pressure_psi' in saved.params).toBe(false)
  })
})
