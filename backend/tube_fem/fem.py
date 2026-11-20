"""Quarter-ring plane-strain finite elements: mesh, element law, contact, Newton.

Everything here is dimensionless: lengths are divided by the tube OD, stresses by
Young's modulus E. The public API in __init__ scales the results back.
"""

import numpy as np

_GP = np.array([-np.sqrt(0.6), 0.0, np.sqrt(0.6)])
_GW = np.array([5.0, 8.0, 5.0]) / 9.0


def _lag(t):
    """1D quadratic Lagrange functions on the nodes -1, 0, 1, and their derivatives."""
    t = np.asarray(t, dtype=float)
    return (np.stack([t * (t - 1.0) / 2.0, 1.0 - t * t, t * (t + 1.0) / 2.0], -1),
            np.stack([t - 0.5, -2.0 * t, t + 0.5], -1))


# d cof(F) / dF for a 2 x 2 F: cof = [[F11, -F10], [-F01, F00]] (index iJ, kL).
_DCOF = np.zeros((2, 2, 2, 2))
_DCOF[0, 0, 1, 1] = _DCOF[1, 1, 0, 0] = 1.0
_DCOF[0, 1, 1, 0] = _DCOF[1, 0, 0, 1] = -1.0
_DCOF4 = _DCOF.reshape(4, 4)


def _cof(F):
    return np.stack([np.stack([F[..., 1, 1], -F[..., 1, 0]], -1),
                     np.stack([-F[..., 0, 1], F[..., 0, 0]], -1)], -2)


class NotConverged(Exception):
    pass


