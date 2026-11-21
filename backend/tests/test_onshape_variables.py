"""Onshape variable table writes, against a fake transport: python -m unittest discover -s backend/tests."""

import copy
import threading
import time
import unittest
from dataclasses import replace
from unittest import mock

from backend import onshape_variables as ov
from backend.linkage import LinkageParams

PENDULUM = LinkageParams(linkage_type="pendulum", bar1_length=11.95, bar2_length=14.43, anchor_distance=4.79,
                         pivot_offset=4.0, foot_length=1.5, foot_angle_deg=100.0, pad_length=1.0, link_curved=True)
TARGET = ov.Target("doc", "ws")
ELEMENTS = "/documents/d/doc/w/ws/elements"


class FakeOnshape:
    """The four endpoints of the linkage write. Any other path fails the test, so nothing can go live.

    The document holds a Part Studio and another Variable Studio, the second with a name the
    tests also use for the table, to show neither is ever read or written.
    """

    def __init__(self, tables=None):
        self.elements = [
            {"id": "PS1", "name": "cam_sim_pendulum", "elementType": "PARTSTUDIO"},
            {"id": "VS0", "name": "Owner variables", "elementType": "VARIABLESTUDIO"},
        ]
        self.tables = {"VS0": [{"name": "pend_arm_L", "type": "LENGTH", "expression": "1 mm", "description": ""}]}
        for eid, (name, variables) in (tables or {}).items():
            self.elements.append({"id": eid, "name": name, "elementType": "VARIABLESTUDIO"})
            self.tables[eid] = copy.deepcopy(variables)
        self.calls = []
        self.fail_write = False
        self.ignore_filter = False   # a listing that returns every element, Part Studios included
        self.references = {}         # eid -> blocks of referenced Variable Studios in its read
        self.listing_delay = 0.0
        self.measured = {}           # variable name -> FeatureScript result, for the Part Studio PSM
        self.cad = None              # name -> FeatureScript value the Part Studio uses; None = follows the table

    def __call__(self, method, path, *, query=None, body=None, follow_redirects=True):
        assert follow_redirects is False, "the linkage write must never follow a redirect"
        self.calls.append((method, path))
        if (method, path) == ("GET", ELEMENTS):
            assert query == {"elementType": "VARIABLESTUDIO"}, query
            listing = copy.deepcopy(self.elements)
            time.sleep(self.listing_delay)
            return listing if self.ignore_filter else [e for e in listing if e["elementType"] == "VARIABLESTUDIO"]
        if (method, path) == ("POST", "/variables/d/doc/w/ws/variablestudio"):
            eid = f"NEW{len(self.tables)}"
            self.elements.append({"id": eid, "name": body["name"], "elementType": "VARIABLESTUDIO"})
            self.tables[eid] = []
            return {"id": eid, "name": body["name"], "elementType": "VARIABLESTUDIO"}
        if (method, path) == ("POST", "/partstudios/d/doc/w/ws/e/PSM/featurescript"):
            script = body["script"]
            if "for (var n in" in script:
                import json as _json
                names = _json.loads(script.split("for (var n in ")[1].split(")")[0])
                cad = self.cad if self.cad is not None else {
                    v["name"]: metres(float(v["expression"].split()[0])) if v["expression"].endswith("mm")
                    else {"btType": "BTFSValueWithUnits", "unitToPower": {"RADIAN": 1}, "value": float(v["expression"].split()[0]) * 3.141592653589793 / 180}
                    for v in (self.table("cam_sim_pendulum") or [])}
                entries = [{"key": {"btType": "BTFSValueString", "value": n}, "value": cad[n]} for n in names if n in cad]
                return {"result": {"btType": "com.belmonttech.serialize.fsvalue.BTFSValueMap", "value": entries}, "notices": []}
            var = script.split('getVariable(context, "')[1].split('"')[0]
            return {"result": copy.deepcopy(self.measured.get(var)), "notices": []}
        prefix, _, eid_part = path.partition("/variables/d/doc/w/ws/e/")
        eid = eid_part[: -len("/variables")] if eid_part.endswith("/variables") else None
        if prefix == "" and eid in self.tables:
            if method == "GET":
                own = {"variableStudioReference": None, "variables": [dict(v, value=None) for v in self.tables[eid]]}
                return [own] + copy.deepcopy(self.references.get(eid, []))
            if method == "POST":
                if self.fail_write:
                    raise ov.oe.OnshapeAPIError(400, "bad variable", None)
                self.tables[eid] = copy.deepcopy(body)
                return None
        raise AssertionError(f"unexpected Onshape call {method} {path}")

    def created(self):
        return [m for m, p in self.calls if p.endswith("/variablestudio")]

    def table(self, name):
        eids = [e["id"] for e in self.elements if e["name"] == name and e["elementType"] == "VARIABLESTUDIO"]
        return self.tables[eids[0]] if eids else None

    def expression(self, table, name):
        return next((v["expression"] for v in self.table(table) or [] if v["name"] == name), None)


