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
The only write is that table. When `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` is set, that Part Studio
is read on the same document and branch: the inputs the CAD decides, for a kind that has them
(**Inputs the CAD decides** below), and what it resolves for the variables the simulator writes
(**What the Part Studio uses**). With that id unset, no Part Studio is read.

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
   request also makes one read per measured variable. When the Part Studio id is set and there is
   at least one variable to send, one further read asks what that Part Studio resolves for each
   of those names. `api_calls` is the sum.
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
   After a write that did not set `write_error`, one more call reads the Part Studio when at least
   one ticked row came back `written`, `created` or `same`. A `write_error`, or no such row, skips that read.
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
Until then writing changes no part. A Variable Studio has no configuration to write into.
Referencing the table is not enough when the Part Studio also defines that name itself:
the local variable is what the part uses. **What the Part Studio uses** is how the window says so.

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
  "element_id": "…", "table_url": "https://cad.onshape.com/documents/…/w/…/e/…",
  "document_id": "…", "workspace_id": "…", "document_url": "https://cad.onshape.com/documents/…/w/…",
  "write_error": null,
  "input_check": { "configured": false, "valid": true, "rows": [], "part_studio_url": null, "error": null },
  "cad_check": { "configured": false, "coherent": true, "rows": [], "error": null } }
```

`api_calls` of 2 is this existing table with the Part Studio id unset: `cad_check.configured` is
then false and `coherent` is true. With the id set, `cad_check` is the read-back in **What the
Part Studio uses**, and that one call is included. For a kind that has a measured input (the
pendulum, by default), `input_check.configured` is true, its `rows` hold each measured input
(`key`, `variable`, `label`, `unit`, `value`, `simulator`, `ok`), `part_studio_url` is that Part
Studio, and `api_calls` also includes one call per measured variable. An elbow or a lever has no
measured input by default, so `input_check.configured` stays false even when the id is set.
Preview still returns this body when `valid` is false. Apply then answers HTTP 409 with the
reason and does not return the body.

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
| `POST /partstudios/d/{did}/w/{wid}/e/{partStudioId}/featurescript` | Measured inputs. Body is `function(context is Context, queries) { return getVariable(context, "<name>"); }`. `partStudioId` is `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID`. One call per measured variable, and only when that id is set and this linkage kind has a measured input. The call reads the Part Studio; it writes nothing. |
| `POST /partstudios/d/{did}/w/{wid}/e/{partStudioId}/featurescript` | What the Part Studio resolves (`cad_check`). Same `partStudioId`. One call when that id is set and the check has names. The script returns a map: for each name, `try silent(getVariable(context, n))`, and a name that comes back undefined is left out. Preview passes every name the simulator would send; an apply that did not set `write_error` passes the ticked rows that are `written`, `created` or `same`. The call reads the Part Studio; it writes nothing. A failure stays in `cad_check.error` on the reply; it is not HTTP 502. |

Default names are in `DEFAULT_MAPPING` (`backend/onshape_variables.py`): `pend_*` for the pendulum,
`lever_*` for the lever, `L1` / `L2` and `elbow_*` for the bar linkage, plus `pinch_tube_OD` and
`pinch_tube_ID` for all three. In the CAD sketch `L1` starts at the fixed anchor, which is the
simulator's bar 2, so `L1` receives bar 2 and `L2` receives bar 1. To use other names, set
`ONSHAPE_LINKAGE_MAPPING` to a JSON object. A kind whose value is an object replaces the default
names for that kind: `{"pendulum": {"my_onshape_name": "bar2_length", …}}`.
The value keys are listed in `VALUES` in the same file. Derived values can be sent too:
`link_length`, `total_height`, `pivot_height_y0`, `link_arc_radius`, `link_arc_side`, `pin_gap_y0`
(pin or pad to the wall the tube rests on at Y = 0, written as `pend_pin_gap`, `lever_pin_gap`, `elbow_pin_gap`:
measure it in the sketch to check that the CAD pinches the tube as the simulator does). A straight link has no
`link_arc_radius`, so that name is left out of the list. When the result does report an arc, the radius sent is
that arc at Y = 0, after a custom radius shorter than half the chord has been raised to a semicircle.
`link_arc_side` has no unit and no default name. It is 0 for a straight link, +1 when a custom-radius arc bulges
inward (screw side) and -1 when it bulges outward (tube side). A tangent arc sends +1 or -1, whichever way that
arc bulges about the chord. Zero is a value, so a name mapped to `link_arc_side` is sent for a straight link too.
`pivot_side` (1 far side of the screw, -1 its tube's side) is in no default mapping: the sketches draw the
carriage pivot on the far side, and `pivot_offset` stays a positive distance. A design with the inverted pivot
is therefore refused (HTTP 409, nothing sent) until a sketch variable is mapped to `pivot_side`.

These calls are made from the container and are not in `~/automation/state/onshape-appels.jsonl`.
A bad table name comes back as HTTP 422 with the rule. Duplicate table names, missing keys, an
unusable target, a geometry that cannot be built, or a simulation that does not start from the
measured inputs come back as HTTP 409 with the reason. A refusal from Onshape on the Variable
Studio calls is HTTP 502. A failure of the Part Studio read-back is not: it stays in `cad_check`.

### What the Part Studio uses

The table write and this read answer different questions. The write changes the Variable Studio.
The read asks the Part Studio in `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` which value it
resolves for each name being checked. That is one read-only FeatureScript call, returned as
`cad_check` on both preview and apply. Onshape is the reference: a name it does not resolve as
written means the part does not follow the table, because the table is not referenced there or
a local variable of the same name replaces it.

Lengths come back in metres and angles in radians, and are converted into the simulator's unit
the same way as a measured input. A plain number has to come back without a unit. `ok` is a
difference of at most 0.001 in that unit, the same tolerance as the export check below. A name
the Part Studio does not define has `onshape` null and `ok` false. One value in the wrong unit
fails the whole read: `coherent` is false, `rows` is empty, and `error` says why. It does not
come back as a single mismatched row.

`configured` is false, `coherent` is true and `rows` is empty when the id is unset or the check
has no names, and nothing is called. Otherwise `configured` is true, and `coherent` is true only
when every checked name matches.

Preview checks every variable the simulator would send. Before anything has been written, the
column can read **not used**. Apply checks only ticked rows that came back `written`, `created`
or `same`. A row left unticked is not in that read. A `write_error` skips the read
(`configured` false, `coherent` false, no extra call). The check does not refuse the write and
does not answer HTTP 409. The measured-input check is what does that.

The window adds a **Part Studio uses** column whenever `configured` is true: the resolved value
with a mark, or **not used**. After a write that went through, it also says **Coherent: the Part
Studio now uses every value written**, or **Not coherent** and lists each mismatch as written
versus what the Part Studio resolves. The read does not depend on the linkage kind having a
measured input. With the id set, an elbow or a lever is checked the same way.

### Inputs the CAD decides

Some inputs are set by the CAD, not by the simulator. The Part Studio measures them, and the
simulator reads them back. The defaults live in `DEFAULT_MEASURED` (`backend/onshape_variables.py`).
The pendulum reads its tube centre (`tube_center_x`, the tube-axis distance from the screw axis)
from `#pend_CALC_tube_center`, in the Part Studio `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID`.
Compliant Bars reads its own Part Studio, `ONSHAPE_COMPLIANT_PART_STUDIO_ID` (no fallback): the tube
centre from `#pend_CALC_tube_center`, the out-of-plane depth (`member_depth`) from `#cb_member_depth`,
and the tube size (`tube_od`, `tube_id`) from `#pinch_tube_OD` and `#pinch_tube_ID`. A Part Studio is an
element id on the table's document and branch, never chosen by name.
A measured input is never written to a table: the pendulum export has no `pend_tube_center`, so the
CAD places the tube itself and the simulator follows its measure. Compliant Bars writes its own tables
(**Compliant Bars: three tables** below).

