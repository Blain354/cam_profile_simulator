"""Pressures in kPa, and data saved in psi read back in kPa: python -m unittest discover -s backend/tests."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

from backend.legacy_units import PSI_TO_KPA, legacy_psi_to_kpa
from backend.linkage import LinkageParams, compute_linkage
from backend.simulation import SimulationParams, compute_simulation
from backend.storage import ProfileStorage

FIXTURES = Path(__file__).resolve().parent / "fixtures"
KPA_15 = 15 * PSI_TO_KPA   # 103.42 kPa


def _sample(d: dict, n: int = 12) -> dict:
    """The same sampling the reference fixture was written with."""
    out = {}
    for k, v in d.items():
        if isinstance(v, list):
            out[k] = v[::max(1, len(v) // n)]
        elif isinstance(v, (int, float, bool, str)) or v is None:
            out[k] = v
    return out


class LegacyHelperTests(unittest.TestCase):
    def test_converts_renames_and_leaves_the_rest(self):
        got = legacy_psi_to_kpa({"input_pressure_psi": 15, "tube_id": 2.0, "note": "x"})
        self.assertEqual(set(got), {"input_pressure_kpa", "tube_id", "note"})
        self.assertAlmostEqual(got["input_pressure_kpa"], 103.421355)
        self.assertEqual((got["tube_id"], got["note"]), (2.0, "x"))

    def test_idempotent(self):
        once = legacy_psi_to_kpa({"params": {"input_pressure_psi": 15}})
        self.assertEqual(legacy_psi_to_kpa(once), once)
        self.assertEqual(legacy_psi_to_kpa({"input_pressure_kpa": 100.0}), {"input_pressure_kpa": 100.0})

    def test_kpa_key_wins_and_psi_key_is_dropped(self):
        self.assertEqual(legacy_psi_to_kpa({"input_pressure_psi": 15, "input_pressure_kpa": 100.0}), {"input_pressure_kpa": 100.0})
        self.assertEqual(legacy_psi_to_kpa({"pressureKpa": 100.0, "pressurePsi": 15}), {"pressureKpa": 100.0})

    def test_nested_payloads_and_lists(self):
        got = legacy_psi_to_kpa({"a": [{"seal_pressure_y0_psi": 10}, 3, None], "b": {"c": {"pressurePsi": 1}}})
        self.assertAlmostEqual(got["a"][0]["seal_pressure_y0_kpa"], 68.94757)
        self.assertEqual(got["a"][1:], [3, None])
        self.assertAlmostEqual(got["b"]["c"]["pressureKpa"], PSI_TO_KPA)

    def test_input_is_not_modified_and_non_numbers_pass_through(self):
        raw = {"input_pressure_psi": None, "params": {"input_pressure_psi": 15}}
        got = legacy_psi_to_kpa(raw)
        self.assertEqual(raw, {"input_pressure_psi": None, "params": {"input_pressure_psi": 15}})
        self.assertIsNone(got["input_pressure_kpa"])
        self.assertEqual(legacy_psi_to_kpa("text"), "text")


class SamePhysicsTests(unittest.TestCase):
    """15 psi before the change and 15 psi in kPa after give the same outputs.

    The old code turned psi into Pa with 6894.76: at that exact pressure the outputs match to
    rounding. A legacy 15 psi now loads as 15 x 6.894757 kPa, 4e-7 lower: the outputs move by
    about as much, a little more on the dynamic chamber near equalization.
    """

    @classmethod
    def setUpClass(cls):
        cls.ref = json.loads((FIXTURES / "psi_reference_15psi.json").read_text())

    def _assert_same(self, got: dict, want: dict, rtol: float):
        self.assertEqual(set(got), set(want))
        for key, expected in want.items():
            with self.subTest(field=key):
                value = got[key]
                if isinstance(expected, list):
                    self.assertEqual(len(value), len(expected))
                    self.assertEqual([v is None for v in value], [v is None for v in expected])
                    a = np.array([v for v in value if v is not None], dtype=float)
                    b = np.array([v for v in expected if v is not None], dtype=float)
                    scale = float(np.max(np.abs(b))) if b.size else 0.0
                    np.testing.assert_allclose(a, b, rtol=rtol, atol=rtol * scale + 1e-12)
                elif isinstance(expected, float):
                    self.assertAlmostEqual(value, expected, delta=rtol * max(1.0, abs(expected)))
                else:
                    self.assertEqual(value, expected)

    def _cam(self, kpa: float, rtol: float):
        ref = self.ref["cam"]
        # The reference was frozen on the simple tube law.
        result = compute_simulation(SimulationParams(input_pressure_kpa=kpa, tube_model="simple", **ref["params"]))
        self._assert_same(_sample(result.__dict__), ref["result"], rtol)

    def _linkage(self, kpa: float, rtol: float):
        ref = self.ref["linkage"]
        result = _sample(compute_linkage(LinkageParams(input_pressure_kpa=kpa, tube_model="simple", **ref["params"])).__dict__)
        want = dict(ref["result"])
        want["seal_pressure_y0_kpa"] = want.pop("seal_pressure_y0_psi") * 6.89476
        # Fields added since the reference was frozen (inverted pivot, assembly clearance).
        for key in ("pivot_x", "travel_sign", "min_clearance", "min_clearance_y", "min_clearance_where", "collision_y", "plane_gap", "plane_gap_where"):
            self.assertNotIn(key, want)
            result.pop(key, None)
        self._assert_same(result, want, rtol)

    def test_cam_model(self):
        self._cam(15 * 6.89476, 1e-9)
        self._cam(KPA_15, 2e-5)

    def test_linkage_model(self):
        self._linkage(15 * 6.89476, 1e-9)
        self._linkage(KPA_15, 2e-5)

    def test_defaults_are_100_kpa(self):
        from backend.simulation import SolverParams
        self.assertEqual(SimulationParams().input_pressure_kpa, 100.0)
        self.assertEqual(SolverParams().input_pressure_kpa, 100.0)
        self.assertEqual(LinkageParams().input_pressure_kpa, 100.0)


class LegacyRouteTests(unittest.TestCase):
    """Old psi payloads and bodies come out in kPa; stored rows stay as they were."""

    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
        except Exception as exc:   # httpx missing
            raise unittest.SkipTest(f"TestClient unavailable: {exc}")
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sys.path.insert(0, backend_dir)
        os.environ.setdefault("SIM_DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
        import main
        cls.main = main
        cls.client = TestClient(main.app)
        cls.experience = json.loads((FIXTURES / "legacy_builder_experience_psi.json").read_text())

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = self.main.profiles
        self.store = self.main.profiles = ProfileStorage(Path(self.tmp.name) / "sim.db")
        self.store.save("cam", "old.json", {"height": 2.0, "input_pressure_psi": 15.0, "note": "old"}, "old")
        self.store.save("cam-finder", "old.builder.json", self.experience, "old experience")
        self.store.save("pendulum", "old", {"params": {"bar1_length": 11.0, "input_pressure_psi": 15.0}, "search": {}, "chart_settings": {}})

    def tearDown(self):
        self.main.profiles = self.saved
        self.tmp.cleanup()

    def _assert_kpa(self, holder: dict, key: str = "input_pressure_kpa"):
        self.assertAlmostEqual(holder[key], KPA_15, places=6)
        self.assertNotIn(key.replace("kpa", "psi").replace("Kpa", "Psi"), holder)

    def test_cam_routes(self):
        self._assert_kpa(self.client.get("/api/configs/old.json").json())
        self._assert_kpa(self.client.get("/api/profiles/cam/old.json").json()["payload"])

    def test_linkage_routes(self):
        self._assert_kpa(self.client.get("/api/linkage/profiles/pendulum/old").json()["params"])
        self._assert_kpa(self.client.get("/api/profiles/pendulum/old").json()["payload"]["params"])

    def test_builder_experience_routes(self):
        for body in (self.client.get("/api/builder-experiences/old.builder.json").json(),
                     self.client.get("/api/profiles/cam-finder/old.builder.json").json()["payload"]):
            self._assert_kpa(body["builder_params"], "pressureKpa")
            self._assert_kpa(body["last_solve_request"])
            # The saved solve still matches its inputs, so the builder does not call it stale.
            self.assertEqual(body["builder_params"]["pressureKpa"], body["last_solve_request"]["input_pressure_kpa"])
            # The solver result held no pressure in psi: its chamber trace is already absolute kPa.
            self.assertEqual(body["solver_result"], self.experience["solver_result"])
            self.assertNotIn("psi", json.dumps(body).lower())

    def test_stored_rows_are_never_rewritten(self):
        self.client.get("/api/configs/old.json")
        self.client.get("/api/builder-experiences/old.builder.json")
        self.assertEqual(self.store.get("cam", "old.json")["payload"]["input_pressure_psi"], 15.0)
        self.assertEqual(self.store.get("cam-finder", "old.builder.json")["payload"], self.experience)

    def test_saving_a_loaded_legacy_body_stores_kpa(self):
        self.client.put("/api/configs/old.json", json={"height": 2.0, "input_pressure_psi": 15.0})
        self._assert_kpa(self.store.get("cam", "old.json")["payload"])
        self.client.put("/api/builder-experiences/old.builder.json", json={"note": "n", **self.experience})
        self._assert_kpa(self.store.get("cam-finder", "old.builder.json")["payload"]["builder_params"], "pressureKpa")
        self.client.put("/api/linkage/profiles/pendulum/old", json={"params": {"input_pressure_psi": 15.0}})
        self._assert_kpa(self.store.get("pendulum", "old")["payload"]["params"])
        self.client.put("/api/profiles/cam/new.json", json={"payload": {"input_pressure_psi": 15.0}})
        self._assert_kpa(self.store.get("cam", "new.json")["payload"])

    def test_request_models_accept_a_legacy_psi_body(self):
        m = self.main
        for model in (m.SimRequest, m.SolveRequest, m.STLExportRequest, m.LinkageRequest, m.LinkageOptimizeRequest, m.LinkageOnshapeApplyRequest):
            with self.subTest(model=model.__name__):
                self.assertAlmostEqual(model(input_pressure_psi=15).input_pressure_kpa, KPA_15, places=6)
                self.assertEqual(model(input_pressure_psi=15, input_pressure_kpa=100).input_pressure_kpa, 100)
                self.assertNotIn("input_pressure_psi", model(input_pressure_psi=15).model_dump())

    def test_simulate_routes_answer_the_same_to_both_bodies(self):
        c = self.client
        self.assertEqual(c.post("/api/simulate", json={"input_pressure_psi": 15}).json(),
                         c.post("/api/simulate", json={"input_pressure_kpa": KPA_15}).json())
        self.assertEqual(c.post("/api/linkage/simulate", json={"input_pressure_psi": 15}).json(),
                         c.post("/api/linkage/simulate", json={"input_pressure_kpa": KPA_15}).json())

    def test_legacy_config_files_import_in_kpa(self):
        cfg = Path(self.tmp.name) / "configs"
        cfg.mkdir()
        (cfg / "20260326_162442_1.json").write_text(json.dumps({"height": 2.5, "input_pressure_psi": 15.0}))
        store = ProfileStorage(Path(self.tmp.name) / "import.db")
        self.assertEqual(store.import_legacy_config_files(cfg, transform=legacy_psi_to_kpa), 1)
        self._assert_kpa(store.get("cam", "20260326_162442_1.json")["payload"])


if __name__ == "__main__":
    unittest.main()
