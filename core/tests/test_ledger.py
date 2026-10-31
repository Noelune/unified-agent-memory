# -*- coding: utf-8 -*-
"""Tests for the Claim Ledger (batch D): block ids, the projection refresh,
the backfill and the write-path wiring.

PLAN §4 identity rules are pinned here: one id per fact (改文字不改 ID), same
text in two notes = two claims, and a refresh never resurrects a deleted
line's claim unless another occurrence still carries it.
"""
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.govern import decide as decide_mod
from unified_memory.app.govern import promote as promote_mod
from unified_memory.app.maintain import backfill as backfill_mod
from unified_memory.common import canonical_path, read_maybe
from unified_memory.domain.markdown import (
    bare_fact_line,
    claim_id_of,
    strip_suffix,
    with_claim_id,
)
from unified_memory.infra.store import get_conn
from unified_memory.infra.store.ledger import (
    claim_id_for_text,
    claim_timeline,
    claims_valid_at,
    new_claim_id,
    refresh_doc,
    refresh_ledger,
)


def _seed_note(vault, doc_id: str, lines: list[str]) -> None:
    path = canonical_path(vault, doc_id)
    body = f"# {path.stem}\n\n" + "\n".join(lines) + "\n"
    path.write_text(body, encoding="utf-8")


class ClaimIdHelpersTest(unittest.TestCase):
    def test_id_round_trip(self):
        line = "- 同步端口为 9443（写入 2026-10-01｜来源：a.md）"
        tagged = with_claim_id(line, "abcdef1234567890")
        self.assertEqual(claim_id_of(tagged), "abcdef1234567890")
        # strip_suffix keeps the bullet (that is bare_fact_line's job) but the
        # identity suffix and the stamp both go.
        self.assertEqual(strip_suffix(tagged), "- 同步端口为 9443")
        self.assertEqual(bare_fact_line(tagged), "同步端口为 9443")

    def test_bare_text_is_id_free_for_the_index(self):
        tagged = with_claim_id("- 备份目录是 D:/x", "0123456789abcdef")
        # bare_fact_line strips stamps AND the block id: the search corpus and
        # the conflict comparison must never see the identity suffix.
        self.assertEqual(bare_fact_line(tagged), "备份目录是 D:/x")

    def test_two_runs_generate_two_ids(self):
        self.assertNotEqual(new_claim_id(), new_claim_id())


class BackfillTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        _seed_note(self.vault, "env", [
            "- 同步端口为 9443（写入 2026-10-01｜来源：Agent提交区/x.md）",
            "- 生产服务器地址是 203.0.113.10（写入 2026-10-01｜来源：Agent提交区/x.md）",
        ])

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_backfill_assignes_ids_and_is_idempotent(self):
        first = backfill_mod.run_backfill(self.vault)
        self.assertGreaterEqual(first["lines"], 2)
        env_ids = [
            claim_id_of(ln)
            for ln in read_maybe(canonical_path(self.vault, "env")).splitlines()
            if ln.lstrip().startswith("-") and "同步端口" in ln
        ]
        self.assertTrue(env_ids[0], "the seeded fact must carry an id after backfill")
        # Second run: every line already carries an id — zero new ids, and the
        # ids themselves are unchanged (改文字不改 ID).
        second = backfill_mod.run_backfill(self.vault)
        self.assertEqual(second["lines"], 0)
        self.assertEqual(
            [
                claim_id_of(ln)
                for ln in read_maybe(canonical_path(self.vault, "env")).splitlines()
                if ln.lstrip().startswith("-") and "同步端口" in ln
            ],
            env_ids,
        )

    def test_dry_run_writes_nothing(self):
        before = read_maybe(canonical_path(self.vault, "env"))
        report = backfill_mod.run_backfill(self.vault, dry_run=True)
        self.assertGreaterEqual(report["lines"], 2)
        self.assertEqual(report["dry_run"], True)
        self.assertEqual(read_maybe(canonical_path(self.vault, "env")), before)

    def test_refresh_projection_matches_the_vault(self):
        backfill_mod.run_backfill(self.vault)
        conn = get_conn(self.vault)
        try:
            # The template notes backfill too; the two SEEDED facts must be in
            # the projection with the active status and one occurrence each.
            for text in ("同步端口为 9443", "生产服务器地址是 203.0.113.10"):
                row = conn.execute("SELECT id, status FROM claims WHERE text = ?", (text,)).fetchone()
                self.assertIsNotNone(row, text)
                self.assertEqual(row["status"], "active")
                timeline = claim_timeline(conn, row["id"])
                self.assertEqual(len(timeline["occurrences"]), 1)
        finally:
            conn.close()

    def test_superseded_history_gets_the_superseded_status(self):
        note = canonical_path(self.vault, "env")
        note.write_text(
            "# 常用路径与环境\n\n"
            "- 同步端口为 9443（写入 2026-10-01｜来源：a.md）\n\n"
            "## 已取代\n\n"
            "- 同步端口为 8443（写入 2026-09-01｜来源：a.md）\n",
            encoding="utf-8",
        )
        backfill_mod.run_backfill(self.vault)
        conn = get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT status, valid_from FROM claims WHERE text = '同步端口为 8443'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["status"], "superseded")
            self.assertEqual(row["valid_from"], "2026-09-01")
        finally:
            conn.close()

    def test_deleting_a_line_drops_only_its_own_claim(self):
        backfill_mod.run_backfill(self.vault)
        note = canonical_path(self.vault, "env")
        kept = [
            ln
            for ln in read_maybe(note).splitlines()
            if not ("同步端口" in ln and ln.lstrip().startswith("-"))
        ]
        note.write_text("\n".join(kept) + "\n", encoding="utf-8")
        refresh_ledger(self.vault)
        conn = get_conn(self.vault)
        try:
            texts = {row["text"] for row in conn.execute("SELECT text FROM claims").fetchall()}
            self.assertNotIn("同步端口为 9443", texts)
            self.assertIn("生产服务器地址是 203.0.113.10", texts)
        finally:
            conn.close()


class WritePathWiringTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        _seed_note(self.vault, "env", [
            "- 同步端口为 9443（写入 2026-10-01｜来源：Agent提交区/x.md）",
        ])
        backfill_mod.run_backfill(self.vault)

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_promoted_facts_are_born_with_ids(self):
        entries = [{"分类": "env", "内容": "部署脚本放在 scripts/deploy.sh", "来源": "x.md", "取代": ""}]
        promote_mod.promote(self.vault, entries)
        text = read_maybe(canonical_path(self.vault, "env"))
        new_lines = [ln for ln in text.splitlines() if "deploy.sh" in ln]
        self.assertEqual(len(new_lines), 1)
        self.assertTrue(claim_id_of(new_lines[0]), new_lines[0])
        conn = get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT status FROM claims WHERE text = ?", ("部署脚本放在 scripts/deploy.sh",)
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["status"], "active")
        finally:
            conn.close()

    def test_decide_supersession_closes_the_window_and_links(self):
        entry = {"旧": "同步端口为 9443", "新": "同步端口已改为 9444", "来源": "x.md", "目标": ""}
        result = decide_mod.decide(self.vault, entry, "用新")
        self.assertTrue(result["ok"])
        conn = get_conn(self.vault)
        try:
            old = claim_id_for_text(conn, "同步端口为 9443")
            new = claim_id_for_text(conn, "同步端口已改为 9444")
            self.assertTrue(old)
            self.assertTrue(new)
            old_row = conn.execute("SELECT status, valid_to FROM claims WHERE id = ?", (old,)).fetchone()
            self.assertEqual(old_row["status"], "superseded")
            self.assertIsNotNone(old_row["valid_to"])
            link = conn.execute(
                "SELECT kind, decided_by FROM links WHERE src = ? AND dst = ?", (old, new)
            ).fetchone()
            self.assertIsNotNone(link)
            self.assertEqual(link["kind"], "supersedes")
            events = conn.execute(
                "SELECT op FROM events WHERE target = ?", (old,)
            ).fetchall()
            self.assertEqual([r["op"] for r in events], ["supersede"])
            # as-of after the change returns only the new value (D3 surface).
            latest = claims_valid_at(conn, "2999-12-31")
            texts = {row["text"] for row in latest}
            self.assertNotIn("同步端口为 9443", texts)
            self.assertIn("同步端口已改为 9444", texts)
        finally:
            conn.close()

    def test_as_of_inside_the_recorded_window_returns_the_old_value(self):
        entry = {"旧": "同步端口为 9443", "新": "同步端口已改为 9444", "来源": "x.md", "目标": ""}
        decide_mod.decide(self.vault, entry, "用新")
        conn = get_conn(self.vault)
        try:
            old = claim_id_for_text(conn, "同步端口为 9443")
            old_row = conn.execute("SELECT valid_from, valid_to FROM claims WHERE id = ?", (old,)).fetchone()
            # A date before the supersession: the old claim's window covers it.
            before_date = old_row["valid_from"] or "2026-10-01"
            valid = claims_valid_at(conn, before_date)
            self.assertIn("同步端口为 9443", {row["text"] for row in valid})
        finally:
            conn.close()


