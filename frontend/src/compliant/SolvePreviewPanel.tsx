import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { CARRIAGE_SPEED_MM_S, triangleWaveY } from './types';
import type { PreviewFrame, SolveJobState } from './types';
import {
  SHORT_REASON_LABELS,
  buildSolveGif,
  computeViewportBounds,
  curateGifTimeline,
  drawFinaleFrame,
  drawSchematicFrame,
} from './solvePreviewRenderer';

const LIVE_DWELL_MS = {
  rejected: 95,
  valid: 440,
  best: 880,
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'experiment';
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function SolvePreviewPanel({ job }: { job: SolveJobState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const running = job.status === 'running';
  const summary = job.summary;
  const hasFinale = Boolean(job.result?.lines?.l && job.result?.lines?.r && job.result?.lines?.f);
  const timeline = useMemo(
    () => summary?.preview_timeline ?? summary?.preview_frames ?? [],
    [summary?.preview_timeline, summary?.preview_frames],
  );
  const curatedReplay = useMemo(() => curateGifTimeline(timeline), [timeline]);
  const bounds = useMemo(
    () => computeViewportBounds(timeline, job.result, job.params),
    [timeline, job.result, job.params],
  );

  // Live queue state (during running)
  const queueRef = useRef<PreviewFrame[]>([]);
  const lastEnqueuedNRef = useRef(0);
  const [liveFrame, setLiveFrame] = useState<PreviewFrame | null>(null);
  const [liveBest, setLiveBest] = useState<PreviewFrame | null>(null);

  // Post-solve playback state (replay evolution -> kinematic finale)
  const [stage, setStage] = useState<'replay' | 'finale'>(hasFinale ? 'finale' : 'replay');
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [replayIdx, setReplayIdx] = useState(0);
  const [finaleY, setFinaleY] = useState(0);

  // GIF export state
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  // Reset internal buffers when switching to a different experiment / job
  useEffect(() => {
    queueRef.current = [];
    lastEnqueuedNRef.current = 0;
    setLiveFrame(null);
    setLiveBest(null);
    setExportError(null);
    setExporting(false);
    setExportPct(0);
    setReplayIdx(0);
    setFinaleY(0);
    setStage(hasFinale ? 'finale' : 'replay');
    setPlaying(!prefersReducedMotion());
  }, [job.experiment_id, hasFinale]);

  // Enqueue new frames streamed from the backend while running
  useEffect(() => {
    if (!running) return;
    const incoming = summary?.preview_frames ?? [];
    if (incoming.length === 0) return;

    const fresh = incoming.filter((f) => f.n > lastEnqueuedNRef.current);
    if (fresh.length === 0) return;
    lastEnqueuedNRef.current = fresh[fresh.length - 1].n;

    const q = queueRef.current;
    for (const f of fresh) q.push(f);

    // Backpressure: trim excess rejected frames while preserving all valid & best frames
    if (q.length > 16) {
      const trimmed: PreviewFrame[] = [];
      let rejSkip = 0;
      for (const item of q) {
        if (item.ok || item.best) {
          trimmed.push(item);
        } else {
          rejSkip++;
          if (rejSkip % 2 === 0) trimmed.push(item);
        }
      }
      queueRef.current = trimmed.slice(-16);
    }

    if (summary?.best_preview) {
      setLiveBest(summary.best_preview);
    }
  }, [running, summary?.preview_frames, summary?.best_preview]);

  // Adaptive-delay playback loop while running
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const reduced = prefersReducedMotion();

    const pump = () => {
      if (cancelled) return;
      const next = queueRef.current.shift();
      if (next) {
        setLiveFrame(next);
        if (next.best) setLiveBest(next);
        const dwell = next.best
          ? LIVE_DWELL_MS.best
          : next.ok
            ? LIVE_DWELL_MS.valid
            : reduced
              ? 420
              : LIVE_DWELL_MS.rejected;
        timer = setTimeout(pump, dwell);
      } else {
        timer = setTimeout(pump, 100);
      }
    };
    pump();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, job.experiment_id]);

  // Transition automatically to best-design finale once run finishes
  const prevRunningRef = useRef(running);
  useEffect(() => {
    if (prevRunningRef.current && !running) {
      if (hasFinale) {
        setStage('finale');
        setFinaleY(0);
      } else {
        setStage('replay');
        setReplayIdx(Math.max(0, curatedReplay.length - 1));
      }
    }
    prevRunningRef.current = running;
  }, [running, hasFinale, curatedReplay.length]);

  // Post-solve Replay loop (Evolution -> transitions cleanly into Finale)
  useEffect(() => {
    if (running || !playing || stage !== 'replay' || curatedReplay.length === 0) return;
    const item = curatedReplay[Math.min(replayIdx, curatedReplay.length - 1)];
    const timer = setTimeout(() => {
      if (replayIdx + 1 < curatedReplay.length) {
        setReplayIdx(replayIdx + 1);
      } else if (hasFinale) {
        setFinaleY(0);
        setStage('finale');
      } else {
        setReplayIdx(0);
      }
    }, item.delayMs);
    return () => clearTimeout(timer);
  }, [running, playing, stage, replayIdx, curatedReplay, hasFinale]);

  // Post-solve Finale oscillation loop (real constant carriage speed, FEM deflected stroke)
  useEffect(() => {
    if (running || !playing || stage !== 'finale' || !hasFinale) return;
    const stroke = job.params?.stroke ?? summary?.active_constraints?.stroke_mm ?? 1.5;
    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const dist = ((now - start) / 1000) * CARRIAGE_SPEED_MM_S;
      setFinaleY(triangleWaveY(dist, stroke));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, playing, stage, hasFinale, job.params?.stroke, summary?.active_constraints?.stroke_mm]);

  // Current frame & ghost for display
  const activeReplayItem = curatedReplay[Math.min(replayIdx, Math.max(0, curatedReplay.length - 1))] ?? null;
  const shownFrame: PreviewFrame | null = running
    ? (liveFrame ?? summary?.preview_frames?.[summary.preview_frames.length - 1] ?? null)
    : stage === 'replay'
      ? (activeReplayItem?.frame ?? null)
      : (summary?.best_preview ?? null);

  const replayGhostBest = useMemo(() => {
    if (running || stage !== 'replay') return null;
    let best: PreviewFrame | null = null;
    for (let i = 0; i < replayIdx && i < curatedReplay.length; i++) {
      if (curatedReplay[i].frame.best) best = curatedReplay[i].frame;
    }
    return best;
  }, [running, stage, replayIdx, curatedReplay]);

  // Draw onto HiDPI canvas whenever displayed frame or pose updates
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const cssW = 420;
    const cssH = 252;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rect = { x: 0, y: 0, w: cssW, h: cssH };

    if (!running && stage === 'finale' && hasFinale && job.result) {
      drawFinaleFrame(ctx, rect, job.result, job.params ?? {}, finaleY, bounds, { blurPx: 2.5 * dpr });
      return;
    }

    if (shownFrame) {
      const ghost = running ? (liveBest ?? summary?.best_preview ?? null) : replayGhostBest;
      const progressFrac = running
        ? (summary?.progress ?? 0)
        : curatedReplay.length > 0
          ? (replayIdx + 1) / curatedReplay.length
          : 1;
      drawSchematicFrame(ctx, rect, shownFrame, ghost, bounds, {
        showCornerEmphasis: shownFrame.best,
        progressFrac,
        blurPx: 2.5 * dpr,
      });
      return;
    }

    // Waiting placeholder
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#71717a';
    ctx.textAlign = 'center';
    ctx.fillText(
      running ? 'Sampling first configurations…' : 'No preview frames recorded for this experiment.',
      cssW / 2,
      cssH / 2 + 4,
    );
  }, [
    running,
    stage,
    hasFinale,
    job.result,
    job.params,
    finaleY,
    shownFrame,
    liveBest,
    summary?.best_preview,
    summary?.progress,
    replayGhostBest,
    replayIdx,
    curatedReplay.length,
    bounds,
  ]);

  const handleReplay = useCallback(() => {
    if (curatedReplay.length > 0) {
      setReplayIdx(0);
      setStage('replay');
      setPlaying(true);
    } else if (hasFinale) {
      setFinaleY(0);
      setStage('finale');
      setPlaying(true);
    }
  }, [curatedReplay.length, hasFinale]);

  const handleDownloadGif = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportPct(2);
    setExportError(null);
    try {
      const blob = await buildSolveGif(job, (pct) => setExportPct(pct));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `compliant-solve-${slugify(job.name)}.gif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not encode GIF.');
    } finally {
      setExporting(false);
    }
  }, [exporting, job]);

  const canExportGif = !running && (curatedReplay.length > 0 || hasFinale);
  const showingFinale = !running && stage === 'finale' && hasFinale;

  // Compact status badge text & color
  let statusDot = 'bg-neutral-500';
  let statusText = 'Waiting…';
  let statusTone = 'text-neutral-400';
  if (showingFinale) {
    statusDot = 'bg-amber-400';
    statusText = 'Best design · actuation';
    statusTone = 'text-amber-300';
  } else if (shownFrame) {
    if (shownFrame.best) {
      statusDot = 'bg-amber-400';
      statusText = `New best · #${shownFrame.n}`;
      statusTone = 'text-amber-300';
    } else if (shownFrame.ok) {
      statusDot = 'bg-emerald-400';
      statusText = `Valid · #${shownFrame.n}`;
      statusTone = 'text-emerald-300';
    } else {
      const reason = SHORT_REASON_LABELS[shownFrame.reason ?? ''] ?? shownFrame.reason ?? 'Invalid';
      statusDot = 'bg-rose-400/80';
      statusText = `Rejected (${reason}) · #${shownFrame.n}`;
      statusTone = 'text-neutral-300';
    }
  }

  const displayDx = showingFinale ? job.result?.dx_at_025_mm : shownFrame?.dx;
  const displayStress = showingFinale ? job.result?.max_stress_mpa : shownFrame?.stress;
  const displayExtra = showingFinale
    ? (job.result?.attack_angle_deg != null
      ? `${job.result.attack_angle_deg > 0 ? '+' : ''}${job.result.attack_angle_deg.toFixed(1)}°`
      : '—')
    : (shownFrame?.score != null ? shownFrame.score.toFixed(3) : '—');

  return (
    <div
      className="rounded-xl border border-neutral-800 bg-neutral-900/70 overflow-hidden"
      data-testid="solve-preview-panel"
    >
      <div className="grid grid-cols-1 md:grid-cols-12">
        {/* Left: Simplified mechanism canvas */}
        <div className="md:col-span-7 bg-[#0d0e11] flex items-center justify-center border-b md:border-b-0 md:border-r border-neutral-800">
          <canvas
            ref={canvasRef}
            className="w-full h-auto block aspect-[5/3] max-h-[260px]"
            aria-label="Simplified preview of tested compliant bar configurations"
          />
        </div>

        {/* Right: Minimalist status, metrics & GIF export */}
        <div className="md:col-span-5 p-4 flex flex-col justify-between gap-3 bg-neutral-900/50">
          <div className="space-y-3">
            {/* Header row */}
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-neutral-200">
                Tested configurations
              </h4>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
                <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-amber-400' : showingFinale ? 'bg-emerald-400' : 'bg-neutral-400'}`} />
                {running ? 'Live' : showingFinale ? 'Finale' : `Replay ${replayIdx + 1}/${curatedReplay.length}`}
              </span>
            </div>

            {/* Active frame state */}
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
              <span className={`font-medium truncate ${statusTone}`}>{statusText}</span>
            </div>

            {/* Compact 3-cell readout */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-1.5">
                <div className="text-[10px] text-neutral-500">ΔX @ 0.25</div>
                <div className="text-xs font-mono font-semibold text-neutral-100 mt-0.5">
                  {displayDx != null ? `${displayDx.toFixed(3)}` : '—'}
                  {displayDx != null && <span className="text-[10px] font-normal text-neutral-500"> mm</span>}
                </div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-1.5">
                <div className="text-[10px] text-neutral-500">Stress</div>
                <div className="text-xs font-mono font-semibold text-neutral-100 mt-0.5">
                  {displayStress != null ? `${displayStress.toFixed(0)}` : '—'}
                  {displayStress != null && <span className="text-[10px] font-normal text-neutral-500"> MPa</span>}
                </div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-1.5">
                <div className="text-[10px] text-neutral-500">{showingFinale ? 'Attack α' : 'Score'}</div>
                <div className="text-xs font-mono font-semibold text-neutral-100 mt-0.5">
                  {displayExtra}
                </div>
              </div>
            </div>

            {/* Subtle legend (sentence case, understated) */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-0.5 bg-amber-400 inline-block" /> L
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-0.5 bg-blue-400 inline-block" /> R
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-0.5 bg-emerald-400 inline-block" /> Foot
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-0.5 bg-rose-400/75 inline-block" /> Rejected
              </span>
              {!showingFinale && (
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 border-t border-dashed border-neutral-500 inline-block" /> Best ghost
                </span>
              )}
            </div>
          </div>

          {/* Bottom controls & Download GIF */}
          <div className="pt-2 border-t border-neutral-800/80 space-y-1.5">
            {running ? (
              <p className="text-[11px] text-neutral-500">
                Pacing slows on valid &amp; new best designs. GIF export unlocks when finished.
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {(curatedReplay.length > 0 || hasFinale) && (
                    <button
                      type="button"
                      onClick={() => setPlaying((p) => !p)}
                      className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-200 hover:border-neutral-500 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
                    >
                      {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      {playing ? 'Pause' : 'Play'}
                    </button>
                  )}
                  {curatedReplay.length > 0 && (
                    <button
                      type="button"
                      onClick={handleReplay}
                      className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
                      title="Replay the evolution of tested designs into the best-design finale"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Replay
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  disabled={!canExportGif || exporting}
                  onClick={handleDownloadGif}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
                >
                  {exporting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Encoding… {exportPct}%
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      Download GIF
                    </>
                  )}
                </button>
              </div>
            )}
            {exportError && (
              <p className="text-[11px] text-rose-300" role="alert">
                {exportError}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
