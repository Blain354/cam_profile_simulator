import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@blain-projects/ui';
import { Download, Film, Loader2, Pause, Play, Redo2, Undo2 } from 'lucide-react';
import { FlowParticles, FlowParticlesSwitch } from '../FlowParticles';
import { useFlowParticlesOn } from '../lib/flowParticles';
import { sideBore, tubeProfile } from '../lib/tubeSide';
import type { TubeSweep } from '../lib/tubeSweep';
import { buildMechanismGif } from './mechanismGif';
import {
  LOAD_FACTOR, MEMBERS, MOTOR_RPM, activeStallY, anchorPoint, anchorSymmetricRange, bezier, deflected,
  deflectedPoint, effectivePinchY, interp, interpNullable, isCarriageStalled,
  leftNormal, nearestToWall, physicalCarriageY, pinchContactX, strokeOutlinePath,
} from './types';
import type {
  CompliantParams, CompliantResult, HoveredBoundTarget, Member, Pt, QuadrantKey, QuadrantMap,
  ShapeKey, SolverConstraints,
} from './types';

/** Same side-view tube as the pendulum: the foot is a round pin, the silicone climbs back to its diameter beside it. */
function pinchedTube({
  sign, name, contact, rPin, wall, od, id, top, flow, maxFlow, sweep, stale,
}: {
  sign: 1 | -1; name: string; contact: Pt; rPin: number; wall: number; od: number; id: number;
  top: number; flow: number; maxFlow: number; sweep: TubeSweep | null; stale: boolean;
}) {
  const frac = maxFlow > 0 ? Math.min(Math.max(flow, 0) / maxFlow, 1) : 0;
  const fromWall = wall - sign * contact[0];
  const ends: [Pt, Pt] = [[fromWall, contact[1]], [fromWall, contact[1]]];
  const profile = tubeProfile(ends, rPin, od, -1, top + 1, sweep ? od : undefined);
  const bore = sideBore(profile, od, id, sweep);
  const xy = (u: number, v: number) => `${(sign * (wall - u)).toFixed(3)},${(-v).toFixed(3)}`;
  const ring = (inner: number[], outer: number[]) =>
    [...profile.map(([, v], i) => xy(outer[i], v)), ...profile.map(([, v], i) => xy(inner[i], v)).reverse()].join(' ');
  const cx = sign * (wall - od / 2);
  return (
    <g>
      {sweep && (
        <title>{`Tube ${name.trim()[0]}, side view: the wall follows the foot, and the open bore at each station is the FEM section's at the local foot-to-wall distance, so it shuts before the wall stops moving. The shoulders on each side of the foot (about one OD) are schematic.${stale ? ' The previous tube, shown while the new one solves.' : ''}`}</title>
      )}
      <polygon points={ring(profile.map(() => 0), profile.map(([h]) => h))} fill="var(--bui-text)" fillOpacity={0.16} stroke="var(--bui-text)" strokeWidth={0.05} strokeLinejoin="round" />
      <polygon points={ring(bore.map((b) => b[1]), bore.map((b) => b[2]))} fill={frac > 0 ? '#10b981' : '#ef4444'} fillOpacity={0.25 + 0.45 * frac} />
      <FlowParticles
        view="side"
        frac={frac}
        bore={bore}
        direction={sign < 0 ? -1 : 1}
        radius={Math.min(0.16, id / 6)}
        color="var(--bui-text)"
        transform={`matrix(${-sign} 0 0 -1 ${sign * wall} 0)`}
      />
      <line x1={cx} y1={-top - 1} x2={cx} y2={1} stroke="var(--bui-text)" strokeOpacity={0.5} strokeWidth={0.04} strokeDasharray="0.5 0.12 0.1 0.12" />
      <text
        x={cx}
        y={-(top + 1.1)}
        fill="var(--bui-text)"
        fontSize={0.62}
        fontWeight="bold"
        textAnchor="middle"
        stroke="var(--bui-surface)"
        strokeWidth={0.18}
        paintOrder="stroke"
      >
        {name}
      </text>
    </g>
  );
}

