"""Finite-element model of a silicone tube pinched between two parallel rigid plates.

Self-contained: imports only numpy and the standard library, nothing from the app.

Why a 2D section is the right model
    The pin (or the cam / bushing) crosses the tube. In the tube's cross-section, the plane
    normal to its axis, the pin face and the wall are two parallel flat rigid surfaces a
    distance h apart. Each axial slice of the tube is therefore a ring squeezed between two
    parallel plates at its local h. This package solves that ring.

Model
    * Plane strain (the slice is held in length by the tube on either side), large
      deformation, total Lagrangian.
    * Material: compressible neo-Hookean, W = mu/2 (J^-2/3 I1 - 3) + kappa/4 (J^2 - 1 - 2 ln J),
      mu = E / (2 (1 + nu)), kappa = E / (3 (1 - 2 nu)), nu = 0.4995 by default: kappa is about
      1000 mu, as for silicone (bulk modulus near 1 GPa, shear modulus near 1 MPa). The solid
      section then keeps its area within 0.3 % down to the deepest squeeze solved. Against
      nu = 0.49 (kappa = 50 mu, which lost 5 % of the area), the force is 2 to 3 % higher
      10 to 25 % past closure, 6 % higher at 50 %; the closing h does not move.
    * Elements: 9-node quadrilaterals, 3 x 3 Gauss points; the volume term uses J projected,
      element by element, onto a linear field (Q9/P3 mixed element, discontinuous linear pressure
      condensed out), so the section neither locks as nu -> 0.5 nor goes soft in bending
      (test_tube_fem checks the ring stiffness from nu = 0.3 to 0.4999 against Castigliano).
    * Mesh: by default 1 element through the wall and 12 around the quarter (48 around the
      tube). Against 2 x 32 for the 3 x 2 mm tube, at 0 and 100 kPa: closing h 0.5 to 0.7 %
      lower, open bore within 0.5 % of the unloaded bore, force within 3.5 % while the tube
      folds and within 1 % from 10 to 40 % past closure (the solved range). A wall too thin for that mesh (ID/OD
      above about 0.85) can stop converging before the bore closes: the sweep is then redone
      once on twice the elements around. Where the static path ends in a snap (the inner
      surface of a fold creasing shut, neo-Hookean creasing), the solver crosses it by dynamic
      relaxation (fem.relax) and keeps only a true equilibrium.
    * Symmetry: with frictionless parallel plates the section is symmetric about the mid-plane
      between the plates and about the axis normal to them. A quarter is meshed (x >= 0, y >= 0).
      The bore closing on itself becomes contact of the inner wall with the mid-plane y = 0.
    * Contact: frictionless, with the plate (y <= h/2 on the outer wall) and with the mid-plane
      (y >= 0 on the inner wall), node to rigid line, penalty plus augmented-Lagrange updates
      until the worst penetration is under 1e-3 of the wall thickness.
    * Air: the gauge pressure acts as a follower load on the part of the bore wall that is not
      resting on the mid-plane. A neo-Hookean tube balloons past about mu ln(OD/ID) of pressure
      (0.135 E for ID/OD = 2/3, so 330 kPa at Shore 50): the free inflation then fails with a
      TubeFemError that says so. The opening of the tube under pressure comes out of the
      elasticity; no empirical compliance.
    * Loading: free inflation first, then the plates close in steps of h, Newton at each step,
      the step cut back when Newton or the contact loop fails, grown when it converges fast.
      A failure before the bore closes raises TubeFemError with what happened and where.
    * Material input: Young's modulus from the Shore A hardness through Gent's relation
      E [MPa] = 0.0981 (56 + 7.62336 S) / (0.137505 (254 - 2.54 S)), or E given directly.

Results (TubeResponse)
    Over the sweep of plate distance h, from first contact to past closure: force per unit tube
    length (N/mm) and its pressure share (the same sweep at zero pressure, subtracted), open bore
    area (mm^2), the h at which the bore closes with no pressure and the h at which it closes
    against the given pressure, the extreme principal stretches, and the deformed outer and inner
    outlines of the whole section at each step. Interpolators force_per_mm(h), open_area(h),
    shape(h). Below the deepest step solved, the force is extrapolated as a plane-strain
    incompressible strip, F ~ h^-3, matched in value and slope (TubeResponse.h_min says where).

    The bore is "closed" once its open area is under CLOSED_AREA_FRACTION of the unloaded bore:
    the two folds at the sides of a flattened tube close only gradually, so a node-touches rule
    would depend on the mesh.

Not modelled
    Axial effects (the tube's bending along its axis on either side of a narrow pin, and its
    stiffening at the pin's round ends: the caller decides what length of tube to charge),
    friction on the plates and in the bore, contact between two tubes, viscoelasticity and
    the Mullins softening of silicone, its stiffening at large stretch (neo-Hookean has none),
    the tube's own pre-stress. Not compared with a measured tube: E comes from the Shore
    hardness through Gent's empirical relation, so expect the absolute forces to be off by
    the scatter of that relation (tens of percent); closing h and open bore depend on E only
    through p/E.

Force deep past closure
    Once the bore is shut, the force is that of a nearly incompressible strip squeezed between
    frictionless plates: about mu (lambda^-2 - lambda^2) times the solid area over h, lambda the
    squeeze ratio, which gives 25 to 28 N/mm at 50 % past closure for a 3 x 2 mm Shore 50
    tube (the FEM: 27.5). That steep rise is confinement, not the contact penalty (ten times
    stiffer or softer moves it under 0.3 %) nor locking (the Q9/P3 element). Friction on the
    plates, left out, would only raise it. The sweep stops 40 % past closure; deeper, the
    force is extrapolated (about 2 % under a solved value at 50 %).

Speed: about 0.4 s per sweep in the production image (the zero-pressure sweep and one per
pressure). The
response depends only on ID/OD, p/E and nu, so it is solved dimensionless and cached on
those (in memory, and on disk when a cache directory is given).
"""

