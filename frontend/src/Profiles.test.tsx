import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { profileTypeOf } from './lib/profiles'
import { ProfileImportModal } from './ProfileControls'
import { CamProfilePreview } from './components'
import { FinderProfilePreview } from './ProfileBuilder'
import { LinkageProfilePreview } from './LinkageExplorer'
import { simulateDefault } from './simulate.fixture'

type Call = { url: string; method: string; body: Record<string, unknown> | null }
type Stored = { name: string; type: string; note: string; payload: Record<string, unknown>; updated_at: string }

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** A fake profile store behind /api/profiles; every other route answers with the default simulation. */
function stubStore(seed: Stored[]) {
  const store = [...seed]
  const defaults: Record<string, string> = {}
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const u = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const path = decodeURIComponent(u.pathname)
    if (u.pathname.startsWith('/api/profiles')) calls.push({ url: `${path}${u.search}`, method, body })
    if (u.pathname === '/api/profiles') {
      const type = u.searchParams.get('type')!
      return ok({
        profiles: store.filter((p) => p.type === type).map((p) => ({ name: p.name, type, note: p.note, updated_at: p.updated_at, created_at: p.updated_at, is_default: defaults[type] === p.name })),
        default: defaults[type] ?? null,
      })
    }
    const m = path.match(/^\/api\/profiles\/([^/]+)(?:\/(.*))?$/)
    if (m) {
      const [, type, rest] = m
      if (rest === 'default') return ok({ default: defaults[type] ?? null })
      if (rest?.startsWith('default/')) { defaults[type] = rest.slice(8); return ok({ status: 'set' }) }
      if (rest == null && method === 'POST') {
        const name = `20261119_120000_${store.length + 1}${type === 'cam' ? '.json' : '.builder.json'}`
        store.push({ name, type, note: body.note, payload: body.payload, updated_at: '2026-11-19T12:00:00Z' })
        return ok({ status: 'saved', name })
      }
      const i = store.findIndex((p) => p.type === type && p.name === rest)
      if (method === 'PUT') {
        const item = { name: rest!, type, note: body.note, payload: body.payload, updated_at: '2026-11-19T12:00:00Z' }
        if (i >= 0) store[i] = item; else store.push(item)
        return ok({ status: i >= 0 ? 'updated' : 'saved', name: rest })
      }
      if (method === 'DELETE') { store.splice(i, 1); return ok({ status: 'deleted' }) }
      return i >= 0 ? ok(store[i]) : new Response('{"detail":"Profile not found"}', { status: 404 })
    }
    if (u.pathname.startsWith('/api/solve-candidate')) return ok({ cached: false, simulation: null })
    if (u.pathname.endsWith('/simulate')) return u.pathname === '/api/simulate' ? ok(simulateDefault) : new Response('{}', { status: 500 })
    return ok([])
  }))
  return { calls, store, defaults }
}

const pendulumProfile: Stored = {
  name: 'custom-interessant', type: 'pendulum', note: 'kept note', updated_at: '2026-11-10T09:30:00Z',
  payload: {
    params: { linkage_type: 'pendulum', bar1_length: 9.5, bar2_length: 13.25, anchor_distance: 2.5, foot_length: 1.75, foot_angle_deg: 95, stroke: 2.5, input_pressure_kpa: 100 },
    search: { bar1_min: 7, bar1_max: 15, fixed: ['foot'] },
    chart_settings: { flow: { autoX: false, autoY: true, xMin: -2, xMax: 2, yMin: 0, yMax: 1 } },
  },
}
const camProfiles: Stored[] = [
  { name: '20260326_233901_11.json', type: 'cam', note: 'startup one', updated_at: '2026-03-26T23:39:01Z', payload: { motor_speed: 120, height: 2.4, note: 'old note' } },
  { name: '20260401_101010_12.json', type: 'cam', note: 'wide deadband', updated_at: '2026-04-01T10:10:10Z', payload: { motor_speed: 100, deadband: 3 } },
]
const finderProfile: Stored = {
  name: '20260417_114007_1.builder.json', type: 'cam-finder', note: 'first solve', updated_at: '2026-04-17T11:40:07Z',
  payload: {
    builder_params: { motorSpeed: 100, tubeId: 2, tubeOd: 3, pressureKpa: 100, chamberVolume: 50, thickness: 2.5, kMin: 1, kMax: 3 },
    solver_result: {
      success: true, message: 'ok', height: 2, K: 2, deadband: 1.5, default_distance: 0.35, simulation: simulateDefault,
      candidates: [{ height: 2, K: 2, deadband: 1.5, default_distance: 0.35, gap_at_Y0: 0.3, volume_rel_error: 0, volume_error_pct: 0, flow_slope_l_per_mm: 1 }],
    },
  },
}
const allProfiles = [...camProfiles, finderProfile, pendulumProfile,
  { name: 'bar one', type: 'elbow', note: '', updated_at: '', payload: { params: {}, search: {} } }]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** The save dialog; the import window may still be closing behind it. */
