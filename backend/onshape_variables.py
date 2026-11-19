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

Environment:
  ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID      the document (shared with the STL export)
  ONSHAPE_LINKAGE_MAPPING                        JSON {kind: {onshape_name: value_key}}, replaces
                                                 the default names of that kind
"""

from __future__ import annotations

import json
import os
import re
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


class LinkageOnshapeError(RuntimeError):
    """Configuration or request problem worth showing to the user as is."""


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
    return Target(did, wid)


def default_table_name(kind: str) -> str:
    return f"cam_sim_{kind}"


def table_name_for(kind: str, name: Optional[str]) -> str:
    """The table name asked for, or the default of this kind. Letters, digits, space, dash, underscore; 1 to 60."""
    name = (name or "").strip() or default_table_name(kind)
    if not _TABLE_NAME.match(name):
        raise LinkageOnshapeError(
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
    return f"{round(float(value), 4):g} {unit}".strip()


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
        if value is None:
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


def find_table(t: Target, name: str) -> Optional[str]:
    """Element id of the Variable Studio called exactly `name`, None when there is none. One call."""
    data = oe._request_json("GET", _elements_path(t), query={"elementType": "VARIABLESTUDIO"})
    found = [
        e.get("id") for e in (data if isinstance(data, list) else [])
        if isinstance(e, dict) and e.get("elementType") == "VARIABLESTUDIO" and e.get("name") == name and e.get("id")
    ]
    if len(found) > 1:
        raise LinkageOnshapeError(
            f"{len(found)} Variable Studios are called {name!r} in this Onshape document. "
            "Rename or remove the extra ones in Onshape, or choose another table name."
        )
    return found[0] if found else None


def _create_table(t: Target, name: str) -> str:
    data = oe._request_json("POST", f"/variables/d/{t.document_id}/w/{t.workspace_id}/variablestudio", body={"name": name})
    eid = data.get("id") if isinstance(data, dict) else None
    if not eid:
        raise oe.OnshapeAPIError(200, "Onshape created no Variable Studio (no element id in the reply)", data)
    return eid


def _read_table(t: Target, eid: str) -> list[dict]:
    """The table's own variables, in order (referenced studios are left out)."""
    data = oe._request_json("GET", _studio_path(t, eid))
    tables = data if isinstance(data, list) else []
    own = [tb for tb in tables if isinstance(tb, dict) and not tb.get("variableStudioReference")]
    return [v for tb in own for v in tb.get("variables", []) if isinstance(v, dict) and v.get("name")]


def _locate(rows: list[Row], studio: list[dict]) -> None:
    by_name = {v["name"]: v for v in studio}
    for row in rows:
        if row.name in by_name:
            row.current_expression = by_name[row.name].get("expression")
            row.status = "same" if _same(row.current_expression, row.new_expression) else "update"
        else:
            row.current_expression, row.status = None, "new"


def _summary(t: Target, name: str, eid: Optional[str], rows: list[Row], calls: int, created: bool = False) -> dict:
    return {
        "rows": [asdict(r) for r in rows],
        "api_calls": calls,
        "table_name": name,
        "table_exists": eid is not None,
        "table_created": created,
        "element_id": eid,
        "table_url": table_url(t, eid) if eid else None,
    }


def preview(params: LinkageParams, table_name: Optional[str] = None, target: Optional[Target] = None) -> dict:
    """What a write would change. Reads only: one call to find the table, one more to read it if it exists."""
    t = target or target_from_env()
    name = table_name_for(params.linkage_type, table_name)
    rows = wanted_rows(params)
    eid = find_table(t, name)
    _locate(rows, _read_table(t, eid) if eid else [])
    return _summary(t, name, eid, rows, 2 if eid else 1)


# ── Writing ──────────────────────────────────────────────────────────────────


def apply(
    params: LinkageParams,
    names: list[str],
    table_name: Optional[str] = None,
    target: Optional[Target] = None,
) -> dict:
    """Write the rows named in `names` into the table, creating it when it does not exist yet.

    An existing table is read again first and written back whole, so the merge is on fresh data
    and the variables added by hand are kept. With nothing to write, nothing is created.
    """
    t = target or target_from_env()
    name = table_name_for(params.linkage_type, table_name)
    keep = set(names)
    rows = wanted_rows(params)
    eid = find_table(t, name)
    calls = 1
    studio: list[dict] = []
    if eid:
        studio = _read_table(t, eid)
        calls += 1
    _locate(rows, studio)

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

    # One POST with the whole list, the untouched variables exactly as read.
    merged = [{k: v.get(k) for k in ("name", "type", "expression", "description")} for v in studio]
    by_name = {v["name"]: v for v in merged}
    for row in todo:
        if row.name in by_name:
            by_name[row.name]["expression"] = row.new_expression
        else:
            merged.append({
                "name": row.name,
                "type": "ANGLE" if VALUES[row.key][1] == "deg" else "LENGTH",
                "expression": row.new_expression,
                "description": f"{row.label} (cam profile simulator)",
            })
    calls += 1
    try:
        oe._request_json("POST", _studio_path(t, eid), body=merged)
        for row in todo:
            row.status = "written" if row.status == "update" else "created"
    except (oe.OnshapeAPIError, oe.OnshapeConfigError) as exc:
        for row in todo:
            row.status, row.detail = "error", str(exc)
    return _summary(t, name, eid, rows, calls, created)
