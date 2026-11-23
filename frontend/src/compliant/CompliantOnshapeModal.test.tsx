import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { CompliantOnshapeModal } from './CompliantOnshapeModal';
import type { CompliantOnshapeReply } from './CompliantOnshapeModal';
import { COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS } from './types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string, status: 'new' | 'same' | 'update', current: string | null = null) =>
  ({ name, key: name, label: name, new_expression: '1 mm', current_expression: current, status, detail: '' });

const reply = (valid: boolean): CompliantOnshapeReply => ({
  tables: [
    { table_name: 'cam_sim_compliant', table_exists: true, table_created: false, element_id: 'E1', table_url: 'https://cad/e/E1',
      rows: [row('cb_junction_x', 'update', '2 mm'), row('cb_anchor_distance', 'same', '1 mm')] },
    { table_name: 'cam_sim_carriage', table_exists: false, table_created: false, element_id: null, table_url: null,
      rows: [row('carriage_pivot_offset', 'new')] },
    { table_name: 'cam_sim_pinch', table_exists: true, table_created: false, element_id: 'E3', table_url: null,
      rows: [row('pinch_preload', 'same', '1 mm')] },
  ],
  api_calls: 6,
  input_check: { configured: true, valid, error: null, part_studio_url: null,
    rows: [{ key: 'member_depth', variable: 'cb_member_depth', label: 'Depth, out of plane', unit: 'mm', value: 4, simulator: valid ? 4 : 3, ok: valid }] },
  cad_check: { configured: false, coherent: true, error: null, rows: [] },
});

function stub(valid: boolean) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    bodies.push({ url, ...(JSON.parse(String(init?.body ?? '{}'))) });
    return new Response(JSON.stringify(reply(valid)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return bodies;
}

test('shows the three tables and writes the ticked variables of all of them', async () => {
  const bodies = stub(true);
  const { findByText, getByRole, getByLabelText } = render(
    <CompliantOnshapeModal open onClose={() => {}} params={COMPLIANT_DEFAULTS} constraints={DEFAULT_CONSTRAINTS} onSyncMeasured={() => {}} />);
  expect(await findByText('cam_sim_compliant')).toBeTruthy();
  expect(await findByText('cam_sim_carriage')).toBeTruthy();
  expect(await findByText('cam_sim_pinch')).toBeTruthy();
  expect((getByLabelText('Write cb_anchor_distance') as HTMLInputElement).disabled).toBe(true);   // already equal
  fireEvent.click(getByRole('button', { name: /Write 2 variables/ }));
  await waitFor(() => expect(bodies.some((b) => String(b.url).endsWith('/api/compliant/onshape/apply'))).toBe(true));
  const apply = bodies.find((b) => String(b.url).endsWith('/api/compliant/onshape/apply'))!;
  expect(apply.names).toEqual(['cb_junction_x', 'carriage_pivot_offset']);
  expect(apply.constraints).toEqual(DEFAULT_CONSTRAINTS);
});

test('an export that does not start from the CAD values cannot be written', async () => {
  stub(false);
  const onSync = vi.fn();
  const { findByRole, getByRole } = render(
    <CompliantOnshapeModal open onClose={() => {}} params={COMPLIANT_DEFAULTS} constraints={DEFAULT_CONSTRAINTS} onSyncMeasured={onSync} />);
  const button = await findByRole('button', { name: /Export not valid/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(getByRole('button', { name: /Load CAD values and check again/ }));
  expect(onSync).toHaveBeenCalled();
});
