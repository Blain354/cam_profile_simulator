"""Linkage kinematics checks: python -m unittest discover -s backend/tests."""

import math
import unittest
from dataclasses import replace

import numpy as np

from backend.linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage


class LinkageTests(unittest.TestCase):
    def test_closed_at_y0_and_bar_lengths_hold(self):
        p = LinkageParams()
        r = compute_linkage(p)
        self.assertTrue(r.feasible, r.message)
        i0 = len(r.Y_positions) // 2
        self.assertAlmostEqual(r.Y_positions[i0], 0.0)
        self.assertAlmostEqual(r.gap_a[i0], r.closed_gap - p.preload, places=9)
        self.assertEqual(r.flow_a[i0], 0.0)
        for y, ex, ey in zip(r.Y_positions, r.elbow_x, r.elbow_y):
            if ex is None:
                continue
            self.assertAlmostEqual(math.hypot(ex + p.anchor_distance, ey), p.bar2_length, places=9)
            self.assertAlmostEqual(math.hypot(ex - p.pivot_offset, ey - (r.pivot_height_y0 + y)), p.bar1_length, places=9)

    def test_reference_sketch_pose(self):
        # Pose measured on the concept sketch: pivot 7.83 mm above the anchor, elbow at (-8.7, 4.5).
        r = compute_linkage(LinkageParams(preload=0.0, pin_diameter=0.0))
        self.assertAlmostEqual(r.pivot_height_y0, 7.83, delta=0.6)

    def test_opening_is_monotone_and_mirror_modes(self):
        r = compute_linkage(LinkageParams())
        g = np.array([v for y, v in zip(r.Y_positions, r.gap_a) if y >= 0], dtype=float)
        self.assertTrue(np.all(np.diff(g) > 0))
        self.assertEqual(r.gap_a, r.gap_b)
        o = compute_linkage(LinkageParams(mirror_mode="opposed"))
        self.assertEqual(o.gap_b, o.gap_a[::-1])
        self.assertGreater(o.max_oversqueeze, 0.1)

    def test_optimizer_beats_start_and_respects_bounds(self):
        p = LinkageParams()
        s = LinkageSearch(grid=14)
        best, feasible, _ = optimize_linkage(p, s)
        self.assertIsNotNone(best)
        self.assertGreater(feasible, 0)
        r = compute_linkage(best)
        self.assertTrue(r.feasible, r.message)
        self.assertLessEqual(r.rms_error, compute_linkage(p).rms_error + 1e-9)
        self.assertGreaterEqual(r.pivot_height_y0, s.min_pivot_height - 1e-6)
        self.assertLessEqual(r.pivot_height_y0 + p.stroke, s.max_pivot_height + 1e-6)

    def test_unreachable_geometry_is_reported(self):
        r = compute_linkage(replace(LinkageParams(), bar2_length=1.0))
        self.assertFalse(r.feasible)
        self.assertNotEqual(r.message, "ok")


if __name__ == "__main__":
    unittest.main()
