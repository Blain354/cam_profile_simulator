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

## Linkage tabs: write the dimensions to a variable table of their own

The Bar, Lever and Pendulum linkage tabs have a **Write to Onshape variables** button
(`OnshapeVariablesModal` in `frontend/src/LinkageExplorer.tsx`, `backend/onshape_variables.py`).
It does not export anything. It writes the dimensions into a Variable Studio that belongs to the
simulator, in the configured document (`ONSHAPE_DOCUMENT_ID`) and in the branch given by `ONSHAPE_LINKAGE_WORKSPACE_ID`
(the document's Main; without it, the STL export's `ONSHAPE_WORKSPACE_ID`).
The only write is that table. When `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` is set, the Part Studio
with that element id is read first, on the same document and branch; that read is under
**Inputs the CAD decides** below. With that id unset, no Part Studio is read.

The table is found by name among the document's Variable Studios. The default name is
`cam_sim_<kind>`: `cam_sim_pendulum`, `cam_sim_lever`, `cam_sim_elbow`. The window has a
**Variable table name** field (1 to 60 characters: letters, digits, space, dash, underscore),
remembered per linkage kind in the browser. A new name gives a brand-new table. If several
Variable Studios carry that exact name, the app refuses (HTTP 409) rather than pick one.

The match is exact: the name typed is trimmed, then compared as is with the Onshape names, case
and spaces included (`Cam_Sim_Pendulum` or `cam_sim_pendulum ` in Onshape is not
`cam_sim_pendulum`). Only elements of type `VARIABLESTUDIO` count: a Part Studio or a drawing
with the same name is never the table, nor a duplicate of it.

1. Opening the window, or **Look up** after changing the name, calls
   `POST /api/linkage/onshape/preview` with `table_name`. If the table does not exist the window
   says so and lists every variable as new (1 API call, the Variable Studio listing). If it exists,
   it is read and each variable shows what the table holds and what the simulator would write
   (2 API calls: that listing, then the table read). When measured inputs are configured, the same
   request also makes one read per measured variable, and `api_calls` includes them.
2. The button writes the ticked rows (`POST /api/linkage/onshape/apply`, same `table_name` and
   `names`). It reads **Create the table and write N variables** when the table does not exist,
   **Overwrite N variables in <name>** when it does. The table is looked up again first.
   A ticked row that already has the same value is left alone. A write happens only when a
   ticked row differs or is not in the table yet:
   - missing table: it is created, then those rows are written (3 calls: list, create, write);
   - existing table: it is read, those rows are merged into what it holds, and the whole list
     is posted back (3 calls: list, read, write). Variables added by hand stay, as name, type,
     expression and description.
   If nothing ticked actually changes, nothing is created or written. A missing table costs
   the listing only (1 call); an existing table is listed and read (2 calls), then left as it is.
   Those counts are the Variable Studio calls. A configured measured-input check runs first and
   adds one call per measured variable; if the check fails, apply returns HTTP 409 before any of them.
   The reply says whether the table
   was created and gives its element id and `https://cad.onshape.com/documents/{did}/w/{wid}/e/{eid}`,
   shown as **Open the table in Onshape**.
   A variable written by the simulator gets the type of its unit: `LENGTH` for mm, `ANGLE` for
   deg, `NUMBER` without a unit; the expression is a plain number with up to 4 decimals and its
   unit (`14.43 mm`, `100 deg`).

What can go wrong:

- **Created, then the write fails.** The reply has `table_created: true`, the element id and
  `write_error`, and every row that was about to be written is `error` (a ticked row that
  already matched stays `same`). The window says the table now exists and that
  the write did not go through (after a refusal nothing was written; after a timeout it may
  have landed, and the next look-up shows it). Writing again finds that table by name: no second table is made.
- **Two clicks at once.** The button is disabled while a request runs, and the backend holds a
  lock per (document, workspace, table name) around list, create and write, so only one table
  is created. The lock is in memory: it holds with the single uvicorn worker the image runs.
- **An odd reply from Onshape.** A listing that is not a list, a read that is not one block of
  the table's own variables (plus referenced ones), or a variable without a name stops the
  apply before any write, so a bad read is never written back as an emptier table. Ids that
  are not plain alphanumeric are refused before they go into a path, and a redirect is never
  followed (a POST must not become a GET reported as done).
- **The table references another Variable Studio.** The read then has one block per referenced
  studio. Only the table's own block is merged and written back; referenced variables are not
  copied into it. A ticked name that only a referenced studio defines is added to the table's
  own list, and its row says so.
- **Many elements.** The listing is read as one array; the app does not page it. A document
  with very many tabs is not expected here, but if Onshape ever paged that reply, a table
  beyond the first page would be missed and a second one created.

The table is a tab of the Onshape document. A Part Studio uses its values only once it
references the table (**Insert > Variable Studio reference**), which the owner does once by hand.
Until then writing changes no part. A Variable Studio has no configuration to write into: what
is written is what every Part Studio referencing it sees.

Request and reply:

```json
// POST /api/linkage/onshape/preview   (any /api/linkage/simulate body, plus)
{ "linkage_type": "pendulum", "...": "...", "table_name": "cam_sim_pendulum" }
// POST /api/linkage/onshape/apply      (same, plus)
{ "...": "...", "table_name": "cam_sim_pendulum", "names": ["pend_arm_L", "pend_anchor"] }
// reply of both
{ "rows": [{ "name": "pend_arm_L", "key": "bar2_length", "label": "...", "new_expression": "14.43 mm",
             "current_expression": "10 mm", "status": "update", "detail": "" }],
  "api_calls": 2, "table_name": "cam_sim_pendulum", "table_exists": true, "table_created": false,
  "element_id": "…", "table_url": "https://cad.onshape.com/documents/…/w/…/e/…", "write_error": null,
  "input_check": { "configured": false, "valid": true, "rows": [], "part_studio_url": null, "error": null } }
```

