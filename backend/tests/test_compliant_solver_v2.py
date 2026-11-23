"""Compliant Bars solver: physical goals, members merging at the junction, CMA-ES, pin-diameter grid."""

import unittest
from dataclasses import replace

import numpy as np

from backend.compliant_bars import (
    PHYSICAL_GOALS, PIN_GRID, SOLVER_GOALS, CompliantConstraints, CompliantParams, LinkageParams,
    _geometry, _goal_utility, _has_member_crossing, _member_segment_pairs, _nearest_on_polyline,
    _polyline_distances, admission_score, compute_compliant,
)
from backend.compliant_bars import _constraints_from_mapping
from backend.compliant_solver import SOLVER_METHODS, _classify_rejections, run_time_budgeted_solve
from backend.linkage import _pinch_force

# A design drawn by hand on 2026-11-23: L and R leave the junction side by side for about 4 mm,
# their centre lines weaving over each other inside the merged width.
MERGING = dict(
    anchor_distance=5.396, junction_x=4.780, junction_y=10.754, pinch_y=12.5,
    l_u1=0.3696, l_v1=3.1255, l_u2=0.55, l_v2=-7.341,
    r_u1=0.0907, r_v1=5.8792, r_u2=0.5399, r_v2=6.9578,
    f_u1=0.05, f_v1=-2.666, f_u2=0.6082, f_v2=-3.3378,
    l_thickness=1.0, r_thickness=0.75, f_thickness=1.0,
    closed_carriage_height=8.0, pivot_offset=5.5, pivot_inverted=True, stroke=0.8, preload=0.1,
    member_depth=4.0, tube_center_x=8.75,
)
TRIO = {"max_flow": 1.0, "min_dead_band": 1.0, "min_torque": 1.0}
BOUNDS = {
    "junction_x": (-7.0, -4.0), "junction_y": (10.0, 13.5), "l_v1": (-2.0, 1.0), "r_v1": (-1.0, 2.0),
    "l_thickness": (0.6, 1.4), "r_thickness": (0.5, 1.3), "f_thickness": (0.6, 1.4),
}


class PhysicalGoalTests(unittest.TestCase):
    def test_each_goal_is_a_share_read_from_the_result(self):
        c = CompliantConstraints(motor_limited_stress=False)
        res = compute_compliant(CompliantParams(), fast=True, constraints=c)
        self.assertTrue(res.passes)
        self.assertTrue(set(PHYSICAL_GOALS) <= set(SOLVER_GOALS))
        self.assertAlmostEqual(_goal_utility(res, c, "max_flow"), min(1.0, res.max_flow_frac), places=9)
        self.assertAlmostEqual(_goal_utility(res, c, "min_dead_band"), 1.0 - res.y_open_mm / 1.5, places=9)
        self.assertAlmostEqual(_goal_utility(res, c, "min_torque"), 1.0 - res.peak_thrust_op_n / res.thrust_available_n, places=9)
        for goal in PHYSICAL_GOALS:
            self.assertEqual(admission_score(res, c, goal=goal), _goal_utility(res, c, goal))
        mean = sum(_goal_utility(res, c, g) for g in PHYSICAL_GOALS) / 3.0
        self.assertAlmostEqual(admission_score(res, c, goal="max_flow", goal_weights=TRIO), mean, places=9)

    def test_thinner_members_free_motor_torque(self):
        c = CompliantConstraints(motor_limited_stress=False)
        base = CompliantParams()
        thin = replace(base, l_thickness=0.8 * base.l_thickness, r_thickness=0.8 * base.r_thickness, f_thickness=0.8 * base.f_thickness)
        a = compute_compliant(base, fast=True, constraints=c)
        b = compute_compliant(thin, fast=True, constraints=c)
        self.assertLess(b.peak_thrust_op_n, a.peak_thrust_op_n)
        self.assertGreater(_goal_utility(b, c, "min_torque"), _goal_utility(a, c, "min_torque"))

    def test_a_tube_that_never_opens_scores_zero_dead_band(self):
        c = CompliantConstraints()
        res = replace(compute_compliant(CompliantParams(), fast=True, constraints=c), y_open_mm=None)
        self.assertEqual(_goal_utility(res, c, "min_dead_band"), 0.0)


class MergedRunTests(unittest.TestCase):
    def test_members_leaving_the_junction_side_by_side_do_not_cross(self):
        p = CompliantParams(**MERGING)
        tube = LinkageParams(tube_id=p.tube_id, tube_od=p.tube_od, tube_center_x=p.tube_center_x, pin_diameter=p.f_thickness,
                             preload=p.preload, stroke=p.stroke)
        samples = _geometry(p, tube)[9]
        # The centre lines do intersect...
        xy = np.vstack([samples["l"], samples["r"][1:], samples["f"][1:]])
        n_l, n_r = len(samples["l"]), len(samples["r"])
        members = [list(range(n_l)), [n_l - 1] + list(range(n_l, n_l + n_r - 1)), [n_l - 1] + list(range(n_l + n_r - 1, len(xy)))]
        self.assertTrue(_has_member_crossing(xy, *_member_segment_pairs(members)))
        # ...inside the width the two members share from the junction outward, which is one solid.
        res = compute_compliant(p, fast=True)
        self.assertTrue(res.crossing_ok)
        self.assertNotIn("cross", res.message.lower())

    def test_distances_match_the_scalar_walk(self):
        rng = np.random.default_rng(4)
        poly = np.cumsum(rng.normal(size=(9, 2)), axis=0)
        pts = rng.normal(scale=4.0, size=(40, 2))
        want = [_nearest_on_polyline(pt, poly)[0] for pt in pts]
        np.testing.assert_allclose(_polyline_distances(pts, poly), want, rtol=0, atol=1e-12)


