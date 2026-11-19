import { Button } from '@blain-projects/ui';
import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export type SubTab = 'explorer' | 'finder';

/** A small segmented tab list. Arrow keys, Home and End move the selection, as in the ARIA tabs pattern. */
export function SubTabs<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : null;
    if (next == null) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 items-center gap-0.5 rounded-lg border border-neutral-700/60 bg-neutral-900/50 p-0.5">
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <Button variant="ghost" key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="tab"
            aria-selected={selected} tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)} onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${selected ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-400 hover:text-neutral-100'}`}>
            {o.label}
          </Button>
        );
      })}
    </div>
  );
}
