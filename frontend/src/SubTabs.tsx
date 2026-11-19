import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export type SubTab = 'explorer' | 'finder';

/**
 * A small segmented tab list. Arrow keys, Home and End move the selection, as in the ARIA tabs pattern.
 * Plain buttons with the kit's tab classes: a kit ghost Button would hide the selected state under its own background.
 */
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
    <div role="tablist" aria-label={label} className="bui-tablist flex shrink-0 items-center">
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="tab"
            aria-selected={selected} tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)} onKeyDown={(e) => onKeyDown(e, i)}
            className={`bui-tab px-2.5 py-1 text-xs${selected ? ' bui-tab--active' : ''}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
