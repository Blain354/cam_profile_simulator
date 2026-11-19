# Onshape STL Export — Pipeline Documentation

> Aligned with the [`web_projects_template`](../../web_projects_template/)
> structure and the OpenClaw `onshape` skill
> (`~/.openclaw/workspace/skills/onshape/SKILL.md`).

The cam profile simulator can push the **current configuration** to an
Onshape parametric model, trigger an STL translation, and stream progress
back to the browser. When the job finishes the STL is cached server-side
(~10 min); the user must click **Download STL** to open a native "Save As"
dialog (`window.showSaveFilePicker`, or `<a download>` fallback). That
extra click is intentional: browsers require a direct user gesture for the
File System Access API.

**Closure ramp (`ramp_enabled`):** the Onshape sketch only models the
closed-side plateau. If the request body has `ramp_enabled: true`,
`POST /api/export/stl-stream` returns **HTTP 422** before any Onshape call
(`backend/main.py`). The modal shows the same constraint and disables
**Start export** (`frontend/src/StlExportModal.tsx`). Turn the toggle off
(or wait for a matching CAD ramp) before exporting.


## High-level flow

```
┌────────────────────────────────────────────────────────────────────────┐
│ Frontend — StlExportModal.tsx                                          │
│   1. User clicks "Export STL" in the header                            │
│   2. Modal POSTs SimulationParams → /api/export/stl-stream             │
│   3. Renders NDJSON progress events as a live log + progress bar       │
│   4. On success: STL ready in cache — user clicks "Download STL"       │
│   5. Download fetches /api/export/stl-download/{job_id}, then          │
│      showSaveFilePicker (or <a download> if the API is missing)        │
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
│   a. POST /variables/.../variables  ← push cam params as variables     │
│   b. POST /partstudios/.../translations { formatName:"STL" }           │
│   c. GET  /translations/{tid}        ← poll until DONE                 │
│   d. GET  /documents/d/{did}/externaldata/{ext} ← STL bytes            │
└────────────────────────────────────────────────────────────────────────┘
```

Granular progress percentages are mapped as:

| Stage                                     | Percent      |
|-------------------------------------------|--------------|
| Validating credentials / resolving target | `0 → 10`     |
| Pushing variables                         | `10 → 30`    |
| Submitting translation job                | `30 → 40`    |
| Polling translation status                | `40 → 80`    |
| Downloading external data ids             | `80 → 96`    |
| Caching STL bytes; result event           | `96 → 100`   |

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

# Optional — only if you push variables to a separate Variable Studio:
ONSHAPE_VARIABLE_ELEMENT_ID=<24-char variable studio element id>

# Optional — JSON object {onshape_var_name: simulator_param_key}.
# Defaults to a 1-to-1 mapping for height/thickness/K/deadband/etc.
ONSHAPE_VARIABLE_MAPPING={"camHeight":"height","camThickness":"thickness"}

# Optional — JSON object {simulator_param_key: unit_suffix}. Defaults to "mm".
ONSHAPE_VARIABLE_UNITS={"K":""}

