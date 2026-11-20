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
# Inverted carriage pivot (on the tube's side), found by the search: the elbow and the lever still
# push, this pendulum pulls (its pivot is further out than its arm).
ELBOW_INV = LinkageParams(pivot_inverted=True)
LEVER_INV = replace(LEVER, bar1_length=9.685, bar2_length=4.543, lever_length=15.949, anchor_distance=7.058, pivot_inverted=True, stroke=0.7)
PENDULUM_INV = LinkageParams(linkage_type="pendulum", bar1_length=8.713, bar2_length=18.0, anchor_distance=-1.405, pivot_offset=4.0,
                             foot_length=3.468, foot_angle_deg=105.909, pivot_inverted=True, stroke=0.15)
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

    def test_inverted_pivot_closes_at_y0_and_keeps_its_bars(self):
        for p, pulls in ((ELBOW_INV, False), (LEVER_INV, False), (PENDULUM_INV, True)):
            with self.subTest(kind=p.linkage_type):
                r = compute_linkage(p)
                self.assertTrue(r.feasible, r.message)
                self.assertAlmostEqual(r.pivot_x, -p.pivot_offset)
                i0 = len(r.Y_positions) // 2
                self.assertAlmostEqual(r.gap_a[i0], r.closed_gap - p.preload, places=9)
                # Y still opens tube A: a link that pulls has its carriage running the other way.
                self.assertTrue(np.all(np.diff(np.array(r.gap_a, dtype=float)) > 0))
                self.assertEqual(r.max_link_force > 0, pulls)
                frame = -1.0 if r.anchor_on_top else 1.0
                self.assertEqual(r.travel_sign, -frame if pulls else frame)
                for y, jx, jy in zip(r.Y_positions, r.joint_x, r.joint_y):
                    self.assertAlmostEqual(math.hypot(jx - r.anchor_x, jy), p.bar2_length, places=9)
                    self.assertAlmostEqual(math.hypot(jx - r.pivot_x, jy - (r.pivot_height_y0 + r.travel_sign * y)), p.bar1_length, places=9)
                # The pin holds against the tube at Y = 0 for a design that pulls as for one that pushes.
                self.assertTrue(r.sealed_after_flex)
        # A fixed height solves the link on the inverted side too.
        free = compute_linkage(PENDULUM_INV)
        same = compute_linkage(replace(PENDULUM_INV, bar1_length=1.0, fixed_height=2 * free.pivot_height_y0))
        self.assertAlmostEqual(same.link_length, PENDULUM_INV.bar1_length, places=9)
        self.assertEqual(same.gap_a, free.gap_a)
        # The curved link and the one-piece part follow the pivot to its side.
        curved = compute_linkage(replace(PENDULUM_INV, link_curved=True))
        self.assertGreater(curved.link_arc_half_angle_deg, 0.0)
        self.assertEqual(curved.gap_a, free.gap_a)
        one = compute_linkage(replace(PENDULUM_INV, compliant=True))
        self.assertTrue(one.feasible, one.message)
        self.assertGreater(one.sensitivity_y0, 0.0)
        self.assertGreater(one.max_link_force, 0.0)    # in one piece too, the link pulls
        self.assertLess(compute_linkage(replace(PENDULUM, compliant=True)).max_link_force, 0.0)

    def test_frame_axial_force_is_positive_in_tension(self):
        # One bar along x, held at node 0, node 1 pulled by 1 N along +x.
        xy = np.array([[0.0, 0.0], [10.0, 0.0]])
        _, _, ends = linkage._frame_solve(xy, [(0, 1)], 1000.0, 10.0, {0: 0.0, 1: 0.0, 2: 0.0, 4: 0.0, 5: 0.0}, {3: 1.0})
        self.assertAlmostEqual(ends[0, 0], 1.0)

    def test_carriage_force_from_statics_matches_virtual_work(self):
        # Point pin, one tube at a time: the link's pull on the carriage must be F * d(gap)/dY.
        for p in (LinkageParams(), LEVER, replace(PENDULUM, pad_length=0.0), ELBOW_INV, LEVER_INV, PENDULUM_INV):
            with self.subTest(kind=p.linkage_type, inverted=p.pivot_inverted):
                r = compute_linkage(replace(p, stroke=min(0.4, p.stroke)))
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
        # A zero compliance only means something to the simple tube law.
        for change in ({"compliance": 0.0, "tube_model": "simple"}, {"pin_diameter": 0.0}, {"member_width": 0.0}):
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

    def test_pinch_height_limit_from_the_top_plane(self):
        def height(q):
            r = compute_linkage(replace(q, compliant=False))
            return r.tip_y[len(r.Y_positions) // 2]
        free = optimize_linkage(PENDULUM, PENDULUM_SEARCH)[0]
        cap = height(free) - 1.0
        capped = optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, pinch_height_max=cap))[0]
        self.assertIsNotNone(capped)
        self.assertLessEqual(height(capped), cap + 1e-6)
        floor = height(free) + 1.0
        raised = optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, pinch_height_min=floor))[0]
        if raised is not None:
            self.assertGreaterEqual(height(raised), floor - 1e-6)
        self.assertIsNone(optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, pinch_height_max=0.1))[0])

    def test_anchor_no_go_zone_is_avoided(self):
        free = optimize_linkage(PENDULUM, PENDULUM_SEARCH)[0]
        a = free.anchor_distance
        zone = replace(PENDULUM_SEARCH, anchor_avoid_min=a - 1.0, anchor_avoid_max=a + 1.0)
        best = optimize_linkage(PENDULUM, zone)[0]
        self.assertIsNotNone(best)
        self.assertFalse(a - 1.0 < best.anchor_distance < a + 1.0, best.anchor_distance)
        # Ends given the other way round mean the same zone; equal ends mean no zone.
        self.assertEqual(optimize_linkage(PENDULUM, replace(zone, anchor_avoid_min=a + 1.0, anchor_avoid_max=a - 1.0))[0], best)
        self.assertEqual(optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, anchor_avoid_min=2.0, anchor_avoid_max=2.0))[0], free)
        # The whole range inside the zone leaves nothing.
        self.assertIsNone(optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, anchor_avoid_min=-50.0, anchor_avoid_max=50.0))[0])

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
        # A stroke long enough to jam the closed tube still gives a clean result. (The FEM tube
        # resists a deep squeeze more than the simple law: this part gives way before it jams.)
        long = compute_linkage(replace(p, stroke=4.0, tube_model="simple"))
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
        bare = compute_linkage(replace(p, compliance=0.0, tube_model="simple"))
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
        self.assertEqual(set(report["rejected"]), {"stress", "thrust", "eye", "rod", "no_flow", "collision", "seal"})
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
        jam = replace(p, stroke=4.0, member_strength_mpa=1e-3, tube_model="simple")
        self.assertIsNotNone(compute_linkage(jam).jam_y)
        self.assertEqual(linkage._one_piece_score(jam, replace(PENDULUM_SEARCH, objective="target"))[2], "no_flow")

    @mock.patch.multiple(linkage, N_FIRST=6000, N_ROUND=3000)
    def test_one_piece_search_looks_past_the_rigid_ranking(self):
        # The screen's default one-piece part at 40 MPa: the best rigid designs all break or open
        # little (about 38 % of full bore at most); random designs and refinement find a better part.
        # A test of the search on the simple tube law: with the module's small budget the FEM tube,
        # which resists a deep squeeze more, leaves the best part just under half the bore.
        p = replace(PENDULUM, tube_center_x=8.0, foot_length=1.5, pad_length=1.0, link_curved=True, compliant=True,
                    tube_model="simple")
        s = replace(PENDULUM_SEARCH, bar1_min=6.0, bar1_max=16.0, anchor_min=-5.0)
        best, _, _, report = optimize_linkage(p, s)
        self.assertIsNotNone(best, report)
        r = compute_linkage(best)
        self.assertGreater(max(v or 0.0 for v in r.flow_a) / r.max_flow_l_min, 0.5)
        self.assertLessEqual(r.max_stress_mpa, p.member_strength_mpa)

    def test_the_rigid_pick_returns_a_design_that_assembles_once_rounded(self):
        # The best inverted pendulum of these ranges sits by a singular closed pose: rounded to
        # 1 um, it lands on a pivot below the anchor line. The pick passes it over.
        p = replace(PENDULUM, foot_length=1.5, pad_length=1.0, tube_center_x=8.0, pivot_inverted=True)
        s = LinkageSearch(bar1_min=6, bar1_max=16, bar2_min=8, bar2_max=18, anchor_min=-5, anchor_max=8, pivot_side="inverted")
        best = optimize_linkage(p, s)[0]
        r = compute_linkage(best)
        self.assertIsNotNone(r.gap_a[len(r.Y_positions) // 2], r.message)
        self.assertGreater(max(v or 0.0 for v in r.flow_a), 0.0)
        self.assertTrue(r.sealed_after_flex)

    def test_stroke_used_stops_where_the_closed_side_locks(self):
        # Full bore at 2.46 mm, but this lever's hinged bar reaches dead centre at Y = -2.275: a
        # full-bore stroke (2.5) would not run. The travel used stops before, and runs.
        p = LinkageParams(linkage_type="lever", bar1_length=10.632, bar2_length=6.931, anchor_distance=2.145,
                          lever_length=10.735, stroke=3.0, chamber_volume_ml=0.0, tube_model="simple")
        r = compute_linkage(p)
        self.assertAlmostEqual(r.y_min, -2.275)
        self.assertGreater(r.y_full_open, 2.45)
        used = linkage._stroke_used(r, LinkageSearch())
        self.assertLessEqual(used, -r.y_min)
        self.assertTrue(compute_linkage(replace(p, stroke=used)).feasible)

    def test_segment_distance_by_hand(self):
        d = lambda a, b, c, e: float(linkage._seg_dist(*a, *b, *c, *e))
        self.assertAlmostEqual(d((0, 0), (4, 0), (1, 2), (3, 2)), 2.0)          # parallel, one over the other
        self.assertAlmostEqual(d((0, 0), (1, 0), (2, 0), (3, 0)), 1.0)          # in line, end to end
        self.assertEqual(d((0, 0), (2, 2), (0, 2), (2, 0)), 0.0)                # crossing
        self.assertAlmostEqual(d((0, 0), (2, 0), (1, 0.5), (1, 3)), 0.5)        # T: an end to the other's middle
        self.assertAlmostEqual(d((0, 0), (1, 0), (4, 4), (5, 5)), 5.0)          # ends nearest each other
        # Segment to arc: a half circle of radius 1 from (0, 0) to (2, 0), bulging up to (1, 1).
        for n, bound in ((linkage.N_ARC_EXACT, 0.003), (linkage.N_ARC_SEARCH, 0.08)):
            pts, sag, whole = linkage._arc_points(0.0, 0.0, 2.0, 0.0, 2.0, math.pi / 2, 1.0, n)
            self.assertAlmostEqual(float(whole), 1.0)
            self.assertAlmostEqual(float(sag), 1.0 - math.cos(math.pi / 2 / n))
            for seg, exact in ((((1.0, 1.5), (1.0, 3.0)), 0.5), (((-1.0, 3.0), (3.0, 3.0)), 2.0), (((2.0, 2.0), (4.0, 4.0)), math.sqrt(5) - 1.0)):
                chords = min(d(a, b, *seg) for a, b in zip(pts[:-1], pts[1:]))
                self.assertLessEqual(chords - float(sag), exact + 1e-9)          # never more than the arc's
                self.assertGreater(chords - float(sag), exact - bound)

    def test_clearance_between_the_two_linkages(self):
        # The CAD's layout: planes 10.75 mm apart, 3 mm slabs, carriage block 5.5 mm across, rod 8 mm.
        self.assertEqual(linkage._plane_gaps(LinkageParams()), {"slabs": 7.75, "carriage": 1.125, "pivot rod": 2.625})
        r = compute_linkage(LinkageParams())
        self.assertEqual((r.plane_gap, r.plane_gap_where), (1.125, "carriage"))
        self.assertIsNone(r.min_clearance)            # nothing reaches the other linkage: nothing to measure
        self.assertIsNone(r.collision_y)
        # A clamped one-piece link has no rod.
        self.assertNotIn("pivot rod", linkage._plane_gaps(replace(PENDULUM, compliant=True, carriage_clamped=True)))

        # Slabs that overlap: every member against every member, in plane. The default elbow's two
        # links, which both cross the screw axis, come within 1.6 mm at the end of the stroke.
        with mock.patch.object(linkage, "_plane_gaps", return_value={"slabs": -1.0}):
            r = compute_linkage(LinkageParams())
        self.assertAlmostEqual(r.min_clearance, -0.409, places=3)
        self.assertEqual((r.min_clearance_where, r.min_clearance_y), ("link A / link B", 3.0))
        self.assertAlmostEqual(r.collision_y, 1.4, places=6)
        i = len(r.Y_positions) - 1
        h0, xb = r.pivot_height_y0, r.pivot_x
        a = ((xb, h0 + 3.0), (r.joint_x[i], r.joint_y[i]))            # link A at Y = 3
        b = ((-xb, h0 + 3.0), (-r.joint_x[0], 2 * h0 - r.joint_y[0]))  # link B: link A at -3, turned
        self.assertAlmostEqual(float(linkage._seg_dist(*a[0], *a[1], *b[0], *b[1])) - 2.0, r.min_clearance, places=9)

        # A rod long enough to reach the other slab: B's rod, a 1.5 mm disc, against A's members.
        r = compute_linkage(replace(LinkageParams(), carriage_pin_length=14.0))
        self.assertEqual(r.plane_gap_where, "pivot rod")
        self.assertAlmostEqual(r.plane_gap, -0.375)
        y = np.array(r.Y_positions)
        by = r.pivot_height_y0 + r.travel_sign * y
        hand = min(float(linkage._seg_dist(-xb, py, -xb, py, *seg)) for k, py in enumerate(by)
                   for seg in ((r.anchor_x, 0.0, r.joint_x[k], r.joint_y[k]), (xb, py, r.joint_x[k], r.joint_y[k]))) - 0.75 - 1.0
        self.assertAlmostEqual(r.min_clearance, hand, places=9)
        self.assertTrue(r.min_clearance_where.startswith("pivot rod "), r.min_clearance_where)   # A against B is the same at -Y
        # Slabs thick enough to reach the carriage block: the link's eye sits in the block.
        r = compute_linkage(replace(PENDULUM_INV, member_thickness=6.0, compliant=True))
        self.assertEqual(r.plane_gap_where, "carriage")
        self.assertAlmostEqual(r.min_clearance, -1.0)                 # half a bar inside
        self.assertTrue(r.min_clearance_where.startswith("carriage block / "))
        self.assertEqual(r.collision_y, 0.0)
        # A gap left across the planes counts: a rod 0.1 mm short of the other slab, over A's link in
        # plane, is 0.1 mm clear of it, not overlapping; and 4.75 mm slabs leave the block 0.25 mm.
        q = replace(LinkageParams(), carriage_pin_length=13.05)
        r = compute_linkage(q)
        self.assertAlmostEqual(r.plane_gap, 0.1)
        y = np.array(r.Y_positions)
        by = r.pivot_height_y0 + r.travel_sign * y
        flat = np.array([min(float(linkage._seg_dist(-xb, py, -xb, py, *seg)) for seg in ((r.anchor_x, 0.0, r.joint_x[k], r.joint_y[k]), (xb, py, r.joint_x[k], r.joint_y[k])))
                         for k, py in enumerate(by)]) - 0.75 - 1.0
        self.assertLess(flat.min(), 0.0)
        self.assertAlmostEqual(r.min_clearance, 0.1, places=9)
        self.assertAlmostEqual(r.collision_y, float(np.abs(y[np.hypot(0.1, np.maximum(flat, 0.0)) < 0.3 - 1e-9]).min()), places=9)
        r = compute_linkage(replace(PENDULUM, compliant=True, member_thickness=4.75))
        self.assertEqual((r.plane_gap_where, r.collision_y), ("carriage", 0.0))
        self.assertAlmostEqual(r.min_clearance, 0.25)
        # The inverted elbow keeps its rod on its own side: the same gaps as normal.
        self.assertEqual(compute_linkage(ELBOW_INV).plane_gap, 1.125)

    def test_a_design_that_collides_is_refused(self):
        # Slabs 6 mm thick reach the carriage block, and every link's eye sits in it: nothing is left.
        p = replace(LinkageParams(), member_thickness=6.0)
        self.assertEqual(compute_linkage(p).collision_y, 0.0)
        best, feasible, tested, report = optimize_linkage(p, LinkageSearch(max_stroke=5.0))
        self.assertIsNone(best)
        self.assertEqual(feasible, 0)
        self.assertGreater(report["sides"]["normal"]["collision"], 0)
        # Without the clearance the same search returns a design: the clearance alone refused them.
        self.assertIsNotNone(optimize_linkage(replace(p, assembly_clearance=-10.0), LinkageSearch(max_stroke=5.0))[0])
        # A rod that reaches the other slab: the search keeps what it returns clear of it over its stroke.
        for q, s in ((LinkageParams(), LinkageSearch(max_stroke=5.0)), (LEVER, LEVER_SEARCH), (PENDULUM, PENDULUM_SEARCH)):
            with self.subTest(kind=q.linkage_type):
                q = replace(q, carriage_pin_length=14.0)
                found = optimize_linkage(q, s)[0]
                r = compute_linkage(found)
                self.assertIsNone(r.collision_y)
                self.assertEqual(r.plane_gap_where, "pivot rod")
                # None: the rod reaches the other plane but nothing there comes near it.
                self.assertTrue(r.min_clearance is None or r.min_clearance >= q.assembly_clearance, r.min_clearance)

    def test_the_finder_keeps_only_designs_that_seal_at_rest(self):
        on = optimize_linkage(LEVER, LEVER_SEARCH)
        off = optimize_linkage(LEVER, replace(LEVER_SEARCH, require_seal=False))
        self.assertTrue(compute_linkage(on[0]).sealed_after_flex)
        self.assertEqual(on, optimize_linkage(LEVER, LEVER_SEARCH))                   # same inputs, same answer
        if not compute_linkage(off[0]).sealed_after_flex:
            self.assertNotEqual(on[0], off[0])
            self.assertGreater(on[3]["sides"]["normal"]["seal"], 0)
        self.assertEqual(off[3]["sides"]["normal"]["seal"], 0)
        # No force figures (a simple tube with no compliance): no seal verdict, so nothing is refused for it.
        blind = replace(LEVER, tube_model="simple", compliance=0.0)
        self.assertIsNone(compute_linkage(blind).sealed_after_flex)
        found = optimize_linkage(blind, LEVER_SEARCH)
        self.assertIsNotNone(found[0])
        self.assertEqual(found[3]["sides"]["normal"]["seal"], 0)

    def test_both_pivot_sides_are_searched_and_the_better_kept(self):
        runs = {side: optimize_linkage(LEVER, replace(LEVER_SEARCH, pivot_side=side)) for side in ("normal", "inverted", "both")}
        both, again = runs["both"], optimize_linkage(LEVER, replace(LEVER_SEARCH, pivot_side="both"))
        self.assertEqual(both[0], again[0])                     # same inputs, same answer
        self.assertEqual(both[3], again[3])
        report = both[3]
        self.assertEqual(set(report["sides"]), {"normal", "inverted"})
        side = report["pivot_side"]
        self.assertEqual(both[0].pivot_inverted, side == "inverted")
        # Each side within "both" is the search of that side alone, and the lower score wins.
        for name in ("normal", "inverted"):
            self.assertEqual(report["sides"][name], runs[name][3]["sides"][name])
        scores = {name: report["sides"][name]["score"] for name in ("normal", "inverted")}
        self.assertEqual(side, min(scores, key=lambda k: (scores[k] is None, scores[k] or 0.0, k != "normal")))
        self.assertEqual(both[0], runs[side][0])
        self.assertEqual(both[1], runs["normal"][1] + runs["inverted"][1])
        self.assertFalse(runs["normal"][0].pivot_inverted)
        self.assertTrue(runs["inverted"][0].pivot_inverted)
        with self.assertRaises(ValueError):
            optimize_linkage(LEVER, replace(LEVER_SEARCH, pivot_side="sideways"))

    def test_one_piece_search_handles_the_pivot_side(self):
        p = replace(PENDULUM, compliant=True, link_curved=True, pad_length=1.0)
        s = replace(PENDULUM_SEARCH, pivot_side="both")
        best, _, _, report = optimize_linkage(p, s)
        self.assertEqual(report["model"], "one-piece")
        self.assertEqual(sum(v["solved"] for v in report["sides"].values()), report["shortlist"])
        self.assertEqual(report["shortlist"], report["passed"] + sum(report["rejected"].values()))
        if best is not None:
            self.assertEqual(best.pivot_inverted, report["pivot_side"] == "inverted")
            r = compute_linkage(best)
            self.assertIsNone(r.collision_y)

    def test_old_requests_default_to_the_normal_pivot(self):
        self.assertFalse(LinkageParams().pivot_inverted)
        self.assertEqual(LinkageSearch().pivot_side, "normal")
        import os
        import sys
        import tempfile
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        os.environ.setdefault("SIM_DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
        import main
        req = main.LinkageOptimizeRequest(**{"linkage_type": "pendulum", "bar1_length": 11.95})
        self.assertFalse(main._linkage_params(req).pivot_inverted)
        self.assertEqual(req.pivot_side, "normal")
        self.assertEqual(main._linkage_params(req).assembly_clearance, 0.3)

    def test_optimize_route_passes_every_search_field(self):
        # The route builds LinkageSearch from the request's fields: one missing there is a 500.
        import os
        import sys
        import tempfile
        try:
            from fastapi.testclient import TestClient
        except Exception as exc:   # httpx missing
            self.skipTest(f"TestClient unavailable: {exc}")
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        os.environ.setdefault("SIM_DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
        import main
        client = TestClient(main.app)
        seen = []
        with mock.patch.object(main, "optimize_linkage", side_effect=lambda p, s: seen.append(s) or (None, 0, 0, {})):
            for body in (
                {"linkage_type": "lever"},
                {"linkage_type": "lever", "pivot_side": "both", "require_seal": False, "objective": "chamber", "min_flow_pct": 40.0},
            ):
                self.assertEqual(client.post("/api/linkage/optimize", json=body).status_code, 200)
        self.assertEqual(
            [(s.pivot_side, s.require_seal, s.objective, s.min_flow_pct) for s in seen],
            [("normal", True, "response", 0.0), ("both", False, "chamber", 40.0)],
        )
        self.assertEqual(client.post("/api/linkage/optimize", json={"pivot_side": "sideways"}).status_code, 422)
        self.assertEqual(client.post("/api/linkage/optimize", json={"objective": "bogus"}).status_code, 422)
        got = client.post("/api/linkage/optimize", json={"linkage_type": "elbow", "max_stroke": 5.0}).json()
        self.assertTrue(got["found"])
        self.assertEqual(got["search_report"]["pivot_side"], "normal")
        self.assertIsInstance(got["candidates"], list)
        self.assertGreater(len(got["candidates"]), 0)

    def test_derived_flow_slope_accel_and_chamber_rise_times(self):
        r = compute_linkage(PENDULUM)
        self.assertTrue(r.feasible, r.message)
        self.assertGreater(r.max_flow_reached_l_min, 0.0)
        self.assertGreater(r.max_flow_reached_pct, 0.0)
        self.assertLessEqual(r.max_flow_reached_pct, 100.1)
        self.assertIsNotNone(r.flow_slope_mean)
        self.assertGreater(r.flow_slope_mean, 0.0)
        self.assertIsNotNone(r.flow_slope_max)
        self.assertGreaterEqual(r.flow_slope_max, r.flow_slope_mean - 1e-9)
        self.assertIsNotNone(r.flow_accel_mean)
        self.assertIsNotNone(r.flow_accel_max)
        self.assertIsNotNone(r.chamber_t50_ms)
        self.assertIsNotNone(r.chamber_t90_ms)
        self.assertLessEqual(r.chamber_t50_ms, r.chamber_t90_ms + 1e-9)
        no_chamber = compute_linkage(replace(PENDULUM, chamber_volume_ml=0.0))
        self.assertIsNone(no_chamber.chamber_t50_ms)
        self.assertIsNone(no_chamber.chamber_t90_ms)

    def test_one_piece_caps_stroke_at_structural_limit_instead_of_discarding(self):
        # A high-gain one-piece pendulum that hits member_strength_mpa well before max_stroke=1.5:
        # the beam evaluator must cap usable travel cleanly below stress_limit_y instead of rejecting it.
        q = LinkageParams(
            linkage_type="pendulum", bar2_length=14.9, bar1_length=9.3, anchor_distance=-2.6,
            pivot_offset=4.0, foot_length=5.8, foot_angle_deg=72.0, tube_center_x=8.225,
            preload=0.2, fixed_height=16.0, compliant=True, link_curved=True,
            member_width=1.2, member_thickness=4.0, member_strength_mpa=40.0,
            tube_shore_a=30.0, stroke=1.5,
        )
        s = replace(PENDULUM_SEARCH, max_stroke=1.5, max_oversqueeze=1.6, anchor_min=-6.0, anchor_max=8.0)
        full = compute_linkage(q)
        self.assertIsNotNone(full.stress_limit_y)
        self.assertLess(full.stress_limit_y, s.max_stroke)
        score, travel, reason, meta = linkage._one_piece_eval(q, s, fast=False)
        self.assertIsNone(reason)
        self.assertTrue(math.isfinite(score))
        self.assertLess(travel, s.max_stroke)
        self.assertLessEqual(travel, full.stress_limit_y + 1e-9)
        self.assertEqual(meta["limiting_factor"], "stress")
        capped = compute_linkage(replace(q, stroke=travel))
        self.assertLessEqual(capped.max_stress_mpa, q.member_strength_mpa + 1e-6)
        self.assertGreater(capped.max_flow_reached_pct, 25.0)

    def test_new_objectives_min_flow_and_pareto_candidates(self):
        with self.assertRaises(ValueError):
            optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, objective="unknown"))
        for goal in ("deadband", "chamber", "progressive"):
            with self.subTest(goal=goal):
                best, feasible, _, report = optimize_linkage(PENDULUM, replace(PENDULUM_SEARCH, objective=goal))
                self.assertIsNotNone(best)
                self.assertGreater(feasible, 0)
                cands = report["candidates"]
                self.assertGreater(len(cands), 0)
                self.assertIn("Best overall", cands[0]["tags"])
                self.assertAlmostEqual(cands[0]["params"]["bar2_length"], best.bar2_length, places=6)
                self.assertAlmostEqual(cands[0]["params"]["stroke"], best.stroke, places=6)
                self.assertIsNotNone(cands[0]["metrics"]["deadband"])
                self.assertIsNotNone(cands[0]["metrics"]["max_flow_reached_pct"])
        # min_flow_pct floor rejects designs that cannot reach the requested bore percentage within tight stroke.
        tight = replace(PENDULUM_SEARCH, max_stroke=0.25, min_flow_pct=90.0)
        none_found, _, _, _ = optimize_linkage(PENDULUM, tight)
        self.assertIsNone(none_found)

    def test_unreachable_geometry_is_reported(self):
        r = compute_linkage(replace(LinkageParams(), bar2_length=1.0))
        self.assertFalse(r.feasible)
        self.assertNotEqual(r.message, "ok")


if __name__ == "__main__":
    unittest.main()