class BucklingTests(unittest.TestCase):
    def test_the_margin_is_reported_and_only_a_positive_floor_rejects(self):
        loose = CompliantConstraints(motor_limited_stress=False)
        res = compute_compliant(CompliantParams(), fast=True, constraints=loose)
        self.assertIsNotNone(res.buckling_margin)
        self.assertGreater(res.buckling_margin, 0.0)
        self.assertTrue(res.buckling_ok)
        self.assertTrue(res.passes)
        strict = replace(loose, min_buckling_margin=1.5 * res.buckling_margin)
        refused = compute_compliant(CompliantParams(), fast=True, constraints=strict)
        self.assertAlmostEqual(refused.buckling_margin, res.buckling_margin, places=9)
        self.assertFalse(refused.buckling_ok)
        self.assertFalse(refused.passes)
        self.assertIn("buckling", refused.message.lower())
        self.assertEqual(_classify_rejections(refused), ["buckling"])
        self.assertLess(admission_score(refused, strict), -1.0e6)
        # A margin further below the floor ranks lower, so a search is pulled back toward the floor.
        stricter = replace(loose, min_buckling_margin=3.0 * res.buckling_margin)
        self.assertLess(admission_score(compute_compliant(CompliantParams(), fast=True, constraints=stricter), stricter),
                        admission_score(refused, strict))

    def test_the_floor_reaches_the_solver_from_the_page(self):
        self.assertEqual(_constraints_from_mapping({"min_buckling_margin": 2}).min_buckling_margin, 2.0)
        self.assertEqual(_constraints_from_mapping({}).min_buckling_margin, 0.0)
        out = run_time_budgeted_solve(CompliantParams(), BOUNDS, time_budget_s=600.0, method="cmaes",
                                      method_params={"max_evals": 30, "seed": 1, "workers": 1},
                                      constraints=CompliantConstraints(min_buckling_margin=2.0))
        self.assertEqual(out["summary"]["active_constraints"]["min_buckling_margin"], 2.0)
        self.assertIn("buckling", [s["key"] for s in out["summary"]["rejection_stats"]])


class PinGridTests(unittest.TestCase):
    def test_grid_tables_agree_with_the_exact_one(self):
        gaps = np.linspace(0.4, 3.2, 60)
        ones = np.ones_like(gaps)
        on_grid = LinkageParams(pin_diameter=1.0)
        exact = sum(_pinch_force(on_grid, gaps, ones, ones, fast=True))
        np.testing.assert_allclose(sum(_pinch_force(on_grid, gaps, ones, ones, fast=PIN_GRID)), exact, rtol=1e-12, atol=1e-12)
        between = LinkageParams(pin_diameter=1.02)
        exact = sum(_pinch_force(between, gaps, ones, ones, fast=True))
        blended = sum(_pinch_force(between, gaps, ones, ones, fast=PIN_GRID))
        self.assertLess(float(np.max(np.abs(blended - exact))), 2e-3 * float(np.max(np.abs(exact))))


class CmaesTests(unittest.TestCase):
    def solve(self, **method_params):
        return run_time_budgeted_solve(
            CompliantParams(), BOUNDS, time_budget_s=600.0, goal="max_flow", goal_weights=TRIO, method="cmaes",
            method_params={"max_evals": 240, "seed": 5, **method_params},
            constraints=CompliantConstraints(motor_limited_stress=False),
        )

    def test_same_seed_and_budget_give_the_same_design_with_or_without_workers(self):
        self.assertEqual(SOLVER_METHODS[0], "cmaes")
        one = self.solve(workers=1)
        again = self.solve(workers=1)
        spread = self.solve(workers=2)
        self.assertEqual(one["tested"], 240)
        self.assertEqual(one["summary"]["seed"], 5)
        self.assertEqual(one["summary"]["max_evals"], 240)
        self.assertTrue(one["found"])
        self.assertEqual(one["params"], again["params"])
        self.assertEqual(one["params"], spread["params"])
        self.assertNotEqual(one["params"], self.solve(workers=1, seed=6)["params"])

    def test_it_does_not_end_below_the_design_it_started_from(self):
        c = CompliantConstraints(motor_limited_stress=False)
        start = compute_compliant(CompliantParams(), fast=False, constraints=c)
        self.assertTrue(start.passes)
        out = self.solve(workers=1)
        end = compute_compliant(CompliantParams(**{k: v for k, v in out["params"].items()}), fast=False, constraints=c)
        self.assertTrue(end.passes)
        self.assertGreaterEqual(admission_score(end, c, goal="max_flow", goal_weights=TRIO),
                                admission_score(start, c, goal="max_flow", goal_weights=TRIO))

    def test_an_evaluation_budget_stops_every_method(self):
        for method in SOLVER_METHODS:
            out = run_time_budgeted_solve(CompliantParams(), BOUNDS, time_budget_s=600.0, method=method,
                                          method_params={"max_evals": 40, "seed": 2, "workers": 1})
            self.assertLessEqual(out["tested"], 40, method)
            self.assertGreaterEqual(out["tested"], 30, method)
        thousands = run_time_budgeted_solve(CompliantParams(), BOUNDS, time_budget_s=0.6, method="cmaes",
                                            method_params={"max_evals_k": 1, "seed": 2, "workers": 1})
        self.assertEqual(thousands["summary"]["max_evals"], 1000)


if __name__ == "__main__":
    unittest.main()
