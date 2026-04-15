import datetime
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional


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
