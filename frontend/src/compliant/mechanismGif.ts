import { encodeGif } from '../lib/gifEncoder';
import type { GifFrameInput } from '../lib/gifEncoder';
import { MAX_PARTICLES, countOpacity, particleSpeed, placeSide, seed } from '../lib/flowParticles';
import { sideBore, tubeProfile } from '../lib/tubeSide';
import type { TubeSweep } from '../lib/tubeSweep';
import { applyFrostedBackdrop } from './solvePreviewRenderer';
import {
  CARRIAGE_SPEED_MM_S, MEMBERS, buildConstantSpeedCycle, deflected, deflectedPoint, interp, interpNullable,
  nearestToWall, pinchContactX, strokeOutlinePath,
} from './types';
import type {
  CompliantParams, CompliantResult, Member, Pt, SolverConstraints,
} from './types';

export interface MechanismGifOptions {
  params: CompliantParams;
  result: CompliantResult;
  constraints: SolverConstraints;
  tubeSweep: TubeSweep | null;
  carriageSpeed?: number;
  includeDetails: boolean;
  includeParticles: boolean;
  onProgress?: (pct: number) => void;
}

const SEEDS = Array.from({ length: MAX_PARTICLES }, (_, i) => seed(i));

const COLORS = {
  bg: '#0d0e11',
  housingFill: '#15181f',
  housingStroke: '#d4d4d8',
  wallRail: '#4a4f5b',
  tubeFill: '#2b2f39',
  tubeStroke: '#9ca3af',
  boreOpen: '#10b981',
  boreShut: '#ef4444',
  screw: '#d4a94a',
  carriageFill: '#3b404c',
  carriageStroke: '#d4d4d8',
  datum: '#60a5fa',
  text: '#f4f4f5',
  mutedText: '#a1a1aa',
  trajectory: '#22d3ee',
  amber: '#f59e0b',
  emerald: '#34d399',
};

const PINNED_RGB: [number, number, number][] = [
  [13, 14, 17],    // bg
  [21, 24, 31],    // housingFill
  [43, 47, 57],    // tubeFill
  [59, 64, 76],    // carriageFill
  [74, 79, 91],    // wallRail
  [212, 169, 74],  // screw
  [245, 158, 11],  // member L / amber
  [96, 165, 250],  // member R / blue
  [52, 211, 153],  // member F / emerald
  [16, 185, 129],  // boreOpen
  [239, 68, 68],   // boreShut
  [34, 211, 238],  // trajectory cyan
  [244, 244, 245], // text
  [161, 161, 170], // mutedText
];

function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  align: CanvasTextAlign = 'center',
  fontSize = 11,
) {
  ctx.save();
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = COLORS.bg;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Draw one frame of the running Compliant Bars mechanism (never includes spline nodes).
 * When `includeDetails` is true, renders the schematic's detail overlays (margins, h₀,
 * gap/force readouts, P_goal target, pinch trajectory α, tube titles, carriage Y).
 */