# Optional — synchronous GET /parts/.../stl path (requires a part id).
ONSHAPE_PART_ID=<24-char part id>
ONSHAPE_USE_DIRECT_STL=1
```

The frontend probes `/api/export/stl-config` before letting the user
start an export, so any missing piece is surfaced inline in the modal.

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

Click **Export STL** in the header. `StlExportModal` is a kit `Modal`
(`@blain-projects/ui`). It will:
1. Probe `/api/export/stl-config` and complain about missing env vars
   before you even start.
2. Stream progress events from `/api/export/stl-stream`. While
   `phase === 'running'`, Esc / overlay click / the close control are
   disabled — use **Cancel** (aborts the stream).
3. On success, show **Download STL** — click it to open the OS file picker
   (or trigger the `<a download>` fallback).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Modal shows "Onshape pipeline not fully configured" | Missing env vars — restart backend after editing `.env`. |
| **Start export** disabled with amber “Closure ramp STL export…” banner | Explorer/Builder has **Closure ramp** on — CAD export is plateau-only; disable the toggle or expect HTTP 422 from `/api/export/stl-stream`. |
| `HTTP 401: Unauthorized` event in the log | Wrong access/secret key, or clock skew > 5 min. |
| Polling stalls at ~50% forever | Onshape model has regen errors — fix in the CAD before retrying. |
| Save dialog never appears in Firefox | Firefox doesn't support `showSaveFilePicker` — the frontend falls back to `<a download>` so the browser uses its default download folder. |
| `OnshapeAPIError 502: external data ids missing` | Translation completed without producing data — usually means the target element isn't a Part Studio. |

## Limits

- **Education plan**: 2 500 API calls / year / user. Each export costs
  4–10 calls depending on polling cycles.
- One STL job is cached for **10 minutes** under `_stl_jobs` (max 12
  concurrent jobs). Beyond that, the user must re-export.
- **Closure ramp profiles cannot be exported** until the Onshape sketch
  reproduces the ramp; the API refuses those jobs with 422.

## Linkage tabs: write the dimensions to the Onshape variable table

The Bar, Lever and Pendulum linkage tabs have a **Write to Onshape variables** button
(`OnshapeVariablesModal` in `frontend/src/LinkageExplorer.tsx`, `backend/onshape_variables.py`).
It does not export anything: it overwrites variable expressions, matched by name.

1. Opening the window reads the tables (`POST /api/linkage/onshape/preview`, 1 or 2 API calls)
   and lists, for each variable, what Onshape holds now and what the simulator would write.
2. **Overwrite N variables in Onshape** writes the ticked rows (`POST /api/linkage/onshape/apply`).
   The tables are read again first, so the write merges into fresh data.

Two places are looked at, the Part Studio first:

| Where | Env | How it is written |
|-------|-----|-------------------|
| `assignVariable` features of a Part Studio (`#L1`, `#L2`…) | `ONSHAPE_LINKAGE_PART_STUDIO_ID` | one POST per changed variable; a configured variable is updated in every configuration |
| a Variable Studio | `ONSHAPE_LINKAGE_VARIABLE_STUDIO_ID` | one POST of the whole list; an unchanged variable goes back as name, type, expression and description only |

A name found nowhere is left alone, unless **Also create the variables Onshape does not have yet**
is ticked: they are then added to the Variable Studio (never to a Part Studio).
Only this studio's own variables are read. A table with `variableStudioReference` set is skipped,
so a name that exists only in the referenced studio shows up as absent, and creating it adds a
variable on this studio.

Default names are in `DEFAULT_MAPPING` (`backend/onshape_variables.py`): `pend_*` for the pendulum,
`lever_*` for the lever, `L1` / `L2` and `elbow_*` for the bar linkage, plus `pinch_tube_OD` and
`pinch_tube_ID` for all three. In the CAD sketch `L1` starts at the fixed anchor, which is the
simulator's bar 2, so `L1` receives bar 2 and `L2` receives bar 1. To use other names, set
`ONSHAPE_LINKAGE_MAPPING` to a JSON object. A kind whose value is an object replaces the default
names for that kind: `{"pendulum": {"my_onshape_name": "bar2_length", …}}`.
The value keys are listed in `VALUES` in the same file. Derived values can be sent too:
`link_length`, `total_height`, `pivot_height_y0`, `link_arc_radius`. A straight link has no
`link_arc_radius`, so that name is left out of the list.

Both writes reach past the `automation` configuration of the STL export.
A Variable Studio has no configuration to write into: what is written is what every Part Studio
using that variable sees. On a Part Studio `assignVariable`, this path calls
`_patch_assign_variable_expression` (`backend/onshape_export.py`) with no
`ONSHAPE_CONFIG_ENUM_VALUE`, so a configured variable is overwritten in every configuration.
`push_variables` passes that value, so an STL export overwrites only the named configuration
when the value is set.

Opening the window is one read per place that is configured (1 or 2). Apply reads those places
again, then posts the Variable Studio list once when a ticked row is updated or created there,
and posts once per Part Studio variable that actually changes. With nothing ticked there is no
write. These calls are made from the container and are not in
`~/automation/state/onshape-appels.jsonl`. Missing keys, an unusable target, or a geometry that
cannot be built come back as HTTP 409 with the reason. A refusal from Onshape is HTTP 502.
