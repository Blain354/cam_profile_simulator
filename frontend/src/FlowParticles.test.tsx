import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FlowParticles, FlowParticlesSwitch } from './FlowParticles'
import type { Bore } from './lib/flowParticles'
import {
  FULL_SPEED, MAX_PARTICLES, countOpacity, flowFraction, fullBoreFlow, particleSpeed, placeSection, placeSide, runningTicks, seed, visibleCount,
} from './lib/flowParticles'

let frames: Map<number, FrameRequestCallback>
let nextId: number
let reduce: boolean

beforeEach(() => {
  localStorage.clear()
  frames = new Map()
  nextId = 1
  reduce = false
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Runs the pending animation frames at time `now` (ms). */
function step(now: number) {
  const pending = [...frames.values()]
  frames.clear()
  act(() => { pending.forEach((cb) => cb(now)) })
}

const shown = (el: Element) => [...el.querySelectorAll('[data-flow-particles] circle')].filter((c) => Number(c.getAttribute('opacity')) > 0)

// A 10 mm tube, 2 mm bore, pinched to 0.4 mm around s = 5.
const pinched: Bore = Array.from({ length: 101 }, (_, i) => {
  const s = i / 10
  const open = 2 - 1.6 * Math.max(0, 1 - Math.abs(s - 5))
  return [s, 1 - open / 2, 1 + open / 2] as const
})

test('density and speed are both proportional to the flow: none at zero, half at half, all at the reference', () => {
  expect(flowFraction(0, 10)).toBe(0)
  expect(flowFraction(5, 10)).toBe(0.5)
  expect(flowFraction(10, 10)).toBe(1)
  expect(flowFraction(12, 10)).toBe(1)
  expect(flowFraction(5, 0)).toBe(0)
  expect(flowFraction(null, 10)).toBe(0)
  for (const view of ['side', 'section'] as const) {
    expect(particleSpeed(0, view)).toBe(0)
    expect(particleSpeed(0.5, view)).toBeCloseTo(FULL_SPEED[view] / 2)
    expect(particleSpeed(1, view)).toBe(FULL_SPEED[view])
  }
  expect(visibleCount(0)).toBe(0)
  expect(visibleCount(0.5)).toBe(MAX_PARTICLES / 2)
  expect(visibleCount(1)).toBe(MAX_PARTICLES)
  const on = (f: number) => Array.from({ length: MAX_PARTICLES }, (_, i) => countOpacity(i, f)).reduce((a, b) => a + b, 0)
  expect(on(0)).toBe(0)
  expect(on(0.5)).toBe(MAX_PARTICLES / 2)
  expect(on(1)).toBe(MAX_PARTICLES)
})

test('the particles shown at half flow are spread along the whole tube', () => {
  const along = Array.from({ length: MAX_PARTICLES / 2 }, (_, i) => seed(i).along)
  for (let k = 0; k < 4; k++) expect(along.filter((a) => a >= k / 4 && a < (k + 1) / 4).length).toBeGreaterThanOrEqual(8)
})

test('side view: every particle stays inside the bore still open where it is, and squeezes at the pinch', () => {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    for (let k = 0; k <= 50; k++) {
      const at = placeSide(pinched, k / 50, seed(i).across, 0.3)
      expect(at).not.toBeNull()
      const s = at!.y, open = 2 - 1.6 * Math.max(0, 1 - Math.abs(s - 5))
      expect(at!.x - at!.r).toBeGreaterThanOrEqual(1 - open / 2 - 1e-9)
      expect(at!.x + at!.r).toBeLessThanOrEqual(1 + open / 2 + 1e-9)
    }
  }
  expect(placeSide(pinched, 0.5, 0.5, 0.3)!.r).toBeCloseTo(0.2)
  // A shut bore holds no particle.
  expect(placeSide([[0, 1, 1], [10, 1, 1]], 0.5, 0.5, 0.3)).toBeNull()
})

test('section view: particles stay inside the open slot and none show when it is shut', () => {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const at = placeSection(0.08, 3, seed(i).along, seed(i).across, seed(i).spread, 0.06)!
    expect(Math.abs(at.x) + at.r).toBeLessThanOrEqual(0.04 + 1e-9)
    expect(Math.abs(at.y) + at.r).toBeLessThanOrEqual(1.5 + 1e-9)
  }
  expect(placeSection(0, 3, 0.5, 0.5, 0.5, 0.06)).toBeNull()
})

test('the loop moves the particles along the flow, and an unmount leaves no animation frame running', () => {
  const { container, unmount } = render(<svg><FlowParticles view="side" frac={1} bore={pinched} direction={1} radius={0.1} color="red" /></svg>)
  expect(shown(container)).toHaveLength(MAX_PARTICLES)
  expect(frames.size).toBe(1)
  const c = container.querySelector('[data-flow-particles] circle')!
  const y0 = Number(c.getAttribute('cy'))
  step(1000)
  step(1100)
  expect(Number(c.getAttribute('cy'))).toBeGreaterThan(y0)
  unmount()
  expect(frames.size).toBe(0)
  expect(runningTicks()).toBe(0)
})

