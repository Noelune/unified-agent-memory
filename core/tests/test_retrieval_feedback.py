# -*- coding: utf-8 -*-
"""Citation feedback (batch A): retrieval is not usage.

record_access used to count a fact the moment it was RETURNED and the
forgetter rewarded that count — 752 access rows / 149 memories, every one
praise, stale facts pinned forever. Only ``used`` events (the model cited the
[short-id] the envelope prints) reinforce now.
"""
from __future__ import annotations

import io
import unittest
from argparse import Namespace
from contextlib import redirect_stdout

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import forgetter, index, search
from unified_memory.common import canonical_path
from unified_memory.memory import cmd_cite


class AccessEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def _one_memory(self) -> str:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n- prefers indigo terminal prompts\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        conn = index.get_conn(self.vault)
        try:
            return conn.execute("SELECT id FROM memories LIMIT 1").fetchone()["id"]
        finally:
            conn.close()

    def test_default_event_is_retrieved(self) -> None:
        mid = self._one_memory()
        index.record_access(self.vault, [mid])
        conn = index.get_conn(self.vault)
        try:
            events = [r["event"] for r in conn.execute(
                "SELECT event AS event FROM access_log").fetchall()]
        finally:
            conn.close()
        self.assertEqual(events, ["retrieved"])
        self.assertEqual(index.used_count(self.vault, mid), 0)

    def test_used_events_are_counted(self) -> None:
        mid = self._one_memory()
        index.record_access(self.vault, [mid])          # retrieved
        index.record_access(self.vault, [mid], event="used")
        index.record_access(self.vault, [mid], event="used")
        self.assertEqual(index.used_count(self.vault, mid), 2)

    def test_render_hybrid_prints_short_ids(self) -> None:
        self._one_memory()
        result = search.hybrid_search(self.vault, "indigo", limit=3)
        self.assertGreater(result["count"], 0)
        conn = index.get_conn(self.vault)
        try:
            short = conn.execute(
                "SELECT id FROM memories WHERE line LIKE '%indigo%' LIMIT 1"
            ).fetchone()["id"][:10]
        finally:
            conn.close()
        rendered = search.render_hybrid(result["results"], "indigo")
        self.assertIn("[" + short + "]", rendered)

    def test_resolve_short_ids_expands_and_rejects(self) -> None:
        mid = self._one_memory()
        self.assertEqual(index.resolve_short_ids(self.vault, [mid[:10]]), [mid])
        self.assertEqual(index.resolve_short_ids(self.vault, ["zzzzzzzzzz"]), [])
        self.assertEqual(index.resolve_short_ids(self.vault, ["'; DROP"]), [])


class CitationCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def test_cmd_use_records_citations(self) -> None:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n- prefers indigo terminal prompts\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        conn = index.get_conn(self.vault)
        try:
            mid = conn.execute("SELECT id FROM memories LIMIT 1").fetchone()["id"]
        finally:
            conn.close()
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            cmd_cite(Namespace(ids=mid[:10], json=True))
        self.assertIn('"matched": 1', buffer.getvalue())
        self.assertEqual(index.used_count(self.vault, mid), 1)


class ReinforcementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def test_retrieval_alone_does_not_reinforce(self) -> None:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n- prefers indigo terminal prompts\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        conn = index.get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT id, doc, line FROM memories LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        index.record_access(self.vault, [row["id"]] * 50)  # retrieved 50 times
        stats = forgetter._index_stats(self.vault, row["doc"], row["line"])
        self.assertIsNotNone(stats)
        self.assertEqual(stats[1], 0)  # used count stays zero

    def test_citations_raise_the_score(self) -> None:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n- prefers indigo terminal prompts\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        conn = index.get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT id, doc, line FROM memories LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        bare_score = forgetter.memory_score(0.85, 0, 400)
        cited_score = forgetter.memory_score(0.85, 20, 400)
        self.assertGreater(cited_score, bare_score)
        self.assertGreater(cited_score, forgetter.FORGET_THRESHOLD)


if __name__ == "__main__":
    unittest.main()