const dialog = () => [...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent?.includes('Save as new profile')) as HTMLElement
/** The save dialog of a linkage tab opens once the loaded profile's note is read. */
const openedDialog = () => waitFor(() => { const d = dialog(); expect(d).toBeTruthy(); return d })

test('the window lists only its type and filters by name and note', async () => {
  const { calls } = stubStore(allProfiles)
  const { findByText, queryByText, getByLabelText } = render(
    <ProfileImportModal open onClose={() => {}} type="cam" renderPreview={() => null} onOpen={() => {}} />)
  await findByText('20260326_233901_11.json')
  expect(calls[0].url).toBe('/api/profiles?type=cam')
  expect(queryByText('custom-interessant')).toBeNull()
  expect(queryByText('20260417_114007_1.builder.json')).toBeNull()
  fireEvent.change(getByLabelText('Search profiles'), { target: { value: 'deadband' } })
  expect(queryByText('20260326_233901_11.json')).toBeNull()
  expect(queryByText('20260401_101010_12.json')).toBeTruthy()
})

test('open, delete and set as default call the store routes of the type', async () => {
  const { calls } = stubStore(allProfiles)
  const onOpen = vi.fn()
  const onDeleted = vi.fn()
  const { findByText, getByText, getAllByText, getByRole, queryByText } = render(
    <ProfileImportModal open onClose={() => {}} type="pendulum" renderPreview={(p) => <span>{String((p.params as { bar1_length: number }).bar1_length)}</span>} onOpen={onOpen} onDeleted={onDeleted} />)
  fireEvent.mouseEnter(await findByText('custom-interessant'))
  await findByText('9.5')
  // In the list and under the preview.
  await waitFor(() => expect(getAllByText('kept note').length).toBe(2))
  fireEvent.click(getByText('custom-interessant'))
  fireEvent.click(getByRole('button', { name: 'Set as default' }))
  await findByText('Is default')
  expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/profiles/pendulum/default/custom-interessant')).toBe(true)
  fireEvent.doubleClick(getByText('custom-interessant'))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'custom-interessant', note: 'kept note' })))
  fireEvent.click(getByRole('button', { name: 'Delete custom-interessant' }))
  await waitFor(() => expect(queryByText('custom-interessant')).toBeNull())
  expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/profiles/pendulum/custom-interessant')).toBe(true)
  expect(onDeleted).toHaveBeenCalledWith('custom-interessant')
})

test('each tab and sub-tab maps to its profile type', () => {
  expect(profileTypeOf('cam', 'explorer')).toBe('cam')
  expect(profileTypeOf('cam', 'finder')).toBe('cam-finder')
  for (const sub of ['explorer', 'finder'] as const) {
    expect(profileTypeOf('linkage', sub)).toBe('elbow')
    expect(profileTypeOf('lever', sub)).toBe('lever')
    expect(profileTypeOf('pendulum', sub)).toBe('pendulum')
  }
})