| Env | Meaning |
|-----|---------|
| `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` | Part Studio on the table's document and branch. It holds the measured variables, and it is the one whose resolved variables are compared with the simulator. Unset: nothing is read or checked. |
| `ONSHAPE_COMPLIANT_PART_STUDIO_ID` | Part Studio of the compliant bars (MINIVALVE: *SMART_VALVE_MOTOR_V3_compliant links_splines*). Measured inputs and the read-back of Compliant Bars. Unset: that tab reads and checks nothing. |
| `ONSHAPE_LINKAGE_MEASURED` | Optional JSON `{kind: {simulator value key: variable name}}` replacing `DEFAULT_MEASURED` for a kind. |

- **Sync from Onshape** (under Tube centre, on the pendulum) calls `POST /api/linkage/onshape/measured`:
  one read-only FeatureScript evaluation per variable (`getVariable`), and each value returned overwrites
  that input on the design.
- **Load CAD values from Onshape** (the button above the Compliant Bars controls) and **Sync from Onshape**
  (on the tube centre and on the out-of-plane depth) call `POST /api/compliant/onshape/measured`: the same
  read-only evaluation, one call per variable. Load CAD values copies every value returned;
  a per-field Sync from Onshape copies only that field.
  The same values gate the Compliant Bars write. An object under `compliant` in `ONSHAPE_LINKAGE_MEASURED`
  replaces the defaults for this tab; the pendulum map is never used for it.
- **Export check.** Opening the write window, and **Look up**, also reads the measured values and says
  whether the export is valid: every measured input must equal the simulator's within 0.001 in that
  value's unit (millimetres for the tube centre). If one differs, the write button is disabled and reads
  **Export not valid**, the window offers **Sync from Onshape and check again**, and `/apply` itself
  refuses with HTTP 409 before it lists or writes the table. A measure that cannot be read also makes
  the export invalid and disables the write: Onshape gave no value (the variable has to be defined
  before the rollback bar), or the value is in the wrong unit. Each successful check costs one API
  call per measured variable. With the id unset, or for a linkage kind that has no measured input,
  this check reads nothing and does not gate the write. A Compliant Bars write is still refused when
  a member cannot be skinned, whether or not `ONSHAPE_COMPLIANT_PART_STUDIO_ID` is set
  (**Compliant Bars: three tables**). The read-back in **What the Part Studio uses**
  is separate: it still runs when the id is set, including for an elbow or a lever.

