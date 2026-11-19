"""Linkage kinematics checks: python -m unittest discover -s backend/tests."""

import math
import unittest
from dataclasses import replace

import numpy as np

from backend.linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage

# Pose measured on the lever concept sketch (about 29.5 px/mm).
LEVER = LinkageParams(linkage_type="lever", bar1_length=6.9, bar2_length=6.9, lever_length=16.5,
                      anchor_distance=5.05, pivot_offset=3.97, pin_diameter=0.4)
# Pose measured on the pendulum concept sketch (about 26.5 px/mm).
PENDULUM = LinkageParams(linkage_type="pendulum", bar1_length=11.95, bar2_length=14.43, anchor_distance=4.79,
                         pivot_offset=4.0, foot_length=1.5, foot_angle_deg=100.0, tube_center_x=8.1)
PENDULUM_SEARCH = LinkageSearch(bar2_min=8.0, bar2_max=18.0, anchor_max=8.0)
LEVER_SEARCH = LinkageSearch(anchor_min=2.0, anchor_max=8.0, bar1_min=3.0, bar1_max=12.0, bar2_max=12.0)


class LinkageTests(unittest.TestCase):
    def test_closed_at_y0_and_bar_lengths_hold(self):
        for p in (LinkageParams(), LEVER, PENDULUM):
            with self.subTest(kind=p.linkage_type):
                r = compute_linkage(p)
                self.assertTrue(r.feasible, r.message)
                i0 = len(r.Y_positions) // 2
                self.assertAlmostEqual(r.Y_positions[i0], 0.0)
                self.assertAlmostEqual(r.gap_a[i0], r.closed_gap - p.preload, places=9)
                self.assertEqual(r.flow_a[i0], 0.0)
                self.assertEqual(r.flow_b[i0], 0.0)
                reach = p.lever_length if p.linkage_type == "lever" else p.bar2_length
                if p.linkage_type == "pendulum":
                    phi = math.radians(p.foot_angle_deg)
                    reach = math.hypot(p.bar2_length + p.foot_length * math.cos(phi), p.foot_length * math.sin(phi))
                sign = -1.0 if r.anchor_on_top else 1.0
                for y, jx, jy, tx, ty in zip(r.Y_positions, r.joint_x, r.joint_y, r.tip_x, r.tip_y):
                    self.assertAlmostEqual(math.hypot(jx - r.anchor_x, jy), p.bar2_length, places=9)
                    self.assertAlmostEqual(math.hypot(jx - p.pivot_offset, jy - (r.pivot_height_y0 + sign * y)), p.bar1_length, places=9)
                    self.assertAlmostEqual(math.hypot(tx - r.anchor_x, ty), reach, places=9)
                    if p.linkage_type == "pendulum":
                        # The foot is rigid: constant length from the joint to the pinch point.
                        self.assertAlmostEqual(math.hypot(tx - jx, ty - jy), p.foot_length, places=9)
                    else:
                        # Anchor, joint and pinch point stay on one line.
                        self.assertAlmostEqual((jx - r.anchor_x) * ty - jy * (tx - r.anchor_x), 0.0, places=8)

    def test_reference_sketch_poses(self):
        r = compute_linkage(LinkageParams(preload=0.0, pin_diameter=0.0))
        self.assertAlmostEqual(r.pivot_height_y0, 7.83, delta=0.6)
        self.assertAlmostEqual(compute_linkage(LEVER).pivot_height_y0, 8.03, delta=1.2)
        pend = compute_linkage(PENDULUM)
        self.assertTrue(pend.anchor_on_top)
        self.assertAlmostEqual(pend.pivot_height_y0, 10.08, delta=1.2)

    def test_double_mirror_moves_the_two_tubes_in_opposition(self):
        for p in (LinkageParams(), LEVER, PENDULUM):
            with self.subTest(kind=p.linkage_type):
                r = compute_linkage(p)
                self.assertEqual(r.gap_b, r.gap_a[::-1])
                self.assertTrue(np.all(np.diff(np.array(r.gap_a, dtype=float)) > 0))
                self.assertGreater(r.flow_a[-1], 0.0)
                self.assertEqual(r.flow_b[-1], 0.0)
                self.assertGreater(r.flow_b[0], 0.0)
                self.assertEqual(r.flow_a[0], 0.0)

    def test_chamber_fills_then_vents(self):
        p = LinkageParams()
        r = compute_linkage(p)
        n = len(r.time_ms)
        self.assertGreater(n, 0)
        kpa = np.array(r.chamber_kpa)
        supply = p.input_pressure_psi * 6.89476
        self.assertAlmostEqual(kpa[n // 4], supply, delta=0.02 * supply)   # top of the +stroke
        self.assertAlmostEqual(kpa[3 * n // 4], 0.0, delta=0.02 * supply)  # bottom of the -stroke
        self.assertTrue(np.all(kpa >= -1e-6) and np.all(kpa <= supply + 1e-6))
        # The cycle starts and ends at atmosphere, so what went in came out.
        self.assertGreater(r.volume_in_ml, 0.0)
        self.assertAlmostEqual(r.volume_in_ml, r.volume_out_ml, delta=0.03 * r.volume_in_ml)
        # Free air needed to pressurise the chamber: V * dP / P_atm.
        self.assertAlmostEqual(r.volume_in_ml, p.chamber_volume_ml * supply / 101.325, delta=0.05 * r.volume_in_ml)
        self.assertEqual(compute_linkage(replace(p, chamber_volume_ml=0.0)).time_ms, [])
        # A 100 RPM motor at 85 % runs the 4 x 3 mm cycle at 0.708 mm/s.
        self.assertAlmostEqual(r.time_ms[-1] / 1000.0, 12.0 / (100 * 0.85 * 0.5 / 60.0), places=6)

    def test_optimizer_beats_start_and_respects_bounds(self):
        for p, s in ((LinkageParams(), LinkageSearch()), (LEVER, LEVER_SEARCH), (PENDULUM, PENDULUM_SEARCH)):
            with self.subTest(kind=p.linkage_type):
                best, feasible, _ = optimize_linkage(p, s)
                self.assertIsNotNone(best)
                self.assertGreater(feasible, 0)
                r = compute_linkage(best)
                self.assertTrue(r.feasible, r.message)
                self.assertLessEqual(r.max_oversqueeze, s.max_oversqueeze + 1e-3)
                self.assertGreaterEqual(r.pivot_height_y0, s.min_pivot_height - 0.01)  # results are rounded to 1 um
                self.assertLessEqual(r.pivot_height_y0 + p.stroke, s.max_pivot_height + 0.01)
                start = compute_linkage(p)
                if start.feasible and start.max_oversqueeze <= s.max_oversqueeze:
                    self.assertLessEqual(r.rms_error, start.rms_error + 1e-9)

    def test_fixed_height_solves_the_link(self):
        free = compute_linkage(PENDULUM)
        self.assertAlmostEqual(free.link_length, PENDULUM.bar1_length)
        # Imposing the height the free solve found gives back the same link.
        same = compute_linkage(replace(PENDULUM, bar1_length=1.0, fixed_height=2 * free.pivot_height_y0))
        self.assertAlmostEqual(same.link_length, PENDULUM.bar1_length, places=9)
        for height in (16.0, 22.0):
            r = compute_linkage(replace(PENDULUM, fixed_height=height))
            self.assertTrue(r.feasible, r.message)
            self.assertAlmostEqual(r.pivot_height_y0, height / 2)
            i0 = len(r.Y_positions) // 2
            self.assertAlmostEqual(r.gap_a[i0], r.closed_gap - PENDULUM.preload, places=9)
            for y, jx, jy in zip(r.Y_positions, r.joint_x, r.joint_y):
                self.assertAlmostEqual(math.hypot(jx - PENDULUM.pivot_offset, jy - (height / 2 - y)), r.link_length, places=9)
        best, feasible, _ = optimize_linkage(replace(PENDULUM, fixed_height=18.0), PENDULUM_SEARCH)
        self.assertIsNotNone(best)
        r = compute_linkage(best)
        self.assertTrue(r.feasible, r.message)
        self.assertAlmostEqual(r.pivot_height_y0, 9.0)
        self.assertAlmostEqual(r.link_length, best.bar1_length, places=3)
        self.assertLessEqual(r.max_oversqueeze, PENDULUM_SEARCH.max_oversqueeze + 1e-3)

    def test_contact_pad_pinches_with_its_nearer_end(self):
        point = compute_linkage(PENDULUM)
        pad = compute_linkage(replace(PENDULUM, pad_length=1.0))
        self.assertTrue(pad.feasible, pad.message)
        i0 = len(pad.Y_positions) // 2
        # Still just closed at Y = 0, with the pad centre further from the wall than a point contact would be.
        self.assertAlmostEqual(pad.gap_a[i0], pad.closed_gap - PENDULUM.preload, places=9)
        self.assertGreater(pad.tip_x[i0], point.tip_x[i0])
        phi = math.radians(PENDULUM.foot_angle_deg)
        for jx, jy, tx, gap in zip(pad.joint_x, pad.joint_y, pad.tip_x, pad.gap_a):
            tilt = abs(math.sin(math.atan2(jy, jx - pad.anchor_x) + phi))
            self.assertAlmostEqual(gap, pad.wall_x + tx - 0.5 * tilt - PENDULUM.pin_diameter / 2, places=9)
        # The other linkage types ignore the pad.
        self.assertEqual(compute_linkage(replace(LEVER, pad_length=1.0)).gap_a, compute_linkage(LEVER).gap_a)

    def test_unreachable_geometry_is_reported(self):
        r = compute_linkage(replace(LinkageParams(), bar2_length=1.0))
        self.assertFalse(r.feasible)
        self.assertNotEqual(r.message, "ok")


if __name__ == "__main__":
    unittest.main()
