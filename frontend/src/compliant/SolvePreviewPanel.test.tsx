import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CompliantSchematic } from './CompliantSchematic';
import { drawMechanismFrame } from './mechanismGif';
import { SolvePreviewPanel } from './SolvePreviewPanel';
import { curateGifTimeline } from './solvePreviewRenderer';
import {
  CARRIAGE_SPEED_MM_S, COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS, buildConstantSpeedCycle,
} from './types';
import type { CompliantResult, PreviewFrame, SolveJobState } from './types';

afterEach(cleanup);

function makeFrame(n: number, opts: { ok?: boolean; best?: boolean; reason?: string | null; dx?: number | null } = {}): PreviewFrame {
  const ok = opts.ok ?? false;
  const best = opts.best ?? false;
  return {
    n,
    t: n * 0.1,
    ok,
    best,
    reason: ok ? null : (opts.reason ?? 'stress'),
    dx: opts.dx ?? (ok ? 0.35 + n * 0.01 : 0.12),
    stress: ok ? 28 : 74,
    score: ok ? 1.2 + n * 0.05 : null,
    wall_x: 9.5,
    h0: 8,
    tube_od: 3,
    tube_id: 2,
    piv_off: 4,
    a: [-4.8, 0],
    j: [-5.5, 12],
    v: [4, 8],
    p: [-8.1, 10.5],
    hl: [-5.0, 4.0, -5.2, 8.0],
    hr: [-2.0, 10.8, 1.0, 9.2],
    hf: [-6.4, 11.4, -7.2, 10.9],
    th: [1.0, 0.9, 1.0],
  };
}

function makeJob(status: SolveJobState['status']): SolveJobState {
  const frames = [
    makeFrame(1, { ok: false, reason: 'stress' }),
    makeFrame(2, { ok: true, best: true, dx: 0.38 }),
    makeFrame(3, { ok: false, reason: 'tube' }),
    makeFrame(4, { ok: true, best: false, dx: 0.34 }),
    makeFrame(5, { ok: true, best: true, dx: 0.44 }),
  ];
  return {
    job_id: 'job-test-1',
    experiment_id: 'job-test-1',
    name: 'Test experiment',
    note: '',
    status,
    goal: 'dx_at_025',
    method: 'hybrid',
    time_budget_s: 10,
    found: status === 'completed',
    params: null,
    result: null,
    runners: [],
    message: 'ok',
    error: null,
    summary: {
      phase: status === 'running' ? 'Wave 1: Global LHS' : 'Final verification',
      wave: 1,
      method: 'hybrid',
      goal: 'dx_at_025',
      tested: 5,
      feasible: 3,
      rejected: 2,
      elapsed_s: status === 'running' ? 2.5 : 10,
      time_budget_s: 10,
      progress: status === 'running' ? 0.25 : 1,
      evals_per_sec: 50,
      best_score: 1.45,
      best_dx_at_025_mm: 0.44,
      best_slope: 8.2,
      best_y_90_mm: 0.85,
      best_stress_mpa: 28,
      rejection_stats: [],
      bound_hits: [],
      free_vars: ['anchor_distance'],
      fixed_vars: [],
      pivot_sides: [false],
      active_constraints: {
        member_strength_mpa: 40,
        min_shell_clearance_mm: 0.05,
        min_pivot_clearance_mm: 0.05,
        pinch_ceiling_margin_mm: 2,
        pinch_floor_margin_mm: 1,
        max_rotation_deg: 15,
        stroke_fixed: true,
        stroke_mm: 1.5,
      },
      coverage: [],
      scatter: [],
      convergence: [
        { t: 0.2, tested: 2, score: 1.3, dx_025: 0.38, slope: 7.5 },
        { t: 0.5, tested: 5, score: 1.45, dx_025: 0.44, slope: 8.2 },
      ],
      runners: [],
      preview_frames: frames,
      preview_timeline: status === 'completed' ? frames : undefined,
      best_preview: frames[4],
    },
  };
}

describe('curateGifTimeline', () => {
  it('assigns adaptive delays: rejected < valid < best in chronological order', () => {
    const timeline = [
      makeFrame(1, { ok: false }),
      makeFrame(2, { ok: true, best: true }),
      makeFrame(3, { ok: false }),
      makeFrame(4, { ok: true, best: false }),
      makeFrame(5, { ok: true, best: true }),
    ];
    const curated = curateGifTimeline(timeline);
    expect(curated.map((c) => c.frame.n)).toEqual([1, 2, 3, 4, 5]);
    const rejectedDelay = curated[0].delayMs;
    const validDelay = curated[3].delayMs;
    const bestDelay = curated[1].delayMs;
    expect(rejectedDelay).toBeLessThan(validDelay);
    expect(validDelay).toBeLessThan(bestDelay);
  });
});

describe('SolvePreviewPanel', () => {
  it('hides Download GIF while running and enables it once completed', () => {
    const { rerender } = render(<SolvePreviewPanel job={makeJob('running')} />);
    expect(screen.getByTestId('solve-preview-panel')).toBeTruthy();
    expect(screen.getByText('Tested configurations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download GIF/i })).toBeNull();

    rerender(<SolvePreviewPanel job={makeJob('completed')} />);
    const btn = screen.getByRole('button', { name: /Download GIF/i }) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Replay/i })).toBeTruthy();
  });
});

