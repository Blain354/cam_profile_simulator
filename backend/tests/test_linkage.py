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

    def test_carriage_force_from_statics_matches_virtual_work(self):
        # Point pin, one tube at a time: the link's pull on the carriage must be F * d(gap)/dY.
        for p in (LinkageParams(), LEVER, replace(PENDULUM, pad_length=0.0)):
            with self.subTest(kind=p.linkage_type):
                r = compute_linkage(replace(p, stroke=0.4))
                y, gap, force = np.array(r.Y_positions), np.array(r.gap_a), np.array(r.force_a)
                net = force * np.gradient(gap, y)
                thrust = np.abs(net - net[::-1])
                np.testing.assert_allclose(np.array(r.thrust)[5:-5], thrust[5:-5], rtol=2e-3, atol=1e-4)
                self.assertAlmostEqual(r.thrust_y0, 0.0, places=9)

    def test_seal_force_and_flex(self):
        r = compute_linkage(replace(PENDULUM, pad_length=1.0))
        self.assertAlmostEqual(r.seal_force, r.seal_force_flatten + r.seal_force_squeeze + r.seal_force_pressure, places=9)
        self.assertTrue(0.3 < r.seal_force < 10.0, r.seal_force)
        self.assertTrue(r.sealed_after_flex)
        self.assertGreater(r.seal_pressure_y0_psi, PENDULUM.input_pressure_psi)
        # More pressure needs more force; a thinner bar flexes more and holds less pressure.
        self.assertGreater(compute_linkage(replace(PENDULUM, input_pressure_psi=30.0)).seal_force, compute_linkage(PENDULUM).seal_force)
        thin = compute_linkage(replace(PENDULUM, pad_length=1.0, member_width=0.5))
        self.assertGreater(thin.flex_y0, r.flex_y0)
        self.assertLess(thin.seal_pressure_y0_psi, r.seal_pressure_y0_psi)
        # Flex shares add up to the total; the mirror holds for the forces too.
        i0 = len(r.Y_positions) // 2
        self.assertLessEqual(r.flex_link_a[i0] + r.flex_bend_a[i0], r.flex_a[i0] + 1e-12)
        self.assertEqual(r.force_b, r.force_a[::-1])

    def test_figures_stop_where_the_pin_reaches_the_wall(self):
        r = compute_linkage(replace(PENDULUM, stroke=3.0))
        self.assertIsNotNone(r.jam_y)
        y = np.array(r.Y_positions)
        self.assertTrue(all(f is None for f, yy in zip(r.thrust, y) if abs(yy) >= r.jam_y))
        self.assertLess(r.max_wall_strain, 0.96)
        short = compute_linkage(replace(PENDULUM, stroke=0.3))
        self.assertIsNone(short.jam_y)
        # Just closed against the pressure takes less than closed with the preload on top.
        self.assertLess(short.seal_force_min, short.seal_force)
        self.assertAlmostEqual(compute_linkage(replace(PENDULUM, stroke=0.3, preload=0.0)).seal_force, short.seal_force_min, places=6)

    def test_forces_absent_rather_than_infinite(self):
        for change in ({"compliance": 0.0}, {"pin_diameter": 0.0}, {"member_width": 0.0}):
            r = compute_linkage(replace(LinkageParams(), **change))
            self.assertIsNone(r.seal_force)
            self.assertTrue(r.forces_message)
        r = compute_linkage(replace(LinkageParams(), lead_screw_pitch=0.0, motor_torque_mnm=0.0))
        self.assertEqual(r.thrust_available, 0.0)
        import json
        json.dumps(r.__dict__, allow_nan=False)

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
        cases = [(p, replace(s, objective=goal)) for p, s in ((LinkageParams(), LinkageSearch(max_stroke=5.0)), (LEVER, LEVER_SEARCH), (PENDULUM, PENDULUM_SEARCH))
                 for goal in ("target", "response")]
        for p, s in cases:
            with self.subTest(kind=p.linkage_type, goal=s.objective):
                best, feasible, _ = optimize_linkage(p, s)
                self.assertIsNotNone(best)
                self.assertGreater(feasible, 0)
                r = compute_linkage(best)
                self.assertTrue(r.feasible, r.message)
                self.assertLessEqual(r.max_oversqueeze, s.max_oversqueeze + 0.01)
                self.assertGreaterEqual(r.pivot_height_y0, s.min_pivot_height - 0.01)  # results are rounded to 1 um
                self.assertLessEqual(r.pivot_height_y0 + best.stroke, s.max_pivot_height + 0.01)
                start = compute_linkage(p)
                if s.objective == "response":
                    # The stroke is cut to the travel that reaches full bore, and the result reports it.
                    self.assertIsNotNone(r.y_full_open)
                    self.assertLessEqual(r.y_full_open, best.stroke + 1e-9)
                    self.assertLess(best.stroke - r.y_full_open, 0.05 + 1e-9)
                    self.assertLess(r.y_open, r.y_full_open)
                    self.assertAlmostEqual(r.response_time_ms, r.y_full_open / (100 * 0.85 * 0.5 / 60.0) * 1000.0, places=6)
                    # Faster than the best "follow the target" design under the same limits.
                    slow, _, _ = optimize_linkage(p, replace(s, objective="target"))
                    slow_full = compute_linkage(slow).y_full_open
                    if slow_full is not None:
                        self.assertLessEqual(r.y_full_open, slow_full + 1e-6)
                elif start.feasible and start.max_oversqueeze <= s.max_oversqueeze:
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
