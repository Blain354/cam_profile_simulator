"""
Write the linkage dimensions on screen into a Variable Studio of the simulator's own.

The table is a Variable Studio tab of the configured document, found by name
(`cam_sim_<kind>` by default). It is created on the first write; the owner then references
it from a Part Studio once, by hand (Insert > Variable Studio reference). Nothing else in the
document is read or written: no Part Studio, no other Variable Studio.

Onshape REST v10 (https://cad.onshape.com/api/openapi, Glassworks explorer):
  GET  /documents/d/{did}/w/{wid}/elements?elementType=VARIABLESTUDIO   find the table by name
  POST /variables/d/{did}/w/{wid}/variablestudio  {"name": ...}          create it
  GET  /variables/d/{did}/w/{wid}/e/{eid}/variables                       read it
  POST /variables/d/{did}/w/{wid}/e/{eid}/variables  [ ... ]              write the whole list

The write replaces the whole list, so it is always read, merge, write: a variable added by
hand in the table is kept. The caller previews first (`preview`), then applies the rows the
user kept (`apply`).

Write safety: the only ids put in a path are the document and workspace of the environment and
an element id taken from the listing (an element of type VARIABLESTUDIO whose name is exactly
the table name, case and inner spaces included) or from the creation reply. Ids are checked to
be plain alphanumeric. Redirects are never followed. A reply of an unexpected shape stops
before any write, so a bad read can never become an empty table written back.

Environment:
  ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID      the document (shared with the STL export)
  ONSHAPE_LINKAGE_MAPPING                        JSON {kind: {onshape_name: value_key}}, replaces
                                                 the default names of that kind
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from dataclasses import asdict, dataclass
from typing import Any, Optional

try:
    import onshape_export as oe
    from linkage import LinkageParams, compute_linkage
except ImportError:  # imported as the backend package (tests)
    from . import onshape_export as oe
    from .linkage import LinkageParams, compute_linkage

# value_key -> (label, unit). Keys are LinkageParams fields or the derived values below.
VALUES = {
    "bar1_length": ("Link, carriage pivot to joint", "mm"),
    "bar2_length": ("Bar hinged at the anchor", "mm"),
    "lever_length": ("Lever, anchor to pinch point", "mm"),
    "foot_length": ("Foot", "mm"),
    "foot_angle_deg": ("Foot angle", "deg"),
    "pad_length": ("Contact pad", "mm"),
    "anchor_distance": ("Anchor distance", "mm"),
    "pivot_offset": ("Carriage pivot offset", "mm"),
    "tube_center_x": ("Tube centre", "mm"),
    "pin_diameter": ("Pinch pin diameter", "mm"),
    "preload": ("Preload", "mm"),
    "stroke": ("Stroke", "mm"),
    "tube_id": ("Tube ID", "mm"),
    "tube_od": ("Tube OD", "mm"),
    "member_width": ("Bar width", "mm"),
    "member_thickness": ("Bar thickness", "mm"),
    # Derived by the simulation.
    "link_length": ("Link actually used (solved when the height is fixed)", "mm"),
    "pivot_height_y0": ("Carriage pivot height at Y = 0", "mm"),
    "total_height": ("Anchor to anchor height", "mm"),
    "link_arc_radius": ("Curved link radius", "mm"),
}

_TUBE = {"pinch_tube_OD": "tube_od", "pinch_tube_ID": "tube_id"}

# Onshape names. `L1` and `L2` are the two bars of the sketch in SMART_VALVE_MOTOR_LAT_PINCH
# Copy 1, where L1 starts at the fixed anchor: the simulator's bar 2.
DEFAULT_MAPPING: dict[str, dict[str, str]] = {
    "elbow": {
        "L1": "bar2_length", "L2": "bar1_length",
        "elbow_anchor": "anchor_distance", "elbow_pivot_offset": "pivot_offset",
        "elbow_tube_center": "tube_center_x", "elbow_pin_dia": "pin_diameter",
        "elbow_height": "total_height", "elbow_stroke": "stroke", **_TUBE,
    },
    "lever": {
        "lever_L": "lever_length", "lever_c": "bar2_length", "lever_r": "bar1_length",
        "lever_anchor": "anchor_distance", "lever_pivot_offset": "pivot_offset",
        "lever_tube_center": "tube_center_x", "lever_pin_dia": "pin_diameter",
        "lever_height": "total_height", "lever_stroke": "stroke", **_TUBE,
    },
    "pendulum": {
        "pend_arm_L": "bar2_length", "pend_link_r": "link_length",
        "pend_foot": "foot_length", "pend_foot_angle": "foot_angle_deg", "pend_pad": "pad_length",
        "pend_anchor": "anchor_distance", "pend_pivot_offset": "pivot_offset",
        "pend_tube_center": "tube_center_x", "pend_pin_dia": "pin_diameter",
        "pend_height": "total_height", "pend_stroke": "stroke",
        "pend_link_radius": "link_arc_radius",
        "pend_bar_width": "member_width", "pend_bar_thickness": "member_thickness", **_TUBE,
    },
}

_NUMBER = re.compile(r"^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*\*?\s*([a-zA-Z]*)\s*$")
_TABLE_NAME = re.compile(r"^[A-Za-z0-9 _-]{1,60}$")
_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
_TYPE = {"mm": "LENGTH", "deg": "ANGLE", "": "NUMBER"}


class LinkageOnshapeError(RuntimeError):
    """Configuration or request problem worth showing to the user as is."""


class TableNameError(LinkageOnshapeError):
    """The table name asked for is not allowed (HTTP 422)."""


def _checked_id(value: Any, what: str) -> str:
    if not (isinstance(value, str) and _ID.match(value)):
        raise LinkageOnshapeError(f"Onshape {what} id is not a plain id; nothing was sent.")
    return value


@dataclass
class Target:
    document_id: str
    workspace_id: str


@dataclass
class Row:
    name: str                       # Onshape variable name
    key: str
    label: str
    new_expression: str
    current_expression: Optional[str] = None
    status: str = "new"             # "update" | "same" | "new" | "written" | "created" | "skipped" | "error"
    detail: str = ""


def target_from_env() -> Target:
    did = os.environ.get("ONSHAPE_DOCUMENT_ID", "").strip()
    wid = os.environ.get("ONSHAPE_WORKSPACE_ID", "").strip()
    if not (did and wid):
        raise LinkageOnshapeError("Onshape document not configured: set ONSHAPE_DOCUMENT_ID and ONSHAPE_WORKSPACE_ID on the backend.")
    return Target(_checked_id(did, "document"), _checked_id(wid, "workspace"))


def default_table_name(kind: str) -> str:
    return f"cam_sim_{kind}"


def table_name_for(kind: str, name: Optional[str]) -> str:
    """The table name asked for, or the default of this kind. Letters, digits, space, dash, underscore; 1 to 60."""
    name = (name or "").strip() or default_table_name(kind)
    if not _TABLE_NAME.match(name):
        raise TableNameError(
            f"Table name {name[:80]!r} is not allowed: 1 to 60 characters, letters, digits, space, dash or underscore."
        )
    return name


def mapping_for(kind: str) -> dict[str, str]:
    mapping = dict(DEFAULT_MAPPING.get(kind, {}))
    raw = os.environ.get("ONSHAPE_LINKAGE_MAPPING", "").strip()
    if raw:
        try:
            custom = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LinkageOnshapeError(f"ONSHAPE_LINKAGE_MAPPING is not valid JSON: {exc}") from exc
        if isinstance(custom, dict) and isinstance(custom.get(kind), dict):
            mapping = {str(k): str(v) for k, v in custom[kind].items()}
    unknown = sorted(set(mapping.values()) - set(VALUES))
    if unknown:
        raise LinkageOnshapeError(f"ONSHAPE_LINKAGE_MAPPING names values the simulator does not have: {', '.join(unknown)}")
    return mapping


def _expression(value: float, unit: str) -> str:
    """A plain Onshape expression: up to 4 decimals, never exponent notation, `mm`, `deg` or no unit."""
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    if text in ("-0", ""):
        text = "0"
    return f"{text} {unit}".strip()


def _same(a: Optional[str], b: str) -> bool:
    """Same quantity, whatever the spacing or trailing zeros. An expression that is not a plain number never matches."""
    if a is None:
        return False
    ma, mb = _NUMBER.match(a), _NUMBER.match(b)
    if not (ma and mb):
        return a.strip() == b.strip()
    return ma.group(2).lower() == mb.group(2).lower() and abs(float(ma.group(1)) - float(mb.group(1))) < 1e-9


def wanted_rows(params: LinkageParams) -> list[Row]:
    """One row per mapped variable whose value exists for this design."""
    result = compute_linkage(params)
    if not result.Y_positions:
        raise LinkageOnshapeError(f"This geometry cannot be built, nothing to send: {result.message}")
    values: dict[str, Any] = dict(asdict(params))
    values.update(
        link_length=result.link_length,
        pivot_height_y0=result.pivot_height_y0,
        total_height=2.0 * result.pivot_height_y0,
        link_arc_radius=result.link_arc_radius,
    )
    rows = []
    for name, key in mapping_for(params.linkage_type).items():
        value = values.get(key)
        if value is None or not math.isfinite(float(value)):
            continue   # e.g. no arc radius on a straight link
        label, unit = VALUES[key]
        rows.append(Row(name=name, key=key, label=label, new_expression=_expression(value, unit)))
    return rows


# ── The table ────────────────────────────────────────────────────────────────


def _elements_path(t: Target) -> str:
    return f"/documents/d/{t.document_id}/w/{t.workspace_id}/elements"


def _studio_path(t: Target, eid: str) -> str:
    return f"/variables/d/{t.document_id}/w/{t.workspace_id}/e/{eid}/variables"


def table_url(t: Target, eid: str) -> str:
    return f"{oe.ONSHAPE_BASE_URL}/documents/{t.document_id}/w/{t.workspace_id}/e/{eid}"


def _call(method: str, path: str, **kw: Any) -> Any:
    return oe._request_json(method, path, follow_redirects=False, **kw)


def find_table(t: Target, name: str) -> Optional[str]:
    """Element id of the Variable Studio called exactly `name`, None when there is none. One call.

    Exact match: case and spaces count (the name asked for is trimmed, the Onshape names are not).
    Only elements of type VARIABLESTUDIO are considered, whatever the listing returns.
    """
    data = _call("GET", _elements_path(t), query={"elementType": "VARIABLESTUDIO"})
    if not isinstance(data, list):
        raise oe.OnshapeAPIError(200, "the element listing is not a list; nothing was written")
    found = [
        e.get("id") for e in data
        if isinstance(e, dict) and e.get("elementType") == "VARIABLESTUDIO" and e.get("name") == name
    ]
    if len(found) > 1:
        raise LinkageOnshapeError(
            f"{len(found)} Variable Studios are called {name!r} in this Onshape document. "
            "Rename or remove the extra ones in Onshape, or choose another table name."
        )
    return _checked_id(found[0], "element") if found else None


def _create_table(t: Target, name: str) -> str:
    data = _call("POST", f"/variables/d/{t.document_id}/w/{t.workspace_id}/variablestudio", body={"name": name})
    eid = data.get("id") if isinstance(data, dict) else None
    if not eid:
        raise oe.OnshapeAPIError(200, "Onshape created no Variable Studio (no element id in the reply)", data)
    return _checked_id(eid, "element")


def _read_table(t: Target, eid: str) -> tuple[list[dict], set[str]]:
    """The table's own variables, in order, and the names that come from studios it references.

    The reply is one block per source: the table's own (`variableStudioReference` null) and one
    per referenced Variable Studio. Only the own block is ever written back; a referenced one
    belongs to another studio. Any other shape raises, before anything is written.
    """
    data = _call("GET", _studio_path(t, eid))
    if not isinstance(data, list) or not all(isinstance(b, dict) and isinstance(b.get("variables"), list) for b in data):
        raise oe.OnshapeAPIError(200, "the table read back in an unexpected shape; nothing was written")
    own = [b for b in data if b.get("variableStudioReference") is None]
    if len(own) != 1:
        raise oe.OnshapeAPIError(200, f"the table read back with {len(own)} blocks of its own; nothing was written")
    variables = own[0]["variables"]
    if not all(isinstance(v, dict) and isinstance(v.get("name"), str) and v["name"] for v in variables):
        raise oe.OnshapeAPIError(200, "the table holds a variable without a name; nothing was written")
    referenced = {
        v.get("name") for b in data if b.get("variableStudioReference") is not None
        for v in b["variables"] if isinstance(v, dict)
    }
    return variables, referenced


def _locate(rows: list[Row], studio: list[dict], referenced: frozenset = frozenset()) -> None:
    by_name = {v["name"]: v for v in studio}
    for row in rows:
        if row.name in referenced:
            row.detail = "also defined in a Variable Studio this table references; this table's own value is the one written"
        if row.name in by_name:
            row.current_expression = by_name[row.name].get("expression")
            row.status = "same" if _same(row.current_expression, row.new_expression) else "update"
        else:
            row.current_expression, row.status = None, "new"


def _summary(
    t: Target, name: str, eid: Optional[str], rows: list[Row], calls: int, created: bool = False,
    write_error: Optional[str] = None,
) -> dict:
    return {
        "rows": [asdict(r) for r in rows],
        "api_calls": calls,
        "table_name": name,
        "table_exists": eid is not None,
        "table_created": created,
        "element_id": eid,
        "table_url": table_url(t, eid) if eid else None,
        "write_error": write_error,
    }


def preview(params: LinkageParams, table_name: Optional[str] = None, target: Optional[Target] = None) -> dict:
    """What a write would change. Reads only: one call to find the table, one more to read it if it exists."""
    t = target or target_from_env()
    name = table_name_for(params.linkage_type, table_name)
    rows = wanted_rows(params)
    eid = find_table(t, name)
    studio, referenced = _read_table(t, eid) if eid else ([], set())
    _locate(rows, studio, frozenset(referenced))
    return _summary(t, name, eid, rows, 2 if eid else 1)


# ── Writing ──────────────────────────────────────────────────────────────────


_locks: dict[tuple[str, str, str], threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(t: Target, name: str) -> threading.Lock:
    """One lock per table, so two clicks at once cannot both create it (single uvicorn worker)."""
    with _locks_guard:
        return _locks.setdefault((t.document_id, t.workspace_id, name), threading.Lock())


def apply(
    params: LinkageParams,
    names: list[str],
    table_name: Optional[str] = None,
    target: Optional[Target] = None,
) -> dict:
    """Write the rows named in `names` into the table, creating it when it does not exist yet.

    An existing table is read again first and written back whole, so the merge is on fresh data
    and the variables added by hand are kept. With nothing to write, nothing is created.
    A write that fails after the table was created says so (`table_created`, `write_error`);
    a retry finds that table by name and does not create a second one.
    """
    t = target or target_from_env()
    name = table_name_for(params.linkage_type, table_name)
    keep = set(names)
    rows = wanted_rows(params)
    with _lock_for(t, name):
        return _apply_locked(t, name, keep, rows)


def _apply_locked(t: Target, name: str, keep: set, rows: list[Row]) -> dict:
    eid = find_table(t, name)
    calls = 1
    studio: list[dict] = []
    referenced: set[str] = set()
    if eid:
        studio, referenced = _read_table(t, eid)
        calls += 1
    _locate(rows, studio, frozenset(referenced))

    for row in rows:
        if row.name not in keep:
            row.status, row.detail = "skipped", "not selected"
    todo = [r for r in rows if r.status in ("update", "new")]
    if not todo:
        return _summary(t, name, eid, rows, calls)

    created = False
    if not eid:
        eid = _create_table(t, name)   # a new table is empty: no read needed
        calls += 1
        created = True

    # One POST with the whole list: every variable read, in order, with the keys it had; the
    # ticked ones get the new expression and the type that goes with its unit.
    merged = [{k: v[k] for k in ("name", "type", "expression", "description") if v.get(k) is not None} for v in studio]
    by_name = {v["name"]: v for v in merged}
    for row in todo:
        kind = _TYPE[VALUES[row.key][1]]
        if row.name in by_name:
            by_name[row.name].update(type=kind, expression=row.new_expression)
        else:
            merged.append({
                "name": row.name,
                "type": kind,
                "expression": row.new_expression,
                "description": f"{row.label} (cam profile simulator)",
            })
    calls += 1
    write_error = None
    try:
        _call("POST", _studio_path(t, eid), body=merged)
        for row in todo:
            row.status = "written" if row.status == "update" else "created"
    except Exception as exc:   # whatever happened, say what now exists
        write_error = f"{exc}" or type(exc).__name__
        for row in todo:
            row.status, row.detail = "error", write_error
    return _summary(t, name, eid, rows, calls, created, write_error)
