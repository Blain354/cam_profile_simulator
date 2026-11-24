export interface OnshapePromptRow {
  name: string;
  label: string;
  current_expression: string | null;
  new_expression: string;
  status: 'update' | 'same' | 'new' | 'written' | 'created' | 'skipped' | 'error';
  detail?: string;
}

export interface OnshapePromptTable {
  table_name: string;
  table_exists: boolean;
  table_created?: boolean;
  element_id: string | null;
  table_url: string | null;
  document_id?: string | null;
  workspace_id?: string | null;
  document_url?: string | null;
  write_error?: string | null;
  rows: OnshapePromptRow[];
}

export interface BuildOnshapeFallbackPromptInput {
  mechanism: string;
  error: string;
  tables: OnshapePromptTable[];
  /** Selected variable names (used when an error happened before row-level statuses became 'error'). */
  selectedNames?: ReadonlySet<string>;
  /** Expected table names when preview itself failed and `tables` is empty. */
  fallbackTableNames?: string[];
  documentId?: string | null;
  workspaceId?: string | null;
  documentUrl?: string | null;
  partStudioUrl?: string | null;
}

const DOC_URL_RE = /^(https?:\/\/[^/]+\/documents\/([A-Za-z0-9]+)\/w\/([A-Za-z0-9]+))(?:\/|$)/;

function extractDocInfo(urls: (string | null | undefined)[]): {
  documentUrl: string | null;
  documentId: string | null;
  workspaceId: string | null;
} {
  for (const url of urls) {
    if (!url) continue;
    const m = DOC_URL_RE.exec(url);
    if (m) return { documentUrl: m[1], documentId: m[2], workspaceId: m[3] };
  }
  return { documentUrl: null, documentId: null, workspaceId: null };
}

/**
 * Builds a concise, self-contained prompt so an agent can manually write the Onshape
 * Variable Studio values when the simulator's automatic write fails.
 */
export function buildOnshapeFallbackPrompt(input: BuildOnshapeFallbackPromptInput): string {
  const { mechanism, error, tables, selectedNames, fallbackTableNames, partStudioUrl } = input;

  const firstTableWithDoc = tables.find((t) => t.document_url || t.document_id || t.workspace_id);
  const parsed = extractDocInfo([
    input.documentUrl,
    firstTableWithDoc?.document_url,
    ...tables.map((t) => t.table_url),
    partStudioUrl,
  ]);

  const documentUrl = input.documentUrl ?? firstTableWithDoc?.document_url ?? parsed.documentUrl;
  const documentId = input.documentId ?? firstTableWithDoc?.document_id ?? parsed.documentId;
  const workspaceId = input.workspaceId ?? firstTableWithDoc?.workspace_id ?? parsed.workspaceId;

  const hasErrorRows = tables.some((t) => t.rows.some((r) => r.status === 'error'));

  const pendingTables = tables
    .map((table) => {
      const rows = hasErrorRows
        ? table.rows.filter((r) => r.status === 'error')
        : table.rows.filter((r) => {
            if (r.status !== 'update' && r.status !== 'new') return false;
            return !selectedNames || selectedNames.size === 0 || selectedNames.has(r.name);
          });
      return { table, rows };
    })
    .filter(({ rows }) => rows.length > 0);

  const lines: string[] = [
    'Write these variables manually to Onshape because the simulator write failed.',
    '',
    `- Project: Cam Profile Simulator (\`cam-profile-sim\`, mechanism: ${mechanism})`,
  ];

  if (documentUrl) {
    const ids = documentId && workspaceId ? ` (\`did\`: \`${documentId}\`, \`wid\`: \`${workspaceId}\`)` : '';
    lines.push(`- Onshape document: ${documentUrl}${ids}`);
  } else if (documentId && workspaceId) {
    lines.push(`- Onshape document: \`did\`: \`${documentId}\`, \`wid\`: \`${workspaceId}\``);
  } else {
    lines.push('- Onshape document: configured via `ONSHAPE_DOCUMENT_ID` / `ONSHAPE_LINKAGE_WORKSPACE_ID` (or `ONSHAPE_WORKSPACE_ID`) in `cam-profile-sim`');
  }

  if (partStudioUrl) {
    lines.push(`- Part Studio: ${partStudioUrl}`);
  }

  lines.push(`- Error: ${error.trim()}`);

  if (pendingTables.length > 0) {
    lines.push('', 'Variable Studios to update (`old` -> `new`):');
    for (const { table, rows } of pendingTables) {
      const state = table.table_exists || table.table_created
        ? `exists${table.element_id ? `, element \`${table.element_id}\`` : ''}`
        : 'missing — create Variable Studio first';
      lines.push('', `### \`${table.table_name}\` (${state})`);
      if (table.table_url) lines.push(`URL: ${table.table_url}`);
      if (table.write_error && table.write_error.trim() !== error.trim()) {
        lines.push(`Table error: ${table.write_error.trim()}`);
      }
      for (const r of rows) {
        const oldVal = r.current_expression ?? '(new)';
        const detail = r.detail && r.detail.trim() && r.detail.trim() !== error.trim() && r.detail.trim() !== table.write_error?.trim()
          ? ` — ${r.detail.trim()}`
          : '';
        lines.push(`- \`#${r.name}\`: \`${oldVal}\` -> \`${r.new_expression}\` (${r.label})${detail}`);
      }
    }
  } else if (fallbackTableNames && fallbackTableNames.length > 0) {
    lines.push('', `Target Variable Studio(s): ${fallbackTableNames.map((n) => `\`${n}\``).join(', ')}`);
    lines.push('(Preview failed before reading current Onshape values; read the table(s) first and apply the design values.)');
  }

  const backendRefs = mechanism === 'Compliant Bars'
    ? '`backend/onshape_compliant.py` and `backend/onshape_variables.py`'
    : '`backend/onshape_variables.py`';

  lines.push(
    '',
    'Notes:',
    '- Preserve all other existing variables in each Variable Studio (read, merge, write).',
    `- Reference implementation in \`cam-profile-sim\`: ${backendRefs} (Onshape REST v10 \`/api/v10/variables/d/{did}/w/{wid}/e/{eid}/variables\`), or edit directly in the Variable Studio tab(s) above.`,
  );

  return lines.join('\n');
}

/** Copies text to the clipboard, falling back to a temporary textarea if the Clipboard API is unavailable. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand fallback
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
