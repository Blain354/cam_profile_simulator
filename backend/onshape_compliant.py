"""
Write a Compliant Bars design into the Onshape Variable Studios it is split across.

The CAD keeps one variable per quantity, grouped by what it belongs to:

  cam_sim_compliant   what is specific to compliant bars: anchor, junction, tip height, the six
                      Bézier handles (u, v), the three in-plane thicknesses
  cam_sim_carriage    the carriage the bars hang on: pivot height at Y = 0, pivot offset, pivot side
                      (1 far side of the screw, -1 its tube's side: an inverted pivot)
  cam_sim_pinch       the pinch, shared by every mechanism: closed gap of the tube, preload

Each table holds plain numbers only; the formulas (handle coordinates, pinch pad) are variables of
the Part Studio. The tube is never written: its size (#pinch_tube_OD, #pinch_tube_ID), its position
(#pend_CALC_tube_center) and the out-of-plane depth (#cb_member_depth) are inputs the CAD decides,
read back and checked before any write (`onshape_variables.read_measured("compliant")`), from the
Part Studio in ONSHAPE_COMPLIANT_PART_STUDIO_ID.

A table is found by exact name, created on the first write, read, merged and written back whole,
exactly as the linkage tables are (`onshape_variables._apply_locked`): a variable added by hand is
kept. A variable written here exists in no other table of the group, so nothing is duplicated.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Optional

try:
    import onshape_variables as ov
    from compliant_bars import CompliantConstraints, CompliantParams, _apply_pinch_goal, compute_compliant, skin_check
except ImportError:  # imported as the backend package (tests)
    from . import onshape_variables as ov
    from .compliant_bars import CompliantConstraints, CompliantParams, _apply_pinch_goal, compute_compliant, skin_check

KIND = "compliant"

_SHAPE = (
    "anchor_distance", "junction_x", "junction_y", "pinch_y",
    "l_u1", "l_v1", "l_u2", "l_v2", "r_u1", "r_v1", "r_u2", "r_v2", "f_u1", "f_v1", "f_u2", "f_v2",
    "l_thickness", "r_thickness", "f_thickness",
)

# {table name: {Onshape variable: simulator value key}}, in the order the window shows them.
TABLES: dict[str, dict[str, str]] = {
    "cam_sim_compliant": {f"cb_{key}": key for key in _SHAPE},
    "cam_sim_carriage": {"carriage_closed_height": "closed_carriage_height", "carriage_pivot_offset": "pivot_offset",
                         "carriage_pivot_side": "pivot_side"},
    "cam_sim_pinch": {"pinch_closed_gap": "closed_gap", "pinch_preload": "preload"},
}


def wanted_rows(params: CompliantParams, constraints: Optional[CompliantConstraints] = None) -> dict[str, list[ov.Row]]:
    """One row per variable, per table, with the value of the design on screen."""
    c = constraints or CompliantConstraints()
    p = _apply_pinch_goal(params, c)   # the tip height the geometry is built with
    result = compute_compliant(p, fast=True, constraints=c)
    if not result.pinch or result.closed_gap <= 0.0:
        raise ov.LinkageOnshapeError(f"This geometry cannot be built, nothing to send: {result.message}")
    values = dict(asdict(p))
    values["closed_gap"] = float(result.closed_gap)
    # carriage_pivot_offset stays a distance; the side places the pivot and the carriage pin holes in the Part Studio.
    values["pivot_side"] = -1.0 if p.pivot_inverted else 1.0
    out: dict[str, list[ov.Row]] = {}
    for table, mapping in TABLES.items():
        rows = []
        for name, key in mapping.items():
            label, unit = ov.VALUES[key]
            rows.append(ov.Row(name=name, key=key, label=label, new_expression=ov._expression(float(values[key]), unit)))
        out[table] = rows
    return out


def check_skins(params: CompliantParams, constraints: Optional[CompliantConstraints] = None) -> dict:
    """Each member's tightest bend against half its thickness: below it, Onshape cannot build the skin."""
    return skin_check(_apply_pinch_goal(params, constraints or CompliantConstraints()))


