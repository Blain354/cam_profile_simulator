"""
Onshape STL export pipeline for the cam profile simulator.

Implements the workflow documented in the OpenClaw `onshape` skill
(`~/.openclaw/workspace/skills/onshape/SKILL.md`):

    1. HMAC-SHA256 sign every API call (Onshape doesn't use Bearer tokens).
    2. Push the cam configuration to a Variable Studio (or Part Studio
       configuration) so the parametric CAD model reflects the simulator
       values.
    3. Kick off an STL translation job on the Part Studio.
    4. Poll the translation status until DONE.
    5. Download the resulting STL blob.

This module is consumed by `main.py` via the streaming `/api/export/stl-stream`
endpoint, which surfaces every stage as a granular progress event.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import os
import random
import string
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional


ONSHAPE_BASE_URL = os.environ.get("ONSHAPE_BASE_URL", "https://cad.onshape.com")
ONSHAPE_API_VERSION = "/api/v10"


def _load_secret_env() -> None:
    """Best-effort load of ~/.openclaw/secrets/onshape.env when present.

    In Docker the secrets are normally injected through `ONSHAPE_ACCESS_KEY` /
    `ONSHAPE_SECRET_KEY`; on a dev host we transparently reuse the file the
    OpenClaw skill maintains so the developer doesn't have to duplicate keys.
    """
    candidate = Path.home() / ".openclaw" / "secrets" / "onshape.env"
    if not candidate.exists():
        return
    try:
        for raw in candidate.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
    except OSError:
        pass


_load_secret_env()


class OnshapeConfigError(RuntimeError):
    """Raised when Onshape credentials or document identifiers are missing."""


class OnshapeAPIError(RuntimeError):
    """Raised when the Onshape API rejects a signed request."""

    def __init__(self, status: int, message: str, payload: Optional[dict] = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.payload = payload


@dataclass
class OnshapeTarget:
    """Resolved identifiers + variable mapping for one export target."""

    document_id: str
    workspace_id: str
    element_id: str
    part_id: Optional[str] = None
    # Optional Variable Studio element id (legacy — unused for the
    # core_top pipeline which targets Part Studio assignVariable features).
    variable_element_id: Optional[str] = None
    # Mapping {variable_name_in_onshape: simulator_param_key}. Values not
    # found in the request payload are skipped silently.
    variable_mapping: dict[str, str] = field(default_factory=dict)
    # Optional units suffix applied to numeric values when pushed to
    # Onshape (e.g. "mm", "deg"). Falls back to "mm" for all sim params.
    variable_units: dict[str, str] = field(default_factory=dict)
    # Configuration parameter id (e.g. "List_5YUX9CqkMmZNVb") together
    # with the enum value we want to load before exporting. When both
    # are set:
    #   • push_variables only overwrites the corresponding configured
    #     entry on every targeted assignVariable feature.
    #   • the STL export adds `configuration=<id>=<value>` so Onshape
    #     regenerates the model with that variant.
    # This lets the automation pipeline coexist with manual work on the
    # default configuration without ever clobbering it.
    config_parameter_id: Optional[str] = None
    config_enum_value: Optional[str] = None


def _default_target() -> OnshapeTarget:
    """Build an `OnshapeTarget` from environment variables.

    Required env: ONSHAPE_DOCUMENT_ID, ONSHAPE_WORKSPACE_ID, ONSHAPE_ELEMENT_ID.
    Optional:     ONSHAPE_PART_ID, ONSHAPE_VARIABLE_ELEMENT_ID,
                  ONSHAPE_VARIABLE_MAPPING  (JSON object — Onshape name -> sim key),
                  ONSHAPE_VARIABLE_UNITS    (JSON object — sim key       -> unit).
    """
    did = os.environ.get("ONSHAPE_DOCUMENT_ID", "").strip()
    wid = os.environ.get("ONSHAPE_WORKSPACE_ID", "").strip()
    eid = os.environ.get("ONSHAPE_ELEMENT_ID", "").strip()
    if not (did and wid and eid):
        raise OnshapeConfigError(
            "Missing Onshape identifiers. Set ONSHAPE_DOCUMENT_ID, "
            "ONSHAPE_WORKSPACE_ID and ONSHAPE_ELEMENT_ID in the backend env."
        )

    raw_map = os.environ.get("ONSHAPE_VARIABLE_MAPPING", "").strip()
    if raw_map:
        try:
            mapping = json.loads(raw_map)
            if not isinstance(mapping, dict):
                raise ValueError("must be a JSON object")
        except (json.JSONDecodeError, ValueError) as exc:
            raise OnshapeConfigError(
                f"ONSHAPE_VARIABLE_MAPPING is not valid JSON: {exc}"
            ) from exc
    else:
        # Defaults are tailored for the Minivalve / core_top use case —
        # they map the cam profile parameters that drive the geometry of
        # core_top onto the `ctrl_*` assignVariable features inside the
        # Part Studio.
        mapping = {
            "ctrl_deadband": "deadband",
            "ctrl_exp_profile_length": "height",
            "ctrl_exp_profile_K": "K",
            "ctrl_default_distance": "default_distance",
        }

    raw_units = os.environ.get("ONSHAPE_VARIABLE_UNITS", "").strip()
    units: dict[str, str] = {}
    if raw_units:
        try:
            parsed = json.loads(raw_units)
            if isinstance(parsed, dict):
                units = {str(k): str(v) for k, v in parsed.items()}
        except json.JSONDecodeError as exc:
            raise OnshapeConfigError(
                f"ONSHAPE_VARIABLE_UNITS is not valid JSON: {exc}"
            ) from exc

    return OnshapeTarget(
        document_id=did,
        workspace_id=wid,
        element_id=eid,
        part_id=os.environ.get("ONSHAPE_PART_ID", "").strip() or None,
        variable_element_id=os.environ.get("ONSHAPE_VARIABLE_ELEMENT_ID", "").strip() or None,
        variable_mapping=mapping,
        variable_units=units,
        config_parameter_id=os.environ.get("ONSHAPE_CONFIG_PARAMETER_ID", "").strip() or None,
        config_enum_value=os.environ.get("ONSHAPE_CONFIG_ENUM_VALUE", "").strip() or None,
    )


# ── HMAC-signed transport ────────────────────────────────────────────────────


def _nonce() -> str:
    chars = string.digits + string.ascii_letters
    return "".join(random.choice(chars) for _ in range(25))


def _date_header() -> str:
    return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def _sign(method: str, nonce: str, date: str, content_type: str, pathname: str, query: str, secret: str) -> str:
    raw = (
        f"{method}\n{nonce}\n{date}\n{content_type}\n{pathname}\n{query}\n"
    ).lower().encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


@dataclass
class _RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes


def _request(
    method: str,
    path: str,
    *,
    query: Optional[dict[str, Any]] = None,
    body: Optional[dict] = None,
    accept: str = "application/json;charset=UTF-8;qs=0.09",
    follow_redirects: bool = True,
) -> _RawResponse:
    """Low-level signed HTTP call. Returns raw bytes so binary endpoints (STL
    blob, redirected CloudFront URL) can be consumed by the caller."""
    access_key = os.environ.get("ONSHAPE_ACCESS_KEY", "").strip()
    secret_key = os.environ.get("ONSHAPE_SECRET_KEY", "").strip()
    if not access_key or not secret_key:
        raise OnshapeConfigError(
            "Onshape API keys missing. Set ONSHAPE_ACCESS_KEY and "
            "ONSHAPE_SECRET_KEY (see ~/.openclaw/secrets/onshape.env)."
        )

    if not path.startswith("/"):
        path = "/" + path
    pathname = ONSHAPE_API_VERSION + path
    query_string = ""
    if query:
        # Sorted for signature stability across re-runs.
        items = [(k, v) for k, v in query.items() if v is not None]
        query_string = urllib.parse.urlencode(items, doseq=True)

    url = ONSHAPE_BASE_URL + pathname + (f"?{query_string}" if query_string else "")

    nonce = _nonce()
    date = _date_header()
    content_type = "application/json"
    signature = _sign(method, nonce, date, content_type, pathname, query_string, secret_key)

    headers = {
        "Date": date,
        "On-Nonce": nonce,
        "Authorization": f"On {access_key}:HmacSHA256:{signature}",
        "Content-Type": content_type,
        "Accept": accept,
    }

    data = json.dumps(body).encode("utf-8") if body is not None else None

    # Onshape redirects binary downloads (STL, externaldata) to presigned
    # CDN URLs (CloudFront / S3). urllib's default redirect handler
    # forwards the `Authorization: On ...` header, which the CDN refuses
    # with 401. We always intercept 3xx manually and re-issue the GET
    # against the Location URL *without* auth headers.

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    opener = urllib.request.build_opener(_NoRedirect())
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    def _do_open(r):
        try:
            with opener.open(r, timeout=120) as resp:
                return _RawResponse(
                    status=resp.status,
                    headers={k: v for k, v in resp.headers.items()},
                    body=resp.read(),
                )
        except urllib.error.HTTPError as exc:
            raw = b""
            try:
                raw = exc.read()
            except Exception:
                pass
            return _RawResponse(
                status=exc.code,
                headers={k: v for k, v in (exc.headers.items() if exc.headers else [])},
                body=raw,
            )

    resp = _do_open(req)

    if follow_redirects and 300 <= resp.status < 400:
        location = resp.headers.get("Location") or resp.headers.get("location")
        if location:
            parsed = urllib.parse.urlsplit(location)
            host = (parsed.hostname or "").lower()
            if host.endswith("onshape.com"):
                # Same auth scheme, different region host (e.g.
                # cad-usw2.onshape.com/modelexport). Re-sign for the
                # redirected pathname + query string.
                new_pathname = parsed.path
                new_query = parsed.query  # raw, preserving order
                new_method = "GET"
                new_nonce = _nonce()
                new_date = _date_header()
                new_sig = _sign(new_method, new_nonce, new_date, content_type, new_pathname, new_query, secret_key)
                new_headers = {
                    "Date": new_date,
                    "On-Nonce": new_nonce,
                    "Authorization": f"On {access_key}:HmacSHA256:{new_sig}",
                    "Content-Type": content_type,
                    "Accept": "application/octet-stream",
                }
                req2 = urllib.request.Request(location, headers=new_headers, method=new_method)
                resp2 = _do_open(req2)
                # The redirected Onshape host may itself redirect to a
                # CDN. Recurse once more (without auth) if so.
                if 300 <= resp2.status < 400:
                    loc2 = resp2.headers.get("Location") or resp2.headers.get("location")
                    if loc2:
                        plain_req = urllib.request.Request(loc2, method="GET")
                        try:
                            with urllib.request.urlopen(plain_req, timeout=120) as cdn_resp:
                                return _RawResponse(
                                    status=cdn_resp.status,
                                    headers={k: v for k, v in cdn_resp.headers.items()},
                                    body=cdn_resp.read(),
                                )
                        except urllib.error.HTTPError as cdn_exc:
                            raise OnshapeAPIError(cdn_exc.code, f"CDN redirect failed ({cdn_exc.reason})", None) from cdn_exc
                if resp2.status >= 400:
                    raise OnshapeAPIError(resp2.status, f"Redirected request failed (HTTP {resp2.status})", None)
                return resp2

            # Non-onshape host (CDN/S3): strip auth.
            plain_req = urllib.request.Request(location, method="GET")
            try:
                with urllib.request.urlopen(plain_req, timeout=120) as cdn_resp:
                    return _RawResponse(
                        status=cdn_resp.status,
                        headers={k: v for k, v in cdn_resp.headers.items()},
                        body=cdn_resp.read(),
                    )
            except urllib.error.HTTPError as cdn_exc:
                raise OnshapeAPIError(cdn_exc.code, f"CDN redirect failed ({cdn_exc.reason})", None) from cdn_exc

    if resp.status >= 400:
        payload: Optional[dict] = None
        try:
            payload = json.loads(resp.body.decode("utf-8"))
        except Exception:
            payload = None
        raise OnshapeAPIError(resp.status, payload.get("message") if isinstance(payload, dict) and payload.get("message") else f"HTTP {resp.status}", payload)

    return resp


def _request_json(method: str, path: str, *, query: Optional[dict] = None, body: Optional[dict] = None) -> Any:
    resp = _request(method, path, query=query, body=body)
    if not resp.body:
        return None
    try:
        return json.loads(resp.body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise OnshapeAPIError(resp.status, f"non-JSON response: {exc}") from exc


# ── High-level pipeline ──────────────────────────────────────────────────────


ProgressFn = Callable[[int, str, Optional[dict]], None]


def _expr_for(value: Any, unit: str) -> str:
    if isinstance(value, (int, float)) and unit:
        return f"{value} {unit}"
    return str(value)


# Onshape variable names whose expressions are pure numbers (no unit).
# Anything ending in `_K`, `_k`, or in this explicit set will be pushed
# without a `mm` suffix even if the simulator value is numeric.
_DIMENSIONLESS_HINTS = {"_k", "_K", "_factor", "_ratio", "_count", "_steps"}


def _is_dimensionless(on_name: str, units: dict[str, str], sim_key: str) -> bool:
    if sim_key in units:
        return units[sim_key] == ""
    lower = on_name.lower()
    return any(h.lower() in lower for h in _DIMENSIONLESS_HINTS)


def _build_overrides(params: dict, target: OnshapeTarget) -> dict[str, str]:
    out: dict[str, str] = {}
    for on_name, sim_key in target.variable_mapping.items():
        if sim_key not in params:
            continue
        value = params[sim_key]
        if value is None:
            continue
        if _is_dimensionless(on_name, target.variable_units, sim_key):
            unit = ""
        else:
            unit = target.variable_units.get(sim_key, "mm" if isinstance(value, (int, float)) else "")
        out[on_name] = _expr_for(value, unit)
    return out


_VARIABLE_QUANTITY_PARAM = {
    "LENGTH": "lengthValue",
    "ANGLE": "angleValue",
    "NUMBER": "numberValue",
    "ANY": "anyValue",
}


def _patch_assign_variable_expression(
    feature: dict,
    new_expression: str,
    *,
    only_enum_value: Optional[str] = None,
) -> bool:
    """Mutate a copy of an `assignVariable` feature so its declared value
    becomes `new_expression`. Returns True if at least one entry was
    patched.

    When `only_enum_value` is set and the parameter is `BTMParameterConfigured`,
    only the configured entry whose `enumValue == only_enum_value` is
    overwritten — the other configurations are left untouched. This is
    how the automation pipeline keeps its scratch values isolated from
    the user's manual default/100/200/300 RPM tuning.

    If the parameter is a flat `BTMParameterQuantity` we still overwrite
    it (there are no per-config slots to choose from).
    """
    params = feature.get("parameters", [])
    var_type = next((p.get("value") for p in params if p.get("parameterId") == "variableType"), "LENGTH")
    target_pid = _VARIABLE_QUANTITY_PARAM.get(var_type, "lengthValue")
    patched = False
    for p in params:
        if p.get("parameterId") != target_pid:
            continue
        bt = p.get("btType", "")
        if bt.startswith("BTMParameterConfigured"):
            for entry in p.get("values", []):
                if only_enum_value is not None and entry.get("enumValue") != only_enum_value:
                    continue
                inner = entry.get("value")
                if isinstance(inner, dict) and "expression" in inner:
                    inner["expression"] = new_expression
                    patched = True
        else:
            if "expression" in p:
                p["expression"] = new_expression
                patched = True
    return patched


def push_variables(target: OnshapeTarget, params: dict, *, progress: Optional[ProgressFn] = None) -> int:
    """Update the `assignVariable` Part Studio features that match our mapping.

    Onshape exposes Part Studio internal variables (the `ctrl_*` family in
    this project) as full feature definitions — not as Variable Studio
    entries. Mutating them requires:

      1. GET /partstudios/{...}/features — snapshot every feature.
      2. For each matching `assignVariable` feature, deep-copy it and
         replace the relevant `expression` (or every configured value).
      3. POST /partstudios/{...}/features/featureid/{fid} with the
         wrapped `BTFeatureDefinitionCall-1406` payload.

    Returns the number of features successfully updated.
    """
    overrides = _build_overrides(params, target)
    if progress:
        progress(15, f"Resolving Part Studio variables (overrides: {len(overrides)})…", {"count": len(overrides)})
    if not overrides:
        return 0

    feats_resp = _request_json(
        "GET",
        f"/partstudios/d/{target.document_id}/w/{target.workspace_id}/e/{target.element_id}/features",
    )
    all_feats = feats_resp.get("features", []) if isinstance(feats_resp, dict) else []

    # Build {variable_name: feature} index from assignVariable features.
    index: dict[str, dict] = {}
    for f in all_feats:
        if f.get("featureType") != "assignVariable":
            continue
        ps = f.get("parameters", [])
        name = next((p.get("value") for p in ps if p.get("parameterId") == "name"), None)
        if name:
            index[name] = f

    updated = 0
    skipped: list[str] = []
    for on_name, expr in overrides.items():
        feature = index.get(on_name)
        if feature is None:
            skipped.append(on_name)
            continue
        patched = copy.deepcopy(feature)
        if not _patch_assign_variable_expression(patched, expr, only_enum_value=target.config_enum_value):
            skipped.append(f"{on_name} (no expression to patch)")
            continue
        fid = patched.get("featureId")
        if not fid:
            skipped.append(f"{on_name} (no featureId)")
            continue
        if progress:
            progress(
                18 + min(8, int(updated * 2)),
                f"Updating {on_name} → {expr}",
                {"variable": on_name, "expression": expr, "feature_id": fid},
            )
        _request_json(
            "POST",
            f"/partstudios/d/{target.document_id}/w/{target.workspace_id}/e/{target.element_id}/features/featureid/{fid}",
            body={"btType": "BTFeatureDefinitionCall-1406", "feature": patched},
        )
        updated += 1

    if progress:
        progress(
            26,
            f"Part Studio variables synchronised ({updated} updated, {len(skipped)} skipped).",
            {"updated": updated, "skipped": skipped},
        )
    return updated


def start_translation(target: OnshapeTarget, *, progress: Optional[ProgressFn] = None) -> str:
    """Kick off an STL translation job. Returns the translation id.

    When `target.part_id` is set we ask Onshape to translate only that
    part (otherwise the whole Part Studio — every part it contains —
    would be packed into a single STL)."""
    body: dict[str, Any] = {
        "formatName": "STL",
        "storeInDocument": False,
        "grouping": True,
        "units": "millimeter",
        "mode": "binary",
        "angularTolerance": 0.04,
        "distanceTolerance": 0.01,
    }
    if target.part_id:
        body["partIds"] = target.part_id  # comma-separated string or list — string is safer.
    cfg = _configuration_query_value(target)
    if cfg:
        body["configuration"] = cfg
    if progress:
        progress(35, "Submitting STL translation job…", {"part_id": target.part_id, "configuration": cfg})
    response = _request_json(
        "POST",
        f"/partstudios/d/{target.document_id}/w/{target.workspace_id}/e/{target.element_id}/translations",
        body=body,
    )
    tid = response.get("id") if isinstance(response, dict) else None
    if not tid:
        raise OnshapeAPIError(502, "Translation submission did not return an id", response)
    return tid


def poll_translation(
    tid: str,
    *,
    progress: Optional[ProgressFn] = None,
    cancel_event: Optional[threading.Event] = None,
    poll_interval: float = 1.5,
    timeout: float = 180.0,
) -> dict:
    """Poll until the translation is DONE, FAILED or timeout. Returns the
    final status payload so the caller can pluck `resultExternalDataIds`."""
    started = time.monotonic()
    last_pct = 35
    attempts = 0
    while True:
        if cancel_event is not None and cancel_event.is_set():
            raise OnshapeAPIError(499, "Translation cancelled by client")
        if time.monotonic() - started > timeout:
            raise OnshapeAPIError(504, f"Translation {tid} timed out after {timeout:.0f}s")

        status = _request_json("GET", f"/translations/{tid}")
        attempts += 1
        if not isinstance(status, dict):
            raise OnshapeAPIError(502, "Unexpected translation status payload", {"raw": status})

        state = (status.get("requestState") or "").upper()
        if progress:
            # Stretch translation polling between 40 → 80% so the bar keeps
            # moving even when Onshape is silent.
            pct = min(80, last_pct + max(1, (80 - last_pct) // 5))
            last_pct = pct
            progress(
                pct,
                f"Onshape translation {state or 'PENDING'} (attempt {attempts})…",
                {"state": state, "attempt": attempts, "translation_id": tid},
            )

        if state == "DONE":
            return status
        if state == "FAILED":
            raise OnshapeAPIError(
                502,
                f"Onshape translation failed: {status.get('failureReason') or 'unknown reason'}",
                status,
            )

        time.sleep(poll_interval)


def download_translation_bytes(
    status_payload: dict,
    *,
    progress: Optional[ProgressFn] = None,
) -> bytes:
    """Fetch the STL bytes corresponding to a finished translation."""
    external_ids: Iterable[str] = status_payload.get("resultExternalDataIds") or []
    external_ids = list(external_ids)
    if not external_ids:
        raise OnshapeAPIError(502, "Translation completed without external data ids", status_payload)
    did = status_payload.get("documentId")
    if not did:
        raise OnshapeAPIError(502, "Translation payload missing documentId", status_payload)

    chunks: list[bytes] = []
    total = len(external_ids)
    for idx, ext in enumerate(external_ids, start=1):
        if progress:
            pct = 82 + int((idx - 1) / max(1, total) * 14)
            progress(pct, f"Downloading STL data {idx}/{total}…", {"index": idx, "total": total})
        resp = _request(
            "GET",
            f"/documents/d/{did}/externaldata/{ext}",
            accept="application/octet-stream",
        )
        chunks.append(resp.body)
    return b"".join(chunks)


def _configuration_query_value(target: OnshapeTarget) -> Optional[str]:
    """Return the value for the Onshape `configuration` query parameter
    (e.g. `List_xxx=automation`) or None when no config is targeted."""
    if target.config_parameter_id and target.config_enum_value:
        return f"{target.config_parameter_id}={target.config_enum_value}"
    return None


def export_part_stl_direct(target: OnshapeTarget, *, progress: Optional[ProgressFn] = None) -> bytes:
    """Faster path for single-part exports — uses GET /parts/.../stl which
    is synchronous (no polling) but only works when `ONSHAPE_PART_ID` is set."""
    if not target.part_id:
        raise OnshapeConfigError("export_part_stl_direct requires ONSHAPE_PART_ID")
    cfg = _configuration_query_value(target)
    if progress:
        progress(60, "Direct part STL download…", {"part_id": target.part_id, "configuration": cfg})
    query: dict[str, Any] = {"mode": "binary", "units": "millimeter", "grouping": "true"}
    if cfg:
        query["configuration"] = cfg
    resp = _request(
        "GET",
        f"/parts/d/{target.document_id}/w/{target.workspace_id}"
        f"/e/{target.element_id}/partid/{urllib.parse.quote(target.part_id, safe='')}/stl",
        query=query,
        accept="application/octet-stream",
    )
    return resp.body


@dataclass
class ExportResult:
    stl_bytes: bytes
    translation_id: Optional[str]
    pushed_variables: int


def run_full_export(
    params: dict,
    *,
    target: Optional[OnshapeTarget] = None,
    progress: Optional[ProgressFn] = None,
    cancel_event: Optional[threading.Event] = None,
) -> ExportResult:
    """End-to-end orchestration. Each stage emits a progress event so the
    streaming endpoint can surface granular feedback to the UI."""
    t = target or _default_target()

    if progress:
        progress(5, "Resolved Onshape target document", {
            "document_id": t.document_id,
            "workspace_id": t.workspace_id,
            "element_id": t.element_id,
            "part_id": t.part_id,
            "configuration": _configuration_query_value(t),
        })

    pushed = push_variables(t, params, progress=progress)
    if progress:
        progress(28, f"Variables synchronised ({pushed} overridden) — waiting for regen…", {"pushed": pushed})

    # Brief pause so the Part Studio finishes regenerating before we
    # request a translation. Onshape regen is normally < 1s for small
    # parametric models but explicit wait avoids occasional "STALE"
    # translation errors on rapid back-to-back requests.
    regen_wait = float(os.environ.get("ONSHAPE_REGEN_WAIT_S", "2.0"))
    time.sleep(max(0.0, regen_wait))
    if progress:
        progress(32, f"Regen wait elapsed ({regen_wait:.1f}s)", None)

    # Prefer the direct-part endpoint when a part id is known — it is
    # synchronous, returns *only* the requested part, and skips the
    # async translation lifecycle entirely.
    use_direct = bool(t.part_id) and os.environ.get(
        "ONSHAPE_USE_DIRECT_STL", "1"
    ).lower() in {"1", "true", "yes"}
    if use_direct:
        stl = export_part_stl_direct(t, progress=progress)
        if progress:
            progress(96, "STL bytes received", {"bytes": len(stl)})
        return ExportResult(stl_bytes=stl, translation_id=None, pushed_variables=pushed)

    tid = start_translation(t, progress=progress)
    status = poll_translation(tid, progress=progress, cancel_event=cancel_event)
    stl = download_translation_bytes(status, progress=progress)
    if progress:
        progress(98, "STL bytes received", {"bytes": len(stl), "translation_id": tid})
    return ExportResult(stl_bytes=stl, translation_id=tid, pushed_variables=pushed)


def get_default_target_or_none() -> Optional[OnshapeTarget]:
    """Helper for the /api/export/status endpoint — never raises."""
    try:
        return _default_target()
    except OnshapeConfigError:
        return None
