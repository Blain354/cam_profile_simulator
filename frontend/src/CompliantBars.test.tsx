import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import CompliantBars from './CompliantBars';
import { SolverModal } from './compliant/SolverModal';
import { SolverGoalBudgetControls } from './compliant/CompliantControls';
import {
  COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS, DEFAULT_SOLVER_GOAL_CONFIG, DEFAULT_SOLVER_METHOD_CONFIG,
  activeStallY, allowableStressMpa, anchorPoint, deflected, deflectedPoint, fromCompliantProfilePayload,
  isCarriageStalled, memberChords, physicalCarriageY, pinchContactX, pinchX,
  screwThrustAvailableN,
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
  expect(body.method).toBe('cmaes');
});

test('right-hand panel renders the uniform multi-chart grid layout', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  const { getByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);

  expect(getByText('Static flow vs carriage Y')).toBeTruthy();
  expect(getByText('Pinch gap vs carriage Y')).toBeTruthy();
  expect(getByText('Pinch force vs carriage Y')).toBeTruthy();
  expect(getByText('Motor torque vs carriage Y')).toBeTruthy();
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

test('Spline bounds Anchor card enables Symmetric (±) by default and displays both mirrored intervals', () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
  const { getByText, getByLabelText } = render(<CompliantBars mode="finder" onOpenExplorer={() => {}} />);

  fireEvent.click(getByText('Spline bounds'));
  const minInput = getByLabelText('Anchor (A) min') as HTMLInputElement;
  const maxInput = getByLabelText('Anchor (A) max') as HTMLInputElement;
  const symToggle = getByLabelText('Symmetric anchor range around center') as HTMLInputElement;

  expect(symToggle.checked).toBe(true);
  fireEvent.change(minInput, { target: { value: '2.5' } });
  fireEvent.change(maxInput, { target: { value: '5.8' } });

  expect(getByText('[-5.8..-2.5] & [2.5..5.8]')).toBeTruthy();
});

test('SolverGoalBudgetControls has no max budget cap and cycles s / min / h via adjacent unit button', () => {
  const onChange = vi.fn();
  const { getByLabelText, getByText, rerender } = render(
    <SolverGoalBudgetControls
      goalConfig={DEFAULT_SOLVER_GOAL_CONFIG}
      timeBudgetS={60}
      onGoalConfigChange={() => {}}
      onTimeBudgetChange={onChange}
    />,
  );

  // Initial 60s decomposes to "1" with unit "min" and has no max attribute.
  const input = getByLabelText('Time budget (min)') as HTMLInputElement;
  const unitBtn = getByLabelText('Change time budget unit');
  expect(input.value).toBe('1');
  expect(input.getAttribute('max')).toBeNull();
  expect(unitBtn.textContent).toBe('min');

  // Cycling unit from min -> h keeps value 1 and emits 3600s.
  fireEvent.click(unitBtn);
  expect(unitBtn.textContent).toBe('h');
  expect(onChange).toHaveBeenLastCalledWith(3600);

  // Entering 12 h emits 43200s without clamping to 3600s.
  fireEvent.change(getByLabelText('Time budget (h)'), { target: { value: '12' } });
  expect(onChange).toHaveBeenLastCalledWith(43200);

  // Cycling h -> s emits 12s.
  fireEvent.click(unitBtn);
  expect(unitBtn.textContent).toBe('s');
  expect(onChange).toHaveBeenLastCalledWith(12);

  // Clicking a preset syncs input value and unit.
  fireEvent.click(getByText('5 min'));
  expect(onChange).toHaveBeenLastCalledWith(300);
  rerender(
    <SolverGoalBudgetControls
      goalConfig={DEFAULT_SOLVER_GOAL_CONFIG}
      timeBudgetS={300}
      onGoalConfigChange={() => {}}
      onTimeBudgetChange={onChange}
    />,
  );
  expect((getByLabelText('Time budget (min)') as HTMLInputElement).value).toBe('5');
  expect(unitBtn.textContent).toBe('min');
});

test('SolverGoalBudgetControls offers Max Pass freq / BW (-3 dB) goal and renders schematic difference tooltip', () => {
  const onGoalChange = vi.fn();
  const { getByLabelText, getByText, getByRole, queryByRole } = render(
    <SolverGoalBudgetControls
      goalConfig={DEFAULT_SOLVER_GOAL_CONFIG}
      timeBudgetS={60}
      onGoalConfigChange={onGoalChange}
      onTimeBudgetChange={() => {}}
    />,
  );

  // The new goal is listed and toggleable.
  const goalLabel = getByText('Max Pass freq / BW (-3 dB)');
  expect(goalLabel).toBeTruthy();
  fireEvent.click(goalLabel);
  expect(onGoalChange).toHaveBeenCalledWith(
    expect.objectContaining({
      selected: ['dx_at_025', 'pass_freq_bw'],
    }),
  );

  // Clicking the info icon opens the portal tooltip with an inline SVG schematic explaining the difference.
  expect(queryByRole('tooltip')).toBeNull();
  const infoBtn = getByLabelText('Explain Pass freq / BW vs other goals');
  fireEvent.click(infoBtn);
  const tooltip = getByRole('tooltip');
  expect(tooltip.querySelector('svg')).toBeTruthy();
  expect(tooltip.textContent).toContain('f_pass = 1 / (2·T₁₀₀)');
  expect(tooltip.textContent).toContain('BW(-3dB) = 0.35/T₁₀₀');
  expect(tooltip.textContent).toContain('Why this goal is different:');
});

