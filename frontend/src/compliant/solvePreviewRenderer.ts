import { encodeGif } from '../lib/gifEncoder';
import type { GifFrameInput } from '../lib/gifEncoder';
import {
  CARRIAGE_SPEED_MM_S, buildConstantSpeedCycle, deflected, deflectedPoint, interp, nearestToWall,
  sampleCubicBezier, strokeOutlinePath,
} from './types';
import type {
  CompliantParams,
  CompliantResult,
  ConvergencePoint,
  Member,
  PreviewFrame,
  Pt,
  SolveJobState,
  SolverMethod,
} from './types';
import { SOLVER_GOAL_META, SOLVER_METHOD_META } from './types';

export const SHORT_REASON_LABELS: Record<string, string> = {
  stress: 'Stress',
  motor_stall: 'Motor stall',
  seal_y0: 'Y=0 seal',
  tube: 'Tube hit',
  crossing: 'Crossing',
  shell: 'Shell hit',
  pivot: 'Pivot hit',
  pinch: 'Pinch margin',
  rotation: 'Rotation',
  junction_forbidden: 'Forbidden J',
  no_open: 'No open',
  geometry: 'Geometry',
};

const PALETTE = {
  bg: '#0d0e11',
  panel: '#13151a',
  border: '#262930',
  housingFill: '#14161c',
  housingStroke: '#454b57',
  wallRail: '#262a33',
  axisLine: '#2d323d',
  datumLine: '#2e4a6b',
  screw: '#b89242',
  carriageFill: '#2c303a',
  carriageStroke: '#596070',
  tubeWall: '#2c303b',
  tubeStroke: '#505766',
  boreOpen: '#10b981',
  boreShut: '#b84a54',
  memberL: '#f59e0b',
  memberR: '#60a5fa',
  memberF: '#34d399',
  rejected: '#b9626c',
  rejectedCore: '#d47c86',
  ghost: '#545b6b',
  trajectory: '#22d3ee',
  textPrimary: '#f4f4f5',
  textSecondary: '#a1a1aa',
  textMuted: '#71717a',
  amber: '#f59e0b',
  emerald: '#34d399',
  rose: '#e1707c',
};

const GIF_PINNED_RGB: [number, number, number][] = [
  [13, 14, 17],    // bg
  [19, 21, 26],    // panel
  [38, 41, 48],    // border
  [20, 22, 28],    // housingFill
  [69, 75, 87],    // housingStroke
  [184, 146, 66],  // screw
  [245, 158, 11],  // memberL / amber
  [96, 165, 250],  // memberR / sky
  [52, 211, 153],  // memberF / emerald
  [16, 185, 129],  // boreOpen
  [184, 74, 84],   // boreShut
  [185, 98, 108],  // rejected
  [212, 124, 134], // rejectedCore
  [34, 211, 238],  // trajectory cyan
  [244, 244, 245], // textPrimary
  [161, 161, 170], // textSecondary
  [113, 113, 122], // textMuted
];

export interface ViewportBounds {
  wallX: number;
  ceiling: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CuratedGifFrame {
  frame: PreviewFrame;
  delayMs: number;
}

export function computeViewportBounds(
  frames: PreviewFrame[],
  result?: CompliantResult | null,
  params?: Partial<CompliantParams> | null,
): ViewportBounds {
  let maxWall = result?.wall_x ?? ((params?.tube_center_x ?? 8) + (params?.tube_od ?? 3) / 2);
  let maxCeiling = (result?.pivot_height_y0 ?? params?.closed_carriage_height ?? 8) * 2;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.wall_x > maxWall) maxWall = f.wall_x;
    if (f.h0 * 2 > maxCeiling) maxCeiling = f.h0 * 2;
  }
  return {
    wallX: Math.max(4, maxWall),
    ceiling: Math.max(8, maxCeiling),
  };
}

function createTransform(rect: Rect, bounds: ViewportBounds) {
  const margin = 2.0;
  const worldW = 2 * (bounds.wallX + margin);
  const worldH = bounds.ceiling + 2 * margin;
  const padX = 14;
  const padY = 14;
  const availW = Math.max(40, rect.w - padX * 2);
  const availH = Math.max(40, rect.h - padY * 2);
  const scale = Math.min(availW / worldW, availH / worldH);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2 + (bounds.ceiling / 2) * scale;
  return {
    scale,
    toX: (wx: number) => cx + wx * scale,
    toY: (wy: number) => cy - wy * scale,
  };
}

