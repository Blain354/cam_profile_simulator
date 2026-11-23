"""Compliant Bars written to its split Onshape tables, against the fake transport of test_onshape_variables."""

import unittest
from dataclasses import replace
from unittest import mock

import numpy as np

from backend import onshape_compliant as oc
from backend.compliant_bars import CompliantConstraints, CompliantParams, bezier_min_radius, skin_check
from backend.tests.test_onshape_variables import FakeOnshape, metres

ov = oc.ov
TARGET = ov.Target("doc", "ws")
# The CAD the tests measure: tube centre 8.75, depth 4, tube 3 x 2 (the splines Part Studio).
DESIGN = CompliantParams(tube_center_x=8.75, member_depth=4.0, tube_od=3.0, tube_id=2.0)
MEASURED = {"pend_CALC_tube_center": metres(8.75), "cb_member_depth": metres(4.0),
            "pinch_tube_OD": metres(3.0), "pinch_tube_ID": metres(2.0)}
OWNER_TABLES = {
    # cam_sim_compliant exists with a variable added by hand; the two shared tables do not exist yet.
    "VSC": ("cam_sim_compliant", [
        {"name": "cb_anchor_distance", "type": "LENGTH", "expression": "4.8 mm", "description": "hand"},
        {"name": "cb_sketch_datum", "type": "LENGTH", "expression": "30 mm", "description": "CAD only"},
    ]),
}
# Pivot side +1 with R handles kept from a pivot -1 design: R hooks to a 0.31 mm radius, below half its
# 0.75 mm thickness. In Onshape (2026-11-23) the skin sketch went over-defined and the eyelet fillets failed.
HOOKED_R = replace(DESIGN, junction_x=4.7798, junction_y=8.7458, pivot_offset=3.25, closed_carriage_height=11.5,
                   pivot_inverted=False, r_u1=0.0907, r_v1=5.8792, r_u2=0.5399, r_v2=6.9578, r_thickness=0.75)


def fs_number(x):
    return {"btType": "com.belmonttech.serialize.fsvalue.BTFSValueNumber", "value": x}


class CompliantOnshapeTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(ov.os.environ, {"ONSHAPE_COMPLIANT_PART_STUDIO_ID": "PSM", "ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID": "OTHER"})
        env.start()
        self.addCleanup(env.stop)

    def use(self, fake):
        fake.measured.update(MEASURED)
        patcher = mock.patch.object(ov.oe, "_request_json", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fake = fake
        return fake

    def follow_tables(self):
        """The Part Studio uses every value now in the three tables (what a reference does)."""
        cad = {}
        for table in oc.TABLES:
            for v in self.fake.table(table) or []:
                num, _, unit = v["expression"].partition(" ")
                cad[v["name"]] = metres(float(num)) if unit == "mm" else fs_number(float(num))
        self.fake.cad = cad

    def test_every_variable_lives_in_one_table_only(self):
        names = [n for m in oc.TABLES.values() for n in m]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(oc.TABLES), {"cam_sim_compliant", "cam_sim_carriage", "cam_sim_pinch"})
        # The tube and the depth are the CAD's: never written by this tab.
        for key in ("tube_od", "tube_id", "tube_center_x", "member_depth"):
            self.assertNotIn(key, [k for m in oc.TABLES.values() for k in m.values()])

    def test_preview_reads_the_three_tables_with_one_listing(self):
        fake = self.use(FakeOnshape(OWNER_TABLES))
        out = oc.preview(DESIGN, target=TARGET)
        by_table = {t["table_name"]: t for t in out["tables"]}
        self.assertEqual(list(by_table), list(oc.TABLES))
        self.assertTrue(by_table["cam_sim_compliant"]["table_exists"])
        self.assertFalse(by_table["cam_sim_carriage"]["table_exists"])
        rows = {r["name"]: r for t in out["tables"] for r in t["rows"]}
        self.assertEqual(rows["cb_anchor_distance"]["status"], "same")
        self.assertEqual(rows["cb_l_u1"]["new_expression"], "0.35")
        self.assertEqual(rows["cb_l_v1"]["new_expression"], "-0.8 mm")
        self.assertEqual(rows["carriage_pivot_offset"]["new_expression"], "4 mm")
        self.assertEqual(rows["pinch_preload"]["new_expression"], "0.1 mm")
        self.assertTrue(rows["pinch_closed_gap"]["new_expression"].endswith(" mm"))
        listings = [p for m, p in fake.calls if p.endswith("/elements")]
        self.assertEqual(len(listings), 1)
        self.assertTrue(out["input_check"]["valid"], out["input_check"])
        # Measured in the compliant Part Studio, never in the linkage one.
        self.assertFalse(any("/e/OTHER/" in p for _, p in fake.calls))

    def test_apply_creates_the_missing_tables_and_keeps_hand_made_variables(self):
        fake = self.use(FakeOnshape(OWNER_TABLES))
        names = [r.name for rows in oc.wanted_rows(DESIGN).values() for r in rows]
        out = oc.apply(DESIGN, names, target=TARGET)
        self.assertIsNone(out["write_error"])
        self.assertEqual(fake.expression("cam_sim_compliant", "cb_sketch_datum"), "30 mm")   # kept
        self.assertEqual(fake.expression("cam_sim_compliant", "cb_junction_x"), "-5.5 mm")
        self.assertEqual(fake.expression("cam_sim_carriage", "carriage_closed_height"), "8 mm")
        self.assertEqual(fake.expression("cam_sim_pinch", "pinch_preload"), "0.1 mm")
        types = {v["name"]: v["type"] for v in fake.table("cam_sim_compliant")}
        self.assertEqual((types["cb_l_u1"], types["cb_l_v1"]), ("NUMBER", "LENGTH"))
        self.assertEqual(sorted(fake.created()), ["POST", "POST"])          # carriage and pinch, not compliant
        # The Part Studio follows: the read-back is coherent, plain numbers included.
        self.follow_tables()
        again = oc.apply(DESIGN, names, target=TARGET)
        self.assertTrue(again["cad_check"]["coherent"], again["cad_check"])

    def test_the_effective_tip_height_is_written(self):
        self.use(FakeOnshape())
        c = CompliantConstraints(target_pinch_from_top_mm=6.0)
        rows = {r.name: r for t in oc.wanted_rows(DESIGN, c).values() for r in t}
        self.assertEqual(rows["cb_pinch_y"].new_expression, "10 mm")     # 2 x 8 - 6

    def test_measured_inputs_gate_the_write(self):
        fake = self.use(FakeOnshape())
        fake.measured["cb_member_depth"] = metres(3.0)
        with self.assertRaises(ov.ExportRefused) as refused:
            oc.apply(DESIGN, ["cb_junction_x"], target=TARGET)
        self.assertIn("cb_member_depth", str(refused.exception))
        self.assertEqual(fake.created(), [])
        self.assertTrue(oc.apply(replace(DESIGN, member_depth=3.0), ["cb_junction_x"], target=TARGET)["input_check"]["valid"])

    def test_the_pivot_side_is_written_with_the_offset(self):
        self.use(FakeOnshape())
        rows = {r.name: r for t in oc.wanted_rows(DESIGN).values() for r in t}
        self.assertEqual(rows["carriage_pivot_side"].new_expression, "1")
        inverted = {r.name: r for t in oc.wanted_rows(replace(DESIGN, pivot_inverted=True)).values() for r in t}
        self.assertEqual(inverted["carriage_pivot_side"].new_expression, "-1")
        self.assertEqual(inverted["carriage_pivot_offset"].new_expression, "4 mm")   # still a distance
        out = oc.apply(replace(DESIGN, pivot_inverted=True), ["carriage_pivot_side"], target=TARGET)
        self.assertEqual(self.fake.expression("cam_sim_carriage", "carriage_pivot_side"), "-1")
        self.assertEqual({v["name"]: v["type"] for v in self.fake.table("cam_sim_carriage")}["carriage_pivot_side"], "NUMBER")
        self.assertIsNone(out["write_error"])

    def test_nothing_ticked_creates_nothing(self):
        fake = self.use(FakeOnshape())
        out = oc.apply(DESIGN, [], target=TARGET)
        self.assertEqual(fake.created(), [])
        self.assertTrue(all(r["status"] == "skipped" for t in out["tables"] for r in t["rows"]))

    def test_no_compliant_part_studio_means_no_measure(self):
        fake = self.use(FakeOnshape())
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_COMPLIANT_PART_STUDIO_ID": ""}):
            out = oc.preview(DESIGN, target=TARGET)
        self.assertFalse(out["input_check"]["configured"])
        self.assertFalse(out["cad_check"]["configured"])
        self.assertNotIn("partstudios", " ".join(p for _, p in fake.calls))

    def test_no_pendulum_fallback_for_compliant(self):
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MEASURED": '{"pendulum": {"tube_center_x": "pend_x"}}'}):
            self.assertEqual(ov.measured_for("compliant")["member_depth"], "cb_member_depth")

    def test_preview_flags_a_member_that_bends_tighter_than_half_its_thickness(self):
        self.use(FakeOnshape(OWNER_TABLES))
        out = oc.preview(HOOKED_R, target=TARGET)
        skins = out["skin_check"]
        self.assertFalse(skins["valid"])
        r = {row["member"]: row for row in skins["rows"]}["r"]
        self.assertFalse(r["ok"])
        self.assertAlmostEqual(r["min_radius_mm"], 0.31, delta=0.005)
        self.assertEqual(r["half_thickness_mm"], 0.375)
        self.assertEqual(r["thickness_variable"], "cb_r_thickness")
        self.assertIn("R (junction to carriage pivot eye)", skins["message"])
        self.assertIn("0.312 mm", skins["message"])
        self.assertIn("0.375 mm", skins["message"])
        self.assertEqual([t["table_name"] for t in out["tables"]], list(oc.TABLES))   # still shown, flagged
        self.assertTrue(oc.preview(DESIGN, target=TARGET)["skin_check"]["valid"])

    def test_apply_refuses_a_member_onshape_cannot_skin_before_any_call(self):
        fake = self.use(FakeOnshape(OWNER_TABLES))
        names = [r.name for rows in oc.wanted_rows(HOOKED_R).values() for r in rows]
        with self.assertRaises(ov.ExportRefused) as refused:
            oc.apply(HOOKED_R, names, target=TARGET)
        self.assertIn("R (junction to carriage pivot eye)", str(refused.exception))
        self.assertEqual(fake.calls, [])
        # Thin enough that half the thickness fits inside the bend: the same shape is written.
        self.assertIsNone(oc.apply(replace(HOOKED_R, r_thickness=0.6), names, target=TARGET)["write_error"])

    def test_the_guard_reads_the_member_thickness(self):
        self.assertTrue(skin_check(replace(HOOKED_R, r_thickness=0.62))["valid"])
        self.assertFalse(skin_check(replace(HOOKED_R, r_thickness=0.63))["valid"])


