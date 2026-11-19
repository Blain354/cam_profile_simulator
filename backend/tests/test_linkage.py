"""Linkage kinematics checks: python -m unittest discover -s backend/tests."""

import math
import unittest
from unittest import mock
from dataclasses import replace

import numpy as np

from backend import linkage
from backend.linkage import LinkageParams, LinkageSearch, compute_linkage, optimize_linkage

# Pose measured on the lever concept sketch (about 29.5 px/mm).
LEVER = LinkageParams(linkage_type="lever", bar1_length=6.9, bar2_length=6.9, lever_length=16.5,
                      anchor_distance=5.05, pivot_offset=3.97, pin_diameter=0.4)
# Pose measured on the pendulum concept sketch (about 26.5 px/mm).
PENDULUM = LinkageParams(linkage_type="pendulum", bar1_length=11.95, bar2_length=14.43, anchor_distance=4.79,
                         pivot_offset=4.0, foot_length=1.5, foot_angle_deg=100.0, tube_center_x=8.1)
PENDULUM_SEARCH = LinkageSearch(bar2_min=8.0, bar2_max=18.0, anchor_max=8.0)
LEVER_SEARCH = LinkageSearch(anchor_min=2.0, anchor_max=8.0, bar1_min=3.0, bar1_max=12.0, bar2_max=12.0)


_ONE_PIECE_BUDGET = {"N_SHORTLIST": 12, "N_ONE_PIECE_ROUND": 4}
_saved = {}


def setUpModule():
    # Each one-piece design costs a beam solve: a small budget keeps the suite quick.
    for name, value in _ONE_PIECE_BUDGET.items():
        _saved[name] = getattr(linkage, name)
        setattr(linkage, name, value)