test.each([
  ['cam', 'explorer', 'cam', 'Cam profiles'],
  ['cam', 'finder', 'cam-finder', 'Cam Finder profiles'],
  ['linkage', 'finder', 'elbow', 'Bar linkage profiles'],
  ['lever', 'explorer', 'lever', 'Lever linkage profiles'],
  ['pendulum', 'finder', 'pendulum', 'Pendulum linkage profiles'],
])('the header Import on %s / %s opens the %s window', async (tab, sub, type, title) => {
  const { calls } = stubStore(allProfiles)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab, sub: { [tab]: sub } }))
  const { getByRole, findByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Import profile' }))
  await findByText(title)
  await waitFor(() => expect(calls.some((c) => c.url === `/api/profiles?type=${type}`)).toBe(true))
  expect(calls.some((c) => c.url.startsWith('/api/profiles?') && c.url !== `/api/profiles?type=${type}`)).toBe(false)
})

test('the Cam Explorer opens its default, then saves a new profile with a generated name and its note', async () => {
  const { calls, defaults } = stubStore(allProfiles)
  defaults.cam = '20260326_233901_11.json'
  const { getByRole, getByTestId } = render(<App />)
  // The note column wins over the payload's note, as the old route served it.
  await waitFor(() => expect(getByTestId('profile-name').textContent).toBe('20260326_233901_11.json'))
  fireEvent.click(getByRole('button', { name: 'Save as new profile' }))
  const d = dialog()
  expect((within(d).getByLabelText('Profile note') as HTMLTextAreaElement).value).toBe('startup one')
  fireEvent.change(within(d).getByLabelText('Profile note'), { target: { value: 'second try' } })
  fireEvent.click(within(d).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(getByTestId('profile-name').textContent).toMatch(/^20261119_120000_\d+\.json$/))
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.url).toBe('/api/profiles/cam')
  expect(post.body!.note).toBe('second try')
  const payload = post.body!.payload as Record<string, unknown>
  expect(payload.motor_speed).toBe(120)
  expect(payload.height).toBe(2.4)
  expect(payload.note).toBe('second try')
  expect(payload.chart_settings).toEqual({})
})

test('the Cam Explorer Update overwrites the loaded profile by name', async () => {
  const { calls, defaults } = stubStore(allProfiles)
  defaults.cam = '20260326_233901_11.json'
  const { getByRole, getByTestId, getByPlaceholderText, findByRole } = render(<App />)
  await waitFor(() => expect(getByTestId('profile-name').textContent).toBe('20260326_233901_11.json'))
  fireEvent.change(getByPlaceholderText('Describe this profile...'), { target: { value: 'edited' } })
  fireEvent.click(await findByRole('button', { name: /Update/ }))
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
  const put = calls.find((c) => c.method === 'PUT')!
  expect(put.url).toBe('/api/profiles/cam/20260326_233901_11.json')
  expect(put.body!.note).toBe('edited')
  expect((put.body!.payload as Record<string, unknown>).note).toBe('edited')
  await waitFor(() => expect(getByRole('button', { name: 'Import profile' })).toBeTruthy())
})

