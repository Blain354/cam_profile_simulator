"""The tube_model switch: everything downstream works with the FEM tube and with the simple law."""

import dataclasses
import json
import os
import tempfile
import unittest
from dataclasses import replace

import numpy as np

from backend import linkage
from backend import tube_model as tube_law
from backend.linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage
from backend.simulation import SimulationParams, SolverParams, compute_simulation, solve_cam_profile
from backend.tests.test_linkage import LEVER, PENDULUM, PENDULUM_SEARCH

_env = {}


def setUpModule():
    # Keep the FEM's disk cache out of the repository.
    _env["dir"] = tempfile.TemporaryDirectory()
    _env["old"] = os.environ.get("SIM_DB_PATH")
    os.environ["SIM_DB_PATH"] = os.path.join(_env["dir"].name, "test.db")
    _env["budget"] = (linkage.N_SHORTLIST, linkage.N_ONE_PIECE_ROUND)
    linkage.N_SHORTLIST, linkage.N_ONE_PIECE_ROUND = 12, 4


def tearDownModule():
    linkage.N_SHORTLIST, linkage.N_ONE_PIECE_ROUND = _env["budget"]
    if _env["old"] is None:
        os.environ.pop("SIM_DB_PATH", None)
    else:
        os.environ["SIM_DB_PATH"] = _env["old"]
    _env["dir"].cleanup()


