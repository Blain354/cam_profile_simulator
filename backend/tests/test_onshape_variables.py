"""Onshape variable table writes, against a fake transport: python -m unittest discover -s backend/tests."""

import copy
import unittest
from dataclasses import replace
from unittest import mock

from backend import onshape_variables as ov
from backend.linkage import LinkageParams

PENDULUM = LinkageParams(linkage_type="pendulum", bar1_length=11.95, bar2_length=14.43, anchor_distance=4.79,
                         pivot_offset=4.0, foot_length=1.5, foot_angle_deg=100.0, pad_length=1.0, link_curved=True)
TARGET = ov.Target("doc", "ws", "vs", "ps")


def assign_variable(name, expression, fid):
    return {"featureType": "assignVariable", "featureId": fid, "parameters": [
        {"parameterId": "name", "value": name},
        {"parameterId": "variableType", "value": "LENGTH"},
        {"parameterId": "lengthValue", "btType": "BTMParameterQuantity-147", "expression": expression},
    ]}


class FakeOnshape:
    """Just enough of the two endpoints, with the Variable Studio POST replacing the whole list."""

    def __init__(self):
        self.studio = [
            {"name": "pinch_tube_OD", "type": "LENGTH", "expression": "3.0 mm", "description": "", "value": None},
            {"name": "M3_length", "type": "LENGTH", "expression": "20.5 mm", "description": "screw", "value": None},
            {"name": "pend_arm_L", "type": "LENGTH", "expression": "10 mm", "description": "", "value": None},
        ]
        self.features = [{"featureType": "newSketch", "featureId": "S1", "parameters": []},
                         assign_variable("pend_foot", "#pinch_tube_OD / 2", "F1"),
                         assign_variable("pend_stroke", "3 mm", "F2")]
        self.calls = []

    def __call__(self, method, path, *, query=None, body=None):
        self.calls.append((method, path))
        if path.startswith("/variables/"):
            if method == "GET":
                return [{"variableStudioReference": None, "variables": copy.deepcopy(self.studio)}]
            self.studio = copy.deepcopy(body)
            return None
        if method == "GET":
            return {"features": copy.deepcopy(self.features)}
        fid = path.rsplit("/", 1)[-1]
        self.features = [body["feature"] if f["featureId"] == fid else f for f in self.features]
        return {}

    def expression(self, name):
        for v in self.studio:
            if v["name"] == name:
                return v["expression"]
        for f in self.features:
            if ov._feature_name(f) == name:
                return ov._feature_expression(f)
        return None


class OnshapeVariablesTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeOnshape()
        patcher = mock.patch.object(ov.oe, "_request_json", self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def rows(self, out):
        return {r["name"]: r for r in out["rows"]}

    def test_preview_reads_only_and_classifies(self):
        rows = self.rows(ov.preview(PENDULUM, TARGET))
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "GET"])
        self.assertEqual(rows["pinch_tube_OD"]["status"], "same")          # "3.0 mm" is 3 mm
        self.assertEqual(rows["pend_arm_L"]["status"], "update")
        self.assertEqual(rows["pend_arm_L"]["new_expression"], "14.43 mm")
        self.assertEqual(rows["pend_foot"]["where"], "part_studio")
        self.assertEqual(rows["pend_foot"]["status"], "update")            # an expression, not a number: never "same"
        self.assertEqual(rows["pend_foot_angle"]["new_expression"], "100 deg")
        self.assertEqual(rows["pend_anchor"]["status"], "missing")
        self.assertIn("pend_link_radius", rows)
        self.assertNotIn("pend_link_radius", self.rows(ov.preview(replace(PENDULUM, link_curved=False), TARGET)))

    def test_apply_overwrites_selected_names_and_drops_nothing(self):
        out = self.rows(ov.apply(PENDULUM, ["pend_arm_L", "pend_foot", "pend_anchor"], target=TARGET))
        self.assertEqual(out["pend_arm_L"]["status"], "written")
        self.assertEqual(out["pend_foot"]["status"], "written")
        self.assertEqual(out["pend_anchor"]["status"], "skipped")          # missing, and creation not asked
        self.assertEqual(out["pend_stroke"]["status"], "skipped")          # not selected
        self.assertEqual(self.fake.expression("pend_arm_L"), "14.43 mm")
        self.assertEqual(self.fake.expression("pend_foot"), "1.5 mm")
        self.assertEqual(self.fake.expression("pend_stroke"), "3 mm")
        # The whole Variable Studio went back: the variables this app does not know are intact.
        self.assertEqual([v["name"] for v in self.fake.studio], ["pinch_tube_OD", "M3_length", "pend_arm_L"])
        self.assertEqual(self.fake.studio[1], {"name": "M3_length", "type": "LENGTH", "expression": "20.5 mm", "description": "screw"})
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "GET", "POST", "POST"])

    def test_create_missing_adds_to_the_variable_studio(self):
        out = self.rows(ov.apply(PENDULUM, ["pend_anchor", "pend_foot_angle"], create_missing=True, target=TARGET))
        self.assertEqual(out["pend_anchor"]["status"], "created")
        added = {v["name"]: v for v in self.fake.studio}
        self.assertEqual(added["pend_anchor"]["expression"], "4.79 mm")
        self.assertEqual(added["pend_foot_angle"]["type"], "ANGLE")
        self.assertEqual(len(self.fake.studio), 5)
        # Without a Variable Studio there is nowhere to create a variable.
        self.fake.calls.clear()
        out = self.rows(ov.apply(PENDULUM, ["pend_height"], create_missing=True, target=ov.Target("doc", "ws", None, "ps")))
        self.assertEqual(out["pend_height"]["status"], "skipped")
        self.assertEqual([m for m, _ in self.fake.calls], ["GET"])

    def test_nothing_selected_writes_nothing(self):
        ov.apply(PENDULUM, [], create_missing=True, target=TARGET)
        self.assertEqual([m for m, _ in self.fake.calls], ["GET", "GET"])

    def test_elbow_names_follow_the_onshape_sketch(self):
        # In the CAD sketch L1 starts at the fixed anchor: the simulator's bar 2.
        rows = {r.name: r for r in ov.wanted_rows(LinkageParams(bar1_length=13.0, bar2_length=7.8))}
        self.assertEqual(rows["L1"].new_expression, "7.8 mm")
        self.assertEqual(rows["L2"].new_expression, "13 mm")

    def test_configuration_errors_are_explicit(self):
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_DOCUMENT_ID": "d", "ONSHAPE_WORKSPACE_ID": "w"}, clear=True):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.target_from_env()
        with mock.patch.dict(ov.os.environ, {"ONSHAPE_LINKAGE_MAPPING": '{"pendulum": {"x": "nope"}}'}):
            with self.assertRaises(ov.LinkageOnshapeError):
                ov.mapping_for("pendulum")
        with self.assertRaises(ov.LinkageOnshapeError):
            ov.wanted_rows(replace(LinkageParams(), bar2_length=-1.0))


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

    def test_preview_then_apply(self):
        fake = FakeOnshape()
        body = {"linkage_type": "pendulum", "bar1_length": 11.95, "bar2_length": 14.43, "anchor_distance": 4.79,
                "pivot_offset": 4.0, "pad_length": 1.0, "link_curved": True}
        with mock.patch.object(self.module.oe, "_request_json", fake), \
                mock.patch.object(self.module, "target_from_env", lambda: self.module.Target("doc", "ws", "vs", "ps")):
            self.assertEqual(self.client.post("/api/linkage/simulate", json=body).status_code, 200)
            res = self.client.post("/api/linkage/onshape/preview", json=body)
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual({r["name"]: r["status"] for r in res.json()["rows"]}["pend_arm_L"], "update")
            res = self.client.post("/api/linkage/onshape/apply", json={**body, "names": ["pend_arm_L"]})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(fake.expression("pend_arm_L"), "14.43 mm")
            self.assertEqual(fake.expression("pend_stroke"), "3 mm")

    def test_unconfigured_target_is_a_409_with_the_reason(self):
        with mock.patch.dict(self.module.os.environ, {"ONSHAPE_DOCUMENT_ID": "", "ONSHAPE_WORKSPACE_ID": ""}):
            res = self.client.post("/api/linkage/onshape/preview", json={"linkage_type": "pendulum"})
        self.assertEqual(res.status_code, 409)
        self.assertIn("ONSHAPE_DOCUMENT_ID", res.json()["detail"])


if __name__ == "__main__":
    unittest.main()
