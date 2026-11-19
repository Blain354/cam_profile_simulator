import { expect, test } from 'vitest'
import { PSI_TO_KPA, formatKpa, legacyPsiToKpa } from './pressure'

test('a stored psi pressure comes back in kPa under the new name', () => {
  const got = legacyPsiToKpa<{ params: Record<string, number> }>({ params: { input_pressure_psi: 15, tube_id: 2 } })
  expect(got.params).toEqual({ tube_id: 2, input_pressure_kpa: 15 * PSI_TO_KPA })
  expect(got.params.input_pressure_kpa).toBeCloseTo(103.421355, 6)
})

test('the conversion is idempotent, and a kPa key next to a psi key wins', () => {
  const once = legacyPsiToKpa({ input_pressure_psi: 15 })
  expect(legacyPsiToKpa(once)).toEqual(once)
  expect(legacyPsiToKpa({ input_pressure_psi: 15, input_pressure_kpa: 100 })).toEqual({ input_pressure_kpa: 100 })
})

test('nested objects and lists are converted, other values pass through', () => {
  expect(legacyPsiToKpa({ a: [{ pressurePsi: 1 }, 2, null], b: 'x' })).toEqual({ a: [{ pressureKpa: PSI_TO_KPA }, 2, null], b: 'x' })
  expect(legacyPsiToKpa(null)).toBeNull()
})

test('a converted pressure shows one decimal, a whole one none', () => {
  expect(formatKpa(15 * PSI_TO_KPA)).toBe('103.4')
  expect(formatKpa(100)).toBe('100')
})
