import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import CompliantBars from './CompliantBars';
import { SolverModal } from './compliant/SolverModal';
import {
  COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS, DEFAULT_SOLVER_GOAL_CONFIG, DEFAULT_SOLVER_METHOD_CONFIG,
  allowableStressMpa, anchorPoint, memberChords,
} from './compliant/types';
import type { Runner, SolveJobState } from './compliant/types';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('Load CAD values from Onshape updates tube_center_x and member_depth from measured endpoint', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/onshape/measured')) {
      return new Response(
        JSON.stringify({
          configured: true,
          values: [
            { key: 'tube_center_x', variable: 'pend_CALC_tube_center', label: 'Tube centre', unit: 'mm', value: 9.25 },
            { key: 'member_depth', variable: 'pend_bar_thickness', label: 'Depth, out of plane', unit: 'mm', value: 4.0 },
          ],
          api_calls: 2,
          part_studio_url: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/api/linkage/materials')) {
      return new Response(JSON.stringify({
        materials: [
          { name: 'PETG Basic (bamb)', modulus_mpa: 1950, strength_mpa: 75, builtin: true },
          { name: 'PETG Translucent (bamb)', modulus_mpa: 1610, strength_mpa: 68, builtin: true },
          { name: 'PLA Basic (bamb)', modulus_mpa: 2750, strength_mpa: 76, builtin: true },
          { name: 'ABS (bamb)', modulus_mpa: 1880, strength_mpa: 62, builtin: true },
        ],
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const { getByRole, findByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);
  fireEvent.click(getByRole('button', { name: /Load CAD values from Onshape/ }));

  expect(await findByText(/9\.2500 mm from #pend_CALC_tube_center/)).toBeTruthy();
  expect(await findByText(/4\.0000 mm from #pend_bar_thickness/)).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem('cam-sim.compliant.v1')!);
  expect(saved.params.tube_center_x).toBe(9.25);
  expect(saved.params.member_depth).toBe(4.0);
});

test('unchecking Fixed on a Context variable opens the Solver section with range and special constraint sliders and sends them to solve', async () => {
  const solveBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/compliant/solve/jobs')) {
      solveBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          job_id: 'job-1', experiment_id: 'job-1', name: 'Test Solve', note: '',
          status: 'completed', goal: 'dx_at_025', time_budget_s: 60,
          summary: null, found: false, params: null, result: null, runners: [], message: 'ok', error: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { getByRole, queryByRole, getByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  // Solver accordion is hidden while all context vars are fixed.
  expect(queryByRole('button', { name: 'Solver' })).toBeNull();

  // Open Context accordion and uncheck "Carriage height at closure".
  fireEvent.click(getByRole('button', { name: 'Context' }));
  const checkbox = getByRole('checkbox', { name: 'Fix Carriage height at closure' });
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  fireEvent.click(checkbox);
  expect((checkbox as HTMLInputElement).checked).toBe(false);

  // Solver accordion appears and opens with context ranges + special constraints.
  expect(getByRole('button', { name: 'Solver' }).getAttribute('aria-expanded')).toBe('true');
  expect(getByText('Context ranges')).toBeTruthy();
  expect(getByText('Special constraints')).toBeTruthy();
  expect(getByText('Pinch ceiling margin (mm)')).toBeTruthy();

  // Mandatory fixed parameters are in separate sections.
  expect(getByRole('button', { name: 'Fixed: pneumatic & CAD' })).toBeTruthy();
  expect(getByRole('button', { name: 'Fixed: material & hardware' })).toBeTruthy();

  // Clicking Run solver opens the setup modal; clicking Launch Solve sends the unlocked range, pinned stroke, method & constraints.
  fireEvent.click(getByRole('button', { name: /Run solver/ }));
  fireEvent.click(getByRole('button', { name: /Launch Solve/ }));
  await waitFor(() => expect(solveBodies.length).toBe(1));
  const body = solveBodies[0] as { bounds: Record<string, [number, number]>; constraints: Record<string, number>; method: string };
  expect(body.bounds.closed_carriage_height).toEqual([6, 12]);
  expect(body.bounds.stroke).toEqual([1.5, 1.5]);
  expect(body.constraints.pinch_ceiling_margin_mm).toBe(2.0);
  expect(body.method).toBe('hybrid');
});

test('right-hand panel renders the uniform multi-chart grid layout', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  const { getByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  expect(getByText('Static flow vs carriage Y')).toBeTruthy();
  expect(getByText('Pinch gap vs carriage Y')).toBeTruthy();
  expect(getByText('Pinch force vs carriage Y')).toBeTruthy();
  expect(getByText('Worst stress in the part vs carriage Y')).toBeTruthy();
});

test('Material selector lists the 4 Bambu Lab (bamb) materials with their XY bending modulus and strength', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  const { getByRole, getByLabelText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  fireEvent.click(getByRole('button', { name: 'Fixed: material & hardware' }));
  const select = getByLabelText('Material') as HTMLSelectElement;
  const options = Array.from(select.options).map((o) => o.textContent);
  expect(options).toEqual([
    'PETG Basic (bamb) (1.95 GPa, 75 MPa)',
    'PETG Translucent (bamb) (1.61 GPa, 68 MPa)',
    'PLA Basic (bamb) (2.75 GPa, 76 MPa)',
    'ABS (bamb) (1.88 GPa, 62 MPa)',
  ]);
  expect(select.value).toBe('PETG Basic (bamb)');

  fireEvent.change(select, { target: { value: 'PLA Basic (bamb)' } });
  const saved = JSON.parse(localStorage.getItem('cam-sim.compliant.v1')!);
  expect(saved.params.member_modulus_mpa).toBe(2750);
  expect(saved.params.member_strength_mpa).toBe(76);
});

test('schematic renders gap and lateral force overlays on both supply and exhaust tubes', async () => {
  const line = {
    x: [-8, -6], y: [10, 10.5],
    x_per_y: [0, 0], y_per_y: [0, 0],
    x_per_n: [0, 0], y_per_n: [0, 0],
    thickness: 1,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/simulate')) {
      return new Response(JSON.stringify({
        feasible: true, passes: true, message: 'ok',
        Y_positions: [-1.5, 0, 1.5],
        flow_a: [0, 0, 10], flow_b: [10, 0, 0],
        gap_a: [0.4, 0.85, 2.1], gap_b: [2.1, 0.92, 0.4],
        gap_rigid_a: [0.4, 0.85, 2.1],
        closed_gap: 0.9, full_open_gap: 2.0,
        flow_slope_mean: 5, flow_slope_max: 7,
        max_stress_mpa: 20, stress_margin: 2,
        plastic_ok: true, shell_ok: true, pivot_ok: true, pinch_ok: true, rotation_ok: true,
        shell_clearance_mm: 1, pivot_clearance_mm: 1, pinch_ceiling_margin_mm: 5.5, max_rotation_deg: 5,
        wall_x: 9.5, pivot_height_y0: 8, pinch_x: -8.1, travel_sign: 1,
        force_a: [12.3, 4.56, 0.2], force_b: [0.2, 6.78, 12.3],
        stress_a: [20, 10, 5], stress_b: [5, 10, 20],
        lines: { l: line, r: line, f: line },
        anchor: [-4.8, 0], junction: [-5.5, 12], pinch: [-8.1, 10.5], pivot: [4, 8],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByText, getByRole, queryByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  expect(await findByText('gap 0.850, 4.56 N')).toBeTruthy();
  expect(await findByText('gap 0.920, 6.78 N')).toBeTruthy();

  fireEvent.click(getByRole('button', { name: 'Hide details' }));
  expect(queryByText('gap 0.850, 4.56 N')).toBeNull();
  expect(queryByText('gap 0.920, 6.78 N')).toBeNull();
});

test('SolverModal shows only top 4 valid solutions, re-ranks via weight sliders, and animates miniature schematics with flow particles', async () => {
  const makeRunner = (
    idx: number,
    opts: { dx: number; slope: number; y90: number; stress: number; alpha: number },
  ): Runner => ({
    score: 10 - idx,
    dx_at_025_mm: opts.dx,
    slope: opts.slope,
    y_90_mm: opts.y90,
    y_open_mm: 0.1,
    max_stress_mpa: opts.stress,
    max_rotation_deg: 6.5,
    attack_angle_deg: opts.alpha,
    shell_clearance_mm: 0.4,
    pivot_clearance_mm: 0.35,
    pinch_ceiling_margin_mm: 5.5,
    stroke: 1.5,
    pivot_inverted: idx % 2 === 1,
    params: {
      ...COMPLIANT_DEFAULTS,
      anchor_distance: 4.5 + idx * 0.25,
      pivot_inverted: idx % 2 === 1,
    },
  });

  // 6 valid candidates; #5 has the lowest stress (8 MPa) so soloing "Low stress" should promote it to #1.
  const runners: Runner[] = [
    makeRunner(0, { dx: 0.34, slope: 11, y90: 0.55, stress: 38, alpha: 4 }),
    makeRunner(1, { dx: 0.31, slope: 12, y90: 0.50, stress: 34, alpha: -8 }),
    makeRunner(2, { dx: 0.28, slope: 13, y90: 0.45, stress: 30, alpha: 12 }),
    makeRunner(3, { dx: 0.25, slope: 14, y90: 0.40, stress: 26, alpha: 2 }),
    makeRunner(4, { dx: 0.21, slope: 18, y90: 0.30, stress: 8, alpha: 15 }),
    makeRunner(5, { dx: 0.19, slope: 9, y90: 0.65, stress: 39, alpha: -20 }),
  ];

  const job: SolveJobState = {
    job_id: 'exp-top4',
    experiment_id: 'exp-top4',
    name: 'Top-4 Ranking Test',
    note: '',
    status: 'completed',
    goal: 'dx_at_025',
    goal_weights: { dx_at_025: 1 },
    method: 'hybrid',
    time_budget_s: 30,
    summary: null,
    found: true,
    params: runners[0].params,
    result: null,
    runners,
    message: 'ok',
    error: null,
  };

  const line = {
    x: [-8, -6], y: [10, 10.5],
    x_per_y: [0, 0.2], y_per_y: [0, 0.1],
    x_per_n: [0, 0], y_per_n: [0, 0],
    thickness: 1,
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/simulate')) {
      return new Response(JSON.stringify({
        feasible: true, passes: true, message: 'ok',
        Y_positions: [-1.5, 0, 1.5],
        flow_a: [0, 0, 10], flow_b: [10, 0, 0],
        gap_a: [0.4, 0.85, 2.1], gap_b: [2.1, 0.92, 0.4],
        closed_gap: 0.9, full_open_gap: 2.0,
        flow_slope_mean: 11, flow_slope_max: 14,
        max_stress_mpa: 38, stress_margin: 1.05,
        plastic_ok: true, shell_ok: true, pivot_ok: true, pinch_ok: true, rotation_ok: true,
        shell_clearance_mm: 0.4, pivot_clearance_mm: 0.35, pinch_ceiling_margin_mm: 5.5, max_rotation_deg: 6.5,
        wall_x: 9.5, pivot_height_y0: 8, pinch_x: -8.1, travel_sign: 1,
        attack_angle_deg: 4,
        force_a: [10, 4, 0.2], force_b: [0.2, 4, 10],
        lines: { l: line, r: line, f: line },
        anchor: [-4.5, 0], junction: [-5.5, 12], pinch: [-8.1, 10.5], pivot: [4, 8],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const { container, getAllByTestId, getByTestId, getByRole, getByText } = render(
    <SolverModal
      open={true}
      modalMode="live"
      job={job}
      baseParams={COMPLIANT_DEFAULTS}
      constraints={DEFAULT_CONSTRAINTS}
      tubeSweep={null}
      goalConfig={DEFAULT_SOLVER_GOAL_CONFIG}
      methodConfig={DEFAULT_SOLVER_METHOD_CONFIG}
      timeBudgetS={30}
      spaceSummary={{ freeCount: 5, lockedCount: 15, pivotBoth: true }}
      onGoalConfigChange={() => {}}
      onMethodConfigChange={() => {}}
      onTimeBudgetChange={() => {}}
      onLaunch={() => {}}
      onSwitchToSetup={() => {}}
      onClose={() => {}}
      onCancel={() => {}}
      onApplyRunner={() => {}}
      onSaveMeta={async () => {}}
    />,
  );

  // Strictly 4 cards shown out of 6 runners.
  expect(getAllByTestId(/^best-solution-card-/).length).toBe(4);
  expect(getByText('Top 4 of 6')).toBeTruthy();

  // Initial #1 is the highest ΔX @ 0.25 candidate (0.340 mm).
  const card1 = getByTestId('best-solution-card-1');
  expect(card1.textContent).toContain('0.340 mm');
  expect(card1.textContent).toContain('α +4°');

  // Secondary translucent mechanism is rendered before primary solid mechanism in DOM order.
  const secLayer = card1.querySelector('[data-layer="mini-secondary"]');
  const priLayer = card1.querySelector('[data-layer="mini-primary"]');
  expect(secLayer).toBeTruthy();
  expect(priLayer).toBeTruthy();
  expect(secLayer!.compareDocumentPosition(priLayer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card1.querySelector('[data-layer="mini-attack-angle"]')).toBeTruthy();

  // Clicking "Low stress" solos that weight to 100% and promotes the 8 MPa candidate to #1.
  fireEvent.click(getByRole('button', { name: 'Low stress' }));
  expect(getByTestId('best-solution-card-1').textContent).toContain('8 MPa');

  // Clicking Play simulates the card's runner and mounts flow particles on the miniature schematic.
  const playBtn = getByTestId('best-solution-card-1').querySelector('button[aria-label="Play mechanism animation"]')!;
  fireEvent.click(playBtn);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/compliant\/simulate$/), expect.anything());
    expect(container.querySelector('[data-flow-particles="side"]')).toBeTruthy();
  });
});

test('anchorPoint places Member L anchor at y = l_thickness / 2 so its contour is tangent to the bottom surface', () => {
  const p = { ...COMPLIANT_DEFAULTS, anchor_distance: 5.2, l_thickness: 1.6 };
  const a = anchorPoint(p);
  expect(a[0]).toBeCloseTo(-5.2, 6);
  expect(a[1]).toBeCloseTo(0.8, 6);
  expect(a[1] - p.l_thickness / 2).toBeCloseTo(0, 6);
  expect(memberChords(p).l[0]).toEqual(a);
});

test('allowableStressMpa scales material strength by stress_limit_factor (default 0.85)', () => {
  expect(DEFAULT_CONSTRAINTS.stress_limit_factor).toBe(0.85);
  expect(allowableStressMpa(100, DEFAULT_CONSTRAINTS)).toBeCloseTo(85, 6);
  expect(allowableStressMpa(75, { ...DEFAULT_CONSTRAINTS, stress_limit_factor: 0.8 })).toBeCloseTo(60, 6);
});

test('Results accordion and Chamber chart display 0 -> 100% inflation time, pass frequency, and -3 dB bandwidth', async () => {
  const line = {
    x: [-8, -6], y: [10, 10.5],
    x_per_y: [0, 0], y_per_y: [0, 0],
    x_per_n: [0, 0], y_per_n: [0, 0],
    thickness: 1,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/simulate')) {
      return new Response(JSON.stringify({
        feasible: true, passes: true, message: 'ok',
        Y_positions: [-1.5, 0, 1.5],
        flow_a: [0, 0, 10], flow_b: [10, 0, 0],
        gap_a: [0.4, 0.85, 2.1], gap_b: [2.1, 0.92, 0.4],
        gap_rigid_a: [0.4, 0.85, 2.1],
        closed_gap: 0.9, full_open_gap: 2.0,
        flow_slope_mean: 5, flow_slope_max: 7,
        max_stress_mpa: 20, stress_margin: 2,
        plastic_ok: true, shell_ok: true, pivot_ok: true, pinch_ok: true, rotation_ok: true,
        shell_clearance_mm: 1, pivot_clearance_mm: 1, pinch_ceiling_margin_mm: 5.5, max_rotation_deg: 5,
        wall_x: 9.5, pivot_height_y0: 8, pinch_x: -8.1, travel_sign: 1,
        force_a: [12.3, 4.56, 0.2], force_b: [0.2, 6.78, 12.3],
        stress_a: [20, 10, 5], stress_b: [5, 10, 20],
        lines: { l: line, r: line, f: line },
        anchor: [-4.8, 0], junction: [-5.5, 12], pinch: [-8.1, 10.5], pivot: [4, 8],
        chamber_t50_ms: 578,
        chamber_t90_ms: 685,
        chamber_t100_ms: 735,
        chamber_cycle_freq_hz: 0.68,
        chamber_bandwidth_hz: 0.48,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByText, getByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  expect(await findByText('735 ms (0.73 s)')).toBeTruthy();
  expect(getByText('Inflate 0 → 100%')).toBeTruthy();
  expect(getByText('Pass freq / BW (-3 dB)')).toBeTruthy();
  expect(getByText('0.68 Hz / 0.48 Hz')).toBeTruthy();
  expect(getByText(/t100 735 ms · f 0\.68 Hz · BW 0\.48 Hz/)).toBeTruthy();
});