export function CompliantSchematic({
  params,
  result,
  constraints,
  bounds,
  quadrantMap,
  hoveredBound,
  yPose,
  playing,
  loadedRpm,
  carriageSpeed,
  tubeSweep,
  tubeStale,
  error,
  onYChange,
  onTogglePlay,
  onCenter,
  onSetShape,
  onPatchParams,
  onDragStart,
  onDragEnd,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: {
  params: CompliantParams;
  result: CompliantResult | null;
  constraints: SolverConstraints;
  bounds?: Record<ShapeKey, [number, number]>;
  quadrantMap?: QuadrantMap;
  hoveredBound?: HoveredBoundTarget;
  yPose: number;
  playing: boolean;
  loadedRpm: number;
  carriageSpeed: number;
  tubeSweep: TubeSweep | null;
  tubeStale: boolean;
  error: string | null;
  onYChange: (y: number) => void;
  onTogglePlay: () => void;
  onCenter: () => void;
  onSetShape: (key: ShapeKey, value: number) => void;
  onPatchParams: (patch: Partial<CompliantParams>) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gifPopoverRef = useRef<HTMLDivElement>(null);
  const filterUid = useId().replace(/:/g, '');
  const backdropBlurId = `compliant-backdrop-blur-${filterUid}`;
  const carriageClipId = `compliant-carriage-clip-${filterUid}`;
  const primaryMaskId = `compliant-primary-mask-${filterUid}`;
  const [showNodes, setShowNodes] = useState(true);
  const [details, setDetails] = useState(true);
  const [gifMenuOpen, setGifMenuOpen] = useState(false);
  const [gifIncludeDetails, setGifIncludeDetails] = useState(true);
  const [gifExporting, setGifExporting] = useState(false);
  const [gifPct, setGifPct] = useState(0);
  const [gifError, setGifError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const flowParticlesOn = useFlowParticlesOn();
  const drag = useRef<
    null | { kind: 'anchor' } | { kind: 'junction' } | { kind: 'pinch' } | { kind: 'handle'; member: Member; index: 0 | 1 }
  >(null);

  useEffect(() => {
    if (!gifMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (gifPopoverRef.current && !gifPopoverRef.current.contains(e.target as Node)) {
        setGifMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGifMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [gifMenuOpen]);

  const handleToggleGifMenu = () => {
    setGifMenuOpen((wasOpen) => {
      if (!wasOpen) {
        setGifIncludeDetails(details);
        setGifError(null);
      }
      return !wasOpen;
    });
  };

  const handleExportMechanismGif = async () => {
    if (!result?.lines?.l || gifExporting) return;
    setGifExporting(true);
    setGifPct(2);
    setGifError(null);
    try {
      const blob = await buildMechanismGif({
        params,
        result,
        constraints,
        tubeSweep,
        carriageSpeed,
        includeDetails: gifIncludeDetails,
        includeParticles: flowParticlesOn,
        onProgress: setGifPct,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = gifIncludeDetails ? 'compliant-mechanism-details.gif' : 'compliant-mechanism.gif';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setGifMenuOpen(false);
    } catch (err) {
      setGifError(err instanceof Error ? err.message : 'Could not encode GIF.');
    } finally {
      setGifExporting(false);
    }
  };

  const hasSolvedLines = Boolean(result?.lines?.l && result?.lines?.r && result?.lines?.f);
  const anchor: Pt = anchorPoint(params);
  const junction: Pt = [params.junction_x, params.junction_y];
  const pivot: Pt = [params.pivot_inverted ? -params.pivot_offset : params.pivot_offset, params.closed_carriage_height];
  const wall = result?.wall_x && result.wall_x > 0 ? result.wall_x : params.tube_center_x + params.tube_od / 2;
  const h0 = result?.pivot_height_y0 && result.pivot_height_y0 > 0 ? result.pivot_height_y0 : params.closed_carriage_height;
  const ceiling = 2 * h0;
  const pinchContactXPos = params.tube_model === 'fem' && tubeSweep?.h_sealed != null
    ? pinchContactX(params, tubeSweep)
    : (hasSolvedLines && result?.pinch_contact_x != null ? result.pinch_contact_x : pinchContactX(params, tubeSweep));
  const pinch: Pt = [pinchContactXPos + params.f_thickness / 2, effectivePinchY(params, constraints)];
  const stallY = activeStallY(result, constraints, params.stroke);
  const stalled = isCarriageStalled(yPose, stallY);
  const yActual = physicalCarriageY(yPose, stallY);
  const force = hasSolvedLines && result ? interp(yActual, result.Y_positions, result.force_a) : 0;
  const atRestPose = Math.abs(yActual) < 1e-9;
  const useLiveRest = !hasSolvedLines || isDragging || atRestPose;

  const restLines = useMemo(() => ({
    l: bezier(anchor, junction, params.l_u1, params.l_v1, params.l_u2, params.l_v2),
    r: bezier(junction, pivot, params.r_u1, params.r_v1, params.r_u2, params.r_v2),
    f: bezier(junction, pinch, params.f_u1, params.f_v1, params.f_u2, params.f_v2),
  }), [anchor[0], anchor[1], junction[0], junction[1], pivot[0], pivot[1], pinch[0], pinch[1], params]);

  const lines = useMemo(() => {
    if (useLiveRest || !result?.lines) return restLines;
    return {
      l: deflected(result.lines.l, yActual, force),
      r: deflected(result.lines.r, yActual, force),
      f: deflected(result.lines.f, yActual, force),
    };
  }, [result, yActual, force, restLines, useLiveRest]);

  const chords: Record<Member, [Pt, Pt]> = { l: [anchor, junction], r: [junction, pivot], f: [junction, pinch] };
  const handleOf = (member: Member, index: 0 | 1): Pt => {
    const [s, e] = chords[member];
    const { n } = leftNormal(s, e);
    const u = params[`${member}_u${index + 1}` as ShapeKey] as number;
    const v = params[`${member}_v${index + 1}` as ShapeKey] as number;
    return [s[0] + u * (e[0] - s[0]) + v * n[0], s[1] + u * (e[1] - s[1]) + v * n[1]];
  };

  const toWorld = (event: React.PointerEvent): Pt | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, -p.y];
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const what = drag.current;
    if (!what) return;
    const p = toWorld(event);
    if (!p) return;
    if (what.kind === 'anchor') onSetShape('anchor_distance', Math.min(12, Math.max(-12, -p[0])));
    else if (what.kind === 'junction') onPatchParams({ junction_x: p[0], junction_y: Math.max(1, p[1]) });
    else if (what.kind === 'pinch') onSetShape('pinch_y', Math.max(0.5, p[1]));
    else {
      const [s, e] = chords[what.member];
      const { n, length } = leftNormal(s, e);
      if (length < 1e-6) return;
      const dx = e[0] - s[0], dy = e[1] - s[1];
      const u = Math.min(0.95, Math.max(0.05, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (length * length)));
      const v = (p[0] - s[0]) * n[0] + (p[1] - s[1]) * n[1];
      onPatchParams({ [`${what.member}_u${what.index + 1}`]: u, [`${what.member}_v${what.index + 1}`]: v } as Partial<CompliantParams>);
    }
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setIsDragging(false);
    onDragEnd?.();
  };

  const margin = 2;
  const poly = (pts: Pt[]) => pts.map(([x, yy]) => `${x.toFixed(3)},${(-yy).toFixed(3)}`).join(' ');
  const dot = (p: Pt, color: string, kind: 'anchor' | 'junction' | 'pinch', label: string) => (
    <g
      data-drag-node={kind}
      className="cursor-grab touch-none"
      onPointerDown={(e) => {
        drag.current = { kind };
        setIsDragging(true);
        onDragStart?.();
        svgRef.current?.setPointerCapture?.(e.pointerId);
      }}
    >
      <circle cx={p[0]} cy={-p[1]} r={1.05} fill="transparent" />
      <circle cx={p[0]} cy={-p[1]} r={0.45} fill="var(--bui-surface)" stroke={color} strokeWidth={0.12} />
      <text x={p[0] + 0.5} y={-p[1] - 0.45} fill={color} fontSize={0.55} fontWeight="bold">{label}</text>
    </g>
  );

  const carriageY = h0 + (result?.travel_sign ?? 1) * yActual;
  const hw = params.pivot_offset + 1;
  const carriagePoly = [
    [-hw, carriageY + 0.9], [-hw + 0.9, carriageY + 1.5], [hw - 0.9, carriageY + 1.5], [hw, carriageY + 0.9],
    [hw, carriageY - 0.9], [hw - 0.9, carriageY - 1.5], [-hw + 0.9, carriageY - 1.5], [-hw, carriageY - 0.9],
  ].map(([px, py]) => `${px},${-py}`).join(' ');
  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, yy]) => [-x, ceiling - yy]);
  const mirroredLines: Record<Member, Pt[]> = {
    l: !useLiveRest && result ? mirror(deflected(result.lines.l, -yActual, interp(-yActual, result.Y_positions, result.force_a))) : mirror(lines.l),
    r: !useLiveRest && result ? mirror(deflected(result.lines.r, -yActual, interp(-yActual, result.Y_positions, result.force_a))) : mirror(lines.r),
    f: !useLiveRest && result ? mirror(deflected(result.lines.f, -yActual, interp(-yActual, result.Y_positions, result.force_a))) : mirror(lines.f),
  };
  const mirroredOutlines: Record<Member, Pt[]> = {
    l: strokeOutlinePath(mirroredLines.l, params.l_thickness),
    r: strokeOutlinePath(mirroredLines.r, params.r_thickness),
    f: strokeOutlinePath(mirroredLines.f, params.f_thickness),
  };
  const renderMirroredMinimal = (outlineOpacity: number, skeletonOpacity: number) => (
    <>
      <g opacity={skeletonOpacity}>
        {MEMBERS.map((member) => (
          <polyline
            key={`${member.id}-skel`}
            points={poly(mirroredLines[member.id])}
            fill="none"
            stroke={member.color}
            strokeWidth={0.08}
            strokeDasharray="0.34 0.34"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
      <g opacity={outlineOpacity}>
        {MEMBERS.map((member) => {
          const outline = mirroredOutlines[member.id];
          if (outline.length < 3) return null;
          return (
            <polygon
              key={`${member.id}-out`}
              points={poly(outline)}
              fill="none"
              stroke={member.color}
              strokeWidth={0.1}
              strokeDasharray="0.38 0.28"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </g>
    </>
  );

  const footB = !useLiveRest && result
    ? mirror(deflected(result.lines.f, -yActual, interp(-yActual, result.Y_positions, result.force_a)))
    : mirror(lines.f);
  const contactA = nearestToWall(lines.f, -1);
  const contactB = nearestToWall(footB, 1);
  const gapA = result ? interpNullable(yActual, result.Y_positions, result.gap_a) : null;
  const gapB = result
    ? interpNullable(yActual, result.Y_positions, result.gap_b) ?? interpNullable(-yActual, result.Y_positions, result.gap_a)
    : null;
  const forceA = result ? interpNullable(yActual, result.Y_positions, result.force_a) : null;
  const forceB = result
    ? interpNullable(yActual, result.Y_positions, result.force_b) ?? interpNullable(-yActual, result.Y_positions, result.force_a)
    : null;
  const newtons = (f: number | null) => (f == null ? '' : `, ${f.toFixed(f < 10 ? 2 : 1)} N`);
  const overlayLabel = (x: number, yy: number, text: string, color: string, textAnchor: 'start' | 'middle' | 'end' = 'middle') => (
    <text
      x={x}
      y={-yy}
      fill={color}
      fontSize={0.62}
      fontWeight="bold"
      textAnchor={textAnchor}
      dominantBaseline="middle"
      stroke="var(--bui-surface)"
      strokeWidth={0.18}
      paintOrder="stroke"
    >
      {text}
    </text>
  );

  return (
    <div data-pane="schematic" className="lg:col-span-4 min-w-0 bg-neutral-800 p-3 sm:p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 mb-3 shrink-0 min-w-0">
        <h3 className="text-sm font-semibold text-neutral-300 min-w-0 flex-1 truncate">Schematic</h3>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {onUndo && (
            <Button
              variant="ghost"
              type="button"
              disabled={!canUndo}
              onClick={onUndo}
              aria-label="Undo node edit"
              title="Undo node or handle edit (Ctrl+Z)"
              className="shrink-0 p-1.5 rounded-md transition-colors border shadow-sm bg-neutral-800 border-neutral-600 text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </Button>
          )}
          {onRedo && (
            <Button
              variant="ghost"
              type="button"
              disabled={!canRedo}
              onClick={onRedo}
              aria-label="Redo node edit"
              title="Redo node or handle edit (Ctrl+Shift+Z)"
              className="shrink-0 p-1.5 rounded-md transition-colors border shadow-sm bg-neutral-800 border-neutral-600 text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            type="button"
            aria-pressed={details}
            onClick={() => setDetails((v) => !v)}
            className={`shrink-0 px-2.5 sm:px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}
          >
            {details ? 'Hide details' : 'Details'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            aria-pressed={showNodes}
            onClick={() => setShowNodes((v) => !v)}
            className={`shrink-0 px-2.5 sm:px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${showNodes ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}
          >
            Spline nodes
          </Button>
          <div className="relative shrink-0" ref={gifPopoverRef}>
            <Button
              variant="ghost"
              type="button"
              disabled={!result?.lines}
              aria-expanded={gifMenuOpen}
              aria-haspopup="dialog"
              onClick={handleToggleGifMenu}
              title="Export a looping GIF of the running mechanism (without spline nodes)"
              className={`inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70 disabled:opacity-40 ${gifMenuOpen ? 'border-amber-500/70 bg-amber-500/20 text-amber-200' : 'bg-neutral-800 border-neutral-600 text-neutral-300 hover:border-amber-500/50 hover:text-amber-200'}`}
            >
              {gifExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
              GIF
            </Button>
            {gifMenuOpen && (
              <div
                role="dialog"
                aria-label="Export mechanism GIF"
                className="absolute right-0 top-full mt-1.5 z-30 w-[min(15rem,calc(100vw-2.5rem))] rounded-xl border border-neutral-700 bg-neutral-900 p-3 shadow-xl space-y-2.5"
              >
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-neutral-100">Mechanism GIF</div>
                  <p className="text-[11px] text-neutral-400 leading-snug">
                    Real-time loop ({carriageSpeed.toFixed(2)} mm/s). Spline nodes are never included.
                  </p>
                </div>
                <label className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-950/70 px-2.5 py-2 cursor-pointer select-none">
                  <span className="text-xs text-neutral-200">Include details</span>
                  <input
                    type="checkbox"
                    checked={gifIncludeDetails}
                    onChange={(e) => setGifIncludeDetails(e.target.checked)}
                    className="h-3.5 w-3.5 rounded accent-amber-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
                  />
                </label>
                <button
                  type="button"
                  disabled={gifExporting || !result?.lines}
                  onClick={handleExportMechanismGif}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-500/60 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
                >
                  {gifExporting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Encoding… {gifPct}%
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      Download GIF
                    </>
                  )}
                </button>
                {gifError && (
                  <p className="text-[11px] text-rose-300" role="alert">
                    {gifError}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mb-3 flex shrink-0 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            <label htmlFor="compliant-y" className="font-medium text-neutral-300">Carriage Y</label>
            {stalled && stallY != null && (
              <span
                role="status"
                title={`Motor reached max torque (${params.motor_torque_mnm.toFixed(0)} mN·m); carriage held at ${yActual >= 0 ? '+' : ''}${yActual.toFixed(2)} mm while cursor is in stall zone`}
                className="rounded border border-red-500/45 bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300"
              >
                Motor stalled · held at {yActual >= 0 ? '+' : ''}{yActual.toFixed(2)} mm
              </span>
            )}
          </div>
          {result != null && result.travel_sign < 0 && (
            <span className="text-[10px] text-neutral-400" title="Y is the travel that opens tube A, here and in the chart. This part pulls, so its carriage moves the other way from a part that pushes for the same Y: the motor turns the other way.">
              link pulls: carriage runs the other way
            </span>
          )}
          <span className={`font-mono ${stalled ? 'text-red-300 font-semibold' : 'text-neutral-100'}`}>{yPose.toFixed(2)} mm</span>
        </div>
        <div className="order-last flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="ghost"
            type="button"
            onClick={onTogglePlay}
            disabled={carriageSpeed <= 0}
            aria-pressed={playing}
            title="Run the carriage back and forth over the full stroke at the loaded motor speed"
            className={`flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold disabled:opacity-50 ${playing ? 'border-amber-500 bg-amber-600 text-white' : 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'}`}
          >
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} {playing ? 'Stop' : 'Oscillate'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={onCenter}
            disabled={!playing && yPose === 0}
            title="Bring the carriage back to Y = 0"
            className="shrink-0 whitespace-nowrap rounded-lg border border-neutral-700 px-3 py-1 text-xs font-bold text-neutral-200 hover:bg-neutral-700/40 disabled:opacity-50"
          >
            Center
          </Button>
          <FlowParticlesSwitch note="Full density and speed at the flow through the full bore. The chamber is not drawn: it is taken as below the drawing, so the air runs down tube A (supply) and up tube B (exhaust)." />
          <span className="w-full sm:w-auto sm:ml-auto text-left sm:text-right text-xs text-neutral-400">
            {loadedRpm.toFixed(0)} RPM under load ({MOTOR_RPM} × {Math.round(LOAD_FACTOR * 100)} %), {carriageSpeed.toFixed(2)} mm/s
          </span>
        </div>
        <input
          id="compliant-y"
          type="range"
          min={-params.stroke}
          max={params.stroke}
          step={0.01}
          value={yPose}
          onChange={(e) => onYChange(parseFloat(e.target.value))}
          className={`w-full cursor-pointer ${stalled ? 'accent-red-500' : 'accent-amber-500'}`}
        />
      </div>

      <div className="min-h-[240px] lg:min-h-[180px] w-full flex-1 overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-900/60">
        <svg
          ref={svgRef}
          viewBox={`${-(wall + margin)} ${-ceiling - margin} ${2 * (wall + margin)} ${ceiling + 2 * margin}`}
          className="h-full w-full select-none touch-pan-y"
          role="img"
          aria-label="Compliant bars"
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
        >
          <defs>
            {/* True frosted-glass backdrop blur (~2.6px screen blur) clipped strictly inside upper layers */}
            <filter
              id={backdropBlurId}
              filterUnits="userSpaceOnUse"
              x={-(wall + margin)}
              y={-ceiling - margin}
              width={2 * (wall + margin)}
              height={ceiling + 2 * margin}
            >
              <feGaussianBlur stdDeviation={0.12} />
            </filter>
            <clipPath id={carriageClipId}>
              <polygon points={carriagePoly} />
            </clipPath>
            <mask
              id={primaryMaskId}
              maskUnits="userSpaceOnUse"
              x={-(wall + margin)}
              y={-ceiling - margin}
              width={2 * (wall + margin)}
              height={ceiling + 2 * margin}
            >
              {MEMBERS.map((member) => (
                <polyline
                  key={member.id}
                  points={poly(lines[member.id])}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={params[`${member.id}_thickness`]}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </mask>
          </defs>
          <rect x={-wall} y={-ceiling} width={2 * wall} height={ceiling} fill="var(--bui-muted)" fillOpacity={0.08} stroke="var(--bui-text)" strokeWidth={0.14} />
          {[-1, 1].map((side) => (
            <rect key={side} x={side < 0 ? -wall - 0.7 : wall} y={-ceiling - 1} width={0.7} height={ceiling + 2} fill="var(--bui-text)" fillOpacity={0.35} />
          ))}
          {constraints.pinch_ceiling_margin_mm > 0 && constraints.pinch_ceiling_margin_mm < ceiling && (
            <g opacity={0.55}>
              <rect
                x={-wall}
                y={-ceiling}
                width={params.tube_od + 1.2}
                height={constraints.pinch_ceiling_margin_mm}
                fill="#f59e0b"
                fillOpacity={0.14}
              />
              <line
                x1={-wall}
                y1={-(ceiling - constraints.pinch_ceiling_margin_mm)}
                x2={-wall + params.tube_od + 1.2}
                y2={-(ceiling - constraints.pinch_ceiling_margin_mm)}
                stroke="#f59e0b"
                strokeWidth={0.07}
                strokeDasharray="0.25 0.2"
              />
            </g>
          )}
          {constraints.pinch_floor_margin_mm > 0 && constraints.pinch_floor_margin_mm < ceiling && (
            <g opacity={0.55}>
              <rect
                x={-wall}
                y={-constraints.pinch_floor_margin_mm}
                width={params.tube_od + 1.2}
                height={constraints.pinch_floor_margin_mm}
                fill="#f59e0b"
                fillOpacity={0.14}
              />
              <line
                x1={-wall}
                y1={-constraints.pinch_floor_margin_mm}
                x2={-wall + params.tube_od + 1.2}
                y2={-constraints.pinch_floor_margin_mm}
                stroke="#f59e0b"
                strokeWidth={0.07}
                strokeDasharray="0.25 0.2"
              />
            </g>
          )}
          {(() => {
            const rPin = Math.max(params.f_thickness / 2, 0.18);
            const maxFlow = result ? Math.max(0, ...result.flow_a.map((f) => f ?? 0)) : 0;
            const tubeArgs = { rPin, wall, od: params.tube_od, id: params.tube_id, top: ceiling, maxFlow, sweep: tubeSweep, stale: tubeStale };
            return (
              <>
                {pinchedTube({ ...tubeArgs, sign: -1, name: 'A  supply', contact: contactA, flow: result ? interp(yActual, result.Y_positions, result.flow_a) : 0 })}
                {pinchedTube({ ...tubeArgs, sign: 1, name: 'B  exhaust', contact: contactB, flow: result ? interp(-yActual, result.Y_positions, result.flow_a) : 0 })}
              </>
            );
          })()}
          {/* Back plane: minimal vertical lead-screw axis + dashed hollow outline & ultra-faint dashed skeleton of opposite copy */}
          <line
            x1={0}
            y1={-ceiling - 0.6}
            x2={0}
            y2={0.6}
            stroke="var(--bui-text)"
            strokeOpacity={0.28}
            strokeWidth={0.07}
            strokeDasharray="0.55 0.25 0.12 0.25"
          />
          <g data-layer="mirror-mechanism">
            {renderMirroredMinimal(0.36, 0.12)}
          </g>
          {/* Middle plane: carriage with frosted backdrop blur strictly inside its sharp polygon */}
          <g data-layer="carriage-backdrop" clipPath={`url(#${carriageClipId})`}>
            <g filter={`url(#${backdropBlurId})`}>
              <rect x={-(wall + margin)} y={-ceiling - margin} width={2 * (wall + margin)} height={ceiling + 2 * margin} fill="var(--bui-surface)" />
              <rect x={-wall} y={-ceiling} width={2 * wall} height={ceiling} fill="var(--bui-muted)" fillOpacity={0.08} />
              <line
                x1={0}
                y1={-ceiling - 0.6}
                x2={0}
                y2={0.6}
                stroke="var(--bui-text)"
                strokeOpacity={0.32}
                strokeWidth={0.09}
                strokeDasharray="0.55 0.25 0.12 0.25"
              />
              {renderMirroredMinimal(0.42, 0.14)}
            </g>
          </g>
          <polygon
            data-carriage="main"
            data-stalled={stalled ? 'true' : 'false'}
            data-actual-y={yActual.toFixed(4)}
            points={carriagePoly}
            fill={stalled ? '#ef4444' : 'var(--bui-muted)'}
            fillOpacity={stalled ? 0.48 : 0.42}
            stroke={stalled ? '#f87171' : 'var(--bui-text)'}
            strokeWidth={stalled ? 0.12 : 0.07}
          />
          <line x1={-wall} y1={-h0} x2={wall} y2={-h0} stroke="#60a5fa" strokeWidth={0.04} strokeDasharray="0.2 0.2" />
          {/* Front plane: primary mechanism with frosted backdrop blur strictly inside its sharp strokes */}
          <g data-layer="primary-backdrop" mask={`url(#${primaryMaskId})`}>
            <g filter={`url(#${backdropBlurId})`}>
              <rect x={-(wall + margin)} y={-ceiling - margin} width={2 * (wall + margin)} height={ceiling + 2 * margin} fill="var(--bui-surface)" />
              <rect x={-wall} y={-ceiling} width={2 * wall} height={ceiling} fill="var(--bui-muted)" fillOpacity={0.08} />
              <line
                x1={0}
                y1={-ceiling - 0.6}
                x2={0}
                y2={0.6}
                stroke="var(--bui-text)"
                strokeOpacity={0.32}
                strokeWidth={0.09}
                strokeDasharray="0.55 0.25 0.12 0.25"
              />
              {renderMirroredMinimal(0.42, 0.14)}
              <polygon
                points={carriagePoly}
                fill={stalled ? '#ef4444' : 'var(--bui-muted)'}
                fillOpacity={stalled ? 0.62 : 0.55}
                stroke={stalled ? '#f87171' : 'var(--bui-text)'}
                strokeWidth={stalled ? 0.14 : 0.11}
              />
            </g>
          </g>
          <circle
            data-layer="pivot-zone"
            cx={pivot[0]}
            cy={-carriageY}
            r={Math.max(params.carriage_pin_diameter / 2, 1.0)}
            fill="#60a5fa"
            fillOpacity={0.14}
            stroke="#60a5fa"
            strokeOpacity={0.7}
            strokeWidth={0.12}
            strokeDasharray="0.35 0.25"
          />
          <circle cx={pivot[0]} cy={-carriageY} r={Math.max(params.carriage_pin_diameter / 2, 0.2)} fill="#60a5fa" />
          {MEMBERS.map((member) => (
            <g key={member.id}>
              <polyline points={poly(lines[member.id])} fill="none" stroke={member.color} strokeOpacity={0.4} strokeWidth={params[`${member.id}_thickness`]} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={poly(lines[member.id])} fill="none" stroke={member.color} strokeWidth={0.12} strokeLinecap="round" />
            </g>
          ))}
          {stalled && (
            <g data-layer="stall-indicator" pointerEvents="none">
              <text
                x={0}
                y={-carriageY}
                fill="#fca5a5"
                fontSize={0.58}
                fontWeight="bold"
                textAnchor="middle"
                dominantBaseline="middle"
                stroke="var(--bui-surface)"
                strokeWidth={0.18}
                paintOrder="stroke"
              >
                Stall · max torque
              </text>
            </g>
          )}
          {details && (
            <g data-layer="details-overlay">
              {overlayLabel(-wall + 0.25, h0 + 0.55, `h₀ ${h0.toFixed(2)}`, '#60a5fa', 'start')}
              {gapA != null && overlayLabel(-wall + 0.2, contactA[1] + 1.1, `gap ${gapA.toFixed(3)}${newtons(forceA)}`, 'var(--bui-text)', 'start')}
              {gapB != null && overlayLabel(wall - 0.2, contactB[1] - 1.1, `gap ${gapB.toFixed(3)}${newtons(forceB)}`, 'var(--bui-text)', 'end')}
              {/* Target pinch point P_goal (fixed at Y = 0) + contact surface marker + target attack angle vector */}
              {constraints.target_pinch_from_top_mm != null && (() => {
                const ty = ceiling - constraints.target_pinch_from_top_mm;
                const txContact = pinchContactXPos;
                const txCenter = txContact + params.f_thickness / 2;
                const footR = Math.max(params.f_thickness / 2, 0.18);
                const angRad = ((constraints.target_attack_angle_deg ?? 0) * Math.PI) / 180;
                const len = 2.4;
                const vx = txCenter + len * Math.cos(angRad);
                const vy = ty + len * Math.sin(angRad);
                return (
                  <g data-layer="pinch-target" opacity={0.85} pointerEvents="none">
                    <line x1={-wall} y1={-ty} x2={txCenter + footR + 0.3} y2={-ty} stroke="#34d399" strokeWidth={0.06} strokeDasharray="0.2 0.16" />
                    <circle cx={txCenter} cy={-ty} r={footR} fill="none" stroke="#34d399" strokeWidth={0.09} strokeDasharray="0.16 0.12" />
                    <circle cx={txContact} cy={-ty} r={0.16} fill="#34d399" stroke="var(--bui-surface)" strokeWidth={0.06} />
                    <line x1={txCenter} y1={-ty} x2={vx} y2={-vy} stroke="#f59e0b" strokeWidth={0.11} strokeDasharray="0.22 0.14" />
                    <circle cx={vx} cy={-vy} r={0.16} fill="#f59e0b" />
                  </g>
                );
              })()}
              {/* Actual loaded pinch trajectory P(Y) for Y: 0 -> +stroke */}
              {result?.lines?.f && result.Y_positions.length > 0 && (() => {
                const lf = result.lines.f;
                const tipIdx = lf.x.length - 1;
                if (tipIdx < 0) return null;
                const pts: Pt[] = [];
                const steps = 12;
                for (let k = 0; k <= steps; k++) {
                  const yy = (k / steps) * params.stroke;
                  const ff = interp(yy, result.Y_positions, result.force_a);
                  pts.push(deflectedPoint(lf, tipIdx, yy, ff));
                }
                const pEnd = pts[pts.length - 1];
                return (
                  <g data-layer="pinch-trajectory" pointerEvents="none">
                    <polyline
                      points={poly(pts)}
                      fill="none"
                      stroke="#22d3ee"
                      strokeWidth={0.14}
                      strokeLinecap="round"
                    />
                    <circle cx={pEnd[0]} cy={-pEnd[1]} r={0.22} fill="#22d3ee" />
                    {result.attack_angle_deg != null && overlayLabel(
                      pEnd[0] + 0.35,
                      pEnd[1],
                      `α ${result.attack_angle_deg > 0 ? '+' : ''}${result.attack_angle_deg.toFixed(0)}°`,
                      '#22d3ee',
                      'start',
                    )}
                  </g>
                );
              })()}
              {tubeSweep && (
                <text
                  x={wall - 0.2}
                  y={1.45}
                  fill="var(--bui-text)"
                  fillOpacity={0.7}
                  fontSize={0.36}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  Tubes: FEM bore, schematic shoulders
                </text>
              )}
            </g>
          )}
          {showNodes && (
            <g data-layer="spline-nodes">
              {MEMBERS.flatMap((member) => ([0, 1] as const).map((index) => {
                const h = handleOf(member.id, index);
                const end = index === 0 ? chords[member.id][0] : chords[member.id][1];
                const isHovered = hoveredBound === `${member.id}_${index + 1}`;
                return (
                  <g
                    key={`${member.id}-${index}`}
                    data-drag-node={`handle-${member.id}-${index + 1}`}
                    className="cursor-grab touch-none"
                    onPointerDown={(e) => {
                      drag.current = { kind: 'handle', member: member.id, index };
                      setIsDragging(true);
                      onDragStart?.();
                      svgRef.current?.setPointerCapture?.(e.pointerId);
                    }}
                  >
                    <line x1={end[0]} y1={-end[1]} x2={h[0]} y2={-h[1]} stroke={member.color} strokeOpacity={isHovered ? 1 : 0.7} strokeWidth={isHovered ? 0.14 : 0.06} />
                    <circle cx={h[0]} cy={-h[1]} r={1.05} fill="transparent" />
                    {isHovered && (
                      <circle cx={h[0]} cy={-h[1]} r={0.75} fill={member.color} fillOpacity={0.25} stroke={member.color} strokeWidth={0.12} />
                    )}
                    <circle cx={h[0]} cy={-h[1]} r={isHovered ? 0.44 : 0.32} fill={member.color} />
                  </g>
                );
              }))}
              {dot(anchor, '#f59e0b', 'anchor', 'A')}
              {dot(junction, '#e5e5e5', 'junction', 'J')}
              {dot(pinch, '#34d399', 'pinch', 'P')}
            </g>
          )}
          {/* Hover highlight & search-zone overlay when hovering a Spline Bounds card */}
          {hoveredBound && bounds && (() => {
            if (hoveredBound === 'anchor') {
              if (constraints.anchor_fixed) {
                return (
                  <g data-layer="bound-hover" pointerEvents="none">
                    <circle cx={anchor[0]} cy={-anchor[1]} r={0.85} fill="#f59e0b" fillOpacity={0.2} stroke="#f59e0b" strokeWidth={0.14} />
                  </g>
                );
              }
              const sym = constraints.anchor_symmetric === true;
              if (sym) {
                const [aLo, aHi] = anchorSymmetricRange(bounds.anchor_distance);
                return (
                  <g data-layer="bound-hover" pointerEvents="none">
                    <line x1={-aHi} y1={-anchor[1]} x2={-aLo} y2={-anchor[1]} stroke="#f59e0b" strokeWidth={0.45} strokeOpacity={0.45} strokeLinecap="round" />
                    <line x1={aLo} y1={-anchor[1]} x2={aHi} y2={-anchor[1]} stroke="#f59e0b" strokeWidth={0.45} strokeOpacity={0.45} strokeLinecap="round" />
                    <circle cx={anchor[0]} cy={-anchor[1]} r={0.85} fill="#f59e0b" fillOpacity={0.2} stroke="#f59e0b" strokeWidth={0.14} />
                  </g>
                );
              }
              const x1 = -bounds.anchor_distance[1];
              const x2 = -bounds.anchor_distance[0];
              return (
                <g data-layer="bound-hover" pointerEvents="none">
                  <line x1={x1} y1={-anchor[1]} x2={x2} y2={-anchor[1]} stroke="#f59e0b" strokeWidth={0.45} strokeOpacity={0.45} strokeLinecap="round" />
                  <circle cx={anchor[0]} cy={-anchor[1]} r={0.85} fill="#f59e0b" fillOpacity={0.2} stroke="#f59e0b" strokeWidth={0.14} />
                </g>
              );
            }
            if (hoveredBound === 'pinch') {
              if (constraints.target_pinch_from_top_mm != null) {
                return (
                  <g data-layer="bound-hover" pointerEvents="none">
                    <circle cx={pinch[0]} cy={-pinch[1]} r={Math.max(params.f_thickness / 2 + 0.35, 0.85)} fill="#34d399" fillOpacity={0.2} stroke="#34d399" strokeWidth={0.14} />
                    <circle cx={pinchContactXPos} cy={-pinch[1]} r={0.22} fill="#34d399" stroke="#ffffff" strokeWidth={0.08} />
                    {overlayLabel(pinch[0] + 0.6, pinch[1] + 0.9, 'P locked to P_goal', '#34d399', 'start')}
                  </g>
                );
              }
              const [yLo, yHi] = bounds.pinch_y;
              return (
                <g data-layer="bound-hover" pointerEvents="none">
                  <line x1={pinch[0]} y1={-yLo} x2={pinch[0]} y2={-yHi} stroke="#34d399" strokeWidth={0.45} strokeOpacity={0.45} strokeLinecap="round" />
                  <circle cx={pinch[0]} cy={-pinch[1]} r={0.85} fill="#34d399" fillOpacity={0.2} stroke="#34d399" strokeWidth={0.14} />
                </g>
              );
            }
            if (hoveredBound === 'junction') {
              const [xLo, xHi] = bounds.junction_x;
              const [yLo, yHi] = bounds.junction_y;
              const ex = constraints.junction_exclude_x ?? null;
              const ey = constraints.junction_exclude_y ?? null;
              // Compute forbidden overlay rectangle clipped to the Junction search box
              let forbRect: { x: number; y: number; w: number; h: number } | null = null;
              if (ex && ey) {
                const fx0 = Math.max(xLo, ex[0]), fx1 = Math.min(xHi, ex[1]);
                const fy0 = Math.max(yLo, ey[0]), fy1 = Math.min(yHi, ey[1]);
                if (fx1 > fx0 && fy1 > fy0) forbRect = { x: fx0, y: -fy1, w: fx1 - fx0, h: fy1 - fy0 };
              } else if (ex) {
                const fx0 = Math.max(xLo, ex[0]), fx1 = Math.min(xHi, ex[1]);
                if (fx1 > fx0) forbRect = { x: fx0, y: -yHi, w: fx1 - fx0, h: Math.max(0.05, yHi - yLo) };
              } else if (ey) {
                const fy0 = Math.max(yLo, ey[0]), fy1 = Math.min(yHi, ey[1]);
                if (fy1 > fy0) forbRect = { x: xLo, y: -fy1, w: Math.max(0.05, xHi - xLo), h: fy1 - fy0 };
              }
              return (
                <g data-layer="bound-hover" pointerEvents="none">
                  <rect
                    x={xLo}
                    y={-yHi}
                    width={Math.max(0.05, xHi - xLo)}
                    height={Math.max(0.05, yHi - yLo)}
                    fill="#10b981"
                    fillOpacity={0.14}
                    stroke="#10b981"
                    strokeWidth={0.12}
                    strokeDasharray="0.25 0.18"
                  />
                  {/* Crosshair at absolute mechanism center (0, h0) */}
                  <line x1={xLo} y1={-h0} x2={xHi} y2={-h0} stroke="#e5e5e5" strokeOpacity={0.45} strokeWidth={0.07} strokeDasharray="0.18 0.14" />
                  <line x1={0} y1={-yLo} x2={0} y2={-yHi} stroke="#e5e5e5" strokeOpacity={0.45} strokeWidth={0.07} strokeDasharray="0.18 0.14" />
                  <circle cx={0} cy={-h0} r={0.3} fill="#ffffff" stroke="#10b981" strokeWidth={0.1} />
                  {/* Forbidden zone (carves out / splits the search grid) */}
                  {forbRect && (
                    <>
                      <rect
                        x={forbRect.x}
                        y={forbRect.y}
                        width={forbRect.w}
                        height={forbRect.h}
                        fill="#ef4444"
                        fillOpacity={0.28}
                        stroke="#ef4444"
                        strokeWidth={0.12}
                      />
                      {overlayLabel(forbRect.x + forbRect.w / 2, -(forbRect.y + forbRect.h / 2), 'forbidden', '#fca5a5')}
                    </>
                  )}
                  <circle cx={junction[0]} cy={-junction[1]} r={0.85} fill="#e5e5e5" fillOpacity={0.22} stroke="#ffffff" strokeWidth={0.12} />
                </g>
              );
            }
            if (hoveredBound.endsWith('_thickness')) {
              const mid = hoveredBound[0] as Member;
              const member = MEMBERS.find((m) => m.id === mid);
              if (!member) return null;
              return (
                <g data-layer="bound-hover" pointerEvents="none">
                  <polyline
                    points={poly(lines[mid])}
                    fill="none"
                    stroke={member.color}
                    strokeOpacity={0.55}
                    strokeWidth={params[`${mid}_thickness`] + 0.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            }
            // Handle target: l_1, l_2, r_1, r_2, f_1, f_2 — world-orthogonal quarter-disks centered on the handle's endpoint
            const [midRaw, idxRaw] = hoveredBound.split('_');
            const mid = midRaw as Member;
            const idx = Number(idxRaw) as 1 | 2;
            const member = MEMBERS.find((m) => m.id === mid);
            if (!member || (idx !== 1 && idx !== 2)) return null;
            const [s, e] = chords[mid];
            const center: Pt = idx === 1 ? s : e;
            const cx = center[0];
            const cy = -center[1];
            const qCfg = quadrantMap?.[hoveredBound as QuadrantKey];
            const qs = qCfg?.quadrants ?? [1, 2, 3, 4];
            const r = qCfg?.radius ?? 2.0;
            const sectorPath = (q: 1 | 2 | 3 | 4): string => {
              if (q === 1) return `M ${cx},${cy} L ${cx + r},${cy} A ${r} ${r} 0 0 0 ${cx},${cy - r} Z`;
              if (q === 2) return `M ${cx},${cy} L ${cx},${cy - r} A ${r} ${r} 0 0 0 ${cx - r},${cy} Z`;
              if (q === 3) return `M ${cx},${cy} L ${cx - r},${cy} A ${r} ${r} 0 0 0 ${cx},${cy + r} Z`;
              return `M ${cx},${cy} L ${cx},${cy + r} A ${r} ${r} 0 0 0 ${cx + r},${cy} Z`;
            };
            const hPt = handleOf(mid, (idx - 1) as 0 | 1);
            return (
              <g data-layer="bound-hover" pointerEvents="none">
                {/* Purely world-orthogonal horizontal & vertical crosshair axes centered on endpoint */}
                <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={member.color} strokeOpacity={0.55} strokeWidth={0.07} strokeDasharray="0.18 0.14" />
                <line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke={member.color} strokeOpacity={0.55} strokeWidth={0.07} strokeDasharray="0.18 0.14" />
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={member.color} strokeOpacity={0.28} strokeWidth={0.06} strokeDasharray="0.2 0.2" />
                {qs.map((q) => (
                  <path
                    key={q}
                    d={sectorPath(q)}
                    fill={member.color}
                    fillOpacity={0.24}
                    stroke={member.color}
                    strokeWidth={0.11}
                  />
                ))}
                {/* Highlight endpoint center & current handle */}
                <circle cx={cx} cy={cy} r={0.35} fill="#ffffff" stroke={member.color} strokeWidth={0.12} />
                <circle cx={hPt[0]} cy={-hPt[1]} r={0.75} fill={member.color} fillOpacity={0.25} stroke="#ffffff" strokeWidth={0.12} />
                {overlayLabel(hPt[0], hPt[1] + 0.9, `${member.title.replace('Member ', '')} H${idx}${qs.length === 0 ? ' (pinned)' : ''}`, member.color)}
              </g>
            );
          })()}
        </svg>
      </div>
      {error && <p className="mt-2 shrink-0 text-xs text-red-300" role="alert">{error}</p>}
      {result && !result.passes && <p className="mt-2 shrink-0 text-xs text-amber-300">{result.message}</p>}
    </div>
  );
}
