"""
Write the linkage dimensions on screen into the Onshape variable table.

Two places hold variables in an Onshape document, and both are matched by name:
  - a Variable Studio: read with GET /variables/.../variables and written back as a whole
    list, so every write is read, merge, write and no variable is ever dropped;
  - `assignVariable` features of a Part Studio (the `#L1`, `#L2` kind): each one is posted
    back with its expression changed, the way the STL export already does.

Nothing here regenerates or exports: it only changes expressions. The caller previews
first (`preview`), then applies the rows the user kept (`apply`).

Environment:
  ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID      the document (shared with the STL export)
  ONSHAPE_LINKAGE_VARIABLE_STUDIO_ID             Variable Studio element id (optional)
  ONSHAPE_LINKAGE_PART_STUDIO_ID                 Part Studio element id (optional)
  ONSHAPE_LINKAGE_MAPPING                        JSON {kind: {onshape_name: value_key}}, replaces
                                                 the default names of that kind
"""

from __future__ import annotations

import copy
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

_QUANTITY_PARAM = {"LENGTH": "lengthValue", "ANGLE": "angleValue", "NUMBER": "numberValue", "ANY": "anyValue"}
_NUMBER = re.compile(r"^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*\*?\s*([a-zA-Z]*)\s*$")


class LinkageOnshapeError(RuntimeError):
    """Configuration or request problem worth showing to the user as is."""


@dataclass
class Target:
    document_id: str
    workspace_id: str
    variable_studio_id: Optional[str]
    part_studio_id: Optional[str]


@dataclass
class Row:
    name: str                       # Onshape variable name
    key: str
    label: str
    new_expression: str
    current_expression: Optional[str] = None
    where: Optional[str] = None     # "variable_studio" | "part_studio" | None when not found
    status: str = "missing"         # "update" | "same" | "missing" | "written" | "created" | "skipped" | "error"
    detail: str = ""


def target_from_env() -> Target:
    did = os.environ.get("ONSHAPE_DOCUMENT_ID", "").strip()
    wid = os.environ.get("ONSHAPE_WORKSPACE_ID", "").strip()
    vs = os.environ.get("ONSHAPE_LINKAGE_VARIABLE_STUDIO_ID", "").strip() or None
    ps = os.environ.get("ONSHAPE_LINKAGE_PART_STUDIO_ID", "").strip() or None
    if not (did and wid):
        raise LinkageOnshapeError("Onshape document not configured: set ONSHAPE_DOCUMENT_ID and ONSHAPE_WORKSPACE_ID on the backend.")
    if not (vs or ps):
        raise LinkageOnshapeError(
            "No Onshape variable table configured: set ONSHAPE_LINKAGE_VARIABLE_STUDIO_ID "
            "and / or ONSHAPE_LINKAGE_PART_STUDIO_ID on the backend."
        )
    return Target(did, wid, vs, ps)


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


# ── Reading ──────────────────────────────────────────────────────────────────


def _studio_path(t: Target) -> str:
    return f"/variables/d/{t.document_id}/w/{t.workspace_id}/e/{t.variable_studio_id}/variables"


def _features_path(t: Target) -> str:
    return f"/partstudios/d/{t.document_id}/w/{t.workspace_id}/e/{t.part_studio_id}/features"


def _read_studio(t: Target) -> list[dict]:
    """The Variable Studio's own variables, in order (referenced studios are left out)."""
    data = oe._request_json("GET", _studio_path(t))
    tables = data if isinstance(data, list) else []
    own = [tb for tb in tables if isinstance(tb, dict) and not tb.get("variableStudioReference")]
    return [v for tb in own for v in tb.get("variables", []) if isinstance(v, dict) and v.get("name")]


def _feature_name(feature: dict) -> Optional[str]:
    return next((p.get("value") for p in feature.get("parameters", []) if p.get("parameterId") == "name"), None)


def _feature_expression(feature: dict) -> Optional[str]:
    params = feature.get("parameters", [])
    kind = next((p.get("value") for p in params if p.get("parameterId") == "variableType"), "LENGTH")
    for p in params:
        if p.get("parameterId") != _QUANTITY_PARAM.get(kind, "lengthValue"):
            continue
        if "expression" in p:
            return p["expression"]
        for entry in p.get("values", []):   # configured: show the first configuration's value
            inner = entry.get("value")
            if isinstance(inner, dict) and "expression" in inner:
                return inner["expression"]
    return None


