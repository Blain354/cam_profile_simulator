/**
 * STL Export modal — drives the backend `/api/export/stl-stream` NDJSON
 * pipeline and surfaces every Onshape stage (auth, variables, translation
 * polling, byte download) as granular progress events so the user can see
 * exactly what's happening while the CAD round-trip runs.
 *
 * When the backend finishes, we try the File System Access API
 * (`window.showSaveFilePicker`) to open the native file explorer save
 * dialog so the user can pick where to drop the STL. Browsers without
 * that API fall back to a regular `<a download>` link.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Box, X, Loader2, CheckCircle2, AlertTriangle, FolderDown, Play, StopCircle } from 'lucide-react';
import type { SimulationParams } from './components';
import { apiUrl } from './components';

type ExportPhase = 'idle' | 'running' | 'success' | 'error' | 'saving' | 'cancelled';

interface ProgressEvent {
  type: 'progress';
  percent: number;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

interface ResultEvent {
  type: 'result';
  percent: 100;
  message: string;
  job_id: string;
  download_url: string;
  filename: string;
  size_bytes: number;
  translation_id: string | null;
  pushed_variables: number;
}

interface ErrorEvent {
  type: 'error';
  code: string;
  status?: number;
  message: string;
  payload?: unknown;
}

type StreamEvent = ProgressEvent | ResultEvent | ErrorEvent;

interface LogLine {
  id: number;
  percent: number;
  message: string;
  detailsText: string;
  timestamp: number;
  tone: 'info' | 'success' | 'error';
}

interface ExportStatus {
  ready: boolean;
  has_keys: boolean;
  has_target: boolean;
  target: null | {
    document_id: string;
    workspace_id: string;
    element_id: string;
    part_id: string | null;
    variable_element_id: string | null;
    variable_mapping: Record<string, string>;
  };
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  params: SimulationParams;
  configName: string;
}

type FileSystemAccessGlobal = typeof window & {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cam-profile';

export default function StlExportModal({ isOpen, onClose, params, configName }: Props) {
  const [phase, setPhase] = useState<ExportPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [currentMessage, setCurrentMessage] = useState<string>('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ResultEvent | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [downloadedAt, setDownloadedAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const suggestedFilename = useMemo(() => {
    const base = slugify(configName || 'cam-profile');
    const h = Number.isFinite(params.height) ? params.height : 0;
    const k = Number.isFinite(params.K) ? params.K : 0;
    const db = Number.isFinite(params.deadband) ? params.deadband : 0;
    const stamp = `h${h}-k${k}-db${db}`.replace(/\./g, 'p');
    return `${base}-${stamp}.stl`;
  }, [configName, params.height, params.K, params.deadband]);

  const appendLog = useCallback((line: Omit<LogLine, 'id'>) => {
    setLog((prev) => {
      const next = [...prev, { ...line, id: ++logIdRef.current }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log]);

  // ── Fetch backend export status whenever the modal opens ────────────────
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch(apiUrl('/api/export/stl-config'), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data: ExportStatus) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus({ ready: false, has_keys: false, has_target: false, target: null });
          appendLog({ percent: 0, message: `Could not reach backend: ${err.message}`, detailsText: '', timestamp: Date.now() / 1000, tone: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, appendLog]);

  const resetState = useCallback(() => {
    setPhase('idle');
    setPercent(0);
    setCurrentMessage('');
    setLog([]);
    setErrorMessage(null);
    setResult(null);
    setDownloadedAt(null);
  }, []);

  const handleClose = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    onClose();
    // Defer state reset so the modal animates out cleanly.
    setTimeout(resetState, 250);
  }, [onClose, resetState]);

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPhase('cancelled');
    appendLog({ percent, message: 'Export cancelled by user.', detailsText: '', timestamp: Date.now() / 1000, tone: 'error' });
  }, [appendLog, percent]);

  const triggerBrowserDownload = useCallback(async (res: ResultEvent) => {
    // First, materialise the STL blob from the one-shot download endpoint.
    const blobResp = await fetch(apiUrl(res.download_url), { credentials: 'include' });
    if (!blobResp.ok) throw new Error(`Download failed (${blobResp.status})`);
    const blob = await blobResp.blob();

    const w = window as FileSystemAccessGlobal;
    if (typeof w.showSaveFilePicker === 'function') {
      // Native file picker → user chooses destination in File Explorer.
      const handle = await w.showSaveFilePicker({
        suggestedName: res.filename || suggestedFilename,
        types: [{ description: 'STL mesh', accept: { 'model/stl': ['.stl'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      // Fallback: classic anchor download (browser uses its default folder
      // or prompts depending on user settings).
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename || suggestedFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  }, [suggestedFilename]);

  const consumeStream = useCallback(async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: ResultEvent | null = null;
    let finalError: ErrorEvent | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!raw) continue;
        try {
          const ev = JSON.parse(raw) as StreamEvent;
          if (ev.type === 'progress') {
            setPercent(ev.percent);
            setCurrentMessage(ev.message);
            const detailsText = ev.details && Object.keys(ev.details).length > 0 ? JSON.stringify(ev.details) : '';
            appendLog({ percent: ev.percent, message: ev.message, detailsText, timestamp: ev.timestamp, tone: 'info' });
          } else if (ev.type === 'result') {
            finalResult = ev;
            setPercent(100);
            setCurrentMessage(ev.message);
            appendLog({
              percent: 100,
              message: ev.message,
              detailsText: `translation_id=${ev.translation_id ?? '—'}, size=${ev.size_bytes} bytes`,
              timestamp: Date.now() / 1000,
              tone: 'success',
            });
          } else if (ev.type === 'error') {
            finalError = ev;
            appendLog({
              percent: 0,
              message: ev.message,
              detailsText: ev.code + (ev.status ? ` (HTTP ${ev.status})` : ''),
              timestamp: Date.now() / 1000,
              tone: 'error',
            });
          }
        } catch (err) {
          appendLog({ percent: 0, message: `Malformed progress line: ${(err as Error).message}`, detailsText: raw.slice(0, 200), timestamp: Date.now() / 1000, tone: 'error' });
        }
      }
    }
    if (finalError) throw new Error(finalError.message);
    return finalResult;
  }, [appendLog]);

  const handleStart = useCallback(async () => {
    resetState();
    setPhase('running');
    setCurrentMessage('Opening export pipeline…');
    appendLog({ percent: 0, message: 'Starting Onshape export pipeline', detailsText: '', timestamp: Date.now() / 1000, tone: 'info' });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const payload = { ...params, filename: suggestedFilename };
      const resp = await fetch(apiUrl('/api/export/stl-stream'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Backend rejected the export request (HTTP ${resp.status}).`);
      }
      const final = await consumeStream(resp.body);
      if (!final) throw new Error('Stream ended without producing a result.');
      setResult(final);
      setPhase('saving');
      setCurrentMessage('Waiting for save destination…');
      appendLog({ percent: 100, message: 'Prompting for save destination', detailsText: final.filename, timestamp: Date.now() / 1000, tone: 'info' });
      try {
        await triggerBrowserDownload(final);
        setPhase('success');
        setDownloadedAt(Date.now());
        setCurrentMessage('STL saved to disk.');
        appendLog({ percent: 100, message: 'STL saved to disk.', detailsText: final.filename, timestamp: Date.now() / 1000, tone: 'success' });
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (message.toLowerCase().includes('abort')) {
          setPhase('cancelled');
          appendLog({ percent: 100, message: 'Save cancelled by user — STL still available below.', detailsText: '', timestamp: Date.now() / 1000, tone: 'error' });
        } else {
          setPhase('error');
          setErrorMessage(message);
          appendLog({ percent: 100, message: `Save failed: ${message}`, detailsText: '', timestamp: Date.now() / 1000, tone: 'error' });
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase('cancelled');
      } else {
        setPhase('error');
        setErrorMessage((err as Error).message || String(err));
      }
    } finally {
      abortRef.current = null;
    }
  }, [params, suggestedFilename, resetState, appendLog, consumeStream, triggerBrowserDownload]);

  if (!isOpen) return null;

  const summary: { label: string; value: string }[] = [
    { label: 'Height', value: `${params.height} mm` },
    { label: 'Thickness', value: `${params.thickness} mm` },
    { label: 'K', value: `${params.K}` },
    { label: 'Deadband', value: `${params.deadband} mm` },
    { label: 'Default distance', value: `${params.default_distance} mm` },
    { label: 'Bushing Ø', value: `${params.bushing_diameter} mm` },
    { label: 'Tube ID/OD', value: `${params.tube_id} / ${params.tube_od} mm` },
  ];

  const busy = phase === 'running' || phase === 'saving';
  const ready = status?.ready ?? false;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={busy ? undefined : handleClose}
      >
        <motion.div
          className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]"
          initial={{ scale: 0.95, y: 10, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.95, y: 10, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-700/80">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600/15 text-emerald-400 border border-emerald-700/50">
                <Box className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-white truncate">Export STL via Onshape</h2>
                <p className="text-xs text-neutral-400 truncate">Pushes the current cam configuration to Onshape, runs a translation, then downloads the resulting STL.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-40"
              aria-label="Close STL export"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-5 py-4 space-y-4 overflow-y-auto">
            {/* Configuration summary */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-3">
              <header className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] uppercase tracking-wider font-semibold text-neutral-400">Configuration to export</h3>
                <span className="text-[11px] font-mono text-emerald-400 truncate max-w-[12rem]" title={configName}>{configName}</span>
              </header>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
                {summary.map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-neutral-500 truncate">{s.label}</span>
                    <span className="text-neutral-100 font-mono tabular-nums truncate">{s.value}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-neutral-500">
                Destination filename: <span className="font-mono text-neutral-300">{suggestedFilename}</span>
              </p>
            </section>

            {/* Onshape backend status */}
            {status && !ready && (
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">Onshape pipeline not fully configured.</p>
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {!status.has_keys && <li>Missing <code>ONSHAPE_ACCESS_KEY</code> / <code>ONSHAPE_SECRET_KEY</code>.</li>}
                    {!status.has_target && <li>Missing <code>ONSHAPE_DOCUMENT_ID</code> / <code>ONSHAPE_WORKSPACE_ID</code> / <code>ONSHAPE_ELEMENT_ID</code>.</li>}
                  </ul>
                  <p className="mt-1 opacity-80">See <code>docs/onshape-export.md</code> for the full setup.</p>
                </div>
              </div>
            )}

            {/* Progress bar */}
            {(phase !== 'idle' || percent > 0) && (
              <section className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {phase === 'running' || phase === 'saving' ? (
                      <Loader2 className="h-3.5 w-3.5 text-emerald-400 animate-spin shrink-0" />
                    ) : phase === 'success' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : phase === 'error' ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                    ) : phase === 'cancelled' ? (
                      <StopCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    ) : null}
                    <span className="truncate text-neutral-200">{currentMessage || '—'}</span>
                  </div>
                  <span className="font-mono tabular-nums text-neutral-400 shrink-0">{percent}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden">
                  <motion.div
                    className={`h-full ${phase === 'error' ? 'bg-red-500' : phase === 'cancelled' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${percent}%` }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  />
                </div>
              </section>
            )}

            {/* Granular log */}
            {log.length > 0 && (
              <section className="rounded-xl border border-neutral-800 bg-black/40">
                <header className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-neutral-500 border-b border-neutral-800">
                  Pipeline log ({log.length})
                </header>
                <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-1 text-[11px] font-mono">
                  {log.map((line) => (
                    <div
                      key={line.id}
                      className={`flex items-start gap-2 ${line.tone === 'error' ? 'text-red-300' : line.tone === 'success' ? 'text-emerald-300' : 'text-neutral-300'}`}
                    >
                      <span className="text-neutral-600 shrink-0 w-10 tabular-nums">{String(line.percent).padStart(3, ' ')}%</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{line.message}</p>
                        {line.detailsText && (
                          <p className="truncate text-[10px] text-neutral-500">{line.detailsText}</p>
                        )}
                      </div>
                      <span className="text-neutral-600 shrink-0">
                        {new Date(line.timestamp * 1000).toLocaleTimeString([], { hour12: false })}
                      </span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </section>
            )}

            {/* Errors */}
            {phase === 'error' && errorMessage && (
              <div className="rounded-lg border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                <p className="font-semibold mb-0.5">Export failed</p>
                <p className="font-mono break-words">{errorMessage}</p>
              </div>
            )}

            {/* Re-download (job still cached for ~10 min) */}
            {result && phase !== 'running' && (
              <div className="rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-100 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold truncate">
                    {downloadedAt ? 'STL saved.' : 'STL ready.'} <span className="font-mono opacity-80">{result.filename}</span>
                  </p>
                  <p className="text-emerald-300/80 text-[11px]">
                    {(result.size_bytes / 1024).toFixed(1)} KB · {result.pushed_variables} variable(s) pushed
                    {result.translation_id ? ` · translation ${result.translation_id.slice(0, 8)}…` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => triggerBrowserDownload(result).catch((err) => setErrorMessage((err as Error).message))}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/60 bg-emerald-600/20 px-2.5 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-600/30"
                >
                  <FolderDown className="h-3.5 w-3.5" /> Save again
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-700/80 bg-neutral-950/40 rounded-b-2xl">
            {phase === 'running' || phase === 'saving' ? (
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex items-center gap-2 rounded-lg border border-red-700/60 bg-red-600/20 hover:bg-red-600/30 text-red-200 px-3 py-1.5 text-xs font-semibold"
              >
                <StopCircle className="h-3.5 w-3.5" /> Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-3 py-1.5 text-xs font-semibold"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={busy || (status !== null && !ready)}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 text-xs font-semibold shadow-lg shadow-emerald-600/30"
              title={ready ? 'Start the Onshape STL export pipeline' : 'Configure Onshape credentials first'}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {phase === 'success' || phase === 'error' || phase === 'cancelled' ? 'Run again' : 'Start export'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
