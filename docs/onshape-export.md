# Onshape STL Export — Pipeline Documentation

> Aligned with the [`web_projects_template`](../../web_projects_template/)
> structure and the OpenClaw `onshape` skill
> (`~/.openclaw/workspace/skills/onshape/SKILL.md`).

The cam profile simulator can push the **current configuration** to an
Onshape parametric model, trigger an STL translation, and stream the
resulting mesh back to the user — with a granular progress bar and a
native "Save As" dialog in the browser.


## High-level flow

```
┌────────────────────────────────────────────────────────────────────────┐
│ Frontend — StlExportModal.tsx                                          │
│   1. User clicks "Export STL" in the header                            │
│   2. Modal POSTs SimulationParams → /api/export/stl-stream             │
│   3. Renders NDJSON progress events as a live log + progress bar       │
│   4. On success: window.showSaveFilePicker (File Explorer dialog)      │
│      → falls back to <a download> if the browser lacks the API         │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ NDJSON stream (one event per line)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Backend — main.py /api/export/stl-stream                               │
│   • Spawns a worker thread → onshape_export.run_full_export()          │
│   • Emits {type:"progress", percent, message, details} per stage       │
│   • Final {type:"result", job_id, download_url, filename, size_bytes}  │
│   • One-shot download served by /api/export/stl-download/{job_id}      │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ HMAC-SHA256 signed REST calls
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Onshape Cloud — REST API v10                                           │
│   a. GET/POST partstudios/.../features  ← patch assignVariable (ctrl_*)│
│   b. Optional regen wait (ONSHAPE_REGEN_WAIT_S, default 2s)            │
│   c. Prefer GET /parts/.../stl when ONSHAPE_PART_ID is set             │
│      else POST /partstudios/.../translations { formatName:"STL" }      │
│   d. GET /translations/{tid} → GET .../externaldata/{ext} (async path) │
└────────────────────────────────────────────────────────────────────────┘
```

Granular progress percentages are mapped as:

| Stage                                     | Percent      |
|-------------------------------------------|--------------|
| Resolving target / credentials            | `~5`         |
| Pushing Part Studio `assignVariable`s     | `15 → 28`    |
| Regen wait                                | `28 → 32`    |
| Submitting translation (async path only)  | `~35`        |
| Polling translation status                | `40 → 80`    |
| Downloading STL bytes                     | `80 → 96`    |
| Caching STL + waiting for save dialog     | `96 → 100`   |

When `ONSHAPE_PART_ID` is set and `ONSHAPE_USE_DIRECT_STL` is truthy
(default), the async translation steps are skipped and the bar jumps from
regen wait to the download/cache range.

## OpenClaw skill reuse

The HMAC signing logic is a clean reimplementation of the reference
script shipped with the OpenClaw skill
(`~/.openclaw/workspace/skills/onshape/scripts/onshape_auth.py`). We
duplicate the code into `backend/onshape_export.py` so the Docker image
remains self-contained (the skill folder is **not** mounted into the
container by design — backend code must stay portable).

If you want to *route* the export through the Makey OpenClaw agent
instead of calling Onshape directly (e.g. so Makey can reason about the
output STL, generate documentation alongside it, etc.), set up an
alternate endpoint that POSTs to:

```
http://openclaw-bridge:8000/api/internal/v1/agents/maker-agent/send
```

with a prompt like *"Export the cam profile to STL using the values
below and place the file at /tmp/cam-export.stl"*. See
[`OPENCLAW.md` in the template](../../web_projects_template/OPENCLAW.md)
for the bridge details. The direct REST integration is preferred for
this app because it lets us stream **granular** progress (Makey would
only return a final reply).

## Required configuration

Backend reads everything from environment variables. The simplest setup
is to forward the same secrets the OpenClaw skill already maintains:

```bash
# In ~/.openclaw/secrets/onshape.env (auto-loaded on dev hosts):
ONSHAPE_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
ONSHAPE_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
```

Then add the document identifiers to the project's `.env`:

