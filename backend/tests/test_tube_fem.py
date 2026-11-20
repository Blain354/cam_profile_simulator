"""Validation of the tube finite-element model (backend/tube_fem).

Every test states its reference. They call the uncached solver. About 10 s in all.
"""

import os
import stat
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tube_fem  # noqa: E402
from tube_fem import TubeFemError, shore_a_to_e_mpa, solve_tube, solve_tube_cached  # noqa: E402
from tube_fem.fem import QuarterRing, State, solve_step  # noqa: E402


def _ring_stiffness(ri, ro, nu, nr=1, nt=12, d=0.002):
    """Plate force per unit length over the change in plate distance, for a squeeze d (E = 1)."""
    m = QuarterRing(ri, ro, nu, nr=nr, nt=nt)
    nc = len(m.c_nodes)
    st = State(m.X.copy(), np.zeros(nc), np.zeros(nc, dtype=bool))
    st, _, _ = solve_step(m, st, ro - d / 2.0, 0.0, 1e3 * m.mu * 2 * nt, 1e-9)
    return 2.0 * st.lam[m.c_sign > 0].sum() / d


class TestSmallStrainReferences(unittest.TestCase):
    def test_free_inflation_matches_lame(self):
        """Thick-walled cylinder, plane strain (Lame): u(r) = (1 + nu)/E ((1 - 2 nu) A r + B / r),
        A = p a^2 / (b^2 - a^2), B = p a^2 b^2 / (b^2 - a^2). At p = 1e-3 E the FEM radii of the
        free inflated tube agree within 1 % (observed +0.4 % inner, +0.5 % outer), at nu = 0.49 and
        at nu = 0.4999 (no locking)."""
        a, b, e = 1.0, 1.5, 2.0
        p = 1e-3 * e
        for nu in (0.49, 0.4999):
            r = solve_tube(2 * b, 2 * a, e_mpa=e, nu=nu, pressure_kpa=p * 1e3)
            big_a, big_b = p * a * a / (b * b - a * a), p * a * a * b * b / (b * b - a * a)
            u = lambda rad: (1 + nu) / e * ((1 - 2 * nu) * big_a * rad + big_b / rad)
            u_out = r.h_contact / 2.0 - b
            u_in = float(np.max(r.inner[0][:, 1])) - a
            self.assertAlmostEqual(u_out / u(b), 1.0, delta=0.01, msg="outer, nu=%g" % nu)
            self.assertAlmostEqual(u_in / u(a), 1.0, delta=0.01, msg="inner, nu=%g" % nu)

    def test_ring_between_plates_and_no_locking(self):
        """Thin ring between two plates (Castigliano, Roark): change in diameter
        d = 0.1488 P R^3 / (E' I), E' = E / (1 - nu^2) in plane strain, I = t^3 / 12.
        Ring t/R = 0.105: the FEM is within 4 % of it (observed 2.1 to 2.6 % softer: shear and
        the ring's curvature, effects of order t/R that the thin-ring result leaves out).
        Locking check: the ratio does not move (< 0.5 %) from nu = 0.49 to nu = 0.4999,
        where a locking element would stiffen many times over."""
        ri, ro = 0.45 * 3, 0.5 * 3
        t, rm = ro - ri, (ri + ro) / 2.0
        ratios = {}
        for nu in (0.3, 0.49, 0.4999):
            thin = 1.0 / (1 - nu * nu) * t ** 3 / 12.0 / (0.1488 * rm ** 3)
            ratios[nu] = _ring_stiffness(ri, ro, nu, d=0.006) / thin
            self.assertAlmostEqual(ratios[nu], 1.0, delta=0.04, msg="nu=%g" % nu)
        self.assertAlmostEqual(ratios[0.4999] / ratios[0.49], 1.0, delta=0.005)


