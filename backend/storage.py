import contextlib
import datetime
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


class SimulationStorage:
    """
    SQLite-backed persistence layer for simulation configs.

    This replaces local JSON-file saves while preserving the frontend contract
    based on "filename" identifiers.
    """

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS simulation_configs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            # Reserved for future Profile Builder persistence.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS solver_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL DEFAULT 'solver',
                    profile_builder_context TEXT,
                    request_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS builder_experiences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    builder_params_json TEXT NOT NULL,
                    solver_result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def migrate_legacy_configs_from_dir(self, configs_dir: Path) -> int:
        if not configs_dir.exists() or not configs_dir.is_dir():
            return 0

        imported = 0
        files = sorted([p for p in configs_dir.iterdir() if p.suffix == ".json" and p.name != "default_config.json"])
        if not files:
            return 0

        with self._connect() as conn:
            for path in files:
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(payload, dict):
                        continue
                    note_raw = payload.get("note", "")
                    note = note_raw if isinstance(note_raw, str) else ""
                    now = _utc_now_iso()
                    cur = conn.execute(
                        """
                        INSERT OR IGNORE INTO simulation_configs (name, note, payload_json, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (path.name, note, json.dumps(payload, ensure_ascii=False), now, now),
                    )
                    if cur.rowcount > 0:
                        imported += 1
                except (OSError, json.JSONDecodeError):
                    continue

            default_path = configs_dir / "default_config.json"
            if default_path.exists():
                try:
                    default_payload = json.loads(default_path.read_text(encoding="utf-8"))
                    default_name = default_payload.get("default")
                    if isinstance(default_name, str) and default_name:
                        conn.execute(
                            """
                            INSERT INTO app_meta (key, value)
                            VALUES ('default_config_name', ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value
                            """,
                            (default_name,),
                        )
                except (OSError, json.JSONDecodeError):
                    pass

            conn.commit()
        return imported

    def list_configs(self) -> List[Dict[str, str]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT name, note
                FROM simulation_configs
                ORDER BY created_at DESC, name DESC
                """
            ).fetchall()
        return [{"filename": row["name"], "note": row["note"] or ""} for row in rows]

    def get_config(self, name: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload_json FROM simulation_configs WHERE name = ?",
                (name,),
            ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload_json"])
        return payload if isinstance(payload, dict) else {}

    def save_new_config(self, payload: Dict[str, Any]) -> str:
        now_prefix = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        next_seq = self._next_sequence_value()
        name = f"{now_prefix}_{next_seq}.json"
        note_raw = payload.get("note", "")
        note = note_raw if isinstance(note_raw, str) else ""
        now = _utc_now_iso()

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO simulation_configs (name, note, payload_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, note, json.dumps(payload, ensure_ascii=False), now, now),
            )
            conn.commit()
        return name

    def update_config(self, name: str, payload: Dict[str, Any]) -> bool:
        note_raw = payload.get("note", "")
        note = note_raw if isinstance(note_raw, str) else ""
        now = _utc_now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE simulation_configs
                SET payload_json = ?, note = ?, updated_at = ?
                WHERE name = ?
                """,
                (json.dumps(payload, ensure_ascii=False), note, now, name),
            )
            conn.commit()
            return cur.rowcount > 0

    def delete_config(self, name: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM simulation_configs WHERE name = ?", (name,))
            if cur.rowcount > 0:
                current_default = conn.execute(
                    "SELECT value FROM app_meta WHERE key = 'default_config_name'"
                ).fetchone()
                if current_default and current_default["value"] == name:
                    conn.execute(
                        "UPDATE app_meta SET value = 'none' WHERE key = 'default_config_name'"
                    )
            conn.commit()
            return cur.rowcount > 0

    def set_default_config(self, name: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO app_meta (key, value)
                VALUES ('default_config_name', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (name,),
            )
            conn.commit()

    def get_default_config(self) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM app_meta WHERE key = 'default_config_name'"
            ).fetchone()
        if row is None:
            return None
        value = row["value"]
        return value if isinstance(value, str) else None

    def _next_sequence_value(self) -> int:
        with self._connect() as conn:
            rows = conn.execute("SELECT name FROM simulation_configs").fetchall()
        max_value = 0
        for row in rows:
            name = row["name"] if isinstance(row["name"], str) else ""
            stem = name[:-5] if name.endswith(".json") else name
            parts = stem.split("_")
            if not parts:
                continue
            try:
                v = int(parts[-1])
                if v > max_value:
                    max_value = v
            except ValueError:
                continue
        return max_value + 1


def default_db_path() -> Path:
    # Prefer explicit environment variable in production.
    env_path = os.getenv("SIM_DB_PATH")
    if env_path:
        return Path(env_path).resolve()
    return (Path(__file__).resolve().parent / "data" / "simulator.db").resolve()


class BuilderExperienceStorage:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate_schema()

    def _migrate_schema(self) -> None:
        """Add columns for older DB files (e.g. last_solve_request_json)."""
        with self._connect() as conn:
            try:
                cols = [r[1] for r in conn.execute("PRAGMA table_info(builder_experiences)").fetchall()]
            except sqlite3.OperationalError:
                return
            if not cols:
                return
            if "last_solve_request_json" not in cols:
                conn.execute(
                    "ALTER TABLE builder_experiences ADD COLUMN last_solve_request_json TEXT"
                )
                conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def list_experiences(self) -> List[Dict[str, str]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT name, note
                FROM builder_experiences
                ORDER BY created_at DESC, name DESC
                """
            ).fetchall()
        return [{"filename": row["name"], "note": row["note"] or ""} for row in rows]

    def save_experience(
        self,
        builder_params: Dict[str, Any],
        solver_result: Dict[str, Any],
        note: str,
        last_solve_request: Optional[Dict[str, Any]] = None,
    ) -> str:
        now_prefix = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        seq = self._next_sequence_value()
        name = f"{now_prefix}_{seq}.builder.json"
        now = _utc_now_iso()
        last_json = (
            json.dumps(last_solve_request, ensure_ascii=False)
            if last_solve_request is not None
            else None
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO builder_experiences (
                    name, note, builder_params_json, solver_result_json,
                    last_solve_request_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    note,
                    json.dumps(builder_params, ensure_ascii=False),
                    json.dumps(solver_result, ensure_ascii=False),
                    last_json,
                    now,
                    now,
                ),
            )
            conn.commit()
        return name

    def update_experience(
        self,
        name: str,
        builder_params: Dict[str, Any],
        solver_result: Dict[str, Any],
        note: str,
        last_solve_request: Optional[Dict[str, Any]] = None,
    ) -> bool:
        now = _utc_now_iso()
        last_json = (
            json.dumps(last_solve_request, ensure_ascii=False)
            if last_solve_request is not None
            else None
        )
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE builder_experiences
                SET note = ?, builder_params_json = ?, solver_result_json = ?,
                    last_solve_request_json = ?, updated_at = ?
                WHERE name = ?
                """,
                (
                    note,
                    json.dumps(builder_params, ensure_ascii=False),
                    json.dumps(solver_result, ensure_ascii=False),
                    last_json,
                    now,
                    name,
                ),
            )
            conn.commit()
            return cur.rowcount > 0

    def get_experience(self, name: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT name, note, builder_params_json, solver_result_json, last_solve_request_json
                FROM builder_experiences
                WHERE name = ?
                """,
                (name,),
            ).fetchone()
        if row is None:
            return None
        raw_last = row["last_solve_request_json"]
        last_sr = None
        if raw_last is not None and str(raw_last).strip():
            try:
                last_sr = json.loads(raw_last)
            except json.JSONDecodeError:
                last_sr = None
        out: Dict[str, Any] = {
            "filename": row["name"],
            "note": row["note"] or "",
            "builder_params": json.loads(row["builder_params_json"]),
            "solver_result": json.loads(row["solver_result_json"]),
        }
        if last_sr is not None:
            out["last_solve_request"] = last_sr
        return out

    def delete_experience(self, name: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM builder_experiences WHERE name = ?", (name,))
            conn.commit()
            return cur.rowcount > 0

    def _next_sequence_value(self) -> int:
        with self._connect() as conn:
            rows = conn.execute("SELECT name FROM builder_experiences").fetchall()
        max_value = 0
        for row in rows:
            name = row["name"] if isinstance(row["name"], str) else ""
            stem = name.replace(".builder.json", "")
            parts = stem.split("_")
            if not parts:
                continue
            try:
                v = int(parts[-1])
                if v > max_value:
                    max_value = v
            except ValueError:
                continue
        return max_value + 1


LINKAGE_KINDS = ("elbow", "lever", "pendulum")


class LinkageProfileStorage:
    """Named linkage configurations (parameters + optimizer ranges), one namespace per linkage type."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS linkage_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (kind, name)
                )
                """
            )
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def list_profiles(self, kind: str) -> List[Dict[str, str]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT name, updated_at FROM linkage_profiles WHERE kind = ? ORDER BY name COLLATE NOCASE",
                (kind,),
            ).fetchall()
        return [{"name": row["name"], "updated_at": row["updated_at"]} for row in rows]

    def get_profile(self, kind: str, name: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload_json FROM linkage_profiles WHERE kind = ? AND name = ?", (kind, name)
            ).fetchone()
        return None if row is None else json.loads(row["payload_json"])

    def save_profile(self, kind: str, name: str, payload: Dict[str, Any]) -> bool:
        """Create or overwrite. Returns True when the profile already existed."""
        now = _utc_now_iso()
        body = json.dumps(payload, ensure_ascii=False)
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE linkage_profiles SET payload_json = ?, updated_at = ? WHERE kind = ? AND name = ?",
                (body, now, kind, name),
            )
            existed = cur.rowcount > 0
            if not existed:
                conn.execute(
                    "INSERT INTO linkage_profiles (kind, name, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (kind, name, body, now, now),
                )
            conn.commit()
        return existed

    def delete_profile(self, kind: str, name: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM linkage_profiles WHERE kind = ? AND name = ?", (kind, name))
            conn.commit()
            return cur.rowcount > 0


# ─── Unified profile store ───────────────────────────────────────
# One table for every saved profile of the app. The three tables above
# (simulation_configs, builder_experiences, linkage_profiles) are copied here
# once and then left as a frozen copy; linkage_profiles still holds the custom
# materials (kind "material"), which are not profiles.

PROFILE_TYPES = ("cam", "cam-finder", "elbow", "lever", "pendulum", "compliant")
_MIGRATION_KEY = "profiles_migrated_v1"


def _default_key(profile_type: str) -> str:
    return f"default_profile:{profile_type}"


def _table_columns(conn: sqlite3.Connection, table: str) -> List[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]


class ProfileStorage:
    """Named JSON payloads, one namespace per profile type, with one default per type."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (type, name)
                )
                """
            )
            conn.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            conn.commit()
        self.migrate_from_old_tables()

    @contextlib.contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """One connection per call: committed on success, rolled back on error, always closed."""
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    # Migration -----------------------------------------------------------

    def migrate_from_old_tables(self) -> bool:
        """Copy the three old tables into `profiles`, once. Returns True when it ran.

        Additive: INSERT OR IGNORE keeps any row already in `profiles`, a default is
        only set when the type has none, and the old tables are only read.
        """
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM app_meta WHERE key = ?", (_MIGRATION_KEY,)).fetchone():
                conn.rollback()
                return False
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            insert = (
                "INSERT OR IGNORE INTO profiles (type, name, note, payload_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)"
            )
            if "simulation_configs" in tables:
                for r in conn.execute("SELECT name, note, payload_json, created_at, updated_at FROM simulation_configs"):
                    conn.execute(insert, ("cam", r["name"], r["note"] or "", r["payload_json"], r["created_at"], r["updated_at"]))
                row = conn.execute("SELECT value FROM app_meta WHERE key = 'default_config_name'").fetchone()
                if row and conn.execute(
                    "SELECT 1 FROM profiles WHERE type = 'cam' AND name = ?", (row["value"],)
                ).fetchone():
                    conn.execute("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)", (_default_key("cam"), row["value"]))
            if "builder_experiences" in tables:
                has_last = "last_solve_request_json" in _table_columns(conn, "builder_experiences")
                cols = "name, note, builder_params_json, solver_result_json, created_at, updated_at"
                if has_last:
                    cols += ", last_solve_request_json"
                for r in conn.execute(f"SELECT {cols} FROM builder_experiences"):
                    try:
                        payload: Dict[str, Any] = {
                            "builder_params": json.loads(r["builder_params_json"]),
                            "solver_result": json.loads(r["solver_result_json"]),
                        }
                    except json.JSONDecodeError as exc:
                        # Fail loud: the whole copy rolls back and the app does not start
                        # on a half-filled store. Fix the row, then restart.
                        raise RuntimeError(
                            f"profiles migration stopped, nothing copied: builder_experiences row {r['name']!r} is not valid JSON"
                        ) from exc
                    raw_last = r["last_solve_request_json"] if has_last else None
                    if raw_last is not None and str(raw_last).strip():
                        try:
                            payload["last_solve_request"] = json.loads(raw_last)
                        except json.JSONDecodeError:
                            pass  # the old GET dropped it too; the raw text stays in the old table
                    conn.execute(insert, (
                        "cam-finder", r["name"], r["note"] or "", json.dumps(payload, ensure_ascii=False),
                        r["created_at"], r["updated_at"],
                    ))
            if "linkage_profiles" in tables:
                kinds = ("elbow", "lever", "pendulum")
                rows = conn.execute(
                    f"SELECT kind, name, payload_json, created_at, updated_at FROM linkage_profiles "
                    f"WHERE kind IN ({','.join('?' * len(kinds))})",
                    kinds,
                )
                for r in rows:
                    conn.execute(insert, (r["kind"], r["name"], "", r["payload_json"], r["created_at"], r["updated_at"]))
            conn.execute("INSERT INTO app_meta (key, value) VALUES (?, ?)", (_MIGRATION_KEY, _utc_now_iso()))
            conn.commit()
        return True

    def import_legacy_config_files(self, configs_dir: Path, transform: Callable[[Dict[str, Any]], Dict[str, Any]] = lambda p: p) -> int:
        """Legacy `configs/*.json` files as `cam` profiles (never overwrites a profile).

        `transform` brings each file's payload to the current fields before it is stored.
        As before, `default_config.json` sets the cam default each time it runs.
        """
        if not configs_dir.exists() or not configs_dir.is_dir():
            return 0
        imported = 0
        files = sorted(p for p in configs_dir.iterdir() if p.suffix == ".json" and p.name != "default_config.json")
        with self._connect() as conn:
            for path in files:
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                payload = transform(payload)
                note = payload.get("note", "")
                now = _utc_now_iso()
                cur = conn.execute(
                    "INSERT OR IGNORE INTO profiles (type, name, note, payload_json, created_at, updated_at) "
                    "VALUES ('cam', ?, ?, ?, ?, ?)",
                    (path.name, note if isinstance(note, str) else "", json.dumps(payload, ensure_ascii=False), now, now),
                )
                imported += cur.rowcount > 0
            default_path = configs_dir / "default_config.json"
            if default_path.exists():
                try:
                    default_name = json.loads(default_path.read_text(encoding="utf-8")).get("default")
                except (OSError, json.JSONDecodeError, AttributeError):
                    default_name = None
                if isinstance(default_name, str) and default_name:
                    conn.execute(
                        "INSERT INTO app_meta (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (_default_key("cam"), default_name),
                    )
            conn.commit()
        return imported

    # Profiles ------------------------------------------------------------

    def list(self, profile_type: str) -> List[Dict[str, Any]]:
        order = "created_at DESC, name DESC" if profile_type in ("cam", "cam-finder") else "name COLLATE NOCASE"
        default = self.get_default(profile_type)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT name, note, created_at, updated_at FROM profiles WHERE type = ? ORDER BY {order}",
                (profile_type,),
            ).fetchall()
        return [
            {
                "name": r["name"],
                "type": profile_type,
                "note": r["note"] or "",
                "updated_at": r["updated_at"],
                "created_at": r["created_at"],
                "is_default": r["name"] == default,
            }
            for r in rows
        ]

    def get(self, profile_type: str, name: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            r = conn.execute(
                "SELECT name, note, payload_json, created_at, updated_at FROM profiles WHERE type = ? AND name = ?",
                (profile_type, name),
            ).fetchone()
        if r is None:
            return None
        payload = json.loads(r["payload_json"])
        return {
            "name": r["name"],
            "type": profile_type,
            "note": r["note"] or "",
            "payload": payload if isinstance(payload, dict) else {},
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }

    def save(self, profile_type: str, name: str, payload: Dict[str, Any], note: str = "") -> bool:
        """Create or overwrite. Returns True when the profile already existed."""
        now = _utc_now_iso()
        body = json.dumps(payload, ensure_ascii=False)
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE profiles SET payload_json = ?, note = ?, updated_at = ? WHERE type = ? AND name = ?",
                (body, note, now, profile_type, name),
            )
            existed = cur.rowcount > 0
            if not existed:
                conn.execute(
                    "INSERT INTO profiles (type, name, note, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (profile_type, name, note, body, now, now),
                )
            conn.commit()
        return existed

    def create(self, profile_type: str, payload: Dict[str, Any], note: str = "") -> str:
        """Save under a generated unique name: YYYYMMDD_HHMMSS_N, plus `.json` for cam and
        `.builder.json` for cam-finder (N = highest trailing number of the type + 1)."""
        suffix = {"cam": ".json", "cam-finder": ".builder.json"}.get(profile_type, "")
        now = _utc_now_iso()
        body = json.dumps(payload, ensure_ascii=False)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            seq = 0
            for r in conn.execute("SELECT name FROM profiles WHERE type = ?", (profile_type,)):
                stem = r["name"][: -len(suffix)] if suffix and r["name"].endswith(suffix) else r["name"]
                try:
                    seq = max(seq, int(stem.split("_")[-1]))
                except ValueError:
                    continue
            prefix = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            while True:
                seq += 1
                name = f"{prefix}_{seq}{suffix}"
                cur = conn.execute(
                    "INSERT OR IGNORE INTO profiles (type, name, note, payload_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (profile_type, name, note, body, now, now),
                )
                if cur.rowcount > 0:
                    break
            conn.commit()
        return name

    def delete(self, profile_type: str, name: str) -> bool:
        """Delete a profile; deleting the type's default clears the default."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM profiles WHERE type = ? AND name = ?", (profile_type, name))
            if cur.rowcount > 0:
                conn.execute("DELETE FROM app_meta WHERE key = ? AND value = ?", (_default_key(profile_type), name))
            conn.commit()
            return cur.rowcount > 0

    def get_default(self, profile_type: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (_default_key(profile_type),)).fetchone()
        return None if row is None else row["value"]

    def set_default(self, profile_type: str, name: Optional[str]) -> None:
        """Set the type's default profile; None clears it."""
        with self._connect() as conn:
            if name is None:
                conn.execute("DELETE FROM app_meta WHERE key = ?", (_default_key(profile_type),))
            else:
                conn.execute(
                    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (_default_key(profile_type), name),
                )
            conn.commit()


