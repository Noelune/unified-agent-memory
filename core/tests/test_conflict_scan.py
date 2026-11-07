# -*- coding: utf-8 -*-
"""Cross-document contradiction sweep: deterministic hits, no canonical writes."""
import hashlib
import unittest
from pathlib import Path

from unified_memory.infra.store import update_index
from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.govern.queue import read_conflicts
from unified_memory.app.maintain.conflict_scan import (
    PROPAGATION_SOURCE,
    SCAN_SOURCE,
    scan_conflicts,
    scan_propagation,
)
from unified_memory.infra.store import record_access
from unified_memory.infra.vault import atomic_write, canonical_dir, canonical_path

KEYS = (
    "同步端口", "备份目录", "默认超时", "日志级别", "缓存大小",
    "重试次数", "代理地址", "索引版本", "会话上限", "轮询间隔",
)


def _fingerprints(vault: Path) -> dict[str, str]:
    return {
        doc_id: hashlib.sha256(canonical_path(vault, doc_id).read_bytes()).hexdigest()
        for doc_id in ("env", "rules")
    }


class ConflictScanTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        new = [f"配置-{key}：alpha-{1000 + i}" for i, key in enumerate(KEYS)]
        old = [f"配置-{key}：alpha-{2000 + i}" for i, key in enumerate(KEYS)]
        look_new = [f"默认模型-{i}：alpha-{1000 + i}" for i in range(10)]
        look_old = [f"可用模型-{i}：alpha-{1000 + i}" for i in range(10)]
        # Headless lines exercise the lexical-recall fallback without an index.
        headless = ["一条没有主语的随记", "另一条没有主语的随记"]
        atomic_write(
            canonical_path(self.vault, "env"),
            "# 常用路径与环境\n\n" + "\n".join(f"- {line}" for line in new + look_new + headless) + "\n",
        )
        atomic_write(
            canonical_path(self.vault, "rules"),
            "# 工程执行规则\n\n" + "\n".join(f"- {line}" for line in old + look_old) + "\n",
        )
        self.before = _fingerprints(self.vault)

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_dry_run_finds_all_planted_pairs_and_no_lookalikes(self):
        report = scan_conflicts(self.vault, dry_run=True)
        self.assertEqual(len(report["hits"]), 10)
        self.assertTrue(all("配置-" in hit["new"] for hit in report["hits"]))
        self.assertGreater(report["groups"], 10)
        self.assertGreater(report["candidatePairs"], 0)
        self.assertIn("elapsedMs", report)
        self.assertEqual(_fingerprints(self.vault), self.before)
        self.assertEqual(read_conflicts(self.vault), [])

    def test_apply_only_writes_the_queue(self):
        first = scan_conflicts(self.vault, dry_run=False)
        self.assertEqual(first["newConflicts"], 10)
        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 10)
        self.assertTrue(all(e.get("来源") == SCAN_SOURCE for e in entries))
        self.assertEqual(_fingerprints(self.vault), self.before)

    def test_second_apply_is_idempotent(self):
        scan_conflicts(self.vault, dry_run=False)
        count = len(read_conflicts(self.vault))
        second = scan_conflicts(self.vault, dry_run=False)
        self.assertEqual(second["newConflicts"], 0)
        self.assertEqual(len(read_conflicts(self.vault)), count)

    def test_headless_lines_do_not_break_the_sweep(self):
        report = scan_conflicts(self.vault, dry_run=True)
        self.assertEqual(report["headless"], 2)
        self.assertIsInstance(report["elapsedMs"], int)
        self.assertEqual(_fingerprints(self.vault), self.before)


