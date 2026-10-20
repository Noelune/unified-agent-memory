# -*- coding: utf-8 -*-
"""Infrastructure files in the submission directory are not submissions.

`Agent提交区/` holds three different kinds of file:

  README.md      documents the format
  前缀登记.md    the prefix registry that setup and the upgrade flow merge into
  <agent>-*.md   actual submissions waiting for a human

Every reader used to exclude only `README.md`, so the registry — a file the
plugin writes about itself — was counted and listed as one pending item. The
panel showed a 待确认 with nothing to confirm, which is the confusing part this
suite pins down.

The consequences were worse than a wrong number:

  * `promote --review` reads unmasked `*.md` as fact lines, so the registry's
    table rows would have been ingested as memories.
  * `dismiss` (and `promote --apply`) move the file to `已处理/`. The upgrade
    merge then finds no registry at the path it owns and recreates the table
    with only this runtime's row, dropping every other runtime's registrations.

One constant (`common.NON_SUBMISSION_FILES`) now answers for all of them, and
each test below asserts one of those readers so a new reader that forgets it
fails here rather than in the panel.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault

from unified_memory import health, inbox, memory, preview, promoter, stats
from unified_memory.common import NON_SUBMISSION_FILES, canonical_dir

REGISTRY = "前缀登记.md"
README = "README.md"
SUBMISSION = "dsh-20260814-120000-01.md"


class NonSubmissionFilesTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.inbox = canonical_dir(self.vault) / "Agent提交区"
        # `init_vault` drops the README itself; start from a known set.
        for stale in self.inbox.glob("*.md"):
            stale.unlink()
        (self.inbox / README).write_text("# 提交区\n", encoding="utf-8")
        (self.inbox / REGISTRY).write_text(
            "# 提交前缀登记\n\n| 前缀 | 运行时 |\n| --- | --- |\n| `dsh-` | 本机 |\n",
            encoding="utf-8",
        )
        (self.inbox / SUBMISSION).write_text("- the build server listens on 8080\n", encoding="utf-8")

    def tearDown(self):
        destroy_scratch(self.vault)

    # ---- the constant itself -------------------------------------------

    def test_the_set_names_both_infrastructure_files(self):
        self.assertEqual(NON_SUBMISSION_FILES, frozenset({README, REGISTRY}))
        self.assertNotIn(SUBMISSION, NON_SUBMISSION_FILES)

    # ---- readers -------------------------------------------------------

    def test_pending_view_lists_only_real_submissions(self):
        data = preview.build(self.vault, "pending", 20)
        names = [it["name"] for it in data["items"]]
        self.assertEqual(names, [SUBMISSION])
        self.assertEqual(data["count"], 1)

    def test_stats_inbox_count_ignores_infrastructure(self):
        self.assertEqual(stats._inbox_count(self.vault), 1)

    def test_doctor_inbox_section_ignores_infrastructure(self):
        report = health.doctor(self.vault)
        self.assertEqual(report["inbox"]["count"], 1)
        self.assertEqual(report["inbox"]["files"], [SUBMISSION])

    def test_status_pending_count_ignores_infrastructure(self):
        # `cmd_status` computes this inline (unlike the other three readers, it
        # does not go through a helper), so it is exercised through its own
        # surface: the panel's /status route runs this command.
        args = argparse.Namespace(json=True)
        buf = io.StringIO()
        with mock.patch.object(memory, "resolve_vault", return_value=self.vault), \
                contextlib.redirect_stdout(buf):
            memory.cmd_status(args)
        data = json.loads(buf.getvalue())["data"]
        self.assertEqual(data.get("inboxPending"), 1)

    # ---- writers -------------------------------------------------------

    def test_dismiss_refuses_to_retire_the_registry(self):
        result = inbox.process_inbox_item(str(self.vault), REGISTRY)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "not-a-submission")
        self.assertTrue((self.inbox / REGISTRY).is_file(), "the registry must stay put")

    def test_dismiss_refuses_to_retire_the_readme(self):
        result = inbox.process_inbox_item(str(self.vault), README)
        self.assertEqual(result["reason"], "not-a-submission")
        self.assertTrue((self.inbox / README).is_file())

    def test_dismiss_still_retires_a_real_submission(self):
        # The refusal above must not become a blanket "nothing can be retired".
        result = inbox.process_inbox_item(str(self.vault), SUBMISSION)
        self.assertTrue(result["ok"], result)
        self.assertFalse((self.inbox / SUBMISSION).exists())
        self.assertTrue((self.inbox / "已处理" / SUBMISSION).is_file())

    def test_review_does_not_read_registry_rows_as_facts(self):
        # The registry's table rows are the exact shape of a submitted fact, so
        # a review that forgets the mask promotes a bookkeeping table into
        # canonical notes. `source_files` is the review's own answer to "what did
        # I read", which makes the leak visible without inspecting prose.
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["source_files"], {SUBMISSION})
        for entry in result["pending"]:
            self.assertEqual(entry["source"], SUBMISSION)
        self.assertNotIn("提交前缀登记", json.dumps(result["pending"], ensure_ascii=False))

    def test_archive_sources_will_not_move_the_registry(self):
        # `promote --apply` archives every reviewed source by name; the name
        # mask has to hold there too, or the registry leaves its merge path.
        promoter.archive_sources(self.vault, {REGISTRY, README, SUBMISSION})
        self.assertTrue((self.inbox / REGISTRY).is_file())
        self.assertTrue((self.inbox / README).is_file())
        self.assertFalse((self.inbox / SUBMISSION).exists())
        self.assertTrue((self.inbox / "已处理" / SUBMISSION).is_file())


if __name__ == "__main__":
    unittest.main()
