import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { DelayedHoverHint } from './components'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('mobile bottom pane bar switches data-mobile-pane and every tab exposes controls, schematic and charts panes', () => {
  const { container, getByRole } = render(<App />)
  const shell = container.querySelector('.cam-workspace') as HTMLElement
  expect(shell.dataset.mobilePane).toBe('controls')

  const nav = getByRole('tablist', { name: 'Workspace panels' })
  const controlsTab = within(nav).getByRole('tab', { name: 'Controls' })
  const schematicTab = within(nav).getByRole('tab', { name: 'Schematic' })
  const chartsTab = within(nav).getByRole('tab', { name: 'Charts' })
  expect(controlsTab.getAttribute('aria-selected')).toBe('true')

  fireEvent.click(schematicTab)
  expect(shell.dataset.mobilePane).toBe('schematic')
  expect(schematicTab.getAttribute('aria-selected')).toBe('true')

  fireEvent.click(chartsTab)
  expect(shell.dataset.mobilePane).toBe('charts')
  expect(chartsTab.getAttribute('aria-selected')).toBe('true')

  // Verify the 3 pane markers exist across Cam Explorer, Linkage, and Compliant Bars.
  for (const tabName of ['Cam', 'Bar Linkage', 'Compliant Bars']) {
    fireEvent.click(getByRole('button', { name: tabName }))
    expect(container.querySelector('[data-pane="controls"]'), tabName).toBeTruthy()
    expect(container.querySelector('[data-pane="schematic"]'), tabName).toBeTruthy()
    expect(container.querySelector('[data-pane="charts"]'), tabName).toBeTruthy()
  }
})

test('mobile Tools drawer opens Export STL, toggles Guidance, and renders without duplicating controls while closed', () => {
  const { getByRole, queryByText } = render(<App />)
  expect(queryByText('Simulation server')).toBeNull()

  const trigger = getByRole('button', { name: 'Tools and settings' })
  fireEvent.click(trigger)
  expect(getByRole('button', { name: /Guidance hints/ })).toBeTruthy()
  expect(getByRole('button', { name: /Guidance hints/ }).getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(getByRole('button', { name: /Guidance hints/ }))
  expect(getByRole('button', { name: /Guidance hints/ }).getAttribute('aria-pressed')).toBe('false')
})

test('DelayedHoverHint stays closed on touch-only devices (hover: none)', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: q === '(hover: none)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
  const { getByText, queryByRole } = render(
    <DelayedHoverHint content={<span>Tooltip body</span>} delayMs={50}>
      <span>Target</span>
    </DelayedHoverHint>,
  )
  fireEvent.mouseEnter(getByText('Target'))
  vi.advanceTimersByTime(200)
  expect(queryByRole('tooltip')).toBeNull()
  vi.useRealTimers()
})
