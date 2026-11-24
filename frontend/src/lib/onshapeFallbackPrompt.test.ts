import { expect, test } from 'vitest';
import { buildOnshapeFallbackPrompt } from './onshapeFallbackPrompt';
import type { OnshapePromptTable } from './onshapeFallbackPrompt';

test('lists failed rows with old/new values, table URLs, and document info', () => {
  const tables: OnshapePromptTable[] = [
    {
      table_name: 'cam_sim_pendulum',
      table_exists: true,
      element_id: 'E1',
      table_url: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/E1',
      write_error: 'HTTP 429: rate limit',
      rows: [
        { name: 'pend_arm_L', label: 'Arm L', current_expression: '10 mm', new_expression: '12 mm', status: 'error', detail: 'HTTP 429: rate limit' },
        { name: 'pend_anchor', label: 'Anchor distance', current_expression: '4 mm', new_expression: '4 mm', status: 'same' },
      ],
    },
    {
      table_name: 'cam_sim_lever',
      table_exists: false,
      element_id: null,
      table_url: null,
      rows: [
        { name: 'lever_L', label: 'Lever length', current_expression: null, new_expression: '16.5 mm', status: 'error' },
      ],
    },
    {
      table_name: 'cam_sim_elbow',
      table_exists: true,
      element_id: 'E3',
      table_url: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/E3',
      rows: [
        { name: 'elbow_stroke', label: 'Stroke', current_expression: '1.5 mm', new_expression: '2.0 mm', status: 'written' },
      ],
    },
  ];

  const prompt = buildOnshapeFallbackPrompt({
    mechanism: 'Pendulum linkage',
    error: 'HTTP 429: rate limit',
    tables,
    partStudioUrl: 'https://cad.onshape.com/documents/DOC123/w/WS456/e/PS99',
  });

  expect(prompt).toContain('cam-profile-sim');
  expect(prompt).toContain('Pendulum linkage');
  expect(prompt).toContain('https://cad.onshape.com/documents/DOC123/w/WS456');
  expect(prompt).toContain('`did`: `DOC123`, `wid`: `WS456`');
  expect(prompt).toContain('https://cad.onshape.com/documents/DOC123/w/WS456/e/PS99');
  expect(prompt).toContain('### `cam_sim_pendulum` (exists, element `E1`)');
  expect(prompt).toContain('URL: https://cad.onshape.com/documents/DOC123/w/WS456/e/E1');
  expect(prompt).toContain('- `#pend_arm_L`: `10 mm` -> `12 mm` (Arm L)');
  expect(prompt).toContain('### `cam_sim_lever` (missing — create Variable Studio first)');
  expect(prompt).toContain('- `#lever_L`: `(new)` -> `16.5 mm` (Lever length)');
  // Already-written table and unchanged row are omitted
  expect(prompt).not.toContain('cam_sim_elbow');
  expect(prompt).not.toContain('pend_anchor');
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
    mechanism: 'Pendulum linkage',
    error: 'HTTP 503: Onshape unavailable',
    tables: [],
    fallbackTableNames: ['cam_sim_pendulum'],
  });

  expect(prompt).toContain('HTTP 503: Onshape unavailable');
  expect(prompt).toContain('`cam_sim_pendulum`');
  expect(prompt).toContain('ONSHAPE_DOCUMENT_ID');
});
