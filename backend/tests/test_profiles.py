"""Unified profile store: python -m unittest discover -s backend/tests."""

import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from backend.storage import (
    PROFILE_TYPES,
    BuilderExperienceStorage,
    LinkageProfileStorage,
    ProfileStorage,
    SimulationStorage,
)


def _build_old_db(path: Path) -> None:
    """A database as the app wrote it before the profiles table: every kind, a material and a default."""
    cams = SimulationStorage(path)
    first = cams.save_new_config({"height": 2.0, "note": "first cam"})
    cams.save_new_config({"height": 3.0, "note": "second cam"})
    cams.set_default_config(first)
    builders = BuilderExperienceStorage(path)
    builders.save_experience({"a": 1}, {"candidates": [1, 2]}, "with request", last_solve_request={"k": 2})
    builders.save_experience({"a": 2}, {"candidates": []}, "without request")
    links = LinkageProfileStorage(path)
    links.save_profile("pendulum", "custom-interessant", {"params": {"bar1_length": 11.0}, "search": {}, "chart_settings": {}})
    links.save_profile("lever", "Zed", {"params": {"bar1_length": 6.9}, "search": {"bar1_min": 3}})
    links.save_profile("lever", "alpha", {"params": {"bar1_length": 5.0}, "search": {}})
    links.save_profile("material", "Nylon", {"modulus_mpa": 1700.0, "strength_mpa": 45.0})


def _old_tables(path: Path) -> dict:
    with sqlite3.connect(path) as conn:
        return {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY id").fetchall()
            for t in ("simulation_configs", "builder_experiences", "linkage_profiles")
        }


class ProfileMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sim.db"
        _build_old_db(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_migration_copies_everything_and_leaves_old_tables(self):
        before = _old_tables(self.path)
        store = ProfileStorage(self.path)
        self.assertEqual(_old_tables(self.path), before)

        cams_old = SimulationStorage(self.path)
        self.assertEqual([p["name"] for p in store.list("cam")], [c["filename"] for c in cams_old.list_configs()])
        for entry in cams_old.list_configs():
            got = store.get("cam", entry["filename"])
            self.assertEqual(got["payload"], cams_old.get_config(entry["filename"]))
            self.assertEqual(got["note"], entry["note"])
        self.assertEqual(store.get_default("cam"), cams_old.get_default_config())

        builders_old = BuilderExperienceStorage(self.path)
        self.assertEqual([p["name"] for p in store.list("cam-finder")], [e["filename"] for e in builders_old.list_experiences()])
        for entry in builders_old.list_experiences():
            old = builders_old.get_experience(entry["filename"])
            got = store.get("cam-finder", entry["filename"])
            self.assertEqual(got["note"], old["note"])
            self.assertEqual(got["payload"], {k: v for k, v in old.items() if k not in ("filename", "note")})

        links_old = LinkageProfileStorage(self.path)
        for kind in ("elbow", "lever", "pendulum"):
            self.assertEqual(
                [{"name": p["name"], "updated_at": p["updated_at"]} for p in store.list(kind)],
                links_old.list_profiles(kind),
            )
            for row in links_old.list_profiles(kind):
                self.assertEqual(store.get(kind, row["name"])["payload"], links_old.get_profile(kind, row["name"]))
        self.assertEqual([p["name"] for p in store.list("lever")], ["alpha", "Zed"])

        # Timestamps are kept, and the material went nowhere.
        with sqlite3.connect(self.path) as conn:
            old_ts = conn.execute("SELECT name, created_at, updated_at FROM simulation_configs ORDER BY name").fetchall()
            new_ts = conn.execute("SELECT name, created_at, updated_at FROM profiles WHERE type = 'cam' ORDER BY name").fetchall()
            self.assertEqual(old_ts, new_ts)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 2 + 2 + 3)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM profiles WHERE name = 'Nylon'").fetchone()[0], 0)

    def test_migration_is_idempotent_and_never_overwrites(self):
        store = ProfileStorage(self.path)
        store.save("pendulum", "custom-interessant", {"params": {"bar1_length": 99.0}})
        deleted = store.list("cam")[0]["name"]
        store.delete("cam", deleted)
        count = len(store.list("cam")) + len(store.list("cam-finder")) + len(store.list("lever"))

        again = ProfileStorage(self.path)   # second start of the app
        self.assertFalse(again.migrate_from_old_tables())
        self.assertEqual(again.get("pendulum", "custom-interessant")["payload"], {"params": {"bar1_length": 99.0}})
        self.assertIsNone(again.get("cam", deleted))
        self.assertEqual(len(again.list("cam")) + len(again.list("cam-finder")) + len(again.list("lever")), count)

        # Even with the run marker gone, a re-run only fills gaps: no duplicate, newer data kept.
        with sqlite3.connect(self.path) as conn:
            conn.execute("DELETE FROM app_meta WHERE key = 'profiles_migrated_v1'")
        self.assertTrue(again.migrate_from_old_tables())
        self.assertEqual(again.get("pendulum", "custom-interessant")["payload"], {"params": {"bar1_length": 99.0}})
        with sqlite3.connect(self.path) as conn:
            dupes = conn.execute("SELECT COUNT(*) FROM profiles GROUP BY type, name HAVING COUNT(*) > 1").fetchall()
        self.assertEqual(dupes, [])

    def test_concurrent_creates_get_distinct_names(self):
        store = ProfileStorage(self.path)
        names = []
        lock = threading.Lock()

        def create():
            name = ProfileStorage(self.path).create("cam", {"height": 1.0})
            with lock:
                names.append(name)

        threads = [threading.Thread(target=create) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(set(names)), 8)
        self.assertEqual(len(store.list("cam")), 2 + 8)

    def test_bad_builder_row_stops_the_copy_without_a_trace(self):
        with sqlite3.connect(self.path) as conn:
            conn.execute("UPDATE builder_experiences SET solver_result_json = '{broken' WHERE note = 'without request'")
        with self.assertRaises(RuntimeError):
            ProfileStorage(self.path)
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 0)
            self.assertIsNone(conn.execute("SELECT 1 FROM app_meta WHERE key = 'profiles_migrated_v1'").fetchone())

    def test_default_none_is_not_migrated(self):
        SimulationStorage(self.path).set_default_config("none")
        self.assertIsNone(ProfileStorage(self.path).get_default("cam"))

    def test_legacy_config_files_on_empty_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "configs"
            cfg.mkdir()
            (cfg / "20260326_162442_1.json").write_text(json.dumps({"height": 2.5, "note": "legacy"}))
            (cfg / "20260326_162653_2.json").write_text(json.dumps({"height": 1.5}))
            (cfg / "default_config.json").write_text(json.dumps({"default": "20260326_162442_1.json"}))
            store = ProfileStorage(Path(tmp) / "empty.db")
            self.assertEqual(store.import_legacy_config_files(cfg), 2)
            self.assertEqual(store.import_legacy_config_files(cfg), 0)
            self.assertEqual(sorted(p["name"] for p in store.list("cam")), ["20260326_162442_1.json", "20260326_162653_2.json"])
            got = store.get("cam", "20260326_162442_1.json")
            self.assertEqual((got["note"], got["payload"]["height"]), ("legacy", 2.5))
            self.assertEqual(store.get_default("cam"), "20260326_162442_1.json")
            # The next save continues the numbering.
            self.assertTrue(store.create("cam", {"height": 1.0}).endswith("_3.json"))