class TestDefaultTube(unittest.TestCase):
    """Default tube 3 x 2 mm, Shore 50."""

    @classmethod
    def setUpClass(cls):
        cls.dry = solve_tube(3.0, 2.0, shore_a=50)
        cls.wet = solve_tube(3.0, 2.0, shore_a=50, pressure_kpa=100.0, dry=cls.dry)
        cls.wall = 0.5

    def test_gent_modulus(self):
        """Gent (1958): E = 0.0981 (56 + 7.62336 S) / (0.137505 (254 - 2.54 S)) MPa: 2.456 MPa at Shore 50."""
        self.assertAlmostEqual(shore_a_to_e_mpa(50), 2.4558, places=3)
        self.assertAlmostEqual(self.dry.e_mpa, 2.4558, places=3)

    def test_contact_penetration_under_tolerance(self):
        """Augmented Lagrange contact: worst penetration under 1e-3 of the wall thickness at every step."""
        for r in (self.dry, self.wet):
            self.assertLessEqual(float(r.penetration.max()), 1e-3 * self.wall)

    def test_force_grows_and_bore_shrinks_with_squeeze(self):
        """Force rises with squeeze (a dip of at most 1 % is allowed where the fold's inner faces
        land on each other), the open bore never grows, and the pressure only adds force."""
        for r in (self.dry, self.wet):
            f = r.force
            self.assertTrue(np.all(np.diff(f) >= -0.01 * f[1:]), msg=np.diff(f))
            self.assertTrue(np.all(np.diff(r.area) <= 1e-4 * r.area[0]))
        open_ = self.wet.h > self.wet.h_sealed
        self.assertTrue(np.all(self.wet.pressure_share[open_] >= -1e-9))

    def test_bore_closes_near_two_walls_and_pressure_moves_it_down(self):
        """With no pressure the bore shuts at h close to 2 x wall (1.0 mm): within 7 % below it,
        the folds at the sides needing a little more squeeze. Against 100 kPa it shuts deeper."""
        self.assertLess(self.dry.h_closed, 2 * self.wall)
        self.assertGreater(self.dry.h_closed, 0.93 * 2 * self.wall)
        self.assertLess(self.wet.h_sealed, self.dry.h_closed - 0.01)
        self.assertAlmostEqual(self.wet.h_closed, self.dry.h_closed)
        self.assertLess(float(self.wet.open_area(self.wet.h_sealed - 1e-6)), 1e-2)

    def test_section_area_kept_when_nearly_incompressible(self):
        """Incompressibility: at nu = 0.4999 the solid section keeps its area within 0.2 % down to
        the deepest squeeze solved; at the default nu = 0.49 the loss stays under 6 %, which is the
        mean stress over the bulk modulus (kappa = 50 mu) at 50 % squeeze past closure."""
        self.assertLess(self.dry.solid_area_change, 0.06)
        stiff = solve_tube(3.0, 2.0, shore_a=50, nu=0.4999)
        self.assertLess(stiff.solid_area_change, 0.002)
        self.assertLess(stiff.h_min, stiff.h_closed * 0.6)

    def test_mesh_convergence(self):
        """Default mesh (1 x 12 elements on the quarter) and 1 x 24 against 3 x 24, at the same
        plate distances: closing h within 1.5 % (observed 0.8 % and 1.0 %), force on the open tube
        (h = 2 mm) within 3 % (1.6 %, 1.8 %), force at 10 % below the finest mesh's closing h
        within 3 % (0.5 %, 0.1 %)."""
        meshes = [self.dry, solve_tube(3.0, 2.0, shore_a=50, nt=24), solve_tube(3.0, 2.0, shore_a=50, nr=3, nt=24)]
        hc = [r.h_closed for r in meshes]
        f_open = [float(r.force_per_mm(2.0)) for r in meshes]
        f_10 = [float(r.force_per_mm(0.9 * meshes[-1].h_closed)) for r in meshes]
        for i in (0, 1):
            self.assertAlmostEqual(hc[i] / hc[-1], 1.0, delta=0.015)
            self.assertAlmostEqual(f_open[i] / f_open[-1], 1.0, delta=0.03)
            self.assertAlmostEqual(f_10[i] / f_10[-1], 1.0, delta=0.03)

    def test_extrapolation_below_the_sweep_keeps_rising(self):
        """Below the deepest step the force follows an incompressible strip law (~ h^-3)."""
        h0 = self.dry.h_min
        f = self.dry.force_per_mm(np.array([h0, 0.9 * h0, 0.5 * h0]))
        self.assertTrue(np.all(np.diff(f) > 0))
        self.assertAlmostEqual(float(f[0]), float(self.dry.force[-1]), places=6)

    def test_shape_outlines_are_closed_whole_sections(self):
        s = self.wet.shape(1.5)
        outer, inner = np.array(s["outer"]), np.array(s["inner"])
        self.assertLessEqual(outer[:, 1].max(), 0.75 + 1e-3)          # plate at h / 2
        self.assertGreater(outer[:, 0].max(), 1.5)                     # flattened: wider than the OD
        self.assertTrue(np.allclose(outer[0], outer[-1]) and np.allclose(inner[0], inner[-1]))


class TestFailureAndCache(unittest.TestCase):
    def test_balloon_is_reported(self):
        """Past mu ln(OD/ID) (0.136 E here) a neo-Hookean tube inflates without limit: a clear error."""
        with self.assertRaises(TubeFemError) as ctx:
            solve_tube(3.0, 2.0, e_mpa=1.0, pressure_kpa=200.0)
        self.assertIn("balloons", str(ctx.exception))

    def test_cache_scales_and_survives_disk(self):
        """The cached response (solved at OD = 1, E = 1) scales to the direct solve; disk round trip.
        ID/OD = 0.5 and p/E = 0.025 are exact under the cache's rounding, so the match is exact."""
        direct = solve_tube(3.0, 1.5, e_mpa=2.0, pressure_kpa=50.0)
        with tempfile.TemporaryDirectory() as d:
            tube_fem._MEM.clear()
            c1 = solve_tube_cached(3.0, 1.5, e_mpa=2.0, pressure_kpa=50.0, cache_dir=d)
            self.assertTrue(any(n.endswith(".json") for n in os.listdir(d)))
            tube_fem._MEM.clear()
            c2 = solve_tube_cached(3.0, 1.5, e_mpa=2.0, pressure_kpa=50.0, cache_dir=d)
        for c in (c1, c2):
            self.assertAlmostEqual(c.h_sealed, direct.h_sealed, places=6)
            self.assertAlmostEqual(float(c.force_per_mm(0.9)), float(direct.force_per_mm(0.9)), places=6)
            self.assertAlmostEqual(float(c.open_area(1.5)), float(direct.open_area(1.5)), places=6)

    def test_unwritable_cache_dir_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
            try:
                tube_fem._MEM.clear()
                r = solve_tube_cached(3.0, 2.0, e_mpa=2.0, cache_dir=os.path.join(d, "sub"))
                self.assertGreater(r.h_closed, 0.0)
            finally:
                os.chmod(d, stat.S_IRWXU)


if __name__ == "__main__":
    unittest.main()