/** Draw simplified side-view silicone tube with smooth pinch shoulder around contact point. */
function drawSimplifiedTube(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  opts: {
    sign: -1 | 1;
    wallX: number;
    ceiling: number;
    od: number;
    id: number;
    pinchY: number;
    gapFromWall: number; // outer wall distance from rigid wall at pinch
    openFrac: number;    // 0 = pinched shut, 1 = full open
  },
) {
  const { sign, wallX, ceiling, od, id, pinchY, gapFromWall, openFrac } = opts;
  const wallT = Math.max(0.15, (od - id) / 2);
  const pinchedH = Math.max(wallT * 1.4, Math.min(od, gapFromWall));
  const shoulder = Math.max(1.2, od * 1.15);
  const steps = 28;

  const ys: number[] = [];
  const outerH: number[] = [];
  const boreIn: number[] = [];
  const boreOut: number[] = [];

  const yTop = ceiling + 0.6;
  const yBot = -0.6;
  for (let i = 0; i <= steps; i++) {
    const wy = yBot + (i / steps) * (yTop - yBot);
    const dy = Math.abs(wy - pinchY);
    const blend = dy >= shoulder ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * dy) / shoulder);
    const h = pinchedH + (od - pinchedH) * blend;
    const localOpen = Math.max(0, h - 2 * wallT);
    const boreMid = wallT + localOpen / 2;
    const halfBore = localOpen / 2;
    ys.push(wy);
    outerH.push(h);
    boreIn.push(boreMid - halfBore);
    boreOut.push(boreMid + halfBore);
  }

  // Tube silicone body
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const wx = sign * (wallX - outerH[i]);
    if (i === 0) ctx.moveTo(tx.toX(wx), tx.toY(ys[i]));
    else ctx.lineTo(tx.toX(wx), tx.toY(ys[i]));
  }
  for (let i = steps; i >= 0; i--) {
    const wx = sign * wallX;
    ctx.lineTo(tx.toX(wx), tx.toY(ys[i]));
  }
  ctx.closePath();
  ctx.fillStyle = PALETTE.tubeWall;
  ctx.fill();
  ctx.strokeStyle = PALETTE.tubeStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Inner bore
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const wx = sign * (wallX - boreOut[i]);
    if (i === 0) ctx.moveTo(tx.toX(wx), tx.toY(ys[i]));
    else ctx.lineTo(tx.toX(wx), tx.toY(ys[i]));
  }
  for (let i = steps; i >= 0; i--) {
    const wx = sign * (wallX - boreIn[i]);
    ctx.lineTo(tx.toX(wx), tx.toY(ys[i]));
  }
  ctx.closePath();
  ctx.fillStyle = openFrac > 0.04 ? PALETTE.boreOpen : PALETTE.boreShut;
  ctx.globalAlpha = openFrac > 0.04 ? 0.28 + 0.48 * openFrac : 0.34;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawHousingBackground(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  wallX: number,
  h0: number,
) {
  const ceiling = 2 * h0;

  // Housing interior & walls
  const xL = tx.toX(-wallX);
  const xR = tx.toX(wallX);
  const yTop = tx.toY(ceiling);
  const yBot = tx.toY(0);
  ctx.fillStyle = PALETTE.housingFill;
  ctx.fillRect(xL, yTop, xR - xL, yBot - yTop);

  // Outer wall bars
  const railW = Math.max(3, 0.55 * tx.scale);
  ctx.fillStyle = PALETTE.wallRail;
  ctx.fillRect(xL - railW, yTop - 4, railW, yBot - yTop + 8);
  ctx.fillRect(xR, yTop - 4, railW, yBot - yTop + 8);

  // Housing frame outline
  ctx.strokeStyle = PALETTE.housingStroke;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(xL, yTop, xR - xL, yBot - yTop);

  // Subtle horizontal datum at h0
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = PALETTE.datumLine;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(xL, tx.toY(h0));
  ctx.lineTo(xR, tx.toY(h0));
  ctx.stroke();
  ctx.restore();
}

let _frostedMaskCanvas: HTMLCanvasElement | null = null;

/**
 * True backdrop-filter blur in Canvas 2D: blurs ONLY what is already drawn on `ctx.canvas`
 * strictly inside the sharp alpha silhouette painted by `paintMask(maskCtx)`, with zero outer blur.
 */
export function applyFrostedBackdrop(
  ctx: CanvasRenderingContext2D,
  blurPx: number,
  paintMask: (maskCtx: CanvasRenderingContext2D) => void,
) {
  const src = ctx.canvas;
  if (!src || typeof document === 'undefined' || src.width <= 0 || src.height <= 0) return;
  if (!_frostedMaskCanvas) _frostedMaskCanvas = document.createElement('canvas');
  if (_frostedMaskCanvas.width !== src.width || _frostedMaskCanvas.height !== src.height) {
    _frostedMaskCanvas.width = src.width;
    _frostedMaskCanvas.height = src.height;
  }
  const mctx = _frostedMaskCanvas.getContext('2d');
  if (!mctx) return;

  const curTransform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;

  mctx.save();
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, _frostedMaskCanvas.width, _frostedMaskCanvas.height);
  if (curTransform) mctx.setTransform(curTransform);

  // 1. Paint sharp opaque mask silhouette
  mctx.globalCompositeOperation = 'source-over';
  mctx.filter = 'none';
  paintMask(mctx);

  // 2. Fill mask interior with Gaussian-blurred pixels of everything currently beneath
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'source-in';
  mctx.filter = `blur(${blurPx.toFixed(1)}px)`;
  mctx.drawImage(src, 0, 0);
  mctx.restore();

  // 3. Stamp frosted interior onto main canvas (razor-sharp edges, blurred interior)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.drawImage(_frostedMaskCanvas, 0, 0);
  ctx.restore();
}