class SkinRadiusTests(unittest.TestCase):
    def test_a_straight_spline_never_fails(self):
        self.assertEqual(bezier_min_radius((0, 0), (10, 0), 0.3, 0.0, 0.7, 0.0), float("inf"))

    def test_a_circular_arc_gives_its_radius(self):
        # Quarter circle of radius 5 from (5, 0) to (0, 5), handles at the usual k = 0.5523 R.
        k = 0.5523 * 5
        s, e = (5.0, 0.0), (0.0, 5.0)
        chord = 5 * 2 ** 0.5
        # (u, v) of (5, k) and (k, 5) along the chord, v to its left (the left normal points away from the centre).
        d = (np.array(e) - s) / chord
        n = np.array([-d[1], d[0]])
        u1, v1 = float((np.array((5, k)) - s) @ d / chord), float((np.array((5, k)) - s) @ n)
        u2, v2 = float((np.array((k, 5)) - s) @ d / chord), float((np.array((k, 5)) - s) @ n)
        self.assertAlmostEqual(bezier_min_radius(s, e, u1, v1, u2, v2), 5.0, delta=0.05)


class CompliantEndpointsTests(unittest.TestCase):
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
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        os.environ.setdefault("SIM_DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
        import main
        cls.main, cls.client = main, TestClient(main.app)

    def test_preview_then_apply(self):
        mod = self.main.onshape_compliant.ov
        fake = FakeOnshape()
        fake.measured.update(MEASURED)
        body = {**{k: getattr(DESIGN, k) for k in ("tube_center_x", "member_depth", "tube_od", "tube_id")}, "constraints": {}}
        with mock.patch.object(mod.oe, "_request_json", fake), mock.patch.object(mod, "target_from_env", lambda: mod.Target("doc", "ws")),                 mock.patch.dict(mod.os.environ, {"ONSHAPE_COMPLIANT_PART_STUDIO_ID": "PSM"}):
            res = self.client.post("/api/compliant/onshape/preview", json=body)
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual([t["table_name"] for t in res.json()["tables"]], list(oc.TABLES))
            res = self.client.post("/api/compliant/onshape/apply", json={**body, "names": ["cb_junction_x", "pinch_preload"]})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(fake.expression("cam_sim_compliant", "cb_junction_x"), "-5.5 mm")
            self.assertEqual(self.client.post("/api/compliant/onshape/apply", json={**body, "names": "x"}).status_code, 422)
            res = self.client.post("/api/compliant/onshape/apply", json={**body, "pivot_inverted": True, "names": ["carriage_pivot_side"]})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(fake.expression("cam_sim_carriage", "carriage_pivot_side"), "-1")
            hooked = {**body, **{k: getattr(HOOKED_R, k) for k in ("junction_x", "junction_y", "pivot_offset", "closed_carriage_height",
                                                                  "r_u1", "r_v1", "r_u2", "r_v2", "r_thickness")}}
            res = self.client.post("/api/compliant/onshape/preview", json=hooked)
            self.assertEqual(res.status_code, 200, res.text)
            self.assertFalse(res.json()["skin_check"]["valid"])
            res = self.client.post("/api/compliant/onshape/apply", json={**hooked, "names": ["cb_r_u1"]})
            self.assertEqual(res.status_code, 409, res.text)
            self.assertIn("0.312 mm", res.json()["detail"])


if __name__ == "__main__":
    unittest.main()
