"""Compliant bars: splines, fused overlap, constraints, slope ranking."""

import unittest

import numpy as np

from backend.compliant_bars import (
    CompliantParams, admission_score, compute_compliant, handle_point, sample_bezier, solve_compliant,
    _overlap_nodes,
)


class BezierTests(unittest.TestCase):
    def test_ends_and_left_offset(self):
        start, end = np.array([0.0, 0.0]), np.array([10.0, 0.0])
        pts, h1, h2 = sample_bezier(start, end, 0.3, 2.0, 0.7, -1.0, n=11)
        self.assertTrue(np.allclose(pts[0], start))
        self.assertTrue(np.allclose(pts[-1], end))
        # Left of +x is +y, so a positive v sits above the chord.
        self.assertGreater(h1[1], 1.5)
        self.assertLess(h2[1], -0.5)
        self.assertAlmostEqual(handle_point(start, end, 0.3, 2.0)[0], 3.0)

    def test_swapped_handles_still_span_the_chord(self):
        pts, _h1, _h2 = sample_bezier([0, 0], [4, 0], 0.8, 1.0, 0.2, -1.0, n=5)
        self.assertAlmostEqual(pts[0, 0], 0.0)
        self.assertAlmostEqual(pts[-1, 0], 4.0)


class OverlapTests(unittest.TestCase):
    def test_close_parallel_curves_fuse_and_distant_ones_do_not(self):
        junction = np.array([0.0, 0.0])
        # Meet at the origin, then run as two horizontal lines 0.4 mm apart.
        top = np.array([[0, 0], [2, 0.2], [6, 0.2], [10, 0.2]])
        bot = np.array([[0, 0], [2, -0.2], [6, -0.2], [10, -0.2]])
        far = np.array([[0, 0], [2, -5], [6, -5], [10, -5]])
        close = _overlap_nodes({"l": top, "r": bot, "f": far}, {"l": 1.0, "r": 1.0, "f": 0.4}, junction)
        self.assertTrue(close["l"][2])
        self.assertTrue(close["r"][2])
        self.assertFalse(close["f"][2])
        # The shared junction itself is not an overlap.
        self.assertFalse(close["l"][0])


class ComputeTests(unittest.TestCase):
    def test_default_shape_solves_and_reports_flow(self):
        result = compute_compliant(CompliantParams(), fast=True)
        self.assertTrue(result.feasible, result.message)
        self.assertEqual(len(result.flow_a), len(result.Y_positions))
        self.assertGreater(len(result.lines["l"]["x"]), 4)
        self.assertTrue(np.isfinite(result.max_stress_mpa))

    def test_tiny_strength_is_plastic(self):
        result = compute_compliant(CompliantParams(member_strength_mpa=0.01), fast=True)
        self.assertFalse(result.plastic_ok)
        self.assertFalse(result.passes)

    def test_junction_outside_the_shell_is_rejected(self):
        result = compute_compliant(CompliantParams(junction_y=40.0), fast=True)
        self.assertFalse(result.shell_ok, result.message)
        self.assertFalse(result.passes)

    def test_junction_on_the_pivot_is_rejected(self):
        result = compute_compliant(CompliantParams(junction_x=4.0, junction_y=8.0, pinch_y=7.0), fast=True)
        self.assertFalse(result.pivot_ok, result.message)

    def test_admissible_slope_outranks_a_rejected_shape(self):
        good = compute_compliant(CompliantParams(), fast=True)
        bad = compute_compliant(CompliantParams(member_strength_mpa=0.01), fast=True)
        self.assertGreater(admission_score(good), 0.0)
        self.assertLess(admission_score(bad), admission_score(good))

    def test_solver_keeps_a_fixed_shape(self):
        params = CompliantParams()
        bounds = {key: (getattr(params, key), getattr(params, key)) for key in (
            "anchor_distance", "junction_x", "junction_y", "pinch_y",
            "l_u1", "l_v1", "l_u2", "l_v2", "r_u1", "r_v1", "r_u2", "r_v2",
            "f_u1", "f_v1", "f_u2", "f_v2", "l_thickness", "r_thickness", "f_thickness",
        )}
        out = solve_compliant(params, bounds, budget=1)
        self.assertEqual(out["tested"], 1)
        self.assertTrue(out["found"], out["message"])
        self.assertAlmostEqual(out["params"]["junction_y"], params.junction_y)
        self.assertGreater(out["result"]["flow_slope_mean"], 0.0)


if __name__ == "__main__":
    unittest.main()