HAND_MADE = [
    {"name": "pinch_tube_OD", "type": "LENGTH", "expression": "3.0 mm", "description": ""},
    {"name": "M3_length", "type": "LENGTH", "expression": "20.5 mm", "description": "screw"},
    {"name": "pend_arm_L", "type": "LENGTH", "expression": "10 mm", "description": ""},
    {"name": "pend_foot", "type": "LENGTH", "expression": "#pinch_tube_OD / 2", "description": ""},
]


class OnshapeVariablesTests(unittest.TestCase):
    def use(self, fake):
        self.fake = fake
        patcher = mock.patch.object(ov.oe, "_request_json", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fake

    def rows(self, out):
        return {r["name"]: r for r in out["rows"]}

    def untouched_elsewhere(self):
        """Only the elements listing and the table itself were ever called."""
        self.assertEqual(self.fake.tables["VS0"], [{"name": "pend_arm_L", "type": "LENGTH", "expression": "1 mm", "description": ""}])
        for _, path in self.fake.calls:
            self.assertNotIn("partstudios", path)
            self.assertNotIn("/e/VS0/", path)
            self.assertNotIn("/e/PS1/", path)

    def test_missing_table_preview_is_one_call_and_every_row_is_new(self):
        self.use(FakeOnshape())
        out = ov.preview(PENDULUM, target=TARGET)
        self.assertEqual(self.fake.calls, [("GET", ELEMENTS)])
        self.assertEqual(out["api_calls"], 1)
        self.assertEqual((out["table_name"], out["table_exists"], out["element_id"], out["table_url"]), ("cam_sim_pendulum", False, None, None))
        rows = self.rows(out)
        self.assertEqual({r["status"] for r in rows.values()}, {"new"})
        self.assertEqual(rows["pend_arm_L"]["new_expression"], "14.43 mm")
        self.assertEqual(rows["pend_foot_angle"]["new_expression"], "100 deg")
        self.assertIn("pend_link_radius", rows)
        # The tube centre is measured in the CAD and only read back: it is never written.
        self.assertNotIn("pend_tube_center", rows)
        # The pin-to-wall gap of the made shape: closed gap less the preload.
        from backend.linkage import compute_linkage
        self.assertEqual(rows["pend_pin_gap"]["new_expression"], ov._expression(compute_linkage(PENDULUM).closed_gap - PENDULUM.preload, "mm"))
        self.assertNotIn("pend_link_radius", self.rows(ov.preview(replace(PENDULUM, link_curved=False), target=TARGET)))
        self.untouched_elsewhere()

    def test_missing_table_is_created_then_filled(self):
        self.use(FakeOnshape())
        out = ov.apply(PENDULUM, ["pend_arm_L", "pend_foot_angle", "pinch_tube_OD"], target=TARGET)
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "POST", "POST"])   # list, create, write: no read
        self.assertEqual(out["api_calls"], 3)
        self.assertTrue(out["table_created"])
        eid = out["element_id"]
        self.assertEqual(out["table_url"], f"https://cad.onshape.com/documents/doc/w/ws/e/{eid}")
        rows = self.rows(out)
        self.assertEqual(rows["pend_arm_L"]["status"], "created")
        self.assertEqual(rows["pend_stroke"]["status"], "skipped")
        self.assertEqual(self.fake.table("cam_sim_pendulum"), [
            {"name": "pend_arm_L", "type": "LENGTH", "expression": "14.43 mm", "description": "Bar hinged at the anchor (cam profile simulator)"},
            {"name": "pend_foot_angle", "type": "ANGLE", "expression": "100 deg", "description": "Foot angle (cam profile simulator)"},
            {"name": "pinch_tube_OD", "type": "LENGTH", "expression": "3 mm", "description": "Tube OD (cam profile simulator)"},
        ])
        # The second time the table is there: found, read, merged.
        self.fake.calls.clear()
        out = ov.apply(PENDULUM, ["pend_anchor"], target=TARGET)
        self.assertFalse(out["table_created"])
        self.assertEqual(out["element_id"], eid)
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "GET", "POST"])
        self.assertEqual([v["name"] for v in self.fake.table("cam_sim_pendulum")], ["pend_arm_L", "pend_foot_angle", "pinch_tube_OD", "pend_anchor"])
        self.untouched_elsewhere()

    def test_existing_table_keeps_hand_made_variables(self):
        self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE)}))
        prev = ov.preview(PENDULUM, target=TARGET)
        self.assertEqual(self.fake.calls, [("GET", ELEMENTS), ("GET", "/variables/d/doc/w/ws/e/T1/variables")])
        self.assertEqual(prev["api_calls"], 2)
        self.assertTrue(prev["table_exists"])
        rows = self.rows(prev)
        self.assertEqual(rows["pinch_tube_OD"]["status"], "same")          # "3.0 mm" is 3 mm
        self.assertEqual(rows["pend_arm_L"]["status"], "update")
        self.assertEqual(rows["pend_arm_L"]["current_expression"], "10 mm")
        self.assertEqual(rows["pend_foot"]["status"], "update")            # an expression, not a number: never "same"
        self.assertEqual(rows["pend_anchor"]["status"], "new")

        self.fake.calls.clear()
        out = self.rows(ov.apply(PENDULUM, ["pend_arm_L", "pend_anchor", "pinch_tube_OD"], target=TARGET))
        self.assertEqual(out["pend_arm_L"]["status"], "written")
        self.assertEqual(out["pend_anchor"]["status"], "created")
        self.assertEqual(out["pinch_tube_OD"]["status"], "same")
        self.assertEqual(out["pend_foot"]["status"], "skipped")
        table = self.fake.table("cam_sim_pendulum")
        self.assertEqual([v["name"] for v in table], ["pinch_tube_OD", "M3_length", "pend_arm_L", "pend_foot", "pend_anchor"])
        self.assertEqual(table[1], HAND_MADE[1])                           # the hand-made one, exactly as read
        self.assertEqual(table[3]["expression"], "#pinch_tube_OD / 2")     # not ticked: kept
        self.assertEqual(self.fake.expression("cam_sim_pendulum", "pend_arm_L"), "14.43 mm")
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "GET", "POST"])
        self.untouched_elsewhere()

    def test_a_new_name_gives_a_new_table(self):
        self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE)}))
        out = ov.apply(PENDULUM, ["pend_arm_L"], table_name="  pendulum v2  ", target=TARGET)
        self.assertTrue(out["table_created"])
        self.assertEqual(out["table_name"], "pendulum v2")
        self.assertEqual(self.fake.table("pendulum v2")[0]["expression"], "14.43 mm")
        self.assertEqual(self.fake.table("cam_sim_pendulum"), HAND_MADE)
        self.untouched_elsewhere()

    def test_duplicate_names_are_refused(self):
        self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE), "T2": ("cam_sim_pendulum", [])}))
        for call in (lambda: ov.preview(PENDULUM, target=TARGET), lambda: ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)):
            with self.assertRaisesRegex(ov.LinkageOnshapeError, "2 Variable Studios are called 'cam_sim_pendulum'"):
                call()
        self.assertEqual(self.fake.calls, [("GET", ELEMENTS), ("GET", ELEMENTS)])

    def test_bad_table_names_are_refused_before_any_call(self):
        self.use(FakeOnshape())
        for bad in ("x" * 61, "a/b", "été", "name;drop", "tab\tname"):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.preview(PENDULUM, table_name=bad, target=TARGET)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(ov.table_name_for("lever", ""), "cam_sim_lever")
        self.assertEqual(ov.table_name_for("elbow", None), "cam_sim_elbow")
        self.assertEqual(ov.table_name_for("elbow", "My table-2_b"), "My table-2_b")

    def test_nothing_selected_creates_nothing(self):
        self.use(FakeOnshape())
        out = ov.apply(PENDULUM, [], target=TARGET)
        self.assertEqual(self.fake.calls, [("GET", ELEMENTS)])
        self.assertFalse(out["table_exists"])

    def test_failed_write_still_reports_the_created_table(self):
        fake = self.use(FakeOnshape())
        fake.fail_write = True
        out = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertTrue(out["table_created"])
        self.assertTrue(out["table_url"].endswith(out["element_id"]))
        self.assertEqual(self.rows(out)["pend_arm_L"]["status"], "error")
        self.assertIn("bad variable", out["write_error"])
        # The retry finds the table just created and writes into it: still one table.
        fake.fail_write = False
        again = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertFalse(again["table_created"])
        self.assertIsNone(again["write_error"])
        self.assertEqual(again["element_id"], out["element_id"])
        self.assertEqual(len(fake.created()), 1)
        self.assertEqual(fake.expression("cam_sim_pendulum", "pend_arm_L"), "14.43 mm")

    def test_a_network_failure_on_write_is_reported_too(self):
        fake = self.use(FakeOnshape())
        real = fake.__call__

        def broken(method, path, **kw):
            if method == "POST" and path.endswith("/variables"):
                fake.calls.append((method, path))
                raise OSError("timed out")
            return real(method, path, **kw)
        self.use(broken).calls = fake.calls
        out = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertTrue(out["table_created"])
        self.assertEqual(out["write_error"], "timed out")

    def test_same_name_on_another_element_type_is_not_the_table(self):
        # The listing ignores the filter: PS1 (a Part Studio called cam_sim_pendulum) comes back too.
        fake = self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE)}))
        fake.ignore_filter = True
        out = ov.preview(PENDULUM, target=TARGET)
        self.assertEqual(out["element_id"], "T1")                          # not a duplicate of PS1
        fake = self.use(FakeOnshape())
        fake.ignore_filter = True
        out = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertTrue(out["table_created"])                              # PS1 is not the table
        self.assertNotEqual(out["element_id"], "PS1")
        self.untouched_elsewhere()

    def test_name_match_is_exact(self):
        # Case and spaces on the Onshape side count; the name typed is trimmed.
        fake = self.use(FakeOnshape({"T1": ("Cam_Sim_Pendulum", HAND_MADE), "T2": ("cam_sim_pendulum ", HAND_MADE),
                                     "T3": ("cam_sim  pendulum", HAND_MADE)}))
        self.assertFalse(ov.preview(PENDULUM, target=TARGET)["table_exists"])
        self.assertEqual(ov.preview(PENDULUM, table_name=" Cam_Sim_Pendulum ", target=TARGET)["element_id"], "T1")
        self.assertEqual(ov.preview(PENDULUM, table_name="cam_sim  pendulum", target=TARGET)["element_id"], "T3")
        ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertEqual(len(fake.created()), 1)
        for eid in ("T1", "T2", "T3"):
            self.assertEqual(fake.tables[eid], HAND_MADE)

    def test_referenced_studios_are_never_written_back(self):
        fake = self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE[:2])}))
        ref = {"variableStudioReference": {"elementId": "VS0"},
               "variables": [{"name": "pend_arm_L", "type": "LENGTH", "expression": "1 mm", "description": ""}]}
        fake.references["T1"] = [ref]
        rows = self.rows(ov.preview(PENDULUM, target=TARGET))
        self.assertEqual(rows["pend_arm_L"]["status"], "new")              # not in the table's own list
        self.assertIn("references", rows["pend_arm_L"]["detail"])
        ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertEqual([v["name"] for v in fake.tables["T1"]], ["pinch_tube_OD", "M3_length", "pend_arm_L"])
        self.untouched_elsewhere()

    def test_unexpected_replies_stop_before_any_write(self):
        for listing in ({"items": []}, None):
            fake = self.use(FakeOnshape())

            def odd_listing(method, path, listing=listing, fake=fake, **kw):
                fake.calls.append((method, path))
                return listing if path == ELEMENTS else fake(method, path, **kw)
            self.use(odd_listing)
            with self.assertRaises(ov.oe.OnshapeAPIError):
                ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
            self.assertEqual(fake.calls, [("GET", ELEMENTS)])
        for read in ([], [{"variableStudioReference": None}], None, [{"variableStudioReference": None, "variables": [{"type": "LENGTH"}]}],
                     [{"variableStudioReference": None, "variables": []}, {"variableStudioReference": None, "variables": []}]):
            fake = self.use(FakeOnshape({"T1": ("cam_sim_pendulum", HAND_MADE)}))
            real = FakeOnshape.__call__

            def odd(method, path, read=read, fake=fake, **kw):
                if method == "GET" and path.endswith("/e/T1/variables"):
                    fake.calls.append((method, path))
                    return read
                return real(fake, method, path, **kw)
            self.use(odd)
            with self.assertRaises(ov.oe.OnshapeAPIError):
                ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
            self.assertNotIn("POST", [m for m, _ in fake.calls])
            self.assertEqual(fake.tables["T1"], HAND_MADE)

    def test_odd_element_ids_are_refused(self):
        fake = self.use(FakeOnshape({"../PS1": ("cam_sim_pendulum", [])}))
        with self.assertRaises(ov.LinkageOnshapeError):
            ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertEqual(fake.calls, [("GET", ELEMENTS)])
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_DOCUMENT_ID": "d/../x", "ONSHAPE_WORKSPACE_ID": "w"}):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.target_from_env()

    def test_written_variables_get_the_type_of_their_unit_and_keep_their_keys(self):
        old = [{"name": "pend_foot_angle", "type": "LENGTH", "expression": "3 mm"},
               {"name": "note", "type": "ANY", "expression": "\"x\""}]
        fake = self.use(FakeOnshape({"T1": ("cam_sim_pendulum", old)}))
        ov.apply(PENDULUM, ["pend_foot_angle"], target=TARGET)
        self.assertEqual(fake.tables["T1"], [{"name": "pend_foot_angle", "type": "ANGLE", "expression": "100 deg"}, old[1]])

    def test_expressions_are_plain_numbers(self):
        self.assertEqual(ov._expression(114.43216, "mm"), "114.4322 mm")
        self.assertEqual(ov._expression(1234567.0, "mm"), "1234567 mm")
        self.assertEqual(ov._expression(-0.00001, "mm"), "0 mm")
        self.assertEqual(ov._expression(-2.5, "deg"), "-2.5 deg")
        self.assertEqual(ov._expression(3, ""), "3")

    def test_two_clicks_at_once_create_one_table(self):
        fake = self.use(FakeOnshape())
        fake.listing_delay = 0.05
        out = []
        threads = [threading.Thread(target=lambda: out.append(ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET))) for _ in range(2)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(len(fake.created()), 1)
        self.assertEqual(sorted(o["table_created"] for o in out), [False, True])

    def test_elbow_names_follow_the_onshape_sketch(self):
        # In the CAD sketch L1 starts at the fixed anchor: the simulator's bar 2.
        rows = {r.name: r for r in ov.wanted_rows(LinkageParams(bar1_length=13.0, bar2_length=7.8))}
        self.assertEqual(rows["L1"].new_expression, "7.8 mm")
        self.assertEqual(rows["L2"].new_expression, "13 mm")

    def test_configuration_errors_are_explicit(self):
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_DOCUMENT_ID": "d", "ONSHAPE_WORKSPACE_ID": ""}, clear=True):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.target_from_env()
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_DOCUMENT_ID": "d", "ONSHAPE_WORKSPACE_ID": "w", "ONSHAPE_LINKAGE_WORKSPACE_ID": "main"}, clear=True):
            self.assertEqual(ov.target_from_env().workspace_id, "main")      # the table's own branch wins
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_DOCUMENT_ID": "d", "ONSHAPE_WORKSPACE_ID": "w"}, clear=True):
            self.assertEqual(ov.target_from_env(), ov.Target("d", "w"))
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MAPPING": '{"pendulum": {"x": "nope"}}'}):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.mapping_for("pendulum")
        with self.assertRaises(ov.LinkageOnshapeError):
            ov.wanted_rows(replace(LinkageParams(), bar2_length=-1.0))

    def test_an_inverted_pivot_is_written_only_where_the_sketch_can_draw_it(self):
        normal = [(r.name, r.new_expression) for r in ov.wanted_rows(PENDULUM)]
        self.assertNotIn("pivot_side", [r.key for r in ov.wanted_rows(PENDULUM)])   # the default rows are as before
        inverted = replace(PENDULUM, pivot_inverted=True, bar1_length=8.713, bar2_length=18.0, anchor_distance=-1.405,
                           foot_length=3.468, foot_angle_deg=105.909, stroke=0.3)
        with self.assertRaises(ov.LinkageOnshapeError) as refused:
            ov.wanted_rows(inverted)
        self.assertIn("Nothing was sent", str(refused.exception))
        mapping = '{"pendulum": {"pend_arm_L": "bar2_length", "pend_pivot_offset": "pivot_offset", "pend_pivot_side": "pivot_side"}}'
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MAPPING": mapping}):
            rows = {r.name: r.new_expression for r in ov.wanted_rows(inverted)}
            self.assertEqual(rows["pend_pivot_side"], "-1")
            self.assertEqual(rows["pend_pivot_offset"], "4 mm")   # a distance, the side says where
            self.assertEqual({r.name: r.new_expression for r in ov.wanted_rows(PENDULUM)}["pend_pivot_side"], "1")
        self.assertEqual([(r.name, r.new_expression) for r in ov.wanted_rows(PENDULUM)], normal)