test('zero flow draws nothing and runs no loop', () => {
  const { container } = render(<svg><FlowParticles view="section" frac={0} width={0.5} length={3} radius={0.06} color="red" /></svg>)
  expect(shown(container)).toHaveLength(0)
  expect(frames.size).toBe(0)
})

test('a flow change keeps the particles where they are and shows the new density at once; back to zero, nothing shows or moves', () => {
  const tube = (frac: number) => <svg><FlowParticles view="side" frac={frac} bore={pinched} direction={-1} radius={0.1} color="red" /></svg>
  const { container, rerender } = render(tube(0.25))
  step(0)
  step(50)
  const c = container.querySelector('[data-flow-particles] circle')!
  const y = c.getAttribute('cy')
  expect(shown(container).length).toBeLessThanOrEqual(MAX_PARTICLES / 4)
  rerender(tube(1))
  expect(c.getAttribute('cy')).toBe(y)
  expect(shown(container).length).toBeGreaterThan(MAX_PARTICLES - 5)
  for (let t = 100; t <= 2000; t += 50) step(t)
  expect(Number(c.getAttribute('cy'))).toBeLessThan(Number(y))
  rerender(tube(0))
  expect(shown(container)).toHaveLength(0)
  expect(frames.size).toBe(0)
})

test('the cam reference is the full-bore flow, from the linear flow-vs-area model', () => {
  const area = [0, 0.5, 1.2, 1.2]
  const flow = area.map((a) => 3 * a)
  expect(fullBoreFlow(flow, area, 2)).toBeCloseTo(3 * Math.PI)
  expect(fullBoreFlow([0, 0], [0, 0], 2)).toBe(0)
})

test('side view: on a sloping wall the whole circle stays inside the bore', () => {
  // Bore narrowing steeply from 2 mm to 0.2 mm over 1 mm of tube.
  const slope: Bore = [[0, 0, 2], [4, 0, 2], [5, 0.9, 1.1], [6, 0, 2], [10, 0, 2]]
  const halfOpen = (s: number) => {
    const t = Math.min(Math.abs(s - 5), 1)
    return 0.1 + 0.9 * t
  }
  for (let i = 0; i < MAX_PARTICLES; i++) {
    for (let k = 0; k <= 100; k++) {
      const at = placeSide(slope, k / 100, seed(i).across, 0.3)
      if (!at) continue
      for (let a = 0; a < 16; a++) {
        const px = at.x + at.r * Math.cos(a * Math.PI / 8), py = at.y + at.r * Math.sin(a * Math.PI / 8)
        expect(Math.abs(px - 1)).toBeLessThanOrEqual(halfOpen(py) + 1e-9)
      }
    }
  }
})

test('reduced motion: the same density, drawn still, with no animation frame', () => {
  reduce = true
  const { container } = render(<svg><FlowParticles view="section" frac={0.5} width={0.5} length={3} radius={0.06} color="red" /></svg>)
  expect(frames.size).toBe(0)
  expect(shown(container).length).toBeGreaterThan(MAX_PARTICLES / 2 - 3)
  expect(shown(container).length).toBeLessThanOrEqual(MAX_PARTICLES / 2)
})

test('the switch hides the particles, stops the loop and is remembered', () => {
  const { container, getByRole } = render(<><FlowParticlesSwitch /><svg><FlowParticles view="side" frac={1} bore={pinched} direction={1} radius={0.1} color="red" /></svg></>)
  const sw = getByRole('switch', { name: 'Flow particles' })
  expect(sw.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(sw)
  expect(sw.getAttribute('aria-checked')).toBe('false')
  expect(container.querySelector('[data-flow-particles]')).toBeNull()
  expect(frames.size).toBe(0)
  expect(localStorage.getItem('cam-sim.flow-particles.v1')).toBe('0')
  fireEvent.click(sw)
  expect(localStorage.getItem('cam-sim.flow-particles.v1')).toBe('1')
})

test('a hidden document pauses the loop and it resumes when shown', () => {
  render(<svg><FlowParticles view="side" frac={1} bore={pinched} direction={1} radius={0.1} color="red" /></svg>)
  expect(frames.size).toBe(1)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(frames.size).toBe(0)
  hidden.mockReturnValue(false)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(frames.size).toBe(1)
})

test('a hidden card (its drawing out of view) pauses the loop and it resumes when shown', () => {
  const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = []
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { observers.push(cb) } observe() {} disconnect() {} })
  render(<svg><FlowParticles view="side" frac={1} bore={pinched} direction={1} radius={0.1} color="red" /></svg>)
  expect(observers).toHaveLength(1)
  expect(frames.size).toBe(1)
  act(() => observers[0]([{ isIntersecting: false }]))
  expect(frames.size).toBe(0)
  act(() => observers[0]([{ isIntersecting: true }]))
  expect(frames.size).toBe(1)
})
