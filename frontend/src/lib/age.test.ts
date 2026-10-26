import { expect, test } from 'vitest'
import { ageOf } from './age'

const now = new Date(2026, 9, 26)

test('reads a commit date as a short French age', () => {
  expect(ageOf('2026-10-26', now)).toBe('aujourd’hui')
  expect(ageOf('2026-10-25', now)).toBe('hier')
  expect(ageOf('2026-10-24', now)).toBe('il y a 2 j')
  expect(ageOf('2026-06-26', now)).toBe('il y a 4 mois')
  expect(ageOf('2024-09-01', now)).toBe('il y a 2 ans')
})

test('gives nothing for a missing or malformed date', () => {
  expect(ageOf('', now)).toBeUndefined()
  expect(ageOf('hier', now)).toBeUndefined()
})