test('screwThrustAvailableN matches 60-degree M3x0.5 power-screw limit and motor/energy controls wire through to solve payload', async () => {
  expect(screwThrustAvailableN(COMPLIANT_DEFAULTS)).toBeCloseTo(54.12, 1);

  const solveBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/compliant/solve/jobs')) {
      solveBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          job_id: 'job-energy', experiment_id: 'job-energy', name: 'Energy Solve', note: '',
          status: 'completed', goal: 'min_energy', time_budget_s: 60,
          summary: null, found: false, params: null, result: null, runners: [], message: 'ok', error: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { getByRole, getByText } = render(<CompliantBars mode="finder" onOpenExplorer={() => {}} />);

  // Fixed: motor & screw accordion is present and opens with motor torque + screw controls.
  fireEvent.click(getByRole('button', { name: 'Fixed: motor & screw' }));
  expect(getByText('Motor torque (mN·m)')).toBeTruthy();
  expect(getByText('Screw Ø (mm)')).toBeTruthy();
  expect(getByText('Lead screw pitch (mm/rev)')).toBeTruthy();

  // Motor-limited stress is checked by default; hard no-stall rejection is off by default (stall caps stroke/performance).
  const motorStressCb = getByRole('checkbox', { name: /Motor-limited stress/ }) as HTMLInputElement;
  const noStallCb = getByRole('checkbox', { name: /No motor stall inside ±stroke/ }) as HTMLInputElement;
  expect(motorStressCb.checked).toBe(true);
  expect(noStallCb.checked).toBe(false);

  // Open Solve setup modal, select Min actuation energy (unselecting default), and launch.
  fireEvent.click(getByRole('button', { name: /Solve…/ }));
  fireEvent.click(getByText('Min actuation energy'));
  fireEvent.click(getByText('Max ΔX @ Y = 0.25 mm'));
  fireEvent.click(getByRole('button', { name: /Launch Solve/ }));

  await waitFor(() => expect(solveBodies.length).toBe(1));
  const body = solveBodies[0] as {
    goal: string;
    params: Record<string, number>;
    constraints: Record<string, unknown>;
  };
  expect(body.goal).toBe('min_energy');
  expect(body.params.motor_torque_mnm).toBe(30);
  expect(body.constraints.motor_limited_stress).toBe(true);
  expect(body.constraints.require_no_stall_in_stroke).toBe(false);
});