test('the Cam Finder opens an experience and saves it with its solve', async () => {
  const { calls } = stubStore(allProfiles)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'cam', sub: { cam: 'finder' } }))
  const { getByRole, getByTestId, findByText, getByText } = render(<App />)
  expect(getByTestId('profile-name').textContent).toBe('Unsaved')
  expect((getByRole('button', { name: 'Save as new profile' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(getByRole('button', { name: 'Import profile' }))
  fireEvent.doubleClick(await findByText('20260417_114007_1.builder.json'))
  await waitFor(() => expect(getByTestId('profile-name').textContent).toBe('20260417_114007_1.builder.json'))
  expect(getByText('Experience note').closest('div')!.querySelector('textarea')!.value).toBe('first solve')
  fireEvent.click(getByRole('button', { name: 'Save as new profile' }))
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.url).toBe('/api/profiles/cam-finder')
  expect(post.body!.note).toBe('first solve')
  const payload = post.body!.payload as Record<string, Record<string, unknown>>
  expect(Object.keys(payload).sort()).toEqual(['builder_params', 'last_solve_request', 'solver_result'])
  expect(payload.builder_params.kMax).toBe(3)
  expect(payload.solver_result.K).toBe(2)
  expect((payload.solver_result.candidates as unknown[]).length).toBe(1)
})

test('a linkage profile round-trips its params, ranges and chart settings, and its name survives a reload', async () => {
  const { calls, store } = stubStore(allProfiles)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: { pendulum: 'explorer' } }))
  const first = render(<App />)
  expect(first.queryByLabelText('Profile name')).toBeNull()
  expect(first.getByRole('button', { name: /Write to Onshape variables/ })).toBeTruthy()
  fireEvent.click(first.getByRole('button', { name: 'Geometry' }))
  fireEvent.click(first.getByRole('button', { name: 'Import profile' }))
  fireEvent.doubleClick(await first.findByText('custom-interessant'))
  await waitFor(() => expect(first.getByTestId('profile-name').textContent).toBe('custom-interessant'))
  await waitFor(() => expect(JSON.parse(localStorage.getItem('cam-sim.linkage.pendulum.v2')!).profile).toBe('custom-interessant'))
  // Saved before the inverted pivot existed: it loads with the carriage pivot on the far side.
  expect(first.getByRole('button', { name: 'Normal' }).getAttribute('aria-pressed')).toBe('true')

  // Save as new: the owner names it; the loaded note is offered.
  fireEvent.click(first.getByRole('button', { name: 'Save as new profile' }))
  const d = await openedDialog()
  expect((within(d).getByLabelText('Profile note') as HTMLTextAreaElement).value).toBe('kept note')
  expect((within(d).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(within(d).getByLabelText('Profile name'), { target: { value: 'copy' } })
  fireEvent.click(within(d).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(first.getByTestId('profile-name').textContent).toBe('copy'))
  const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/profiles/pendulum/copy')!
  const payload = put.body!.payload as { params: Record<string, unknown>; search: Record<string, unknown>; chart_settings: Record<string, Record<string, unknown>> }
  expect(Object.keys(payload).sort()).toEqual(['chart_settings', 'params', 'search'])
  const saved = pendulumProfile.payload as typeof payload
  for (const [k, v] of Object.entries(saved.params)) expect(payload.params[k]).toEqual(v)
  expect(payload.search.bar1_min).toBe(7)
  expect(payload.search.bar1_max).toBe(15)
  expect(payload.search.fixed).toEqual(['foot'])
  expect(payload.params.pivot_inverted).toBe(false)
  expect(payload.search.pivot_side).toBe('normal')
  expect(payload.search.require_seal).toBe(true)
  expect(payload.params.linkage_plane_spacing).toBe(10.75)
  expect(payload.chart_settings.flow).toEqual(saved.chart_settings.flow)

  // Update keeps the note stored with the profile, since the linkage tabs have no note field.
  store.find((p) => p.name === 'copy')!.note = 'note on copy'
  first.unmount()
  const again = render(<App />)
  await waitFor(() => expect(again.getByTestId('profile-name').textContent).toBe('copy'))
  // After a reload the stored profile is read back: the same values flag nothing...
  await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/profiles/pendulum/copy').length).toBeGreaterThan(0))
  expect(again.queryByRole('button', { name: /Update/ })).toBeNull()
  // ...and an edit can be written back to it by Update, with its note.
  fireEvent.click(again.getByText('Pneumatic system'))
  const box = again.getByText('Pressure (kPa)').closest('.space-y-2')!.querySelector('input[type=number]') as HTMLInputElement
  fireEvent.change(box, { target: { value: '130' } })
  fireEvent.click(await again.findByRole('button', { name: /Update/ }))
  await waitFor(() => expect(store.find((p) => p.name === 'copy')!.payload).toMatchObject({ params: { input_pressure_kpa: 130 } }))
  expect(store.find((p) => p.name === 'copy')!.note).toBe('note on copy')
})

