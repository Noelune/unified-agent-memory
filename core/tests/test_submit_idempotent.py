# -*- coding: utf-8 -*-
"""submit is idempotent: identical fact text never creates a second file.

The promoter's exact-text dedup (the `prior` set in promote.py) runs only at
review time, so every retry of the same fact minted another `dsh-*.md` and a
second `submit` audit row, and the caller heard nothing until review day.
The submission entry is where the caller is listening, so that is where the
idempotency lives: same exact normalized text, in the inbox or already in
已处理/, answers with the existing file instead of a new one.
"""
import contextlib
import io
import unittest
from argparse import Namespace

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.ingest import commands as ingest
from unified_memory.infra.store import audit_rows, audit_verify
from unified_memory.domain.policy import NON_SUBMISSION_FILES
from unified_memory.infra.vault import canonical_dir

def _submit(agent: str, fact: str) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ingest.cmd_submit(Namespace(agent=agent, fact=fact))
    return buf.getvalue()

class SubmitIdempotentTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _submissions(self) -> list:
        inbox = canonical_dir(self.vault) / "Agent提交区"
        return sorted(
            p.name
            for layer in (inbox, inbox / "已处理")
            if layer.is_dir()
            for p in layer.glob("*.md")
            if p.name not in NON_SUBMISSION_FILES
        )

    def test_resubmitting_the_same_fact_writes_no_second_file(self):
        first = _submit("dsh", "备份目录是 C:/backups")
        self.assertIn("submitted 1 fact line(s)", first)

        second = _submit("dsh", "备份目录是 C:/backups")
        self.assertIn("duplicate submission", second)

        names = self._submissions()
        self.assertEqual(len(names), 1, names)
        # The duplicate answers with the existing file, by name.
        self.assertIn(names[0], second)

        # Audit carries the idempotency: one submit row, one
        # submit-duplicate row, and the chain still verifies end to end.
        actions = [r["action"] for r in audit_rows(self.vault)]
        self.assertEqual(actions.count("submit"), 1)
        self.assertEqual(actions.count("submit-duplicate"), 1)
        ok, broken = audit_verify(self.vault)
        self.assertTrue(ok, broken)

    def test_a_different_agent_gets_the_same_answer(self):
        _submit("dsh", "部署脚本是 scripts/deploy.py")
        second = _submit("codex", "部署脚本是 scripts/deploy.py")
        self.assertIn("duplicate submission", second)
        self.assertEqual(len(self._submissions()), 1)

    def test_a_genuinely_new_fact_still_gets_its_own_file(self):
        # Negative control: the dedup is exact text, not "anything similar".
        _submit("dsh", "部署脚本是 scripts/deploy.py")
        second = _submit("dsh", "部署脚本是 D:/scripts/deploy.py")
        self.assertIn("submitted 1 fact line(s)", second)
        self.assertEqual(len(self._submissions()), 2)

if __name__ == "__main__":
    unittest.main()
