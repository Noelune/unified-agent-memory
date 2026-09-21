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
        """A pre-existing 已处理/ item must survive byte-for-byte.

        The old version of this test only moved a unique file and read it back —
        it never had a second file to lose, so "unconditional overwrite" stayed
        green. This one plants the collision first: dismissing a *new* file that
        shares the old one's name must not touch the old one's bytes.
        """
        done = os.path.join(self.inbox, "已处理")
        os.makedirs(done, exist_ok=True)
        victim = os.path.join(done, "keep.md")
        original = "- 旧的一行\n- 第二行\n"
        with open(victim, "w", encoding="utf-8") as fh:
            fh.write(original)
        before = os.stat(victim)

        self._write("keep.md", "- 新的一行\n")
        got = inbox.process_inbox_item(self.tmp, "keep.md")
        self.assertTrue(got["ok"])

        with open(victim, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), original, "旧条目被改写了")
        after = os.stat(victim)
        self.assertEqual((before.st_size, before.st_mtime_ns),
                         (after.st_size, after.st_mtime_ns),
                         "旧条目被覆盖（大小或 mtime 变了）")
        self.assertEqual(len(os.listdir(done)), 2, "两份都必须保留")

    def test_three_way_collision_keeps_three_distinct_files(self):
        """Critical-1: three same-name dismissals must leave three distinct files.

        The previous two-file version stopped one step short of the bug: the
        second file got a timestamp, and the *third* dismissal recomputed the
        same second-resolution timestamp, hit an existing path, and let
        shutil.move silently clobber it. Asserting on the payloads (not just the
        count) is what makes that undetectable-class loss visible.
        """
        for i in (1, 2, 3):
            self._write("dup.md", f"- 第{i}次\n")
            got = inbox.process_inbox_item(self.tmp, "dup.md")
            self.assertTrue(got["ok"], f"第 {i} 次 dismiss 应成功：{got}")

        done = os.path.join(self.inbox, "已处理")
        entries = sorted(os.listdir(done))
        self.assertEqual(len(entries), 3, f"三次都应留存，实际 {entries}")
        payloads = []
        for entry in entries:
            with open(os.path.join(done, entry), encoding="utf-8") as fh:
                payloads.append(fh.read())
        self.assertEqual(len(set(payloads)), 3,
                         f"三份内容必须互不相同，实际 {payloads}")
        self.assertEqual(sorted(payloads), ["- 第1次\n", "- 第2次\n", "- 第3次\n"])

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

    def test_symlinked_done_dir_outside_inbox_is_rejected(self):
        """Important-2: 已处理/ must resolve inside the inbox, like the read path.

        The old code validated only the *source* dirname, so a symlinked
        Agent提交区/已处理/ pointing anywhere on disk would receive the file —
        a write escaping the inbox. preview.read_inbox_item already guards both
        sides; the write path must match.
        """
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside, exist_ok=True)
        done = os.path.join(self.inbox, "已处理")
        try:
            os.symlink(outside, done, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:  # pragma: no cover
            self.skipTest(f"symlinks unavailable on this host: {exc}")

        self._write("escape.md", "- 不该出去\n")
        got = inbox.process_inbox_item(self.tmp, "escape.md")
        self.assertFalse(got["ok"], "symlink 逃逸必须被拒绝")
        self.assertEqual(got["reason"], "outside-inbox")
        self.assertEqual(os.listdir(outside), [], "外部目录不得收到任何文件")
        self.assertTrue(os.path.exists(os.path.join(self.inbox, "escape.md")),
                        "被拒绝的条目必须留在 inbox 原位")


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