class CompliantExperimentStorage:
    """SQLite persistence for Compliant Bars solving experiments."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS compliant_solve_experiments (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'completed',
                    goal TEXT NOT NULL DEFAULT 'dx_at_025',
                    time_budget_s REAL NOT NULL DEFAULT 60.0,
                    elapsed_s REAL NOT NULL DEFAULT 0.0,
                    tested INTEGER NOT NULL DEFAULT 0,
                    feasible INTEGER NOT NULL DEFAULT 0,
                    best_score REAL,
                    request_json TEXT NOT NULL,
                    summary_json TEXT NOT NULL,
                    best_params_json TEXT,
                    best_result_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def save_experiment(
        self,
        exp_id: str,
        name: str,
        note: str,
        status: str,
        goal: str,
        time_budget_s: float,
        elapsed_s: float,
        tested: int,
        feasible: int,
        best_score: Optional[float],
        request: Dict[str, Any],
        summary: Dict[str, Any],
        best_params: Optional[Dict[str, Any]],
        best_result: Optional[Dict[str, Any]],
    ) -> str:
        now = _utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO compliant_solve_experiments (
                    id, name, note, status, goal, time_budget_s, elapsed_s,
                    tested, feasible, best_score, request_json, summary_json,
                    best_params_json, best_result_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    note = excluded.note,
                    status = excluded.status,
                    elapsed_s = excluded.elapsed_s,
                    tested = excluded.tested,
                    feasible = excluded.feasible,
                    best_score = excluded.best_score,
                    summary_json = excluded.summary_json,
                    best_params_json = excluded.best_params_json,
                    best_result_json = excluded.best_result_json,
                    updated_at = excluded.updated_at
                """,
                (
                    exp_id,
                    name,
                    note,
                    status,
                    goal,
                    float(time_budget_s),
                    float(elapsed_s),
                    int(tested),
                    int(feasible),
                    float(best_score) if best_score is not None else None,
                    json.dumps(request, ensure_ascii=False),
                    json.dumps(summary, ensure_ascii=False),
                    json.dumps(best_params, ensure_ascii=False) if best_params is not None else None,
                    json.dumps(best_result, ensure_ascii=False) if best_result is not None else None,
                    now,
                    now,
                ),
            )
            conn.commit()
        return exp_id

    def list_experiments(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, note, status, goal, time_budget_s, elapsed_s,
                       tested, feasible, best_score, created_at, updated_at
                FROM compliant_solve_experiments
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_experiment(self, exp_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM compliant_solve_experiments WHERE id = ?",
                (exp_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "note": row["note"],
            "status": row["status"],
            "goal": row["goal"],
            "time_budget_s": row["time_budget_s"],
            "elapsed_s": row["elapsed_s"],
            "tested": row["tested"],
            "feasible": row["feasible"],
            "best_score": row["best_score"],
            "request": json.loads(row["request_json"]),
            "summary": json.loads(row["summary_json"]),
            "best_params": json.loads(row["best_params_json"]) if row["best_params_json"] else None,
            "best_result": json.loads(row["best_result_json"]) if row["best_result_json"] else None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def update_meta(self, exp_id: str, name: Optional[str] = None, note: Optional[str] = None) -> bool:
        now = _utc_now_iso()
        with self._connect() as conn:
            row = conn.execute("SELECT name, note FROM compliant_solve_experiments WHERE id = ?", (exp_id,)).fetchone()
            if row is None:
                return False
            new_name = name.strip() if isinstance(name, str) and name.strip() else row["name"]
            new_note = note if isinstance(note, str) else row["note"]
            cur = conn.execute(
                "UPDATE compliant_solve_experiments SET name = ?, note = ?, updated_at = ? WHERE id = ?",
                (new_name, new_note, now, exp_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def mark_stale_running_as_interrupted(self) -> int:
        """Mark any job left in 'running' state from a previous server process as 'interrupted'."""
        now = _utc_now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                UPDATE compliant_solve_experiments
                SET status = 'interrupted', updated_at = ?
                WHERE status = 'running'
                """,
                (now,),
            )
            conn.commit()
            return cur.rowcount

    def delete_experiment(self, exp_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM compliant_solve_experiments WHERE id = ?", (exp_id,))
            conn.commit()
            return cur.rowcount > 0