class QuarterRing:
    """Quarter of a ring section (x >= 0, y >= 0) meshed with 9-node quadrilaterals.

    Node (j, k): j = 0 .. 2 nt around (j = 0 on the x axis, the fold side; j = 2 nt on the
    y axis, under the plate), k = 0 .. 2 nr through the wall (k = 0 on the bore).
    Symmetry: ux = 0 on the y axis, uy = 0 on the x axis. Plate: y <= h / 2 on the outer
    nodes. Self-contact of the bore: y >= 0 on the inner nodes (the mirror image of the
    wall across the mid-plane is the other half of the tube).
    """

    def __init__(self, ri, ro, nu, nr=2, nt=16, grade=1.0):
        self.ri, self.ro, self.nr, self.nt = ri, ro, nr, nt
        self.mu = 1.0 / (2.0 * (1.0 + nu))
        self.kappa = 1.0 / (3.0 * (1.0 - 2.0 * nu))
        s = np.linspace(0.0, 1.0, nt + 1)
        te = 0.5 * np.pi * s ** grade                 # element edges, finer near the fold if grade > 1
        th = np.empty(2 * nt + 1)
        th[0::2], th[1::2] = te, 0.5 * (te[:-1] + te[1:])
        r = np.linspace(ri, ro, 2 * nr + 1)
        self.n_k = 2 * nr + 1
        nn = (2 * nt + 1) * self.n_k
        jj, kk = np.meshgrid(np.arange(2 * nt + 1), np.arange(self.n_k), indexing="ij")
        self.X = np.stack([r[kk] * np.cos(th[jj]), r[kk] * np.sin(th[jj])], -1).reshape(nn, 2)
        self.X[(jj == 2 * nt).ravel(), 0] = 0.0
        self.X[(jj == 0).ravel(), 1] = 0.0
        self.nn, self.ndof = nn, 2 * nn
        node = lambda j, k: j * self.n_k + k
        conn = []
        for et in range(nt):
            for er in range(nr):
                conn.append([node(2 * et + b, 2 * er + a) for b in range(3) for a in range(3)])
        self.conn = np.array(conn)
        self.ne = len(conn)
        # Shape functions at the 3 x 3 Gauss points: a = 3 * beta + alpha, xi radial, eta around.
        L, dL = _lag(_GP)
        N = np.einsum("pb,qa->pqba", L, L).reshape(9, 9)                     # [g = 3p+q, a] with p ~ eta, q ~ xi
        dxi = np.einsum("pb,qa->pqba", L, dL).reshape(9, 9)
        deta = np.einsum("pb,qa->pqba", dL, L).reshape(9, 9)
        w = np.einsum("p,q->pq", _GW, _GW).ravel()
        dNdxi = np.stack([dxi, deta], -1)                                    # [g, a, 2]
        Xe = self.X[self.conn]                                               # [e, a, 2]
        J0 = np.einsum("eai,gaJ->egiJ", Xe, dNdxi)
        self.dNdX = np.einsum("gaK,egKJ->egaJ", dNdxi, np.linalg.inv(J0))
        self.w0 = w[None, :] * np.linalg.det(J0)
        self.A0 = self.w0.sum(1)
        self.solid_area0 = float(self.A0.sum())
        # B: F (as F00, F01, F10, F11) = B u_e, with u_e = (u0x, u0y, u1x, ...).
        self.B = np.zeros((self.ne, 9, 4, 18))
        for i in range(2):
            for J_ in range(2):
                self.B[:, :, 2 * i + J_, i::2] = self.dNdX[:, :, :, J_]
        # Volume term on J projected onto {1, xi, eta} per element (Q9/P3, discontinuous linear
        # pressure condensed out): Jbar_g = sum_h proj[e, g, h] J_h.
        phi = np.stack([np.ones(9), np.tile(_GP, 3), np.repeat(_GP, 3)], -1)          # [g, 3]
        Me = np.einsum("eg,gk,gl->ekl", self.w0, phi, phi)
        self.proj = np.einsum("gk,ekl,hl,eh->egh", phi, np.linalg.inv(Me), phi, self.w0)
        self.HB = np.einsum("egpa,pq,egqb->egab", self.B, _DCOF4, self.B)               # d2 J / du2 per point
        dofs = np.stack([2 * self.conn, 2 * self.conn + 1], -1).reshape(self.ne, 18)
        self.edof = dofs
        self.k_idx = (dofs[:, :, None] * self.ndof + dofs[:, None, :]).ravel()
        # Boundary sets.
        self.outer = np.array([node(j, 2 * nr) for j in range(2 * nt + 1)])
        self.inner = np.array([node(j, 0) for j in range(2 * nt + 1)])
        fixed = [2 * node(2 * nt, k) for k in range(self.n_k)] + [2 * node(0, k) + 1 for k in range(self.n_k)]
        self.free = np.setdiff1d(np.arange(self.ndof), fixed)
        # Contact candidates (the x-axis nodes are held on y = 0 already).
        self.c_nodes = np.concatenate([self.outer[1:], self.inner[1:]])
        self.c_sign = np.concatenate([np.ones(2 * nt), -np.ones(2 * nt)])   # +1 plate (y <= yp), -1 mid-plane (y >= 0)
        # Follower pressure on the bore: T[b, d, c] = int L_b L_d L'_c d eta, per inner edge.
        L3, dL3 = _lag(_GP)
        self.T = np.einsum("g,gb,gd,gc->bdc", _GW, L3, L3, dL3)
        self.bore_edges = np.array([[self.inner[2 * et + b] for b in range(3)] for et in range(nt)])
        be = self.bore_edges
        self.p_idx_xy = ((2 * be)[:, :, None] * self.ndof + (2 * be + 1)[:, None, :]).ravel()
        self.p_idx_yx = ((2 * be + 1)[:, :, None] * self.ndof + (2 * be)[:, None, :]).ravel()

    # -- element law ---------------------------------------------------------------------
    def _deform(self, x):
        F = np.einsum("eai,egaJ->egiJ", x[self.conn], self.dNdX)
        J = F[..., 0, 0] * F[..., 1, 1] - F[..., 0, 1] * F[..., 1, 0]
        return F, J

    def valid(self, x):
        """No Gauss point turned inside out, in J or in its projection."""
        _, J = self._deform(x)
        return bool(np.all(J > 1e-8) and np.all(np.einsum("egh,eh->eg", self.proj, J) > 1e-6))

    def internal(self, x, need_k=True):
        """Internal force [ndof] and tangent [ndof, ndof] at nodal positions x [nn, 2].

        Neo-Hookean in plane strain (F33 = 1): W = mu/2 (J^-2/3 (F:F + 1) - 3) at the Gauss
        points, plus U = kappa/4 (Jb^2 - 1 - 2 ln Jb) where Jb is J projected, element by
        element, onto the linear field {1, xi, eta}. That is the Q9/P3 mixed element (9-node
        displacement, discontinuous linear pressure) with the pressure condensed out: stable,
        and free of volumetric locking. Returns None if any point is inverted.
        """
        F, J = self._deform(x)
        if np.any(J <= 1e-8):
            return None
        Jb = np.einsum("egh,eh->eg", self.proj, J)
        if np.any(Jb <= 1e-6):
            return None
        mu, ka = self.mu, self.kappa
        F4 = F.reshape(self.ne, 9, 4)
        C4 = _cof(F).reshape(self.ne, 9, 4)
        I = (F4 * F4).sum(-1) + 1.0
        j23, j53 = J ** (-2.0 / 3.0), J ** (-5.0 / 3.0)
        P4 = mu * (j23[..., None] * F4 - (I * j53 / 3.0)[..., None] * C4)
        wB = self.w0[..., None, None] * self.B                         # [e, g, 4, 18]
        dJ = np.einsum("egp,egpa->ega", C4, self.B)
        dJb = np.einsum("egh,eha->ega", self.proj, dJ)
        wup = self.w0 * 0.5 * ka * (Jb - 1.0 / Jb)
        fe = np.einsum("egp,egpa->ea", P4, wB) + np.einsum("eg,ega->ea", wup, dJb)
        f = np.bincount(self.edof.ravel(), fe.ravel(), self.ndof)
        if not need_k:
            return f, None
        A = (mu * j23)[..., None, None] * np.eye(4) \
            - (2.0 / 3.0 * mu * j53)[..., None, None] * (F4[..., :, None] * C4[..., None, :] + C4[..., :, None] * F4[..., None, :]) \
            + (5.0 / 9.0 * mu * I * J ** (-8.0 / 3.0))[..., None, None] * (C4[..., :, None] * C4[..., None, :]) \
            - (mu * I * j53 / 3.0)[..., None, None] * _DCOF4
        ke = np.matmul(np.swapaxes(wB, -1, -2), np.matmul(A, self.B)).sum(1)
        wupp = self.w0 * 0.5 * ka * (1.0 + 1.0 / Jb ** 2)
        ke += np.einsum("eg,ega,egb->eab", wupp, dJb, dJb) + np.einsum("eh,ehab->eab", np.einsum("eg,egh->eh", wup, self.proj), self.HB)
        K = np.bincount(self.k_idx, ke.ravel(), self.ndof * self.ndof).reshape(self.ndof, self.ndof)
        return f, K

    def pressure(self, x, p_node):
        """Follower load of the bore pressure (p per inner node, linear along each edge) and its tangent."""
        nodes = self.bore_edges                                   # [edge, 3]
        M = np.einsum("bdc,ed->ebc", self.T, p_node[nodes])       # f_x[b] = M y, f_y[b] = -M x
        xe = x[nodes]
        fx = np.einsum("ebc,ec->eb", M, xe[..., 1])
        fy = -np.einsum("ebc,ec->eb", M, xe[..., 0])
        f = np.zeros(self.ndof)
        np.add.at(f, 2 * nodes, fx)
        np.add.at(f, 2 * nodes + 1, fy)
        K = np.bincount(self.p_idx_xy, M.ravel(), self.ndof * self.ndof) - np.bincount(self.p_idx_yx, M.ravel(), self.ndof * self.ndof)
        return f, K.reshape(self.ndof, self.ndof)

    def strain_extremes(self, x):
        """Largest and smallest principal stretch over the Gauss points (out-of-plane stretch is 1)."""
        F = np.einsum("eai,egaJ->egiJ", x[self.conn], self.dNdX)
        C = np.einsum("egkI,egkJ->egIJ", F, F)
        tr, det = C[..., 0, 0] + C[..., 1, 1], C[..., 0, 0] * C[..., 1, 1] - C[..., 0, 1] ** 2
        disc = np.sqrt(np.maximum(tr * tr / 4.0 - det, 0.0))
        lam1, lam2 = np.sqrt(tr / 2.0 + disc), np.sqrt(np.maximum(tr / 2.0 - disc, 0.0))
        return float(max(lam1.max(), 1.0)), float(min(lam2.min(), 1.0))

    def solid_area(self, x):
        F = np.einsum("eai,egaJ->egiJ", x[self.conn], self.dNdX)
        return float((self.w0 * (F[..., 0, 0] * F[..., 1, 1] - F[..., 0, 1] * F[..., 1, 0])).sum())

    def bore_area(self, x):
        """Open bore of the quarter: between the inner wall (clipped to y >= 0) and the two axes."""
        pts = x[self.inner].copy()
        pts[:, 1] = np.maximum(pts[:, 1], 0.0)
        pts[:, 0] = np.maximum(pts[:, 0], 0.0)
        poly = np.vstack([[0.0, 0.0], pts])
        xs, ys = poly[:, 0], poly[:, 1]
        return float(0.5 * abs(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))))


