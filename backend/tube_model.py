"""The one adapter between the app and the tube finite-element package (tube_fem).

Every model that squeezes the tube (linkage tabs, cam tab, profile solver) asks this module
for the tube's law when its params say tube_model == "fem". With "simple" they keep their
own empirical law (compliance in mm/MPa). To unplug the FEM: delete backend/tube_fem/ and
this file, and the `if tube_model.uses_fem(...)` branches that call it.

What the FEM gives the rest of the code (all at the line pressure):
  closed_gap      the plate distance at which the bore closes against that pressure
  full_open_gap   the plate distance at which the bore is back to FULL_OPEN_FRACTION of its
                  unloaded area (the last few percent only come as the tube gets round again)
  area(h)         open bore, capped at the unloaded bore pi (ID/2)^2 like the simple model
  slices(h)       force per mm of tube split in three, so the existing result fields keep a
                  meaning: flatten = zero-pressure force up to closure, squeeze = the extra
                  zero-pressure force past closure, pressure = what the air adds
  held_kpa(h)     pressure a section squeezed to h still seals: linear between the closing h
                  with no pressure (seals 0) and the closing h at the line pressure

The FEM is solved at grid pressures PRESSURE_STEP of p/E apart and blended linearly in between,
so dragging the pressure or hardness slider solves a new tube only every few kPa.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import Tuple

import numpy as np

try:
    import tube_fem
    from storage import default_db_path
except ImportError:  # imported as backend.tube_model (tests)
    from . import tube_fem
    from .storage import default_db_path

MODEL_FEM = "fem"
MODEL_SIMPLE = "simple"
DEFAULT_TUBE_MODEL = MODEL_FEM
DEFAULT_SHORE_A = 50.0
FULL_OPEN_FRACTION = 0.95
REFERENCE_PE = 0.04       # p/E for held_kpa's slope when the line pressure is 0 (100 kPa at Shore 50),
                          # at most half the pressure at which the tube balloons
PRESSURE_STEP = 0.005     # p/E between two solved pressures (12 kPa at Shore 50); linear in between


class TubeModelError(ValueError):
    """The FEM cannot answer for this tube (for example it balloons at this pressure)."""


def uses_fem(params) -> bool:
    return getattr(params, "tube_model", MODEL_SIMPLE) == MODEL_FEM


def cache_dir() -> str:
    return str(default_db_path().parent / "tube_fem_cache")


@dataclass(frozen=True)
class FemLaw:
    """The FEM tube at one line pressure: a blend of the solved responses at the two grid
    pressures around it (PRESSURE_STEP of p/E apart), so a pressure or hardness slider drag
    solves a new tube only every few kPa and reads the cache in between."""
    parts: Tuple[Tuple[float, "tube_fem.TubeResponse"], ...]   # (weight, response), weights sum to 1
    kpa: float
    reference: "tube_fem.TubeResponse"    # the same tube at REFERENCE_PE, for held_kpa when p = 0
    closed_gap: float
    full_open_gap: float
    bore: float

    @property
    def response(self) -> "tube_fem.TubeResponse":
        """The nearest solved response (its zero-pressure data are the same for all parts)."""
        return max(self.parts, key=lambda wr: wr[0])[1]

    @property
    def e_mpa(self) -> float:
        return self.response.e_mpa

    def _mix(self, f) -> np.ndarray:
        return sum(w * np.asarray(f(r), dtype=float) for w, r in self.parts)

    def open_area(self, h) -> np.ndarray:
        return np.minimum(self._mix(lambda r: r.open_area(h)), self.bore)

    def area(self, h) -> np.ndarray:
        """Open bore (mm^2): 0 at and below the closed gap, at most the unloaded bore."""
        h = np.asarray(h, dtype=float)
        return np.where(h > self.closed_gap, self.open_area(h), 0.0)

    def slices(self, h) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        r = self.response
        # Like the simple model, the law stops at 95 % squeeze of the double wall: a pin driven
        # further is a jam (the linkage reports it), not a force to compute.
        h = np.maximum(np.asarray(h, dtype=float), 0.05 * (r.od - r.id))
        dry = r.force_dry_per_mm(h)
        folded = r.force_dry_per_mm(np.maximum(h, r.h_closed))
        # The air only pushes the walls apart: a negative share is interpolation noise past closure.
        return folded, dry - folded, np.maximum(self._mix(lambda q: q.force_per_mm(h)) - dry, 0.0)

    def held_kpa(self, h) -> np.ndarray:
        h_closed = self.response.h_closed
        if self.kpa > 0:
            sealed, kpa = self.closed_gap, self.kpa
        else:
            sealed, kpa = self.reference.h_sealed, self.reference.pressure_kpa
        span = max(h_closed - sealed, 1e-9)
        return np.clip((h_closed - np.asarray(h, dtype=float)) / span, 0.0, None) * kpa


def _shore(params) -> float:
    return float(getattr(params, "tube_shore_a", DEFAULT_SHORE_A))


def law(params) -> FemLaw:
    """FEM law for params.tube_od, tube_id, tube_shore_a, input_pressure_kpa. Raises TubeModelError."""
    return _law(float(params.tube_od), float(params.tube_id), _shore(params), max(float(params.input_pressure_kpa), 0.0))


def _solve(od, id_, e, kpa, shore, asked):
    """The cached FEM response at kpa; an error names the pressure the user asked for (asked)."""
    try:
        return tube_fem.solve_tube_cached(od, id_, e_mpa=e, pressure_kpa=kpa, cache_dir=cache_dir())
    except (tube_fem.TubeFemError, ValueError) as err:
        raise TubeModelError("Tube FEM (%.2f x %.2f mm, Shore %.0f, %.0f kPa): %s" % (od, id_, shore, asked, err)) from err


@lru_cache(maxsize=64)
def _law(od: float, id_: float, shore: float, kpa: float) -> FemLaw:
    try:
        e = tube_fem.shore_a_to_e_mpa(shore)
    except ValueError as err:
        raise TubeModelError(str(err)) from err
    pe = kpa * 1e-3 / e
    lo = np.floor(pe / PRESSURE_STEP + 1e-9) * PRESSURE_STEP
    w = (pe - lo) / PRESSURE_STEP
    grid = [(1.0 - w, lo)] + ([(w, lo + PRESSURE_STEP)] if w > 1e-6 else [])
    parts = tuple((float(wt), _solve(od, id_, e, p * e * 1e3, shore, kpa)) for wt, p in grid)
    if kpa > 0:
        ref = parts[0][1]
    else:
        # A soft tube balloons near mu ln(OD/ID): keep the reference pressure well under that.
        balloon = np.log(od / id_) / (2.0 * (1.0 + tube_fem.NU_DEFAULT))
        ref = _solve(od, id_, e, min(REFERENCE_PE, 0.5 * balloon) * e * 1e3, shore, kpa)
    bore = float(np.pi * (id_ / 2.0) ** 2)
    closed = float(sum(wt * r.h_sealed for wt, r in parts))
    draft = FemLaw(parts=parts, kpa=kpa, reference=ref, closed_gap=closed, full_open_gap=od, bore=bore)
    # Full bore: the first plate distance (opening up) where the blended bore is back to FULL_OPEN_FRACTION.
    top = max(r.h_contact for _, r in parts)
    hs = np.linspace(closed, top, 801)
    above = np.nonzero(draft.open_area(hs) >= FULL_OPEN_FRACTION * bore)[0]
    full = float(hs[above[0]]) if above.size else float(top)
    return FemLaw(parts=parts, kpa=kpa, reference=ref, closed_gap=closed, full_open_gap=full, bore=bore)


def section(params, h: float) -> dict:
    """Deformed section at plate distance h, for the "Tube section" card."""
    fl = law(params)
    r = fl.response
    shapes = [(w, q.shape(h)) for w, q in fl.parts]
    mix = lambda k: sum(w * np.array(s[k]) for w, s in shapes).tolist()
    parts = fl.slices(np.array([h]))
    return {
        "h": float(h),
        "outer": mix("outer"),
        "inner": mix("inner"),
        "force_per_mm": float(sum(parts)[0]),
        "pressure_share_per_mm": float(parts[2][0]),
        "open_area_mm2": float(fl.area(h)),
        "bore_area_mm2": fl.bore,
        "h_contact": float(sum(w * q.h_contact for w, q in fl.parts)),
        "h_closed": float(r.h_closed),
        "h_sealed": fl.closed_gap,
        "full_open_gap": fl.full_open_gap,
        "h_min_solved": float(min(q.h_min for _, q in fl.parts)),
        "e_mpa": float(r.e_mpa),
        "max_stretch": float(np.interp(h, r.h[::-1], r.stretch_max[::-1])),
    }


def _quarter(outline: np.ndarray, n: int) -> np.ndarray:
    """The first quarter of a whole outline (from the x axis to the y axis), as n points.

    Kept by node (material points, so a blend between two plate distances stays physical);
    resampled by arc length only when the mesh has another node count (a thin wall solved on a
    finer mesh)."""
    q = outline[: (len(outline) + 3) // 4]
    if len(q) == n:
        return q
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(q, axis=0).T))])
    t = np.linspace(0.0, s[-1], n)
    return np.column_stack([np.interp(t, s, q[:, 0]), np.interp(t, s, q[:, 1])])


SWEEP_DEEP_STEPS = 12     # force-only samples below the deepest solved step, down to the law's floor


def sweep(params) -> dict:
    """Everything the tube drawings need for one tube, sent once and interpolated in the browser.

    h: the solved plate distances (decreasing), from first contact to the deepest step solved.
    outer, inner: at each h, the quarter outline (x >= 0, y >= 0, from the x axis to the y axis)
    flattened to [x0, y0, x1, y1, ...], n points; the whole section is that quarter mirrored on
    both axes. force_per_mm, pressure_share_per_mm, open_area_mm2 at each h, as section() gives
    them. deep: force samples below h_min_solved (extrapolated, no shape)."""
    fl = law(params)
    r = fl.response
    n = (len(r.outer[0]) + 3) // 4
    hs = r.h[r.h >= min(q.h_min for _, q in fl.parts) - 1e-12]
    outer, inner = [], []
    for h in hs:
        mix = lambda k: sum(w * _quarter(np.array(q.shape(h)[k]), n) for w, q in fl.parts)
        outer.append(mix("outer"))
        inner.append(mix("inner"))
    sl = fl.slices(hs)
    floor = 0.05 * (r.od - r.id)
    deep = np.geomspace(hs[-1], floor, SWEEP_DEEP_STEPS + 1)[1:] if hs[-1] > floor else np.array([])
    dl = fl.slices(deep)
    g = lambda a: [float("%.5g" % v) for v in np.asarray(a, dtype=float)]
    flat = lambda qs: [[round(float(v), 4) for v in q.ravel()] for q in qs]
    return {
        "od": float(r.od), "id": float(r.id), "e_mpa": float(r.e_mpa), "pressure_kpa": fl.kpa,
        "bore_area_mm2": fl.bore,
        "h_contact": float(sum(w * q.h_contact for w, q in fl.parts)),
        "h_closed": float(r.h_closed),
        "h_sealed": fl.closed_gap,
        "full_open_gap": fl.full_open_gap,
        "h_min_solved": float(hs[-1]),
        "n": n,
        "h": g(hs),
        "force_per_mm": g(sum(sl)),
        "pressure_share_per_mm": g(sl[2]),
        "open_area_mm2": g(fl.area(hs)),
        "outer": flat(outer),
        "inner": flat(inner),
        "deep": {"h": g(deep), "force_per_mm": g(sum(dl)) if len(deep) else [], "pressure_share_per_mm": g(dl[2]) if len(deep) else []},
    }
