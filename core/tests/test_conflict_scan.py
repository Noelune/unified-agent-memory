# -*- coding: utf-8 -*-
"""Cross-document contradiction sweep: deterministic hits, no canonical writes."""
import hashlib
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.govern.queue import read_conflicts
from unified_memory.app.maintain.conflict_scan import SCAN_SOURCE, scan_conflicts
from unified_memory.infra.vault import atomic_write, canonical_path

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


if __name__ == "__main__":
    unittest.main()
