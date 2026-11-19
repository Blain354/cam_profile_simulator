"""Pressures in psi, from before every pressure was in kPa.

Saved profiles, the legacy `configs/*.json` files and old clients still carry pressures in
psi under the old field names. `legacy_psi_to_kpa` is the one place they become kPa: it runs on
every request body that used to accept a psi field and on every profile payload served, and
never rewrites a stored row. Saving afterwards stores kPa.
"""

from typing import Any

PSI_TO_KPA = 6.894757

# Old key -> new key, wherever it sits in a payload.
LEGACY_PSI_KEYS = {
    "input_pressure_psi": "input_pressure_kpa",      # cam, solver, STL export and linkage parameters
    "seal_pressure_y0_psi": "seal_pressure_y0_kpa",  # linkage result
    "pressurePsi": "pressureKpa",                    # Profile Builder state saved in builder_params
}


def legacy_psi_to_kpa(value: Any) -> Any:
    """A copy of `value` with every legacy psi key, at any depth, renamed and converted to kPa.

    Idempotent: a payload that has the kPa key keeps it, and a psi key next to it is dropped.
    """
    if isinstance(value, list):
        return [legacy_psi_to_kpa(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: legacy_psi_to_kpa(v) for k, v in value.items() if k not in LEGACY_PSI_KEYS}
    for psi_key, kpa_key in LEGACY_PSI_KEYS.items():
        if psi_key in value and kpa_key not in value:
            old = value[psi_key]
            is_number = isinstance(old, (int, float)) and not isinstance(old, bool)
            out[kpa_key] = old * PSI_TO_KPA if is_number else old
    return out
