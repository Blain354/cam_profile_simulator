"""Compliant bars: splines, fused overlap, constraints, slope ranking."""

import unittest

import numpy as np

from backend.compliant_bars import (
    CompliantConstraints, CompliantParams, admission_score, compute_compliant, handle_point,
    sample_bezier, solve_compliant, _overlap_nodes,
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
        # 5.0 mN·m motor clears the FEM operating stroke (~4.5 mN·m) and stalls before the default bar yields.
        good = compute_compliant(CompliantParams(motor_torque_mnm=5.0), fast=True)
        bad = compute_compliant(CompliantParams(motor_torque_mnm=5.0, member_strength_mpa=0.01), fast=True)
        self.assertGreater(admission_score(good), 0.0)
        self.assertLess(admission_score(bad), admission_score(good))

    def test_solver_keeps_a_fixed_shape(self):
        params = CompliantParams(motor_torque_mnm=5.0)
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

    def test_chart_series_and_pinch_ceiling_constraint(self):
        params = CompliantParams(closed_carriage_height=8.0, pinch_y=14.8)  # ceiling is 16.0 -> margin 1.2 mm
        relaxed = compute_compliant(params, fast=True, constraints=CompliantConstraints(pinch_ceiling_margin_mm=1.0))
        self.assertTrue(relaxed.pinch_ok)
        self.assertAlmostEqual(relaxed.pinch_ceiling_margin_mm, 1.2, places=3)
        self.assertEqual(len(relaxed.flow_b), len(relaxed.Y_positions))
        self.assertEqual(len(relaxed.gap_a), len(relaxed.Y_positions))
        self.assertEqual(len(relaxed.gap_b), len(relaxed.Y_positions))
        self.assertEqual(len(relaxed.stress_a), len(relaxed.Y_positions))

        strict = compute_compliant(params, fast=True, constraints=CompliantConstraints(pinch_ceiling_margin_mm=2.5))
        self.assertFalse(strict.pinch_ok)
        self.assertFalse(strict.passes)
        self.assertIn("ceiling", strict.message.lower())

    def test_solver_can_vary_context_and_respects_ceiling_margin(self):
        params = CompliantParams()
        bounds = {
            "pinch_y": (4.0, 15.5),
            "closed_carriage_height": (7.0, 10.0),
            "stroke": (1.2, 2.0),
        }
        constraints = CompliantConstraints(pinch_ceiling_margin_mm=3.0, pinch_floor_margin_mm=2.0)
        out = solve_compliant(params, bounds, budget=12, seed=42, constraints=constraints, pivot_side="both")
        self.assertGreaterEqual(out["tested"], 12)
        if out["found"]:
            p = out["params"]
            ceiling = 2.0 * p["closed_carriage_height"]
            self.assertGreaterEqual(ceiling - p["pinch_y"], 3.0 - 1e-6)
            self.assertGreaterEqual(p["pinch_y"], 2.0 - 1e-6)

    def test_chamber_cycle_and_dx_at_025_metrics(self):
        params = CompliantParams(chamber_volume_ml=10.0)
        res = compute_compliant(params, fast=False)
        self.assertIsNotNone(res.dx_at_025_mm)
        self.assertIsNotNone(res.kinematic_gain)
        self.assertGreater(len(res.time_ms), 10)
        self.assertEqual(len(res.chamber_kpa), len(res.time_ms))
        self.assertEqual(len(res.flow_in_l_min), len(res.time_ms))
        self.assertEqual(len(res.flow_out_l_min), len(res.time_ms))
        self.assertGreater(max(res.chamber_kpa), 0.0)
        # 0 -> 100 % inflation time (99 % equalization convention) and derived pass frequency / -3 dB bandwidth
        self.assertIsNotNone(res.chamber_t100_ms)
        self.assertGreater(res.chamber_t100_ms, res.chamber_t90_ms)
        self.assertIsNotNone(res.chamber_cycle_freq_hz)
        self.assertIsNotNone(res.chamber_bandwidth_hz)
        t_sec = res.chamber_t100_ms / 1000.0
        self.assertAlmostEqual(res.chamber_cycle_freq_hz, 1.0 / (2.0 * t_sec), places=6)
        self.assertAlmostEqual(res.chamber_bandwidth_hz, 0.35 / t_sec, places=6)

        # Fast mode also computes the 0 -> 100 % inflation estimate and frequencies for solver runners
        res_fast = compute_compliant(params, fast=True)
        self.assertIsNotNone(res_fast.chamber_t100_ms)
        self.assertIsNotNone(res_fast.chamber_cycle_freq_hz)
        self.assertIsNotNone(res_fast.chamber_bandwidth_hz)

    def test_time_budgeted_solver_and_experiment_storage(self):
        import tempfile
        from pathlib import Path
        from backend.compliant_solver import CompliantSolveJobManager, run_time_budgeted_solve
        from backend.storage import CompliantExperimentStorage

        params = CompliantParams()
        bounds = {
            "anchor_distance": (3.5, 6.0),
            "junction_x": (-7.0, -4.0),
            "junction_y": (10.0, 14.0),
            "pinch_y": (8.0, 12.5),
            "l_thickness": (0.7, 1.3),
        }
        out = run_time_budgeted_solve(
            params,
            bounds,
            time_budget_s=0.8,
            goal="dx_at_025",
            constraints=CompliantConstraints(pinch_ceiling_margin_mm=2.0, pinch_floor_margin_mm=1.0),
            seed=7,
        )
        self.assertGreater(out["tested"], 5)
        self.assertIn("summary", out)
        self.assertIn("rejection_stats", out["summary"])
        self.assertIn("coverage", out["summary"])
        self.assertEqual(len(out["summary"]["free_vars"]), 5)

        with tempfile.TemporaryDirectory() as tmp:
            store = CompliantExperimentStorage(Path(tmp) / "test.db")
            mgr = CompliantSolveJobManager(store)
            job = mgr.start_job(
                params_dict=params.__dict__,
                bounds=bounds,
                constraints_dict={"pinch_ceiling_margin_mm": 2.0, "pinch_floor_margin_mm": 1.0},
                pivot_side="current",
                goal="min_open_stroke",
                time_budget_s=0.6,
                name="Test Run",
                note="unit test",
            )
            import time
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                state = mgr.get_job(job["job_id"])
                if state and state["status"] != "running":
                    break
                time.sleep(0.05)
            final = mgr.get_job(job["job_id"])
            self.assertEqual(final["status"], "completed")
            exps = store.list_experiments()
            self.assertEqual(len(exps), 1)
            self.assertEqual(exps[0]["name"], "Test Run")
            self.assertTrue(store.update_meta(job["job_id"], name="Renamed Run", note="updated"))
            loaded = store.get_experiment(job["job_id"])
            self.assertEqual(loaded["name"], "Renamed Run")
            self.assertEqual(loaded["note"], "updated")
            self.assertTrue(store.delete_experiment(job["job_id"]))
            self.assertEqual(store.list_experiments(), [])


    def test_junction_forbidden_zone_rejects_deadband(self):
        params = CompliantParams(junction_x=0.5, junction_y=8.0)
        cons = CompliantConstraints(junction_exclude_x=(-2.0, 2.0))
        res = compute_compliant(params, fast=True, constraints=cons)
        self.assertFalse(res.junction_ok)
        self.assertFalse(res.passes)
        self.assertIn("forbidden", res.message.lower())

        outside = compute_compliant(CompliantParams(junction_x=-5.5, junction_y=12.0), fast=True, constraints=cons)
        self.assertTrue(outside.junction_ok)

    def test_seal_at_y0_is_enforced_as_hard_constraint(self):
        # Even for a very soft bar, the fixed Y=0 pinch constraint keeps gap_y0_mm locked to closed_gap - preload,
        # while max_y0_flex_mm catches excessive pre-flex required to hold that position.
        soft = CompliantParams(member_modulus_mpa=150.0, preload=0.02, l_thickness=0.4, r_thickness=0.4, f_thickness=0.4)
        res_locked = compute_compliant(soft, fast=True)
        self.assertAlmostEqual(res_locked.gap_y0_mm, res_locked.closed_gap - soft.preload, places=5)
        self.assertTrue(res_locked.sealed_at_y0)

        res_capped = compute_compliant(soft, fast=True, constraints=CompliantConstraints(max_y0_flex_mm=0.05))
        self.assertFalse(res_capped.sealed_at_y0)
        self.assertFalse(res_capped.passes)
        self.assertIn("y = 0", res_capped.message.lower())

    def test_pinch_x_at_y0_is_fixed_independent_of_node_configuration(self):
        # Regardless of how nodes/handles/thicknesses/modulus are dragged, at carriage Y = 0
        # the foot contact X from the wall equals the precalculated FEM (closed_gap - preload),
        # while pinch_y stays as configured.
        base = CompliantParams(preload=0.12, pinch_y=11.2, input_pressure_kpa=100.0, tube_shore_a=50.0)
        base_res = compute_compliant(base, fast=True)
        expected_gap_y0 = base_res.closed_gap - base.preload
        expected_contact_x = expected_gap_y0 - base_res.wall_x

        variants = [
            base,
            CompliantParams(anchor_distance=2.0, junction_x=-3.0, junction_y=9.5, preload=0.12, pinch_y=11.2),
            CompliantParams(anchor_distance=7.2, junction_x=-6.8, junction_y=14.0, l_v1=2.2, r_v2=-1.8, preload=0.12, pinch_y=11.2),
            CompliantParams(f_thickness=0.5, l_thickness=0.6, r_thickness=0.6, member_modulus_mpa=400.0, preload=0.12, pinch_y=11.2),
            CompliantParams(f_thickness=1.8, preload=0.12, pinch_y=7.4),
        ]
        for p in variants:
            res = compute_compliant(p, fast=True)
            mid = len(res.Y_positions) // 2
            self.assertAlmostEqual(res.Y_positions[mid], 0.0, places=9)
            self.assertAlmostEqual(res.pinch_contact_x, expected_contact_x, places=6)
            self.assertAlmostEqual(res.gap_y0_mm, expected_gap_y0, places=6)
            self.assertAlmostEqual(res.gap_a[mid], expected_gap_y0, places=6)
            self.assertAlmostEqual(res.gap_b[mid], expected_gap_y0, places=6)
            self.assertAlmostEqual(res.lines["f"]["x"][-1] - p.f_thickness / 2.0, expected_contact_x, places=6)
            self.assertAlmostEqual(res.lines["f"]["force_y0"], res.force_a[mid], places=6)
            self.assertAlmostEqual(res.pinch[1], p.pinch_y, places=6)

        # Changing FEM pressure or preload updates the fixed Pinch_x accordingly.
        higher_p = compute_compliant(CompliantParams(preload=0.12, pinch_y=11.2, input_pressure_kpa=180.0), fast=True)
        self.assertNotAlmostEqual(higher_p.pinch_contact_x, expected_contact_x, places=3)
        self.assertAlmostEqual(higher_p.gap_y0_mm, higher_p.closed_gap - 0.12, places=6)

        more_preload = compute_compliant(CompliantParams(preload=0.25, pinch_y=11.2, input_pressure_kpa=100.0), fast=True)
        self.assertAlmostEqual(more_preload.pinch_contact_x, expected_contact_x - 0.13, places=6)
        self.assertAlmostEqual(more_preload.gap_y0_mm, base_res.closed_gap - 0.25, places=6)

    def test_attack_angle_and_trajectory_target_goal(self):
        from backend.compliant_bars import admission_score
        params = CompliantParams(motor_torque_mnm=5.0)
        res = compute_compliant(params, fast=True)
        self.assertIsNotNone(res.attack_angle_deg)
        self.assertGreaterEqual(res.attack_angle_deg, -90.0)
        self.assertLessEqual(res.attack_angle_deg, 90.0)
        # Exact match to current pinch_from_top & attack_angle scores higher than a mismatched target.
        exact_c = CompliantConstraints(
            target_pinch_from_top_mm=res.pinch_ceiling_margin_mm,
            target_attack_angle_deg=res.attack_angle_deg,
        )
        far_c = CompliantConstraints(
            target_pinch_from_top_mm=1.0,
            target_attack_angle_deg=-75.0,
        )
        self.assertGreater(
            admission_score(res, exact_c, goal="trajectory_target"),
            admission_score(res, far_c, goal="trajectory_target"),
        )

    def test_shell_clearance_catches_negative_stroke_collision(self):
        # Exact counter-example from the math audit: passes at Y=0 and Y=+stroke, but collides at Y=-stroke.
        p = CompliantParams(
            r_thickness=0.9, l_thickness=0.9, r_v1=7.5, r_v2=7.5,
            stroke=1.0, preload=0.20, member_modulus_mpa=3500.0, member_strength_mpa=50.0,
        )
        res = compute_compliant(p, fast=True)
        self.assertFalse(res.shell_ok)
        self.assertFalse(res.passes)
        self.assertLess(res.shell_clearance_mm, 0.0)
        self.assertIn("closed (-stroke)", res.message)

    def test_multi_goal_weighted_scoring(self):
        from backend.compliant_bars import admission_score, normalize_goal_weights
        w = normalize_goal_weights("dx_at_025", {"dx_at_025": 70, "trajectory_target": 30})
        self.assertAlmostEqual(w["dx_at_025"], 0.7, places=6)
        self.assertAlmostEqual(w["trajectory_target"], 0.3, places=6)
        res = compute_compliant(CompliantParams(motor_torque_mnm=5.0), fast=True)
        sc = admission_score(res, CompliantConstraints(target_pinch_from_top_mm=5.5, target_attack_angle_deg=0.0), goal_weights=w)
        self.assertTrue(sc > 0.0)

    def test_member_lr_tube_clearance_rejects_tube_collision(self):
        # Curve Member L far left into Tube A (like the user screenshot) -> must fail tube_ok & passes!
        bad = CompliantParams(l_v1=4.0, l_v2=4.0)
        cons = CompliantConstraints(min_tube_clearance_mm=0.5)
        res = compute_compliant(bad, fast=True, constraints=cons)
        self.assertFalse(res.tube_ok)
        self.assertFalse(res.passes)
        self.assertLess(res.tube_clearance_mm, 0.5)
        self.assertIn("tube", res.message.lower())

    def test_pinch_locked_to_goal_and_contact_aligned_across_foot_thicknesses(self):
        from backend.compliant_solver import run_time_budgeted_solve

        target_from_top = 4.5
        cons = CompliantConstraints(target_pinch_from_top_mm=target_from_top)
        contact_xs = []
        for f_th in (0.5, 1.0, 2.0):
            # Pass an intentionally mismatched pinch_y to verify compute_compliant locks P to P_goal.
            p = CompliantParams(f_thickness=f_th, pinch_y=9.0, closed_carriage_height=8.0)
            res = compute_compliant(p, fast=True, constraints=cons)
            y_goal = 2.0 * p.closed_carriage_height - target_from_top
            x_goal_contact = -res.wall_x + (res.closed_gap - p.preload)

            self.assertAlmostEqual(res.pinch[1], y_goal, places=6)
            self.assertAlmostEqual(res.lines["f"]["y"][-1], y_goal, places=6)
            self.assertAlmostEqual(res.pinch_ceiling_margin_mm, target_from_top, places=6)

            # Real contact surface (foot tip center minus f_thickness / 2) must stay aligned on x_goal_contact.
            x_contact = res.pinch_x - f_th / 2.0
            self.assertAlmostEqual(res.pinch_contact_x, x_goal_contact, places=6)
            self.assertAlmostEqual(x_contact, x_goal_contact, places=6)
            self.assertAlmostEqual(res.lines["f"]["x"][-1] - f_th / 2.0, x_goal_contact, places=6)
            contact_xs.append(x_contact)

        # Contact X is invariant to f_thickness (0.5 vs 2.0 mm).
        self.assertAlmostEqual(contact_xs[0], contact_xs[1], places=6)
        self.assertAlmostEqual(contact_xs[0], contact_xs[2], places=6)

        # Solver must lock pinch_y to 2*h0 - target_pinch_from_top_mm even when h0 and f_thickness vary.
        base = CompliantParams(closed_carriage_height=8.0, pinch_y=9.0)
        bounds = {
            "pinch_y": (4.0, 14.0),
            "closed_carriage_height": (7.5, 9.5),
            "f_thickness": (0.6, 1.8),
            "junction_x": (-6.5, -4.5),
        }
        out = run_time_budgeted_solve(
            base,
            bounds,
            time_budget_s=0.6,
            goal="dx_at_025",
            constraints=CompliantConstraints(
                target_pinch_from_top_mm=5.5,
                pinch_ceiling_margin_mm=2.0,
                pinch_floor_margin_mm=1.0,
            ),
            seed=11,
        )
        self.assertNotIn("pinch_y", out["summary"]["free_vars"])
        self.assertIn("pinch_y", out["summary"]["fixed_vars"])
        if out["found"]:
            wp = out["params"]
            wr = out["result"]
            expected_y = 2.0 * wp["closed_carriage_height"] - 5.5
            self.assertAlmostEqual(wp["pinch_y"], expected_y, places=6)
            self.assertAlmostEqual(wr["pinch"][1], expected_y, places=6)
            self.assertAlmostEqual(
                wr["pinch_x"] - wp["f_thickness"] / 2.0,
                -wr["wall_x"] + (wr["closed_gap"] - wp["preload"]),
                places=6,
            )


    def test_all_search_methods_and_pivot_side_coverage(self):
        from backend.compliant_solver import SOLVER_METHODS, run_time_budgeted_solve
        params = CompliantParams()
        bounds = {"anchor_distance": (3.5, 6.0), "junction_x": (-7.0, -4.0), "l_thickness": (0.8, 1.2)}
        for method in SOLVER_METHODS:
            out = run_time_budgeted_solve(
                params,
                bounds,
                time_budget_s=0.5,
                method=method,
                pivot_side="both",
                seed=3,
            )
            self.assertEqual(out["summary"]["method"], method)
            self.assertGreater(out["tested"], 2)
            self.assertIn("pivot_inverted", out["summary"]["free_vars"])
            cov_keys = [c["key"] for c in out["summary"]["coverage"]]
            self.assertIn("pivot_inverted", cov_keys)

    def test_tight_y0_gap_flex_constraint(self):
        # Default has ~0.009 mm flex at Y=0 -> passes 0.05 mm cap, fails 0.002 mm cap.
        p = CompliantParams()
        ok = compute_compliant(p, fast=True, constraints=CompliantConstraints(max_y0_flex_mm=0.05))
        self.assertTrue(ok.sealed_at_y0)
        self.assertIsNotNone(ok.flex_y0_mm)
        strict = compute_compliant(p, fast=True, constraints=CompliantConstraints(max_y0_flex_mm=0.002))
        self.assertFalse(strict.sealed_at_y0)
        self.assertFalse(strict.passes)
        self.assertIn("flex", strict.message.lower())

    def test_brute_force_exact_cartesian_grid_completes_all_nodes(self):
        from backend.compliant_solver import run_time_budgeted_solve
        p = CompliantParams()
        # 3 free dims with k = 2 steps -> 2^3 = 8 grid points + 1 starting point = 9 total evals
        bounds = {"anchor_distance": (4.0, 5.5), "junction_x": (-6.0, -5.0), "l_thickness": (0.9, 1.1)}
        out = run_time_budgeted_solve(
            p,
            bounds,
            time_budget_s=5.0,
            method="brute_force",
            method_params={"sampling": "grid", "steps_per_var": 2},
            pivot_side="current",
            seed=1,
        )
        self.assertEqual(out["tested"], 9)

    def test_solver_emits_preview_frames_and_curated_timeline(self):
        from backend.compliant_solver import run_time_budgeted_solve

        p = CompliantParams()
        bounds = {
            "anchor_distance": (3.5, 6.5),
            "junction_x": (-7.5, -3.5),
            "l_v1": (-3.0, 3.0),
            "l_thickness": (0.7, 1.3),
        }
        progress_snaps = []
        out = run_time_budgeted_solve(
            p,
            bounds,
            time_budget_s=0.6,
            method="hybrid",
            seed=7,
            on_progress=lambda snap: progress_snaps.append(snap),
        )
        self.assertGreater(len(progress_snaps), 0)
        self.assertIn("preview_frames", progress_snaps[0])
        self.assertGreater(len(progress_snaps[0]["preview_frames"]), 0)

        summary = out["summary"]
        timeline = summary.get("preview_timeline")
        self.assertIsInstance(timeline, list)
        self.assertGreater(len(timeline), 0)
        # Strictly increasing evaluation index n
        ns = [f["n"] for f in timeline]
        self.assertEqual(ns, sorted(set(ns)))
        # Every frame carries compact Bezier geometry
        for f in timeline:
            self.assertEqual(len(f["a"]), 2)
            self.assertEqual(len(f["j"]), 2)
            self.assertEqual(len(f["v"]), 2)
            self.assertEqual(len(f["p"]), 2)
            self.assertEqual(len(f["hl"]), 4)
            self.assertEqual(len(f["hr"]), 4)
            self.assertEqual(len(f["hf"]), 4)
            self.assertEqual(len(f["th"]), 3)
            if f["ok"]:
                self.assertIsNone(f["reason"])
            else:
                self.assertIsNotNone(f["reason"])
        if out["found"]:
            self.assertIsNotNone(summary.get("best_preview"))
            self.assertTrue(any(f["best"] for f in timeline))


    def test_anchor_contour_is_tangent_to_bottom_surface(self):
        from backend.compliant_bars import _empty
        from backend.compliant_solver import _make_preview_frame

        for thickness in (0.6, 1.0, 1.8):
            params = CompliantParams(anchor_distance=4.8, l_thickness=thickness)
            res = compute_compliant(params, fast=True)
            self.assertAlmostEqual(res.anchor[0], -4.8, places=6)
            self.assertAlmostEqual(res.anchor[1], thickness / 2.0, places=6)
            self.assertAlmostEqual(res.lines["l"]["y"][0] - thickness / 2.0, 0.0, places=6)
            fallback = _make_preview_frame(1, 0.0, params, _empty("err"), -1.0, False, "err")
            self.assertAlmostEqual(fallback["a"][1], round(thickness / 2.0, 2), places=6)

    def test_stress_limit_factor_filters_above_scaled_strength(self):
        base = CompliantParams()
        ref = compute_compliant(base, fast=True)
        self.assertTrue(ref.max_stress_mpa is not None and ref.max_stress_mpa > 0.0)
        # Set material strength just above peak stress so 1.0 passes, but 0.85 rejects.
        tight = CompliantParams(member_strength_mpa=ref.max_stress_mpa / 0.90)
        ok_full = compute_compliant(tight, fast=True, constraints=CompliantConstraints(stress_limit_factor=1.0))
        rej_85 = compute_compliant(tight, fast=True, constraints=CompliantConstraints(stress_limit_factor=0.85))
        self.assertTrue(ok_full.plastic_ok)
        self.assertFalse(rej_85.plastic_ok)
        self.assertFalse(rej_85.passes)
        self.assertIn("85%", rej_85.message)

    def test_crossing_members_are_rejected(self):
        from backend.compliant_solver import _classify_rejections

        # Default non-crossing shape must pass crossing_ok.
        ok = compute_compliant(CompliantParams(), fast=True)
        self.assertTrue(ok.crossing_ok)

        # Anchor on the far right (anchor_distance = -5.5 -> x = +5.5), junction on the left,
        # pivot on the right above anchor, with L bowing up across R -> L and R clearly cross.
        crossed = CompliantParams(
            anchor_distance=-1.0,
            junction_x=-4.0,
            junction_y=12.0,
            pinch_y=10.5,
            l_u1=0.35, l_v1=-5.0, l_u2=0.65, l_v2=-5.0,
            r_u1=0.35, r_v1=-2.0, r_u2=0.65, r_v2=-2.0,
        )
        res = compute_compliant(crossed, fast=True)
        self.assertFalse(res.crossing_ok)
        self.assertFalse(res.passes)
        self.assertIn("cross", res.message.lower())
        self.assertIn("crossing", _classify_rejections(res))

    def test_anchor_symmetric_samples_both_sides_and_skips_center_gap(self):
        from backend.compliant_bars import anchor_symmetric_range, anchor_val_to_z, anchor_z_to_val
        from backend.compliant_solver import run_time_budgeted_solve

        # Helper round-trip on [2.5, 5.8] -> [-5.8, -2.5] U [2.5, 5.8]
        a_lo, a_hi = anchor_symmetric_range(2.5, 5.8)
        self.assertAlmostEqual(a_lo, 2.5)
        self.assertAlmostEqual(a_hi, 5.8)
        self.assertAlmostEqual(anchor_z_to_val(0.0, a_lo, a_hi), -5.8)
        self.assertAlmostEqual(anchor_z_to_val(0.5, a_lo, a_hi), 2.5)
        self.assertAlmostEqual(anchor_z_to_val(1.0, a_lo, a_hi), 5.8)
        for v in (-5.8, -4.15, -2.5, 2.5, 4.15, 5.8):
            z = anchor_val_to_z(v, a_lo, a_hi)
            self.assertAlmostEqual(anchor_z_to_val(z, a_lo, a_hi), v, places=5)

        # Brute-force LHS with anchor_symmetric=True must sample both sides and never land in (-2.5, 2.5).
        seen_anchors = []
        base = CompliantParams(anchor_distance=4.8)
        bounds = {"anchor_distance": (2.5, 5.8)}
        cons = CompliantConstraints(anchor_symmetric=True)
        out = run_time_budgeted_solve(
            base,
            bounds,
            time_budget_s=0.6,
            method="brute_force",
            method_params={"sampling": "lhs", "target_evals": 40},
            constraints=cons,
            seed=13,
        )
        summary = out["summary"]
        self.assertIn("anchor_distance", summary["free_vars"])
        self.assertTrue(summary["active_constraints"]["anchor_symmetric"])
        cov = next(c for c in summary["coverage"] if c["key"] == "anchor_distance")
        self.assertAlmostEqual(cov["lo"], -5.8, places=3)
        self.assertAlmostEqual(cov["hi"], 5.8, places=3)
        # Both negative half (bins 0..4) and positive half (bins 5..9) must be tested.
        self.assertGreater(sum(cov["tested_bins"][:5]), 0)
        self.assertGreater(sum(cov["tested_bins"][5:]), 0)
        # Every preview frame's anchor x must satisfy |x| in [2.5, 5.8].
        for fr in summary.get("preview_timeline", []):
            ax = abs(float(fr["a"][0]))
            seen_anchors.append(float(fr["a"][0]))
            self.assertGreaterEqual(ax, 2.5 - 0.02)
            self.assertLessEqual(ax, 5.8 + 0.02)
        self.assertTrue(any(x < 0 for x in seen_anchors))
        self.assertTrue(any(x > 0 for x in seen_anchors))

    def test_pass_freq_bw_goal_scoring_and_solve(self):
        from dataclasses import replace
        from backend.compliant_bars import SOLVER_GOALS, admission_score, normalize_goal_weights
        from backend.compliant_solver import run_time_budgeted_solve

        self.assertIn("pass_freq_bw", SOLVER_GOALS)

        res = compute_compliant(CompliantParams(motor_torque_mnm=5.0), fast=True)
        self.assertTrue(res.passes)
        self.assertIsNotNone(res.chamber_cycle_freq_hz)

        faster = replace(res, chamber_cycle_freq_hz=2.5, chamber_bandwidth_hz=1.75)
        slower = replace(res, chamber_cycle_freq_hz=0.8, chamber_bandwidth_hz=0.56)
        unfilled = replace(res, chamber_cycle_freq_hz=None, chamber_bandwidth_hz=None)

        s_fast = admission_score(faster, goal="pass_freq_bw")
        s_slow = admission_score(slower, goal="pass_freq_bw")
        s_none = admission_score(unfilled, goal="pass_freq_bw")
        self.assertGreater(s_fast, s_slow)
        self.assertGreater(s_slow, s_none)

        w = normalize_goal_weights("pass_freq_bw", {"pass_freq_bw": 60, "dx_at_025": 40})
        self.assertAlmostEqual(w["pass_freq_bw"], 0.6, places=6)
        self.assertAlmostEqual(w["dx_at_025"], 0.4, places=6)
        self.assertGreater(
            admission_score(faster, goal_weights=w),
            admission_score(slower, goal_weights=w),
        )

        out = run_time_budgeted_solve(
            CompliantParams(motor_torque_mnm=4.0),
            {"junction_x": (-6.5, -4.5), "l_thickness": (0.85, 1.15)},
            time_budget_s=0.6,
            goal="pass_freq_bw",
            seed=7,
        )
        self.assertEqual(out["summary"]["goal_weights"], {"pass_freq_bw": 1.0})
        self.assertGreater(out["tested"], 0)
        if out["found"]:
            self.assertIsNotNone(out["summary"]["best_chamber_cycle_freq_hz"])
            self.assertIsNotNone(out["summary"]["best_chamber_bandwidth_hz"])

    def test_vertical_screw_thrust_and_actuation_energy(self):
        p = CompliantParams(stroke=1.0, motor_torque_mnm=30.0)
        res = compute_compliant(p, fast=False)
        self.assertEqual(len(res.thrust), len(res.Y_positions))
        # Twin mechanism thrust is 0 at Y = 0 and symmetric in |Y|.
        mid = len(res.Y_positions) // 2
        self.assertAlmostEqual(res.Y_positions[mid], 0.0, places=6)
        self.assertAlmostEqual(res.thrust[mid], 0.0, places=6)
        self.assertAlmostEqual(res.thrust[0], res.thrust[-1], places=5)
        self.assertGreater(res.peak_thrust_op_n, 0.0)
        self.assertGreater(res.peak_torque_op_mnm, 0.0)
        self.assertGreater(res.thrust_available_n, 50.0)
        self.assertTrue(res.screw_self_locking)
        # Full cycle energy (raise + lower on both sides) exceeds single-stroke raise work.
        self.assertGreater(res.energy_stroke_mj, 0.0)
        self.assertGreater(res.energy_cycle_mj, 2.0 * res.energy_stroke_mj)
        # Over-travel series extends past operating stroke for force/stress plotting.
        self.assertGreater(len(res.overtravel_y), len(res.Y_positions))
        self.assertGreater(max(res.overtravel_y), p.stroke)

    def test_motor_limited_stress_stall_before_yield_in_and_out_of_stroke(self):
        from backend.compliant_solver import _classify_rejections

        # Case A: Stall-safe stiff design (no stall in ±1.0 mm, stalls at ~±1.49 mm BEFORE yielding at ~±1.57 mm).
        stiff_ok = CompliantParams(
            stroke=1.0, l_thickness=2.6, r_thickness=2.6, f_thickness=1.6,
            junction_x=-4.2, junction_y=12.5, motor_torque_mnm=30.0,
        )
        res_ok = compute_compliant(stiff_ok, fast=False)
        self.assertTrue(res_ok.passes, res_ok.message)
        self.assertTrue(res_ok.plastic_ok)
        self.assertTrue(res_ok.motor_ok)
        self.assertIsNotNone(res_ok.stall_y_mm)
        self.assertIsNotNone(res_ok.yield_y_mm)
        self.assertGreaterEqual(res_ok.stall_y_mm, stiff_ok.stroke)
        self.assertLess(res_ok.stall_y_mm, res_ok.yield_y_mm)
        self.assertLessEqual(res_ok.max_stress_to_stall_mpa, stiff_ok.member_strength_mpa)

        # Case B: Flimsy design safe inside ±1.0 mm (19 MPa), but yields at ±2.58 mm (10.4 N) before 30 mN·m (54.1 N) stalls.
        flimsy = CompliantParams(stroke=1.0, motor_torque_mnm=30.0)
        res_flimsy = compute_compliant(flimsy, fast=False)
        self.assertLess(res_flimsy.max_stress_op_mpa, flimsy.member_strength_mpa)
        self.assertTrue(res_flimsy.motor_ok)
        self.assertFalse(res_flimsy.plastic_ok)
        self.assertFalse(res_flimsy.passes)
        self.assertIn("before motor stalls", res_flimsy.message.lower())
        # Turning off motor_limited_stress restores infinite-torque operating-zone-only check.
        res_inf = compute_compliant(flimsy, fast=True, constraints=CompliantConstraints(motor_limited_stress=False))
        self.assertTrue(res_inf.plastic_ok)

        # Case C: High-gain stiff design fails infinite-torque stress inside ±1.5 mm, but motor stalls BEFORE yielding!
        stiff_rescued = CompliantParams(
            stroke=1.5, l_thickness=2.8, r_thickness=2.8, f_thickness=1.6,
            junction_x=-4.2, junction_y=12.5, motor_torque_mnm=25.0,
        )
        res_inf_fail = compute_compliant(stiff_rescued, fast=True, constraints=CompliantConstraints(motor_limited_stress=False))
        self.assertFalse(res_inf_fail.plastic_ok)
        # Under motor-limited stress, stress stops at stall (~53 MPa < 75 MPa) -> plastic_ok is rescued!
        res_strict_motor = compute_compliant(
            stiff_rescued, fast=True,
            constraints=CompliantConstraints(motor_limited_stress=True, require_no_stall_in_stroke=True),
        )
        self.assertTrue(res_strict_motor.plastic_ok)
        self.assertFalse(res_strict_motor.motor_ok)
        self.assertFalse(res_strict_motor.passes)
        self.assertIn("motor_stall", _classify_rejections(res_strict_motor))
        # Allowing stall in stroke lets the rescued design pass completely.
        res_allow_stall = compute_compliant(
            stiff_rescued, fast=True,
            constraints=CompliantConstraints(motor_limited_stress=True, require_no_stall_in_stroke=False),
        )
        self.assertTrue(res_allow_stall.plastic_ok)
        self.assertTrue(res_allow_stall.motor_ok)
        self.assertTrue(res_allow_stall.passes, res_allow_stall.message)

    def test_min_energy_goal_scoring_and_solver(self):
        from dataclasses import replace
        from backend.compliant_bars import SOLVER_GOALS, admission_score, normalize_goal_weights
        from backend.compliant_solver import run_time_budgeted_solve

        self.assertIn("min_energy", SOLVER_GOALS)

        base = CompliantParams(
            stroke=1.0, l_thickness=2.6, r_thickness=2.6, f_thickness=1.6,
            junction_x=-4.2, junction_y=12.5, motor_torque_mnm=30.0,
        )
        res = compute_compliant(base, fast=True)
        self.assertTrue(res.passes, res.message)

        low_e = replace(res, energy_cycle_mj=60.0)
        high_e = replace(res, energy_cycle_mj=450.0)
        stalled_e = replace(res, energy_cycle_mj=60.0, peak_thrust_op_n=80.0, thrust_available_n=54.0)

        self.assertGreater(
            admission_score(low_e, goal="min_energy"),
            admission_score(high_e, goal="min_energy"),
        )
        self.assertGreater(
            admission_score(low_e, goal="min_energy"),
            admission_score(stalled_e, goal="min_energy"),
        )

        w = normalize_goal_weights("min_energy", {"min_energy": 75, "dx_at_025": 25})
        self.assertAlmostEqual(w["min_energy"], 0.75, places=6)
        self.assertAlmostEqual(w["dx_at_025"], 0.25, places=6)

        out = run_time_budgeted_solve(
            base,
            {"junction_x": (-5.5, -3.5), "l_thickness": (2.2, 2.9), "r_thickness": (2.2, 2.9)},
            time_budget_s=0.7,
            goal="min_energy",
            seed=19,
        )
        summary = out["summary"]
        self.assertEqual(summary["goal"], "min_energy")
        self.assertEqual(summary["goal_weights"], {"min_energy": 1.0})
        self.assertTrue(out["found"], out["message"])
        self.assertIsNotNone(summary["best_energy_cycle_mj"])
        self.assertIsNotNone(summary["best_peak_thrust_op_n"])
        self.assertIsNotNone(summary["best_peak_torque_op_mnm"])
        self.assertTrue(summary["active_constraints"]["motor_limited_stress"])
        self.assertFalse(summary["active_constraints"]["require_no_stall_in_stroke"])
        self.assertAlmostEqual(summary["active_constraints"]["motor_torque_mnm"], 30.0, places=2)
        rej_keys = {r["key"] for r in summary["rejection_stats"]}
        self.assertIn("motor_stall", rej_keys)

    def test_motor_stall_caps_reachable_stroke_and_performance_without_hard_reject(self):
        # Default constraints do NOT hard-reject stall inside ±stroke; instead, stall physically caps
        # carriage travel to ±effective_stroke_mm, limiting max flow, dx_at_025, and chamber frequency,
        # while early stall increases energy (holding stall torque across the stalled remainder).
        strong_motor = compute_compliant(CompliantParams(motor_torque_mnm=8.0, stroke=1.5, chamber_volume_ml=100.0), fast=False)
        weak_motor = compute_compliant(CompliantParams(motor_torque_mnm=1.0, stroke=1.5, chamber_volume_ml=100.0), fast=False)
        self.assertTrue(strong_motor.motor_ok)
        self.assertTrue(weak_motor.motor_ok)  # Not hard-rejected by default
        self.assertIsNotNone(weak_motor.stall_y_mm)
        self.assertLess(weak_motor.effective_stroke_mm, 1.5)
        self.assertAlmostEqual(weak_motor.effective_stroke_mm, weak_motor.stall_y_mm, places=6)
        self.assertGreater(strong_motor.max_flow_l_min, weak_motor.max_flow_l_min)
        self.assertGreater(strong_motor.max_flow_frac, weak_motor.max_flow_frac)
        self.assertIsNotNone(strong_motor.chamber_cycle_freq_hz)
        self.assertTrue(
            weak_motor.chamber_cycle_freq_hz is None
            or strong_motor.chamber_cycle_freq_hz > weak_motor.chamber_cycle_freq_hz
        )
        # Optional hard rejection still works when explicitly enabled.
        strict = compute_compliant(
            CompliantParams(motor_torque_mnm=1.0, stroke=1.5),
            fast=True,
            constraints=CompliantConstraints(require_no_stall_in_stroke=True),
        )
        self.assertFalse(strict.motor_ok)
        self.assertFalse(strict.passes)

    def test_motor_stall_before_airflow_is_rejected(self):
        from backend.compliant_solver import _classify_rejections, run_time_budgeted_solve

        # Stiff bar with weak motor stalls at ~±0.08 mm while the tube is still pinched shut (0% flow, no bandwidth).
        stalled_no_flow = CompliantParams(
            stroke=1.5, l_thickness=2.8, r_thickness=2.8, f_thickness=1.6,
            junction_x=-4.2, junction_y=12.5, motor_torque_mnm=2.0,
        )
        res = compute_compliant(stalled_no_flow, fast=False)
        self.assertTrue(res.feasible)
        self.assertTrue(res.plastic_ok)
        self.assertTrue(res.motor_ok)
        self.assertFalse(res.flow_ok)
        self.assertFalse(res.passes)
        self.assertEqual(res.max_flow_l_min, 0.0)
        self.assertIsNone(res.chamber_bandwidth_hz)
        self.assertIn("before air flows", res.message.lower())
        self.assertIn("stall_no_flow", _classify_rejections(res))
        self.assertLess(admission_score(res), -1.0e6)

        # Solver must never accept a stall-before-airflow design as valid and must record stall_no_flow rejections.
        out = run_time_budgeted_solve(
            stalled_no_flow,
            {"l_thickness": (2.4, 3.0), "r_thickness": (2.4, 3.0)},
            time_budget_s=0.6,
            goal="pass_freq_bw",
            seed=5,
        )
        self.assertFalse(out["found"])
        self.assertEqual(out["feasible"], 0)
        rej = {r["key"]: r["count"] for r in out["summary"]["rejection_stats"]}
        self.assertGreater(rej.get("stall_no_flow", 0), 0)
        for runner in out["runners"]:
            self.assertGreaterEqual(runner["max_flow_frac"] or 0.0, 0.02 - 1e-9)


if __name__ == "__main__":
    unittest.main()
