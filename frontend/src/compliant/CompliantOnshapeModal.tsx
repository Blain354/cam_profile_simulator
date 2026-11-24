import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@blain-projects/ui';
import { Check, Copy, UploadCloud } from 'lucide-react';
import { apiFetch } from '../components';
import { buildOnshapeFallbackPrompt, copyTextToClipboard } from '../lib/onshapeFallbackPrompt';
import type { CompliantParams, SolverConstraints } from './types';

/** One variable of a table (backend `onshape_variables.Row`). */
export interface CompliantOnshapeRow {
  name: string; key: string; label: string; new_expression: string; current_expression: string | null;
  status: 'update' | 'same' | 'new' | 'written' | 'created' | 'skipped' | 'error';
  detail: string;
}
interface TableState {
  rows: CompliantOnshapeRow[]; table_name: string; table_exists: boolean; table_created: boolean;
  element_id: string | null; table_url: string | null; write_error?: string | null;
  document_id?: string | null; workspace_id?: string | null; document_url?: string | null;
}
interface InputCheck {
  configured: boolean; valid: boolean; error: string | null; part_studio_url: string | null;
  rows: { key: string; variable: string; label: string; unit: string; value: number; simulator: number; ok: boolean }[];
}
interface CadCheck {
  configured: boolean; coherent: boolean; error: string | null;
  rows: { name: string; label: string; unit: string; simulator: number; onshape: number | null; ok: boolean }[];
}
/** Each member's tightest bend against half its thickness (backend `compliant_bars.skin_check`). */
interface SkinCheck {
  valid: boolean; message: string | null;
  rows: { member: string; label: string; thickness_variable: string; min_radius_mm: number | null; half_thickness_mm: number; ok: boolean }[];
}
/** Reply of /api/compliant/onshape/preview and /apply (backend `onshape_compliant`). */
export interface CompliantOnshapeReply {
  tables: TableState[]; api_calls: number; input_check: InputCheck; cad_check: CadCheck; skin_check?: SkinCheck;
  write_error?: string | null;
  document_id?: string | null; workspace_id?: string | null; document_url?: string | null;
}

/** What each table holds: the window says it so the split is visible. */
const TABLE_ROLE: Record<string, string> = {
  cam_sim_compliant: 'Specific to compliant bars: anchor, junction, tip height, handles, thicknesses.',
  cam_sim_carriage: 'The carriage, shared with the other mechanisms: pivot height, offset and side (-1: on the tube side).',
  cam_sim_pinch: 'The pinch, shared with the other mechanisms: closed gap of the tube, preload.',
};

async function call(path: string, body: unknown): Promise<CompliantOnshapeReply> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.json().then((j) => (typeof j.detail === 'string' ? j.detail : null)).catch(() => null);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const STATUS: Record<CompliantOnshapeRow['status'], [string, string]> = {
  update: ['will change', 'text-amber-300'], same: ['already equal', 'text-neutral-500'], new: ['will be added', 'text-amber-300'],
  written: ['written', 'text-emerald-400'], created: ['added', 'text-emerald-400'], skipped: ['left as is', 'text-neutral-500'], error: ['failed', 'text-red-400'],
};
const pickable = (r: CompliantOnshapeRow) => r.status === 'update' || r.status === 'new' || r.status === 'error';

/**
 * Shows what the three Onshape tables of the compliant bars hold against the design on screen, then writes the
 * ticked variables, each into its own table. The tube and the depth are not written: the CAD decides them, and
 * the write is refused until the design starts from what Onshape measures.
 */
