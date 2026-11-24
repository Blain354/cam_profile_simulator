import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineChart as LineChartIcon, Loader2, RotateCcw, X } from 'lucide-react';
import { apiFetch } from '../components';
import {
  COMPLIANT_PLOT_TABS, CompliantSingleChart,
} from './CompliantCharts';
import type { CompliantPlotKind } from './CompliantCharts';
import { allowableStressMpa } from './types';
import type {
  CompliantParams, CompliantResult, Runner, SolverConstraints,
} from './types';

/**
 * Interactive hover/click chart preview tooltip for a solver candidate card.
 * Opens on hover over the small chart icon beside "Apply", stays interactive when
 * moving the pointer inside, defaults to "Stress vs carriage Y" (with safe limit,
 * breaking strength, operating stroke, and motor stall markers), and lets the user
 * switch tabs across all Explorer charts.
 */
export function RunnerChartsTooltip({
  runner,
  runnerKey,
  rank,
  baseParams,
  constraints,
  resultCache,
}: {
  runner: Runner;
  runnerKey: string;
  rank: number;
  baseParams: CompliantParams;
  constraints: SolverConstraints;
  resultCache: React.MutableRefObject<Map<string, CompliantResult>>;
}) {
  const params: CompliantParams = useMemo(
    () => ({ ...baseParams, ...runner.params }),
    [baseParams, runner.params],
  );

  const visibleTabs = useMemo(
    () => COMPLIANT_PLOT_TABS.filter((t) => t.kind !== 'chamber' || params.chamber_volume_ml > 0),
    [params.chamber_volume_ml],
  );

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [activeTab, setActiveTab] = useState<CompliantPlotKind>('stress');
  const [simResult, setSimResult] = useState<CompliantResult | null>(() => resultCache.current.get(runnerKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSeqRef = useRef(0);

  // Keep simResult in sync when runnerKey changes (e.g. re-ranking cards).
  useEffect(() => {
    fetchSeqRef.current += 1;
    setLoading(false);
    setError(null);
    setSimResult(resultCache.current.get(runnerKey) ?? null);
  }, [runnerKey, resultCache]);

  // If Chamber tab becomes unavailable, fall back to Stress.
  useEffect(() => {
    if (activeTab === 'chamber' && params.chamber_volume_ml <= 0) {
      setActiveTab('stress');
    }
  }, [activeTab, params.chamber_volume_ml]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const estW = Math.min(640, window.innerWidth - 24);
    const estH = 400;

    // Center horizontally around trigger when possible, clamped within viewport.
    let left = r.right - estW;
    if (left < 12) {
      left = Math.min(window.innerWidth - estW - 12, Math.max(12, r.left));
    }
    if (left + estW > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - estW - 12);
    }

    // Prefer opening below the trigger; flip above if there is more room above.
    let top = r.bottom + gap;
    if (top + estH > window.innerHeight - 12 && r.top - gap - estH >= 12) {
      top = r.top - gap - estH;
    } else if (top + estH > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - estH - 12);
    }
    if (top < 12) top = 12;

    setPos({ top, left });
  }, []);

  const ensureSimulated = useCallback(async (force = false) => {
    if (!force) {
      const cached = resultCache.current.get(runnerKey);
      if (cached) {
        setSimResult(cached);
        setError(null);
        return;
      }
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/compliant/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, constraints }),
      });
      const data = await res.json().catch(() => null);
      if (seq !== fetchSeqRef.current) return;
      if (res.ok && data?.Y_positions) {
        const parsed = data as CompliantResult;
        resultCache.current.set(runnerKey, parsed);
        setSimResult(parsed);
      } else {
        setError(data?.detail || data?.message || 'Could not simulate this solution.');
      }
    } catch {
      if (seq !== fetchSeqRef.current) return;
      setError('Network error while loading charts.');
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [constraints, params, resultCache, runnerKey]);

  const openNow = useCallback(() => {
    clearCloseTimer();
    updatePosition();
    setOpen(true);
    void ensureSimulated(false);
  }, [clearCloseTimer, ensureSimulated, updatePosition]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 240);
  }, [clearCloseTimer, pinned]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setPinned(false);
        setOpen(false);
      }
    };
    const onResize = () => updatePosition();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updatePosition]);

  const activeMeta = visibleTabs.find((t) => t.kind === activeTab) ?? visibleTabs[0];
  const motorLimited = constraints.motor_limited_stress ?? true;
  const stallY = motorLimited
    ? (simResult?.stall_y_mm ?? runner.stall_y_mm ?? null)
    : null;
  const allowableMpa = allowableStressMpa(params.member_strength_mpa, constraints);
  const hasSafetyFactor = (constraints.stress_limit_factor ?? 1) < 0.999;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Inspect charts for solution #${rank}`}
        aria-expanded={open}
        title="Hover to preview stress & Explorer charts (click to pin)"
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={scheduleClose}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (pinned && open) {
            setPinned(false);
            setOpen(false);
          } else {
            clearCloseTimer();
            updatePosition();
            setPinned(true);
            setOpen(true);
            void ensureSimulated(false);
          }
        }}
        className={`shrink-0 inline-flex items-center justify-center rounded-lg border p-1.5 transition ${
          open
            ? 'border-amber-400/70 bg-amber-500/20 text-amber-200'
            : 'border-neutral-700 bg-neutral-800/80 text-neutral-300 hover:border-amber-500/60 hover:bg-amber-500/15 hover:text-amber-200'
        }`}
      >
        <LineChartIcon className="w-3.5 h-3.5" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            data-testid={`runner-charts-tooltip-${rank}`}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            className="fixed z-[100001] w-[min(40rem,calc(100vw-1.5rem))] rounded-xl border border-neutral-600 bg-neutral-900/98 p-3 text-left text-neutral-100 shadow-2xl space-y-2.5"
            style={{ top: pos.top, left: pos.left }}
          >
            {/* Header + tab menu */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 rounded bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                  #{rank}
                </span>
                <span className="text-xs font-bold text-neutral-100 truncate">
                  {activeMeta.title(params, simResult)}
                </span>
              </div>
              <button
                type="button"
                aria-label="Close chart preview"
                onClick={() => {
                  setPinned(false);
                  setOpen(false);
                }}
                className="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Chart tabs */}
            <div
              role="tablist"
              aria-label="Solution chart views"
              className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950/80 p-1"
            >
              {visibleTabs.map((tab) => {
                const selected = tab.kind === activeTab;
                return (
                  <button
                    key={tab.kind}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActiveTab(tab.kind)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                      selected
                        ? 'bg-amber-500/20 text-amber-200 border border-amber-500/50'
                        : 'text-neutral-400 border border-transparent hover:bg-neutral-800/80 hover:text-neutral-200'
                    }`}
                  >
                    {tab.shortLabel}
                  </button>
                );
              })}
            </div>

            {/* Reference strip: stroke, stall vs stroke, safe & physical stress limits */}
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                Stroke ±{params.stroke.toFixed(2)} mm
              </span>
              {stallY != null && Number.isFinite(stallY) && (
                <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-violet-300">
                  Stall ±{stallY.toFixed(2)} mm ({stallY < params.stroke - 1e-4 ? 'before stroke' : 'after stroke'})
                </span>
              )}
              {hasSafetyFactor ? (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                  Safe {allowableMpa.toFixed(1)} MPa · Break {params.member_strength_mpa.toFixed(0)} MPa
                </span>
              ) : (
                <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">
                  Strength {params.member_strength_mpa.toFixed(0)} MPa
                </span>
              )}
            </div>

            {/* Interactive chart body */}
            <div className="h-[270px] w-full rounded-lg border border-neutral-800 bg-neutral-950/90 p-2">
              {loading && !simResult ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-neutral-400">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                  <span>Simulating full curves…</span>
                </div>
              ) : error && !simResult ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-red-300">
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => void ensureSimulated(true)}
                    className="inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-200 hover:border-amber-500/60 hover:text-amber-200"
                  >
                    <RotateCcw className="w-3 h-3" /> Retry
                  </button>
                </div>
              ) : (
                <CompliantSingleChart
                  kind={activeTab}
                  params={params}
                  result={simResult}
                  constraints={constraints}
                  minHeight={250}
                />
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
