"""Geometry and pneumatic regression checks: python -m unittest discover -s backend/tests."""

import unittest
from dataclasses import replace

import numpy as np

from backend.simulation import (
    AXIS_BUSHING_PLAY_MM,
    SimulationParams,
    SolverParams,
    _profile_distances_at_y,
    compute_simulation,
    solve_cam_profile,
)


class ClosureRampTests(unittest.TestCase):
    def test_ramp_endpoints_tangency_and_unchanged_opening_curve(self):
        for distance in (0.01, 0.35, 2.0):
            with self.subTest(default_distance=distance):
                params = SimulationParams(default_distance=distance, ramp_enabled=True)
                result = compute_simulation(params)
                x, y = np.array(result.cam_X), np.array(result.cam_Y)
                ramp = y <= result.ramp_join_Y
                rx, ry = x[ramp], y[ramp]
                self.assertEqual(rx[0], params.bushing_diameter / 2.0)
                self.assertEqual(rx[-1], params.bushing_diameter / 2.0 + distance)
                self.assertAlmostEqual(ry[-1] - ry[0], 10.0)
                self.assertTrue(np.all(np.diff(rx) >= 0.0))
                # Endpoint secants converge to the vertical Bézier tangent.
                self.assertLess(abs((rx[-1] - rx[-2]) / (ry[-1] - ry[-2])), 0.003 * distance)
                self.assertAlmostEqual(result.min_gaps[0], AXIS_BUSHING_PLAY_MM)
                self.assertTrue(np.all(np.diff(result.min_gaps) >= -1e-10))

                old = compute_simulation(replace(params, ramp_enabled=False))
                old_curve = [(cx, cy) for cx, cy in zip(old.cam_X, old.cam_Y) if result.ramp_join_Y < cy]
                new_curve = [(cx, cy) for cx, cy in zip(x, y) if result.ramp_join_Y < cy]
                # Ramp mode includes the exact final extension endpoint as well.
                self.assertEqual(old_curve, new_curve[:len(old_curve)])

    def test_contact_uses_perpendicular_distance_to_sloped_wall(self):
        # Segment (1, 0)..(4, 4); distance from (0, 3) to its interior is 2.6 mm.
        distance = _profile_distances_at_y(np.array([1.0, 4.0]), np.array([0.0, 4.0]), np.array([0.0, 3.0]))
        np.testing.assert_allclose(distance, [1.0, 2.6], atol=1e-12)

    def test_compliance_and_pressure_govern_flow_cutoff(self):
        params = SimulationParams(ramp_enabled=True, default_distance=1.1)
        first_open = []
        for compliance in (0.2, 0.7, 2.0):
            p = replace(params, compliance=compliance)
            result = compute_simulation(p)
            threshold = p.tube_od - p.tube_id - compliance * p.input_pressure_psi * 0.00689476
            gap = np.array(result.min_gaps)
            flow = np.array(result.flow_l_min)
            np.testing.assert_array_equal(flow[gap <= threshold], 0.0)
            self.assertTrue(np.all(flow[gap > threshold] > 0.0))
            first_open.append(next(y for y, q in zip(result.Y_positions, flow) if q > 0))
        self.assertGreater(first_open[0], first_open[1])
        self.assertGreater(first_open[1], first_open[2])

        low_pressure = compute_simulation(replace(params, input_pressure_psi=15))
        high_pressure = compute_simulation(replace(params, input_pressure_psi=60))
        low_y = next(y for y, q in zip(low_pressure.Y_positions, low_pressure.flow_l_min) if q > 0)
        high_y = next(y for y, q in zip(high_pressure.Y_positions, high_pressure.flow_l_min) if q > 0)
        self.assertLess(high_y, low_y)

    def test_geometric_zero_does_not_artificially_force_zero_flow(self):
        # With this deliberately soft tube, pressure expansion exceeds wall thickness.
        result = compute_simulation(SimulationParams(ramp_enabled=True, compliance=5.0))
        self.assertGreater(result.flow_l_min[0], 0.0)
        self.assertEqual(result.cam_X[0], 1.5)

    def test_default_opening_flow_remains_close(self):
        params = SimulationParams(input_pressure_psi=15)
        plateau = compute_simulation(params)
        ramp = compute_simulation(replace(params, ramp_enabled=True))
        y = np.linspace(0.0, min(plateau.Y_end, ramp.Y_end), 500)
        old_flow = np.interp(y, plateau.Y_positions, plateau.flow_l_min)
        new_flow = np.interp(y, ramp.Y_positions, ramp.flow_l_min)
        self.assertLess(np.max(np.abs(new_flow - old_flow)) / max(plateau.flow_l_min), 0.002)
        self.assertLess(abs(ramp.total_volume_ml / plateau.total_volume_ml - 1.0), 0.002)
        self.assertEqual(max(ramp.flow_l_min), max(plateau.flow_l_min))

    def test_solver_propagates_ramp_to_every_candidate(self):
        for optimize in (False, True):
            with self.subTest(optimize_default_distance=optimize):
                result = solve_cam_profile(SolverParams(
                    ramp_enabled=True, optimize_default_distance=optimize,
                    k_steps=2, height_steps=3, deadband_steps=3,
                    k_min=1, k_max=3, h_search_lo=1.5, h_search_max=4,
                    deadband_min=1.5, deadband_max=4,
                    gap_at_y0_margin_mm=0.1, default_distance_safety_factor=0.9,
                ))
                self.assertTrue(result.success, result.message)
                self.assertTrue(result.simulation.ramp_enabled)
                self.assertTrue(result.candidate_simulations)
                for simulation in result.candidate_simulations:
                    self.assertTrue(simulation.ramp_enabled)
                    self.assertAlmostEqual(simulation.min_gaps[0], AXIS_BUSHING_PLAY_MM)


if __name__ == '__main__':
    unittest.main()
