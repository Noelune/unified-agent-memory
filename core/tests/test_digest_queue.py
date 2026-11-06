# -*- coding: utf-8 -*-
"""Tests for the hook-queue write path (batch E3): the Claude Code transcript
adapter and digest --queue.

The live LLM is never called (chat_extract_facts is patched); the real
~/.unified-memory.yaml, the real hook-state dir and the real vault are never
touched — queue/state live in a temp dir, the vault is a scratch one.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.common import canonical_dir, read_maybe
from unified_memory.infra.transcripts.claude_code import claude_code_transcript
from unified_memory.infra import hookstate
from unified_memory.app.ingest import digest as digest_mod


class TranscriptAdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="um-transcript-"))

    def _write(self, lines: list[str]) -> Path:
        path = self.tmp / "t.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_user_assistant_lines_become_a_transcript(self):
        path = self._write([
            '{"type":"user","message":{"content":[{"type":"text","text":"把同步端口改一下"}]}}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"已把同步端口改为 9443"}]}}',
        ])
        text = claude_code_transcript(path)
        self.assertIn("用户: 把同步端口改一下", text)
        self.assertIn("助手: 已把同步端口改为 9443", text)

    def test_array_content_joins_text_blocks(self):
        path = self._write([
            '{"type":"assistant","message":{"content":[{"type":"text","text":"第一段"},'
            '{"type":"tool_use","name":"x"},{"type":"text","text":"第二段"}]}}',
        ])
        text = claude_code_transcript(path)
        self.assertIn("第一段", text)
        self.assertIn("第二段", text)
        self.assertNotIn("tool_use", text)

    def test_bad_and_non_conversation_lines_are_skipped(self):
        path = self._write([
            "{not json at all",
            '{"type":"summary","summary":"无关行"}',
            "42",
            '{"type":"user","message":{"content":"纯字符串内容也可以"}}',
        ])
        text = claude_code_transcript(path)
        self.assertNotIn("not json", text)
        self.assertNotIn("无关行", text)
        self.assertIn("纯字符串内容也可以", text)

    def test_every_produced_line_is_redacted(self):
        path = self._write([
            '{"type":"user","message":{"content":[{"type":"text","text":"我的 api_key=qwertyuiop123 记得别提交"}]}}',
        ])
        text = claude_code_transcript(path)
        self.assertNotIn("qwertyuiop123", text)
        self.assertIn("api_key=<REDACTED>", text)


class DigestQueueTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.state = Path(tempfile.mkdtemp(prefix="um-queue-"))
        self._env = patch.dict(os.environ, {"UNIFIED_MEMORY_HOOK_STATE": str(self.state)})
        self._env.start()
        os.environ.pop("UNIFIED_MEMORY_HOOK_RECALL_MODE", None)

    def tearDown(self):
        self._env.stop()
        destroy_scratch(self.vault)

    def _seed_queue(self, transcript: Path) -> None:
        hookstate.queue_path().parent.mkdir(parents=True, exist_ok=True)
        hookstate.queue_path().write_text(
            json.dumps({"ts": "2026-10-31T12:00:00", "source": "clear",
                        "path": str(transcript), "session_id": "s1"}) + "\n",
            encoding="utf-8",
        )

    def _transcript(self, name: str = "t.jsonl") -> Path:
        path = self.state / name
        path.write_text(
            '{"type":"user","message":{"content":[{"type":"text","text":"决定把缓存目录迁到 D 盘"}]}}\n'
            '{"type":"assistant","message":{"content":[{"type":"text","text":"已迁移完成"}]}}\n',
            encoding="utf-8",
        )
        return path

    def test_queue_drain_writes_inbox_and_marks_done(self):
        transcript = self._transcript()
        self._seed_queue(transcript)
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            report = digest_mod.digest(self.vault, source="queue")
        self.assertEqual(report["source"], "queue")
        self.assertEqual(report["pending"], 1)
        self.assertEqual(report["written"], 1)
        inbox = canonical_dir(self.vault) / "Agent提交区"
        self.assertEqual(len(list(inbox.glob("digest-*.md"))), 1)
        self.assertIn(str(transcript), read_maybe(hookstate.done_path()))

    def test_queue_drain_is_idempotent(self):
        transcript = self._transcript()
        self._seed_queue(transcript)
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            digest_mod.digest(self.vault, source="queue")
            report = digest_mod.digest(self.vault, source="queue")
        # Second run: the done file filters the path, so nothing is re-extracted.
        self.assertEqual(report["pending"], 0)
        inbox = canonical_dir(self.vault) / "Agent提交区"
        self.assertEqual(len(list(inbox.glob("digest-*.md"))), 1)

    def test_dry_run_neither_writes_nor_marks_done(self):
        transcript = self._transcript()
        self._seed_queue(transcript)
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            report = digest_mod.digest(self.vault, dry_run=True, source="queue")
        self.assertEqual(report["facts"], 1)
        self.assertEqual(report["written"], 0)
        inbox = canonical_dir(self.vault) / "Agent提交区"
        self.assertEqual(list(inbox.glob("digest-*.md")), [])
        self.assertFalse(hookstate.done_path().exists())

    def test_bad_entries_are_skipped_and_counted(self):
        transcript = self._transcript()
        hookstate.queue_path().parent.mkdir(parents=True, exist_ok=True)
        hookstate.queue_path().write_text(
            "{broken json\n"
            + json.dumps({"ts": "2026-10-31T12:00:00", "path": str(transcript), "source": "clear"}) + "\n"
            + json.dumps({"ts": "2026-10-31T12:01:00", "path": "/no/such/transcript.jsonl"}) + "\n",
            encoding="utf-8",
        )
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            report = digest_mod.digest(self.vault, source="queue")
        # The broken line is dropped at parse; the missing transcript is
        # filtered at collection (both never reach the extraction loop).
        self.assertEqual(report["pending"], 1)
        self.assertEqual(report["written"], 1)

    def test_extraction_failure_leaves_entry_unmarked(self):
        transcript = self._transcript()
        self._seed_queue(transcript)
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=None,
        ):
            report = digest_mod.digest(self.vault, source="queue")
        # 3C names the failure and how far it got: the message is informational
        # (the contract is the STATE — entry unmarked, cursor untouched), so the
        # wording may carry more detail than the old bare label.
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn(f"claude-code {transcript.name}", report["skipped"][0])
        self.assertIn("chunk extraction failed", report["skipped"][0])
        self.assertFalse(hookstate.done_path().exists())
        # A later successful run can still process it.
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            report = digest_mod.digest(self.vault, source="queue")
        self.assertEqual(report["written"], 1)

    def test_archive_cursor_is_never_touched_by_queue_mode(self):
        transcript = self._transcript()
        self._seed_queue(transcript)
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), patch(
            "unified_memory.app.ingest.digest.chat_extract_facts",
            return_value=["缓存目录已迁移到 D 盘"],
        ):
            digest_mod.digest(self.vault, source="queue")
        from unified_memory.infra.store import get_meta

        self.assertEqual(get_meta(self.vault, "digest_cursor"), "")
        self.assertEqual(get_meta(self.vault, "digest_cursor_state"), "")