export function CompliantOnshapeModal({ open, onClose, params, constraints, onSyncMeasured }: {
  open: boolean; onClose: () => void; params: CompliantParams; constraints: SolverConstraints;
  /** Copies the values Onshape measures into the design (the tab's Load CAD values); the window then checks again. */
  onSyncMeasured: () => void;
}) {
  const [reply, setReply] = useState<CompliantOnshapeReply | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'read' | 'write' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const staleRef = useRef(0);
  const writingRef = useRef(false);
  const recheckRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
  }, []);

  // One read per opening (or after a sync), never per change on screen: each read costs Onshape API calls.
  const read = () => {
    const ticket = ++staleRef.current;
    setReply(null); setError(null); setDone(false); setCopyState('idle'); setBusy('read');
    call('/api/compliant/onshape/preview', { ...params, constraints })
      .then((r) => {
        if (ticket !== staleRef.current) return;
        setReply(r);
        setPicked(new Set(r.tables.flatMap((t) => t.rows.filter((row) => row.status === 'update' || row.status === 'new').map((row) => row.name))));
      })
      .catch((e) => { if (ticket === staleRef.current) setError(e instanceof Error ? e.message : 'Could not read the Onshape tables.'); })
      .finally(() => { if (ticket === staleRef.current) setBusy(null); });
  };

  useEffect(() => {
    if (!open) { staleRef.current++; return; }
    read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && recheckRef.current) { recheckRef.current = false; read(); }
    // Only a sync sets recheckRef: the values to check are the synced ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const check = reply?.input_check;
  const cad = reply?.cad_check;
  const cadByName = new Map((cad?.rows ?? []).map((c) => [c.name, c]));
  const skins = reply?.skin_check;
  const unskinnable = skins != null && !skins.valid;
  const blocked = (check != null && check.configured && !check.valid) || unskinnable;
  const allRows = reply ? reply.tables.flatMap((t) => t.rows) : [];
  const chosen = allRows.filter((r) => pickable(r) && picked.has(r.name));
  const n = chosen.length;
  const toggle = (name: string) => setPicked((p) => { const s = new Set(p); if (s.has(name)) s.delete(name); else s.add(name); return s; });

  const sync = () => { recheckRef.current = true; onSyncMeasured(); };

  const write = async () => {
    if (!reply || writingRef.current) return;
    writingRef.current = true;
    setBusy('write'); setError(null); setCopyState('idle');
    try {
      const r = await call('/api/compliant/onshape/apply', { ...params, constraints, names: chosen.map((row) => row.name) });
      setReply(r);
      if (r.write_error) setError(`A write did not go through: ${r.write_error}. Writing again reads each table first, then writes.`);
      else setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The write to Onshape failed.');
    } finally {
      writingRef.current = false;
      setBusy(null);
    }
  };

  const copyAgentPrompt = async (errorMessage: string) => {
    const prompt = buildOnshapeFallbackPrompt({
      mechanism: 'Compliant Bars',
      error: errorMessage,
      tables: reply?.tables ?? [],
      selectedNames: picked,
      fallbackTableNames: Object.keys(TABLE_ROLE),
      documentId: reply?.document_id,
      workspaceId: reply?.workspace_id,
      documentUrl: reply?.document_url,
      partStudioUrl: reply?.input_check?.part_studio_url,
    });
    const ok = await copyTextToClipboard(prompt);
    setCopyState(ok ? 'copied' : 'failed');
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2500);
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" closeOnOverlayClick={busy == null} closeOnEsc={busy == null} showClose={busy == null}
      title="Write this design to the Onshape variable tables">
      <div className="space-y-3 text-sm">
        <p className="text-xs leading-snug text-neutral-400">
          The design is split across three Variable Studios so that no quantity exists twice. The tube (size and position) and
          the out-of-plane depth are not written: the CAD decides them, and the write is allowed only when the design starts from them.
        </p>
        {busy === 'read' && <p className="text-neutral-400" role="status">Reading the tables in Onshape…</p>}
        {error && (
          <div className="rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">
            <p>{error}</p>
            <Button variant="ghost" type="button" onClick={() => copyAgentPrompt(error)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-400/60 px-2 py-1 text-xs font-bold text-red-100 hover:bg-red-900/50">
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? 'Copied prompt' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt for agent'}
            </Button>
          </div>
        )}
        {reply && (
          <>
            {skins && !skins.valid && (
              <div className="rounded-lg border border-red-500/50 bg-red-900/30 p-2 text-xs text-red-200" role="alert">
                <p className="font-bold">Onshape cannot build this shape: a member bends tighter than half its thickness, so its skin does not exist.</p>
                {skins.rows.filter((r) => !r.ok).map((r) => (
                  <p key={r.member} className="mt-1 font-mono">
                    {r.label}: tightest radius {r.min_radius_mm == null ? '∞' : r.min_radius_mm.toFixed(3)} mm, half of #{r.thickness_variable} {r.half_thickness_mm.toFixed(3)} mm ✗
                  </p>
                ))}
                <p className="mt-1">Open the bend with the handles or thin the member, then read again.</p>
              </div>
            )}
            {check?.configured && (
              <div className={`rounded-lg border p-2 text-xs ${check.valid ? 'border-emerald-600/60 bg-emerald-900/20 text-emerald-200' : 'border-red-500/50 bg-red-900/30 text-red-200'}`} role="status">
                <p className="font-bold">
                  {check.valid ? 'Valid export: the design starts from the inputs Onshape measures now.' : 'Export not valid: the design does not start from the inputs Onshape measures now.'}
                </p>
                {check.error && <p className="mt-1">{check.error}</p>}
                {check.rows.map((r) => (
                  <p key={r.key} className="mt-1 font-mono">
                    {r.label}: simulator {r.simulator.toFixed(4)} {r.unit}, Onshape #{r.variable} {r.value.toFixed(4)} {r.unit} {r.ok ? '✓' : '✗'}
                  </p>
                ))}
                {!check.valid && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="ghost" type="button" onClick={sync} disabled={busy != null}
                      className="rounded-lg border border-red-400/60 px-2 py-1 text-xs font-bold text-red-100 disabled:opacity-40">
                      Load CAD values and check again
                    </Button>
                    {check.error && !error && (
                      <Button variant="ghost" type="button" onClick={() => copyAgentPrompt(check.error!)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/60 px-2 py-1 text-xs font-bold text-red-100 hover:bg-red-900/50">
                        {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copyState === 'copied' ? 'Copied prompt' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt for agent'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {done && cad?.configured && (
              <div className={`rounded-lg border p-2 text-xs ${cad.coherent ? 'border-emerald-600/60 bg-emerald-900/20 text-emerald-200' : 'border-amber-500/60 bg-amber-900/20 text-amber-100'}`} role="status">
                <p className="font-bold">
                  {cad.coherent
                    ? 'Coherent: the Part Studio now uses every value written.'
                    : 'Not coherent: the Part Studio does not use some of the values written. Check that it references the three tables and has no local variable of the same name.'}
                </p>
                {cad.error && <p className="mt-1">{cad.error}</p>}
              </div>
            )}
            <div className="max-h-[50vh] space-y-3 overflow-auto">
              {reply.tables.map((t) => (
                <section key={t.table_name} aria-label={t.table_name} className="rounded-lg border border-neutral-700">
                  <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-800 px-2 py-1.5">
                    <span>
                      <span className="font-mono text-xs font-bold text-neutral-100">{t.table_name}</span>
                      <span className="ml-2 text-[10px] text-neutral-500">
                        {t.table_created ? 'created' : t.table_exists ? 'exists' : 'missing: writing creates it'}
                      </span>
                    </span>
                    {t.table_url && <a href={t.table_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-amber-300 underline">Open in Onshape</a>}
                    <span className="block w-full text-[10px] text-neutral-500">{TABLE_ROLE[t.table_name] ?? ''}</span>
                  </header>
                  <table className="w-full min-w-[460px] text-xs">
                    <tbody>
                      {t.rows.map((r) => {
                        const c = cadByName.get(r.name);
                        return (
                          <tr key={r.name} className="border-t border-neutral-800 first:border-t-0">
                            <td className="w-6 p-2">
                              {!done && <input type="checkbox" aria-label={`Write ${r.name}`} checked={pickable(r) && picked.has(r.name)}
                                disabled={!pickable(r) || busy != null} onChange={() => toggle(r.name)} className="accent-amber-500" />}
                            </td>
                            <td className="p-2"><span className="font-mono text-neutral-100">#{r.name}</span><span className="block text-[10px] text-neutral-500">{r.label}</span></td>
                            <td className="p-2 font-mono text-neutral-300">{r.current_expression ?? '—'}</td>
                            <td className="p-2 font-mono text-neutral-100">{r.new_expression}</td>
                            {cad?.configured && (
                              <td className={`p-2 font-mono ${c == null ? 'text-neutral-500' : c.ok ? 'text-emerald-400' : 'text-amber-300'}`}>
                                {c == null ? '—' : c.onshape == null ? 'not used' : `${c.onshape.toFixed(4)} ${c.ok ? '✓' : '✗'}`}
                              </td>
                            )}
                            <td className={`p-2 ${STATUS[r.status][1]}`} title={r.detail || undefined}>
                              {STATUS[r.status][0]}{r.status === 'error' && r.detail ? `: ${r.detail}` : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy != null} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-bold text-neutral-300">
                {done ? 'Close' : 'Cancel'}
              </Button>
              {!done && (
                <Button variant="ghost" type="button" onClick={write} disabled={busy != null || n === 0 || blocked}
                  title={unskinnable ? 'A member cannot be skinned in Onshape' : blocked ? 'Load the CAD values first' : undefined}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-500 px-3 py-1.5 text-xs font-bold text-neutral-900 disabled:opacity-40">
                  <UploadCloud className="w-3.5 h-3.5" />
                  {busy === 'write' ? 'Writing…' : blocked ? 'Export not valid' : n === 0 ? 'Nothing to write' : `Write ${n} variable${n > 1 ? 's' : ''}`}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
