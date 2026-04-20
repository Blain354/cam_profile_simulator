import React, { useState, useEffect, useCallback, useRef, createContext, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, Trash2,
  X, RefreshCw
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
  bushing_diameter: number;
  lead_screw_pitch: number;
  tube_id: number;
  tube_od: number;
  input_pressure_psi: number;
  compliance: number;
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

export interface SavedConfigEntry {
  filename: string;
  note: string;
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
  bushing_diameter: 3.0,
  lead_screw_pitch: 0.5,
  tube_id: 2.0,
  tube_od: 3.0,
  input_pressure_psi: 15.0,
  compliance: 0.7,
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

export function mergeConfigParams(raw: Partial<SimulationParams> & Record<string, unknown>): SimulationParams {
  return {
    ...defaultParams,
    ...raw,
    note: typeof raw.note === 'string' ? raw.note : defaultParams.note,
    chamber_volume_ml: typeof raw.chamber_volume_ml === 'number' ? raw.chamber_volume_ml : defaultParams.chamber_volume_ml,
    chart_settings: (raw.chart_settings && typeof raw.chart_settings === 'object') ? raw.chart_settings as Record<string, unknown> : defaultParams.chart_settings,
  };
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
  if (!isOpen) return null;
  const setNum = (key: keyof ChartDomainSettings, val: string) => {
    const n = parseFloat(val);
    if (!Number.isNaN(n)) onChange({ ...settings, [key]: n });
  };
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-neutral-200">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={settings.autoX}
                onChange={(e) => onChange({ ...settings, autoX: e.target.checked })}
                className="rounded border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500"
              />
              Auto X
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={settings.autoY}
                onChange={(e) => onChange({ ...settings, autoY: e.target.checked })}
                className="rounded border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500"
              />
              Auto Y
            </label>
          </div>
          {!settings.autoX && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">X min</label>
                <input type="number" value={settings.xMin} onChange={(e) => setNum('xMin', e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">X max</label>
                <input type="number" value={settings.xMax} onChange={(e) => setNum('xMax', e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </div>
            </div>
          )}
          {!settings.autoY && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Y min</label>
                <input type="number" value={settings.yMin} onChange={(e) => setNum('yMin', e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Y max</label>
                <input type="number" value={settings.yMax} onChange={(e) => setNum('yMax', e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Accordion ───────────────────────────────────────────────────

export function Accordion({
  title,
  children,
  defaultOpen = true,
  showBottomBorder = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  showBottomBorder?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className={showBottomBorder ? 'border-b border-neutral-700/50 pb-2' : 'pb-2'}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="w-full flex cursor-pointer items-center justify-between rounded-lg border border-transparent px-2 py-2 text-sm font-semibold text-neutral-400 transition-all hover:border-neutral-700 hover:bg-neutral-700/30 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <span>{title}</span>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
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
            className="pointer-events-none fixed z-[100001] w-[min(20rem,calc(100vw-1.5rem))] max-h-[min(70vh,24rem)] overflow-y-auto rounded-xl border border-neutral-600 bg-neutral-900/98 p-3 text-left shadow-2xl backdrop-blur-md"
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
}) {
  const hintsEnabled = useContext(TooltipHintsEnabledContext);
  const inner = (
    <div className={`space-y-2 ${disabled ? 'pointer-events-none opacity-45' : ''}`}>
      <div className="flex justify-between items-center">
        <label
          className={`text-sm tracking-tight flex items-center gap-2 ${isModified ? 'text-amber-400 font-bold' : 'text-neutral-300 font-medium'}`}
        >
          {label}
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse hidden xl:block" />}
          {secondaryValue && (
            <span className={`ml-2 text-xs font-normal ${isModified ? 'text-amber-500/70' : 'text-neutral-500'}`}>
              ({secondaryValue})
            </span>
          )}
        </label>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(v);
          }}
          className="w-20 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-right text-neutral-100 focus:outline-none focus:border-blue-500 font-mono disabled:cursor-not-allowed"
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
    <div className="flex justify-between items-center bg-neutral-900/50 p-2 rounded">
      <span className="text-sm text-neutral-400">{label}</span>
      <span className={`text-sm font-mono font-medium ${highlight ? 'text-fuchsia-400' : 'text-neutral-200'}`}>{value}</span>
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
}: {
  data: SimulationResult;
  params: SimulationParams;
  details: boolean;
  isPreview?: boolean;
  allowInteractInPreview?: boolean;
  domainOverride?: ChartDomainSettings;
}) {
  const r = params.bushing_diameter / 2;
  const flatCamX = r + params.default_distance;
  const maxCamX = Math.max(...data.cam_X);

  const autoMinX = details ? -r - 0.6 : -r - 0.4;
  const autoMaxX = details ? maxCamX + 1.0 : maxCamX + 0.4;
  const autoMinY = (details || isPreview) ? -params.deadband - r - 1.2 : -params.deadband - r - 0.4;
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

  const canInteract = details && (!isPreview || allowInteractInPreview);

  useEffect(() => { if (!details) panRef.current = { id: null, last: null }; }, [details]);

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
    if (!canInteract || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    const p = svgClientToWorld(e.currentTarget, e.clientX, e.clientY);
    panRef.current = { id: e.pointerId, last: p };
  }, [canInteract]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!canInteract || panRef.current.id === null || panRef.current.last === null) return;
    if (e.pointerId !== panRef.current.id) return;
    const p = svgClientToWorld(e.currentTarget, e.clientX, e.clientY);
    const last = panRef.current.last;
    setVb((prev) => ({ ...prev, x: prev.x + (last.x - p.x), y: prev.y + (last.y - p.y) }));
    panRef.current.last = p;
  }, [canInteract]);

  const onPointerEnd = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (panRef.current.id !== e.pointerId) return;
    try { (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    panRef.current = { id: null, last: null };
  }, []);

  return (
    <>
      {canInteract && (
        <button type="button" onClick={resetView} title="Reset view"
          className="absolute bottom-2 right-2 z-10 p-2 rounded-lg bg-neutral-800/95 border border-neutral-600 text-neutral-300 hover:bg-neutral-700 hover:text-white shadow-md transition-colors focus:outline-none focus:ring-2 ring-blue-500">
          <RefreshCw className="w-4 h-4" />
        </button>
      )}
      <svg ref={svgRef} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
        className={`w-full h-full scale-y-[-1] touch-none select-none ${canInteract ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onDoubleClick={(e) => { if (!canInteract) return; e.preventDefault(); resetView(); }}>

        <motion.rect initial={false} animate={{ x: minX, y: minY, width: w, height: h }} transition={{ duration: 0.5, ease: 'easeInOut' }} fill="#171717" />
        <motion.path initial={false} animate={{ d: `M ${minX} ${0} L ${maxX} ${0}` }} transition={{ duration: 0.5, ease: 'easeInOut' }} stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" />
        <motion.path initial={false} animate={{ d: `M ${0} ${minY} L ${0} ${maxY}` }} transition={{ duration: 0.5, ease: 'easeInOut' }} stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" />

        <polyline points={camPoints} fill="none" stroke="#10b981" strokeWidth="0.08" strokeLinejoin="round" />
        <circle cx={cx} cy={cy} r={r} fill="#8b5cf6" fillOpacity={details ? 0.3 : 0.1} stroke="#8b5cf6" strokeWidth="0.08" opacity={0.8} />

        {details && (
          <g>
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

            <line x1={r} y1={minY + 0.5} x2={flatCamX} y2={minY + 0.5} stroke="#f59e0b" strokeWidth="0.03" />
            <line x1={r} y1={minY + 0.3} x2={r} y2={minY + 0.7} stroke="#f59e0b" strokeWidth="0.05" />
            <line x1={flatCamX} y1={minY + 0.3} x2={flatCamX} y2={minY + 0.7} stroke="#f59e0b" strokeWidth="0.05" />
            <g transform="scale(1,-1)">
              <text x={flatCamX + 0.3} y={-(minY + 0.5)} fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="middle">Def. Dist {params.default_distance.toFixed(3)}mm</text>
              <text x={flatCamX + 0.3} y={-(minY + 0.85)} fill="#60a5fa" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="middle">K {params.K.toFixed(3)}</text>
            </g>

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
          <h3 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide min-w-0 flex-1 truncate">Vertical System</h3>
          <button type="button" onClick={() => setDetails(!details)}
            className={`shrink-0 px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white shadow-blue-500/20' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}>
            {details ? 'Hide Details' : 'Details'}
          </button>
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

// ─── ConfigModal ─────────────────────────────────────────────────

export function ConfigModal({
  isOpen, onClose, configs, onHoverConfig, onSelectConfig, onOpenConfig, onDeleteConfig, onSetDefault,
  selectedConfig, defaultConfig, previewParams, previewData, onApply,
}: {
  isOpen: boolean; onClose: () => void; configs: SavedConfigEntry[];
  onHoverConfig: (name: string) => void; onSelectConfig: (name: string) => void;
  onOpenConfig: (name: string) => void; onDeleteConfig: (name: string, e: React.MouseEvent) => void;
  onSetDefault: (name: string) => void; selectedConfig: string | null; defaultConfig: string | null;
  previewParams: SimulationParams | null; previewData: SimulationResult | null; onApply: () => void;
}) {
  const previewStats = useMemo(() => {
    if (!previewData) return null;
    const staticFlowAtHalfMm = (() => {
      const ys = previewData.Y_positions;
      const vals = previewData.flow_l_min;
      const len = ys.length;
      if (!len || len !== vals.length) return null;
      if (len === 1) return vals[0];
      for (let i = 0; i < len - 1; i++) {
        const a = ys[i];
        const b = ys[i + 1];
        if (a === b) continue;
        if ((0.5 - a) * (0.5 - b) <= 0) {
          const t = (0.5 - a) / (b - a);
          return vals[i] + t * (vals[i + 1] - vals[i]);
        }
      }
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < len; i++) {
        const d = Math.abs(ys[i] - 0.5);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return vals[best];
    })();
    const maxStaticFlow = previewData.flow_l_min.length ? Math.max(...previewData.flow_l_min) : 0;
    const hasDynamic = previewData.dynamic_flow_l_min.length > 0;
    const maxDynamicFlow = hasDynamic ? Math.max(...previewData.dynamic_flow_l_min) : null;
    return {
      gapAtY0: previewData.gap_at_Y0,
      staticFlowAtHalfMm,
      maxStaticFlow,
      maxDynamicFlow,
      totalVolume: previewData.total_volume_ml,
      equalization: previewData.equalization_time_ms,
    };
  }, [previewData]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-4xl h-[70vh] flex overflow-hidden">
        <div className="w-64 shrink-0 min-w-0 border-r border-neutral-800 flex flex-col bg-neutral-900/50">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-center min-w-0">
            <h3 className="text-sm font-bold text-white uppercase tracking-tighter truncate">Configurations</h3>
            <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors shrink-0"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-2 space-y-1">
            {configs.map(({ filename, note }) => (
              <div key={filename} className="group relative flex items-start min-w-0 max-w-full">
                <button type="button" onMouseEnter={() => onHoverConfig(filename)} onClick={() => onSelectConfig(filename)}
                  onDoubleClick={() => onOpenConfig(filename)} title={`${filename} — double-click to open`}
                  className={`min-w-0 w-full max-w-full text-left px-3 py-2 rounded-lg text-xs transition-all pr-10 ${selectedConfig === filename ? 'bg-blue-600 text-white font-bold' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}>
                  <div className="flex items-start justify-between gap-2 w-full min-w-0">
                    <span className="font-mono break-all [overflow-wrap:anywhere] text-left leading-snug">{filename}</span>
                    {defaultConfig === filename && (
                      <div className="flex items-center gap-1 bg-emerald-500 text-white px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-tighter shadow-sm shrink-0 mt-0.5">
                        <div className="w-1 h-1 rounded-full bg-white animate-pulse" /> DEFAULT
                      </div>
                    )}
                  </div>
                  {note.trim() ? (
                    <p className={`mt-1 text-[10px] leading-snug line-clamp-2 font-normal break-words [overflow-wrap:anywhere] ${selectedConfig === filename ? 'text-blue-100/90' : 'text-neutral-500 group-hover:text-neutral-400'}`}>{note.trim()}</p>
                  ) : null}
                </button>
                <button onClick={(e) => onDeleteConfig(filename, e)}
                  className="absolute right-2 top-2 p-1.5 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all" title="Delete Config">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="p-4 border-t border-neutral-800">
            <button disabled={!selectedConfig} onClick={onApply}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold transition-all shadow-lg">
              OPEN CONFIG
            </button>
          </div>
        </div>
        <div className="flex-1 bg-neutral-950 flex flex-col">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/40">
            <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Configuration Preview</h4>
            {selectedConfig && (
              <button onClick={() => onSetDefault(selectedConfig)} disabled={defaultConfig === selectedConfig}
                className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${defaultConfig === selectedConfig ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 opacity-50' : 'bg-blue-600/10 border-blue-500/30 text-blue-400 hover:bg-blue-600/20'}`}>
                {defaultConfig === selectedConfig ? 'IS DEFAULT' : 'DEFINE AS DEFAULT'}
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 flex">
            {previewParams ? (
              <>
                <div className="w-1/3 min-w-[230px] max-w-[340px] border-r border-neutral-800 bg-neutral-900/65 p-4 overflow-y-auto space-y-4">
                  {previewParams.note.trim() ? (
                    <div>
                      <div className="text-[10px] text-neutral-500 uppercase font-bold mb-1">Note</div>
                      <p className="text-xs text-neutral-200 leading-relaxed whitespace-pre-wrap break-words">{previewParams.note.trim()}</p>
                    </div>
                  ) : null}

                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase font-bold mb-2">Simulation Inputs</div>
                    <div className="grid grid-cols-1 gap-2">
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Motor speed</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.motor_speed.toFixed(1)} RPM</span></div>
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Thickness</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.thickness.toFixed(3)} mm</span></div>
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Tube</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.tube_id.toFixed(2)} x {previewParams.tube_od.toFixed(2)} mm</span></div>
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Pressure</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.input_pressure_psi.toFixed(1)} PSI</span></div>
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Compliance</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.compliance.toFixed(3)} mm/MPa</span></div>
                      <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Chamber vol.</span><span className="text-[11px] font-mono text-neutral-200">{previewParams.chamber_volume_ml.toFixed(2)} mL</span></div>
                    </div>
                  </div>

                  {previewStats && (
                    <div>
                      <div className="text-[10px] text-neutral-500 uppercase font-bold mb-2">Dynamic Stats</div>
                      <div className="grid grid-cols-1 gap-2">
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">gap @ Y=0</span><span className="text-[11px] font-mono text-cyan-300">{previewStats.gapAtY0.toFixed(4)} mm</span></div>
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Static flow @ Y=0.5</span><span className="text-[11px] font-mono text-amber-300">{previewStats.staticFlowAtHalfMm !== null ? `${previewStats.staticFlowAtHalfMm.toFixed(3)} L/min` : 'N/A'}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Max flow (static)</span><span className="text-[11px] font-mono text-amber-300">{previewStats.maxStaticFlow.toFixed(3)} L/min</span></div>
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Max flow (dynamic)</span><span className="text-[11px] font-mono text-amber-300">{previewStats.maxDynamicFlow !== null ? `${previewStats.maxDynamicFlow.toFixed(3)} L/min` : 'N/A'}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Total volume</span><span className="text-[11px] font-mono text-amber-300">{previewStats.totalVolume.toFixed(2)} mL</span></div>
                        <div className="flex justify-between gap-4"><span className="text-[11px] text-neutral-400">Equalization</span><span className="text-[11px] font-mono text-amber-300">{previewStats.equalization >= 0 ? `${previewStats.equalization.toFixed(1)} ms` : 'N/A'}</span></div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="w-2/3 min-w-0 p-6 flex items-center justify-center overflow-hidden">
                  <div className="w-full h-full flex flex-col items-center justify-center">
                    <VerticalSystemView data={previewData} params={previewParams} details={true} setDetails={() => {}} isPreview={true} />
                  </div>
                </div>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-neutral-600 text-sm font-medium animate-pulse">Hover a config to preview...</div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