test('Results accordion displays peak thrust, cycle energy, stall Y, and yield Y, and SolverModal ranks by Low energy', async () => {
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
        Y_positions: [-1.0, 0, 1.0],
        flow_a: [0, 0, 10], flow_b: [10, 0, 0],
        gap_a: [0.4, 0.85, 2.1], gap_b: [2.1, 0.92, 0.4],
        gap_rigid_a: [0.4, 0.85, 2.1],
        closed_gap: 0.9, full_open_gap: 2.0,
        flow_slope_mean: 5, flow_slope_max: 7,
        max_stress_mpa: 60.2, stress_margin: 1.25,
        plastic_ok: true, motor_ok: true, shell_ok: true, pivot_ok: true, pinch_ok: true, rotation_ok: true,
        shell_clearance_mm: 1, pivot_clearance_mm: 1, pinch_ceiling_margin_mm: 5.5, max_rotation_deg: 5,
        wall_x: 9.5, pivot_height_y0: 8, pinch_x: -8.1, travel_sign: 1,
        force_a: [12.3, 4.56, 0.2], force_b: [0.2, 6.78, 12.3],
        thrust: [35.1, 0, 35.1],
        stress_a: [20, 10, 5], stress_b: [5, 10, 20],
        lines: { l: line, r: line, f: line },
        anchor: [-4.8, 0], junction: [-5.5, 12], pinch: [-8.1, 10.5], pivot: [4, 8],
        thrust_available_n: 54.1,
        peak_thrust_op_n: 35.1,
        peak_torque_op_mnm: 19.5,
        energy_cycle_mj: 215.4,
        stall_y_mm: 1.49,
        yield_y_mm: 1.57,
        thrust_to_yield_n: 57.8,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByText, getByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);
  expect(await findByText('35.1 N · 19.5 mN·m')).toBeTruthy();
  expect(getByText('215.4 mJ')).toBeTruthy();
  expect(getByText('±1.49 mm (54.1 N)')).toBeTruthy();
  expect(getByText('±1.57 mm (57.8 N)')).toBeTruthy();

  cleanup();

  // Verify SolverModal live re-ranking promotes lowest-energy runner when clicking "Low energy".
  const makeRunner = (idx: number, dx: number, energy: number, thrust: number): Runner => ({
    score: 10 - idx,
    dx_at_025_mm: dx,
    slope: 10,
    y_90_mm: 0.5,
    y_open_mm: 0.1,
    max_stress_mpa: 40,
    max_rotation_deg: 6,
    attack_angle_deg: 0,
    shell_clearance_mm: 0.4,
    pivot_clearance_mm: 0.35,
    pinch_ceiling_margin_mm: 5.5,
    energy_cycle_mj: energy,
    peak_thrust_op_n: thrust,
    stall_y_mm: 1.4,
    motor_ok: true,
    stroke: 1.0,
    pivot_inverted: false,
    params: { ...COMPLIANT_DEFAULTS, anchor_distance: 4.5 + idx * 0.3 },
  });
  const runners = [
    makeRunner(0, 0.35, 420, 38.0),
    makeRunner(1, 0.22, 85, 11.2),
  ];
  const job: SolveJobState = {
    job_id: 'exp-energy-rank',
    experiment_id: 'exp-energy-rank',
    name: 'Energy Ranking Test',
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
  const modal = render(
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
      spaceSummary={{ freeCount: 5, lockedCount: 15, pivotBoth: false }}
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
  expect(modal.getByTestId('best-solution-card-1').textContent).toContain('420 mJ');
  fireEvent.click(modal.getByRole('button', { name: 'Low energy' }));
  expect(modal.getByTestId('best-solution-card-1').textContent).toContain('85 mJ');
});

test('pinchContactX uses FEM h_sealed and preload, independent of mechanism nodes, and deflected stays locked at Y=0', () => {
  expect(COMPLIANT_DEFAULTS.tube_model).toBe('fem');
  const femSweep = { h_sealed: 0.78 };
  const base = { ...COMPLIANT_DEFAULTS, tube_model: 'fem' as const, tube_center_x: 8, tube_od: 3, preload: 0.12 };
  const expectedContactX = (0.78 - 0.12) - (8 + 1.5);
  expect(pinchContactX(base, femSweep)).toBeCloseTo(expectedContactX, 6);
  expect(pinchX(base, femSweep)).toBeCloseTo(expectedContactX + base.f_thickness / 2, 6);

  // Dragging mechanism nodes / handles / pinch_y / thicknesses does not change pinchContactX.
  const dragged = {
    ...base,
    anchor_distance: 2.1,
    junction_x: -3.2,
    junction_y: 14.5,
    pinch_y: 6.4,
    l_v1: 2.5,
    f_v2: -1.7,
    f_thickness: 1.9,
  };
  expect(pinchContactX(dragged, femSweep)).toBeCloseTo(expectedContactX, 6);
  expect(pinchX(dragged, femSweep)).toBeCloseTo(expectedContactX + 1.9 / 2, 6);

  // At Y = 0 with force = force_y0, deflected() and deflectedPoint() stay strictly at the Y = 0 pinch coordinates.
  const line = {
    x: [-5.5, expectedContactX + 0.5],
    y: [12, 10.5],
    x_per_y: [0.2, 0.8],
    y_per_y: [0.1, -0.05],
    x_per_n: [0.02, 0.09],
    y_per_n: [0.01, 0.03],
    force_y0: 4.2,
    thickness: 1.0,
  };
  const atY0 = deflected(line, 0, 4.2);
  expect(atY0[1][0]).toBeCloseTo(expectedContactX + 0.5, 9);
  expect(atY0[1][1]).toBeCloseTo(10.5, 9);
  expect(deflectedPoint(line, 1, 0, 4.2)).toEqual([expectedContactX + 0.5, 10.5]);
});

test('schematic keeps valid viewBox and h0 when backend returns an empty failed result (e.g. FEM ballooning)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/simulate')) {
      return new Response(JSON.stringify({
        feasible: false,
        passes: false,
        message: 'Tube FEM: ballooning',
        Y_positions: [],
        flow_a: [], flow_b: [], gap_a: [], gap_b: [], gap_rigid_a: [],
        force_a: [], force_b: [], stress_a: [], stress_b: [],
        wall_x: 0, pivot_height_y0: 0, anchor_x: 0, pivot_x: 0, pinch_x: 0, pinch_contact_x: 0,
        travel_sign: 1, lines: {}, handles: {},
        anchor: [0, 0], junction: [0, 0], pinch: [0, 0], pivot: [0, 0],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);
  expect(await findByText('Tube FEM: ballooning')).toBeTruthy();
  const svg = document.querySelector('svg[aria-label="Compliant bars"]');
  expect(svg).toBeTruthy();
  const vb = (svg?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
  // Must use params fallback (wall = 9.5, ceiling = 16) rather than collapsing to 4x4 around 0.
  expect(vb[2]).toBeGreaterThan(15);
  expect(vb[3]).toBeGreaterThan(15);
  expect(svg?.textContent).toContain('h₀ 8.00');
  expect(svg?.textContent).not.toContain('h₀ 0.00');
});

test('fromCompliantProfilePayload migrates legacy v1 max_y0_flex_mm=0.05 and require_no_stall_in_stroke defaults', () => {
  const legacy = fromCompliantProfilePayload({
    constraints: { max_y0_flex_mm: 0.05, require_no_stall_in_stroke: true },
  });
  expect(legacy.constraints.max_y0_flex_mm).toBe(0);
  expect(legacy.constraints.require_no_stall_in_stroke).toBe(false);
  expect(legacy.constraints.constraints_version).toBe(2);

  // Explicit v2 user choices are preserved.
  const v2 = fromCompliantProfilePayload({
    constraints: { constraints_version: 2, max_y0_flex_mm: 0.12, require_no_stall_in_stroke: true },
  });
  expect(v2.constraints.max_y0_flex_mm).toBe(0.12);
  expect(v2.constraints.require_no_stall_in_stroke).toBe(true);
});

test('carriage stall helpers clamp physical Y to ±stallY only outside the non-stall zone', () => {
  expect(activeStallY({ stall_y_mm: 0.65 }, { motor_limited_stress: true }, 1.5)).toBeCloseTo(0.65, 6);
  expect(activeStallY({ stall_y_mm: 1.8 }, { motor_limited_stress: true }, 1.5)).toBeNull();
  expect(activeStallY({ stall_y_mm: 0.65 }, { motor_limited_stress: false }, 1.5)).toBeNull();

  // Inside (-0.65, +0.65): carriage follows commanded Y normally and is not stalled.
  expect(isCarriageStalled(0.4, 0.65)).toBe(false);
  expect(physicalCarriageY(0.4, 0.65)).toBeCloseTo(0.4, 6);
  expect(isCarriageStalled(-0.4, 0.65)).toBe(false);
  expect(physicalCarriageY(-0.4, 0.65)).toBeCloseTo(-0.4, 6);

  // Outside ±0.65: carriage freezes at ±0.65 and flags stalled = true.
  expect(isCarriageStalled(1.2, 0.65)).toBe(true);
  expect(physicalCarriageY(1.2, 0.65)).toBeCloseTo(0.65, 6);
  expect(isCarriageStalled(-1.2, 0.65)).toBe(true);
  expect(physicalCarriageY(-1.2, 0.65)).toBeCloseTo(-0.65, 6);
});

test('carriage oscillation keeps running across ±stroke while clamping carriage red at ±stallY in the stall zone', async () => {
  const line = {
    x: [-8, -6], y: [10, 10.5],
    x_per_y: [0, 0.2], y_per_y: [0, 0],
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
        plastic_ok: true, motor_ok: true, flow_ok: true, shell_ok: true, pivot_ok: true, pinch_ok: true, rotation_ok: true,
        shell_clearance_mm: 1, pivot_clearance_mm: 1, pinch_ceiling_margin_mm: 5.5, max_rotation_deg: 5,
        wall_x: 9.5, pivot_height_y0: 8, pinch_x: -8.1, travel_sign: 1,
        force_a: [12.3, 4.56, 0.2], force_b: [0.2, 6.78, 12.3],
        stress_a: [20, 10, 5], stress_b: [5, 10, 20],
        stall_y_mm: 0.65, effective_stroke_mm: 0.65,
        lines: { l: line, r: line, f: line },
        anchor: [-4.8, 0.5], junction: [-5.5, 12], pinch: [-8.1, 10.5], pivot: [4, 8],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextRafId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const idx = rafQueue.findIndex((item) => item.id === id);
    if (idx >= 0) rafQueue.splice(idx, 1);
  });

  const { container, findByText, getByLabelText, getByRole, queryByText } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);
  expect(await findByText('gap 0.850, 4.56 N')).toBeTruthy();

  const carriage = () => container.querySelector('polygon[data-carriage="main"]')!;
  const slider = () => getByLabelText('Carriage Y') as HTMLInputElement;
  expect(carriage().getAttribute('data-stalled')).toBe('false');
  expect(queryByText(/Motor stalled/)).toBeNull();

  // Start oscillating from Y = 0; advance frames past Y = 0.65 mm into the stall zone (around Y ≈ 1.13 mm).
  const oscBtn = getByRole('button', { name: /Oscillate/ });
  fireEvent.click(oscBtn);
  expect(oscBtn.getAttribute('aria-pressed')).toBe('true');

  let t = 0;
  const advanceFrames = (count: number, stepMs = 100) => {
    for (let i = 0; i < count && rafQueue.length > 0; i++) {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const item of batch) item.cb(t);
      t += stepMs;
    }
  };

  // At ~0.708 mm/s, 17 frames * 100 ms ≈ 1.13 mm (well past +0.65 stall, before +1.5 peak).
  advanceFrames(17, 100);

  await waitFor(() => {
    expect(carriage().getAttribute('data-stalled')).toBe('true');
  });
  // Animation keeps running across ±stroke; slider is past 0.65 while physical carriage is held at +0.65 in red.
  expect(getByRole('button', { name: /Stop/ }).getAttribute('aria-pressed')).toBe('true');
  expect(parseFloat(slider().value)).toBeGreaterThan(0.9);
  expect(carriage().getAttribute('data-actual-y')).toBe('0.6500');
  expect(carriage().getAttribute('fill')).toBe('#ef4444');
  expect(container.textContent).toContain('Motor stalled · held at +0.65 mm');
  expect(container.querySelector('[data-layer="stall-indicator"]')?.textContent).toContain('Stall · max torque');

  // Advance until the triangle wave turns around at +1.5 and re-enters (-0.65, +0.65) (around d ≈ 2.65 mm -> Y ≈ +0.35 mm).
  advanceFrames(21, 100);

  await waitFor(() => {
    expect(carriage().getAttribute('data-stalled')).toBe('false');
  });
  expect(getByRole('button', { name: /Stop/ }).getAttribute('aria-pressed')).toBe('true');
  expect(Math.abs(parseFloat(carriage().getAttribute('data-actual-y')!))).toBeLessThan(0.65);
  expect(queryByText(/Motor stalled/)).toBeNull();
});