## Compliant Bars: three tables

**Write to Onshape variables** (under Load CAD values, Compliant Bars tab) writes the design into three
Variable Studios of the document, so that no quantity exists twice in the CAD (`backend/onshape_compliant.py`):

| Table | Variables | Holds |
|-------|-----------|-------|
| `cam_sim_compliant` | `cb_anchor_distance`, `cb_junction_x`, `cb_junction_y`, `cb_pinch_y`, `cb_{l,r,f}_{u,v}{1,2}`, `cb_{l,r,f}_thickness` | what is specific to compliant bars. The owner adds the CAD-only inputs by hand (`cb_member_depth`, `cb_eye_diameter`, `cb_pin_hole_diameter`, `cb_pad_*`, `cb_sketch_datum`); a write keeps them. |
| `cam_sim_carriage` | `carriage_closed_height`, `carriage_pivot_offset`, `carriage_pivot_side` (1 far side of the screw, -1 the tube's side: `pivot_inverted`) | the carriage, shared by every mechanism. The side places the pivot and the carriage pin holes in the Part Studio. |
| `cam_sim_pinch` | `pinch_closed_gap` (the tube model's closed gap), `pinch_preload` | the pinch, shared by every mechanism |

`cb_pinch_y` is the tip height the geometry is built with: with a target pinch height in the constraints,
it is `2 x closed_carriage_height - target`. Not written, because the CAD decides them: the tube size
(`#pinch_tube_OD`, `#pinch_tube_ID`, table *VARIABLES-MODULAR-VALVE-MOTOR*), the tube position
(`#pend_CALC_tube_center`, and `#pinch_CALC_tube_wall` measured in the Part Studio) and `#cb_member_depth`.
The tables hold plain numbers; every formula (handle coordinates, pinch pad) is a variable of the Part Studio.

- `POST /api/compliant/onshape/preview`, body = the `/api/compliant/simulate` body. Locally it builds the
  geometry and runs `skin_check` (`backend/compliant_bars.py`). If the geometry cannot be built
  (no pinch, or a closed gap that is not positive), the reply is HTTP 409 and nothing is sent.
  Otherwise Onshape: one call lists the Variable Studios, one more reads each table that exists,
  one per measured input, one read-back. A member that fails `skin_check` does not refuse the preview.
  Reply: `{tables: [{table_name, table_exists, element_id, table_url, document_id, workspace_id, document_url, rows}], api_calls, input_check, cad_check, skin_check, document_id, workspace_id, document_url}`. `document_url` is the workspace URL from `document_url` in `backend/onshape_variables.py` (`ONSHAPE_BASE_URL`, then `/documents/{document_id}/w/{workspace_id}`). Each table carries the same three fields.
  `skin_check` is `{valid, message, rows}`. Each row is one member (`l`, `r`, `f`): the smallest radius of
  curvature of its cubic, `|B'|^3 / |B' x B''|`, sampled on 1001 points, against half `cb_{l,r,f}_thickness`.
  The handles are the ones written to Onshape: `u1` and `u2` are not swapped, unlike the mesh sampler.
  The window names each failing member with both numbers and disables the write (**Export not valid**).
  **Load CAD values and check again** is offered for a measured-input mismatch. This window has no **Look up**.
- `POST /api/compliant/onshape/apply`, same body plus `names`. The geometry refusal above comes first.
  Before any Onshape call it then refuses
  (HTTP 409, `ExportRefused`) when `skin_check` is not valid. It then reads the measured inputs and
  refuses the same way when that check is configured and not valid. Each table is then read, merged and
  written back whole like the linkage tables (created when missing, untouched when nothing ticked in it
  changes). A failed write is reported on that table (`write_error` is the first one); the other tables
  are still written, and the Part Studio read-back is skipped.
When that window shows an error — a write that did not go through, or a measured-input mismatch that carries an error — **Copy prompt for agent** copies a manual write list and does not call Onshape. The text names the mechanism, the error, and the document URL when the reply has one. Otherwise it names the document and workspace ids, or, when those are missing, `ONSHAPE_DOCUMENT_ID` and `ONSHAPE_LINKAGE_WORKSPACE_ID` (or `ONSHAPE_WORKSPACE_ID`). It also names the Part Studio URL when the check has one, and the rows still to change: rows whose status is `error`, or, if none are, the ticked rows that would `update` or be `new` — every such row when nothing is ticked. The linkage window has the same button (`frontend/src/lib/onshapeFallbackPrompt.ts`).