class AsOfAcceptanceTest(unittest.TestCase):
    """PLAN batch acceptance: a config changed 3 times — 4 dates, all correct.

    decide() stamps everything "today", so one real chain collapses to one
    date; the test first pins the CHAIN CONTIGUITY the wiring produces, then
    backdates the four windows to distinct historical dates (fixture setup —
    the wiring itself is covered by the D2 tests) and checks as-of on all
    four. Same-day successive changes collapsing to the last value is honest
    date-granularity behaviour, documented in the ledger.
    """

    def setUp(self):
        self.vault = make_scratch_vault()
        _seed_note(self.vault, "env", ["- 同步端口为 8000（写入 2026-01-01｜来源：a.md）"])
        backfill_mod.run_backfill(self.vault)

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_three_supersedes_four_dates_all_correct(self):
        for new_text in ("同步端口已改为 9000", "同步端口已改为 9443", "同步端口已改为 9500"):
            conn = get_conn(self.vault)
            try:
                current = [
                    row["text"]
                    for row in conn.execute("SELECT text FROM claims WHERE status = 'active'").fetchall()
                    if "同步端口" in row["text"]
                ][0]
            finally:
                conn.close()
            entry = {"旧": current, "新": new_text, "来源": "a.md", "目标": ""}
            result = decide_mod.decide(self.vault, entry, "用新")
            self.assertTrue(result["ok"], result)

        conn = get_conn(self.vault)
        try:
            rows = conn.execute(
                "SELECT id, text, valid_from, valid_to, status FROM claims"
                " WHERE text LIKE '同步端口%' ORDER BY valid_from"
            ).fetchall()
            self.assertEqual(len(rows), 4)
            v1, v2, v3, v4 = rows
            # The decide wiring chains the windows: each version ends exactly
            # where its successor starts, and only the newest is active.
            self.assertIsNone(v4["valid_to"])
            self.assertEqual(v1["valid_to"], v2["valid_from"])
            self.assertEqual(v2["valid_to"], v3["valid_from"])
            self.assertEqual(v3["valid_to"], v4["valid_from"])
            self.assertEqual(v4["status"], "active")
            for older in (v1, v2, v3):
                self.assertEqual(older["status"], "superseded")

            # Backdate the four windows to distinct dates (fixture setup) and
            # run the actual acceptance: four dates, each returns exactly the
            # then-current value.
            dates = ["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"]
            versions = [v1, v2, v3, v4]
            for row, start in zip(versions, dates):
                conn.execute("UPDATE claims SET valid_from = ? WHERE id = ?", (start, row["id"]))
            for i, row in enumerate(versions):
                end = dates[i + 1] if i + 1 < len(dates) else None
                conn.execute("UPDATE claims SET valid_to = ? WHERE id = ?", (end, row["id"]))
            conn.commit()
            for i, (date, expected) in enumerate(zip(dates, (v1, v2, v3, v4))):
                valid = {row["text"] for row in claims_valid_at(conn, date)}
                self.assertIn(versions[i]["text"], valid, date)
                for j, other in enumerate(versions):
                    if j != i:
                        self.assertNotIn(other["text"], valid, f"{date}: {other['text']}")
        finally:
            conn.close()
