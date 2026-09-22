# -*- coding: utf-8 -*-
import unittest
import tempfile
from pathlib import Path

from unified_memory import index as index_mod
from unified_memory import stats as stats_mod


class DailyCountsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name) / "vault"
        # get_conn() creates the schema on open, so it doubles as "ensure".
        conn = index_mod.get_conn(self.vault)
        rows = [
            ("m1", "a.md", "l1", "2026-01-01T10:00:00"),
            ("m2", "a.md", "l2", "2026-01-01T11:00:00"),
            ("m3", "a.md", "l3", "2026-01-03T09:00:00"),
        ]
        for mid, doc, line, created in rows:
            conn.execute(
                "INSERT INTO memories (id, doc, line, type, importance, status,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (mid, doc, line, "fact", 0.5, "active", created, created),
            )
        conn.commit()
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_fills_missing_days_with_zero(self):
        got = stats_mod.daily_counts(self.vault)
        self.assertEqual(
            got,
            [
                {"date": "2026-01-01", "count": 2},
                {"date": "2026-01-02", "count": 0},
                {"date": "2026-01-03", "count": 1},
            ],
        )

    def test_empty_index_returns_empty_list(self):
        empty = Path(self.tmp.name) / "empty"
        index_mod.get_conn(empty).close()  # create nothing but an empty index
        self.assertEqual(stats_mod.daily_counts(empty), [])


if __name__ == "__main__":
    unittest.main()
