"""Saved linkage profiles: python -m unittest discover -s backend/tests."""

import tempfile
import unittest
from pathlib import Path

from backend.storage import LinkageProfileStorage


class LinkageProfileStorageTests(unittest.TestCase):
    def test_save_overwrite_list_delete_per_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = LinkageProfileStorage(Path(tmp) / "sim.db")
            self.assertFalse(store.save_profile("pendulum", "v1", {"params": {"bar1_length": 11.0}, "search": {}}))
            self.assertFalse(store.save_profile("pendulum", "Alpha", {"params": {"bar1_length": 9.0}, "search": {}}))
            self.assertFalse(store.save_profile("lever", "v1", {"params": {"bar1_length": 6.9}, "search": {}}))
            # Same name again overwrites, and only within its own linkage type.
            self.assertTrue(store.save_profile("pendulum", "v1", {"params": {"bar1_length": 12.5}, "search": {"bar1_min": 3}}))
            self.assertEqual([p["name"] for p in store.list_profiles("pendulum")], ["Alpha", "v1"])
            self.assertEqual(store.get_profile("pendulum", "v1"), {"params": {"bar1_length": 12.5}, "search": {"bar1_min": 3}})
            self.assertEqual(store.get_profile("lever", "v1")["params"]["bar1_length"], 6.9)
            self.assertIsNone(store.get_profile("elbow", "v1"))
            self.assertTrue(store.delete_profile("pendulum", "v1"))
            self.assertFalse(store.delete_profile("pendulum", "v1"))
            self.assertEqual([p["name"] for p in store.list_profiles("lever")], ["v1"])
            # A second instance on the same file sees the data: it is on disk, not in memory.
            self.assertEqual([p["name"] for p in LinkageProfileStorage(Path(tmp) / "sim.db").list_profiles("pendulum")], ["Alpha"])


if __name__ == "__main__":
    unittest.main()
