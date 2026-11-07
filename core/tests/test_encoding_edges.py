# -*- coding: utf-8 -*-
"""Encoding edges: BOM and CRLF vault files (Windows editors write both).

The parsers split on \n and strip() lines, so CRLF should be invisible —
and a UTF-8 BOM on the first line must not turn the heading/fact into
unparseable text.
"""
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter
from unified_memory.domain.markdown import bare_fact_line, doc_lines, fact_lines
from unified_memory.infra.vault import atomic_write, canonical_path


class BomAndCrlfTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_fact_lines_skip_bom_headed_heading(self):
        text = "﻿## 常用路径与环境\n\n- 备份目录是 C:/backups\n"
        self.assertIn("备份目录是 C:/backups", fact_lines(text))

    def test_bare_fact_line_handles_bom_and_crlf(self):
        self.assertEqual(bare_fact_line("﻿- 服务器监听 127.0.0.1:8080\r"), "服务器监听 127.0.0.1:8080")

    def test_doc_lines_status_on_crlf_note(self):
        text = "## 笔记\r\n\r\n- 活跃事实（写入 2026-11-08｜来源：Agent提交区/x.md）\r\n\r\n## 已取代\r\n\r\n- 旧事实\r\n"
        statuses = [(status, bare) for status, bare, _raw in doc_lines(text)]
        self.assertEqual(statuses[0][0], "active")
        self.assertEqual(statuses[-1][0], "superseded")

    def test_promotion_round_trip_on_crlf_note(self):
        path = canonical_path(self.vault, "env")
        atomic_write(path, "# 常用路径与环境\r\n\r\n- 服务器监听 127.0.0.1:8080\r\n")
        inbox = path.parent.parent / "50-Agent-Context" / "Agent提交区"
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / "m-20261108-000001-01.md").write_text("- 服务器监听 127.0.0.1:9090\r\n", encoding="utf-8")
        result = promoter.review(self.vault, verbose=False)
        # A CRLF-persisted note must still be seen: the new value contradicts
        # the CRLF-stored old value and goes to the queue.
        self.assertEqual(result["conflicts"], 1, result)
