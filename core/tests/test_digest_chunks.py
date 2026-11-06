# -*- coding: utf-8 -*-
"""3C: long sessions are extracted in overlapping chunks, not tail-truncated.

The old `_transcript_of` kept only the last 6000 chars, so the head of a long
session was dropped with no record at all. Extraction now slides a 6000-char
window with 500 chars of overlap across the whole (redacted) session, dedups
across chunks, reports 送审/总 chars, and refuses to write or advance the
cursor when any chunk fails.
"""
import unittest
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.ingest import digest as digest_mod

HEAD_MARKER = "用户偏好：终端必须用深色主题"


def _long_transcript(total: int = 13000) -> str:
    filler = "这是与记忆无关的会话正文填充。\n"
    body = f"# 会话开头\n\n- {HEAD_MARKER}\n\n" + filler * 400
    return body[:total].ljust(total, "字")


class ChunkingTest(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(digest_mod._chunk_transcript("短文本"), ["短文本"])

    def test_long_text_windows_share_the_overlap(self):
        text = _long_transcript(13000)
        chunks = digest_mod._chunk_transcript(text)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(len(chunks[0]), digest_mod.MAX_INPUT_CHARS)
        # 500 chars of context shared between neighbours.
        self.assertEqual(chunks[1][: digest_mod.CHUNK_OVERLAP], chunks[0][-digest_mod.CHUNK_OVERLAP :])
        self.assertEqual(chunks[2][: digest_mod.CHUNK_OVERLAP], chunks[1][-digest_mod.CHUNK_OVERLAP :])
        # The whole session is covered, in order.
        self.assertEqual("".join([chunks[0], chunks[1][digest_mod.CHUNK_OVERLAP :], chunks[2][digest_mod.CHUNK_OVERLAP :]]), text)
        self.assertIn(HEAD_MARKER, chunks[0])


class DigestChunkFlowTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        archive = self.vault / "50-Agent-Context" / "会话归档"
        archive.mkdir(parents=True, exist_ok=True)
        (archive / "2026-11-06.md").write_text(_long_transcript(), encoding="utf-8")

    def tearDown(self):
        destroy_scratch(self.vault)

    def _run(self, side_effect, **kwargs):
        with patch("unified_memory.infra.providers.embed.configured", return_value=True), \
             patch.object(digest_mod, "chat_extract_facts", side_effect=side_effect) as llm:
            report = digest_mod.digest(self.vault, **kwargs)
        return report, llm

    def test_a_head_only_fact_is_recovered(self):
        # The extraction sees the head marker only if the window that carries
        # it is sent — the tail-truncating behaviour would never see it.
        def extract(chunk):
            return [HEAD_MARKER] if HEAD_MARKER in chunk else []

        report, llm = self._run(extract, dry_run=True)
        self.assertEqual(report["facts"], 1)
        # Sent > total by exactly the overlap re-sent between the 3 windows.
        total = len(_long_transcript())
        self.assertEqual(report["charsTotal"], total)
        self.assertEqual(report["charsSent"], total + digest_mod.CHUNK_OVERLAP * 2)
        self.assertEqual(llm.call_count, 3)

    def test_dedup_across_chunks_counts_echoes_once(self):
        # The filler phrase appears in every window; the model echoing the same
        # fact for each chunk must still yield ONE fact.
        def extract(chunk):
            return ["会话正文填充的事实"] if "正文填充" in chunk else []

        report, llm = self._run(extract, dry_run=True)
        self.assertGreaterEqual(llm.call_count, 2)
        self.assertEqual(report["facts"], 1)

    def test_a_failed_chunk_skips_the_unit_whole(self):
        calls = {"n": 0}

        def extract(chunk):
            calls["n"] += 1
            return ["头部事实"] if calls["n"] == 1 else None

        with patch("unified_memory.infra.providers.embed.configured", return_value=True), \
             patch.object(digest_mod, "chat_extract_facts", side_effect=extract), \
             patch.object(digest_mod, "_write_digest_facts", return_value=1) as write, \
             patch.object(digest_mod, "set_meta") as set_meta:
            report = digest_mod.digest(self.vault)
        self.assertEqual(len(report["skipped"]), 1)
        self.assertIn("chunk extraction failed", report["skipped"][0])
        write.assert_not_called()
        set_meta.assert_not_called()
        self.assertEqual(report["written"], 0)


if __name__ == "__main__":
    unittest.main()
