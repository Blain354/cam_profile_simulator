/** Pressures are in kPa. States saved in this browser before that carried psi under old names. */
export const PSI_TO_KPA = 6.894757;

/** Old key -> new key, wherever it sits (same table as backend/legacy_units.py). */
const LEGACY_PSI_KEYS: Record<string, string> = {
  input_pressure_psi: 'input_pressure_kpa',
  seal_pressure_y0_psi: 'seal_pressure_y0_kpa',
  pressurePsi: 'pressureKpa',
};

/**
 * A copy of `value` with every legacy psi key, at any depth, renamed and converted to kPa.
 * Idempotent: a kPa key already there wins, and the psi key next to it is dropped.
 */
export function legacyPsiToKpa<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => legacyPsiToKpa(v)) as T;
  if (!value || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) if (!(key in LEGACY_PSI_KEYS)) out[key] = legacyPsiToKpa(v);
  for (const [psiKey, kpaKey] of Object.entries(LEGACY_PSI_KEYS)) {
    if (psiKey in src && !(kpaKey in src)) {
      const old = src[psiKey];
      out[kpaKey] = typeof old === 'number' ? old * PSI_TO_KPA : old;
    }
  }
  return out as T;
}

/** A pressure as typed: whole kPa as is, a converted one (103.42…) to one decimal. */
export const formatKpa = (kpa: number): string => (Number.isInteger(kpa) ? String(kpa) : kpa.toFixed(1));
