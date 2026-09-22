# -*- coding: utf-8 -*-
import json
import sys
import unittest
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import _GUARD_INDEX_DB, assert_guard_intact  # arms the isolation guard
from unified_memory import index as index_mod
from unified_memory import memory as mem_mod
from unified_memory import stats as stats_mod
from unified_memory.preview import INBOX_REL as INBOX_REL_FOR_TEST


class _ScratchIndexTest(unittest.TestCase):
    """Base for stats tests: keep the index DB out of the real home dir.

    memory.INDEX_DB is the single redirectable base path (see schema.index_db_for)
    but it defaults to ~/.unified-memory/index.db, so an unredirected test leaks
    one index-<hash>.db per run into the user's home. Importing test_common arms
    the session-wide guard first, so the restore below can never put a real-home
    path back: the saved value is either a scratch path or the guard dir.
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
        # Never restore a real-home path: if the pre-setUp value was the real
        # default (test_common not yet imported in an older revision of this
        # file), fall back to the guard dir instead of handing the next test the
        # user's own index location.
        mem_mod.INDEX_DB = (
            _GUARD_INDEX_DB if self._saved_index_db is None else self._saved_index_db
        )
        assert_guard_intact()
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


class BreakdownTest(_ScratchIndexTest):
    scratch_dir = "breakdown-index"

    # A superseded row that would top every breakdown if the WHERE status='active'
    # filter were dropped: unique type, unique-and-highest importance, and the
    # highest access_count. Its presence is what makes an unfiltered query fail
    # loudly instead of passing on an all-active fixture.
    SUPERSEDED_ID = "m-superseded"
    SUPERSEDED_LINE = "memory superseded"

    def setUp(self):
        super().setUp()
        conn = index_mod.get_conn(self.vault)
        # The base class seeds m1/m2/m3 as a shared fixture; this class needs its
        # own breakdown rows, so drop those instead of colliding on the id PK.
        conn.execute("DELETE FROM memories")
        rows = [
            ("m1", "fact", 0.5, 3, "memory one"),
            ("m2", "fact", 0.9, 0, "memory two"),
            ("m3", "bug", 0.9, 7, "memory three"),
            (self.SUPERSEDED_ID, "workflow", 1.0, 99, self.SUPERSEDED_LINE),
        ]
        for mid, typ, imp, ac, line in rows:
            conn.execute(
                "INSERT INTO memories (id, doc, line, type, importance, status,"
                " access_count, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, "a.md", line, typ, imp,
                 "superseded" if mid == self.SUPERSEDED_ID else "active",
                 ac, "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
            )
        conn.commit()
        conn.close()

    def test_type_counts_descending(self):
        self.assertEqual(
            stats_mod.type_counts(self.vault),
            [{"type": "fact", "count": 2}, {"type": "bug", "count": 1}],
        )

    def test_importance_counts_descending_by_value(self):
        self.assertEqual(
            stats_mod.importance_counts(self.vault),
            [{"value": 0.9, "count": 2}, {"value": 0.5, "count": 1}],
        )

    def test_top_accessed_excludes_zero_and_is_redacted(self):
        got = stats_mod.top_accessed(self.vault)
        self.assertEqual([g["count"] for g in got], [7, 3])
        for g in got:
            self.assertIs(g["untrusted"], True)

    def test_superseded_row_is_excluded_from_every_breakdown(self):
        # The fixture's superseded row carries the highest access_count (99), a
        # private type ('workflow') and the top importance band (1.0): each
        # function is checked directly, and the row's id/label must never appear
        # anywhere, because an unfiltered query would surface it first.
        types = stats_mod.type_counts(self.vault)
        self.assertEqual([t["type"] for t in types], ["fact", "bug"])
        self.assertNotIn("workflow", [t["type"] for t in types])

        importance = stats_mod.importance_counts(self.vault)
        self.assertEqual([i["value"] for i in importance], [0.9, 0.5])
        self.assertNotIn(1.0, [i["value"] for i in importance])

        top = stats_mod.top_accessed(self.vault)
        self.assertNotIn(self.SUPERSEDED_ID, [t["id"] for t in top])
        self.assertEqual([t["count"] for t in top], [7, 3])
        self.assertNotIn(
            self.SUPERSEDED_LINE, [t["label"] for t in top],
            "a superseded memory leaked into the most-recalled ranking",
        )

    def test_superseded_row_is_excluded_even_as_the_only_other_row(self):
        # Same invariant, minimal shape: delete the active rows and the
        # superseded one must still be invisible to every breakdown.
        conn = index_mod.get_conn(self.vault)
        conn.execute(
            "DELETE FROM memories WHERE id != ?", (self.SUPERSEDED_ID,)
        )
        conn.commit()
        conn.close()
        self.assertEqual(stats_mod.type_counts(self.vault), [])
        self.assertEqual(stats_mod.importance_counts(self.vault), [])
        self.assertEqual(stats_mod.top_accessed(self.vault), [])

    def test_top_accessed_label_is_redacted(self):
        # redact() is a secret scrubber, not a content stripper (see
        # common.SECRET_PATTERNS): a credential-shaped line in vault content
        # must come back scrubbed, since memory text is untrusted data.
        conn = index_mod.get_conn(self.vault)
        conn.execute(
            "UPDATE memories SET line = ? WHERE id = ?",
            ("api_key=abcdef123456", "m3"),
        )
        conn.commit()
        conn.close()
        self.assertEqual(stats_mod.top_accessed(self.vault)[0]["label"],
                         "api_key=<REDACTED>")

    def test_top_accessed_respects_limit(self):
        self.assertEqual(len(stats_mod.top_accessed(self.vault, limit=1)), 1)


class BuildTest(_ScratchIndexTest):
    scratch_dir = "build-index"

    def test_build_returns_every_key(self):
        got = stats_mod.build(self.vault)
        self.assertEqual(
            sorted(got.keys()),
            ["access", "daily", "importance", "span", "top", "totals", "types"],
        )

    def test_span_null_when_no_data(self):
        # The base fixture seeds 3 memories, so "no data" needs a vault of its
        # own; None (not "") is the contract callers branch on.
        empty = Path(self.tmp.name) / "empty"
        index_mod.get_conn(empty).close()
        got = stats_mod.build(empty)
        self.assertIsNone(got["span"]["start"])
        self.assertIsNone(got["span"]["end"])

    def test_envelope_is_parseable_and_ok(self):
        data = stats_mod.build(self.vault)
        parsed = json.loads(stats_mod.envelope(data))
        self.assertIs(parsed["ok"], True)
        self.assertEqual(parsed["command"], "stats")
        self.assertIn("daily", parsed["data"])

    def test_totals_are_derived_from_the_same_aggregates(self):
        # memories/accesses must equal the sums build() already returned above,
        # so a console never shows a total that disagrees with its own chart.
        got = stats_mod.build(self.vault)
        totals = got["totals"]
        self.assertEqual(sorted(totals),
                         ["accesses", "inbox", "memories", "vectors"])
        self.assertEqual(totals["memories"], sum(t["count"] for t in got["types"]))
        self.assertEqual(totals["accesses"], sum(a["count"] for a in got["access"]))
        self.assertEqual(totals["memories"], 3)  # base fixture: m1, m2, m3
        for key in totals:
            self.assertIsInstance(totals[key], int)

    def test_memories_total_counts_superseded_rows_daily_does_not(self):
        # memories = SUM(type_counts) covers every ACTIVE row; daily_counts also
        # filters to active, so the two only diverge on an undated row. Add one
        # whose created_at has no usable date: it must still count in the total
        # even though it contributes no day. This is what separates "sum of
        # type_counts" from "sum of daily" (a silently surviving mutation).
        conn = index_mod.get_conn(self.vault)
        conn.execute(
            "INSERT INTO memories (id, doc, line, type, importance, status,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("m-undated", "a.md", "l4", "bug", 0.5, "active", "", ""),
        )
        conn.commit()
        conn.close()
        got = stats_mod.build(self.vault)
        self.assertEqual(sum(t["count"] for t in got["types"]), 4)
        self.assertEqual(sum(d["count"] for d in got["daily"]), 3)
        self.assertEqual(got["totals"]["memories"], 4)

    def test_totals_count_vectors_and_inbox(self):
        conn = index_mod.get_conn(self.vault)
        conn.execute(
            "INSERT INTO embeddings (memory_id, dim, vector)"
            " VALUES (?,?,?)", ("m1", 3, b"xyz")
        )
        conn.commit()
        conn.close()
        inbox = Path(self.vault) / INBOX_REL_FOR_TEST
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / "dsh-1.md").write_text("- a fact\n", encoding="utf-8")
        (inbox / "dsh-2.md").write_text("- another\n", encoding="utf-8")
        (inbox / "not-markdown.txt").write_text("ignored\n", encoding="utf-8")
        totals = stats_mod.build(self.vault)["totals"]
        self.assertEqual(totals["vectors"], 1)
        self.assertEqual(totals["inbox"], 2)  # *.md only

    def test_build_is_read_only(self):
        # The console's read path must not change the data it draws. Asserting
        # row counts rather than file bytes is deliberate: get_conn() re-runs
        # its CREATE TABLE IF NOT EXISTS pragmas on every open, so the file's
        # bytes move even for a pure SELECT (measured: sqlite 3.53.1). Byte
        # identity would fail for every reader in this module and tell us
        # nothing about whether a write happened.
        def snapshot(vault):
            conn = index_mod.get_conn(vault)
            try:
                return {
                    t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                    for t in ("memories", "access_log", "embeddings")
                }
            finally:
                conn.close()

        before = snapshot(self.vault)
        stats_mod.build(self.vault)
        self.assertEqual(before, snapshot(self.vault))
        self.assertEqual(before["memories"], 3)  # fixture actually loaded


if __name__ == "__main__":
    unittest.main()