import hashlib
import json
import os
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from .fem import NotConverged, QuarterRing, State, relax, solve_step

__all__ = ["TubeResponse", "TubeFemError", "solve_tube", "solve_tube_cached", "shore_a_to_e_mpa",
           "CLOSED_AREA_FRACTION", "SOLVER_VERSION"]

SOLVER_VERSION = 2
NU_DEFAULT = 0.4995
CLOSED_AREA_FRACTION = 1e-3      # bore closed below this share of the unloaded bore area
PEN_TOL_WALL = 1e-3              # contact penetration tolerance, share of the wall thickness
SQUEEZE_PAST_CLOSURE = 0.4       # the sweep tries to go to h = (1 - this) * closing h; extrapolated below


class TubeFemError(RuntimeError):
    pass


class _SqueezeFailed(TubeFemError):
    """The squeeze stopped converging before the bore closed (not a balloon)."""


def shore_a_to_e_mpa(shore_a: float) -> float:
    """Young's modulus (MPa) from Shore A hardness, Gent (1958)."""
    s = float(shore_a)
    if not 0.0 < s < 100.0:
        raise ValueError("Shore A hardness must be between 0 and 100")
    return 0.0981 * (56.0 + 7.62336 * s) / (0.137505 * (254.0 - 2.54 * s))


