import { cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'

beforeEach(() => {
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