def _read_features(t: Target) -> dict[str, dict]:
    data = oe._request_json("GET", _features_path(t))
    feats = data.get("features", []) if isinstance(data, dict) else []
    out: dict[str, dict] = {}
    for f in feats:
        if f.get("featureType") == "assignVariable" and _feature_name(f):
            out[_feature_name(f)] = f
    return out


def _locate(rows: list[Row], studio: Optional[list[dict]], features: Optional[dict[str, dict]]) -> None:
    by_name = {v["name"]: v for v in (studio or [])}
    for row in rows:
        if features and row.name in features:
            row.where, row.current_expression = "part_studio", _feature_expression(features[row.name])
        elif row.name in by_name:
            row.where, row.current_expression = "variable_studio", by_name[row.name].get("expression")
        else:
            row.where, row.current_expression, row.status = None, None, "missing"
            continue
        row.status = "same" if _same(row.current_expression, row.new_expression) else "update"


def _read(t: Target):
    studio = _read_studio(t) if t.variable_studio_id else None
    features = _read_features(t) if t.part_studio_id else None
    return studio, features


def _summary(t: Target, rows: list[Row], calls: int) -> dict:
    return {
        "rows": [asdict(r) for r in rows],
        "api_calls": calls,
        "has_variable_studio": bool(t.variable_studio_id),
        "has_part_studio": bool(t.part_studio_id),
        "document_url": f"{oe.ONSHAPE_BASE_URL}/documents/{t.document_id}/w/{t.workspace_id}/e/{t.variable_studio_id or t.part_studio_id}",
    }


def preview(params: LinkageParams, target: Optional[Target] = None) -> dict:
    """What a write would change. Reads only."""
    t = target or target_from_env()
    rows = wanted_rows(params)
    studio, features = _read(t)
    _locate(rows, studio, features)
    return _summary(t, rows, int(studio is not None) + int(features is not None))


# ── Writing ──────────────────────────────────────────────────────────────────


def apply(
    params: LinkageParams,
    names: list[str],
    create_missing: bool = False,
    target: Optional[Target] = None,
) -> dict:
    """Write the rows named in `names`. Variables are read again first, so the merge is on fresh data.

    A name found nowhere is created in the Variable Studio only when `create_missing` is set.
    """
    t = target or target_from_env()
    keep = set(names)
    rows = wanted_rows(params)
    studio, features = _read(t)
    _locate(rows, studio, features)
    calls = int(studio is not None) + int(features is not None)

    for row in rows:
        if row.name not in keep:
            row.status, row.detail = "skipped", "not selected"
        elif row.status == "missing" and not (create_missing and studio is not None):
            row.status = "skipped"
            row.detail = "no Variable Studio to create it in" if create_missing else "not in Onshape"

    # Variable Studio: one POST with the whole list, the untouched variables exactly as read.
    studio_rows = [r for r in rows if r.status in ("update", "missing") and r.where != "part_studio"]
    if studio_rows and studio is not None:
        merged = [{k: v.get(k) for k in ("name", "type", "expression", "description")} for v in studio]
        by_name = {v["name"]: v for v in merged}
        for row in studio_rows:
            if row.name in by_name:
                by_name[row.name]["expression"] = row.new_expression
            else:
                merged.append({
                    "name": row.name,
                    "type": "ANGLE" if VALUES[row.key][1] == "deg" else "LENGTH",
                    "expression": row.new_expression,
                    "description": f"{row.label} (cam profile simulator)",
                })
        try:
            oe._request_json("POST", _studio_path(t), body=merged)
            calls += 1
            for row in studio_rows:
                row.status = "written" if row.where else "created"
                row.where = "variable_studio"
        except (oe.OnshapeAPIError, oe.OnshapeConfigError) as exc:
            calls += 1
            for row in studio_rows:
                row.status, row.detail = "error", str(exc)

    # Part Studio: one POST per variable feature.
    for row in rows:
        if row.status != "update" or row.where != "part_studio":
            continue
        patched = copy.deepcopy(features[row.name])
        if not oe._patch_assign_variable_expression(patched, row.new_expression) or not patched.get("featureId"):
            row.status, row.detail = "error", "this variable has no expression to change"
            continue
        try:
            calls += 1
            oe._request_json("POST", f"{_features_path(t)}/featureid/{patched['featureId']}",
                 body={"btType": "BTFeatureDefinitionCall-1406", "feature": patched})
            row.status = "written"
        except (oe.OnshapeAPIError, oe.OnshapeConfigError) as exc:
            row.status, row.detail = "error", str(exc)
    return _summary(t, rows, calls)