def tearDownModule():
    for name, value in _saved.items():
        setattr(linkage, name, value)


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
        self.assertGreater(r.seal_pressure_y0_kpa, PENDULUM.input_pressure_kpa)
        # More pressure needs more force; a thinner bar flexes more and holds less pressure.
        self.assertGreater(compute_linkage(replace(PENDULUM, input_pressure_kpa=206.8)).seal_force, compute_linkage(PENDULUM).seal_force)
        thin = compute_linkage(replace(PENDULUM, pad_length=1.0, member_width=0.5))
        self.assertGreater(thin.flex_y0, r.flex_y0)
        self.assertLess(thin.seal_pressure_y0_kpa, r.seal_pressure_y0_kpa)
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
        self.assertAlmostEqual(compute_linkage(replace(PENDULUM, stroke=0.3, preload=0.0, contact_deformation=False)).seal_force, short.seal_force_min, places=6)

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
        supply = p.input_pressure_kpa
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
                best, feasible, _, report = optimize_linkage(p, s)
                self.assertIsNotNone(best)
                self.assertEqual(report["model"], "rigid")
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
                    self.assertIsNone(r.jam_y)
                    self.assertAlmostEqual(r.response_time_ms, r.y_full_open / (100 * 0.85 * 0.5 / 60.0) * 1000.0, places=6)
                    # Never worse than the design it started from, when that one was within the limits.
                    if start.jam_y is None and start.y_full_open is not None and start.max_oversqueeze <= s.max_oversqueeze and start.y_full_open <= s.max_stroke:
                        self.assertLessEqual(r.y_open, start.y_open + 0.03)
                elif start.feasible and start.max_oversqueeze <= s.max_oversqueeze:
                    self.assertLessEqual(r.rms_error, start.rms_error + 1e-9)

    def test_response_search_ranks_partial_flow_and_searches_the_foot(self):
        tight = replace(PENDULUM_SEARCH, max_stroke=0.3)
        best, feasible, _, _ = optimize_linkage(PENDULUM, tight)
        self.assertIsNotNone(best)   # cannot reach full bore: still gives the most flow it can
        r = compute_linkage(best)
        self.assertTrue(r.feasible, r.message)
        self.assertGreater(max(v or 0.0 for v in r.flow_a), 0.0)
        self.assertIsNone(r.y_full_open)
        self.assertLessEqual(best.stroke, 0.3 + 1e-9)
        self.assertLessEqual(r.max_oversqueeze, tight.max_oversqueeze + 0.01)
        # The foot is searched within its ranges, and held when the range is a single value.
        free = optimize_linkage(PENDULUM, PENDULUM_SEARCH)[0]
        held = optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, foot_min=1.5, foot_max=1.5, foot_angle_min=100.0, foot_angle_max=100.0))[0]
        self.assertEqual((held.foot_length, held.foot_angle_deg), (1.5, 100.0))
        self.assertTrue(1.0 <= free.foot_length <= 6.0 and 45.0 <= free.foot_angle_deg <= 135.0)
        self.assertLessEqual(compute_linkage(free).y_open, compute_linkage(held).y_open + 1e-6)
        # Over-squeeze below the preload leaves nothing feasible.
        self.assertIsNone(optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, max_oversqueeze=0.05))[0])

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
        best, feasible, _, _ = optimize_linkage(replace(PENDULUM, fixed_height=18.0), PENDULUM_SEARCH)
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

    def test_tube_pushes_the_pin_back_until_bars_and_tube_balance(self):
        p = replace(PENDULUM, pad_length=1.0, stroke=0.3)
        rigid, r = compute_linkage(replace(p, contact_deformation=False)), compute_linkage(p)
        self.assertTrue(r.contact_solved)
        self.assertFalse(rigid.contact_solved)
        # Same bars, same geometry: only the loaded gap moves, and only away from the wall.
        self.assertEqual(r.gap_a, rigid.gap_a)
        self.assertEqual(rigid.gap_loaded_a, rigid.gap_a)
        gap, loaded, flex, force = (np.array(v, dtype=float) for v in (r.gap_a, r.gap_loaded_a, r.flex_a, r.force_a))
        np.testing.assert_allclose(loaded, gap + flex, atol=1e-12)
        self.assertTrue(np.all(flex >= 0.0))
        self.assertEqual(r.gap_loaded_b, r.gap_loaded_a[::-1])
        # The pin gives way, so it presses less than rigid bars would and the tube opens sooner.
        i0 = len(r.Y_positions) // 2
        self.assertLess(r.seal_force, rigid.seal_force)
        self.assertLess(r.y_open, rigid.y_open)
        self.assertEqual(r.flow_a[i0], 0.0)
        # Balance: the push-back is the pin force times the bars' compliance at the pin.
        self.assertAlmostEqual(flex[i0], force[i0] / r.pin_stiffness, places=7)
        # Softer bars give way more, and the tube opens sooner still.
        soft = compute_linkage(replace(p, member_width=0.4))
        self.assertGreater(soft.flex_y0, r.flex_y0)
        self.assertGreater(soft.gap_loaded_a[i0], r.gap_loaded_a[i0])
        self.assertLess(soft.y_open, r.y_open)

    def test_curved_link_keeps_the_kinematics_and_bends(self):
        p = replace(PENDULUM, pad_length=1.0, stroke=0.3)
        straight, r = compute_linkage(p), compute_linkage(replace(p, link_curved=True))
        self.assertEqual(r.gap_a, straight.gap_a)
        self.assertEqual(r.joint_x, straight.joint_x)
        self.assertEqual(straight.link_arc_half_angle_deg, 0.0)
        self.assertIsNone(straight.link_bending_stress_mpa)
        alpha = math.radians(r.link_arc_half_angle_deg)
        self.assertTrue(0.0 < alpha <= math.pi / 2 + 1e-9)
        self.assertAlmostEqual(2.0 * r.link_arc_radius * math.sin(alpha), p.bar1_length, places=9)
        self.assertAlmostEqual(r.link_arc_sag, r.link_arc_radius * (1.0 - math.cos(alpha)), places=9)
        self.assertIn(r.link_arc_side, (-1.0, 1.0))
        # The arc meets the joint along the foot, at Y = 0.
        i0 = len(r.Y_positions) // 2
        cx, cy, px, py = r.joint_x[i0], r.joint_y[i0], r.tip_x[i0], r.tip_y[i0]
        bx, by = p.pivot_offset, r.pivot_height_y0
        chord = math.atan2(by - cy, bx - cx)
        tangent = chord + r.link_arc_side * alpha
        foot = math.atan2(py - cy, px - cx)
        self.assertAlmostEqual(abs(math.sin(tangent - foot)), 0.0, places=9)
        # A curved bar bends under the pull a straight one only stretches under.
        self.assertGreater(r.link_bending_stress_mpa, 0.0)
        self.assertGreater(r.flex_y0, straight.flex_y0)
        self.assertLess(r.pin_stiffness, straight.pin_stiffness)
        self.assertGreaterEqual(r.max_bending_stress_mpa, r.link_bending_stress_mpa)
        # The other types have no foot to be tangent to.
        self.assertEqual(compute_linkage(replace(LEVER, link_curved=True)).link_arc_half_angle_deg, 0.0)

    def test_frame_solver_matches_a_cantilever(self):
        from backend.linkage import _frame_solve
        e, w, t, length = 2500.0, 2.0, 3.0, 10.0
        ei = e * t * w ** 3 / 12.0
        xy = np.array([[i * length / 10, 0.0] for i in range(11)])
        u, reactions, ends = _frame_solve(xy, [(i, i + 1) for i in range(10)], e * w * t, ei, {0: 0.0, 1: 0.0, 2: 0.0}, {31: 1.0})
        self.assertAlmostEqual(u[10, 1], length ** 3 / (3.0 * ei), places=9)      # tip deflection P L^3 / 3 E I
        self.assertAlmostEqual(u[10, 2], length ** 2 / (2.0 * ei), places=9)      # tip slope
        self.assertAlmostEqual(abs(ends[0, 1]), length, places=6)                 # root moment P L
        np.testing.assert_allclose(reactions[0], [0.0, -1.0, -length], atol=1e-6)

    def test_one_piece_flexure_bends_instead_of_pivoting(self):
        # The default is the real part: the carriage end turns on a steel rod.
        self.assertFalse(PENDULUM.carriage_clamped)
        p = replace(PENDULUM, pad_length=1.0, stroke=0.6, compliant=True, link_curved=True, carriage_clamped=True)
        r = compute_linkage(p)
        self.assertTrue(r.feasible, r.message)
        import json
        json.dumps(r.__dict__, allow_nan=False)
        i0 = len(r.Y_positions) // 2
        y = np.array(r.Y_positions)
        # Made in its Y = 0 shape: with no tube it sits just closed plus the preload there.
        self.assertAlmostEqual(r.gap_a[i0], r.closed_gap - p.preload, places=9)
        # With no tube the pin moves in proportion to the carriage (small deflections).
        np.testing.assert_allclose(np.diff(r.gap_a), r.sensitivity_y0 * (y[1] - y[0]), rtol=2e-2)
        self.assertGreater(r.sensitivity_y0, 0.0)
        self.assertGreater(r.flow_a[-1], 0.0)
        self.assertEqual(r.flow_a[i0], 0.0)
        self.assertEqual(r.gap_loaded_b, r.gap_loaded_a[::-1])
        # Balance at the pin, and the drawing's pose is the loaded one.
        self.assertAlmostEqual(r.flex_a[i0], r.force_a[i0] / r.pin_stiffness, places=7)
        self.assertAlmostEqual(r.gap_loaded_a[i0] - r.gap_a[i0], r.flex_a[i0], places=12)
        # The part's shapes: three lines that share the joint, the arm starting at the anchor, built in.
        f = r.flexure
        self.assertEqual((f["arm"]["x"][0], f["arm"]["y"][0]), (r.anchor_x, 0.0))
        self.assertEqual((f["arm"]["x_per_mm"][0], f["arm"]["y_per_mm"][0], f["arm"]["x_per_n"][0]), (0.0, 0.0, 0.0))
        for line in ("foot", "link"):
            self.assertEqual((f[line]["x"][0], f[line]["y"][0]), (f["arm"]["x"][-1], f["arm"]["y"][-1]))
        # The carriage end follows the carriage exactly, whatever the pin force.
        self.assertAlmostEqual(f["link"]["y_per_mm"][-1], 1.0, places=9)
        self.assertAlmostEqual(f["link"]["x_per_mm"][-1], 0.0, places=9)
        self.assertAlmostEqual(f["link"]["y_per_n"][-1], 0.0, places=9)
        self.assertAlmostEqual(f["foot"]["x"][-1] + f["foot"]["x_per_mm"][-1] * f["travel_sign"] * y[-1] + f["foot"]["x_per_n"][-1] * r.force_a[-1], r.tip_x[-1], places=9)
        # Bending the part takes thrust even with the tubes out, and stresses it.
        self.assertGreater(r.spring_rate, 0.0)
        self.assertGreater(r.max_stress_mpa, 0.0)
        self.assertAlmostEqual(r.stress_margin, p.member_strength_mpa / r.max_stress_mpa, places=9)
        self.assertEqual(r.stress_b, r.stress_a[::-1])
        self.assertIn(r.max_stress_where, ("arm", "foot", "link"))
        self.assertIn(r.max_stress_spot, ("shell", "joint", "carriage", "span"))
        # A stroke long enough to jam the closed tube still gives a clean result.
        long = compute_linkage(replace(p, stroke=4.0))
        self.assertIsNotNone(long.jam_y)
        json.dumps(long.__dict__, allow_nan=False)
        # A thinner section bends more easily: less thrust and less stress for the same travel.
        thin = compute_linkage(replace(p, member_width=1.0))
        self.assertLess(thin.spring_rate, r.spring_rate / 4.0)
        self.assertLess(thin.max_stress_mpa, r.max_stress_mpa)
        self.assertLess(thin.pin_stiffness, r.pin_stiffness)
        # Letting the carriage end pivot frees the link: softer still.
        pivot = compute_linkage(replace(p, carriage_clamped=False))
        self.assertLess(pivot.spring_rate, r.spring_rate)
        # The rod carries what the carriage gives the part; the eye and the rod are checked on it.
        self.assertGreater(pivot.carriage_load, 0.0)
        self.assertGreaterEqual(pivot.carriage_load, pivot.max_side_load)
        self.assertAlmostEqual(pivot.carriage_bearing_mpa, pivot.carriage_load / (1.5 * 4.0), places=9)
        self.assertAlmostEqual(pivot.carriage_pin_bending_mpa, 32 * pivot.carriage_load * 8.0 / 4 / (np.pi * 1.5 ** 3), places=9)
        self.assertIsNone(r.carriage_bearing_mpa)       # clamped: no rod
        thick_rod = compute_linkage(replace(p, carriage_clamped=False, carriage_pin_diameter=3.0))
        self.assertAlmostEqual(thick_rod.carriage_bearing_mpa, pivot.carriage_bearing_mpa / 2.0, places=9)
        # Past the strength the travel where it happens is reported.
        weak = compute_linkage(replace(p, member_strength_mpa=r.max_stress_mpa / 2.0))
        self.assertIsNotNone(weak.stress_limit_y)
        self.assertLess(weak.stress_limit_y, p.stroke)
        self.assertIsNone(compute_linkage(replace(p, member_strength_mpa=r.max_stress_mpa * 2.0)).stress_limit_y)
        # Only the pendulum can be one piece; the others keep their pivots.
        self.assertIsNone(compute_linkage(replace(LEVER, compliant=True)).flexure)
        self.assertIsNone(compute_linkage(PENDULUM).flexure)
        # No tube stiffness to push with: the part's own figures are still there.
        bare = compute_linkage(replace(p, compliance=0.0))
        self.assertIsNone(bare.seal_force)
        self.assertGreater(bare.max_stress_mpa, 0.0)
        self.assertTrue(bare.forces_message)

    @mock.patch.multiple(linkage, N_FIRST=6000, N_ROUND=3000)
    def test_one_piece_search_ranks_on_the_part_and_holds_its_limits(self):
        p = replace(PENDULUM, compliant=True, member_strength_mpa=150.0)
        best, feasible, tested, report = optimize_linkage(p, PENDULUM_SEARCH)
        self.assertEqual(report["model"], "one-piece")
        # The first batch, then a round of draws around the best that hold, each design once.
        rounds = len(linkage.ONE_PIECE_ROUNDS) * linkage.N_ONE_PIECE_ROUND
        self.assertTrue(linkage.N_SHORTLIST < report["shortlist"] <= linkage.N_SHORTLIST + rounds, report)
        self.assertEqual(report["shortlist"], report["passed"] + sum(report["rejected"].values()))
        self.assertEqual(set(report["rejected"]), {"stress", "thrust", "eye", "rod", "no_flow"})
        self.assertIsNotNone(best)
        self.assertGreater(report["passed"], 0)
        self.assertTrue(best.compliant)
        self.assertEqual(best.chamber_volume_ml, p.chamber_volume_ml)
        # Re-simulated as returned, over the travel it uses: every limit holds.
        r = compute_linkage(best)
        self.assertTrue(r.feasible, r.message)
        self.assertIsNotNone(r.flexure)
        self.assertLessEqual(best.stroke, PENDULUM_SEARCH.max_stroke + 1e-9)
        self.assertIsNone(r.jam_y)
        self.assertGreater(max(v or 0.0 for v in r.flow_a), 0.0)
        self.assertLessEqual(r.max_stress_mpa, p.member_strength_mpa)
        self.assertLessEqual(r.thrust_needed, r.thrust_available)
        self.assertLessEqual(r.carriage_bearing_mpa, p.member_strength_mpa)
        self.assertLessEqual(r.carriage_pin_bending_mpa, p.carriage_pin_strength_mpa)
        # The part gives way: the closed tube's squeeze is read on the loaded gap.
        self.assertLessEqual(r.closed_gap - min(g for g in r.gap_loaded_a if g is not None), PENDULUM_SEARCH.max_oversqueeze + 1e-9)
        self.assertLessEqual(r.pivot_height_y0 + best.stroke, PENDULUM_SEARCH.max_pivot_height + 0.01)
        if r.y_full_open is not None:
            self.assertLess(best.stroke - r.y_full_open, 0.05 + 1e-9)
        import json
        json.dumps(r.__dict__, allow_nan=False)
        # Same inputs, same answer.
        self.assertEqual(optimize_linkage(p, PENDULUM_SEARCH), (best, feasible, tested, report))
        # A range with min = max holds that value through both stages.
        pinned = replace(PENDULUM_SEARCH, bar1_min=best.bar1_length, bar1_max=best.bar1_length,
                         bar2_min=best.bar2_length, bar2_max=best.bar2_length,
                         anchor_min=best.anchor_distance, anchor_max=best.anchor_distance,
                         foot_angle_min=best.foot_angle_deg, foot_angle_max=best.foot_angle_deg)
        held, _, _, held_report = optimize_linkage(p, pinned)
        self.assertIsNotNone(held)
        self.assertEqual((held.bar1_length, held.bar2_length, held.anchor_distance, held.foot_angle_deg),
                         (best.bar1_length, best.bar2_length, best.anchor_distance, best.foot_angle_deg))
        self.assertTrue(PENDULUM_SEARCH.foot_min <= held.foot_length <= PENDULUM_SEARCH.foot_max)
        lever = optimize_linkage(LEVER, replace(LEVER_SEARCH, bar1_min=6.9, bar1_max=6.9, lever_min=16.5, lever_max=16.5))[0]
        self.assertEqual((lever.bar1_length, lever.lever_length), (6.9, 16.5))
        # Too weak a material: no design is offered, and the report says why.
        none, _, _, weak = optimize_linkage(replace(p, member_strength_mpa=1.0), PENDULUM_SEARCH)
        self.assertIsNone(none)
        self.assertEqual(weak["passed"], 0)
        self.assertGreater(weak["rejected"]["stress"], 0)
        self.assertEqual(weak["shortlist"], sum(weak["rejected"].values()))
        # The rod is checked only when the link turns on it; a limit set to 0 is not checked.
        self.assertIsNone(linkage._one_piece_limit(best, r, best.stroke))
        self.assertEqual(linkage._one_piece_limit(replace(best, carriage_pin_strength_mpa=1e-3), r, best.stroke), "rod")
        self.assertIsNone(linkage._one_piece_limit(replace(best, carriage_pin_strength_mpa=0.0), r, best.stroke))
        self.assertIsNone(linkage._one_piece_limit(replace(best, carriage_pin_strength_mpa=1e-3, carriage_clamped=True), r, best.stroke))
        self.assertEqual(linkage._one_piece_limit(replace(best, member_strength_mpa=1e-3), r, best.stroke), "stress")
        # A short rod: the eye takes the load on a small area and is checked before the rod.
        short_rod = replace(best, carriage_pin_length=0.05)
        self.assertEqual(linkage._one_piece_limit(short_rod, compute_linkage(short_rod), best.stroke), "eye")
        # no_flow comes first: a stroke that jams the closed tube has no travel to check limits on.
        jam = replace(p, stroke=4.0, member_strength_mpa=1e-3)
        self.assertIsNotNone(compute_linkage(jam).jam_y)
        self.assertEqual(linkage._one_piece_score(jam, replace(PENDULUM_SEARCH, objective="target"))[2], "no_flow")

    @mock.patch.multiple(linkage, N_FIRST=6000, N_ROUND=3000)
    def test_one_piece_search_looks_past_the_rigid_ranking(self):
        # The screen's default one-piece part at 40 MPa: the best rigid designs all break or open
        # little (about 38 % of full bore at most); random designs and refinement find a better part.
        p = replace(PENDULUM, tube_center_x=8.0, foot_length=1.5, pad_length=1.0, link_curved=True, compliant=True)
        s = replace(PENDULUM_SEARCH, bar1_min=6.0, bar1_max=16.0, anchor_min=-5.0)
        best, _, _, report = optimize_linkage(p, s)
        self.assertIsNotNone(best, report)
        r = compute_linkage(best)
        self.assertGreater(max(v or 0.0 for v in r.flow_a) / r.max_flow_l_min, 0.5)
        self.assertLessEqual(r.max_stress_mpa, p.member_strength_mpa)

    def test_unreachable_geometry_is_reported(self):
        r = compute_linkage(replace(LinkageParams(), bar2_length=1.0))
        self.assertFalse(r.feasible)
        self.assertNotEqual(r.message, "ok")


if __name__ == "__main__":
    unittest.main()
