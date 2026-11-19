import { useEffect, useRef } from 'react';
import { apiFetch } from '../components';

/** One saved-profile store for the whole app; each feature has its own type and payload shape. */
export type ProfileType = 'cam' | 'cam-finder' | 'elbow' | 'lever' | 'pendulum';

export type ProfilePayload = Record<string, unknown>;

export interface ProfileSummary {
  name: string;
  type: ProfileType;
  note: string;
  updated_at: string;
  created_at: string;
  is_default: boolean;
}

export interface StoredProfile {
  name: string;
  type: ProfileType;
  note: string;
  payload: ProfilePayload;
  updated_at: string;
}

export interface SaveResult {
  status: 'saved' | 'updated';
  name: string;
}

/** What the import window's title says it lists. */
export const PROFILE_TYPE_LABEL: Record<ProfileType, string> = {
  cam: 'Cam profiles',
  'cam-finder': 'Cam Finder profiles',
  elbow: 'Bar linkage profiles',
  lever: 'Lever linkage profiles',
  pendulum: 'Pendulum linkage profiles',
};

const base = (type: ProfileType) => `/api/profiles/${encodeURIComponent(type)}`;
const one = (type: ProfileType, name: string) => `${base(type)}/${encodeURIComponent(name)}`;
const json = { 'Content-Type': 'application/json' };

/** The server's `detail` when it gives one, so a refused name says why. */
async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = await res.json().catch(() => null);
  const detail = body && typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`;
  throw new Error(detail);
}

export async function listProfiles(type: ProfileType): Promise<{ profiles: ProfileSummary[]; default: string | null }> {
  const res = await check(await apiFetch(`/api/profiles?type=${encodeURIComponent(type)}`));
  const data = await res.json().catch(() => null);
  const profiles = data && Array.isArray(data.profiles) ? data.profiles as ProfileSummary[] : [];
  return { profiles, default: data && typeof data.default === 'string' ? data.default : null };
}

export async function getProfile(type: ProfileType, name: string): Promise<StoredProfile> {
  const res = await check(await apiFetch(one(type, name)));
  const data = await res.json();
  return {
    name: typeof data.name === 'string' ? data.name : name,
    type,
    note: typeof data.note === 'string' ? data.note : '',
    payload: data.payload && typeof data.payload === 'object' ? data.payload : {},
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
  };
}

/** Create or overwrite the profile of that name. */
export async function saveProfile(type: ProfileType, name: string, payload: ProfilePayload, note: string): Promise<SaveResult> {
  const res = await check(await apiFetch(one(type, name), { method: 'PUT', headers: json, body: JSON.stringify({ payload, note }) }));
  return res.json();
}

/** Save under a name the server generates. */
export async function createProfile(type: ProfileType, payload: ProfilePayload, note: string): Promise<SaveResult> {
  const res = await check(await apiFetch(base(type), { method: 'POST', headers: json, body: JSON.stringify({ payload, note }) }));
  return res.json();
}

/** Delete a profile; deleting the type's default clears the default on the server. */
export async function removeProfile(type: ProfileType, name: string): Promise<void> {
  await check(await apiFetch(one(type, name), { method: 'DELETE' }));
}

export async function getDefaultProfile(type: ProfileType): Promise<string | null> {
  const res = await check(await apiFetch(`${base(type)}/default`));
  const data = await res.json().catch(() => null);
  return data && typeof data.default === 'string' && data.default !== 'none' ? data.default : null;
}

export async function setDefaultProfile(type: ProfileType, name: string): Promise<void> {
  await check(await apiFetch(`${base(type)}/default/${encodeURIComponent(name)}`, { method: 'PUT' }));
}

// ─── The contract between the header pill and each feature ─────

/** What a feature reports to the header pill. */
export interface ProfileState {
  /** The loaded profile, or null when nothing saved is loaded. */
  name: string | null;
  /** Unsaved changes against the loaded profile. */
  dirty: boolean;
  /** Whether there is something to save (the Cam Finder needs a solve first). */
  canSave: boolean;
  /** The note the feature edits; undefined when it has no note field (the stored note is kept). */
  note?: string;
}

/** What the header calls on the feature of the open tab. */
export interface ProfileHandle {
  /** The payload to store, in the feature's own shape. */
  getPayload: (note: string) => ProfilePayload;
  /** Load a stored profile into the feature. */
  apply: (profile: StoredProfile) => void;
  /** The payload was stored under this name and note. */
  markSaved: (name: string, note: string, payload: ProfilePayload) => void;
  /** The loaded profile was deleted: keep the values, forget the name. */
  detach: () => void;
}

export const UNSAVED_PROFILE: ProfileState = { name: null, dirty: false, canSave: true };

const sameState = (a: ProfileState, b: ProfileState) =>
  a.name === b.name && a.dirty === b.dirty && a.canSave === b.canSave && a.note === b.note;

/** Report a feature's profile state upward only when it changes. */
export function useReportProfileState(state: ProfileState, onChange?: (state: ProfileState) => void) {
  const last = useRef<ProfileState | null>(null);
  useEffect(() => {
    if (!onChange || (last.current && sameState(last.current, state))) return;
    last.current = state;
    onChange(state);
  });
}

/** `2026-03-26 23:39` in local time, or nothing for a missing date. */
export function formatProfileDate(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Cam and Cam Finder names are generated when left empty; the owner names linkage profiles. */
export const nameIsOptional = (type: ProfileType) => type === 'cam' || type === 'cam-finder';

/** The profile type a tab and sub-tab save and import: a linkage profile holds its Explorer and Finder settings together. */
export function profileTypeOf(tab: 'cam' | 'linkage' | 'lever' | 'pendulum', sub: 'explorer' | 'finder'): ProfileType {
  if (tab === 'cam') return sub === 'finder' ? 'cam-finder' : 'cam';
  return tab === 'linkage' ? 'elbow' : tab;
}