export function drawMechanismFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: {
    params: CompliantParams;
    result: CompliantResult;
    constraints: SolverConstraints;
    tubeSweep: TubeSweep | null;
    yPose: number;
    includeDetails: boolean;
    includeParticles: boolean;
    particlePhaseA: number;
    particlePhaseB: number;
  },
) {
  const {
    params, result, constraints, tubeSweep, yPose,
    includeDetails, includeParticles, particlePhaseA, particlePhaseB,
  } = opts;

  const wall = result.wall_x;
  const h0 = result.pivot_height_y0;
  const ceiling = 2 * h0;
  const margin = 2.2;
  const worldW = 2 * (wall + margin);
  const worldH = ceiling + 2 * margin;
  const pad = 16;
  const scale = Math.min((width - pad * 2) / worldW, (height - pad * 2) / worldH);
  const originX = width / 2;
  const originY = height / 2 + (ceiling / 2) * scale;
  const toX = (wx: number) => originX + wx * scale;
  const toY = (wy: number) => originY - wy * scale;

  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  // Housing rectangle & outer rails
  const xL = toX(-wall);
  const xR = toX(wall);
  const yTop = toY(ceiling);
  const yBot = toY(0);
  ctx.fillStyle = COLORS.housingFill;
  ctx.fillRect(xL, yTop, xR - xL, yBot - yTop);

  const railW = Math.max(3, 0.7 * scale);
  ctx.fillStyle = COLORS.wallRail;
  ctx.fillRect(xL - railW, toY(ceiling + 1), railW, (ceiling + 2) * scale);
  ctx.fillRect(xR, toY(ceiling + 1), railW, (ceiling + 2) * scale);

  ctx.strokeStyle = COLORS.housingStroke;
  ctx.lineWidth = Math.max(1.2, 0.14 * scale);
  ctx.strokeRect(xL, yTop, xR - xL, yBot - yTop);

  // Optional ceiling & floor pinch margin bands (details only)
  if (includeDetails) {
    const bandW = (params.tube_od + 1.2) * scale;
    if (constraints.pinch_ceiling_margin_mm > 0 && constraints.pinch_ceiling_margin_mm < ceiling) {
      const bandH = constraints.pinch_ceiling_margin_mm * scale;
      ctx.fillStyle = COLORS.amber;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(xL, yTop, bandW, bandH);
      ctx.globalAlpha = 0.55;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS.amber;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xL, yTop + bandH);
      ctx.lineTo(xL + bandW, yTop + bandH);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    if (constraints.pinch_floor_margin_mm > 0 && constraints.pinch_floor_margin_mm < ceiling) {
      const bandH = constraints.pinch_floor_margin_mm * scale;
      ctx.fillStyle = COLORS.amber;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(xL, yBot - bandH, bandW, bandH);
      ctx.globalAlpha = 0.55;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS.amber;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xL, yBot - bandH);
      ctx.lineTo(xL + bandW, yBot - bandH);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  // Deflected mechanisms A & B
  const forceA = interp(yPose, result.Y_positions, result.force_a);
  const forceB = interp(-yPose, result.Y_positions, result.force_a);
  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, ceiling - y]);
  const linesA: Record<Member, Pt[]> = {
    l: deflected(result.lines.l, yPose, forceA),
    r: deflected(result.lines.r, yPose, forceA),
    f: deflected(result.lines.f, yPose, forceA),
  };
  const linesB: Record<Member, Pt[]> = {
    l: mirror(deflected(result.lines.l, -yPose, forceB)),
    r: mirror(deflected(result.lines.r, -yPose, forceB)),
    f: mirror(deflected(result.lines.f, -yPose, forceB)),
  };

  const contactA = nearestToWall(linesA.f, -1);
  const contactB = nearestToWall(linesB.f, 1);
  const maxFlow = Math.max(0, ...result.flow_a.map((f) => f ?? 0));
  const flowA = interp(yPose, result.Y_positions, result.flow_a);
  const flowB = interp(-yPose, result.Y_positions, result.flow_a);
  const rPin = Math.max(params.f_thickness / 2, 0.18);

  // Draw Tube A and Tube B using the exact tubeProfile + sideBore model
  const drawTube = (
    sign: -1 | 1,
    name: string,
    contact: Pt,
    flow: number,
    particlePhase: number,
  ) => {
    const frac = maxFlow > 0 ? Math.min(Math.max(flow, 0) / maxFlow, 1) : 0;
    const fromWall = wall - sign * contact[0];
    const ends: [Pt, Pt] = [[fromWall, contact[1]], [fromWall, contact[1]]];
    const profile = tubeProfile(ends, rPin, params.tube_od, -1, ceiling + 1, tubeSweep ? params.tube_od : undefined);
    const bore = sideBore(profile, params.tube_od, params.tube_id, tubeSweep);

    const traceRing = (inner: number[], outer: number[]) => {
      ctx.beginPath();
      for (let i = 0; i < profile.length; i++) {
        const sx = toX(sign * (wall - outer[i]));
        const sy = toY(profile[i][1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      for (let i = profile.length - 1; i >= 0; i--) {
        const sx = toX(sign * (wall - inner[i]));
        const sy = toY(profile[i][1]);
        ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    };

    // Silicone wall
    traceRing(profile.map(() => 0), profile.map(([h]) => h));
    ctx.fillStyle = COLORS.tubeFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.tubeStroke;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Inner bore
    traceRing(bore.map((b) => b[1]), bore.map((b) => b[2]));
    ctx.fillStyle = frac > 0 ? COLORS.boreOpen : COLORS.boreShut;
    ctx.globalAlpha = 0.25 + 0.45 * frac;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Flow particles inside open bore
    if (includeParticles && frac > 0.01) {
      const pRadius = Math.min(0.16, params.tube_id / 6);
      ctx.fillStyle = COLORS.text;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const a = countOpacity(i, frac);
        if (a <= 0) break;
        const along = ((SEEDS[i].along + particlePhase) % 1 + 1) % 1;
        const at = placeSide(bore, along, SEEDS[i].across, pRadius);
        if (!at || at.fade <= 0) continue;
        // Local frame matches SVG matrix(-sign 0 0 -1 sign*wall 0) -> world x = sign*(wall - at.x), world y = at.y
        const wx = sign * (wall - at.x);
        const wy = at.y;
        ctx.globalAlpha = 0.85 * a * at.fade;
        ctx.beginPath();
        ctx.arc(toX(wx), toY(wy), Math.max(1.1, at.r * scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Centerline
    const cx = toX(sign * (wall - params.tube_od / 2));
    ctx.save();
    ctx.setLineDash([6, 2, 2, 2]);
    ctx.strokeStyle = COLORS.text;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    ctx.moveTo(cx, toY(ceiling + 1));
    ctx.lineTo(cx, toY(-1));
    ctx.stroke();
    ctx.restore();

    if (includeDetails) {
      drawOutlinedText(ctx, name, cx, toY(ceiling + 1.25), COLORS.text, 'center', 10);
    }
  };

  drawTube(-1, 'A supply', contactA, flowA, particlePhaseA);
  drawTube(1, 'B exhaust', contactB, flowB, particlePhaseB);

  const drawMemberLine = (
    c: CanvasRenderingContext2D,
    pts: Pt[],
    thickness: number,
    color: string,
    bodyAlpha: number,
    coreAlpha: number,
  ) => {
    if (pts.length < 2) return;
    const trace = () => {
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) c.moveTo(toX(pts[i][0]), toY(pts[i][1]));
        else c.lineTo(toX(pts[i][0]), toY(pts[i][1]));
      }
    };
    c.lineCap = 'round';
    c.lineJoin = 'round';
    trace();
    c.strokeStyle = color;
    c.globalAlpha = bodyAlpha;
    c.lineWidth = Math.max(2, thickness * scale);
    c.stroke();

    if (coreAlpha > 0) {
      trace();
      c.strokeStyle = color;
      c.globalAlpha = coreAlpha;
      c.lineWidth = Math.max(1.2, 0.12 * scale);
      c.stroke();
    }
    c.globalAlpha = 1;
  };

  // Back plane: minimal vertical lead-screw axis + dashed outline opposite-side copy (below carriage)
  ctx.save();
  ctx.setLineDash([7, 3, 2, 3]);
  ctx.strokeStyle = COLORS.text;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(ceiling + 0.6));
  ctx.lineTo(toX(0), toY(-0.6));
  ctx.stroke();
  ctx.restore();

  // Dashed ultra-faint central skeleton (88% transparent) + dashed hollow outer outline of opposite copy
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const m of MEMBERS) {
    const pts = linesB[m.id];
    if (pts.length < 2) continue;
    // Ultra-faint dashed skeleton centerline (~88% transparent)
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = m.color;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(toX(pts[i][0]), toY(pts[i][1]));
      else ctx.lineTo(toX(pts[i][0]), toY(pts[i][1]));
    }
    ctx.stroke();

    // Hollow dashed outer contour (true thickness outline)
    const outline = strokeOutlinePath(pts, params[`${m.id}_thickness`]);
    if (outline.length >= 3) {
      ctx.setLineDash([4.5, 3.5]);
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.36;
      ctx.strokeStyle = m.color;
      ctx.beginPath();
      for (let i = 0; i < outline.length; i++) {
        if (i === 0) ctx.moveTo(toX(outline[i][0]), toY(outline[i][1]));
        else ctx.lineTo(toX(outline[i][0]), toY(outline[i][1]));
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();

  // Middle plane: carriage with frosted backdrop blur strictly inside its sharp polygon
  const carriageY = h0 + (result.travel_sign ?? 1) * yPose;
  const hw = params.pivot_offset + 1;
  const carriagePts: Pt[] = [
    [-hw, carriageY + 0.9], [-hw + 0.9, carriageY + 1.5], [hw - 0.9, carriageY + 1.5], [hw, carriageY + 0.9],
    [hw, carriageY - 0.9], [hw - 0.9, carriageY - 1.5], [-hw + 0.9, carriageY - 1.5], [-hw, carriageY - 0.9],
  ];
  const traceCarriage = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    carriagePts.forEach(([px, py], i) => {
      if (i === 0) c.moveTo(toX(px), toY(py));
      else c.lineTo(toX(px), toY(py));
    });
    c.closePath();
  };

  applyFrostedBackdrop(ctx, 2.5, (mctx) => {
    traceCarriage(mctx);
    mctx.fillStyle = '#ffffff';
    mctx.fill();
  });

  traceCarriage(ctx);
  ctx.fillStyle = COLORS.carriageFill;
  ctx.globalAlpha = 0.56;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLORS.carriageStroke;
  ctx.lineWidth = 1.1;
  ctx.stroke();

  // Horizontal datum h0
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.datum;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(xL, toY(h0));
  ctx.lineTo(xR, toY(h0));
  ctx.stroke();
  ctx.restore();

  // Front plane: frosted backdrop blur strictly inside primary mechanism A's sharp strokes
  applyFrostedBackdrop(ctx, 2.5, (mctx) => {
    for (const m of MEMBERS) {
      drawMemberLine(mctx, linesA[m.id], params[`${m.id}_thickness`], '#ffffff', 1, 0);
    }
  });

  // Active front pivot pin & primary mechanism A (crisp silhouette + translucent tint)
  const pivotX = params.pivot_inverted ? -params.pivot_offset : params.pivot_offset;
  ctx.beginPath();
  ctx.arc(toX(pivotX), toY(carriageY), Math.max(2.5, Math.max(params.carriage_pin_diameter / 2, 0.2) * scale), 0, Math.PI * 2);
  ctx.fillStyle = COLORS.datum;
  ctx.fill();

  for (const m of MEMBERS) {
    drawMemberLine(ctx, linesA[m.id], params[`${m.id}_thickness`], m.color, 0.4, 1);
  }

  // Details overlay (strictly controlled by includeDetails; NEVER spline nodes)
  if (includeDetails) {
    const gapA = interpNullable(yPose, result.Y_positions, result.gap_a);
    const gapB = interpNullable(yPose, result.Y_positions, result.gap_b)
      ?? interpNullable(-yPose, result.Y_positions, result.gap_a);
    const fA = interpNullable(yPose, result.Y_positions, result.force_a);
    const fB = interpNullable(yPose, result.Y_positions, result.force_b)
      ?? interpNullable(-yPose, result.Y_positions, result.force_a);
    const newtons = (f: number | null) => (f == null ? '' : `, ${f.toFixed(f < 10 ? 2 : 1)} N`);

    drawOutlinedText(ctx, `h₀ ${h0.toFixed(2)}`, toX(-wall + 0.25), toY(h0 + 0.65), COLORS.datum, 'left', 10);
    if (gapA != null) {
      drawOutlinedText(ctx, `gap ${gapA.toFixed(3)}${newtons(fA)}`, toX(-wall + 0.2), toY(contactA[1] + 1.25), COLORS.text, 'left', 10);
    }
    if (gapB != null) {
      drawOutlinedText(ctx, `gap ${gapB.toFixed(3)}${newtons(fB)}`, toX(wall - 0.2), toY(contactB[1] - 1.25), COLORS.text, 'right', 10);
    }

    // Target pinch P_goal & target attack vector
    if (constraints.target_pinch_from_top_mm != null) {
      const ty = ceiling - constraints.target_pinch_from_top_mm;
      const txContact = result.pinch_contact_x ?? pinchContactX(params, tubeSweep);
      const txCenter = txContact + params.f_thickness / 2;
      const footR = Math.max(params.f_thickness / 2, 0.18);
      const angRad = ((constraints.target_attack_angle_deg ?? 0) * Math.PI) / 180;
      const len = 2.4;
      const vx = txCenter + len * Math.cos(angRad);
      const vy = ty + len * Math.sin(angRad);

      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS.emerald;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(toX(-wall), toY(ty));
      ctx.lineTo(toX(txCenter + footR + 0.3), toY(ty));
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(toX(txCenter), toY(ty), footR * scale, 0, Math.PI * 2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(toX(txContact), toY(ty), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.emerald;
      ctx.fill();

      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS.amber;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(toX(txCenter), toY(ty));
      ctx.lineTo(toX(vx), toY(vy));
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(toX(vx), toY(vy), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.amber;
      ctx.fill();
      ctx.restore();
    }

    // Loaded pinch trajectory P(Y) for Y: 0 -> +stroke
    const lf = result.lines.f;
    const tipIdx = lf.x.length - 1;
    if (tipIdx >= 0 && result.Y_positions.length > 0) {
      const trajPts: Pt[] = [];
      for (let k = 0; k <= 12; k++) {
        const yy = (k / 12) * params.stroke;
        const ff = interp(yy, result.Y_positions, result.force_a);
        trajPts.push(deflectedPoint(lf, tipIdx, yy, ff));
      }
      const pEnd = trajPts[trajPts.length - 1];
      ctx.beginPath();
      trajPts.forEach(([tx, ty], i) => {
        if (i === 0) ctx.moveTo(toX(tx), toY(ty));
        else ctx.lineTo(toX(tx), toY(ty));
      });
      ctx.strokeStyle = COLORS.trajectory;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(toX(pEnd[0]), toY(pEnd[1]), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.trajectory;
      ctx.fill();

      if (result.attack_angle_deg != null) {
        drawOutlinedText(
          ctx,
          `α ${result.attack_angle_deg > 0 ? '+' : ''}${result.attack_angle_deg.toFixed(0)}°`,
          toX(pEnd[0]) + 7,
          toY(pEnd[1]),
          COLORS.trajectory,
          'left',
          10,
        );
      }
    }

    // Live carriage Y readout at top-left
    drawOutlinedText(
      ctx,
      `Y = ${yPose >= 0 ? '+' : ''}${yPose.toFixed(2)} mm`,
      14,
      16,
      COLORS.mutedText,
      'left',
      11,
    );
  }

  ctx.restore();
}

/**
 * Generate a seamlessly looping GIF of the Compliant Bars mechanism oscillating
 * at constant real carriage speed (0 -> +stroke -> -stroke -> 0), never with spline nodes.
 */
export async function buildMechanismGif(options: MechanismGifOptions): Promise<Blob> {
  const {
    params, result, constraints, tubeSweep, carriageSpeed,
    includeDetails, includeParticles, onProgress,
  } = options;
  const width = 520;
  const height = 440;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const speed = carriageSpeed && carriageSpeed > 0 ? carriageSpeed : CARRIAGE_SPEED_MM_S;
  const steps = buildConstantSpeedCycle(params.stroke, speed, 120);
  const maxFlow = Math.max(1e-6, ...result.flow_a.map((f) => f ?? 0));

  const frames: GifFrameInput[] = [];
  let phaseA = 0;
  let phaseB = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const yPose = step.y;
    const flowA = Math.max(0, interp(yPose, result.Y_positions, result.flow_a));
    const flowB = Math.max(0, interp(-yPose, result.Y_positions, result.flow_a));
    const fracA = Math.min(1, flowA / maxFlow);
    const fracB = Math.min(1, flowB / maxFlow);

    drawMechanismFrame(ctx, width, height, {
      params,
      result,
      constraints,
      tubeSweep,
      yPose,
      includeDetails,
      includeParticles,
      particlePhaseA: phaseA,
      particlePhaseB: phaseB,
    });

    const img = ctx.getImageData(0, 0, width, height);
    frames.push({ rgba: new Uint8ClampedArray(img.data), delayMs: step.delayMs });

    // Advance particles over the exact real-time step duration (A: -1, B: +1)
    const dt = step.delayMs / 1000;
    phaseA = (phaseA - particleSpeed(fracA, 'side') * dt) % 1;
    phaseB = (phaseB + particleSpeed(fracB, 'side') * dt) % 1;

    if (i % 8 === 0) {
      onProgress?.(Math.round(((i + 1) / steps.length) * 78));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress?.(85);
  await new Promise((r) => setTimeout(r, 0));

  const bytes = encodeGif(width, height, frames, PINNED_RGB);
  onProgress?.(100);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
}
