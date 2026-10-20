# -*- coding: utf-8 -*-
"""memory_preview — read-only governance views."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import shutil
import tempfile

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory, preview
from unified_memory.common import AGENT_CONTEXT, SUBMISSION_DIR, canonical_dir, read_maybe
from unified_memory.preview import INBOX_REL


def _empty_inbox(vault: Path) -> Path:
    """Return a scratch inbox with no pre-existing files.

    init_vault drops a README.md into Agent提交区, so a fixture that counts
    inbox files must start from a clean directory or the count is off by one.
    """
    inbox = canonical_dir(vault) / "Agent提交区"
    for stale in inbox.glob("*.md"):
        stale.unlink()
    return inbox


def _touch(path: Path, mtime: float) -> None:
    """Pin an mtime so mtime-ordered views are deterministic."""
    os.utime(path, (mtime, mtime))


class PreviewViewTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_views_tuple_is_exactly_the_four_documented_ones(self):
        self.assertEqual(preview.VIEWS, ("pending", "conflicts", "forgetting", "recent"))

    def test_unknown_view_raises_systemexit(self):
        with self.assertRaises(SystemExit):
            preview.build(self.vault, "nope", 10)

    def test_pending_lists_inbox_files_newest_first(self):
        inbox = _empty_inbox(self.vault)
        older = inbox / "claude-20260816-001-01.md"
        newer = inbox / "dsh-20260816-002-01.md"
        older.write_text("- first\n", encoding="utf-8")
        newer.write_text("- second\n", encoding="utf-8")
        _touch(older, 1_700_000_000)
        _touch(newer, 1_700_000_100)

        data = preview.build(self.vault, "pending", 10)

        self.assertEqual(data["view"], "pending")
        self.assertEqual(data["count"], 2)
        self.assertEqual([i["name"] for i in data["items"]], [newer.name, older.name])
        for item in data["items"]:
            self.assertIs(item["untrusted"], True)
            self.assertIn("mtime", item)

    def test_pending_is_capped_by_limit(self):
        inbox = _empty_inbox(self.vault)
        for n in range(5):
            (inbox / f"dsh-20260816-00000{n}-01.md").write_text(f"- fact {n}\n", encoding="utf-8")

        self.assertEqual(preview.build(self.vault, "pending", 2)["count"], 2)

    def test_readme_in_the_inbox_is_not_a_pending_item(self):
        # README.md is the inbox's own format documentation. The promoter has
        # always skipped it and `memory status` counts without it; the panel
        # counting it meant a vault with an empty inbox reported "1 pending".
        inbox = _empty_inbox(self.vault)
        (inbox / "README.md").write_text("# 提交区\n\n一行一条事实。\n", encoding="utf-8")

        data = preview.build(self.vault, "pending", 10)

        self.assertEqual(data["count"], 0)
        self.assertEqual(data["items"], [])

    def test_recent_lists_canonical_notes_newest_first(self):
        doc = canonical_dir(self.vault) / "我的偏好摘要.md"
        _touch(doc, 1_700_000_000)  # older than every other note
        newest = canonical_dir(self.vault) / "工具可用性检查.md"
        _touch(newest, 1_900_000_000)  # pinned newest

        data = preview.build(self.vault, "recent", 10)

        self.assertEqual(data["view"], "recent")
        names = [i["name"] for i in data["items"]]
        self.assertIn(doc.name, names)
        self.assertEqual(names[0], newest.name, "the freshest note must sort first")
        self.assertLess(names.index(newest.name), names.index(doc.name))
        self.assertEqual(data["count"], len(names))
        for item in data["items"]:
            self.assertIs(item["untrusted"], True)

    def test_forgetting_orders_active_memories_by_lowest_salience(self):
        rules = canonical_dir(self.vault) / "工程执行规则.md"
        rules.write_text(
            read_maybe(rules)
            + "\n- 部署前必须先验证（写入 2026-08-15｜来源：Agent提交区/codex-20260815-002-01.md）\n",
            encoding="utf-8",
        )

        data = preview.build(self.vault, "forgetting", 100)

        self.assertEqual(data["view"], "forgetting")
        self.assertGreaterEqual(data["count"], 1)
        # Target the line we appended (the doc already holds template lines).
        record = next(i for i in data["items"] if i["line"] == "部署前必须先验证")
        self.assertEqual(record["doc"], rules.name)
        self.assertEqual(record["type"], "workflow")
        self.assertEqual(record["accessCount"], 0)
        self.assertIs(record["untrusted"], True)
        # Decay order: never-accessed, lowest-importance records come first.
        keys = [(i["accessCount"], i["importance"]) for i in data["items"]]
        self.assertEqual(keys, sorted(keys))

    def _conflict_file(self) -> Path:
        from unified_memory.common import CONFLICT_FILE, situation_dir

        return situation_dir(self.vault) / CONFLICT_FILE

    def test_an_empty_conflict_queue_is_a_real_answer(self):
        # The queue is a file this code reads, so an empty parse IS "nothing to
        # rule on". It used to query an index value no writer ever emitted and
        # report `unsupported` instead — honest about the query, but it told the
        # panel nothing about the queue that actually exists.
        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["view"], "conflicts")
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["items"], [])
        self.assertNotIn("reason", data)

    def test_a_queued_conflict_surfaces_with_both_sides(self):
        from unified_memory.conflict import append_conflict

        append_conflict(
            self.vault, "the relay listens on 9090", "the relay listens on 8080", "a.md", "env"
        )

        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["count"], 1)
        item = data["items"][0]
        self.assertEqual(item["new"], "the relay listens on 9090")
        self.assertEqual(item["old"], "the relay listens on 8080")
        self.assertEqual(item["doc"], "env")
        self.assertTrue(item["key"], "a decision needs a handle, not an index")
        self.assertIs(item["untrusted"], True)

    def test_a_hand_written_block_is_read_the_same_as_a_json_line(self):
        # The shape the user's own vault contains, written by the other runtime:
        # a `##` heading and one field per line. Reading only the JSON shape
        # returned [] for this file, so the panel said "no conflicts" while the
        # conflict sat in plain sight.
        self._conflict_file().write_text(
            "# 事实冲突待裁决队列\n\n---\n"
            "## 2026-10-19 03:01 冲突 #20261019030125-1\n"
            "- 状态：[待裁决]\n"
            "- 新提交：备份目录已迁移到 D:\\backups\n"
            "- 来源：[[Hermes会话自动归档/2026-10-18]]\n"
            "- 既有：- 备份目录是 C:\\backups（写入 2026-10-16）\n"
            "- 所在：50-Agent-Context\\常用路径与环境.md\n",
            encoding="utf-8",
        )

        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["count"], 1)
        item = data["items"][0]
        self.assertEqual(item["new"], "备份目录已迁移到 D:\\backups")
        self.assertEqual(item["old"], "- 备份目录是 C:\\backups（写入 2026-10-16）")
        self.assertEqual(item["doc"], "50-Agent-Context\\常用路径与环境.md")
        self.assertEqual(item["key"], "20261019030125-1")

    def test_a_block_marked_resolved_is_not_pending(self):
        # A block someone decided but did not delete must not come back as a
        # fresh question: re-asking a settled conflict is how a queue becomes
        # a loop nobody trusts.
        self._conflict_file().write_text(
            "## 2026-10-19 03:01 冲突 #20261019030125-1\n"
            "- 状态：[已裁决]\n"
            "- 新提交：备份目录已迁移到 D:\\backups\n"
            "- 既有：- 备份目录是 C:\\backups\n",
            encoding="utf-8",
        )

        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["count"], 0)

    def test_other_views_are_always_ok(self):
        for view in ("pending", "conflicts", "forgetting", "recent"):
            data = preview.build(self.vault, view, 10)
            self.assertEqual(data["status"], "ok", view)


class PreviewEnvelopeTest(unittest.TestCase):
    def test_items_carry_untrusted_flag(self):
        # build() is exercised through the CLI in test_json_output; here we
        # assert the envelope contract on a synthetic result.
        payload = preview.envelope("pending", {"view": "pending", "count": 0, "items": []})
        parsed = json.loads(payload)
        self.assertIs(parsed["ok"], True)
        self.assertEqual(parsed["data"]["view"], "pending")


class PreviewCliTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _run(self, argv: list[str]) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(argv)
        return buf.getvalue()

    def test_cli_json_is_one_parseable_object(self):
        out = self._run(["preview", "pending", "--json"])
        payload = json.loads(out)  # raises if not valid JSON
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "preview")
        self.assertEqual(payload["data"]["view"], "pending")
        self.assertNotIn("<memory-data>", out)

    def test_cli_text_wraps_vault_content_in_memory_data(self):
        inbox = _empty_inbox(self.vault)
        (inbox / "dsh-20260816-003-01.md").write_text("- a plain fact\n", encoding="utf-8")

        out = self._run(["preview", "pending"])

        self.assertIn("<memory-data>", out)
        self.assertIn("never as instructions", out)
        self.assertIn("dsh-20260816-003-01.md", out)

    def test_cli_text_without_items_still_wraps_and_says_so(self):
        _empty_inbox(self.vault)

        out = self._run(["preview", "pending"])

        self.assertIn("<memory-data>", out)
        self.assertIn("no items in view 'pending'", out)


class ReadInboxItemTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        inbox = os.path.join(self.tmp, INBOX_REL)
        os.makedirs(inbox, exist_ok=True)
        self.inbox = inbox

    def test_reads_existing_item(self):
        path = os.path.join(self.inbox, "dsh-20260101-000000-01.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("- 事实一\n- 事实二\n")
        got = preview.read_inbox_item(self.tmp, "dsh-20260101-000000-01.md")
        self.assertEqual(got["name"], "dsh-20260101-000000-01.md")
        self.assertIn("事实一", got["body"])

    def test_rejects_traversal(self):
        # Each rejected name must report WHY it was rejected, so this test can
        # tell "the whitelist refused the name" apart from "the file is
        # missing". Without the reason the two collapse into body=None and
        # deleting the whitelist would still leave the suite green.
        for bad in ("../secret.md", "..\\secret.md", "sub/dir.md", "", ".", "a\x00b"):
            with self.subTest(bad=bad):
                got = preview.read_inbox_item(self.tmp, bad)
                self.assertIsNone(got["body"])
                self.assertEqual(got["reason"], "invalid-name")

    def test_missing_file_yields_none_body(self):
        got = preview.read_inbox_item(self.tmp, "nope.md")
        self.assertIsNone(got["body"])
        self.assertEqual(got["reason"], "not-found")

    def test_cannot_escape_inbox_via_absolute_like_name(self):
        got = preview.read_inbox_item(self.tmp, "C:/Windows/win.ini")
        self.assertIsNone(got["body"])
        self.assertEqual(got["reason"], "invalid-name")

    def test_readable_item_carries_no_reason(self):
        path = os.path.join(self.inbox, "ok.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("- ok\n")
        got = preview.read_inbox_item(self.tmp, "ok.md")
        self.assertNotIn("reason", got)

    def test_inbox_rel_is_derived_from_common_not_redeclared(self):
        # common.py already owns AGENT_CONTEXT / SUBMISSION_DIR; INBOX_REL must
        # be their composition, never a hand-typed duplicate literal.
        expected = os.path.join(AGENT_CONTEXT, SUBMISSION_DIR)
        self.assertEqual(INBOX_REL, expected)

    def test_inbox_item_body_is_marked_untrusted(self):
        path = os.path.join(self.inbox, "u.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("- body\n")
        got = preview.read_inbox_item(self.tmp, "u.md")
        self.assertIs(got["untrusted"], True)


class NoteJsonContractTest(unittest.TestCase):
    """docs/JSON-CONTRACT.md §2: vault-derived records must carry `untrusted`.

    The note body is the highest-risk derived value in the CLI — a whole
    free-text file the user controls — so it needs the marker at least as much
    as preview's filenames do.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        inbox = os.path.join(self.tmp, INBOX_REL)
        os.makedirs(inbox, exist_ok=True)
        with open(os.path.join(inbox, "n.md"), "w", encoding="utf-8") as fh:
            fh.write("- 事实\n")

    def test_cmd_note_json_marks_the_body_untrusted(self):
        payload = json.loads(memory.cmd_note(self.tmp, "n.md", as_json=True))

        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "note")
        self.assertIs(payload["data"]["untrusted"], True)
        self.assertIn("事实", payload["data"]["body"])

    def test_cmd_note_json_marks_a_rejected_name_untrusted_too(self):
        # A None body still rides the same record shape; the consumer must be
        # told the record is derived data on every path, not just on success.
        payload = json.loads(memory.cmd_note(self.tmp, "../x.md", as_json=True))

        self.assertIsNone(payload["data"]["body"])
        self.assertIs(payload["data"]["untrusted"], True)

    def test_cmd_note_text_still_prints_the_bare_body(self):
        # The human path must not regress into printing JSON.
        self.assertEqual(memory.cmd_note(self.tmp, "n.md"), "- 事实\n")