@dataclass
class TubeResponse:
    od: float
    id: float
    e_mpa: float
    nu: float
    pressure_kpa: float
    h: np.ndarray                 # mm, plate distance, decreasing
    force: np.ndarray             # N per mm of tube, with the pressure
    force_dry: np.ndarray         # N per mm of tube at zero pressure, at the same h
    area: np.ndarray              # mm^2 of open bore, with the pressure
    area_dry: np.ndarray          # mm^2 of open bore at zero pressure
    stretch_max: np.ndarray       # largest principal stretch in the section (>= 1)
    stretch_min: np.ndarray       # smallest principal stretch (<= 1)
    penetration: np.ndarray       # mm, worst contact penetration at each step
    outer: np.ndarray             # [step, n, 2] mm, deformed outer outline of the whole section
    inner: np.ndarray             # [step, n, 2] mm, deformed inner outline
    h_contact: float              # mm, plate distance at first contact (the inflated OD)
    h_closed: float               # mm, bore closes with no pressure
    h_sealed: float               # mm, bore closes against the given pressure
    h_min: float                  # mm, deepest step solved; below, the force is extrapolated
    area_free: float              # mm^2, bore of the free tube under the pressure
    solid_area_change: float      # worst relative change of the solid section area
    steps: int
    newton_iterations: int
    seconds: float = 0.0

    @property
    def pressure_share(self) -> np.ndarray:
        return self.force - self.force_dry

    def _extrapolate(self, h, f, k):
        """Value at h of a law matched to (h_min, f, stiffness k) and growing as h^-3 below."""
        h = np.maximum(h, 1e-6 * self.od)
        return f + k * self.h_min / 3.0 * ((self.h_min / h) ** 3 - 1.0)

    def _force(self, h, values):
        h = np.asarray(h, dtype=float)
        hs, fs = self.h[::-1], values[::-1]
        out = np.interp(h, hs, fs, left=fs[0], right=0.0)
        if len(hs) >= 2:
            k = max((fs[1] - fs[0]) / (hs[0] - hs[1]), 0.0)
            below = h < hs[0]
            if np.any(below):
                out = np.where(below, self._extrapolate(h, fs[0], k), out)
        return out

    def force_per_mm(self, h):
        """N per mm of tube at plate distance h (mm), pressure included."""
        return self._force(h, self.force)

    def force_dry_per_mm(self, h):
        """N per mm of tube at plate distance h with no pressure in the bore."""
        return self._force(h, self.force_dry)

    def open_area(self, h):
        """mm^2 of open bore at plate distance h, under the pressure. Above first contact: the free tube."""
        hs, a = self.h[::-1], self.area[::-1]
        return np.interp(np.asarray(h, dtype=float), hs, a, left=0.0, right=self.area_free)

    def shape(self, h) -> Dict[str, list]:
        """Deformed outlines at plate distance h (linear between solved steps)."""
        h = float(np.clip(h, self.h[-1], self.h[0]))
        i = int(np.clip(np.searchsorted(-self.h, -h), 1, len(self.h) - 1))
        h0, h1 = self.h[i - 1], self.h[i]
        t = 0.0 if h0 == h1 else (h0 - h) / (h0 - h1)
        mix = lambda a: (1.0 - t) * a[i - 1] + t * a[i]
        return {"outer": mix(self.outer).tolist(), "inner": mix(self.inner).tolist()}

    def to_dict(self) -> dict:
        """Plain lists; the outlines rounded to 1e-6 of the OD (drawing only), to keep files small."""
        d = {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in self.__dict__.items()}
        for k in ("outer", "inner"):
            d[k] = (np.round(getattr(self, k) / self.od, 6) * self.od).tolist()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "TubeResponse":
        arrays = ("h", "force", "force_dry", "area", "area_dry", "stretch_max", "stretch_min", "penetration", "outer", "inner")
        return cls(**{k: (np.array(v, dtype=float) if k in arrays else v) for k, v in d.items()})


def _whole(q: np.ndarray) -> np.ndarray:
    """Quarter outline (from the x axis to the y axis) mirrored into the whole closed section."""
    a = q                                     # x >= 0, y >= 0, from (x, 0) to (0, y)
    b = q[::-1][1:] * [-1.0, 1.0]             # x <= 0, y >= 0
    c = q[1:] * [-1.0, -1.0]                  # x <= 0, y <= 0
    d = q[::-1][1:] * [1.0, -1.0]             # x >= 0, y <= 0
    return np.vstack([a, b, c, d])


@dataclass
class _Sweep:
    h: List[float]
    force: List[float]
    area: List[float]
    smax: List[float]
    smin: List[float]
    pen: List[float]
    outer: List[np.ndarray]
    inner: List[np.ndarray]
    area_free: float
    solid_change: float
    newton: int
    h_contact: float
    snaps: int = 0


