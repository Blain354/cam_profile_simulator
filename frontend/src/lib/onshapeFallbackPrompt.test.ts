import { expect, test } from 'vitest';
import { buildOnshapeFallbackPrompt } from './onshapeFallbackPrompt';
import type { OnshapePromptTable } from './onshapeFallbackPrompt';

test('lists failed rows with old/new values, table URLs, and document info', () => {
  const tables: OnshapePromptTable[] = [
    {
      table_name: 'cam_sim_compliant',
      table_exists: true,
      element_id: 'E1',
      table_url: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/E1',
      write_error: 'HTTP 429: rate limit',
      rows: [
        { name: 'cb_junction_x', label: 'Junction x', current_expression: '2 mm', new_expression: '3.5 mm', status: 'error', detail: 'HTTP 429: rate limit' },
        { name: 'cb_anchor_distance', label: 'Anchor distance', current_expression: '1 mm', new_expression: '1 mm', status: 'same' },
      ],
    },
    {
      table_name: 'cam_sim_carriage',
      table_exists: false,
      element_id: null,
      table_url: null,
      rows: [
        { name: 'carriage_pivot_offset', label: 'Carriage pivot offset', current_expression: null, new_expression: '4 mm', status: 'error' },
      ],
    },
    {
      table_name: 'cam_sim_pinch',
      table_exists: true,
      element_id: 'E3',
      table_url: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/E3',
      rows: [
        { name: 'pinch_preload', label: 'Preload', current_expression: '0.5 mm', new_expression: '0.8 mm', status: 'written' },
      ],
    },
  ];

  const prompt = buildOnshapeFallbackPrompt({
    mechanism: 'Compliant Bars',
    error: 'HTTP 429: rate limit',
    tables,
    partStudioUrl: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/PS99',
  });

  expect(prompt).toContain('cam-profile-sim');
  expect(prompt).toContain('Compliant Bars');
  expect(prompt).toContain('https://cad.onshape.com/documents/DOC123/w/WS456');
  expect(prompt).toContain('`did`: `DOC123`, `wid`: `WS456`');
  expect(prompt).toContain('https://cad.onshape.com/documents/DOC123/w/WS456/e/PS99');
  expect(prompt).toContain('### `cam_sim_compliant` (exists, element `E1`)');
  expect(prompt).toContain('URL: https://cad.onshape.com/documents/DOC123/w/WS456/e/E1');
  expect(prompt).toContain('- `#cb_junction_x`: `2 mm` -> `3.5 mm` (Junction x)');
  expect(prompt).toContain('### `cam_sim_carriage` (missing — create Variable Studio first)');
  expect(prompt).toContain('- `#carriage_pivot_offset`: `(new)` -> `4 mm` (Carriage pivot offset)');
  // Already-written table and unchanged row are omitted
  expect(prompt).not.toContain('cam_sim_pinch');
  expect(prompt).not.toContain('cb_anchor_distance');
});

test('falls back to selected update/new rows when apply fails with a network error', () => {
  const prompt = buildOnshapeFallbackPrompt({
    mechanism: 'Pendulum linkage',
    error: 'HTTP 502',
    documentId: 'DOC1',
    workspaceId: 'WS2',
    documentUrl: 'https://cad.onshape.com/documents/DOC1/w/WS2',
    selectedNames: new Set(['pend_arm_L']),
    tables: [
      {
        table_name: 'cam_sim_pendulum',
        table_exists: true,
        element_id: 'E9',
        table_url: 'https://cad.onshape.com/documents/DOC1/w/WS2/e/E9',
        rows: [
          { name: 'pend_arm_L', label: 'Bar hinged at the anchor', current_expression: '10 mm', new_expression: '12 mm', status: 'update' },
          { name: 'pend_foot', label: 'Foot', current_expression: '5 mm', new_expression: '6 mm', status: 'update' },
        ],
      },
    ],
  });

  expect(prompt).toContain('Pendulum linkage');
  expect(prompt).toContain('- `#pend_arm_L`: `10 mm` -> `12 mm` (Bar hinged at the anchor)');
  expect(prompt).not.toContain('pend_foot');
});

test('still produces a useful prompt when preview itself failed before loading tables', () => {
  const prompt = buildOnshapeFallbackPrompt({
    mechanism: 'Compliant Bars',
    error: 'HTTP 503: Onshape unavailable',
    tables: [],
    fallbackTableNames: ['cam_sim_compliant', 'cam_sim_carriage', 'cam_sim_pinch'],
  });

  expect(prompt).toContain('HTTP 503: Onshape unavailable');
  expect(prompt).toContain('`cam_sim_compliant`, `cam_sim_carriage`, `cam_sim_pinch`');
  expect(prompt).toContain('ONSHAPE_DOCUMENT_ID');
});
