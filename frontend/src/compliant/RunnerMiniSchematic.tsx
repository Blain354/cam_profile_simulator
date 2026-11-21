import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { FlowParticles } from '../FlowParticles';
import { apiFetch } from '../components';
import { sideBore, tubeProfile } from '../lib/tubeSide';
import type { TubeSweep } from '../lib/tubeSweep';
import {
  LOAD_FACTOR, MOTOR_RPM, SCREW_PITCH_MM, anchorPoint, bezier, deflected, effectivePinchY, interp,
  nearestToWall, pinchContactX, strokeOutlinePath,
} from './types';
import type {
  CompliantParams, CompliantResult, Member, Pt, Runner, SolverConstraints,
} from './types';

const MEMBER_IDS: Member[] = ['l', 'r', 'f'];
const PRIMARY_COLOR = '#f59e0b';
const SECONDARY_COLOR = '#f59e0b';

function miniTube({
  sign, contact, rPin, wall, od, id, top, flow, maxFlow, sweep, showParticles,
}: {
  sign: 1 | -1; contact: Pt; rPin: number; wall: number; od: number; id: number;
  top: number; flow: number; maxFlow: number; sweep: TubeSweep | null; showParticles: boolean;
}) {
  const frac = maxFlow > 0 ? Math.min(Math.max(flow, 0) / maxFlow, 1) : 0;
  const fromWall = wall - sign * contact[0];
  const ends: [Pt, Pt] = [[fromWall, contact[1]], [fromWall, contact[1]]];
  const profile = tubeProfile(ends, rPin, od, -1, top + 1, sweep ? od : undefined);
  const bore = sideBore(profile, od, id, sweep);
  const xy = (u: number, v: number) => `${(sign * (wall - u)).toFixed(3)},${(-v).toFixed(3)}`;
  const ring = (inner: number[], outer: number[]) =>
    [...profile.map(([, v], i) => xy(outer[i], v)), ...profile.map(([, v], i) => xy(inner[i], v)).reverse()].join(' ');

  return (
    <g>
      <polygon
        points={ring(profile.map(() => 0), profile.map(([h]) => h))}
        fill="var(--bui-text)"
        fillOpacity={0.1}
        stroke="var(--bui-text)"
        strokeOpacity={0.28}
        strokeWidth={0.05}
        strokeLinejoin="round"
      />
      <polygon
        points={ring(bore.map((b) => b[1]), bore.map((b) => b[2]))}
        fill={frac > 0 ? '#10b981' : '#ef4444'}
        fillOpacity={0.16 + 0.42 * frac}
      />
      {showParticles && (
        <FlowParticles
          view="side"
          frac={frac}
          bore={bore}
          direction={sign < 0 ? -1 : 1}
          radius={Math.min(0.18, id / 5.5)}
          color="#e5e5e5"
          transform={`matrix(${-sign} 0 0 -1 ${sign * wall} 0)`}
          forceOn={true}
        />
      )}
    </g>
  );
}

/**
 * Compact schematic preview for a solver candidate:
 * - Renders at Y = 0 by default, with the primary mechanism solid in front and
 *   the secondary mirrored mechanism translucent in the back.
 * - Only overlays: attack angle (α) + Play/Pause button (animates with flow particles only).
 */