class ProfileRouteTests(unittest.TestCase):
    """Old and new routes over one store (main.py imports its siblings by bare name)."""

    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
        except Exception as exc:   # httpx missing
            raise unittest.SkipTest(f"TestClient unavailable: {exc}")
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sys.path.insert(0, backend_dir)
        os.environ["SIM_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
        import main
        cls.main = main
        cls.client = TestClient(main.app)

    def setUp(self):
        # main is imported once per process: point its stores at a fresh old-format DB.
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sim.db"
        _build_old_db(self.path)
        self.saved = (self.main.profiles, self.main.linkage_storage)
        self.main.profiles = ProfileStorage(self.path)
        self.main.linkage_storage = LinkageProfileStorage(self.path)

    def tearDown(self):
        self.main.profiles, self.main.linkage_storage = self.saved
        self.tmp.cleanup()

    def test_old_routes_answer_as_before_on_migrated_data(self):
        c = self.client
        cams, builders, links = SimulationStorage(self.path), BuilderExperienceStorage(self.path), LinkageProfileStorage(self.path)
        self.assertEqual(c.get("/api/configs").json(), {"configs": cams.list_configs()})
        self.assertEqual(c.get("/api/configs/default").json(), {"default": cams.get_default_config()})
        for entry in cams.list_configs():
            self.assertEqual(c.get(f"/api/configs/{entry['filename']}").json(), cams.get_config(entry["filename"]))
        self.assertEqual(c.get("/api/builder-experiences").json(), {"experiences": builders.list_experiences()})
        for entry in builders.list_experiences():
            self.assertEqual(c.get(f"/api/builder-experiences/{entry['filename']}").json(), builders.get_experience(entry["filename"]))
        for kind in ("elbow", "lever", "pendulum"):
            self.assertEqual(c.get(f"/api/linkage/profiles?kind={kind}").json(), {"profiles": links.list_profiles(kind)})
            for row in links.list_profiles(kind):
                self.assertEqual(c.get(f"/api/linkage/profiles/{kind}/{row['name']}").json(), links.get_profile(kind, row["name"]))

    def test_cam_both_directions(self):
        c = self.client
        name = c.post("/api/save-config", json={"height": 4.0, "note": "via old"}).json()["filename"]
        listed = c.get("/api/profiles?type=cam").json()
        self.assertEqual(listed["profiles"][0]["name"], name)
        self.assertEqual(listed["profiles"][0]["note"], "via old")
        self.assertEqual(c.get(f"/api/profiles/cam/{name}").json()["payload"]["height"], 4.0)

        self.assertEqual(c.put("/api/profiles/cam/mine.json", json={"payload": {"height": 5.0}, "note": "via new"}).json(),
                         {"status": "saved", "name": "mine.json"})
        got = c.get("/api/configs/mine.json").json()
        self.assertEqual((got["height"], got["note"]), (5.0, "via new"))
        self.assertIn({"filename": "mine.json", "note": "via new"}, c.get("/api/configs").json()["configs"])
        self.assertEqual(c.put("/api/configs/mine.json", json={"height": 6.0, "note": "edited"}).json()["status"], "updated")
        self.assertEqual(c.get("/api/profiles/cam/mine.json").json()["note"], "edited")
        self.assertEqual(c.put("/api/configs/missing.json", json={"height": 1.0}).status_code, 404)
        self.assertEqual(c.delete("/api/configs/mine.json").json(), {"status": "deleted"})
        self.assertEqual(c.get("/api/profiles/cam/mine.json").status_code, 404)

        created = c.post("/api/profiles/cam", json={"payload": {"height": 7.0}}).json()["name"]
        self.assertRegex(created, r"^\d{8}_\d{6}_\d+\.json$")
        self.assertEqual(c.get(f"/api/configs/{created}").json()["height"], 7.0)

    def test_cam_finder_both_directions(self):
        c = self.client
        body = {"note": "n", "builder_params": {"a": 1}, "solver_result": {"r": 2}, "last_solve_request": {"q": 3}}
        name = c.post("/api/builder-experiences", json=body).json()["filename"]
        self.assertTrue(name.endswith(".builder.json"))
        self.assertEqual(c.get(f"/api/profiles/cam-finder/{name}").json()["payload"],
                         {"builder_params": {"a": 1}, "solver_result": {"r": 2}, "last_solve_request": {"q": 3}})
        payload = {"builder_params": {"b": 1}, "solver_result": {"s": 1}}
        self.assertEqual(c.put(f"/api/profiles/cam-finder/{name}", json={"payload": payload, "note": "new"}).json()["status"], "updated")
        self.assertEqual(c.get(f"/api/builder-experiences/{name}").json(),
                         {"filename": name, "note": "new", "builder_params": {"b": 1}, "solver_result": {"s": 1}})
        self.assertEqual(c.put("/api/builder-experiences/nope.builder.json", json=body).status_code, 404)
        created = c.post("/api/profiles/cam-finder", json={"payload": payload}).json()["name"]
        self.assertRegex(created, r"^\d{8}_\d{6}_\d+\.builder\.json$")
        self.assertIn(created, [e["filename"] for e in c.get("/api/builder-experiences").json()["experiences"]])
        self.assertEqual(c.delete(f"/api/builder-experiences/{created}").json(), {"status": "deleted"})
        self.assertEqual(c.get(f"/api/profiles/cam-finder/{created}").status_code, 404)

    def test_linkage_both_directions(self):
        c = self.client
        for kind in ("elbow", "lever", "pendulum"):
            payload = {"params": {"bar1_length": 10.0}, "search": {}, "chart_settings": {"x": "y"}}
            self.assertEqual(c.put(f"/api/profiles/{kind}/x", json={"payload": payload}).json(), {"status": "saved", "name": "x"})
            self.assertEqual(c.get(f"/api/linkage/profiles/{kind}/x").json(), payload)
            self.assertIn("x", [p["name"] for p in c.get(f"/api/linkage/profiles?kind={kind}").json()["profiles"]])
            old_body = {"params": {"bar1_length": 12.0}, "search": {"bar1_min": 1}}
            self.assertEqual(c.put(f"/api/linkage/profiles/{kind}/via-old", json=old_body).json()["status"], "saved")
            self.assertEqual(c.get(f"/api/profiles/{kind}/via-old").json()["payload"], {**old_body, "chart_settings": {}})
            created = c.post(f"/api/profiles/{kind}", json={"payload": payload}).json()["name"]
            self.assertRegex(created, r"^\d{8}_\d{6}_\d+$")
            self.assertEqual(c.delete(f"/api/linkage/profiles/{kind}/{created}").json(), {"status": "deleted"})
            self.assertEqual(c.delete(f"/api/profiles/{kind}/x").json(), {"status": "deleted"})
            self.assertEqual(c.get(f"/api/linkage/profiles/{kind}/x").status_code, 404)
        self.assertEqual(c.put("/api/profiles/pendulum/" + "n" * 61, json={"payload": {}}).status_code, 400)

    def test_materials_never_listed_as_profiles(self):
        c = self.client
        self.assertEqual(c.put("/api/linkage/materials/PA12", json={"modulus_mpa": 1700, "strength_mpa": 45}).status_code, 200)
        names = {m["name"] for m in c.get("/api/linkage/materials").json()["materials"]}
        self.assertTrue({"Nylon", "PA12"} <= names)
        for t in PROFILE_TYPES:
            listed = [p["name"] for p in c.get(f"/api/profiles?type={t}").json()["profiles"]]
            self.assertNotIn("Nylon", listed)
            self.assertNotIn("PA12", listed)
        self.assertEqual(c.get("/api/profiles?type=material").status_code, 404)
        self.assertEqual(c.get("/api/profiles/material/Nylon").status_code, 404)
        with sqlite3.connect(self.path) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM profiles WHERE name IN ('Nylon', 'PA12')").fetchone()[0], 0)

    def test_unknown_type_is_404(self):
        c = self.client
        for resp in (
            c.get("/api/profiles?type=nope"),
            c.get("/api/profiles/nope/x"),
            c.put("/api/profiles/nope/x", json={"payload": {}}),
            c.post("/api/profiles/nope", json={"payload": {}}),
            c.delete("/api/profiles/nope/x"),
            c.get("/api/profiles/nope/default"),
            c.put("/api/profiles/nope/default/x"),
        ):
            self.assertEqual(resp.status_code, 404)

    def test_default_handling(self):
        c = self.client
        listed = c.get("/api/profiles?type=cam").json()
        default = listed["default"]
        self.assertEqual([p["name"] for p in listed["profiles"] if p["is_default"]], [default])
        self.assertEqual(c.get("/api/profiles/cam/default").json(), {"default": default})
        self.assertEqual(c.put("/api/profiles/cam/default/missing.json").status_code, 404)

        other = [p["name"] for p in listed["profiles"] if p["name"] != default][0]
        self.assertEqual(c.put(f"/api/profiles/cam/default/{other}").json(), {"status": "set", "default": other})
        self.assertEqual(c.get("/api/configs/default").json(), {"default": other})
        self.assertEqual(c.delete(f"/api/profiles/cam/{other}").status_code, 200)
        self.assertIsNone(c.get("/api/profiles?type=cam").json()["default"])

        # The old route sets any name, and "none" clears.
        self.assertEqual(c.post(f"/api/configs/default/{default}").json(), {"status": "set", "default": default})
        self.assertEqual(c.get("/api/profiles/cam/default").json(), {"default": default})
        self.assertEqual(c.post("/api/configs/default/none").json(), {"status": "set", "default": "none"})
        self.assertIsNone(c.get("/api/configs/default").json()["default"])

        # Defaults are per type.
        self.assertEqual(c.put("/api/profiles/lever/default/Zed").status_code, 200)
        self.assertEqual(c.get("/api/profiles/lever/default").json(), {"default": "Zed"})
        self.assertIsNone(c.get("/api/profiles/pendulum/default").json()["default"])
        self.assertEqual(c.put("/api/profiles/lever/default", json={"payload": {}}).status_code, 400)

    def test_payload_must_be_an_object_under_the_cap(self):
        c = self.client
        self.assertEqual(c.put("/api/profiles/lever/x", json={"payload": [1, 2]}).status_code, 422)
        big = {"blob": "x" * (2 * 1024 * 1024 + 1)}
        self.assertEqual(c.put("/api/profiles/lever/x", json={"payload": big}).status_code, 413)
        self.assertEqual(c.post("/api/profiles/lever", json={"payload": {}, "note": big["blob"]}).status_code, 413)
        self.assertEqual(c.put("/api/profiles/lever/default", json={"payload": {}}).status_code, 400)
        self.assertEqual(c.put("/api/profiles/lever/%20default%20", json={"payload": {}}).status_code, 400)
        self.assertIsNone(self.main.profiles.get("lever", "x"))


if __name__ == "__main__":
    unittest.main()
