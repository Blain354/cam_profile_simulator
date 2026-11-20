import { useEffect, useState } from 'react';
import { apiFetch } from '../components';

/**
 * The tube model's values and hooks shared by the tabs: the model switch's two values, the
 * hardness default, Gent's relation, and the FEM section fetch. Components are in ../TubeModel.tsx.
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

export interface Section {
  h: number;
  outer: [number, number][];
  inner: [number, number][];
  force_per_mm: number;
  pressure_share_per_mm: number;
  open_area_mm2: number;
  bore_area_mm2: number;
  h_contact: number;
  h_closed: number;
  h_sealed: number;
  max_stretch: number;
}

/** The FEM section at plate distance h (mm), fetched a moment after h settles. A section or an
 * error solved for another tube (OD, ID, hardness, pressure) is not shown: a new tube can take a
 * second or two to solve, and its old shape would pass for the new one meanwhile. */
export function useSection(tube: TubeSpec, h: number | null) {
  const [answer, setAnswer] = useState<{ key: string; section: Section | null; error: string | null } | null>(null);
  const hKey = h == null || !Number.isFinite(h) ? null : Math.round(h * 1000) / 1000;
  const { tube_od, tube_id, tube_shore_a, input_pressure_kpa, tube_model } = tube;
  const tubeKey = `${tube_od}|${tube_id}|${tube_shore_a}|${input_pressure_kpa}`;
  useEffect(() => {
    if (tube_model !== 'fem' || hKey == null) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      apiFetch('/api/tube/section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tube_od, tube_id, tube_shore_a, input_pressure_kpa, h: Math.max(hKey, 0) }),
        signal: ctl.signal,
      })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new Error(body?.detail ? String(body.detail) : `HTTP ${res.status}`);
          if (!body || !Array.isArray(body.outer) || !Array.isArray(body.inner)) throw new Error('No tube section in the answer');
          setAnswer({ key: tubeKey, section: body as Section, error: null });
        })
        .catch((e) => { if (!ctl.signal.aborted) setAnswer({ key: tubeKey, section: null, error: e instanceof Error ? e.message : String(e) }); });
    }, 120);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [tube_od, tube_id, tube_shore_a, input_pressure_kpa, tube_model, hKey, tubeKey]);
  const current = answer && answer.key === tubeKey ? answer : null;
  return { section: current?.section ?? null, error: current?.error ?? null };
}

/** The FEM's closed gap (the plate distance at which the bore shuts against the pressure), or null while unknown. */
export function useFemClosedGap(tube: TubeSpec): number | null {
  const { section } = useSection(tube, tube.tube_od);
  return tube.tube_model === 'fem' && section ? section.h_sealed : null;
}