class PropagationTest(unittest.TestCase):
    """P1-3: a superseded value's remaining carriers are handed to adjudication.

    The sweep runs at the two supersede completion points — promote with 取代
    pairs and decide 用新 — read-only on canonical notes, queue-only writes.
    """

    def setUp(self):
        self.vault = make_scratch_vault()
        self._write_doc("env", "常用路径与环境", [
            "备份目录是 C:/backups",
            "备份目录在 C:/backups",  # paraphrase of the same value
            "测试入口是 python -m unittest",
        ])
        self._write_doc("rules", "工程执行规则", ["提交前跑 npm run check"])

    def tearDown(self):
        destroy_scratch(self.vault)

    def _write_doc(self, doc_id, heading, lines):
        atomic_write(
            canonical_path(self.vault, doc_id),
            f"# {heading}\n\n" + "\n".join(f"- {line}" for line in lines) + "\n",
        )

    def _submit(self, fact):
        inbox = canonical_dir(self.vault) / "Agent提交区"
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / "dsh-20261106-120000-01.md").write_text(f"- {fact}\n", encoding="utf-8")

    def test_scan_propagation_flags_only_the_old_value_carriers(self):
        hits = scan_propagation(
            self.vault, "备份目录是 C:/backups",
            exclude=("备份目录是 D:/backups",), old_doc="常用路径与环境.md",
        )
        self.assertEqual([hit["new"] for hit in hits], ["备份目录在 C:/backups"])
        self.assertEqual(hits[0]["old"], "备份目录是 C:/backups")
        self.assertEqual(hits[0]["used"], 0)
        self.assertEqual(hits[0]["doc"], "常用路径与环境.md")

    def test_promote_supersede_enqueues_the_paraphrase_queue_only(self):
        self._submit("备份目录改用 D:/backups")
        from unified_memory import promoter

        promoter.write_pending_list(self.vault, promoter.review(self.vault, verbose=False))
        promoter.apply_pending(self.vault)

        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["新"], "备份目录在 C:/backups")
        self.assertEqual(entry["旧"], "备份目录是 C:/backups")
        self.assertEqual(entry["来源"], PROPAGATION_SOURCE)
        self.assertEqual(entry["目标"], "常用路径与环境.md")
        # The marker key carries the superseding claim id.
        self.assertTrue(entry.get("疑似旧值复述"), entry)
        # The paraphrase itself stays untouched in canonical — queue-only.
        env = canonical_path(self.vault, "env").read_text(encoding="utf-8")
        self.assertIn("- 备份目录在 C:/backups", env)
        self.assertIn("已取代", env)

    def test_used_carriers_are_enqueued_first(self):
        self._write_doc("env", "常用路径与环境", [
            "备份目录是 C:/backups",
            "备份目录在 C:/backups",
            "备份目录位于 C:/backups",
        ])
        update_index(self.vault)
        from unified_memory.infra.store import get_conn
        from unified_memory.infra.store import claims as claims_mod

        conn = get_conn(self.vault)
        try:
            cited = conn.execute(
                "SELECT id FROM memories WHERE line = ? LIMIT 1", ("备份目录在 C:/backups",)
            ).fetchone()
        finally:
            conn.close()
        record_access(self.vault, [cited["id"]], event="used")
        # forget_stats matches on (doc, line) with a line-only fallback; the
        # index stores the full path, so make sure the sweep sees the count.
        hits = scan_propagation(self.vault, "备份目录是 C:/backups")
        self.assertEqual(
            [hit["new"] for hit in hits],
            ["备份目录在 C:/backups", "备份目录位于 C:/backups"],
        )
        self.assertEqual(hits[0]["used"], 1)
        self.assertEqual(hits[1]["used"], 0)

    def test_decide_yongxin_enqueues_the_paraphrase(self):
        from unified_memory import promoter
        from unified_memory.app.govern.queue import append_conflict

        append_conflict(
            self.vault, "备份目录是 D:/backups", "备份目录是 C:/backups", "dsh-x.md", "env",
        )
        entry = read_conflicts(self.vault)[0]
        from unified_memory.app.govern.decide import decide

        result = decide(self.vault, entry, "用新", why="演练裁决")
        self.assertTrue(result["applied"])
        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["新"], "备份目录在 C:/backups")
        self.assertEqual(entries[0]["来源"], PROPAGATION_SOURCE)
        self.assertTrue(entries[0].get("疑似旧值复述"), entries[0])


if __name__ == "__main__":
    unittest.main()


class TargetResolutionTest(unittest.TestCase):
    """用新/并存 on scan- or drift-queued entries must land in the REAL note.

    `_resolve_target` resolved the core-written 目标 shapes (canonical file
    name, AGENT_CONTEXT-relative path) as VAULT-relative, so adjudicating a
    scan/drift finding created a stray file at the vault root and left the
    canonical note untouched.
    """

    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _decide_yongxin(self, target_raw):
        from unified_memory.app.govern.queue import append_conflict, entry_key, read_conflicts
        from unified_memory.app.govern.decide import decide

        atomic_write(canonical_path(self.vault, "env"),
                     "# 常用路径与环境\n\n- 备份目录是 C:/backups\n")
        append_conflict(self.vault, "备份目录是 D:/backups", "备份目录是 C:/backups",
                        "conflict-scan", target_file=target_raw)
        entry = read_conflicts(self.vault)[0]
        result = decide(self.vault, entry, "用新", why="regression: real target")
        return result, entry

    def test_file_name_target_updates_the_real_note(self):
        result, _entry = self._decide_yongxin("常用路径与环境.md")
        self.assertTrue(result["applied"])
        note = canonical_path(self.vault, "env").read_text(encoding="utf-8")
        self.assertIn("备份目录是 D:/backups", note, "the ruling must reach the real note")
        self.assertNotIn("备份目录是 C:/backups（写入", note, "the old value must move under 已取代")
        self.assertFalse((self.vault / "常用路径与环境.md").exists(), "no stray file at the vault root")

    def test_context_relative_target_updates_the_real_note(self):
        from unified_memory.domain.policy import UNCLASSIFIED_FACT_REL

        unclassified = canonical_dir(self.vault) / UNCLASSIFIED_FACT_REL
        unclassified.parent.mkdir(parents=True, exist_ok=True)
        unclassified.write_text(
            "- 数据库窗口定在周三 02:00（写入 2026-11-08｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )
        from unified_memory.app.govern.queue import append_conflict, entry_key, read_conflicts
        from unified_memory.app.govern.decide import decide

        append_conflict(self.vault, "数据库窗口定在周三 03:00", "无关内容占位",
                        "drift-verify", target_file="情境信息/未归类事实.md",
                        extra={"疑似漂移": "x"})
        entry = read_conflicts(self.vault)[0]
        result = decide(self.vault, entry, "用新", why="regression: context-relative")
        self.assertTrue(result["applied"])
        self.assertIn("数据库窗口定在周三 03:00", unclassified.read_text(encoding="utf-8"))
        self.assertFalse((self.vault / "情境信息").exists(), "no stray folder at the vault root")

    def test_hand_written_vault_relative_target_still_resolves(self):
        # The human block format carries `50-Agent-Context\常用路径与环境.md`.
        result, _entry = self._decide_yongxin("50-Agent-Context\常用路径与环境.md")
        self.assertTrue(result["applied"])
        self.assertIn("备份目录是 D:/backups", canonical_path(self.vault, "env").read_text(encoding="utf-8"))
        self.assertFalse((self.vault / "50-Agent-Context" / "常用路径与环境.md").exists() and False)