def _checked_inputs(params: CompliantParams, t: ov.Target) -> tuple[dict, int]:
    try:
        measured = ov.read_measured(KIND, t)
    except (ov.LinkageOnshapeError, ov.oe.OnshapeAPIError, ov.oe.OnshapeConfigError) as exc:
        return {"configured": True, "valid": False, "rows": [], "part_studio_url": None,
                "error": f"The inputs measured in Onshape could not be read: {exc}"}, 1
    return ov.input_check(params, measured), measured["api_calls"]


def _find_tables(t: ov.Target, names: list[str]) -> dict[str, Optional[str]]:
    """Element id of each table, None when missing. One listing call for all of them, exact names."""
    data = ov._call("GET", ov._elements_path(t), query={"elementType": "VARIABLESTUDIO"})
    if not isinstance(data, list):
        raise ov.oe.OnshapeAPIError(200, "the element listing is not a list; nothing was written")
    out: dict[str, Optional[str]] = {}
    for name in names:
        found = [e.get("id") for e in data
                 if isinstance(e, dict) and e.get("elementType") == "VARIABLESTUDIO" and e.get("name") == name]
        if len(found) > 1:
            raise ov.LinkageOnshapeError(
                f"{len(found)} Variable Studios are called {name!r} in this Onshape document. Rename or remove the extra ones in Onshape."
            )
        out[name] = ov._checked_id(found[0], "element") if found else None
    return out


def preview(params: CompliantParams, constraints: Optional[CompliantConstraints] = None,
            target: Optional[ov.Target] = None) -> dict:
    """What a write would change, table by table. Reads only."""
    t = target or ov.target_from_env()
    rows = wanted_rows(params, constraints)
    skins = check_skins(params, constraints)
    check, calls = _checked_inputs(params, t)
    ids = _find_tables(t, list(rows))
    calls += 1
    tables = []
    for name, trs in rows.items():
        eid = ids[name]
        studio, referenced = ov._read_table(t, eid) if eid else ([], set())
        calls += 1 if eid else 0
        ov._locate(trs, studio, frozenset(referenced))
        tables.append(ov._summary(t, name, eid, trs, 0))
    cad, cad_calls = ov.cad_check([r for trs in rows.values() for r in trs], t, KIND)
    return {"tables": tables, "api_calls": calls + cad_calls, "input_check": check, "cad_check": cad, "skin_check": skins}


def apply(params: CompliantParams, names: list[str], constraints: Optional[CompliantConstraints] = None,
          target: Optional[ov.Target] = None) -> dict:
    """Write the named variables, each into its own table (created when missing), after the input check.

    Refused (ExportRefused, HTTP 409) when a member bends tighter than half its thickness: Onshape could not
    build its skin. A table where nothing ticked changes is neither created nor written. A failed write in one table
    is reported on that table; the others are still written, and the read-back is skipped.
    """
    t = target or ov.target_from_env()
    keep = set(names)
    rows = wanted_rows(params, constraints)
    skins = check_skins(params, constraints)
    if not skins["valid"]:   # refused before any call: nothing is read or written
        raise ov.ExportRefused(f"Export refused: {skins['message']}")
    check, calls = _checked_inputs(params, t)
    if check["configured"] and not check["valid"]:
        raise ov.ExportRefused(ov._refusal(check))
    tables = []
    for name, trs in rows.items():
        with ov._lock_for(t, name):
            summary = ov._apply_locked(t, name, keep, trs)
        calls += summary["api_calls"]
        summary["api_calls"] = 0
        tables.append(summary)
    write_error = next((s["write_error"] for s in tables if s.get("write_error")), None)
    if write_error:
        cad, cad_calls = {"configured": False, "coherent": False, "rows": [], "error": None}, 0
    else:
        written = [r for trs in rows.values() for r in trs if r.status in ("written", "created", "same")]
        cad, cad_calls = ov.cad_check(written, t, KIND)
    return {"tables": tables, "api_calls": calls + cad_calls, "input_check": check, "cad_check": cad,
            "skin_check": skins, "write_error": write_error}