class State:
    """Positions, contact multipliers and active sets: what a converged step carries forward."""

    def __init__(self, x, lam, active):
        self.x, self.lam, self.active = x, lam, active

    def copy(self):
        return State(self.x.copy(), self.lam.copy(), self.active.copy())


def solve_step(m, st, yp, p, k_pen, pen_tol, max_newton=30, max_outer=30, damp=0.0):
    """Equilibrium with the plate at y = yp and bore pressure p, starting from state st.

    Inner loop: Newton with the contact set and the pressure-loaded nodes frozen.
    Outer loop: update the contact set (release nodes in tension, catch nodes that went
    through) and the augmented-Lagrange multipliers until the set is stable and the
    worst penetration is under pen_tol. Raises NotConverged.

    damp > 0 adds a spring of that stiffness from every node to where it started the step
    (viscous stabilisation): it carries the solution through a local snap, the fold's inner
    surface zipping shut. Returns the largest such artificial nodal force as well.
    """
    x, lam, active = st.x.copy(), st.lam.copy(), st.active.copy()
    x_start = st.x
    cn, cs = m.c_nodes, m.c_sign
    free = m.free
    scale = 1e-9 + 1e-7 * m.mu
    for outer in range(max_outer):
        p_node = np.zeros(m.nn)
        if p > 0.0:
            # The bore is loaded wherever its wall is not resting on the mid-plane.
            inner_active = np.zeros(m.nn, dtype=bool)
            inner_active[cn[(cs < 0) & active]] = True
            p_node[m.inner] = np.where(inner_active[m.inner], 0.0, p)
        for it in range(max_newton):
            out = m.internal(x)
            if out is None:
                raise NotConverged("an element turned inside out")
            f, K = out
            if damp > 0.0:
                f = f + damp * (x - x_start).ravel()
                K = K + damp * np.eye(m.ndof)
            if p > 0.0:
                fp, Kp = m.pressure(x, p_node)
                f = f - fp
                K = K - Kp
            # Frozen contact: penalty spring plus multiplier on the active nodes.
            gap = np.where(cs > 0, yp - x[cn, 1], x[cn, 1])
            force = np.where(active, lam - k_pen * gap, 0.0)       # >= 0 pushes the node off the obstacle
            dof = 2 * cn + 1
            np.add.at(f, dof, cs * force)
            np.add.at(K, (dof, dof), np.where(active, k_pen, 0.0))
            r = f[free]
            if not np.all(np.isfinite(r)):
                raise NotConverged("non-finite residual")
            rn = np.abs(r).max()
            if it > 0 and rn < scale:
                break
            try:
                du = np.linalg.solve(K[np.ix_(free, free)], -r)
            except np.linalg.LinAlgError:
                raise NotConverged("singular tangent")
            step = np.zeros(m.ndof)
            step[free] = du
            # Backtrack only to keep every element right side out.
            t = 1.0
            for _ in range(8):
                trial = x + t * step.reshape(-1, 2)
                if m.valid(trial):
                    break
                t *= 0.5
            else:
                raise NotConverged("an element turned inside out")
            x = trial
            if np.abs(du).max() * t < 1e-13:
                break
        else:
            raise NotConverged("Newton did not converge (residual %.3g)" % rn)
        gap = np.where(cs > 0, yp - x[cn, 1], x[cn, 1])
        trial_force = lam - k_pen * gap
        new_active = np.where(active, trial_force > 0.0, gap < 0.0)
        pen = float(np.max(np.where(new_active, -gap, 0.0), initial=0.0))
        if np.array_equal(new_active, active) and pen <= pen_tol:
            lam = np.where(active, trial_force, 0.0)
            ghost = float(damp * np.abs(x - x_start).max()) if damp > 0.0 else 0.0
            return State(x, lam, active), outer, ghost
        if np.array_equal(new_active, active):
            lam = np.where(active, np.maximum(trial_force, 0.0), 0.0)   # augment
        else:
            lam = np.where(new_active & active, np.maximum(trial_force, 0.0), 0.0)
            active = new_active
    raise NotConverged("contact set did not settle")


def relax(m, st, yp, p, k_pen, pen_tol, max_solves=200):
    """Static equilibrium past a snap, by dynamic relaxation at a fixed plate position.

    When the static path ends in a limit point (the inner surface of the fold creasing shut,
    a subcritical instability), Newton from the last state has no nearby root. Damped solves
    (each node tied by a spring to where it was) walk the section to the new branch, then an
    undamped solve must converge there: the state returned is a true equilibrium, with no
    artificial force left in it. Returns (state, damped solves used).
    """
    for damp in (0.3, 0.1, 0.03):
        cur = st
        for k in range(max_solves):
            try:
                cur, _, _ = solve_step(m, cur, yp, p, k_pen, pen_tol, damp=damp * m.mu)
            except NotConverged:
                break
            try:
                fin, _, _ = solve_step(m, cur, yp, p, k_pen, pen_tol)
                return fin, k + 1
            except NotConverged:
                pass
    raise NotConverged("no equilibrium found past the snap")
