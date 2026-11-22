import { FlowParticles } from './FlowParticles';
import { flowFraction, fullBoreFlow } from './lib/flowParticles';
import { Button, Input, Modal } from '@blain-projects/ui';
import React, { useState, useEffect, useCallback, useRef, createContext, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { interpAt } from './lib/camTravel';
import { boreAcross, sectionAt, useTubeSweep } from './lib/tubeSweep';
import { legacyPsiToKpa } from './lib/pressure';
import {
  ChevronDown, ChevronRight,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Shared types ────────────────────────────────────────────────

export interface SimulationParams {
  motor_speed: number;
  height: number;
  thickness: number;
  K: number;
  deadband: number;
  default_distance: number;
  ramp_enabled: boolean;
  bushing_diameter: number;
  lead_screw_pitch: number;
  tube_id: number;
  tube_od: number;
  input_pressure_kpa: number;
  compliance: number;
  /** "fem": the bore comes from the tube's finite-element section; "simple": the compliance law. */
  tube_model: 'fem' | 'simple';
  tube_shore_a: number;
  chamber_volume_ml: number;
  note: string;
  /** Persisted UI settings (chart domains, etc.). */
  chart_settings?: Record<string, unknown>;
}

export interface ChartDomainSettings {
  autoX: boolean;
  autoY: boolean;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface SimulationResult {
  cam_X: number[];
  cam_Y: number[];
  Y_positions: number[];
  min_gaps: number[];
  flow_area: number[];
  flow_l_min: number[];
  dynamic_flow_l_min: number[];
  chamber_pressure_kpa: number[];
  time_axis_ms: number[];
  gap_at_Y0: number;
  default_distance: number;
  deadband: number;
  height: number;
  linear_speed_mm_s: number;
  ctrl_length: number;
  Y_start: number;
  Y_end: number;
  equalization_time_ms: number;
  total_volume_ml: number;
  ramp_enabled?: boolean;
  ramp_closed_Y?: number | null;
  ramp_join_Y?: number | null;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
export const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

/** Fetch wrapper that always sends auth cookies (cross-origin credentials). */
export const apiFetch = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(apiUrl(path), { ...init, credentials: 'include' });

export const defaultParams: SimulationParams = {
  motor_speed: 100,
  height: 2.0,
  thickness: 2.5,
  K: 2.0,
  deadband: 1.5,
  default_distance: 0.35,
  ramp_enabled: false,
  bushing_diameter: 3.0,
  lead_screw_pitch: 0.5,
  tube_id: 2.0,
  tube_od: 3.0,
  input_pressure_kpa: 100,
  compliance: 0.7,
  tube_model: 'fem',
  tube_shore_a: 50,
  chamber_volume_ml: 0.0,
  note: '',
  chart_settings: {},
};

// ─── Global tooltip guidance mode ────────────────────────────────

const TooltipHintsEnabledContext = createContext<boolean>(true);

export function TooltipHintsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <TooltipHintsEnabledContext.Provider value={enabled}>{children}</TooltipHintsEnabledContext.Provider>;
}

export function mergeConfigParams(input: Partial<SimulationParams> & Record<string, unknown>): SimulationParams {
  // A config file saved before pressures were in kPa carries input_pressure_psi: without this the
  // default 100 kPa would take its place.
  const raw = legacyPsiToKpa(input);
  return {
    ...defaultParams,
    ...raw,
    ramp_enabled: typeof raw.ramp_enabled === 'boolean' ? raw.ramp_enabled : false,
    tube_model: raw.tube_model === 'simple' || raw.tube_model === 'fem' ? raw.tube_model : defaultParams.tube_model,
    tube_shore_a: typeof raw.tube_shore_a === 'number' ? raw.tube_shore_a : defaultParams.tube_shore_a,
    note: typeof raw.note === 'string' ? raw.note : defaultParams.note,
    chamber_volume_ml: typeof raw.chamber_volume_ml === 'number' ? raw.chamber_volume_ml : defaultParams.chamber_volume_ml,
    chart_settings: (raw.chart_settings && typeof raw.chart_settings === 'object') ? raw.chart_settings as Record<string, unknown> : defaultParams.chart_settings,
  };
}

export function ClosureRampToggle({
  value,
  onChange,
  isModified = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  isModified?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Button variant="ghost" type="button" role="switch" aria-checked={value}
        onClick={() => onChange(!value)}
        className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${isModified ? 'border-amber-500/50 text-amber-300' : 'border-neutral-700 text-neutral-300'}`}
        title="Replace the 10 mm closed-side plateau with a smooth ramp tangent to the opening curve. The geometric offset reaches 0 mm at maximum closure; bushing play and tube compliance still determine the physical gap and flow.">
        <span>Closure ramp</span>
        <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${value ? 'bg-blue-600' : 'bg-neutral-600'}`}>
          <span className={`h-4 w-4 rounded-full bg-white transition-transform ${value ? 'translate-x-4' : ''}`} />
        </span>
      </Button>
      <p className="text-[10px] leading-snug text-neutral-400">
        {value ? '0 mm → Default Dist over 10 mm, with a tangent join.' : 'Constant Default Dist on the closed-side plateau.'}
      </p>
    </div>
  );
}

export function ChartDomainSettingsModal({
  isOpen,
  title,
  settings,
  onClose,
  onChange,
}: {
  isOpen: boolean;
  title: string;
  settings: ChartDomainSettings;
  onClose: () => void;
  onChange: (next: ChartDomainSettings) => void;
}) {
  const setNum = (key: keyof ChartDomainSettings, val: string) => {
    const n = parseFloat(val);
    if (!Number.isNaN(n)) onChange({ ...settings, [key]: n });
  };
  return (
    <Modal open={isOpen} onClose={onClose} title={title} size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={settings.autoX}
              onChange={(e) => onChange({ ...settings, autoX: e.target.checked })}
              className="rounded border-neutral-600 bg-neutral-900 text-blue-500"
            />
            Auto X
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={settings.autoY}
              onChange={(e) => onChange({ ...settings, autoY: e.target.checked })}
              className="rounded border-neutral-600 bg-neutral-900 text-blue-500"
            />
            Auto Y
          </label>
        </div>
        {!settings.autoX && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">X min</label>
              <Input type="number" value={settings.xMin} onChange={(e) => setNum('xMin', e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-500">X max</label>
              <Input type="number" value={settings.xMax} onChange={(e) => setNum('xMax', e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
            </div>
          </div>
        )}
        {!settings.autoY && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Y min</label>
              <Input type="number" value={settings.yMin} onChange={(e) => setNum('yMin', e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Y max</label>
              <Input type="number" value={settings.yMax} onChange={(e) => setNum('yMax', e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Accordion ───────────────────────────────────────────────────

const ACCORDION_STORE = 'cam-sim.accordions.v1';
const AccordionScopeContext = createContext('app');

/** Groups accordions so the same title on two tabs keeps two session states. */
export function AccordionScope({ id, children }: { id: string; children: React.ReactNode }) {
  return <AccordionScopeContext.Provider value={id}>{children}</AccordionScopeContext.Provider>;
}

function accordionMap(): Record<string, boolean> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ACCORDION_STORE) ?? 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, boolean>;
  } catch { /* private mode, or a value this page did not write */ }
  return {};
}

function storedOpen(key: string): boolean | undefined {
  const value = accordionMap()[key];
  return typeof value === 'boolean' ? value : undefined;
}

function storeOpen(key: string, open: boolean) {
  try {
    sessionStorage.setItem(ACCORDION_STORE, JSON.stringify({ ...accordionMap(), [key]: open }));
  } catch { /* storage blocked: the choice lasts until this panel unmounts */ }
}

export function Accordion({
  title,
  children,
  defaultOpen = false,
  showBottomBorder = true,
  id,
  openSignal,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  showBottomBorder?: boolean;
  id?: string;
  /** When incremented above 0, forces the accordion open (e.g. when a user unlocks a solver variable). */
  openSignal?: number;
}) {
  const scope = useContext(AccordionScopeContext);
  const storageKey = `${scope}:${id ?? title}`;
  const [isOpen, setIsOpen] = useState(() => storedOpen(storageKey) ?? defaultOpen);
  const [seenKey, setSeenKey] = useState(storageKey);
  const [seenSignal, setSeenSignal] = useState(openSignal ?? 0);
  if (storageKey !== seenKey) {
    setSeenKey(storageKey);
    setIsOpen(storedOpen(storageKey) ?? defaultOpen);
  }
  if (openSignal != null && openSignal > 0 && openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (!isOpen) {
      setIsOpen(true);
      storeOpen(storageKey, true);
    }
  }
  const toggle = () => {
    setIsOpen((prev) => {
      const next = !prev;
      storeOpen(storageKey, next);
      return next;
    });
  };
  return (
    <div key={storageKey} className={showBottomBorder ? 'border-b border-neutral-700/50 pb-2' : 'pb-2'}>
      <Button variant="ghost"
        onClick={toggle}
        aria-expanded={isOpen}
        className="w-full flex cursor-pointer items-center justify-between rounded-lg border border-transparent px-2 py-2 text-sm font-semibold text-neutral-400 transition-all hover:border-neutral-700 hover:bg-neutral-700/30 hover:text-neutral-100"
      >
        <span>{title}</span>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </Button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Delayed tooltip (hover ≥ delayMs) ───────────────────────────

export function DelayedHoverHint({
  children,
  content,
  delayMs = 500,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  delayMs?: number;
}) {
  const hintsEnabled = useContext(TooltipHintsEnabledContext);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);
  useEffect(() => {
    if (!hintsEnabled) {
      clearTimer();
      setOpen(false);
    }
  }, [hintsEnabled, clearTimer]);

  const scheduleOpen = useCallback(() => {
    // Touch screens have no true hover: avoid stuck floating tooltips after a tap.
    if (typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 12;
      const maxW = 320;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.right + gap;
      if (left + maxW > vw - 12) {
        left = Math.max(12, r.left - gap - maxW);
      }
      let top = r.top;
      const estH = 280;
      if (top + estH > vh - 12) {
        top = Math.max(12, vh - estH - 12);
      }
      setPos({ top, left });
      setOpen(true);
    }, delayMs);
  }, [clearTimer, delayMs]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  if (!hintsEnabled) {
    return <>{children}</>;
  }

  return (
    <>
      <div
        ref={wrapRef}
        className="rounded-md ring-offset-2 ring-offset-neutral-900"
        onMouseEnter={scheduleOpen}
        onMouseLeave={hide}
      >
        {children}
      </div>
      {hintsEnabled && open &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[100001] w-[min(20rem,calc(100vw-1.5rem))] max-h-[min(70vh,24rem)] overflow-y-auto rounded-xl border border-neutral-600 bg-neutral-900/98 p-3 text-left shadow-2xl"
            style={{ top: pos.top, left: pos.left }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}

// ─── ParameterSlider ─────────────────────────────────────────────

export function ParameterSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  secondaryValue,
  isModified,
  description,
  disabled = false,
  inputDecimals,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (val: number) => void;
  secondaryValue?: string;
  isModified?: boolean;
  /** Shown after 500 ms when hovering the control (label + inputs). */
  description?: React.ReactNode;
  disabled?: boolean;
  /** The number box shows a value off the step (a converted 103.42…) to this many decimals and accepts it. */
  inputDecimals?: number;
}) {
  const hintsEnabled = useContext(TooltipHintsEnabledContext);
  const inner = (
    <div className={`space-y-2 ${disabled ? 'pointer-events-none opacity-45' : ''}`}>
      <div className="flex justify-between items-center gap-2">
        <label
          className={`min-w-0 flex-1 text-sm tracking-tight flex flex-wrap items-center gap-x-2 gap-y-0.5 ${isModified ? 'text-amber-400 font-bold' : 'text-neutral-300 font-medium'}`}
        >
          <span>{label}</span>
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 hidden xl:block" />}
          {secondaryValue && (
            <span className={`text-xs font-normal ${isModified ? 'text-amber-500/70' : 'text-neutral-500'}`}>
              ({secondaryValue})
            </span>
          )}
        </label>
        <Input
          type="number"
          value={inputDecimals != null && !Number.isInteger(value) ? Number(value.toFixed(inputDecimals)) : value}
          min={min}
          max={max}
          step={inputDecimals != null ? 'any' : step}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
          className="w-20 shrink-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-right text-neutral-100 font-mono disabled:cursor-not-allowed"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500 hover:accent-blue-400 transition-all cursor-pointer disabled:cursor-not-allowed"
      />
    </div>
  );

  if (hintsEnabled && description) {
    return <DelayedHoverHint content={description}>{inner}</DelayedHoverHint>;
  }
  return inner;
}

// ─── StatRow ─────────────────────────────────────────────────────

export function StatRow({ label, value, highlight = false }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-2 bg-neutral-900/50 p-2 rounded">
      <span className="min-w-0 text-sm text-neutral-400">{label}</span>
      <span className={`shrink-0 text-right text-sm font-mono font-medium ${highlight ? 'text-fuchsia-400' : 'text-neutral-200'}`}>{value}</span>
    </div>
  );
}

// ─── SVG helpers ─────────────────────────────────────────────────

function svgClientToWorld(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const inv = svg.getScreenCTM()?.inverse();
  if (!inv) return { x: 0, y: 0 };
  return pt.matrixTransform(inv);
}

// ─── VerticalSystemSvgDiagram ────────────────────────────────────

export function VerticalSystemSvgDiagram({
  data,
  params,
  details,
  isPreview = false,
  allowInteractInPreview = false,
  domainOverride,
  y,
}: {
  data: SimulationResult;
  params: SimulationParams;
  details: boolean;
  isPreview?: boolean;
  allowInteractInPreview?: boolean;
  domainOverride?: ChartDomainSettings;
  /** Bushing position along the cam (mm). Given, the cam is drawn shifted by -y with the pinched tube; omitted, the static drawing at Y = 0. */
  y?: number;
}) {
  const live = y !== undefined;
  const r = params.bushing_diameter / 2;
  const flatCamX = r + params.default_distance;
  const maxCamX = Math.max(...data.cam_X);

  const autoMinX = details ? -r - 0.6 : -r - 0.4;
  const autoMaxX = details ? maxCamX + 1.0 : maxCamX + 0.4;
  const legacyMinY = (details || isPreview) ? -params.deadband - r - 1.2 : -params.deadband - r - 0.4;
  const autoMinY = data.ramp_enabled && data.ramp_closed_Y != null ? Math.min(legacyMinY, data.ramp_closed_Y - 0.4) : legacyMinY;
  const autoMaxY = (details || isPreview) ? params.height + r + 1.2 : params.height + r + 0.4;
  const minX = domainOverride && !domainOverride.autoX ? domainOverride.xMin : autoMinX;
  const maxX = domainOverride && !domainOverride.autoX ? domainOverride.xMax : autoMaxX;
  const minY = domainOverride && !domainOverride.autoY ? domainOverride.yMin : autoMinY;
  const maxY = domainOverride && !domainOverride.autoY ? domainOverride.yMax : autoMaxY;

  const w = maxX - minX;
  const h = maxY - minY;

  const camPoints = data.cam_X.map((x, i) => `${x},${data.cam_Y[i]}`).join(' ');
  const cx = 0;
  const cy = 0;

  const boundsRef = useRef({ bw: w });
  useEffect(() => { boundsRef.current = { bw: w }; }, [w]);

  const [vb, setVb] = useState({ x: minX, y: minY, w, h });
  useEffect(() => { setVb({ x: minX, y: minY, w, h }); }, [minX, minY, w, h]);

  const resetView = useCallback(() => { setVb({ x: minX, y: minY, w, h }); }, [minX, minY, w, h]);

  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ id: number | null; last: { x: number; y: number } | null }>({ id: null, last: null });
  const pointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map());
  const pinchDistRef = useRef<number | null>(null);

  const canInteract = details && (!isPreview || allowInteractInPreview);

  useEffect(() => {
    if (!details) {
      panRef.current = { id: null, last: null };
      pointersRef.current.clear();
      pinchDistRef.current = null;
    }
  }, [details]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !canInteract) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pt = svgClientToWorld(el, e.clientX, e.clientY);
      const { bw } = boundsRef.current;
      setVb((prev) => {
        const z = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        let newW = prev.w * z;
        newW = Math.min(Math.max(newW, bw * 0.02), bw * 25);
        const zAct = newW / prev.w;
        const newH = prev.h * zAct;
        return { x: pt.x - (pt.x - prev.x) * zAct, y: pt.y - (pt.y - prev.y) * zAct, w: newW, h: newH };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [canInteract]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!canInteract || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (pointersRef.current.size === 1) {
      const p = svgClientToWorld(e.currentTarget, e.clientX, e.clientY);
      panRef.current = { id: e.pointerId, last: p };
      pinchDistRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchDistRef.current = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      panRef.current = { id: null, last: null };
    }
  }, [canInteract]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!canInteract) return;
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    }
    if (pointersRef.current.size === 2 && pinchDistRef.current != null) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      if (dist > 4 && pinchDistRef.current > 4) {
        const z = pinchDistRef.current / dist;
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        const pt = svgClientToWorld(e.currentTarget, midX, midY);
        const { bw } = boundsRef.current;
        setVb((prev) => {
          const newW = Math.min(Math.max(prev.w * z, bw * 0.02), bw * 25);
          const zAct = newW / prev.w;
          const newH = prev.h * zAct;
          return { x: pt.x - (pt.x - prev.x) * zAct, y: pt.y - (pt.y - prev.y) * zAct, w: newW, h: newH };
        });
        pinchDistRef.current = dist;
      }
      return;
    }
    if (panRef.current.id === null || panRef.current.last === null) return;
    if (e.pointerId !== panRef.current.id) return;
    const p = svgClientToWorld(e.currentTarget, e.clientX, e.clientY);
    const last = panRef.current.last;
    setVb((prev) => ({ ...prev, x: prev.x + (last.x - p.x), y: prev.y + (last.y - p.y) }));
    panRef.current.last = p;
  }, [canInteract]);

  const onPointerEnd = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(e.pointerId);
    try { (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pointersRef.current.size < 2) pinchDistRef.current = null;
    if (pointersRef.current.size === 1) {
      const [[id, pt]] = [...pointersRef.current.entries()];
      panRef.current = { id, last: svgClientToWorld(e.currentTarget, pt.clientX, pt.clientY) };
    } else if (panRef.current.id === e.pointerId || pointersRef.current.size === 0) {
      panRef.current = { id: null, last: null };
    }
  }, []);

  // Dimension lines in cam coordinates: in the live view they move with the cam. Without a ramp the
  // default-distance mark sits near the bottom of the view, on the straight wall.
  const defDistY = data.ramp_join_Y ?? (live ? Math.min(minY + 0.5 + (y ?? 0), -params.deadband / 2) : minY + 0.5);
  const camDimensions = (
    <>
      <line x1={flatCamX - 0.2} y1={-params.deadband / 2} x2={flatCamX - 0.2} y2={params.deadband / 2} stroke="#ef4444" strokeWidth="0.03" />
      <line x1={flatCamX - 0.4} y1={-params.deadband / 2} x2={flatCamX} y2={-params.deadband / 2} stroke="#ef4444" strokeWidth="0.05" />
      <line x1={flatCamX - 0.4} y1={params.deadband / 2} x2={flatCamX} y2={params.deadband / 2} stroke="#ef4444" strokeWidth="0.05" />
      <g transform="scale(1,-1)">
        <text x={flatCamX - 0.4} y={-(params.deadband / 2 + 0.2)} fill="#ef4444" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="auto">Deadband {params.deadband.toFixed(2)}mm</text>
      </g>

      <line x1={maxCamX + 0.6} y1={-params.deadband / 2} x2={maxCamX + 0.6} y2={-params.deadband / 2 + params.height} stroke="#10b981" strokeWidth="0.03" />
      <line x1={maxCamX + 0.4} y1={-params.deadband / 2} x2={maxCamX + 0.8} y2={-params.deadband / 2} stroke="#10b981" strokeWidth="0.05" />
      <line x1={maxCamX + 0.4} y1={-params.deadband / 2 + params.height} x2={maxCamX + 0.8} y2={-params.deadband / 2 + params.height} stroke="#10b981" strokeWidth="0.05" />
      <g transform="scale(1,-1)">
        <text x={maxCamX + 0.8} y={-(-params.deadband / 2 - 0.2)} fill="#10b981" fontSize="0.22" fontWeight="bold" textAnchor="end" dominantBaseline="hanging">Height {params.height.toFixed(2)}mm</text>
      </g>

      <line x1={r} y1={defDistY} x2={flatCamX} y2={defDistY} stroke="#f59e0b" strokeWidth="0.03" />
      <line x1={r} y1={defDistY - 0.2} x2={r} y2={defDistY + 0.2} stroke="#f59e0b" strokeWidth="0.05" />
      <line x1={flatCamX} y1={defDistY - 0.2} x2={flatCamX} y2={defDistY + 0.2} stroke="#f59e0b" strokeWidth="0.05" />
      <g transform="scale(1,-1)">
        <text x={flatCamX + 0.3} y={-defDistY} fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="middle">Def. Dist {params.default_distance.toFixed(3)}mm</text>
        <text x={flatCamX + 0.3} y={-(live ? defDistY + 0.35 : minY + 0.85)} fill="#60a5fa" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="middle">K {params.K.toFixed(3)}</text>
        {data.ramp_enabled && data.ramp_closed_Y != null && <text x={r + 0.3} y={-data.ramp_closed_Y} fill="#10b981" fontSize="0.22" fontWeight="bold" dominantBaseline="middle">Ramp end: 0 mm offset</text>}
      </g>
    </>
  );

  return (
    <>
      {canInteract && (
        <Button variant="ghost" type="button" onClick={resetView} title="Reset view"
          className="absolute bottom-2 right-2 z-10 p-2 rounded-lg bg-neutral-800/95 border border-neutral-600 text-neutral-300 hover:bg-neutral-700 hover:text-white shadow-md transition-colors">
          <RefreshCw className="w-4 h-4" />
        </Button>
      )}
      <svg ref={svgRef} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
        className={`w-full h-full scale-y-[-1] select-none ${canInteract ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onDoubleClick={(e) => { if (!canInteract) return; e.preventDefault(); resetView(); }}>

        <motion.rect initial={false} animate={{ x: minX, y: minY, width: w, height: h }} transition={{ duration: 0.25, ease: 'easeOut' }} fill="#171717" />
        <motion.path initial={false} animate={{ d: `M ${minX} ${0} L ${maxX} ${0}` }} transition={{ duration: 0.25, ease: 'easeOut' }} stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" />
        <motion.path initial={false} animate={{ d: `M ${0} ${minY} L ${0} ${maxY}` }} transition={{ duration: 0.25, ease: 'easeOut' }} stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" />

        {live ? (
          <>
            <g transform={`translate(0 ${-y})`}>
              <polyline points={camPoints} fill="none" stroke="#10b981" strokeWidth="0.08" strokeLinejoin="round" />
              {details && camDimensions}
            </g>
            <LiveTubeAndGap data={data} params={params} y={y} details={details} />
          </>
        ) : (
          <>
            <polyline points={camPoints} fill="none" stroke="#10b981" strokeWidth="0.08" strokeLinejoin="round" />
            <circle cx={cx} cy={cy} r={r} fill="#8b5cf6" fillOpacity={details ? 0.3 : 0.1} stroke="#8b5cf6" strokeWidth="0.08" opacity={0.8} />
          </>
        )}

        {details && !live && (
          <g>
            {camDimensions}

            {(() => {
              let minDist = Infinity;
              let closestIdx = 0;
              data.cam_X.forEach((x, i) => {
                const d = Math.sqrt(x * x + data.cam_Y[i] * data.cam_Y[i]);
                if (d < minDist) { minDist = d; closestIdx = i; }
              });
              const xCam = data.cam_X[closestIdx];
              const yCam = data.cam_Y[closestIdx];
              const dCenter = Math.sqrt(xCam * xCam + yCam * yCam);
              const nx = xCam / dCenter;
              const ny = yCam / dCenter;
              const actualGap = (dCenter - r) + 0.25;
              const offX = -0.25 * nx;
              const offY = -0.25 * ny;
              const xCirc = offX + nx * r;
              const yCirc = offY + ny * r;
              return (
                <g>
                  <circle cx={offX} cy={offY} r={r} fill="none" stroke="#f59e0b" strokeWidth="0.02" strokeDasharray="0.1 0.1" />
                  <line x1={xCirc} y1={yCirc} x2={xCam} y2={yCam} stroke="#f59e0b" strokeWidth="0.04" strokeDasharray="0.05 0.05" />
                  <circle cx={xCirc} cy={yCirc} r="0.03" fill="#f59e0b" />
                  <circle cx={xCam} cy={yCam} r="0.03" fill="#f59e0b" />
                  <g transform={`translate(${xCam + 0.8}, ${yCam}) scale(1,-1)`}>
                    <rect x="-0.4" y="-0.15" width="1.2" height="0.3" fill="#171717" fillOpacity="0.8" rx="0.05" />
                    <text x="0.2" y="0.05" fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="middle">Gap {actualGap.toFixed(3)}mm</text>
                  </g>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </>
  );
}

/**
 * The bushing, the tube and the gap at carriage position `y`, drawn from the simulation's arrays:
 * the gap is `min_gaps`. With the FEM tube, the tube is the FEM section at that gap (from the sweep,
 * interpolated per frame); with the simple model, the model's slot of area `flow_area`. Only the
 * direction of the pinch comes from the drawn cam (its nearest point to the screw axis).
 */
function LiveTubeAndGap({ data, params, y, details }: { data: SimulationResult; params: SimulationParams; y: number; details: boolean }) {
  // While a new tube solves, the last FEM tube stays drawn (marked in the tooltip) rather than the simple slot.
  const { drawn: sweep, stale } = useTubeSweep(params);
  const r = params.bushing_diameter / 2;
  const gap = interpAt(y, data.Y_positions, data.min_gaps);
  const area = interpAt(y, data.Y_positions, data.flow_area);
  const flow = interpAt(y, data.Y_positions, data.flow_l_min);
  const maxFlow = Math.max(0, ...data.flow_l_min);

  // Nearest point of the shifted cam profile to the screw axis (segment projection).
  let best = Infinity, px = r + params.default_distance, py = 0;
  for (let i = 0; i + 1 < data.cam_X.length; i++) {
    const ax = data.cam_X[i], ay = data.cam_Y[i] - y;
    const dx = data.cam_X[i + 1] - ax, dy = data.cam_Y[i + 1] - y - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.min(Math.max(-(ax * dx + ay * dy) / l2, 0), 1) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = qx * qx + qy * qy;
    if (d < best) { best = d; px = qx; py = qy; }
  }
  const dist = Math.sqrt(best) || 1;
  const nx = px / dist, ny = py / dist;
  // The bushing sits one gap from the cam: its radial play is taken up away from the cam.
  const bx = px - nx * (gap + r), by = py - ny * (gap + r);

  // Tube section, schematic: the model's own slot. The bore is (pi/2)*ID wide and flow_area / width
  // high (the backend's inner gap, capped at the full bore area); the walls fill the rest of the gap.
  const od = params.tube_od, id = params.tube_id;
  const wi = (Math.PI / 2) * id;
  const hi = wi > 0 ? area / wi : 0;
  const ho = Math.max(Math.min(gap, od), hi, 0.01);
  const lo = wi + (od - id);
  const li = wi;
  const tx = px - nx * gap / 2, ty = py - ny * gap / 2;
  const angle = Math.atan2(ny, nx) * 180 / Math.PI;
  const frac = maxFlow > 0 ? Math.min(flow / maxFlow, 1) : 0;
  const particles = flowFraction(flow, fullBoreFlow(data.flow_l_min, data.flow_area, id));
  // FEM tube: its section at this gap, the plates' normal (the section's y) along the gap, true scale.
  const fem = sweep ? sectionAt(sweep, gap) : null;
  const femPath = (pts: [number, number][]) => pts.map(([fx, fy], i) => `${i ? 'L' : 'M'}${fy.toFixed(4)},${fx.toFixed(4)}`).join(' ') + ' Z';
  const halfLength = fem ? Math.max(...fem.outer.map((p) => Math.abs(p[0]))) : lo / 2;
  // Label just past the tube's end, along the cam.
  const lx = tx - ny * (halfLength + 0.3), ly = ty + nx * (halfLength + 0.3);
  const boreFill = frac > 0 ? '#10b981' : '#ef4444';

  return (
    <g>
      <g transform={`translate(${tx} ${ty}) rotate(${angle})`}>
        {fem ? (
          <>
            <title>{`Tube section from the FEM at the ${gap.toFixed(3)} mm gap${fem.extrapolated ? ' (extrapolated: deeper than the FEM solved, its deepest shape flattened to the gap)' : ''}: squeezed between two flat plates, so it does not follow the curve of the bushing or the cam. Bore ${fem.open_area_mm2.toFixed(3)} mm².${stale ? ' The previous tube, shown while the new one solves.' : ''}`}</title>
            <path d={femPath(fem.outer)} fill="#d4d4d4" fillOpacity={0.16} stroke="#d4d4d4" strokeWidth={0.03} strokeLinejoin="round" />
            <path d={femPath(fem.inner)} fill={boreFill} fillOpacity={0.25 + 0.45 * frac} stroke={fem.open_area_mm2 > 0 ? boreFill : '#ef4444'} strokeWidth={0.02} strokeLinejoin="round" />
            <FlowParticles view="section" frac={particles} width={0} length={0} bore={boreAcross(fem.inner)} radius={0.06} color="#f5f5f5" />
          </>
        ) : (
          <>
            <rect x={-ho / 2} y={-lo / 2} width={ho} height={lo} rx={ho / 2} fill="#d4d4d4" fillOpacity={0.16} stroke="#d4d4d4" strokeWidth={0.03} />
            <title>Tube section (schematic): the model's slot, bore area = simulated flow area</title>
            {hi > 0.005
              ? <rect x={-hi / 2} y={-li / 2} width={hi} height={li} rx={Math.min(hi / 2, 0.05)} fill={boreFill} fillOpacity={0.25 + 0.45 * frac} />
              : <line x1={0} y1={-li / 2} x2={0} y2={li / 2} stroke="#ef4444" strokeWidth={0.04} />}
            {/* Air crossing the section, perpendicular to the screen; full density and speed at the full-bore flow */}
            <FlowParticles view="section" frac={particles} width={hi} length={li} radius={0.06} color="#f5f5f5" />
          </>
        )}
      </g>
      <circle cx={bx} cy={by} r={r} fill="#8b5cf6" fillOpacity={details ? 0.3 : 0.1} stroke="#8b5cf6" strokeWidth="0.08" opacity={0.8} />
      <line x1={-0.12} y1={0} x2={0.12} y2={0} stroke="#a3a3a3" strokeWidth={0.03} />
      <line x1={0} y1={-0.12} x2={0} y2={0.12} stroke="#a3a3a3" strokeWidth={0.03} />
      {details && (
        <g>
          <circle cx={0} cy={0} r={r} fill="none" stroke="#f59e0b" strokeWidth="0.02" strokeDasharray="0.1 0.1" />
          <line x1={bx + nx * r} y1={by + ny * r} x2={px} y2={py} stroke="#f59e0b" strokeWidth="0.04" strokeDasharray="0.05 0.05" />
          <circle cx={bx + nx * r} cy={by + ny * r} r="0.03" fill="#f59e0b" />
          <circle cx={px} cy={py} r="0.03" fill="#f59e0b" />
        </g>
      )}
      <g transform={`translate(${lx} ${ly}) scale(1,-1)`}>
        <text x={0} y={0} fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="middle" dominantBaseline="middle"
          stroke="#171717" strokeWidth={0.06} paintOrder="stroke">Gap {gap.toFixed(3)} mm</text>
        {details && (
          <text x={0} y={0.3} fill="#a3a3a3" fontSize="0.16" textAnchor="middle" dominantBaseline="middle"
            stroke="#171717" strokeWidth={0.05} paintOrder="stroke">{fem
              ? `Tube section, FEM${fem.extrapolated ? ' (extrapolated)' : ''}: bore ${fem.open_area_mm2.toFixed(3)} mm²`
              : `Tube section, schematic: bore ${hi.toFixed(3)} mm, ${area.toFixed(3)} mm²`}</text>
        )}
      </g>
    </g>
  );
}

// ─── VerticalSystemView ──────────────────────────────────────────

export function VerticalSystemView({
  data,
  params,
  details,
  setDetails,
  isPreview = false,
  allowInteractInPreview = false,
  domainOverride,
}: {
  data: SimulationResult | null;
  params: SimulationParams;
  details: boolean;
  setDetails: (val: boolean) => void;
  isPreview?: boolean;
  allowInteractInPreview?: boolean;
  domainOverride?: ChartDomainSettings;
}) {
  if (!data) return <div className="animate-pulse bg-neutral-900/60 w-full h-full rounded-lg" />;
  return (
    <div className={`w-full h-full flex flex-col relative overflow-hidden ${isPreview && !allowInteractInPreview ? 'pointer-events-none' : ''}`}>
      {!isPreview && (
        <div className="flex items-center gap-3 mb-4 shrink-0 min-w-0">
          <h3 className="text-sm font-semibold text-neutral-300 min-w-0 flex-1 truncate">Vertical System</h3>
          <Button variant="ghost" type="button" onClick={() => setDetails(!details)}
            className={`shrink-0 px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}>
            {details ? 'Hide Details' : 'Details'}
          </Button>
        </div>
      )}
      <div className={`flex-1 w-full bg-neutral-900/60 rounded-lg border border-neutral-800/80 overflow-hidden relative ${isPreview ? 'rounded-xl border-blue-500/30' : ''}`}>
        <VerticalSystemSvgDiagram
          data={data}
          params={params}
          details={details}
          isPreview={isPreview}
          allowInteractInPreview={allowInteractInPreview}
          domainOverride={domainOverride}
        />
      </div>
    </div>
  );
}

// ─── Cam profile preview ─────────────────────────────────────────

function staticFlowAt(sim: SimulationResult, yMm: number): number | null {
  const ys = sim.Y_positions;
  const vals = sim.flow_l_min;
  const len = ys.length;
  if (!len || len !== vals.length) return null;
  if (len === 1) return vals[0];
  for (let i = 0; i < len - 1; i++) {
    const a = ys[i];
    const b = ys[i + 1];
    if (a === b) continue;
    if ((yMm - a) * (yMm - b) <= 0) {
      const t = (yMm - a) / (b - a);
      return vals[i] + t * (vals[i + 1] - vals[i]);
    }
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < len; i++) {
    const d = Math.abs(ys[i] - yMm);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return vals[best];
}

/** The import window's preview of a Cam Explorer profile: its inputs, simulated figures and cam drawing. */
export function CamProfilePreview({ payload }: { payload: Record<string, unknown> }) {
  const params = useMemo(() => mergeConfigParams(payload), [payload]);
  // The simulation answer with the parameters it is for: a late answer for an earlier hover never shows.
  const [sim, setSim] = useState<{ params: SimulationParams; data: SimulationResult } | null>(null);
  const data = sim?.params === params ? sim.data : null;
  useEffect(() => {
    const ac = new AbortController();
    apiFetch('/api/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: ac.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((out) => { if (!ac.signal.aborted && out && Array.isArray(out.Y_positions)) setSim({ params, data: out }); })
      .catch(() => { /* no figures, the inputs stay */ });
    return () => ac.abort();
  }, [params]);
  const stats = useMemo(() => {
    if (!data) return null;
    return {
      gapAtY0: data.gap_at_Y0,
      staticFlowAtHalfMm: staticFlowAt(data, 0.5),
      maxStaticFlow: data.flow_l_min.length ? Math.max(...data.flow_l_min) : 0,
      maxDynamicFlow: data.dynamic_flow_l_min.length ? Math.max(...data.dynamic_flow_l_min) : null,
      totalVolume: data.total_volume_ml,
      equalization: data.equalization_time_ms,
    };
  }, [data]);
  const row = (label: string, value: string, tone = 'text-neutral-200') => (
    <div key={label} className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">{label}</span><span className={`text-[11px] font-mono ${tone}`}>{value}</span></div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="max-h-40 w-full overflow-y-auto border-b border-neutral-800 bg-neutral-900/65 p-4 space-y-4 md:max-h-none md:w-2/5 md:max-w-[280px] md:border-b-0 md:border-r">
        <div>
          <div className="text-[10px] text-neutral-500 font-bold mb-2">Simulation Inputs</div>
          <div className="grid grid-cols-1 gap-2">
            {row('Motor speed', `${params.motor_speed.toFixed(1)} RPM`)}
            {row('Thickness', `${params.thickness.toFixed(3)} mm`)}
            {row('Tube', `${params.tube_id.toFixed(2)} x ${params.tube_od.toFixed(2)} mm`)}
            {row('Pressure', `${params.input_pressure_kpa.toFixed(1)} kPa`)}
            {row('Compliance', `${params.compliance.toFixed(3)} mm/MPa`)}
            {row('Chamber vol.', `${params.chamber_volume_ml.toFixed(2)} mL`)}
          </div>
        </div>
        {stats && (
          <div>
            <div className="text-[10px] text-neutral-500 font-bold mb-2">Dynamic Stats</div>
            <div className="grid grid-cols-1 gap-2">
              {row('gap @ Y=0', `${stats.gapAtY0.toFixed(4)} mm`, 'text-cyan-300')}
              {row('Static flow @ Y=0.5', stats.staticFlowAtHalfMm !== null ? `${stats.staticFlowAtHalfMm.toFixed(3)} L/min` : 'N/A', 'text-amber-300')}
              {row('Max flow (static)', `${stats.maxStaticFlow.toFixed(3)} L/min`, 'text-amber-300')}
              {row('Max flow (dynamic)', stats.maxDynamicFlow !== null ? `${stats.maxDynamicFlow.toFixed(3)} L/min` : 'N/A', 'text-amber-300')}
              {row('Total volume', `${stats.totalVolume.toFixed(2)} mL`, 'text-amber-300')}
              {row('Equalization', stats.equalization >= 0 ? `${stats.equalization.toFixed(1)} ms` : 'N/A', 'text-amber-300')}
            </div>
          </div>
        )}
      </div>
      <div className="flex min-h-32 min-w-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="w-full h-full flex flex-col items-center justify-center">
          <VerticalSystemView data={data} params={params} details={true} setDetails={() => {}} isPreview={true} />
        </div>
      </div>
    </div>
  );
}
