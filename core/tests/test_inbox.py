"""Tests for the inbox dismiss path — the project's only write operation."""
import json
import os
import shutil
import tempfile
import unittest

from unified_memory import inbox
from unified_memory.preview import INBOX_REL


class ProcessInboxItemTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.inbox = os.path.join(self.tmp, INBOX_REL)
        os.makedirs(self.inbox, exist_ok=True)

    def _write(self, name, text="- 一条事实\n"):
        path = os.path.join(self.inbox, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def test_moves_item_into_done_dir(self):
        src = self._write("dsh-20260101-000000-01.md")
        got = inbox.process_inbox_item(self.tmp, "dsh-20260101-000000-01.md")
        self.assertTrue(got["ok"])
        self.assertFalse(os.path.exists(src), "原文件必须已移走")
        moved = os.path.join(self.inbox, "已处理", "dsh-20260101-000000-01.md")
        self.assertTrue(os.path.exists(moved), "必须出现在 已处理/ 下")

    def test_never_deletes_content(self):
        self._write("keep.md", "- 必须保留\n")
        inbox.process_inbox_item(self.tmp, "keep.md")
        moved = os.path.join(self.inbox, "已处理", "keep.md")
        with open(moved, encoding="utf-8") as fh:
            self.assertIn("必须保留", fh.read())

    def test_collision_gets_timestamp_suffix(self):
        self._write("dup.md", "- 第一次\n")
        inbox.process_inbox_item(self.tmp, "dup.md")
        self._write("dup.md", "- 第二次\n")
        got = inbox.process_inbox_item(self.tmp, "dup.md")
        self.assertTrue(got["ok"])
        done = os.path.join(self.inbox, "已处理")
        entries = os.listdir(done)
        self.assertEqual(len(entries), 2, f"两份都应留存，实际 {entries}")
        self.assertIn("dup.md", entries)

    def test_rejects_traversal(self):
        for bad in ("../x.md", "..\\x.md", "sub/x.md", "", ".", "a\x00b", "/etc/passwd"):
            with self.subTest(bad=bad):
                got = inbox.process_inbox_item(self.tmp, bad)
                self.assertFalse(got["ok"])
                self.assertIsNotNone(got["reason"])

    def test_missing_item_is_not_ok(self):
        got = inbox.process_inbox_item(self.tmp, "ghost.md")
        self.assertFalse(got["ok"])
        self.assertIsNotNone(got["reason"])


class DismissCliTest(unittest.TestCase):
    def test_json_envelope(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, INBOX_REL), exist_ok=True)
        with open(os.path.join(tmp, INBOX_REL, "x.md"), "w", encoding="utf-8") as fh:
            fh.write("- hi\n")
        from unified_memory import memory
        out = memory.cmd_dismiss(vault=tmp, name="x.md", as_json=True)
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "dismiss")