test('Ctrl+Z / Ctrl+Shift+Z undoes and redoes drag-and-drop edits on position nodes (A, J, P) and Bezier direction handles', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));

  const { container, getByRole } = render(<CompliantBars mode="explorer" onOpenExplorer={() => {}} />);
  const svg = container.querySelector('svg[aria-label="Compliant bars"]') as SVGSVGElement;
  expect(svg).toBeTruthy();

  // Mock identity SVG screen CTM so clientX/clientY map 1:1 to SVG coords (world x = clientX, world y = -clientY).
  (svg as unknown as { createSVGPoint: () => { x: number; y: number; matrixTransform: () => { x: number; y: number } } }).createSVGPoint = () => {
    const pt = { x: 0, y: 0, matrixTransform: () => ({ x: pt.x, y: pt.y }) };
    return pt;
  };
  (svg as unknown as { getScreenCTM: () => { inverse: () => object } }).getScreenCTM = () => ({ inverse: () => ({}) });

  const readStore = () => JSON.parse(localStorage.getItem('cam-sim.compliant.v1')!);
  const undoBtn = () => getByRole('button', { name: 'Undo node edit' }) as HTMLButtonElement;
  const redoBtn = () => getByRole('button', { name: 'Redo node edit' }) as HTMLButtonElement;

  expect(undoBtn().disabled).toBe(true);
  expect(redoBtn().disabled).toBe(true);

  const dragNode = (selector: string, points: [number, number][]) => {
    const el = svg.querySelector(selector)!;
    expect(el).toBeTruthy();
    fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, clientX: points[0][0], clientY: -points[0][1] }));
    for (let i = 1; i < points.length; i++) {
      fireEvent(svg, new MouseEvent('pointermove', { bubbles: true, clientX: points[i][0], clientY: -points[i][1] }));
    }
    fireEvent(svg, new MouseEvent('pointerup', { bubbles: true }));
  };

  // Click without moving should NOT push an undo step.
  dragNode('[data-drag-node="junction"]', [[-5.5, 12]]);
  expect(undoBtn().disabled).toBe(true);

  // 1) Drag Junction J across multiple pointerMove events -> coalesced into ONE undo step.
  const initJx = COMPLIANT_DEFAULTS.junction_x;
  const initJy = COMPLIANT_DEFAULTS.junction_y;
  dragNode('[data-drag-node="junction"]', [[-5.5, 12], [-4.5, 13], [-3.2, 14.5]]);
  expect(readStore().params.junction_x).toBeCloseTo(-3.2, 4);
  expect(readStore().params.junction_y).toBeCloseTo(14.5, 4);
  expect(undoBtn().disabled).toBe(false);

  // 2) Drag Bezier direction control handle L1 across multiple moves -> ONE undo step.
  const initLU1 = COMPLIANT_DEFAULTS.l_u1;
  const initLV1 = COMPLIANT_DEFAULTS.l_v1;
  dragNode('[data-drag-node="handle-l-1"]', [[-4, 5], [-2, 8], [-1.5, 9.5]]);
  const draggedLU1 = readStore().params.l_u1;
  const draggedLV1 = readStore().params.l_v1;
  expect(draggedLU1).not.toBeCloseTo(initLU1, 2);

  // 3) Drag Anchor A -> ONE undo step.
  const initAnchor = COMPLIANT_DEFAULTS.anchor_distance;
  dragNode('[data-drag-node="anchor"]', [[-4.8, 0.5], [-2.5, 0.5]]);
  expect(readStore().params.anchor_distance).toBeCloseTo(2.5, 4);

  // 4) Drag Pinch P -> updates both pinch_y and constraints.target_pinch_from_top_mm.
  const initPinchY = COMPLIANT_DEFAULTS.pinch_y;
  const initFromTop = DEFAULT_CONSTRAINTS.target_pinch_from_top_mm;
  dragNode('[data-drag-node="pinch"]', [[-8, 10.5], [-8, 12.2]]);
  expect(readStore().params.pinch_y).toBeCloseTo(12.2, 4);
  expect(readStore().constraints.target_pinch_from_top_mm).toBeCloseTo(3.8, 2);

  // Ctrl+Z inside a numeric/text input must NOT intercept schematic undo.
  const fakeTextInput = document.createElement('input');
  fakeTextInput.type = 'text';
  document.body.appendChild(fakeTextInput);
  fireEvent.keyDown(fakeTextInput, { key: 'z', ctrlKey: true });
  expect(readStore().params.pinch_y).toBeCloseTo(12.2, 4);
  document.body.removeChild(fakeTextInput);

  // Ctrl+Z #1: undoes Pinch P (restores both pinch_y and target_pinch_from_top_mm).
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.pinch_y).toBeCloseTo(initPinchY, 4);
  expect(readStore().constraints.target_pinch_from_top_mm).toBeCloseTo(initFromTop!, 2);
  expect(redoBtn().disabled).toBe(false);

  // Ctrl+Shift+Z redoes Pinch P, then Ctrl+Z undoes it again.
  fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
  expect(readStore().params.pinch_y).toBeCloseTo(12.2, 4);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.pinch_y).toBeCloseTo(initPinchY, 4);

  // Ctrl+Z #2: undoes Anchor A.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.anchor_distance).toBeCloseTo(initAnchor, 4);

  // Ctrl+Z #3: undoes Bezier handle L1.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.l_u1).toBeCloseTo(initLU1, 4);
  expect(readStore().params.l_v1).toBeCloseTo(initLV1, 4);

  // Ctrl+Y redoes Bezier handle L1, then Ctrl+Z undoes it again.
  fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
  expect(readStore().params.l_u1).toBeCloseTo(draggedLU1, 4);
  expect(readStore().params.l_v1).toBeCloseTo(draggedLV1, 4);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.l_u1).toBeCloseTo(initLU1, 4);

  // Ctrl+Z #4: undoes Junction J in a single step despite 3 drag points.
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(readStore().params.junction_x).toBeCloseTo(initJx, 4);
  expect(readStore().params.junction_y).toBeCloseTo(initJy, 4);
  expect(undoBtn().disabled).toBe(true);
});

