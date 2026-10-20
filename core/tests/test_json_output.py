# -*- coding: utf-8 -*-
"""--json output contract for the memory CLI."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory


class StatusJsonTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_status_json_emits_one_parseable_object(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["status", "--json"])
        payload = json.loads(buf.getvalue())  # raises if not valid JSON
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "status")
        self.assertIn("vault", payload["data"])
        self.assertIn("index", payload["data"])

    def test_status_without_json_is_unchanged_text(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["status"])
        out = buf.getvalue()
        self.assertFalse(out.lstrip().startswith("{"))
        self.assertIn("vault:", out)


class SearchJsonTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_search_json_envelope_and_untrusted_flag(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆", "--json"])
        payload = json.loads(buf.getvalue())
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "search")
        self.assertEqual(payload["data"]["query"], "记忆")
        self.assertIn("results", payload["data"])
        for r in payload["data"]["results"]:
            self.assertIs(r["untrusted"], True)
        self.assertNotIn("<memory-data>", buf.getvalue())

    def test_search_json_hybrid_also_works(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆", "--hybrid", "--json"])
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["command"], "search")
        self.assertIn("streams", payload["data"])

    def test_search_without_json_still_wraps_memory_data(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆"])
        self.assertIn("<memory-data>", buf.getvalue())


class AdviseCliTest(unittest.TestCase):
    """`advise` is the agent's half of the conflict queue, over the CLI.

    The contract that matters is the envelope one: a business refusal must
    travel as `data.reason` with exit 0, because `runCore` throws away stdout
    from a failed subprocess — a non-zero exit here would leave the panel with
    an empty string and no way to say why.
    """

    def setUp(self):
        from unified_memory.conflict import append_conflict, entry_key, read_conflicts

        self.vault = make_scratch_vault()
        append_conflict(
            self.vault,
            "备份目录已迁移到 D:\\backups",
            "- 备份目录是 C:\\backups（写入 2026-10-16）",
            "Agent提交区/x.md",
            "50-Agent-Context\\常用路径与环境.md",
        )
        self.key = entry_key(read_conflicts(self.vault)[0])

    def tearDown(self):
        destroy_scratch(self.vault)

    def _run(self, argv: list[str]) -> dict:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(argv)
        return json.loads(buf.getvalue())

    def test_a_recommendation_lands_in_the_entry_and_the_envelope(self):
        payload = self._run([
            "advise", self.key, "并存", "--why", "一个指目录，一个指文件，不冲突。", "--json",
        ])

        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "advise")
        self.assertEqual(payload["data"]["key"], self.key)
        self.assertEqual(payload["data"]["choice"], "并存")

        from unified_memory.conflict import find_conflict

        entry = find_conflict(self.vault, self.key)
        self.assertEqual(entry["建议"], "并存")
        self.assertEqual(entry["解释"], "一个指目录，一个指文件，不冲突。")

    def test_skipping_is_not_a_recommendation(self):
        # `跳过` dequeues the entry AND suppresses the fact forever, so it can
        # never be advice about which side is true. Offering it as a suggestion
        # would hide the one outcome the reader must choose deliberately.
        payload = self._run(["advise", self.key, "跳过", "--why", "懒得看。", "--json"])

        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["data"]["reason"], "unknown-choice")
        self.assertEqual(payload["data"]["allowed"], ["用新", "保留旧", "并存"])

        from unified_memory.conflict import find_conflict

        self.assertNotIn("建议", find_conflict(self.vault, self.key))

    def test_a_gone_entry_is_reported_not_crashed(self):
        payload = self._run(["advise", "no-such-key", "并存", "--why", "x", "--json"])

        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["data"]["reason"], "not-found")

    def test_a_reason_is_mandatory_on_the_command_line(self):
        # The reason is the whole difference between advising and handing the
        # question back untouched. argparse refusing is the cheapest place to
        # enforce that: the entry cannot be written without one.
        with self.assertRaises(SystemExit):
            memory.main(["advise", self.key, "并存"])

    def test_decide_records_why_in_the_history_log(self):
        payload = self._run([
            "decide", self.key, "用新", "--why", "9090 是当前值，8080 已停用。", "--json",
        ])

        self.assertIs(payload["ok"], True)
        from unified_memory.common import ADJUDICATED_FILE, read_maybe, situation_dir

        log = read_maybe(situation_dir(self.vault) / ADJUDICATED_FILE)
        self.assertIn("理由：9090 是当前值，8080 已停用。", log)


if __name__ == "__main__":
    unittest.main()