export function RunnerMiniSchematic({
  runner,
  runnerKey,
  baseParams,
  constraints,
  tubeSweep,
  resultCache,
}: {
  runner: Runner;
  runnerKey: string;
  baseParams: CompliantParams;
  constraints: SolverConstraints;
  tubeSweep: TubeSweep | null;
  resultCache: React.MutableRefObject<Map<string, CompliantResult>>;
}) {
  const params: CompliantParams = useMemo(
    () => ({ ...baseParams, ...runner.params }),
    [baseParams, runner.params],
  );

  const [simResult, setSimResult] = useState<CompliantResult | null>(() => resultCache.current.get(runnerKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [yPose, setYPose] = useState(0);
  const filterUid = useId().replace(/:/g, '');
  const backdropBlurId = `mini-backdrop-blur-${filterUid}`;
  const carriageClipId = `mini-carriage-clip-${filterUid}`;
  const primaryMaskId = `mini-primary-mask-${filterUid}`;
  const motion = useRef({ d: 0, speed: (MOTOR_RPM * LOAD_FACTOR * SCREW_PITCH_MM) / 60, stroke: params.stroke });

  // Reset playback and pick up cached simulation whenever the card displays a different runner.
  useEffect(() => {
    setPlaying(false);
    setYPose(0);
    setLoading(false);
    motion.current.d = 0;
    motion.current.stroke = params.stroke;
    setSimResult(resultCache.current.get(runnerKey) ?? null);
  }, [runnerKey, params.stroke, resultCache]);

  // Triangle-wave oscillation loop matching the main schematic's carriage speed.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    let shown = 0;
    const step = (now: number) => {
      const m = motion.current;
      if (m.speed <= 0 || m.stroke <= 0) {
        setPlaying(false);
        return;
      }
      if (last != null) m.d = (m.d + ((now - last) / 1000) * m.speed) % (4 * m.stroke);
      last = now;
      if (now - shown > 28) {
        shown = now;
        const s = m.stroke;
        setYPose(m.d <= s ? m.d : m.d <= 3 * s ? 2 * s - m.d : m.d - 4 * s);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const handleTogglePlay = async () => {
    if (playing) {
      setPlaying(false);
      setYPose(0);
      motion.current.d = 0;
      return;
    }
    if (simResult) {
      motion.current.d = 0;
      motion.current.stroke = params.stroke;
      setPlaying(true);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/compliant/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, constraints }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.lines) {
        const parsed = data as CompliantResult;
        resultCache.current.set(runnerKey, parsed);
        setSimResult(parsed);
        motion.current.d = 0;
        motion.current.stroke = params.stroke;
        setPlaying(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const anchor: Pt = anchorPoint(params);
  const junction: Pt = [params.junction_x, params.junction_y];
  const pivot: Pt = [params.pivot_inverted ? -params.pivot_offset : params.pivot_offset, params.closed_carriage_height];
  const wall = simResult?.wall_x ?? params.tube_center_x + params.tube_od / 2;
  const h0 = simResult?.pivot_height_y0 ?? params.closed_carriage_height;
  const ceiling = 2 * h0;
  const pinchContactXPos = simResult?.pinch_contact_x ?? pinchContactX(params);
  const pinch: Pt = [pinchContactXPos + params.f_thickness / 2, effectivePinchY(params, constraints)];

  const restLines = useMemo(() => ({
    l: bezier(anchor, junction, params.l_u1, params.l_v1, params.l_u2, params.l_v2),
    r: bezier(junction, pivot, params.r_u1, params.r_v1, params.r_u2, params.r_v2),
    f: bezier(junction, pinch, params.f_u1, params.f_v1, params.f_u2, params.f_v2),
  }), [anchor[0], anchor[1], junction[0], junction[1], pivot[0], pivot[1], pinch[0], pinch[1], params]);

  const forceA = simResult ? interp(yPose, simResult.Y_positions, simResult.force_a) : 0;
  const forceB = simResult ? interp(-yPose, simResult.Y_positions, simResult.force_a) : 0;

  const primaryLines = useMemo(() => {
    if (!simResult?.lines) return restLines;
    return {
      l: deflected(simResult.lines.l, yPose, forceA),
      r: deflected(simResult.lines.r, yPose, forceA),
      f: deflected(simResult.lines.f, yPose, forceA),
    };
  }, [simResult, yPose, forceA, restLines]);

  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, yy]) => [-x, ceiling - yy]);

  const secondaryLines = useMemo(() => {
    if (!simResult?.lines) {
      return {
        l: mirror(restLines.l),
        r: mirror(restLines.r),
        f: mirror(restLines.f),
      };
    }
    return {
      l: mirror(deflected(simResult.lines.l, -yPose, forceB)),
      r: mirror(deflected(simResult.lines.r, -yPose, forceB)),
      f: mirror(deflected(simResult.lines.f, -yPose, forceB)),
    };
  }, [simResult, yPose, forceB, restLines, ceiling]);

  const poly = (pts: Pt[]) => pts.map(([x, yy]) => `${x.toFixed(3)},${(-yy).toFixed(3)}`).join(' ');
  const carriageY = h0 + (simResult?.travel_sign ?? 1) * yPose;
  const hw = params.pivot_offset + 1;
  const carriagePoly = [
    [-hw, carriageY + 0.85], [-hw + 0.85, carriageY + 1.4], [hw - 0.85, carriageY + 1.4],
    [hw, carriageY + 0.85], [hw, carriageY - 0.85], [hw - 0.85, carriageY - 1.4],
    [-hw + 0.85, carriageY - 1.4], [-hw, carriageY - 0.85],
  ].map(([px, py]) => `${px},${-py}`).join(' ');
  const secondaryOutlines: Record<Member, Pt[]> = {
    l: strokeOutlinePath(secondaryLines.l, params.l_thickness),
    r: strokeOutlinePath(secondaryLines.r, params.r_thickness),
    f: strokeOutlinePath(secondaryLines.f, params.f_thickness),
  };
  const renderSecondaryMinimal = (outlineOpacity: number, skeletonOpacity: number) => (
    <>
      <g opacity={skeletonOpacity}>
        {MEMBER_IDS.map((id) => (
          <polyline
            key={`${id}-skel`}
            points={poly(secondaryLines[id])}
            fill="none"
            stroke={SECONDARY_COLOR}
            strokeWidth={0.1}
            strokeDasharray="0.35 0.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
      <g opacity={outlineOpacity}>
        {MEMBER_IDS.map((id) => {
          const out = secondaryOutlines[id];
          if (out.length < 3) return null;
          return (
            <polygon
              key={`${id}-out`}
              points={poly(out)}
              fill="none"
              stroke={SECONDARY_COLOR}
              strokeWidth={0.14}
              strokeDasharray="0.4 0.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </g>
    </>
  );
  const margin = 1.4;

  const contactA = nearestToWall(primaryLines.f, -1);
  const contactB = nearestToWall(secondaryLines.f, 1);
  const rPin = Math.max(params.f_thickness / 2, 0.18);
  const maxFlow = simResult ? Math.max(0, ...simResult.flow_a.map((f) => f ?? 0)) : 0;
  const flowA = simResult && playing ? interp(yPose, simResult.Y_positions, simResult.flow_a) : 0;
  const flowB = simResult && playing ? interp(-yPose, simResult.Y_positions, simResult.flow_a) : 0;

  const attackAngleDeg = simResult?.attack_angle_deg ?? runner.attack_angle_deg ?? null;

  // Compute attack-angle trajectory (if simulated) or schematic attack vector at Y = 0
  const attackOverlay = useMemo(() => {
    if (simResult?.lines?.f && simResult.Y_positions.length > 0) {
      const lf = simResult.lines.f;
      const tipIdx = lf.x.length - 1;
      if (tipIdx >= 0) {
        const pts: Pt[] = [];
        const steps = 10;
        for (let k = 0; k <= steps; k++) {
          const yy = (k / steps) * params.stroke;
          const ff = interp(yy, simResult.Y_positions, simResult.force_a);
          pts.push([
            lf.x[tipIdx] + lf.x_per_y[tipIdx] * yy + lf.x_per_n[tipIdx] * ff,
            lf.y[tipIdx] + lf.y_per_y[tipIdx] * yy + lf.y_per_n[tipIdx] * ff,
          ]);
        }
        return pts;
      }
    }
    if (attackAngleDeg != null && Number.isFinite(attackAngleDeg)) {
      const rad = (attackAngleDeg * Math.PI) / 180;
      const len = 2.6;
      const tip = restLines.f[restLines.f.length - 1] ?? pinch;
      return [tip, [tip[0] + len * Math.cos(rad), tip[1] + len * Math.sin(rad)] as Pt];
    }
    return null;
  }, [simResult, params.stroke, attackAngleDeg, restLines.f, pinch]);

  return (
    <div className="relative w-full sm:w-44 aspect-[1.12/1] shrink-0 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
      <svg
        viewBox={`${-(wall + margin)} ${-ceiling - margin} ${2 * (wall + margin)} ${ceiling + 2 * margin}`}
        className="h-full w-full select-none"
        role="img"
        aria-label="Solution schematic preview"
      >
        <defs>
          <filter
            id={backdropBlurId}
            filterUnits="userSpaceOnUse"
            x={-(wall + margin)}
            y={-ceiling - margin}
            width={2 * (wall + margin)}
            height={ceiling + 2 * margin}
          >
            <feGaussianBlur stdDeviation={0.25} />
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
            {MEMBER_IDS.map((id) => (
              <polyline
                key={id}
                points={poly(primaryLines[id])}
                fill="none"
                stroke="#ffffff"
                strokeWidth={params[`${id}_thickness`]}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </mask>
        </defs>
        {/* Subtle housing frame */}
        <rect
          x={-wall}
          y={-ceiling}
          width={2 * wall}
          height={ceiling}
          fill="var(--bui-muted)"
          fillOpacity={0.04}
          stroke="var(--bui-text)"
          strokeOpacity={0.25}
          strokeWidth={0.12}
        />
        {[-1, 1].map((side) => (
          <rect
            key={side}
            x={side < 0 ? -wall - 0.55 : wall}
            y={-ceiling - 0.6}
            width={0.55}
            height={ceiling + 1.2}
            fill="var(--bui-text)"
            fillOpacity={0.18}
          />
        ))}

        {/* Tubes A & B with flow particles (shown during playback only) */}
        {miniTube({
          sign: -1, contact: contactA, rPin, wall, od: params.tube_od, id: params.tube_id,
          top: ceiling, flow: flowA, maxFlow, sweep: tubeSweep, showParticles: playing,
        })}
        {miniTube({
          sign: 1, contact: contactB, rPin, wall, od: params.tube_od, id: params.tube_id,
          top: ceiling, flow: flowB, maxFlow, sweep: tubeSweep, showParticles: playing,
        })}

        {/* Back plane: minimal vertical lead-screw axis + dashed hollow outline & ultra-faint dashed skeleton */}
        <line
          x1={0}
          y1={-ceiling - 0.4}
          x2={0}
          y2={0.4}
          stroke="var(--bui-text)"
          strokeOpacity={0.25}
          strokeWidth={0.08}
          strokeDasharray="0.55 0.25 0.12 0.25"
        />
        <g data-layer="mini-secondary">
          {renderSecondaryMinimal(0.34, 0.12)}
        </g>

        {/* Middle plane: carriage with frosted interior blur clipped to sharp polygon */}
        <g data-layer="mini-carriage-backdrop" clipPath={`url(#${carriageClipId})`}>
          <g filter={`url(#${backdropBlurId})`}>
            <rect x={-(wall + margin)} y={-ceiling - margin} width={2 * (wall + margin)} height={ceiling + 2 * margin} fill="#0a0a0a" />
            <line
              x1={0}
              y1={-ceiling - 0.4}
              x2={0}
              y2={0.4}
              stroke="var(--bui-text)"
              strokeOpacity={0.3}
              strokeWidth={0.1}
              strokeDasharray="0.55 0.25 0.12 0.25"
            />
            {renderSecondaryMinimal(0.4, 0.14)}
          </g>
        </g>
        <polygon
          points={carriagePoly}
          fill="#1b1e25"
          fillOpacity={0.55}
          stroke="var(--bui-text)"
          strokeOpacity={0.38}
          strokeWidth={0.07}
        />

        {/* Front plane: primary mechanism with frosted interior blur clipped to sharp strokes */}
        <g data-layer="mini-primary-backdrop" mask={`url(#${primaryMaskId})`}>
          <g filter={`url(#${backdropBlurId})`}>
            <rect x={-(wall + margin)} y={-ceiling - margin} width={2 * (wall + margin)} height={ceiling + 2 * margin} fill="#0a0a0a" />
            <line
              x1={0}
              y1={-ceiling - 0.4}
              x2={0}
              y2={0.4}
              stroke="var(--bui-text)"
              strokeOpacity={0.3}
              strokeWidth={0.1}
              strokeDasharray="0.55 0.25 0.12 0.25"
            />
            {renderSecondaryMinimal(0.4, 0.14)}
            <polygon points={carriagePoly} fill="#1b1e25" fillOpacity={0.65} stroke="var(--bui-text)" strokeOpacity={0.45} strokeWidth={0.11} />
          </g>
        </g>
        <g data-layer="mini-primary" opacity={0.82}>
          {MEMBER_IDS.map((id) => (
            <polyline
              key={id}
              points={poly(primaryLines[id])}
              fill="none"
              stroke={PRIMARY_COLOR}
              strokeWidth={params[`${id}_thickness`]}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>

        {/* Attack angle overlay (only graphical overlay) */}
        {attackOverlay && attackOverlay.length >= 2 && (
          <g data-layer="mini-attack-angle" pointerEvents="none">
            <polyline
              points={poly(attackOverlay)}
              fill="none"
              stroke="#22d3ee"
              strokeWidth={0.22}
              strokeLinecap="round"
            />
            <circle
              cx={attackOverlay[attackOverlay.length - 1][0]}
              cy={-attackOverlay[attackOverlay.length - 1][1]}
              r={0.32}
              fill="#22d3ee"
            />
          </g>
        )}
      </svg>

      {/* Attack angle numeric pill */}
      {attackAngleDeg != null && (
        <span
          className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-neutral-950/85 border border-cyan-500/40 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-300"
          title="Pinch foot attack angle (α)"
        >
          α {attackAngleDeg > 0 ? '+' : ''}{attackAngleDeg.toFixed(0)}°
        </span>
      )}

      {/* Play / Pause animation overlay button */}
      <button
        type="button"
        onClick={handleTogglePlay}
        disabled={loading}
        aria-pressed={playing}
        aria-label={playing ? 'Pause mechanism animation' : 'Play mechanism animation'}
        title={playing ? 'Stop animation and return to Y = 0' : 'Play mechanism oscillation with flow particles'}
        className={`absolute bottom-1.5 right-1.5 inline-flex items-center justify-center rounded-md border p-1.5 transition shadow ${
          playing
            ? 'border-amber-400 bg-amber-500 text-neutral-950 hover:bg-amber-400'
            : 'border-neutral-600 bg-neutral-900/90 text-amber-300 hover:border-amber-400 hover:bg-neutral-800'
        }`}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : playing ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Play className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}