def metres(mm):
    return {"btType": "com.belmonttech.serialize.fsvalue.BTFSValueWithUnits", "unitToPower": {"METER": 1}, "value": mm / 1000.0}


class MeasuredInputsTests(unittest.TestCase):
    """The CAD's measured tube centre is an input: an export is valid only when the simulation starts from it."""

    use = OnshapeVariablesTests.use

    def setUp(self):
        patcher = mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID": "PSM"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_not_configured_reads_nothing(self):
        self.use(FakeOnshape())
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID": ""}):
            out = ov.preview(PENDULUM, target=TARGET)
            self.assertEqual(ov.read_measured("pendulum", TARGET)["configured"], False)
        self.assertEqual(out["input_check"]["configured"], False)
        self.assertNotIn("partstudios", " ".join(p for _, p in self.fake.calls))
        self.assertFalse(ov.read_measured("lever", TARGET)["configured"])   # no measured input for this kind

    def test_read_gives_millimetres(self):
        fake = self.use(FakeOnshape())
        fake.measured["pend_CALC_tube_center"] = metres(8.075)
        out = ov.read_measured("pendulum", TARGET)
        self.assertEqual(out["api_calls"], 1)
        self.assertAlmostEqual(out["values"][0]["value"], 8.075, places=9)
        self.assertEqual((out["values"][0]["key"], out["values"][0]["variable"]), ("tube_center_x", "pend_CALC_tube_center"))

    def test_matching_inputs_make_a_valid_export(self):
        fake = self.use(FakeOnshape())
        fake.measured["pend_CALC_tube_center"] = metres(PENDULUM.tube_center_x + 0.0004)
        out = ov.preview(PENDULUM, target=TARGET)
        self.assertTrue(out["input_check"]["valid"])
        self.assertEqual(out["api_calls"], 3)          # the listing, the measure and the Part Studio read-back
        written = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        self.assertTrue(written["input_check"]["valid"])
        self.assertEqual(fake.expression("cam_sim_pendulum", "pend_arm_L"), "14.43 mm")

    def test_differing_inputs_refuse_the_export_before_any_write(self):
        fake = self.use(FakeOnshape())
        fake.measured["pend_CALC_tube_center"] = metres(8.075)
        out = ov.preview(replace(PENDULUM, tube_center_x=8.1), target=TARGET)
        check = out["input_check"]
        self.assertFalse(check["valid"])
        self.assertEqual([(r["key"], r["ok"]) for r in check["rows"]], [("tube_center_x", False)])
        calls = len(fake.calls)
        with self.assertRaises(ov.ExportRefused) as refused:
            ov.apply(replace(PENDULUM, tube_center_x=8.1), ["pend_arm_L"], target=TARGET)
        self.assertIn("8.0750", str(refused.exception))
        self.assertEqual([m for m, p in fake.calls[calls:] if "/variables" in p and m == "POST"], [])
        self.assertIsNone(fake.table("cam_sim_pendulum"))
        # Synced to the measure, the same export goes through.
        ov.apply(replace(PENDULUM, tube_center_x=8.075), ["pend_arm_L"], target=TARGET)
        self.assertEqual(fake.expression("cam_sim_pendulum", "pend_arm_L"), "14.43 mm")

    def test_a_measure_that_cannot_be_read_refuses_the_export(self):
        fake = self.use(FakeOnshape())          # the variable is not in the Part Studio
        out = ov.preview(PENDULUM, target=TARGET)
        self.assertFalse(out["input_check"]["valid"])
        self.assertIn("pend_CALC_tube_center", out["input_check"]["error"])
        with self.assertRaises(ov.ExportRefused):
            ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)
        fake.measured["pend_CALC_tube_center"] = {"btType": "BTFSValueWithUnits", "unitToPower": {"RADIAN": 1}, "value": 1.0}
        self.assertIn("not a mm", ov.preview(PENDULUM, target=TARGET)["input_check"]["error"])

    def test_the_part_studio_is_checked_against_what_was_written(self):
        fake = self.use(FakeOnshape())
        fake.measured["pend_CALC_tube_center"] = metres(PENDULUM.tube_center_x)
        before = ov.preview(PENDULUM, target=TARGET)["cad_check"]
        self.assertTrue(before["configured"])
        self.assertFalse(before["coherent"])                       # nothing written yet: the Part Studio has none of them
        self.assertTrue(all(r["onshape"] is None for r in before["rows"]))
        out = ov.apply(PENDULUM, [r.name for r in ov.wanted_rows(PENDULUM)], target=TARGET)
        self.assertTrue(out["cad_check"]["coherent"], out["cad_check"])   # the Part Studio follows the table
        # A Part Studio that keeps its own value for one of them is reported, value and all.
        fake.cad = {r.name: metres(1.0) if r.name == "pend_arm_L" else None for r in ov.wanted_rows(PENDULUM)}
        fake.cad = {k: v for k, v in fake.cad.items() if v is not None}
        after = ov.apply(PENDULUM, ["pend_arm_L"], target=TARGET)["cad_check"]
        bad = [r for r in after["rows"] if not r["ok"]]
        self.assertFalse(after["coherent"])
        self.assertEqual(bad[0]["name"], "pend_arm_L")
        self.assertAlmostEqual(bad[0]["onshape"], 1.0)

    def test_odd_measured_mapping_is_refused(self):
        self.use(FakeOnshape())
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MEASURED": '{"pendulum": {"tube_center_x": "x\\" + 1"}}'}):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.read_measured("pendulum", TARGET)