def _sweep(id_over_od, p, nu, nr, nt, grade, h_list=None, depth=SQUEEZE_PAST_CLOSURE):
    """One dimensionless sweep (OD = 1, E = 1), plate distance from first contact downwards.

    Without h_list: adaptive steps until (1 - depth) x the closing h. With h_list: records the
    state at exactly those plate distances (sub-stepping in between when needed).
    """
    m = QuarterRing(0.5 * id_over_od, 0.5, nu, nr=nr, nt=nt, grade=grade)
    wall = 0.5 * (1.0 - id_over_od)
    k_pen = 1e3 * m.mu * (2 * nt)             # stiff against the elements next to the contact
    pen_tol = PEN_TOL_WALL * wall
    nc = len(m.c_nodes)
    st = State(m.X.copy(), np.zeros(nc), np.zeros(nc, dtype=bool))
    newton = 0
    far = 10.0
    # Free inflation, in pressure steps.
    done, dp = 0.0, p
    while done < p:
        try:
            st2, it, _ = solve_step(m, st, far, done + dp, k_pen, pen_tol)
        except NotConverged as e:
            dp *= 0.5
            if dp < 1e-3 * p:
                raise TubeFemError("free inflation stops converging at %.3g E of pressure (%s): the tube balloons; "
                                   "a neo-Hookean tube has a pressure it cannot exceed, about mu ln(OD/ID)" % (done, e))
            continue
        st, done, newton = st2, done + dp, newton + it + 1
    area_free = 4.0 * m.bore_area(st.x)
    bore0 = np.pi * (0.5 * id_over_od) ** 2
    yp = float(st.x[m.outer, 1].max())
    out = _Sweep([], [], [], [], [], [], [], [], area_free, 0.0, newton, 2.0 * yp)

    def record(state, yp_):
        out.h.append(2.0 * yp_)
        plate = m.c_sign > 0
        out.force.append(2.0 * float(state.lam[plate].sum()))
        out.area.append(4.0 * m.bore_area(state.x))
        smax, smin = m.strain_extremes(state.x)
        out.smax.append(smax)
        out.smin.append(smin)
        gap = np.where(m.c_sign > 0, yp_ - state.x[m.c_nodes, 1], state.x[m.c_nodes, 1])
        out.pen.append(float(max(-gap.min(), 0.0)))
        out.outer.append(_whole(state.x[m.outer]))
        out.inner.append(_whole(state.x[m.inner]))
        out.solid_change = max(out.solid_change, abs(m.solid_area(state.x) / m.solid_area0 - 1.0))

    targets = list(h_list) if h_list is not None else None
    if targets and targets[0] >= 2.0 * yp:
        while targets and targets[0] >= 2.0 * yp:      # above first contact: the free tube
            out.h.append(targets.pop(0))
            out.force.append(0.0)
            out.area.append(area_free)
            out.smax.append(1.0); out.smin.append(1.0); out.pen.append(0.0)
            out.outer.append(_whole(st.x[m.outer])); out.inner.append(_whole(st.x[m.inner]))
    elif targets is None:
        record(st, yp)
    dh = 0.01
    h_close = None
    while True:
        h = 2.0 * yp
        if targets is not None:
            if not targets:
                break
            goal = targets[0]
        else:
            goal = (1.0 - depth) * h_close if h_close is not None else 0.0
            if h <= goal + 1e-12:
                break
        # Steps: up to 0.02 OD on the open tube, 0.004 OD while the bore is nearly shut.
        a_last = out.area[-1] if out.area else area_free
        dh_max = 0.004 if (h_close is None and a_last < 0.15 * bore0) else (0.01 if h_close is not None else 0.02)
        step = min(dh, dh_max, h - goal)
        try:
            st2, outer_it, _ = solve_step(m, st, yp - step / 2.0, p, k_pen, pen_tol)
        except NotConverged as e:
            if step > 1e-3:
                dh = 0.5 * step
                continue
            # The static path ends here (a snap: the inner surface of the fold creasing shut).
            # Relax to the equilibrium on the other side at this plate position.
            try:
                st2, used = relax(m, st, yp - step / 2.0, p, k_pen, pen_tol)
                outer_it = 3
                out.snaps += 1
                out.newton += used
            except NotConverged:
                if h_close is None:
                    raise _SqueezeFailed("the squeeze stops converging at h = %.4f OD, before the bore closes: %s" % (h, e))
                break       # past closure: keep what was solved, extrapolate beyond
        st, yp = st2, yp - step / 2.0
        out.newton += outer_it + 1
        if targets is None or abs(2.0 * yp - targets[0]) < 1e-12:
            if targets is not None:
                targets.pop(0)
            record(st, yp)
        if targets is None and h_close is None and out.area[-1] <= CLOSED_AREA_FRACTION * bore0:
            h_close = 2.0 * yp
        dh = min(dh * 1.5, 0.02) if outer_it <= 2 else dh
        if len(out.h) > 600:
            break
    return out, m


