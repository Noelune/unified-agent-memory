# -*- coding: utf-8 -*-
"""Tests for the default-enabled participation layer (batch D7, 0.9.1).

Nothing here is opt-in any more: the block-id backfill fires once per vault on
the maintenance paths, the hook-queue drains through catchup, and setup.py
installs the Claude Code hook wiring. All tests use scratch vaults and a temp
Claude dir — the real ~/.claude and ~/.unified-memory are never touched.
"""
import json
import os
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.maintain import backfill as backfill_mod
from unified_memory.app.ingest import digest as digest_mod
from unified_memory.common import canonical_path, read_maybe
from unified_memory.domain.markdown import claim_id_of
from unified_memory.infra import hookstate
from unified_memory.infra.store import get_meta


class EnsureBackfilledTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        path = canonical_path(self.vault, "env")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "# 常用路径与环境\n\n- 同步端口为 9443（写入 2026-10-01｜来源：a.md）\n",
            encoding="utf-8",
        )

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_first_call_backfills_and_sets_the_marker(self):
        report = backfill_mod.ensure_backfilled(self.vault)
        self.assertIsNotNone(report)
        self.assertGreaterEqual(report["lines"], 1)
        text = read_maybe(canonical_path(self.vault, "env"))
        self.assertTrue(claim_id_of(
            next(ln for ln in text.splitlines() if "同步端口" in ln)
        ))
        self.assertTrue(get_meta(self.vault, backfill_mod.BACKFILL_MARKER_KEY))

    def test_second_call_is_a_noop(self):
        backfill_mod.ensure_backfilled(self.vault)
        text = read_maybe(canonical_path(self.vault, "env"))
        self.assertIsNone(backfill_mod.ensure_backfilled(self.vault))
        self.assertEqual(read_maybe(canonical_path(self.vault, "env")), text)


class SyncTriggersBackfillTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        path = canonical_path(self.vault, "env")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "# 常用路径与环境\n\n- 同步端口为 9443（写入 2026-10-01｜来源：a.md）\n",
            encoding="utf-8",
        )
        self._env = patch.dict(os.environ, {"UNIFIED_MEMORY_VAULT": str(self.vault)})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        destroy_scratch(self.vault)

    def test_cmd_sync_backfills_once(self):
        from unified_memory.app.system import cmd_sync

        cmd_sync(Namespace(limit=400, no_embed=True, json=False))
        self.assertTrue(get_meta(self.vault, backfill_mod.BACKFILL_MARKER_KEY))
        text = read_maybe(canonical_path(self.vault, "env"))
        self.assertTrue(claim_id_of(
            next(ln for ln in text.splitlines() if "同步端口" in ln)
        ))


class CatchupDrainsQueueTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.state = Path(tempfile.mkdtemp(prefix="um-default-enable-"))
        self._env = patch.dict(os.environ, {"UNIFIED_MEMORY_HOOK_STATE": str(self.state)})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        destroy_scratch(self.vault)

    def test_catchup_runs_backfill_and_drains_the_queue(self):
        transcript = self.state / "t.jsonl"
        transcript.write_text(
            '{"type":"user","message":{"content":[{"type":"text","text":"决定把缓存目录迁到 D 盘"}]}}\n',
            encoding="utf-8",
        )
        hookstate.queue_path().parent.mkdir(parents=True, exist_ok=True)
        hookstate.queue_path().write_text(
            json.dumps({"ts": "2026-10-31T12:00:00", "source": "clear",
                        "path": str(transcript), "session_id": "s1"}) + "\n",
            encoding="utf-8",
        )
        from unified_memory import catchup

        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            report = catchup.run(self.vault)
        self.assertEqual(report["backfill"]["status"], "ran")
        self.assertEqual(report["queue"]["written"], 1)
        inbox = self.vault / "50-Agent-Context" / "Agent提交区"
        self.assertEqual(len(list(inbox.glob("digest-*.md"))), 1)
        # The marker is set too: the backfill never fires again.
        self.assertTrue(get_meta(self.vault, backfill_mod.BACKFILL_MARKER_KEY))
        second = catchup.run(self.vault)
        self.assertEqual(second["backfill"]["status"], "skipped")
        self.assertEqual(second["queue"]["pending"], 0)


class ClaudeHookInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="um-claude-home-"))
        self.claude_dir = self.tmp / ".claude"
        self.repo = Path(__file__).resolve().parents[2]

    def _install(self, remove=False):
        import importlib.util
        import sys as _sys

        # setup.py does `from deploy import main`, so its own directory must
        # be importable while the module loads.
        _sys.path.insert(0, str(self.repo / "setup"))
        try:
            spec = importlib.util.spec_from_file_location(
                "setup_under_test", self.repo / "setup" / "setup.py"
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.install_claude_hooks(self.repo, claude_dir=self.claude_dir, remove=remove)
        finally:
            _sys.path.remove(str(self.repo / "setup"))

    def _settings(self) -> dict:
        return json.loads((self.claude_dir / "settings.json").read_text(encoding="utf-8"))

    def test_fresh_install_creates_the_three_entries(self):
        outcome = self._install()
        self.assertIn("installed", outcome)
        hooks = self._settings()["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "SessionEnd"})
        entry = hooks["UserPromptSubmit"][0]["hooks"][0]
        self.assertEqual(entry["timeout"], 30)
        self.assertIn("memory_hook.py", entry["args"][0])
        self.assertNotIn("${CLAUDE_PROJECT_DIR}", entry["args"][0])

    def test_install_is_idempotent_and_preserves_user_hooks(self):
        self.claude_dir.mkdir(parents=True, exist_ok=True)
        user_entry = {"type": "exec", "command": "echo", "args": ["user-own-hook"]}
        (self.claude_dir / "settings.json").write_text(
            json.dumps({"hooks": {"UserPromptSubmit": [{"hooks": [user_entry]}]}}),
            encoding="utf-8",
        )
        first = self._install()
        self.assertIn("installed", first)
        second = self._install()
        self.assertIn("already", second)
        groups = self._settings()["hooks"]["UserPromptSubmit"]
        self.assertEqual(len(groups), 2, "user group kept, our group appended once")
        self.assertEqual(groups[0]["hooks"][0]["args"], ["user-own-hook"])
        self.assertTrue(any((self.claude_dir).glob("settings.json.bak-*")))

    def test_remove_drops_only_our_entries(self):
        self.claude_dir.mkdir(parents=True, exist_ok=True)
        user_entry = {"type": "exec", "command": "echo", "args": ["user-own-hook"]}
        (self.claude_dir / "settings.json").write_text(
            json.dumps({"hooks": {"UserPromptSubmit": [{"hooks": [user_entry]}]}}),
            encoding="utf-8",
        )
        self._install()
        outcome = self._install(remove=True)
        self.assertIn("removed", outcome)
        groups = self._settings()["hooks"]["UserPromptSubmit"]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["hooks"][0]["args"], ["user-own-hook"])

    def test_invalid_user_json_is_never_touched(self):
        self.claude_dir.mkdir(parents=True, exist_ok=True)
        (self.claude_dir / "settings.json").write_text("{not json", encoding="utf-8")
        outcome = self._install()
        self.assertIn("skipped", outcome)
        self.assertEqual((self.claude_dir / "settings.json").read_text(encoding="utf-8"), "{not json")


if __name__ == "__main__":
    unittest.main()
