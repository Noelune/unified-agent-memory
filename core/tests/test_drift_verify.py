# -*- coding: utf-8 -*-
"""3B: provenance facts are re-checked against their source archives.

Two stages: a low-bar similarity pre-filter (zero overlap = unsupported, no
LLM spent) and LLM entailment for the rest (temperature 0, verdict forced to
支持/不支持/无法判断). Unsupported candidates are reported by default and
enqueued only with --apply; a wrong suspect costs a human glance, never a
canonical write.
"""
import unittest
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.govern.queue import read_conflicts
from unified_memory.app.maintain import drift_verify
from unified_memory.infra.vault import atomic_write, canonical_path

ORIGIN = "会话归档/2026-11-06.md"
SOURCE_TEXT = (
    "# 2026-11-06 会话\n\n"
    "- 今天把备份目录定在 C:/backups，这是唯一的备份位置。\n"
    "- 测试入口是 python -m unittest discover。\n"
    "- 闲聊一句，与记忆无关。\n"
)


class DriftVerifyTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        atomic_write(
            canonical_path(self.vault, "env"),
            "# 常用路径与环境\n\n"
            "- 备份目录是 C:/backups（写入 2026-11-06｜来源：Agent提交区/digest-x.md）"
            f"（溯源：{ORIGIN}） ^c-aaaaaaaaaaaaaaaa\n"
            "- 数据库端口是 6333（写入 2026-11-06｜来源：Agent提交区/digest-x.md）"
            f"（溯源：{ORIGIN}） ^c-bbbbbbbbbbbbbbbb\n"
            "- 普通事实没有溯源（写入 2026-11-06｜来源：Agent提交区/x.md）\n",
        )
        atomic_write(self.vault / ORIGIN, SOURCE_TEXT)

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_prefilter_flags_zero_overlap_without_llm(self):
        with patch.object(drift_verify, "chat_completion", return_value="支持") as llm:
            report = drift_verify.verify_drift(self.vault)
        self.assertEqual(report["checked"], 2)
        self.assertEqual(report["prefiltered"], 1, report)
        self.assertEqual(report["llmChecked"], 1)
        # Exactly one LLM call: the zero-overlap port fact is decided by the
        # pre-filter alone; only the anchored backup fact reaches the model.
        self.assertEqual(llm.call_count, 1)
        self.assertEqual(len(report["candidates"]), 1)
        self.assertEqual(report["candidates"][0]["fact"], "数据库端口是 6333")
        self.assertEqual(report["candidates"][0]["verdict"], "不支持")

    def test_llm_verdicts_are_classified(self):
        with patch.object(drift_verify, "chat_completion", return_value="支持") as llm:
            report = drift_verify.verify_drift(self.vault)
        self.assertEqual(report["llmChecked"], 1)
        self.assertEqual(report["supported"], 1)
        self.assertEqual(report["unsupported"], 1)
        user_msg = llm.call_args[0][0][1]["content"]
        self.assertIn("备份目录", user_msg)

    def test_an_unsupported_llm_verdict_becomes_a_candidate(self):
        with patch.object(drift_verify, "chat_completion", return_value="不支持"):
            report = drift_verify.verify_drift(self.vault)
        self.assertEqual(report["unsupported"], 2)
        self.assertEqual(
            {c["fact"] for c in report["candidates"]},
            {"备份目录是 C:/backups", "数据库端口是 6333"},
        )

    def test_undecidable_verdicts_are_reported_not_enqueued(self):
        with patch.object(drift_verify, "chat_completion", return_value="无法判断"):
            report = drift_verify.verify_drift(self.vault)
        self.assertEqual(report["undecidable"], 1)
        self.assertEqual(report["unsupported"], 1, "the prefiltered port fact stays a candidate")
        self.assertEqual(len(report["candidates"]), 1)

    def test_missing_source_is_skipped_not_flagged(self):
        atomic_write(
            canonical_path(self.vault, "rules"),
            "# 工程执行规则\n\n"
            f"- 孤儿事实（写入 2026-11-06｜来源：Agent提交区/x.md）（溯源：会话归档/2099-01-01.md）\n",
        )
        with patch.object(drift_verify, "chat_completion", return_value="支持"):
            report = drift_verify.verify_drift(self.vault)
        self.assertEqual(report["checked"], 3)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn("source missing", report["skipped"][0])

    def test_apply_enqueues_with_evidence_and_is_idempotent(self):
        with patch.object(drift_verify, "chat_completion", return_value="不支持"):
            first = drift_verify.verify_drift(self.vault, apply=True)
        self.assertEqual(first["enqueued"], 2)
        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 2)
        by_fact = {e["新"]: e for e in entries}
        drift_entry = by_fact["数据库端口是 6333"]
        self.assertEqual(drift_entry["来源"], "drift-verify")
        self.assertEqual(drift_entry["目标"], "常用路径与环境.md")
        self.assertEqual(drift_entry["旧"], "- 测试入口是 python -m unittest discover。",
                         "the best source line (verbatim, bullet included) rides as 旧")
        self.assertEqual(drift_entry["疑似漂移"], "原文不含等价内容")
        self.assertEqual(drift_entry["溯源"], ORIGIN)
        self.assertEqual(drift_entry["证据"], "- 测试入口是 python -m unittest discover。")
        with patch.object(drift_verify, "chat_completion", return_value="不支持"):
            second = drift_verify.verify_drift(self.vault, apply=True)
        self.assertEqual(second["enqueued"], 0)
        self.assertEqual(len(read_conflicts(self.vault)), 2)


if __name__ == "__main__":
    unittest.main()
