import { Button } from '@blain-projects/ui';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Cog, Maximize2, Minimize2 } from 'lucide-react';
import { ChartDomainSettingsModal } from './components';
import type { ChartDomainSettings } from './components';

export interface ChartCardView {
  maximized: boolean;
  settings: ChartDomainSettings;
}

/**
 * A chart card: title, axis-domain settings behind the cog (amber when `modified`),
 * and a maximize button that shows the same chart in a full-viewport overlay.
 * `children` is called once for the card and once more for the overlay while it is open.
 */
export function ChartCard({
  title,
  maximizedTitle = title,
  settingsTitle = `${title} domain settings`,
  settings,
  onSettingsChange,
  modified = false,
  compact = false,
  layout = false,
  className = '',
  bodyClassName = '',
  maximizeLabel = 'Expand chart',
  children,
}: {
  title: string;
  maximizedTitle?: string;
  settingsTitle?: string;
  settings: ChartDomainSettings;
  onSettingsChange: (next: ChartDomainSettings) => void;
  modified?: boolean;
  /** Smaller title and buttons, for the cards of a secondary row. */
  compact?: boolean;
  /** Animate size changes of the card frame (framer-motion `layout`). */
  layout?: boolean;
  className?: string;
  bodyClassName?: string;
  maximizeLabel?: string;
  children: (view: ChartCardView) => ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!maximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // A layer that already handled this Esc (a UI-kit modal or popover) keeps it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setMaximized(false); };
    window.addEventListener('keydown', onKey);
    minimizeRef.current?.focus({ preventScroll: true });
    const opener = maximizeRef.current;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus({ preventScroll: true });
    };
  }, [maximized]);

  const btn = compact ? 'p-1' : 'p-1.5';
  const icon = compact ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const titleClass = compact ? 'text-xs font-bold text-neutral-400 lg:text-neutral-200' : 'text-sm font-bold text-neutral-200';

  return (
    <motion.div layout={layout} className={`flex min-h-0 flex-col items-stretch rounded-xl border border-neutral-700 bg-neutral-800 p-3 ${className}`}>
      {/* Side columns share the leftover width on sm+, keeping the title centred; on narrow phones left-align so long titles use the full row. */}
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr]">
        <span className="hidden sm:block" />
        <h3 className={`min-w-0 text-left sm:text-center ${titleClass}`}>{title}</h3>
        <div className="flex shrink-0 justify-end gap-1">
          <Button variant="ghost" type="button" onClick={() => setSettingsOpen(true)}
            className={`rounded-md ${btn} transition-colors hover:bg-neutral-700 ${modified ? 'text-amber-400 hover:text-amber-300' : 'text-neutral-400 hover:text-white'}`}
            title={modified ? 'Chart settings (changed)' : 'Chart settings'}>
            <Cog className={icon} />
          </Button>
          <Button ref={maximizeRef} variant="ghost" type="button" onClick={() => setMaximized(true)}
            className={`rounded-md ${btn} text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white`}
            title={maximizeLabel} aria-label={maximizeLabel}>
            <Maximize2 className={icon} />
          </Button>
        </div>
      </div>
      <div className={`min-h-0 w-full flex-1 ${bodyClassName}`}>{children({ maximized: false, settings })}</div>

      {createPortal(
        <AnimatePresence>
          {maximized && (
            <motion.div key="chart-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMaximized(false)}
              className="fixed inset-0 z-[120] flex items-center justify-center bg-neutral-950/70 p-2 text-neutral-100 sm:p-6">
              <motion.div role="dialog" aria-modal="true" aria-label={maximizedTitle}
                initial={{ scale: 0.97 }} animate={{ scale: 1 }} exit={{ scale: 0.97 }}
                onClick={(e) => e.stopPropagation()}
                className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-neutral-600 bg-neutral-800 shadow-2xl">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-700/50 bg-neutral-800/80 px-4 py-3 sm:p-6 sm:pb-2">
                  <h3 className="min-w-0 text-base sm:text-xl font-bold text-neutral-100">{maximizedTitle}</h3>
                  <Button ref={minimizeRef} variant="ghost" type="button" onClick={() => setMaximized(false)}
                    className="shrink-0 rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white"
                    title="Exit fullscreen" aria-label="Exit fullscreen">
                    <Minimize2 className="h-5 w-5 sm:h-6 sm:w-6" />
                  </Button>
                </div>
                <div className={`min-h-0 w-full flex-1 overflow-hidden p-3 sm:p-6 ${bodyClassName}`}>{children({ maximized: true, settings })}</div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      <ChartDomainSettingsModal
        isOpen={settingsOpen}
        title={settingsTitle}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onChange={onSettingsChange}
      />
    </motion.div>
  );
}