def solve_tube(od: float, id: float, e_mpa: Optional[float] = None, nu: float = NU_DEFAULT,
               pressure_kpa: float = 0.0, shore_a: Optional[float] = None,
               nr: int = 1, nt: int = 12, grade: float = 1.0, dry: Optional["TubeResponse"] = None) -> TubeResponse:
    """Solve the pinched section of a tube od x id (mm) under a gauge pressure (kPa).

    Give e_mpa, or shore_a for Gent's relation. nr, nt: elements through the wall and around
    the quarter. dry: the zero-pressure response of the same tube, if already solved (it gives
    the pressure's share of the force and the zero-pressure closing h); solved here otherwise.
    Raises TubeFemError when the model cannot answer.
    """
    t0 = time.perf_counter()
    if e_mpa is None:
        if shore_a is None:
            raise ValueError("give e_mpa or shore_a")
        e_mpa = shore_a_to_e_mpa(shore_a)
    if not (od > id > 0.0) or e_mpa <= 0.0 or not 0.0 < nu < 0.5 or pressure_kpa < 0.0:
        raise ValueError("need od > id > 0, E > 0, 0 < nu < 0.5 and a pressure >= 0")
    ratio, p = id / od, pressure_kpa * 1e-3 / e_mpa
    try:
        wet, _ = _sweep(ratio, p, nu, nr, nt, grade)
    except _SqueezeFailed:
        # A thin wall folds tighter than this mesh resolves: once more on twice the elements around.
        wet, _ = _sweep(ratio, p, nu, nr, 2 * nt, grade)
    h_wet = np.array(wet.h)
    h_seal = _closing_h(h_wet, np.array(wet.area), ratio)
    if h_seal is None:
        raise TubeFemError("the bore did not close within the sweep")
    s, a2, fscale = od, od * od, e_mpa * od
    r = TubeResponse(
        od=float(od), id=float(id), e_mpa=float(e_mpa), nu=float(nu), pressure_kpa=float(pressure_kpa),
        h=h_wet * s, force=np.array(wet.force) * fscale, force_dry=np.array(wet.force) * fscale,
        area=np.array(wet.area) * a2, area_dry=np.array(wet.area) * a2,
        stretch_max=np.array(wet.smax), stretch_min=np.array(wet.smin), penetration=np.array(wet.pen) * s,
        outer=np.array(wet.outer) * s, inner=np.array(wet.inner) * s,
        h_contact=wet.h_contact * s, h_closed=h_seal * s, h_sealed=h_seal * s, h_min=float(h_wet[-1]) * s,
        area_free=wet.area_free * a2, solid_area_change=wet.solid_change, steps=len(h_wet),
        newton_iterations=wet.newton,
    )
    if p > 0.0:
        if dry is None:
            dry = solve_tube(od, id, e_mpa=e_mpa, nu=nu, pressure_kpa=0.0, nr=nr, nt=nt, grade=grade)
        # The zero-pressure force at the same plate distances: the difference is the pressure's
        # share. Deeper than the dry sweep went, both bores are shut and the share is zero.
        hd, fd, ad = dry.h[::-1], dry.force[::-1], dry.area[::-1]
        r.force_dry = np.where(r.h < hd[0], r.force, np.interp(r.h, hd, fd, right=0.0))
        r.area_dry = np.interp(r.h, hd, ad, left=0.0, right=dry.area_free)
        r.h_closed = dry.h_closed
        r.newton_iterations += dry.newton_iterations
    r.seconds = time.perf_counter() - t0
    return r


def _closing_h(h, area, ratio):
    """First h (descending sweep) where the open area falls under the closed threshold, interpolated."""
    thr = CLOSED_AREA_FRACTION * np.pi * (0.5 * ratio) ** 2
    below = np.nonzero(area <= thr)[0]
    if not below.size:
        return None
    i = int(below[0])
    if i == 0:
        return float(h[0])
    a0, a1 = area[i - 1], area[i]
    t = (a0 - thr) / (a0 - a1) if a0 != a1 else 1.0
    return float(h[i - 1] + t * (h[i] - h[i - 1]))


# -- cache -------------------------------------------------------------------------------
MEMORY_ENTRIES = 48       # responses kept in memory (least recently used dropped)
DISK_ENTRIES = 200        # response files kept on disk (oldest dropped), about 150 kB each
_MEM: "OrderedDict[str, dict]" = OrderedDict()
_MEM_LOCK = threading.Lock()
_KEY_LOCKS: Dict[str, threading.Lock] = {}


def _mem_get(key: str) -> Optional[dict]:
    with _MEM_LOCK:
        d = _MEM.get(key)
        if d is not None:
            _MEM.move_to_end(key)
        return d


def _mem_put(key: str, d: dict) -> None:
    with _MEM_LOCK:
        _MEM[key] = d
        _MEM.move_to_end(key)
        while len(_MEM) > MEMORY_ENTRIES:
            _MEM.popitem(last=False)


def _key_lock(key: str) -> threading.Lock:
    with _MEM_LOCK:
        return _KEY_LOCKS.setdefault(key, threading.Lock())


def _prune_disk(cache_dir: str) -> None:
    try:
        files = [os.path.join(cache_dir, n) for n in os.listdir(cache_dir) if n.startswith("tube_") and n.endswith(".json")]
        files.sort(key=os.path.getmtime)
        for f in files[:max(len(files) - DISK_ENTRIES, 0)]:
            os.remove(f)
    except OSError:
        pass