function drawDashedHollowOutline(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  pts: Pt[],
  thicknessMm: number,
  color: string,
  outlineAlpha: number,
  skeletonAlpha = 0.12,
) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Ultra-faint dashed central skeleton (~88% transparent)
  ctx.setLineDash([3.5, 3.5]);
  ctx.strokeStyle = color;
  ctx.globalAlpha = skeletonAlpha;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const sx = tx.toX(pts[i][0]);
    const sy = tx.toY(pts[i][1]);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.stroke();

  // Hollow dashed outer contour of the member's real thickness
  const outline = strokeOutlinePath(pts, thicknessMm);
  if (outline.length >= 3) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = outlineAlpha;
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    for (let i = 0; i < outline.length; i++) {
      const sx = tx.toX(outline[i][0]);
      const sy = tx.toY(outline[i][1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawDashedBezierOutline(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  s: [number, number],
  h: [number, number, number, number],
  e: [number, number],
  thicknessMm: number,
  color: string,
  outlineAlpha: number,
  mirrorCeiling: number,
) {
  const mirroredS: Pt = [-s[0], mirrorCeiling - s[1]];
  const mirroredH: [number, number, number, number] = [
    -h[0], mirrorCeiling - h[1], -h[2], mirrorCeiling - h[3],
  ];
  const mirroredE: Pt = [-e[0], mirrorCeiling - e[1]];
  const pts = sampleCubicBezier(mirroredS, mirroredH, mirroredE, 14);
  drawDashedHollowOutline(ctx, tx, pts, thicknessMm, color, outlineAlpha, 0.12);
}

function drawScrewAndCarriage(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  h0: number,
  carriageY: number,
  pivotOffset: number,
  pivotX: number,
  backdropBlurPx = 2.5,
) {
  const ceiling = 2 * h0;
  const yTop = tx.toY(ceiling);
  const yBot = tx.toY(0);

  // Subtle vertical lead-screw axis below carriage
  ctx.save();
  ctx.setLineDash([6, 3, 2, 3]);
  ctx.strokeStyle = PALETTE.textPrimary;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx.toX(0), yTop - 4);
  ctx.lineTo(tx.toX(0), yBot + 4);
  ctx.stroke();
  ctx.restore();

  // Carriage octagon geometry
  const hw = pivotOffset + 0.9;
  const pts: Pt[] = [
    [-hw, carriageY + 0.8],
    [-hw + 0.7, carriageY + 1.3],
    [hw - 0.7, carriageY + 1.3],
    [hw, carriageY + 0.8],
    [hw, carriageY - 0.8],
    [hw - 0.7, carriageY - 1.3],
    [-hw + 0.7, carriageY - 1.3],
    [-hw, carriageY - 0.8],
  ];
  const traceCarriage = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    pts.forEach(([px, py], i) => {
      if (i === 0) c.moveTo(tx.toX(px), tx.toY(py));
      else c.lineTo(tx.toX(px), tx.toY(py));
    });
    c.closePath();
  };

  // Frosted backdrop blur strictly inside carriage polygon (blurs mirrored mechanism & screw underneath)
  applyFrostedBackdrop(ctx, backdropBlurPx, (mctx) => {
    traceCarriage(mctx);
    mctx.fillStyle = '#ffffff';
    mctx.fill();
  });

  // Translucent carriage tint + sharp crisp border
  traceCarriage(ctx);
  ctx.fillStyle = PALETTE.carriageFill;
  ctx.globalAlpha = 0.62;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.carriageStroke;
  ctx.lineWidth = 1.1;
  ctx.stroke();

  // Active front pivot pin (sharp)
  const pinR = Math.max(2.2, 0.55 * tx.scale);
  ctx.beginPath();
  ctx.arc(tx.toX(pivotX), tx.toY(carriageY), pinR, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.memberR;
  ctx.fill();
}

function drawBezierMember(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  s: [number, number],
  h: [number, number, number, number],
  e: [number, number],
  thicknessMm: number,
  color: string,
  bodyAlpha: number,
  coreAlpha: number,
  mirrorCeiling?: number,
) {
  const mx = (x: number) => (mirrorCeiling != null ? -x : x);
  const my = (y: number) => (mirrorCeiling != null ? mirrorCeiling - y : y);

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(tx.toX(mx(s[0])), tx.toY(my(s[1])));
    ctx.bezierCurveTo(
      tx.toX(mx(h[0])),
      tx.toY(my(h[1])),
      tx.toX(mx(h[2])),
      tx.toY(my(h[3])),
      tx.toX(mx(e[0])),
      tx.toY(my(e[1])),
    );
  };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Scaled body thickness
  trace();
  ctx.strokeStyle = color;
  ctx.globalAlpha = bodyAlpha;
  ctx.lineWidth = Math.max(2, thicknessMm * tx.scale);
  ctx.stroke();

  // Crisp centerline core
  if (coreAlpha > 0) {
    trace();
    ctx.strokeStyle = color;
    ctx.globalAlpha = coreAlpha;
    ctx.lineWidth = Math.max(1.2, 0.14 * tx.scale);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPolylineMember(
  ctx: CanvasRenderingContext2D,
  tx: ReturnType<typeof createTransform>,
  pts: Pt[],
  thicknessMm: number,
  color: string,
  bodyAlpha: number,
  coreAlpha: number,
) {
  if (pts.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const sx = tx.toX(pts[i][0]);
      const sy = tx.toY(pts[i][1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  trace();
  ctx.strokeStyle = color;
  ctx.globalAlpha = bodyAlpha;
  ctx.lineWidth = Math.max(2, thicknessMm * tx.scale);
  ctx.stroke();

  if (coreAlpha > 0) {
    trace();
    ctx.strokeStyle = color;
    ctx.globalAlpha = coreAlpha;
    ctx.lineWidth = Math.max(1.25, 0.15 * tx.scale);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Architectural corner registration marks (clean drafting emphasis without glow). */
function drawCornerBrackets(ctx: CanvasRenderingContext2D, rect: Rect, color: string) {
  const inset = 7;
  const len = 10;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(rect.x + inset, rect.y + inset + len);
  ctx.lineTo(rect.x + inset, rect.y + inset);
  ctx.lineTo(rect.x + inset + len, rect.y + inset);
  // Top-right
  ctx.moveTo(rect.x + rect.w - inset - len, rect.y + inset);
  ctx.lineTo(rect.x + rect.w - inset, rect.y + inset);
  ctx.lineTo(rect.x + rect.w - inset, rect.y + inset + len);
  // Bottom-left
  ctx.moveTo(rect.x + inset, rect.y + rect.h - inset - len);
  ctx.lineTo(rect.x + inset, rect.y + rect.h - inset);
  ctx.lineTo(rect.x + inset + len, rect.y + rect.h - inset);
  // Bottom-right
  ctx.moveTo(rect.x + rect.w - inset - len, rect.y + rect.h - inset);
  ctx.lineTo(rect.x + rect.w - inset, rect.y + rect.h - inset);
  ctx.lineTo(rect.x + rect.w - inset, rect.y + rect.h - inset - len);
  ctx.stroke();
  ctx.restore();
}

/** Draw one tested candidate frame (rest pose, simplified schematic + optional best ghost). */
export function drawSchematicFrame(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  frame: PreviewFrame,
  ghostBest: PreviewFrame | null,
  bounds: ViewportBounds,
  opts?: { showCornerEmphasis?: boolean; progressFrac?: number; blurPx?: number },
) {
  ctx.save();
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const tx = createTransform(rect, bounds);
  const ceiling = 2 * frame.h0;
  const pinchGapA = Math.max(0.2, frame.wall_x + frame.p[0] - frame.th[2] / 2);
  const mirrorBlur = opts?.blurPx ?? 2.5;

  // Housing + tubes
  drawHousingBackground(ctx, tx, frame.wall_x, frame.h0);
  drawSimplifiedTube(ctx, tx, {
    sign: -1,
    wallX: frame.wall_x,
    ceiling,
    od: frame.tube_od,
    id: frame.tube_id,
    pinchY: frame.p[1],
    gapFromWall: pinchGapA,
    openFrac: 0,
  });
  drawSimplifiedTube(ctx, tx, {
    sign: 1,
    wallX: frame.wall_x,
    ceiling,
    od: frame.tube_od,
    id: frame.tube_id,
    pinchY: ceiling - frame.p[1],
    gapFromWall: pinchGapA,
    openFrac: 0,
  });

  // Back plane: hollow dashed outline + ultra-faint dashed skeleton of mirrored mechanism B
  if (frame.ok) {
    drawDashedBezierOutline(ctx, tx, frame.a, frame.hl, frame.j, frame.th[0], PALETTE.memberL, 0.36, ceiling);
    drawDashedBezierOutline(ctx, tx, frame.j, frame.hr, frame.v, frame.th[1], PALETTE.memberR, 0.36, ceiling);
    drawDashedBezierOutline(ctx, tx, frame.j, frame.hf, frame.p, frame.th[2], PALETTE.memberF, 0.36, ceiling);
  } else {
    drawDashedBezierOutline(ctx, tx, frame.a, frame.hl, frame.j, frame.th[0], PALETTE.rejected, 0.24, ceiling);
    drawDashedBezierOutline(ctx, tx, frame.j, frame.hr, frame.v, frame.th[1], PALETTE.rejected, 0.24, ceiling);
    drawDashedBezierOutline(ctx, tx, frame.j, frame.hf, frame.p, frame.th[2], PALETTE.rejected, 0.24, ceiling);
  }

  // Middle plane: lead screw & carriage (frosted interior blur strictly inside sharp carriage polygon)
  drawScrewAndCarriage(ctx, tx, frame.h0, frame.h0, frame.piv_off, frame.v[0], mirrorBlur);

  // Faint dashed ghost of current best valid design (when inspecting a different candidate)
  if (ghostBest && ghostBest.n !== frame.n) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = PALETTE.ghost;
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = 1.25;
    const drawGhostCurve = (s: [number, number], h: [number, number, number, number], e: [number, number]) => {
      ctx.beginPath();
      ctx.moveTo(tx.toX(s[0]), tx.toY(s[1]));
      ctx.bezierCurveTo(tx.toX(h[0]), tx.toY(h[1]), tx.toX(h[2]), tx.toY(h[3]), tx.toX(e[0]), tx.toY(e[1]));
      ctx.stroke();
    };
    drawGhostCurve(ghostBest.a, ghostBest.hl, ghostBest.j);
    drawGhostCurve(ghostBest.j, ghostBest.hr, ghostBest.v);
    drawGhostCurve(ghostBest.j, ghostBest.hf, ghostBest.p);
    ctx.restore();
  }

  // Front plane: frosted backdrop blur strictly inside primary segment A's sharp strokes
  applyFrostedBackdrop(ctx, mirrorBlur, (mctx) => {
    drawBezierMember(mctx, tx, frame.a, frame.hl, frame.j, frame.th[0], '#ffffff', 1, 0);
    drawBezierMember(mctx, tx, frame.j, frame.hr, frame.v, frame.th[1], '#ffffff', 1, 0);
    drawBezierMember(mctx, tx, frame.j, frame.hf, frame.p, frame.th[2], '#ffffff', 1, 0);
  });

  // Active candidate mechanism A in front of carriage (crisp silhouette + translucent tint)
  if (frame.ok) {
    const bodyAlpha = frame.best ? 0.45 : 0.36;
    drawBezierMember(ctx, tx, frame.a, frame.hl, frame.j, frame.th[0], PALETTE.memberL, bodyAlpha, 0.95);
    drawBezierMember(ctx, tx, frame.j, frame.hr, frame.v, frame.th[1], PALETTE.memberR, bodyAlpha, 0.95);
    drawBezierMember(ctx, tx, frame.j, frame.hf, frame.p, frame.th[2], PALETTE.memberF, bodyAlpha, 0.95);
  } else {
    drawBezierMember(ctx, tx, frame.a, frame.hl, frame.j, frame.th[0], PALETTE.rejected, 0.24, 0.7);
    drawBezierMember(ctx, tx, frame.j, frame.hr, frame.v, frame.th[1], PALETTE.rejected, 0.24, 0.7);
    drawBezierMember(ctx, tx, frame.j, frame.hf, frame.p, frame.th[2], PALETTE.rejected, 0.24, 0.7);
  }

  // Subtle joint dots (anchor, junction, pinch tip)
  const dotR = 2.6;
  const drawJoint = (pt: [number, number], color: string) => {
    ctx.beginPath();
    ctx.arc(tx.toX(pt[0]), tx.toY(pt[1]), dotR, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.bg;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  };
  drawJoint(frame.a, frame.ok ? PALETTE.memberL : PALETTE.rejectedCore);
  drawJoint(frame.j, frame.ok ? PALETTE.textPrimary : PALETTE.rejectedCore);
  drawJoint(frame.p, frame.ok ? PALETTE.memberF : PALETTE.rejectedCore);
  // Fixed outer contact surface marker at (closed_gap - preload) from the wall
  const contactX = frame.p[0] - frame.th[2] / 2;
  ctx.beginPath();
  ctx.arc(tx.toX(contactX), tx.toY(frame.p[1]), 2.0, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.emerald;
  ctx.fill();

  // Drafting corner marks for best milestones
  if (opts?.showCornerEmphasis ?? frame.best) {
    drawCornerBrackets(ctx, rect, frame.best ? PALETTE.amber : PALETTE.emerald);
  }

  // Thin progress hairline along bottom edge
  if (opts?.progressFrac != null) {
    const frac = Math.max(0, Math.min(1, opts.progressFrac));
    ctx.fillStyle = PALETTE.border;
    ctx.fillRect(rect.x, rect.y + rect.h - 2, rect.w, 2);
    ctx.fillStyle = frame.best ? PALETTE.amber : frame.ok ? PALETTE.emerald : PALETTE.textMuted;
    ctx.fillRect(rect.x, rect.y + rect.h - 2, Math.round(rect.w * frac), 2);
  }

  ctx.restore();
}

/** Draw the Special Finale frame: real FEM deflected winning mechanism oscillating at carriage pose yPose. */
export function drawFinaleFrame(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  result: CompliantResult,
  params: Partial<CompliantParams>,
  yPose: number,
  bounds: ViewportBounds,
  opts?: { progressFrac?: number; accentColor?: string; blurPx?: number },
) {
  ctx.save();
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const tx = createTransform(rect, bounds);
  const wallX = result.wall_x;
  const h0 = result.pivot_height_y0;
  const ceiling = 2 * h0;
  const tubeOd = params.tube_od ?? 3.0;
  const tubeId = params.tube_id ?? 2.0;
  const pivotOffset = params.pivot_offset ?? Math.abs(result.pivot[0]);
  const stroke = params.stroke ?? 1.5;
  const carriageY = h0 + (result.travel_sign ?? 1) * yPose;
  const mirrorBlur = opts?.blurPx ?? 2.5;

  const forceA = interp(yPose, result.Y_positions, result.force_a);
  const forceB = interp(-yPose, result.Y_positions, result.force_a);
  const maxFlow = Math.max(1e-6, ...result.flow_a.map((v) => v ?? 0));
  const flowA = Math.max(0, interp(yPose, result.Y_positions, result.flow_a));
  const flowB = Math.max(0, interp(-yPose, result.Y_positions, result.flow_a));
  const openFracA = Math.min(1, flowA / maxFlow);
  const openFracB = Math.min(1, flowB / maxFlow);

  const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, ceiling - y]);
  const leftLines: Record<Member, Pt[]> = {
    l: deflected(result.lines.l, yPose, forceA),
    r: deflected(result.lines.r, yPose, forceA),
    f: deflected(result.lines.f, yPose, forceA),
  };
  const rightLines: Record<Member, Pt[]> = {
    l: mirror(deflected(result.lines.l, -yPose, forceB)),
    r: mirror(deflected(result.lines.r, -yPose, forceB)),
    f: mirror(deflected(result.lines.f, -yPose, forceB)),
  };

  const contactA = nearestToWall(leftLines.f, -1);
  const contactB = nearestToWall(rightLines.f, 1);
  const fTh = result.lines.f.thickness;
  const gapA = Math.max(0.2, wallX + contactA[0] - fTh / 2);
  const gapB = Math.max(0.2, wallX - contactB[0] - fTh / 2);

  // Housing + tubes A & B
  drawHousingBackground(ctx, tx, wallX, h0);
  drawSimplifiedTube(ctx, tx, {
    sign: -1,
    wallX,
    ceiling,
    od: tubeOd,
    id: tubeId,
    pinchY: contactA[1],
    gapFromWall: gapA,
    openFrac: openFracA,
  });
  drawSimplifiedTube(ctx, tx, {
    sign: 1,
    wallX,
    ceiling,
    od: tubeOd,
    id: tubeId,
    pinchY: contactB[1],
    gapFromWall: gapB,
    openFrac: openFracB,
  });

  // Back plane: hollow dashed outline + ultra-faint dashed skeleton of mirrored mechanism B
  drawDashedHollowOutline(ctx, tx, rightLines.l, result.lines.l.thickness, PALETTE.memberL, 0.36, 0.12);
  drawDashedHollowOutline(ctx, tx, rightLines.r, result.lines.r.thickness, PALETTE.memberR, 0.36, 0.12);
  drawDashedHollowOutline(ctx, tx, rightLines.f, result.lines.f.thickness, PALETTE.memberF, 0.36, 0.12);

  // Middle plane: lead screw & carriage (frosted interior blur strictly inside sharp carriage polygon)
  drawScrewAndCarriage(ctx, tx, h0, carriageY, pivotOffset, result.pivot[0], mirrorBlur);

  // Front plane: frosted backdrop blur strictly inside primary mechanism A's sharp strokes
  applyFrostedBackdrop(ctx, mirrorBlur, (mctx) => {
    drawPolylineMember(mctx, tx, leftLines.l, result.lines.l.thickness, '#ffffff', 1, 0);
    drawPolylineMember(mctx, tx, leftLines.r, result.lines.r.thickness, '#ffffff', 1, 0);
    drawPolylineMember(mctx, tx, leftLines.f, result.lines.f.thickness, '#ffffff', 1, 0);
  });

  // Primary mechanism A in front of carriage (crisp silhouette + translucent tint)
  drawPolylineMember(ctx, tx, leftLines.l, result.lines.l.thickness, PALETTE.memberL, 0.45, 1);
  drawPolylineMember(ctx, tx, leftLines.r, result.lines.r.thickness, PALETTE.memberR, 0.45, 1);
  drawPolylineMember(ctx, tx, leftLines.f, result.lines.f.thickness, PALETTE.memberF, 0.45, 1);

  // Loaded pinch trajectory trace P(Y) for Y: 0 -> +stroke
  const lf = result.lines.f;
  const tipIdx = lf.x.length - 1;
  if (tipIdx >= 0) {
    ctx.beginPath();
    for (let k = 0; k <= 12; k++) {
      const yy = (k / 12) * stroke;
      const ff = interp(yy, result.Y_positions, result.force_a);
      const [px, py] = deflectedPoint(lf, tipIdx, yy, ff);
      if (k === 0) ctx.moveTo(tx.toX(px), tx.toY(py));
      else ctx.lineTo(tx.toX(px), tx.toY(py));
    }
    ctx.strokeStyle = PALETTE.trajectory;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Live tip marker
    const curTip = leftLines.f[leftLines.f.length - 1];
    ctx.beginPath();
    ctx.arc(tx.toX(curTip[0]), tx.toY(curTip[1]), 3, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.trajectory;
    ctx.fill();
  }

  // Subtle tube labels
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = openFracA > 0.04 ? PALETTE.emerald : PALETTE.textMuted;
  ctx.textAlign = 'left';
  ctx.fillText('A', tx.toX(-wallX) + 4, tx.toY(ceiling) + 13);
  ctx.fillStyle = openFracB > 0.04 ? PALETTE.emerald : PALETTE.textMuted;
  ctx.textAlign = 'right';
  ctx.fillText('B', tx.toX(wallX) - 4, tx.toY(ceiling) + 13);

  // Architectural amber corner brackets
  drawCornerBrackets(ctx, rect, opts?.accentColor ?? PALETTE.amber);

  if (opts?.progressFrac != null) {
    const frac = Math.max(0, Math.min(1, opts.progressFrac));
    ctx.fillStyle = PALETTE.border;
    ctx.fillRect(rect.x, rect.y + rect.h - 2, rect.w, 2);
    ctx.fillStyle = PALETTE.amber;
    ctx.fillRect(rect.x, rect.y + rect.h - 2, Math.round(rect.w * frac), 2);
  }

  ctx.restore();
}

/** Curate a balanced, chronological GIF sequence from the solve timeline with adaptive delays. */
export function curateGifTimeline(timeline: PreviewFrame[]): CuratedGifFrame[] {
  if (timeline.length === 0) return [];

  const bests = timeline.filter((f) => f.best);
  const valids = timeline.filter((f) => f.ok && !f.best);
  const invalids = timeline.filter((f) => !f.ok);

  const pickEven = (arr: PreviewFrame[], limit: number): PreviewFrame[] => {
    if (arr.length <= limit) return arr;
    if (limit <= 1) return [arr[arr.length - 1]];
    const out: PreviewFrame[] = [];
    for (let i = 0; i < limit; i++) {
      const idx = Math.round((i * (arr.length - 1)) / (limit - 1));
      if (out.length === 0 || out[out.length - 1].n !== arr[idx].n) {
        out.push(arr[idx]);
      }
    }
    return out;
  };

  const keptBest = pickEven(bests, 18);
  const keptValid = pickEven(valids, 14);
  const keptInvalid = pickEven(invalids, 30);

  const merged = [...keptInvalid, ...keptValid, ...keptBest].sort((a, b) => a.n - b.n);
  // Dedupe by eval index n
  const deduped: PreviewFrame[] = [];
  for (const f of merged) {
    if (deduped.length === 0 || deduped[deduped.length - 1].n !== f.n) {
      deduped.push(f);
    }
  }

  // Auto-scale delays so Act 1 lands comfortably in ~5.5–8.5 seconds while preserving clear contrast
  const rawMs = deduped.reduce((sum, f) => sum + (f.best ? 700 : f.ok ? 340 : 90), 0);
  const targetMax = 8200;
  const scale = rawMs > targetMax ? targetMax / rawMs : 1;

  return deduped.map((frame, i) => {
    const isFinalBest = frame.best && i === deduped.length - 1;
    const baseDelay = frame.best ? (isFinalBest ? 760 : 680) : frame.ok ? 340 : 90;
    const minDelay = frame.best ? 420 : frame.ok ? 210 : 70;
    return {
      frame,
      delayMs: Math.round(Math.max(minDelay, baseDelay * scale)),
    };
  });
}

function drawSparkline(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  points: { n: number; score: number }[],
  maxN: number,
  currentN: number,
  accentColor: string,
) {
  ctx.save();
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  const visible = points.filter((p) => p.n <= currentN);
  if (visible.length === 0) {
    ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText('Searching for valid design…', rect.x + rect.w / 2, rect.y + rect.h / 2 + 3);
    ctx.restore();
    return;
  }

  const minS = Math.min(...points.map((p) => p.score));
  const maxS = Math.max(...points.map((p) => p.score));
  const spanS = Math.max(1e-4, maxS - minS);
  const padX = 8;
  const padY = 8;
  const w = rect.w - padX * 2;
  const h = rect.h - padY * 2;
  const denomN = Math.max(1, maxN);
  const sx = (n: number) => rect.x + padX + Math.min(1, n / denomN) * w;
  const sy = (s: number) => rect.y + rect.h - padY - ((s - minS) / spanS) * h;

  ctx.beginPath();
  visible.forEach((p, idx) => {
    const px = sx(p.n);
    const py = sy(p.score);
    if (idx === 0) {
      ctx.moveTo(px, py);
    } else {
      const prevY = sy(visible[idx - 1].score);
      ctx.lineTo(px, prevY);
      ctx.lineTo(px, py);
    }
  });
  const last = visible[visible.length - 1];
  ctx.lineTo(sx(currentN), sy(last.score));
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Current best marker dot
  ctx.beginPath();
  ctx.arc(sx(last.n), sy(last.score), 2.8, 0, Math.PI * 2);
  ctx.fillStyle = accentColor;
  ctx.fill();
  ctx.restore();
}

function drawGifSidebarHeader(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sw: number,
  job: SolveJobState,
  tagText: string,
  tagColor: string,
) {
  const pad = 16;
  const method = (job.summary?.method ?? job.method ?? 'hybrid') as SolverMethod;
  const methodLabel = SOLVER_METHOD_META[method]?.short ?? method;
  const goalLabel = SOLVER_GOAL_META[job.goal]?.short ?? job.goal;

  // Title
  ctx.font = '600 13px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textPrimary;
  ctx.textAlign = 'left';
  ctx.fillText('Compliant bar solve', sx + pad, 28);

  ctx.font = '500 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(`${methodLabel} · ${goalLabel}`, sx + pad, 45);

  // Status dot + label
  ctx.beginPath();
  ctx.arc(sx + pad + 4, 71, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = tagColor;
  ctx.fill();

  ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = tagColor;
  ctx.fillText(tagText, sx + pad + 14, 75);

  // Subtle separator
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(sx + pad, 88, sw - pad * 2, 1);
}

function drawMetricRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  valueColor = PALETTE.textPrimary,
) {
  ctx.font = '500 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);

  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = valueColor;
  ctx.textAlign = 'right';
  ctx.fillText(value, x + width, y);
  ctx.textAlign = 'left';
}

function drawEvolutionGifFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  job: SolveJobState,
  frame: PreviewFrame,
  ghostBest: PreviewFrame | null,
  bounds: ViewportBounds,
  sparkPoints: { n: number; score: number }[],
  totalTested: number,
  bestMilestoneIdx: number,
  progressFrac: number,
) {
  const splitX = 416;
  const sideW = width - splitX;
  const pad = 16;

  drawSchematicFrame(
    ctx,
    { x: 0, y: 0, w: splitX, h: height },
    frame,
    ghostBest,
    bounds,
    { showCornerEmphasis: frame.best, progressFrac },
  );

  // Right sidebar
  ctx.fillStyle = PALETTE.panel;
  ctx.fillRect(splitX, 0, sideW, height);
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(splitX, 0, 1, height);

  const tagColor = frame.best ? PALETTE.amber : frame.ok ? PALETTE.emerald : PALETTE.rose;
  const tagText = frame.best
    ? `New best #${bestMilestoneIdx}`
    : frame.ok
      ? 'Valid design'
      : `Rejected · ${SHORT_REASON_LABELS[frame.reason ?? ''] ?? frame.reason ?? 'Invalid'}`;

  drawGifSidebarHeader(ctx, splitX, sideW, job, tagText, tagColor);

  const innerW = sideW - pad * 2;
  const x0 = splitX + pad;

  drawMetricRow(ctx, x0, 114, innerW, 'Evaluation', `#${frame.n} / ${totalTested}`);
  drawMetricRow(
    ctx,
    x0,
    136,
    innerW,
    'ΔX @ 0.25',
    frame.dx != null ? `${frame.dx.toFixed(3)} mm` : '—',
    frame.best ? PALETTE.amber : frame.ok ? PALETTE.emerald : PALETTE.textSecondary,
  );
  drawMetricRow(
    ctx,
    x0,
    158,
    innerW,
    'Max stress',
    frame.stress != null ? `${frame.stress.toFixed(0)} MPa` : '—',
    frame.reason === 'stress' ? PALETTE.rose : PALETTE.textPrimary,
  );
  drawMetricRow(
    ctx,
    x0,
    180,
    innerW,
    'Score',
    frame.score != null ? frame.score.toFixed(3) : '—',
    frame.best ? PALETTE.amber : frame.ok ? PALETTE.emerald : PALETTE.textMuted,
  );

  // Best-so-far block
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(x0, 198, innerW, 1);

  ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText('Best so far', x0, 218);

  const currentBest = frame.best ? frame : ghostBest;
  drawMetricRow(
    ctx,
    x0,
    240,
    innerW,
    'Best ΔX₀.₂₅',
    currentBest?.dx != null ? `${currentBest.dx.toFixed(3)} mm` : '—',
    currentBest ? PALETTE.amber : PALETTE.textMuted,
  );
  drawMetricRow(
    ctx,
    x0,
    262,
    innerW,
    'Stress',
    currentBest?.stress != null ? `${currentBest.stress.toFixed(0)} MPa` : '—',
    PALETTE.textPrimary,
  );

  // Mini convergence sparkline
  ctx.font = '500 10px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText('Score progression', x0, 290);
  drawSparkline(
    ctx,
    { x: x0, y: 298, w: innerW, h: 72 },
    sparkPoints,
    totalTested,
    frame.n,
    PALETTE.amber,
  );

  // Footer
  ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(`t = ${frame.t.toFixed(1)} s`, x0, height - 12);
}

function drawFinaleGifFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  job: SolveJobState,
  result: CompliantResult,
  params: Partial<CompliantParams>,
  yPose: number,
  bounds: ViewportBounds,
  phaseLabel: string,
  progressFrac: number,
) {
  const splitX = 416;
  const sideW = width - splitX;
  const pad = 16;

  drawFinaleFrame(
    ctx,
    { x: 0, y: 0, w: splitX, h: height },
    result,
    params,
    yPose,
    bounds,
    { progressFrac },
  );

  // Right sidebar
  ctx.fillStyle = PALETTE.panel;
  ctx.fillRect(splitX, 0, sideW, height);
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(splitX, 0, 1, height);

  drawGifSidebarHeader(ctx, splitX, sideW, job, 'Best design', PALETTE.amber);

  const innerW = sideW - pad * 2;
  const x0 = splitX + pad;
  const stroke = params.stroke ?? 1.5;
  const maxFlow = Math.max(1e-6, ...result.flow_a.map((v) => v ?? 0));
  const flowA = Math.max(0, interp(yPose, result.Y_positions, result.flow_a));
  const flowB = Math.max(0, interp(-yPose, result.Y_positions, result.flow_a));
  const fracA = Math.min(1, flowA / maxFlow);
  const fracB = Math.min(1, flowB / maxFlow);

  // Actuation subtitle
  ctx.font = '500 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText(phaseLabel, x0, 108);

  // Live Carriage Y meter
  drawMetricRow(ctx, x0, 132, innerW, 'Carriage Y', `${yPose >= 0 ? '+' : ''}${yPose.toFixed(2)} mm`, PALETTE.trajectory);
  const barY = 140;
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(x0, barY, innerW, 6);
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(x0 + innerW / 2 - 0.5, barY - 2, 1, 10);
  const normY = stroke > 0 ? Math.max(-1, Math.min(1, yPose / stroke)) : 0;
  const markerX = x0 + innerW / 2 + normY * (innerW / 2 - 3);
  ctx.fillStyle = PALETTE.amber;
  ctx.fillRect(Math.min(x0 + innerW / 2, markerX), barY + 1, Math.abs(markerX - (x0 + innerW / 2)), 4);
  ctx.fillStyle = PALETTE.textPrimary;
  ctx.fillRect(markerX - 1.5, barY - 1, 3, 8);

  // Live Tube A & B bars
  const drawTubeBar = (y: number, label: string, frac: number) => {
    drawMetricRow(
      ctx,
      x0,
      y,
      innerW,
      label,
      frac > 0.04 ? `${Math.round(frac * 100)}% open` : 'Sealed',
      frac > 0.04 ? PALETTE.emerald : PALETTE.textMuted,
    );
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(x0, y + 6, innerW, 5);
    ctx.fillStyle = frac > 0.04 ? PALETTE.emerald : PALETTE.boreShut;
    ctx.fillRect(x0, y + 6, Math.max(frac > 0.04 ? 2 : 0, Math.round(innerW * frac)), 5);
  };
  drawTubeBar(168, 'Tube A (supply)', fracA);
  drawTubeBar(198, 'Tube B (exhaust)', fracB);

  // Summary metrics
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(x0, 222, innerW, 1);

  ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText('Performance summary', x0, 242);

  drawMetricRow(
    ctx,
    x0,
    264,
    innerW,
    'ΔX @ 0.25',
    result.dx_at_025_mm != null ? `${result.dx_at_025_mm.toFixed(3)} mm` : '—',
    PALETTE.amber,
  );
  drawMetricRow(
    ctx,
    x0,
    286,
    innerW,
    'Max stress',
    result.max_stress_mpa != null ? `${result.max_stress_mpa.toFixed(1)} MPa` : '—',
    PALETTE.textPrimary,
  );
  drawMetricRow(
    ctx,
    x0,
    308,
    innerW,
    'Y₉₀ stroke',
    result.y_90_mm != null ? `${result.y_90_mm.toFixed(2)} mm` : '—',
    PALETTE.textPrimary,
  );
  drawMetricRow(
    ctx,
    x0,
    330,
    innerW,
    'Attack angle α',
    result.attack_angle_deg != null ? `${result.attack_angle_deg > 0 ? '+' : ''}${result.attack_angle_deg.toFixed(1)}°` : '—',
    PALETTE.trajectory,
  );

  // Run totals footer
  const tested = job.summary?.tested ?? 0;
  const feasible = job.summary?.feasible ?? 0;
  const elapsed = job.summary?.elapsed_s ?? 0;
  ctx.fillStyle = PALETTE.border;
  ctx.fillRect(x0, 352, innerW, 1);
  ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(`${tested} tested · ${feasible} valid · ${elapsed.toFixed(1)}s`, x0, 374);
}

/** Generate the full animated GIF (Evolution of tested designs + Special Kinematic Finale). */
export async function buildSolveGif(
  job: SolveJobState,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const width = 640;
  const height = 400;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const timeline = job.summary?.preview_timeline ?? job.summary?.preview_frames ?? [];
  const curated = curateGifTimeline(timeline);
  const bounds = computeViewportBounds(timeline, job.result, job.params);
  const totalTested = Math.max(
    job.summary?.tested ?? 0,
    timeline.length > 0 ? timeline[timeline.length - 1].n : 1,
  );

  const conv: ConvergencePoint[] = job.summary?.convergence ?? [];
  const sparkPoints: { n: number; score: number }[] = conv.length > 0
    ? conv.map((c) => ({ n: c.tested, score: c.score }))
    : timeline
        .filter((f) => f.best && f.score != null)
        .map((f) => ({ n: f.n, score: f.score as number }));

  const hasFinale = Boolean(job.result?.lines?.l && job.result?.lines?.r && job.result?.lines?.f);
  const stroke = job.params?.stroke ?? job.summary?.active_constraints?.stroke_mm ?? 1.5;

  // Build finale poses: constant real carriage speed (0 -> +stroke -> -stroke -> 0)
  const finaleSteps: { y: number; delayMs: number; label: string }[] = [];
  if (hasFinale) {
    const speed = CARRIAGE_SPEED_MM_S;
    const speedTag = `${speed.toFixed(2)} mm/s`;
    finaleSteps.push({ y: 0, delayMs: 480, label: `Best design at rest (${speedTag})` });
    const cycle = buildConstantSpeedCycle(stroke, speed, 84);
    for (let i = 0; i < cycle.length; i++) {
      const st = cycle[i];
      const lbl = st.y > 0.02
        ? (st.dir > 0 ? `Opening A · ${speedTag}` : `Closing A · ${speedTag}`)
        : st.y < -0.02
          ? (st.dir < 0 ? `Opening B · ${speedTag}` : `Closing B · ${speedTag}`)
          : `Passing Y = 0 · ${speedTag}`;
      finaleSteps.push({ y: st.y, delayMs: st.delayMs, label: lbl });
    }
    finaleSteps.push({ y: 0, delayMs: 1100, label: `Sealed at rest (${speedTag})` });
  }

  const totalFrames = curated.length + finaleSteps.length + (hasFinale ? 0 : (curated.length > 0 ? 1 : 0));
  const gifFrames: GifFrameInput[] = [];
  let ghostBest: PreviewFrame | null = null;
  let bestMilestoneIdx = 0;

  for (let i = 0; i < curated.length; i++) {
    const { frame, delayMs } = curated[i];
    if (frame.best) bestMilestoneIdx++;
    drawEvolutionGifFrame(
      ctx,
      width,
      height,
      job,
      frame,
      ghostBest,
      bounds,
      sparkPoints,
      totalTested,
      bestMilestoneIdx,
      (i + 1) / Math.max(1, curated.length),
    );
    if (frame.best) ghostBest = frame;

    const img = ctx.getImageData(0, 0, width, height);
    gifFrames.push({ rgba: new Uint8ClampedArray(img.data), delayMs });

    if (i % 8 === 0) {
      onProgress?.(Math.round(((i + 1) / Math.max(1, totalFrames)) * 75));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (hasFinale && job.result) {
    const params = job.params ?? {};
    for (let i = 0; i < finaleSteps.length; i++) {
      const step = finaleSteps[i];
      drawFinaleGifFrame(
        ctx,
        width,
        height,
        job,
        job.result,
        params,
        step.y,
        bounds,
        step.label,
        (i + 1) / finaleSteps.length,
      );
      const img = ctx.getImageData(0, 0, width, height);
      gifFrames.push({ rgba: new Uint8ClampedArray(img.data), delayMs: step.delayMs });

      if (i % 8 === 0) {
        onProgress?.(Math.round(((curated.length + i + 1) / Math.max(1, totalFrames)) * 75));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } else if (curated.length > 0) {
    // End hold on the final tested frame if no valid design was found
    const last = gifFrames[gifFrames.length - 1];
    gifFrames.push({ rgba: last.rgba, delayMs: 1400 });
  }

  onProgress?.(82);
  await new Promise((r) => setTimeout(r, 0));

  const bytes = encodeGif(width, height, gifFrames, GIF_PINNED_RGB);
  onProgress?.(100);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
}
