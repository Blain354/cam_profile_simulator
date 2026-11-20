import { useTubeSweep } from './tubeSweep';

/**
 * The tube model's values and hooks shared by the tabs: the model switch's two values, the
 * hardness default, Gent's relation, and the FEM closed gap (the sweep itself is in ./tubeSweep.ts). Components are in ../TubeModel.tsx.
 */

export type TubeModel = 'fem' | 'simple';
export const DEFAULT_TUBE_MODEL: TubeModel = 'fem';
export const DEFAULT_SHORE_A = 50;

/** A stored value, or the default when it is missing or not one of the two models. */
export const cleanTubeModel = (raw: unknown): TubeModel => (raw === 'simple' || raw === 'fem' ? raw : DEFAULT_TUBE_MODEL);

/** Gent's relation, as in backend/tube_fem: E (MPa) from Shore A. */
export const shoreToMpa = (s: number) => (0.0981 * (56 + 7.62336 * s)) / (0.137505 * (254 - 2.54 * s));

export interface TubeSpec {
  tube_od: number;
  tube_id: number;
  tube_shore_a: number;
  input_pressure_kpa: number;
  tube_model: TubeModel;
}

/** The FEM's closed gap (the plate distance at which the bore shuts against the pressure): null while it
 * solves or when the FEM refuses the tube (error says why). */
export function useFemClosedGap(tube: TubeSpec): { gap: number | null; error: string | null } {
  const { sweep, error } = useTubeSweep(tube);
  if (tube.tube_model !== 'fem') return { gap: null, error: null };
  return { gap: sweep ? sweep.h_sealed : null, error };
}