```env
ONSHAPE_DOCUMENT_ID=<24-char document id>
ONSHAPE_WORKSPACE_ID=<24-char workspace id>
ONSHAPE_ELEMENT_ID=<24-char part studio element id>

# Optional — Variable Studio element id (legacy; core_top uses Part Studio
# assignVariable features, not Variable Studio entries):
ONSHAPE_VARIABLE_ELEMENT_ID=<24-char variable studio element id>

# Optional — JSON object {onshape_var_name: simulator_param_key}.
# Default mapping (Minivalve / core_top) when unset:
#   ctrl_deadband → deadband
#   ctrl_exp_profile_length → height
#   ctrl_exp_profile_K → K
#   ctrl_default_distance → default_distance
ONSHAPE_VARIABLE_MAPPING={"ctrl_deadband":"deadband","ctrl_exp_profile_length":"height","ctrl_exp_profile_K":"K","ctrl_default_distance":"default_distance"}

# Optional — JSON object {simulator_param_key: unit_suffix}.
# Numeric params default to "mm"; dimensionless keys (K, or unit "") stay bare.
ONSHAPE_VARIABLE_UNITS={"K":""}

# Optional — synchronous GET /parts/.../stl path (requires a part id).
# Direct path is preferred when part id is set; set to 0 to force async translation.
ONSHAPE_PART_ID=<24-char part id>
ONSHAPE_USE_DIRECT_STL=1

# Optional — pause after pushing variables so Part Studio regen finishes
# before STL (avoids occasional STALE translation errors). Default: 2.0
ONSHAPE_REGEN_WAIT_S=2.0

# Optional — Onshape configuration slot used by the automation pipeline.
# When BOTH are set: only that configured enum entry is overwritten on each
# assignVariable, and STL requests pass configuration=<id>=<value> so the
# default / manual RPM configs are never clobbered.
ONSHAPE_CONFIG_PARAMETER_ID=List_<id>
ONSHAPE_CONFIG_ENUM_VALUE=<enum value name>
```

All of the above are forwarded in `docker-compose.yml` for the backend
service. The frontend probes `/api/export/stl-config` before letting the
user start an export, so any missing piece is surfaced inline in the modal.

## Finding the Onshape identifiers

Open the parametric cam document in your browser. The URL looks like:

```
https://cad.onshape.com/documents/{document_id}/w/{workspace_id}/e/{element_id}
```

For `ONSHAPE_PART_ID`, run the OpenClaw skill helper or hit
`GET /api/v10/parts/d/{did}/w/{wid}/e/{eid}` and grab the `partId` of
the cam body.

## Local testing

```bash
# Backend
cd backend
ONSHAPE_ACCESS_KEY=... ONSHAPE_SECRET_KEY=... \
ONSHAPE_DOCUMENT_ID=... ONSHAPE_WORKSPACE_ID=... ONSHAPE_ELEMENT_ID=... \
uvicorn main:app --reload --port 8001

# Frontend (with VITE_API_BASE_URL pointing to the backend)
cd frontend && npm run dev
```

Click **Export STL** in the header. The modal will:
1. Probe `/api/export/stl-config` and complain about missing env vars
   before you even start.
2. Stream progress events from `/api/export/stl-stream`.
3. Open the OS file picker on completion to save the STL.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Modal shows "Onshape pipeline not fully configured" | Missing env vars — restart backend after editing `.env`. |
| `HTTP 401: Unauthorized` event in the log | Wrong access/secret key, or clock skew > 5 min. |
| Polling stalls at ~50% forever | Onshape model has regen errors — fix in the CAD before retrying. |
| `STALE` / flaky translation right after a push | Increase `ONSHAPE_REGEN_WAIT_S` (default `2.0`). |
| Manual CAD configs overwritten by export | Set both `ONSHAPE_CONFIG_PARAMETER_ID` and `ONSHAPE_CONFIG_ENUM_VALUE` so only the automation enum slot is patched. |
| Save dialog never appears in Firefox | Firefox doesn't support `showSaveFilePicker` — the frontend falls back to `<a download>` so the browser uses its default download folder. |
| `OnshapeAPIError 502: external data ids missing` | Translation completed without producing data — usually means the target element isn't a Part Studio. |

## Limits

- **Education plan**: 2 500 API calls / year / user. Each export costs
  4–10 calls depending on polling cycles.
- One STL job is cached for **10 minutes** under `_stl_jobs` (max 12
  concurrent jobs). Beyond that, the user must re-export.
