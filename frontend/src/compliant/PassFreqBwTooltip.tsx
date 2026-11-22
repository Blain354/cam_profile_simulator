import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

/**
 * Interactive hover/click tooltip with a two-panel SVG schematic explaining:
 * 1) How "Pass freq / BW (-3 dB)" differs from the static goals (ΔX @ 0.25, Min Y₉₀, dQ/dY).
 * 2) The difference between Pass freq (1 / 2·T₁₀₀) and -3 dB Bandwidth (0.35 / T₁₀₀).
 */
export function PassFreqBwTooltip({
  ariaLabel = 'Explain Pass freq / BW vs other goals',
}: {
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const gap = 10;
    const estW = Math.min(416, window.innerWidth - 24);
    const estH = 340;
    let left = r.right + gap;
    if (left + estW > window.innerWidth - 12) {
      left = Math.max(12, r.left - gap - estW);
    }
    let top = r.top - 24;
    if (top + estH > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - estH - 12);
    }
    if (top < 12) top = 12;
    setPos({ top, left });
  }, []);

  const openNow = useCallback(() => {
    clearCloseTimer();
    updatePosition();
    setOpen(true);
  }, [clearCloseTimer, updatePosition]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 140);
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
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
            updatePosition();
            setPinned(true);
            setOpen(true);
          }
        }}
        className="inline-flex items-center justify-center rounded-full p-0.5 text-neutral-400 hover:text-amber-300 focus:text-amber-300 focus:outline-none transition-colors shrink-0"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            className="fixed z-[100001] w-[min(26rem,calc(100vw-1.5rem))] max-h-[min(80vh,28rem)] overflow-y-auto rounded-xl border border-neutral-600 bg-neutral-900/98 p-3 text-left shadow-2xl space-y-2.5"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-amber-300">
                Pass freq / BW (-3 dB) vs Static Goals
              </p>
              <span className="text-[10px] font-mono text-neutral-400">
                BW = 0.7 · f_pass
              </span>
            </div>

            {/* Two-panel SVG schematic comparing static Q(Y) goals vs dynamic P(t) chamber response */}
            <svg
              viewBox="0 0 380 156"
              className="w-full h-auto rounded-lg border border-neutral-800 bg-neutral-950"
              aria-label="Schematic comparing static Q(Y) goals against dynamic chamber P(t) pass frequency and -3 dB bandwidth"
            >
              {/* Panel divider */}
              <line x1="184" y1="8" x2="184" y2="148" stroke="#262626" strokeWidth="1" strokeDasharray="3 3" />

              {/* ── LEFT PANEL: Static goals Q(Y) ── */}
              <text x="12" y="18" fill="#a3a3a3" fontSize="9.5" fontWeight="600">
                Static goals: Flow Q(Y)
              </text>
              {/* Axes */}
              <line x1="26" y1="120" x2="172" y2="120" stroke="#525252" strokeWidth="1" />
              <line x1="26" y1="28" x2="26" y2="120" stroke="#525252" strokeWidth="1" />
              <text x="166" y="131" fill="#737373" fontSize="8" textAnchor="end">Y (mm)</text>
              <text x="19" y="34" fill="#737373" fontSize="8" textAnchor="end">Q</text>

              {/* 90% Q reference line */}
              <line x1="26" y1="44" x2="168" y2="44" stroke="#8b5cf6" strokeWidth="0.9" strokeDasharray="3 2" opacity="0.7" />
              <text x="30" y="41" fill="#c4b5fd" fontSize="7.5">90% Q</text>

              {/* Y = 0.25 reference line */}
              <line x1="62" y1="30" x2="62" y2="120" stroke="#f59e0b" strokeWidth="0.9" strokeDasharray="3 2" opacity="0.75" />
              <text x="62" y="131" fill="#fbbf24" fontSize="7.5" textAnchor="middle">0.25</text>

              {/* Static Q(Y) curve: deadband then rising ramp then plateau */}
              <path
                d="M 26 120 L 42 120 C 56 120, 62 104, 78 78 C 94 52, 112 42, 134 39 L 168 38"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
              />

              {/* Mean slope tangent line (dQ/dY) */}
              <line x1="56" y1="110" x2="112" y2="44" stroke="#38bdf8" strokeWidth="1.2" strokeDasharray="2 2" opacity="0.85" />
              <text x="95" y="92" fill="#7dd3fc" fontSize="8" fontWeight="600">dQ/dY</text>

              {/* Dot for ΔX @ 0.25 */}
              <circle cx="62" cy="105" r="3" fill="#f59e0b" />
              <text x="66" y="114" fill="#fcd34d" fontSize="7.5" fontWeight="600">ΔX @ 0.25</text>

              {/* Dot for Y_90 */}
              <line x1="115" y1="44" x2="115" y2="120" stroke="#8b5cf6" strokeWidth="0.9" strokeDasharray="2 2" opacity="0.7" />
              <circle cx="115" cy="44" r="3" fill="#a78bfa" />
              <text x="119" y="131" fill="#c4b5fd" fontSize="7.5" fontWeight="600">Y₉₀</text>

              <text x="12" y="146" fill="#737373" fontSize="7.5">
                Looks only at static curve vs Y
              </text>

              {/* ── RIGHT PANEL: Dynamic chamber P(t) ── */}
              <text x="196" y="18" fill="#34d399" fontSize="9.5" fontWeight="600">
                Pass freq / BW: Chamber P(t)
              </text>
              {/* Axes */}
              <line x1="208" y1="120" x2="368" y2="120" stroke="#525252" strokeWidth="1" />
              <line x1="208" y1="28" x2="208" y2="120" stroke="#525252" strokeWidth="1" />
              <text x="366" y="131" fill="#737373" fontSize="8" textAnchor="end">t (ms)</text>
              <text x="203" y="34" fill="#737373" fontSize="8" textAnchor="end">P</text>

              {/* 100% P reference line */}
              <line x1="208" y1="42" x2="364" y2="42" stroke="#525252" strokeWidth="0.8" strokeDasharray="2 2" />
              <text x="211" y="39" fill="#a3a3a3" fontSize="7.2">100%</text>

              {/* Shaded inflation area 0 -> T_100 */}
              <path
                d="M 208 120 L 218 120 C 232 120, 240 62, 282 42 L 282 120 Z"
                fill="#10b981"
                opacity="0.16"
              />

              {/* Inflation curve 0 -> 100% (T_100) */}
              <path
                d="M 208 120 L 218 120 C 232 120, 240 62, 282 42"
                fill="none"
                stroke="#34d399"
                strokeWidth="2.2"
              />
              {/* Symmetric deflation curve 100% -> 0% (2·T_100) */}
              <path
                d="M 282 42 C 304 42, 314 106, 356 120"
                fill="none"
                stroke="#34d399"
                strokeWidth="1.6"
                strokeDasharray="4 2.5"
                opacity="0.8"
              />

              {/* Vertical markers at T_100 and 2·T_100 */}
              <line x1="282" y1="42" x2="282" y2="120" stroke="#34d399" strokeWidth="1" strokeDasharray="2 2" />
              <circle cx="282" cy="42" r="3" fill="#34d399" />
              <text x="282" y="131" fill="#6ee7b7" fontSize="7.8" fontWeight="600" textAnchor="middle">T₁₀₀</text>

              <line x1="356" y1="88" x2="356" y2="120" stroke="#34d399" strokeWidth="0.9" strokeDasharray="2 2" opacity="0.7" />
              <text x="352" y="131" fill="#6ee7b7" fontSize="7.5" textAnchor="middle">2·T₁₀₀</text>

              {/* Full cycle bracket 0 -> 2·T_100 */}
              <path d="M 209 98 L 209 103 L 355 103 L 355 98" fill="none" stroke="#6ee7b7" strokeWidth="1" />
              <rect x="234" y="95" width="96" height="14" rx="3" fill="#0a0a0a" opacity="0.9" />
              <text x="282" y="104.5" fill="#6ee7b7" fontSize="7.6" fontWeight="600" textAnchor="middle">
                f_pass = 1 / (2·T₁₀₀)
              </text>

              {/* -3 dB BW callout pill */}
              <rect x="286" y="48" width="84" height="15" rx="3" fill="#451a03" stroke="#f59e0b" strokeWidth="0.7" />
              <text x="328" y="58" fill="#fcd34d" fontSize="7.4" fontWeight="600" textAnchor="middle">
                BW(-3dB) = 0.35/T₁₀₀
              </text>

              <text x="196" y="146" fill="#737373" fontSize="7.5">
                Full inflate + deflate cycle with volume V
              </text>
            </svg>

            {/* Concise text explanation */}
            <div className="space-y-1.5 text-[11px] leading-snug text-neutral-300">
              <p>
                <span className="font-semibold text-emerald-300">Why this goal is different:</span>{' '}
                <span className="text-amber-300">ΔX @ 0.25</span>,{' '}
                <span className="text-violet-300">Min Y₉₀</span>, and{' '}
                <span className="text-sky-300">dQ/dY</span> only score the static curve vs carriage position{' '}
                <span className="font-mono">Y</span>.{' '}
                <strong className="text-neutral-100">Pass freq / BW</strong> simulates the full dynamic chamber fill
                (motor ramp speed, deadband, orifice flow &amp; chamber volume <span className="font-mono">V</span>)
                to directly minimize <span className="font-mono text-emerald-300">T₁₀₀</span>.
              </p>
              <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1">
                  <div className="text-[10px] font-semibold text-emerald-300">Pass freq (f_pass)</div>
                  <div className="text-[10px] text-neutral-300">
                    <span className="font-mono">1 / (2·T₁₀₀)</span> — full 0→100%→0% pneumatic cycle rate.
                  </div>
                </div>
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1">
                  <div className="text-[10px] font-semibold text-amber-300">BW (-3 dB)</div>
                  <div className="text-[10px] text-neutral-300">
                    <span className="font-mono">0.35 / T₁₀₀</span> — equivalent 1st-order cutoff (maximizes with f_pass).
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
