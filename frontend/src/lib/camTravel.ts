import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimulationResult } from '../components';

/** Linear interpolation of `vals` at `y` on the increasing grid `ys`, clamped to its ends. */
export function interpAt(y: number, ys: number[], vals: number[]): number {
  const n = Math.min(ys.length, vals.length);
  if (n === 0) return 0;
  if (y <= ys[0]) return vals[0];
  if (y >= ys[n - 1]) return vals[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] <= y) lo = mid; else hi = mid;
  }
  const span = ys[hi] - ys[lo];
  return span > 0 ? vals[lo] + (vals[hi] - vals[lo]) * (y - ys[lo]) / span : vals[lo];
}

export interface CamTravel {
  y: number;
  setY: (y: number) => void;
  playing: boolean;
  toggle: () => void;
  /** Callback ref for the card: the travel stops by itself once the card is unmounted or hidden. */
  attach: (el: HTMLElement | null) => void;
  min: number;
  max: number;
  speed: number;
}

/**
 * Carriage position over the simulated Y range, and Oscillate: Y_start to Y_end and back at the
 * simulation's own linear speed (motor speed x lead-screw pitch; the cam model has no load factor).
 */
export function useCamTravel(data: SimulationResult | null): CamTravel {
  const min = data?.Y_positions[0] ?? 0;
  const max = data?.Y_positions[data.Y_positions.length - 1] ?? 0;
  const speed = data?.linear_speed_mm_s ?? 0;
  const [rawY, setRawY] = useState(0);
  const [playing, setPlaying] = useState(false);
  const node = useRef<HTMLElement | null>(null);
  const live = useRef({ d: 0, speed, min, max });
  const y = Math.min(Math.max(rawY, min), max);
  const attach = useCallback((el: HTMLElement | null) => { node.current = el; }, []);

  useEffect(() => {
    live.current.speed = speed;
    live.current.min = min;
    live.current.max = max;
  }, [speed, min, max]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let shown = 0;
    const step = (now: number) => {
      const m = live.current;
      const span = m.max - m.min;
      if (m.speed <= 0 || span <= 0 || !node.current || node.current.offsetParent === null) { setPlaying(false); return; }
      if (last != null) m.d = (m.d + (now - last) / 1000 * m.speed) % (2 * span);
      last = now;
      if (now - shown > 30) {
        shown = now;
        setRawY(m.min + (m.d <= span ? m.d : 2 * span - m.d));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    // Resume from where the carriage is, on the way up.
    if (!playing) live.current.d = y - min;
    setPlaying(!playing);
  };
  const setY = (v: number) => { setPlaying(false); setRawY(v); };
  return { y, setY, playing, toggle, attach, min, max, speed };
}