test('SolverModal chart icon beside Apply opens interactive tabbed tooltip defaulting to Stress vs carriage Y', async () => {
  let simCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/simulate')) {
      simCalls += 1;
      return new Response(
        JSON.stringify({
          feasible: true,
          passes: true,
          message: 'ok',
          Y_positions: [-1.5, -0.75, 0, 0.75, 1.5],
          flow_a: [0, 0, 0, 12, 24],
          flow_b: [24, 12, 0, 0, 0],
          gap_a: [0.6, 0.7, 0.8, 1.8, 2.8],
          gap_b: [2.8, 1.8, 0.8, 0.7, 0.6],
          gap_rigid_a: [0.6, 0.7, 0.8, 1.9, 2.9],
          closed_gap: 0.8,
          full_open_gap: 2.8,
          flow_slope_mean: 16,
          flow_slope_max: 20,
          max_stress_mpa: 48,
          stress_margin: 0.64,
          plastic_ok: true,
          shell_ok: true,
          pivot_ok: true,
          shell_clearance_mm: 0.8,
          pivot_clearance_mm: 1.0,
          max_rotation_deg: 6,
          wall_x: 9.5,
          pivot_height_y0: 8,
          pinch_x: -7.5,
          travel_sign: 1,
          force_a: [4, 2, 1, 0.5, 0.2],
          force_b: [0.2, 0.5, 1, 2, 4],
          thrust: [8, 4, 2, 4, 8],
          thrust_available_n: 18,
          stall_y_mm: 1.85,
          stress_a: [45, 22, 5, 18, 48],
          stress_b: [48, 18, 5, 22, 45],
          overtravel_y: [-2.0, -1.5, 0, 1.5, 2.0],
          overtravel_stress_a: [68, 45, 5, 48, 70],
          overtravel_stress_b: [70, 48, 5, 45, 68],
          overtravel_force_a: [9, 4, 1, 0.2, 0.1],
          overtravel_force_b: [0.1, 0.2, 1, 4, 9],
          overtravel_thrust: [22, 8, 2, 8, 22],
          time_ms: [0, 200, 400],
          y_time: [0, 1.5, 0],
          flow_in_l_min: [0, 20, 0],
          flow_out_l_min: [0, 0, 18],
          chamber_kpa: [0, 100, 0],
          chamber_t50_ms: 80,
          chamber_t90_ms: 150,
          chamber_t100_ms: 200,
          chamber_cycle_freq_hz: 2.5,
          chamber_bandwidth_hz: 1.75,
          lines: {
            l: { x: [0, 1], y: [0, 1], x_per_y: [0, 0], y_per_y: [0, 0], x_per_n: [0, 0], y_per_n: [0, 0], thickness: 1 },
            r: { x: [1, 2], y: [1, 2], x_per_y: [0, 0], y_per_y: [0, 0], x_per_n: [0, 0], y_per_n: [0, 0], thickness: 1 },
            f: { x: [1, 0], y: [1, 2], x_per_y: [0, 0], y_per_y: [0, 0], x_per_n: [0, 0], y_per_n: [0, 0], thickness: 1 },
          },
          anchor: [-4.8, 0],
          junction: [-5.5, 12],
          pinch: [-7.5, 10.5],
          pivot: [4, 8],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const runner: Runner = {
    score: 0.9,
    slope: 16,
    dx_at_025_mm: 0.42,
    max_stress_mpa: 48,
    shell_clearance_mm: 0.8,
    pivot_clearance_mm: 1.0,
    stall_y_mm: 1.85,
    stroke: 1.5,
    params: { ...COMPLIANT_DEFAULTS, stroke: 1.5 },
  };
  const job: SolveJobState = {
    job_id: 'job-charts',
    experiment_id: 'exp-charts',
    name: 'Tooltip Charts Test',
    note: '',
    status: 'completed',
    goal: 'dx_at_025',
    time_budget_s: 60,
    summary: null,
    found: true,
    params: runner.params,
    result: null,
    runners: [runner],
    message: 'ok',
    error: null,
  };

  const { getByTestId, getByRole, queryByTestId } = render(
    <SolverModal
      open={true}
      modalMode="live"
      job={job}
      baseParams={COMPLIANT_DEFAULTS}
      constraints={DEFAULT_CONSTRAINTS}
      goalConfig={DEFAULT_SOLVER_GOAL_CONFIG}
      methodConfig={DEFAULT_SOLVER_METHOD_CONFIG}
      timeBudgetS={60}
      spaceSummary={{ freeCount: 4, lockedCount: 15, pivotBoth: false }}
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

  const card1 = getByTestId('best-solution-card-1');
  const chartBtn = card1.querySelector('button[aria-label="Inspect charts for solution #1"]')!;
  expect(chartBtn).toBeTruthy();
  expect(queryByTestId('runner-charts-tooltip-1')).toBeNull();

  // Hover opens the tooltip, fetches simulation once, and defaults to Stress vs carriage Y.
  fireEvent.mouseEnter(chartBtn);
  const tooltip = getByTestId('runner-charts-tooltip-1');
  await waitFor(() => expect(simCalls).toBe(1));
  expect(tooltip.textContent).toContain('Worst stress in the part vs carriage Y');
  expect(tooltip.textContent).toContain('Stroke ±1.50 mm');
  expect(tooltip.textContent).toContain('Stall ±1.85 mm (after stroke)');
  expect(tooltip.textContent).toContain('Safe 63.8 MPa · Break 75 MPa');
  expect(getByRole('tab', { name: 'Stress' }).getAttribute('aria-selected')).toBe('true');

  // Switching tabs displays every Explorer chart.
  fireEvent.click(getByRole('tab', { name: 'Flow' }));
  expect(tooltip.textContent).toContain('Static flow vs carriage Y');

  fireEvent.click(getByRole('tab', { name: 'Chamber' }));
  expect(tooltip.textContent).toContain('Chamber (10 mL): inflation & deflation');

  fireEvent.click(getByRole('tab', { name: 'Gap' }));
  expect(tooltip.textContent).toContain('Pinch gap vs carriage Y');

  fireEvent.click(getByRole('tab', { name: 'Force' }));
  expect(tooltip.textContent).toContain('Pinch force vs carriage Y');

  fireEvent.click(getByRole('tab', { name: 'Torque' }));
  expect(tooltip.textContent).toContain('Motor torque vs carriage Y');

  // Closing and re-hovering reuses cached simulation without re-fetching.
  fireEvent.click(getByRole('button', { name: 'Close chart preview' }));
  expect(queryByTestId('runner-charts-tooltip-1')).toBeNull();
  fireEvent.mouseEnter(chartBtn);
  expect(getByTestId('runner-charts-tooltip-1')).toBeTruthy();
  expect(simCalls).toBe(1);
});

test('CompliantBars reconnects to a server-side running session on mount and reports it to App', async () => {
  const runningJob: SolveJobState = {
    job_id: 'live-42',
    experiment_id: 'live-42',
    name: '[cmaes] max_flow (60s)',
    note: '',
    status: 'running',
    goal: 'max_flow',
    method: 'cmaes',
    time_budget_s: 60,
    summary: {
      phase: 'CMA-ES gen 4',
      wave: 1,
      method: 'cmaes',
      goal: 'max_flow',
      tested: 120,
      feasible: 9,
      rejected: 111,
      elapsed_s: 12.5,
      time_budget_s: 60,
      progress: 0.21,
      evals_per_sec: 9.6,
      best_score: 0.88,
      best_dx_at_025_mm: 0.34,
      best_slope: 8.2,
      best_y_90_mm: 0.65,
      best_attack_angle_deg: 2.1,
      best_stress_mpa: 44.0,
      rejection_stats: [],
      bound_hits: [],
      free_vars: ['anchor_distance'],
      fixed_vars: [],
      pivot_sides: [false],
      active_constraints: {
        member_strength_mpa: 75,
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
      convergence: [],
      runners: [],
    },
    found: false,
    params: null,
    result: null,
    runners: [],
    message: 'Running…',
    error: null,
  };

  sessionStorage.setItem('cam-sim.compliant.activeJobId', 'live-42');
  sessionStorage.setItem('cam-sim.compliant.liveModalOpen', '1');

  const onActiveJobChange = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/solve/jobs/active')) {
      return new Response(JSON.stringify({ active: runningJob }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/compliant/solve/jobs/live-42')) {
      return new Response(JSON.stringify(runningJob), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/compliant/experiments')) {
      return new Response(JSON.stringify({ experiments: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByRole } = render(
    <CompliantBars mode="finder" onOpenExplorer={() => {}} onActiveJobChange={onActiveJobChange} />,
  );

  // Live modal reopens automatically after refresh when it was open before.
  const dialog = await findByRole('dialog', { name: 'Compliant Bars Solver' });
  expect(dialog.textContent).toContain('[cmaes] max_flow (60s)');
  expect(dialog.textContent).toContain('Stop & keep best');
  expect(onActiveJobChange).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'live-42', status: 'running' }));
});

test('CompliantBars settles an interrupted session cleanly after a server restart', async () => {
  const interruptedJob: SolveJobState = {
    job_id: 'old-99',
    experiment_id: 'old-99',
    name: 'Before redeploy',
    note: '',
    status: 'interrupted',
    goal: 'dx_at_025',
    method: 'cmaes',
    time_budget_s: 60,
    summary: {
      phase: 'CMA-ES gen 8',
      wave: 1,
      method: 'cmaes',
      goal: 'dx_at_025',
      tested: 240,
      feasible: 11,
      rejected: 229,
      elapsed_s: 28.0,
      time_budget_s: 60,
      progress: 0.47,
      evals_per_sec: 8.5,
      best_score: 1.15,
      best_dx_at_025_mm: 0.31,
      best_slope: 7.4,
      best_y_90_mm: 0.72,
      best_attack_angle_deg: 1.5,
      best_stress_mpa: 48.0,
      rejection_stats: [],
      bound_hits: [],
      free_vars: ['anchor_distance'],
      fixed_vars: [],
      pivot_sides: [false],
      active_constraints: {
        member_strength_mpa: 75,
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
      convergence: [],
      runners: [],
    },
    found: true,
    params: { anchor_distance: 5.2 },
    result: null,
    runners: [],
    message: 'Interrupted by server restart — last saved checkpoint preserved.',
    error: null,
  };

  sessionStorage.setItem('cam-sim.compliant.activeJobId', 'old-99');
  sessionStorage.setItem('cam-sim.compliant.liveModalOpen', '1');

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/compliant/solve/jobs/active')) {
      return new Response(JSON.stringify({ active: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/compliant/solve/jobs/old-99')) {
      return new Response(JSON.stringify(interruptedJob), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/compliant/experiments')) {
      return new Response(JSON.stringify({ experiments: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { findByRole } = render(<CompliantBars mode="finder" onOpenExplorer={() => {}} />);
  const dialog = await findByRole('dialog', { name: 'Compliant Bars Solver' });
  expect(dialog.textContent).toContain('interrupted');
  expect(dialog.textContent).toContain('last saved checkpoint');
  expect(sessionStorage.getItem('cam-sim.compliant.activeJobId')).toBeNull();
});

test('anchor distance can be fixed in Spline bounds and pins bounds on Launch Solve', async () => {
  const solveBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/compliant/solve/jobs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      solveBodies.push(body);
      return new Response(JSON.stringify({
        job_id: 'anchor-fix-1',
        experiment_id: 'anchor-fix-1',
        name: 'anchor-fix',
        note: '',
        status: 'completed',
        created_at: '2026-11-23T00:00:00Z',
        started_at: '2026-11-23T00:00:00Z',
        finished_at: '2026-11-23T00:00:01Z',
        elapsed_s: 1,
        time_budget_s: 60,
        method: 'cmaes',
        goal: 'dx_at_025',
        goal_weights: { dx_at_025: 1 },
        summary: {
          tested: 1, feasible_count: 1, feasible_rate: 1, elapsed_s: 1,
          evals_per_sec: 1, best_score: 0.5, rejection_stats: [], bound_hits: [],
          free_vars: ['junction_x'], fixed_vars: ['anchor_distance'], pivot_sides: [false],
          active_constraints: {
            member_strength_mpa: 75, stress_limit_factor: 0.85, allowable_stress_mpa: 63.75,
            min_shell_clearance_mm: 0.05, min_pivot_clearance_mm: 0.05,
            pinch_ceiling_margin_mm: 2, pinch_floor_margin_mm: 1, max_rotation_deg: 15,
            stroke_fixed: true, stroke_mm: 1.5, anchor_fixed: true, anchor_symmetric: false,
          },
          coverage: [], scatter: [], convergence: [], runners: [],
        },
        found: false, params: null, result: null, runners: [], message: 'ok', error: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/compliant/solve/jobs/active')) {
      return new Response(JSON.stringify({ active: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/compliant/experiments')) {
      return new Response(JSON.stringify({ experiments: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const { getByRole, getByLabelText, queryByLabelText } = render(<CompliantBars mode="finder" onOpenExplorer={() => {}} />);

  fireEvent.click(getByRole('button', { name: 'Spline bounds' }));
  expect(getByLabelText('Anchor (A) min')).toBeTruthy();

  const fixCheckbox = getByRole('checkbox', { name: 'Fix anchor distance' }) as HTMLInputElement;
  expect(fixCheckbox.checked).toBe(false);
  fireEvent.click(fixCheckbox);
  expect(fixCheckbox.checked).toBe(true);
  expect(queryByLabelText('Anchor (A) min')).toBeNull();

  const fixedInput = getByLabelText('Fixed anchor distance') as HTMLInputElement;
  fireEvent.change(fixedInput, { target: { value: '3.25' } });

  fireEvent.click(getByRole('button', { name: /Solve…/ }));
  fireEvent.click(getByRole('button', { name: /Launch Solve/ }));
  await waitFor(() => expect(solveBodies.length).toBe(1));

  const body = solveBodies[0] as {
    params: { anchor_distance: number };
    bounds: Record<string, [number, number]>;
    constraints: { anchor_fixed?: boolean };
  };
  expect(body.params.anchor_distance).toBe(3.25);
  expect(body.bounds.anchor_distance).toEqual([3.25, 3.25]);
  expect(body.constraints.anchor_fixed).toBe(true);
});