function makeMinimalResult(): CompliantResult {
  const mkLine = (x0: number, y0: number, x1: number, y1: number, thickness: number) => ({
    x: [x0, (x0 + x1) / 2, x1],
    y: [y0, (y0 + y1) / 2, y1],
    x_per_y: [0, 0.2, 0.4],
    y_per_y: [0, 0.1, 0.2],
    x_per_n: [0, 0, 0],
    y_per_n: [0, 0, 0],
    thickness,
  });
  return {
    feasible: true,
    passes: true,
    message: 'ok',
    Y_positions: [-1.5, 0, 1.5],
    flow_a: [0, 0, 10],
    flow_b: [10, 0, 0],
    gap_a: [0.4, 0.5, 2.2],
    gap_b: [2.2, 0.5, 0.4],
    flow_slope_mean: 6.5,
    flow_slope_max: 8.0,
    max_stress_mpa: 25,
    stress_margin: 1.6,
    plastic_ok: true,
    shell_ok: true,
    pivot_ok: true,
    shell_clearance_mm: 0.8,
    pivot_clearance_mm: 1.2,
    max_rotation_deg: 9,
    wall_x: 9.5,
    pivot_height_y0: 8,
    pinch_x: -8.1,
    pinch_contact_x: -8.6,
    travel_sign: 1,
    force_a: [5, 2, 0],
    force_b: [0, 2, 5],
    lines: {
      l: mkLine(-4.8, 0, -5.5, 12, 1.0),
      r: mkLine(-5.5, 12, 4, 8, 0.9),
      f: mkLine(-5.5, 12, -8.1, 10.5, 1.0),
    },
    anchor: [-4.8, 0],
    junction: [-5.5, 12],
    pinch: [-8.1, 10.5],
    pivot: [4, 8],
    attack_angle_deg: 12,
  };
}

describe('Mechanism GIF export', () => {
  it('draws detail labels only when includeDetails is true and never spline nodes', () => {
    const texts: string[] = [];
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((t: string) => texts.push(t)),
    } as unknown as CanvasRenderingContext2D;

    const result = makeMinimalResult();
    drawMechanismFrame(mockCtx, 520, 440, {
      params: COMPLIANT_DEFAULTS,
      result,
      constraints: DEFAULT_CONSTRAINTS,
      tubeSweep: null,
      yPose: 0.5,
      includeDetails: false,
      includeParticles: false,
      particlePhaseA: 0,
      particlePhaseB: 0,
    });
    expect(texts).toHaveLength(0);

    drawMechanismFrame(mockCtx, 520, 440, {
      params: COMPLIANT_DEFAULTS,
      result,
      constraints: DEFAULT_CONSTRAINTS,
      tubeSweep: null,
      yPose: 0.5,
      includeDetails: true,
      includeParticles: false,
      particlePhaseA: 0,
      particlePhaseB: 0,
    });
    expect(texts.some((t) => t.startsWith('h₀'))).toBe(true);
    expect(texts.some((t) => t.startsWith('gap'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Y ='))).toBe(true);
    expect(texts.some((t) => t === 'A' || t === 'J' || t === 'P')).toBe(false);
  });

  it('opens the Mechanism GIF popover with Include details toggle in CompliantSchematic', () => {
    render(
      <CompliantSchematic
        params={COMPLIANT_DEFAULTS}
        result={makeMinimalResult()}
        constraints={DEFAULT_CONSTRAINTS}
        yPose={0}
        playing={false}
        loadedRpm={85}
        carriageSpeed={0.7}
        tubeSweep={null}
        tubeStale={false}
        error={null}
        onYChange={() => {}}
        onTogglePlay={() => {}}
        onCenter={() => {}}
        onSetShape={() => {}}
        onPatchParams={() => {}}
      />,
    );
    const gifBtn = screen.getByRole('button', { name: /^GIF$/i });
    fireEvent.click(gifBtn);
    const checkbox = screen.getByLabelText(/Include details/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole('button', { name: /Download GIF/i })).toBeTruthy();
  });

  it('samples constant-speed carriage cycles at exact real carriage speed', () => {
    const stroke = 1.5;
    const speed = CARRIAGE_SPEED_MM_S; // 0.70833 mm/s
    const steps = buildConstantSpeedCycle(stroke, speed, 120);
    expect(steps.length % 4).toBe(0);

    const q = steps.length / 4;
    expect(steps[0].y).toBeCloseTo(0, 6);
    expect(steps[q].y).toBeCloseTo(stroke, 6);
    expect(steps[2 * q].y).toBeCloseTo(0, 6);
    expect(steps[3 * q].y).toBeCloseTo(-stroke, 6);

    // Every single frame advances by the exact same |Δy| (constant velocity, no easing)
    const expectedStep = (4 * stroke) / steps.length;
    for (let i = 0; i < steps.length; i++) {
      const nextY = steps[(i + 1) % steps.length].y;
      expect(Math.abs(nextY - steps[i].y)).toBeCloseTo(expectedStep, 5);
    }

    // Total GIF duration equals real physical cycle time 4*stroke/speed within 10 ms (1 cs)
    const totalMs = steps.reduce((acc, s) => acc + s.delayMs, 0);
    const expectedMs = ((4 * stroke) / speed) * 1000;
    expect(Math.abs(totalMs - expectedMs)).toBeLessThanOrEqual(10);
  });
});