test('an existing name asks before it is overwritten, and a refusal writes nothing', async () => {
  const { calls } = stubStore(allProfiles)
  vi.mocked(window.confirm).mockReturnValue(false)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: { pendulum: 'explorer' } }))
  const { getByRole } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Save as new profile' }))
  const d = await openedDialog()
  fireEvent.change(within(d).getByLabelText('Profile name'), { target: { value: 'custom-interessant' } })
  fireEvent.click(within(d).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('"custom-interessant"')))
  expect(calls.some((c) => c.method === 'PUT' || c.method === 'POST')).toBe(false)
})

test('the linkage Update writes nothing when the stored note cannot be read', async () => {
  const { calls, store } = stubStore(allProfiles)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: { pendulum: 'explorer' } }))
  const { getByRole, getByTestId, findByText, findByRole, getByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Import profile' }))
  fireEvent.doubleClick(await findByText('custom-interessant'))
  await waitFor(() => expect(getByTestId('profile-name').textContent).toBe('custom-interessant'))
  fireEvent.click(getByText('Pneumatic system'))
  const box = getByText('Pressure (kPa)').closest('.space-y-2')!.querySelector('input[type=number]') as HTMLInputElement
  fireEvent.change(box, { target: { value: '120' } })
  const update = await findByRole('button', { name: /Update/ })
  const real = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    (!init?.method && String(input).includes('/api/profiles/pendulum/custom-interessant') ? new Response('{}', { status: 500 }) : real(input, init)))
  fireEvent.click(update)
  await findByText(/Not saved/)
  expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  expect(store.find((p) => p.name === 'custom-interessant')!.note).toBe('kept note')
})

test.each([
  ['cam', (payload: Record<string, unknown>) => <CamProfilePreview payload={payload} />],
  ['cam-finder', (payload: Record<string, unknown>) => <FinderProfilePreview payload={payload} />],
  ['elbow', (payload: Record<string, unknown>) => <LinkageProfilePreview kind="elbow" payload={payload} />],
  ['pendulum', (payload: Record<string, unknown>) => <LinkageProfilePreview kind="pendulum" payload={payload} />],
])('the %s preview renders an old or empty payload', (_type, preview) => {
  stubStore([])
  for (const payload of [{}, { params: {}, search: {} }, { solver_result: {} }, { solver_result: { simulation: {} }, builder_params: null }]) {
    expect(() => { render(preview(payload)); cleanup() }).not.toThrow()
  }
})

test('a preview that throws leaves the window working', async () => {
  stubStore(allProfiles)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const onOpen = vi.fn()
  const { findByText, getByText } = render(
    <ProfileImportModal open onClose={() => {}} type="pendulum" renderPreview={() => { throw new Error('bad payload') }} onOpen={onOpen} />)
  fireEvent.mouseEnter(await findByText('custom-interessant'))
  await findByText(/No preview for this profile/)
  fireEvent.doubleClick(getByText('custom-interessant'))
  await waitFor(() => expect(onOpen).toHaveBeenCalled())
})

test('the linkage Update resends the stored note', async () => {
  const { calls } = stubStore(allProfiles)
  localStorage.setItem('cam-sim.tabs.v1', JSON.stringify({ tab: 'pendulum', sub: { pendulum: 'explorer' } }))
  const { getByRole, getByTestId, findByText, findByRole, getByText } = render(<App />)
  fireEvent.click(getByRole('button', { name: 'Import profile' }))
  fireEvent.doubleClick(await findByText('custom-interessant'))
  await waitFor(() => expect(getByTestId('profile-name').textContent).toBe('custom-interessant'))
  fireEvent.click(getByText('Pneumatic system'))
  const box = getByText('Pressure (kPa)').closest('.space-y-2')!.querySelector('input[type=number]') as HTMLInputElement
  fireEvent.change(box, { target: { value: '120' } })
  fireEvent.click(await findByRole('button', { name: /Update/ }))
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
  const put = calls.find((c) => c.method === 'PUT')!
  expect(put.url).toBe('/api/profiles/pendulum/custom-interessant')
  expect(put.body!.note).toBe('kept note')
  expect((put.body!.payload as { params: Record<string, unknown> }).params.input_pressure_kpa).toBe(120)
  await waitFor(() => expect(getByRole('button', { name: 'Import profile' })).toBeTruthy())
})
