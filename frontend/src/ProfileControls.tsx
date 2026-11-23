import { Button, Input, Modal, Textarea } from '@blain-projects/ui';
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Import, RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { PROFILE_TYPE_LABEL, formatProfileDate, getProfile, listProfiles, nameIsOptional, removeProfile, setDefaultProfile } from './lib/profiles';
import type { ProfilePayload, ProfileState, ProfileSummary, ProfileType, StoredProfile } from './lib/profiles';

// ─── Header pill ─────────────────────────────────────────────────

export function ProfilePill({ state, onImport, onSaveAsNew, onUpdate, onRevert }: {
  state: ProfileState;
  onImport: () => void;
  onSaveAsNew: () => void;
  onUpdate: () => void;
  onRevert: () => void;
}) {
  const { name, dirty, canSave } = state;
  const label = name ?? 'Unsaved';
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 flex-nowrap min-w-0 max-w-full">
      <div className={`inline-flex min-w-0 max-w-full items-center gap-0 rounded-xl border p-0.5 sm:p-1 shadow-sm transition-colors ${dirty ? 'border-amber-500/35 bg-amber-950/20' : 'border-neutral-700/80 bg-neutral-800/50'}`} title={label}>
        <div className={`flex min-w-[4.5rem] max-w-[8.5rem] sm:min-w-0 sm:max-w-[12rem] items-center gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-2.5 py-1.5 ${dirty ? 'bg-amber-500/5' : 'bg-neutral-900/40'}`}>
          <span className="hidden sm:inline shrink-0 text-[10px] font-semibold text-neutral-500">Profile</span>
          <span data-testid="profile-name" className={`min-w-0 truncate font-mono text-xs font-medium tabular-nums ${dirty ? 'text-amber-300' : name ? 'text-emerald-400' : 'text-neutral-400'}`}>
            {label}
          </span>
          {dirty && <span className="shrink-0 -ml-1.5 font-mono text-xs text-amber-400" aria-label="Unsaved changes">*</span>}
        </div>
        <Button variant="ghost" type="button" onClick={onImport}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700/80 hover:text-white"
          title="Import a saved profile" aria-label="Import profile">
          <Import className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
          <span className="hidden min-[1800px]:inline">Import</span>
        </Button>
        <Button variant="ghost" type="button" onClick={onSaveAsNew} disabled={!canSave}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700/80 hover:text-white disabled:opacity-40"
          title={canSave ? 'Save as a new profile' : 'Nothing to save yet'} aria-label="Save as new profile">
          <Save className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
          <span className="hidden min-[1800px]:inline">Save as new</span>
        </Button>
      </div>
      <AnimatePresence>
        {canSave && dirty && (
          name ? (
            <motion.div
              key="dirty-actions"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="flex flex-col gap-0.5 shrink-0"
            >
              <button
                type="button"
                onClick={onUpdate}
                className="relative w-full cursor-pointer px-2 py-[2px] bg-amber-500 hover:bg-amber-400 text-neutral-900 border border-amber-400 rounded-full flex items-center justify-center gap-1 transition-all font-bold text-[10px] leading-3"
                title={`Overwrite ${name}`}
              >
                <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-100" />
                </span>
                <RefreshCw className="w-2.5 h-2.5 shrink-0" aria-hidden /> Update
              </button>
              <button
                type="button"
                onClick={onRevert}
                className="w-full cursor-pointer px-2 py-[2px] bg-neutral-800/70 hover:bg-neutral-700/80 text-neutral-400 hover:text-neutral-100 border border-neutral-700 rounded-full flex items-center justify-center gap-1 transition-all font-semibold text-[10px] leading-3"
                title={`Revert to saved ${name}`}
              >
                <RotateCcw className="w-2.5 h-2.5 shrink-0" aria-hidden /> Revert
              </button>
            </motion.div>
          ) : (
            <motion.button
              key="dirty-save"
              type="button"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              onClick={onSaveAsNew}
              className="relative shrink-0 cursor-pointer px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-neutral-900 border border-amber-400 rounded-full flex items-center gap-1.5 transition-all font-bold text-[10px]"
              title="Save as a new profile"
            >
              <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-100" />
              </span>
              <RefreshCw className="w-3 h-3" aria-hidden /> Save
            </motion.button>
          )
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Save as new ─────────────────────────────────────────────────

export function ProfileSaveDialog({ open, type, initialName = '', initialNote, onClose, onSave }: {
  open: boolean;
  type: ProfileType;
  initialName?: string;
  initialNote: string;
  onClose: () => void;
  /** An empty name means a generated one. */
  onSave: (name: string, note: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setNote(initialNote);
    setError(null);
    setBusy(false);
  }, [open, initialName, initialNote]);
  const optional = nameIsOptional(type);
  const limit = optional ? 120 : 60;
  const trimmed = name.trim();
  const submit = async () => {
    if (busy) return;
    if (!trimmed && !optional) { setError('Give the profile a name first.'); return; }
    if (trimmed.includes('/')) { setError('A profile name cannot contain a slash.'); return; }
    if (trimmed === 'default') { setError('"default" is reserved.'); return; }
    setBusy(true);
    setError(null);
    try {
      if (await onSave(trimmed, note)) onClose();
    } catch (e) {
      setError(`Not saved: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Save as new profile" size="sm">
      <div className="space-y-3 p-4">
        <p className="text-xs text-neutral-500">Saved with the {PROFILE_TYPE_LABEL[type].toLowerCase()}.</p>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-neutral-400">Name</span>
          <Input type="text" value={name} maxLength={limit} autoFocus
            placeholder={optional ? 'Empty for a generated name' : 'Profile name'} aria-label="Profile name"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-neutral-400">Note (optional)</span>
          <Textarea value={note} rows={3} aria-label="Profile note" onChange={(e) => setNote(e.target.value)}
            className="w-full resize-y rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100" />
        </label>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-bold text-neutral-300">
            Cancel
          </Button>
          <Button variant="ghost" type="button" onClick={() => void submit()} disabled={busy || (!optional && !trimmed)}
            className="flex items-center gap-1.5 rounded-lg border border-blue-500 bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-40">
            <Save className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Import window ───────────────────────────────────────────────

/** A preview that throws on an odd payload says so instead of taking the window down. */
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return <div className="w-full h-full flex items-center justify-center p-4 text-center text-neutral-500 text-sm">No preview for this profile; it can still be opened.</div>;
    }
    return this.props.children;
  }
}

/** Calls the feature's preview inside the boundary, so what it throws is caught there. */
function PreviewOf({ render, payload }: { render: (payload: ProfilePayload) => ReactNode; payload: ProfilePayload }) {
  return <>{render(payload)}</>;
}

/**
 * The app's one import window: the saved profiles of one type, a search, a preview on hover,
 * double-click or Open to load, delete, and the type's default.
 */
export function ProfileImportModal({ open, onClose, type, renderPreview, onOpen, onDeleted }: {
  open: boolean;
  onClose: () => void;
  type: ProfileType;
  /** The feature's own preview of a stored payload. */
  renderPreview: (payload: ProfilePayload) => ReactNode;
  onOpen: (profile: StoredProfile) => void;
  onDeleted?: (name: string) => void;
}) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<StoredProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, StoredProfile>());
  /** The last name hovered or picked: a late answer for another one is dropped. */
  const wanted = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const out = await listProfiles(type);
      setProfiles(out.profiles);
      setDefaultName(out.default);
      setError(null);
    } catch (e) {
      setError(`Could not list the profiles: ${e instanceof Error ? e.message : e}`);
    }
  };

  useEffect(() => {
    if (!open) return;
    cache.current.clear();
    wanted.current = null;
    setSelected(null);
    setPreview(null);
    setQuery('');
    setProfiles([]);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type]);

  const fetchOne = async (name: string) => {
    const hit = cache.current.get(name);
    if (hit) return hit;
    const p = await getProfile(type, name);
    cache.current.set(name, p);
    return p;
  };

  const show = async (name: string) => {
    wanted.current = name;
    try {
      const p = await fetchOne(name);
      if (wanted.current === name) setPreview(p);
    } catch { /* the list entry stays; opening it will say why */ }
  };

  const openProfile = async (name: string) => {
    try {
      const p = await fetchOne(name);
      onOpen(p);
      onClose();
    } catch (e) {
      setError(`Could not open ${name}: ${e instanceof Error ? e.message : e}`);
      void refresh();
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete the saved profile "${name}"?`)) return;
    try {
      await removeProfile(type, name);
      cache.current.delete(name);
      if (selected === name) setSelected(null);
      if (preview?.name === name) setPreview(null);
      onDeleted?.(name);
    } catch (e) {
      setError(`Could not delete ${name}: ${e instanceof Error ? e.message : e}`);
    }
    void refresh();
  };

  const makeDefault = async (name: string) => {
    try {
      await setDefaultProfile(type, name);
      setDefaultName(name);
    } catch (e) {
      setError(`Could not set the default: ${e instanceof Error ? e.message : e}`);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q) || (p.note || '').toLowerCase().includes(q));
  }, [profiles, query]);

  return (
    <Modal open={open} onClose={onClose} title={PROFILE_TYPE_LABEL[type]} size="lg">
      <div className="flex h-[min(74dvh,640px)] md:h-[min(62vh,640px)] min-h-0 flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-neutral-800 md:w-60 md:flex-none md:border-b-0 md:border-r">
          <div className="border-b border-neutral-800/70 px-3 pb-2 pt-1">
            <Input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search profiles"
              className="w-full rounded-md border border-neutral-700 bg-neutral-900/80 px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-500" />
          </div>
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-2 space-y-1" role="list">
            {filtered.map(({ name, note, updated_at }) => (
              <div key={name} role="listitem" className="group relative flex items-start min-w-0 max-w-full">
                <Button variant="ghost" type="button" onMouseEnter={() => { void show(name); }}
                  onClick={() => { setSelected(name); void show(name); }}
                  onDoubleClick={() => { void openProfile(name); }} title={`${name} (double-click to open)`}
                  className={`!flex !flex-col !items-stretch !justify-start min-w-0 w-full max-w-full text-left px-3 py-2 rounded-lg text-xs transition-all pr-12 ${selected === name ? 'bg-blue-600 text-white font-bold' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}>
                  <div className="flex items-start justify-between gap-2 w-full min-w-0">
                    <span className="font-mono break-all [overflow-wrap:anywhere] text-left leading-snug">{name}</span>
                    {defaultName === name && (
                      <div className="flex items-center gap-1 bg-emerald-500 text-white px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 mt-0.5">
                        Default
                      </div>
                    )}
                  </div>
                  {note.trim() ? (
                    <p className={`mt-1 text-[10px] leading-snug line-clamp-2 font-normal break-words [overflow-wrap:anywhere] ${selected === name ? 'text-blue-100/90' : 'text-neutral-500 group-hover:text-neutral-400'}`}>{note.trim()}</p>
                  ) : null}
                  {formatProfileDate(updated_at) && (
                    <p className={`mt-0.5 text-[10px] font-normal font-mono ${selected === name ? 'text-blue-100/70' : 'text-neutral-600'}`}>{formatProfileDate(updated_at)}</p>
                  )}
                </Button>
                <Button variant="ghost" type="button" onClick={(e) => { e.stopPropagation(); void remove(name); }}
                  className="absolute right-1.5 top-1.5 p-1.5 rounded-md text-neutral-500 hover:text-red-400 hover:bg-red-500/10 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 transition-all"
                  title={`Delete ${name}`} aria-label={`Delete ${name}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-neutral-500">
                {profiles.length ? 'No matching profile' : 'No saved profile yet'}
              </div>
            )}
          </div>
          <div className="p-2.5 md:p-4 border-t border-neutral-800">
            <Button variant="ghost" type="button" disabled={!selected} onClick={() => { if (selected) void openProfile(selected); }}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold transition-all shadow-lg">
              Open
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="px-3 py-2.5 md:p-4 border-b border-neutral-800 flex justify-between items-center gap-2 bg-neutral-900/40">
            <h4 className="text-xs font-bold text-neutral-500">Preview</h4>
            {selected && (
              <Button variant="ghost" type="button" onClick={() => void makeDefault(selected)} disabled={defaultName === selected}
                className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${defaultName === selected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 opacity-50' : 'bg-blue-600/10 border-blue-500/30 text-blue-400 hover:bg-blue-600/20'}`}>
                {defaultName === selected ? 'Is default' : 'Set as default'}
              </Button>
            )}
          </div>
          {error && <p className="px-4 pt-2 text-xs text-red-400" role="alert">{error}</p>}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {preview ? (
              <>
                <div className="min-h-0 flex-1 overflow-hidden" data-testid="profile-preview">
                  <PreviewBoundary key={preview.name}><PreviewOf render={renderPreview} payload={preview.payload} /></PreviewBoundary>
                </div>
                {preview.note.trim() ? (
                  <div className="shrink-0 p-3 md:p-4 bg-neutral-900 border-t border-neutral-800 space-y-1">
                    <div className="text-[10px] text-neutral-500 font-bold">Note</div>
                    <p className="text-xs text-neutral-200 leading-relaxed whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{preview.note.trim()}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center p-4 text-center text-neutral-600 text-sm font-medium">Select a profile to preview it</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
