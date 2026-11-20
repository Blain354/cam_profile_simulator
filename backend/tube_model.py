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
REFERENCE_KPA = 100.0     # pressure used for held_kpa's slope when the line pressure is 0


class TubeModelError(ValueError):
    """The FEM cannot answer for this tube (for example it balloons at this pressure)."""


def uses_fem(params) -> bool:
    return getattr(params, "tube_model", MODEL_SIMPLE) == MODEL_FEM


def cache_dir() -> str:
    return str(default_db_path().parent / "tube_fem_cache")


@dataclass(frozen=True)
class FemLaw:
    response: "tube_fem.TubeResponse"
    reference: "tube_fem.TubeResponse"    # the same tube at REFERENCE_KPA, for held_kpa when p = 0
    closed_gap: float
    full_open_gap: float
    bore: float

    @property
    def e_mpa(self) -> float:
        return self.response.e_mpa

    def area(self, h) -> np.ndarray:
        """Open bore (mm^2): 0 at and below the closed gap, at most the unloaded bore."""
        h = np.asarray(h, dtype=float)
        return np.where(h > self.closed_gap, np.minimum(self.response.open_area(h), self.bore), 0.0)

    def slices(self, h) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        r = self.response
        # Like the simple model, the law stops at 95 % squeeze of the double wall: a pin driven
        # further is a jam (the linkage reports it), not a force to compute.
        h = np.maximum(np.asarray(h, dtype=float), 0.05 * (r.od - r.id))
        dry = r.force_dry_per_mm(h)
        folded = r.force_dry_per_mm(np.maximum(h, r.h_closed))
        # The air only pushes the walls apart: a negative share is interpolation noise past closure.
        return folded, dry - folded, np.maximum(r.force_per_mm(h) - dry, 0.0)

    def held_kpa(self, h) -> np.ndarray:
        ref = self.response if self.response.pressure_kpa > 0 else self.reference
        span = max(ref.h_closed - ref.h_sealed, 1e-9)
        return np.clip((ref.h_closed - np.asarray(h, dtype=float)) / span, 0.0, None) * ref.pressure_kpa


def _shore(params) -> float:
    return float(getattr(params, "tube_shore_a", DEFAULT_SHORE_A))


def law(params) -> FemLaw:
    """FEM law for params.tube_od, tube_id, tube_shore_a, input_pressure_kpa. Raises TubeModelError."""
    return _law(float(params.tube_od), float(params.tube_id), _shore(params), max(float(params.input_pressure_kpa), 0.0))


def _solve(od, id_, shore, kpa):
    try:
        return tube_fem.solve_tube_cached(od, id_, shore_a=shore, pressure_kpa=kpa, cache_dir=cache_dir())
    except (tube_fem.TubeFemError, ValueError) as e:
        raise TubeModelError("Tube FEM (%.2f x %.2f mm, Shore %.0f, %.0f kPa): %s" % (od, id_, shore, kpa, e)) from e


@lru_cache(maxsize=64)
def _law(od: float, id_: float, shore: float, kpa: float) -> FemLaw:
    r = _solve(od, id_, shore, kpa)
    ref = r if kpa > 0 else _solve(od, id_, shore, REFERENCE_KPA)
    bore = float(np.pi * (id_ / 2.0) ** 2)
    hs, a = r.h[::-1], np.minimum(r.area[::-1], bore)
    above = np.nonzero(a >= FULL_OPEN_FRACTION * bore)[0]
    if above.size:
        i = int(above[0])
        full = float(np.interp(FULL_OPEN_FRACTION * bore, a[max(i - 1, 0):i + 1], hs[max(i - 1, 0):i + 1])) if i > 0 else float(hs[0])
    else:
        full = float(r.h_contact)
    return FemLaw(response=r, reference=ref, closed_gap=float(r.h_sealed), full_open_gap=full, bore=bore)


def section(params, h: float) -> dict:
    """Deformed section at plate distance h, for the "Tube section" card."""
    fl = law(params)
    r = fl.response
    shape = r.shape(h)
    return {
        "h": float(h),
        "outer": shape["outer"],
        "inner": shape["inner"],
        "force_per_mm": float(sum(fl.slices(np.array([h])))[0]),
        "pressure_share_per_mm": float(fl.slices(np.array([h]))[2][0]),
        "open_area_mm2": float(fl.area(h)),
        "bore_area_mm2": fl.bore,
        "h_contact": float(r.h_contact),
        "h_closed": float(r.h_closed),
        "h_sealed": float(r.h_sealed),
        "full_open_gap": fl.full_open_gap,
        "h_min_solved": float(r.h_min),
        "e_mpa": float(r.e_mpa),
        "max_stretch": float(np.interp(h, r.h[::-1], r.stretch_max[::-1])),
    }