def _cached(key: str, cache_dir: Optional[str], solve) -> TubeResponse:
    """Memory, then disk (cache_dir), then solve() -> TubeResponse. One solve per key at a time:
    a slider drag that sends the same request twice waits for the first answer; other keys and
    cached reads do not wait."""
    d = _mem_get(key)
    if d is None:
        try:
            with _key_lock(key):
                d = _mem_get(key)
                path = os.path.join(cache_dir, "tube_" + hashlib.sha1(key.encode()).hexdigest()[:16] + ".json") if cache_dir else None
                if d is None and path:
                    try:
                        with open(path) as fh:
                            d = json.load(fh)
                        if d.get("key") != key:
                            d = None
                    except (OSError, ValueError):
                        d = None
                if d is None:
                    d = {"key": key, "response": solve().to_dict()}
                    if path:
                        try:
                            os.makedirs(cache_dir, exist_ok=True)
                            fd, tmp = tempfile.mkstemp(dir=cache_dir, suffix=".tmp")
                            with os.fdopen(fd, "w") as fh:
                                json.dump(d, fh)
                            os.replace(tmp, path)
                            _prune_disk(cache_dir)
                        except OSError:
                            pass
                _mem_put(key, d)
        finally:
            with _MEM_LOCK:
                _KEY_LOCKS.pop(key, None)       # later callers find the answer in memory
    return TubeResponse.from_dict(d["response"])


def solve_tube_cached(od: float, id: float, e_mpa: Optional[float] = None, nu: float = NU_DEFAULT,
                      pressure_kpa: float = 0.0, shore_a: Optional[float] = None,
                      cache_dir: Optional[str] = None, nr: int = 1, nt: int = 12, grade: float = 1.0) -> TubeResponse:
    """solve_tube on the dimensionless parameters, rounded (ID/OD to 1e-4, p/E to 1e-5), cached.

    The response depends only on ID/OD, p/E and nu: it is solved once with OD = 1 and E = 1 and
    scaled. The zero-pressure sweep is cached on its own, so a new pressure costs one sweep.
    Kept in memory (MEMORY_ENTRIES, least recently used dropped) and on disk as JSON in
    cache_dir when given (written atomically, the oldest beyond DISK_ENTRIES removed; an
    unwritable directory is skipped silently). Errors are not cached.
    """
    if e_mpa is None:
        if shore_a is None:
            raise ValueError("give e_mpa or shore_a")
        e_mpa = shore_a_to_e_mpa(shore_a)
    if not (od > id > 0.0) or e_mpa <= 0.0:
        raise ValueError("need od > id > 0 and E > 0")
    ratio = round(id / od, 4)
    p_e = max(round(pressure_kpa * 1e-3 / e_mpa, 5), 0.0)
    tag = "v%d_r%.4f_nu%.4f_m%dx%dg%.2f" % (SOLVER_VERSION, ratio, nu, nr, nt, grade)
    mesh = dict(nr=nr, nt=nt, grade=grade)
    dry = _cached(tag + "_p0", cache_dir, lambda: solve_tube(1.0, ratio, e_mpa=1.0, nu=nu, pressure_kpa=0.0, **mesh))
    r = dry if p_e == 0.0 else _cached(
        tag + "_p%.5f" % p_e, cache_dir,
        lambda: solve_tube(1.0, ratio, e_mpa=1.0, nu=nu, pressure_kpa=p_e * 1e3, dry=dry, **mesh))
    return _scaled(r, od, e_mpa, pressure_kpa)


def _scaled(r: TubeResponse, od: float, e_mpa: float, pressure_kpa: float) -> TubeResponse:
    s, a2, f = od, od * od, e_mpa * od
    return TubeResponse(
        od=od, id=r.id * s, e_mpa=e_mpa, nu=r.nu, pressure_kpa=pressure_kpa,
        h=r.h * s, force=r.force * f, force_dry=r.force_dry * f, area=r.area * a2, area_dry=r.area_dry * a2,
        stretch_max=r.stretch_max, stretch_min=r.stretch_min, penetration=r.penetration * s,
        outer=r.outer * s, inner=r.inner * s, h_contact=r.h_contact * s, h_closed=r.h_closed * s,
        h_sealed=r.h_sealed * s, h_min=r.h_min * s, area_free=r.area_free * a2,
        solid_area_change=r.solid_area_change, steps=r.steps, newton_iterations=r.newton_iterations, seconds=r.seconds,
    )
