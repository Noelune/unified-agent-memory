# -*- coding: utf-8 -*-
import unittest
import tempfile
from pathlib import Path

from unified_memory import index as index_mod
from unified_memory import memory as mem_mod
from unified_memory import stats as stats_mod


class _ScratchIndexTest(unittest.TestCase):
    """Base for stats tests: keep the index DB out of the real home dir.

    memory.INDEX_DB is the single redirectable base path (see schema.index_db_for)
    but it defaults to ~/.unified-memory/index.db, so an unredirected test leaks
    one index-<hash>.db per run into the user's home. Each concrete class gets its
    own scratch base path under its own tempdir, and the original value is
    restored in tearDown so other test files in the same process are unaffected.
    """

    scratch_dir = "index"  # per-class subdir; overridden to avoid cross-class hits

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._saved_index_db = mem_mod.INDEX_DB
        mem_mod.INDEX_DB = Path(self.tmp.name) / self.scratch_dir / "index.db"
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
        mem_mod.INDEX_DB = self._saved_index_db
        self.tmp.cleanup()


class DailyCountsTest(_ScratchIndexTest):
    scratch_dir = "daily-counts-index"

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


class AccessCountsTest(_ScratchIndexTest):
    scratch_dir = "access-counts-index"

    def setUp(self):
        super().setUp()
        conn = index_mod.get_conn(self.vault)
        for mid, at in [
            ("m1", "2026-02-01T08:00:00"),
            ("m1", "2026-02-01T09:00:00"),
            ("m2", "2026-02-04T09:00:00"),
        ]:
            conn.execute(
                "INSERT INTO access_log (memory_id, at) VALUES (?,?)", (mid, at)
            )
        conn.commit()
        conn.close()

    def test_zero_fills_across_span(self):
        got = stats_mod.access_counts(self.vault)
        self.assertEqual([g["count"] for g in got], [2, 0, 0, 1])
        self.assertEqual(got[0]["date"], "2026-02-01")
        self.assertEqual(got[-1]["date"], "2026-02-04")

    def test_no_accesses_returns_empty(self):
        empty = Path(self.tmp.name) / "empty"
        index_mod.get_conn(empty).close()  # create nothing but an empty index
        self.assertEqual(stats_mod.access_counts(empty), [])


if __name__ == "__main__":
    unittest.main()