`api_calls` of 2 is this existing table with no measured Part Studio. When one is set,
`input_check.configured` is true, `rows` holds each measured input (`key`, `variable`, `label`,
`unit`, `value`, `simulator`, `ok`), `part_studio_url` is that Part Studio, and `api_calls` includes
one call per measured variable. Preview still returns this body when `valid` is false. Apply then
answers HTTP 409 with the reason and does not return the body.

Row status: preview gives `update`, `same` or `new`. Apply sets a row that was not ticked to
`skipped`. A ticked row that already matches stays `same` and is not changed; one that differs
becomes `written`, one the table did not hold becomes `created`, and a failed write becomes
`error` (with `detail`). `table_name` empty or absent means the default.

Onshape REST v10 endpoints used (from the official OpenAPI description that backs the API
explorer, `https://cad.onshape.com/api/openapi`, explorer at https://cad.onshape.com/glassworks/explorer/):

| Call | Operation |
|------|-----------|
| `GET /documents/d/{did}/w/{wid}/elements?elementType=VARIABLESTUDIO` | `getElementsInDocument` (Document) |
| `POST /variables/d/{did}/w/{wid}/variablestudio`, body `{"name": "..."}` | `createVariableStudio` (Variables) |
| `GET /variables/d/{did}/w/{wid}/e/{eid}/variables` | `getVariables` (Variables) |
| `POST /variables/d/{did}/w/{wid}/e/{eid}/variables`, body `[{"name", "type", "expression", "description"}]` | `setVariables` (Variables), replaces the whole list |
| `POST /partstudios/d/{did}/w/{wid}/e/{partStudioId}/featurescript` | body is `function(context is Context, queries) { return getVariable(context, "<name>"); }`. `partStudioId` is `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID`. One call per measured variable, and only when that id is set and this linkage kind has a measured input. The call reads the Part Studio; it writes nothing. |

Default names are in `DEFAULT_MAPPING` (`backend/onshape_variables.py`): `pend_*` for the pendulum,
`lever_*` for the lever, `L1` / `L2` and `elbow_*` for the bar linkage, plus `pinch_tube_OD` and
`pinch_tube_ID` for all three. In the CAD sketch `L1` starts at the fixed anchor, which is the
simulator's bar 2, so `L1` receives bar 2 and `L2` receives bar 1. To use other names, set
`ONSHAPE_LINKAGE_MAPPING` to a JSON object. A kind whose value is an object replaces the default
names for that kind: `{"pendulum": {"my_onshape_name": "bar2_length", …}}`.
The value keys are listed in `VALUES` in the same file. Derived values can be sent too:
`link_length`, `total_height`, `pivot_height_y0`, `link_arc_radius`, `pin_gap_y0`
(pin or pad to the wall the tube rests on at Y = 0, written as `pend_pin_gap`, `lever_pin_gap`, `elbow_pin_gap`:
measure it in the sketch to check that the CAD pinches the tube as the simulator does). A straight link has no
`link_arc_radius`, so that name is left out of the list.

These calls are made from the container and are not in `~/automation/state/onshape-appels.jsonl`.
A bad table name comes back as HTTP 422 with the rule. Duplicate table names, missing keys, an
unusable target, a geometry that cannot be built, or a simulation that does not start from the
measured inputs come back as HTTP 409 with the reason. A refusal from Onshape is HTTP 502.

### Inputs the CAD decides

Some inputs are set by the CAD, not by the simulator. The Part Studio measures them, and the
simulator reads them back. The only default is the pendulum tube centre (`tube_center_x`, the
tube-axis distance from the screw axis), from the variable `#pend_CALC_tube_center`
(`DEFAULT_MEASURED` in `backend/onshape_variables.py`). The Part Studio is the element id in
`ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID`, on the table's document and branch. It is not chosen by name.

| Env | Meaning |
|-----|---------|
| `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` | Part Studio holding the measured variables, in the table's document and branch. Unset: nothing is read or checked. |
| `ONSHAPE_LINKAGE_MEASURED` | Optional JSON `{kind: {simulator value key: variable name}}` replacing `DEFAULT_MEASURED` for a kind. |

- **Sync from Onshape** (under Tube centre, on the pendulum) calls `POST /api/linkage/onshape/measured`:
  one read-only FeatureScript evaluation per variable (`getVariable`), and each value returned overwrites
  that input on the design.
- **Export check.** Opening the write window, and **Look up**, also reads the measured values and says
  whether the export is valid: every measured input must equal the simulator's within 0.001 in that
  value's unit (millimetres for the tube centre). If one differs, the write button is disabled and reads
  **Export not valid**, the window offers **Sync from Onshape and check again**, and `/apply` itself
  refuses with HTTP 409 before it lists or writes the table. A measure that cannot be read also makes
  the export invalid and disables the write: Onshape gave no value (the variable has to be defined
  before the rollback bar), or the value is in the wrong unit. Each successful check costs one API
  call per measured variable. With the id unset, or for a linkage kind that has no measured input,
  nothing is read and the write is not gated.