class FemLinkageTests(unittest.TestCase):
    def test_default_is_fem_and_simple_is_a_switch_away(self):
        self.assertEqual(LinkageParams().tube_model, "fem")
        self.assertEqual(SimulationParams().tube_model, "fem")
        self.assertEqual(SolverParams().tube_model, "fem")
        fem, simple = compute_linkage(LinkageParams()), compute_linkage(LinkageParams(tube_model="simple"))
        law = tube_law.law(LinkageParams())
        self.assertAlmostEqual(fem.closed_gap, law.closed_gap)
        self.assertAlmostEqual(simple.closed_gap, 1.0 - 0.7 * 0.1)
        self.assertNotAlmostEqual(fem.seal_force, simple.seal_force, places=3)

    def test_every_linkage_type_runs_on_the_fem_tube(self):
        for p in (LinkageParams(), LEVER, PENDULUM, replace(PENDULUM, pad_length=1.0)):
            with self.subTest(kind=p.linkage_type, pad=p.pad_length):
                r = compute_linkage(p)
                self.assertTrue(r.feasible, r.message)
                json.dumps(r.__dict__, allow_nan=False)
                i0 = len(r.Y_positions) // 2
                self.assertEqual(r.flow_a[0], 0.0)
                self.assertGreater(r.flow_a[-1], 0.0)
                self.assertAlmostEqual(r.seal_force, r.seal_force_flatten + r.seal_force_squeeze + r.seal_force_pressure, places=9)
                self.assertGreater(r.seal_force_pressure, 0.0)
                self.assertAlmostEqual(r.tube_modulus_mpa, tube_law.law(p).e_mpa)
                self.assertGreaterEqual(r.seal_pressure_y0_kpa, 0.0)
                self.assertGreater(r.force_a[i0], 0.0)
                if p.linkage_type == "pendulum":
                    self.assertIsNotNone(r.y_full_open)     # the pendulum reaches full bore within its stroke

    def test_one_piece_flexure_and_its_search_on_the_fem_tube(self):
        p = replace(PENDULUM, compliant=True, stroke=0.6)
        r = compute_linkage(p)
        self.assertTrue(r.feasible, r.message)
        self.assertGreater(r.max_stress_mpa, 0.0)
        self.assertAlmostEqual(r.flex_a[len(r.Y_positions) // 2], r.force_a[len(r.Y_positions) // 2] / r.pin_stiffness, places=7)
        json.dumps(r.__dict__, allow_nan=False)
        best, feasible, tested, _ = optimize_linkage(replace(PENDULUM, compliant=True), replace(PENDULUM_SEARCH, max_stroke=3.0))
        self.assertGreater(tested, 0)

    def test_rigid_search_on_the_fem_tube(self):
        best, feasible, tested, _ = optimize_linkage(LinkageParams(), LinkageSearch(max_stroke=5.0))
        self.assertIsNotNone(best)
        self.assertTrue(compute_linkage(best).feasible)

    def test_a_tube_that_balloons_is_reported_not_crashed(self):
        r = compute_linkage(LinkageParams(tube_shore_a=15.0, input_pressure_kpa=400.0))
        self.assertFalse(r.feasible)
        self.assertIn("balloons", r.message)
        with self.assertRaises(tube_law.TubeModelError):
            compute_simulation(SimulationParams(tube_shore_a=15.0, input_pressure_kpa=400.0))


class FemCamTests(unittest.TestCase):
    def test_cam_flow_follows_the_fem_bore(self):
        p = SimulationParams(ramp_enabled=True, default_distance=1.1, chamber_volume_ml=5.0)
        r = compute_simulation(p)
        law = tube_law.law(p)
        gap, flow, area = (np.array(v) for v in (r.min_gaps, r.flow_l_min, r.flow_area))
        np.testing.assert_array_equal(flow[gap <= law.closed_gap], 0.0)
        self.assertTrue(np.all(flow[gap > law.closed_gap + 1e-3] > 0.0))
        np.testing.assert_allclose(area, law.area(gap))
        self.assertGreater(r.total_volume_ml, 0.0)
        # More pressure opens the tube from inside: flow starts earlier along the cam.
        first = lambda res: next(y for y, q in zip(res.Y_positions, res.flow_l_min) if q > 0)
        self.assertLess(first(compute_simulation(replace(p, input_pressure_kpa=200.0))), first(r))

    def test_profile_solver_on_the_fem_tube(self):
        result = solve_cam_profile(SolverParams(
            ramp_enabled=True, k_steps=2, height_steps=3, deadband_steps=3, k_min=1, k_max=3,
            h_search_lo=1.5, h_search_max=4, deadband_min=1.5, deadband_max=4,
            gap_at_y0_margin_mm=0.1, default_distance_safety_factor=0.9,
        ))
        self.assertTrue(result.success, result.message)
        self.assertAlmostEqual(result.theoretical_gap_mm, tube_law.law(SolverParams()).closed_gap)


class FemPressureGridTests(unittest.TestCase):
    def test_pressures_between_grid_points_blend_the_two_neighbours(self):
        """The FEM is solved every PRESSURE_STEP of p/E and blended linearly in between."""
        at = lambda kpa: tube_law.law(LinkageParams(tube_shore_a=50.0, input_pressure_kpa=kpa))
        step_kpa = tube_law.PRESSURE_STEP * tube_law.tube_fem.shore_a_to_e_mpa(50.0) * 1e3
        lo, hi, mid = at(4 * step_kpa), at(5 * step_kpa), at(4.5 * step_kpa)
        self.assertEqual(len(lo.parts), 1)
        self.assertEqual(len(mid.parts), 2)
        self.assertAlmostEqual(mid.closed_gap, 0.5 * (lo.closed_gap + hi.closed_gap), places=9)
        self.assertTrue(hi.closed_gap < mid.closed_gap < lo.closed_gap)
        h = np.array([1.2, 1.6, 2.0])
        np.testing.assert_allclose(mid.open_area(h), 0.5 * (lo.open_area(h) + hi.open_area(h)))
        self.assertEqual(len(tube_law.section(LinkageParams(input_pressure_kpa=4.5 * step_kpa), 1.4)["outer"]), len(lo.response.outer[0]))


class FemSectionAndRequestTests(unittest.TestCase):
    def test_section_for_the_card(self):
        s = tube_law.section(LinkageParams(), 1.5)
        self.assertEqual(len(s["outer"]), len(s["inner"]))
        self.assertGreater(s["pressure_share_per_mm"], 0.0)
        self.assertGreater(s["force_per_mm"], s["pressure_share_per_mm"])
        self.assertLess(s["open_area_mm2"], s["bore_area_mm2"])
        self.assertLess(s["h_sealed"], s["h_closed"])

    def test_old_bodies_get_the_defaults(self):
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        try:
            import main  # noqa: F401  (needs fastapi, present in the image)
        except Exception as exc:
            raise unittest.SkipTest(f"main unavailable: {exc}")
        for model in (main.LinkageRequest, main.SimRequest):
            body = model()
            self.assertEqual((body.tube_model, body.tube_shore_a), ("fem", 50.0))
        self.assertEqual(main._linkage_params(main.LinkageRequest(tube_model="simple")).tube_model, "simple")
        self.assertEqual(dataclasses.asdict(main._linkage_params(main.LinkageRequest()))["tube_shore_a"], 50.0)


if __name__ == "__main__":
    unittest.main()