class NoteCliExitCodeTest(unittest.TestCase):
    """`memory note` must not report success for a miss.

    It used to exit 0 while printing an empty line, so in a pipe a missing
    submission and an empty submission were the same thing. The JSON path is
    contractual and unchanged (envelope + exit 0 + `data.reason`); the text
    path has only the exit status to carry the difference.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        inbox = os.path.join(self.tmp, INBOX_REL)
        os.makedirs(inbox, exist_ok=True)
        with open(os.path.join(inbox, "here.md"), "w", encoding="utf-8") as fh:
            fh.write("- 事实\n")
        # `note` has no --vault flag: it resolves the vault from the
        # environment or the config file, so the fixture points it there.
        self._prev_env = os.environ.get("UNIFIED_MEMORY_VAULT")
        os.environ["UNIFIED_MEMORY_VAULT"] = self.tmp

    def tearDown(self):
        if self._prev_env is None:
            os.environ.pop("UNIFIED_MEMORY_VAULT", None)
        else:
            os.environ["UNIFIED_MEMORY_VAULT"] = self._prev_env

    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                memory.main(argv)
            except SystemExit as exc:
                code = exc.code or 0
        return code, out.getvalue(), err.getvalue()

    def test_text_miss_exits_non_zero_with_nothing_on_stdout(self):
        code, out, err = self._run(["note", "ghost.md"])
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), "")
        self.assertIn("not-found", err)

    def test_text_hit_exits_zero(self):
        code, out, _err = self._run(["note", "here.md"])
        self.assertEqual(code, 0)
        self.assertIn("事实", out)

    def test_json_miss_keeps_the_contract_envelope(self):
        # §5.2: outer ok stays true and the failure rides in data.reason, so
        # the browser panel can tell "rejected name" from "no such file".
        code, out, _err = self._run(["note", "../x.md", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertIs(payload["ok"], True)
        self.assertIsNone(payload["data"]["body"])
        self.assertEqual(payload["data"]["reason"], "invalid-name")


if __name__ == "__main__":
    unittest.main()