class OnshapeEndpointsTests(unittest.TestCase):
    """The two routes as FastAPI serves them (main.py imports its siblings by bare name)."""

    @classmethod
    def setUpClass(cls):
        import os
        import sys
        import tempfile
        try:
            from fastapi.testclient import TestClient
        except Exception as exc:   # httpx missing
            raise unittest.SkipTest(f"TestClient unavailable: {exc}")
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sys.path.insert(0, backend_dir)
        os.environ["SIM_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
        import main
        import onshape_variables
        cls.main, cls.module = main, onshape_variables
        cls.client = TestClient(main.app)

    def test_materials_builtin_and_custom(self):
        c = self.client
        names = lambda: [(m["name"], m["builtin"]) for m in c.get("/api/linkage/materials").json()["materials"]]
        expected_builtins = [
            ("PETG Basic (bamb)", True),
            ("PETG Translucent (bamb)", True),
            ("PLA Basic (bamb)", True),
            ("ABS (bamb)", True),
        ]
        self.assertEqual(names(), expected_builtins)
        self.assertEqual(c.put("/api/linkage/materials/Nylon PA12", json={"modulus_mpa": 1700, "strength_mpa": 45}).json()["status"], "saved")
        self.assertEqual(c.put("/api/linkage/materials/Nylon PA12", json={"modulus_mpa": 1800, "strength_mpa": 45}).json()["status"], "updated")
        got = c.get("/api/linkage/materials").json()["materials"][-1]
        self.assertEqual(got, {"name": "Nylon PA12", "modulus_mpa": 1800.0, "strength_mpa": 45.0, "builtin": False})
        # The built-in ones cannot be overwritten or deleted, and a material needs a modulus.
        self.assertEqual(c.put("/api/linkage/materials/pla basic (bamb)", json={"modulus_mpa": 1, "strength_mpa": 1}).status_code, 409)
        self.assertEqual(c.delete("/api/linkage/materials/PETG Basic (bamb)").status_code, 409)
        self.assertEqual(c.put("/api/linkage/materials/X", json={"modulus_mpa": 0, "strength_mpa": 1}).status_code, 422)
        # Custom materials do not show up as linkage profiles.
        self.assertEqual(c.get("/api/linkage/profiles?kind=material").status_code, 404)
        self.assertEqual(c.delete("/api/linkage/materials/Nylon PA12").json()["status"], "deleted")
        self.assertEqual(c.delete("/api/linkage/materials/Nylon PA12").status_code, 404)
        self.assertEqual(names(), expected_builtins)

    def test_linkage_profile_keeps_chart_settings(self):
        c = self.client
        url = "/api/linkage/profiles/lever/charts"
        flow = {"autoX": True, "autoY": False, "xMin": -1, "xMax": 1, "yMin": 0, "yMax": 30}
        c.put(url, json={"params": {"bar1_length": 6.9}, "search": {}, "chart_settings": {"flow": flow}})
        self.assertEqual(c.get(url).json()["chart_settings"], {"flow": flow})
        # A client that does not send the field still saves, with no chart settings.
        c.put(url, json={"params": {"bar1_length": 7.0}})
        self.assertEqual(c.get(url).json(), {"params": {"bar1_length": 7.0}, "search": {}, "chart_settings": {}})
        # A profile stored before the field existed still loads.
        self.main.profiles.save("lever", "old", {"params": {"bar1_length": 5.0}, "search": {}})
        self.assertEqual(c.get("/api/linkage/profiles/lever/old").json(), {"params": {"bar1_length": 5.0}, "search": {}})
        c.delete(url)
        c.delete("/api/linkage/profiles/lever/old")

    def onshape(self, fake):
        return mock.patch.object(self.module.oe, "_request_json", fake), \
            mock.patch.object(self.module, "target_from_env", lambda: self.module.Target("doc", "ws"))

    def test_preview_then_apply(self):
        fake = FakeOnshape()
        body = {"linkage_type": "pendulum", "bar1_length": 11.95, "bar2_length": 14.43, "anchor_distance": 4.79,
                "pivot_offset": 4.0, "pad_length": 1.0, "link_curved": True}
        a, b = self.onshape(fake)
        with a, b:
            self.assertEqual(self.client.post("/api/linkage/simulate", json=body).status_code, 200)
            res = self.client.post("/api/linkage/onshape/preview", json={**body, "table_name": "cam_sim_pendulum"})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertFalse(res.json()["table_exists"])
            self.assertEqual({r["name"]: r["status"] for r in res.json()["rows"]}["pend_arm_L"], "new")
            res = self.client.post("/api/linkage/onshape/apply", json={**body, "names": ["pend_arm_L"]})   # no name: the default
            self.assertEqual(res.status_code, 200, res.text)
            self.assertTrue(res.json()["table_created"])
            self.assertIn("/e/", res.json()["table_url"])
            self.assertEqual(fake.expression("cam_sim_pendulum", "pend_arm_L"), "14.43 mm")

    def test_bad_name_is_422_and_duplicates_409(self):
        fake = FakeOnshape({"T1": ("dup", []), "T2": ("dup", [])})
        a, b = self.onshape(fake)
        with a, b:
            res = self.client.post("/api/linkage/onshape/preview", json={"linkage_type": "pendulum", "table_name": "x" * 61})
            self.assertEqual(res.status_code, 422)
            self.assertIn("1 to 60 characters", res.json()["detail"])
            res = self.client.post("/api/linkage/onshape/apply", json={"linkage_type": "pendulum", "table_name": "dup", "names": ["pend_arm_L"]})
            self.assertEqual(res.status_code, 409)
            self.assertIn("2 Variable Studios", res.json()["detail"])
        self.assertEqual(fake.calls, [("GET", ELEMENTS)])

    def test_unconfigured_target_is_a_409_with_the_reason(self):
        with mock.patch.dict(self.module.os.environ, {"ONSHAPE_DOCUMENT_ID": "", "ONSHAPE_WORKSPACE_ID": ""}), \
                mock.patch.object(self.module.oe, "_request_json", FakeOnshape()):
            res = self.client.post("/api/linkage/onshape/preview", json={"linkage_type": "pendulum"})
        self.assertEqual(res.status_code, 409)
        self.assertIn("ONSHAPE_DOCUMENT_ID", res.json()["detail"])


if __name__ == "__main__":
    unittest.main()
