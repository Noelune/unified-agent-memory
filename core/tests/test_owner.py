# -*- coding: utf-8 -*-
"""Single-writer rule: who may rewrite 50-Agent-Context canonical notes.

Hermes记忆系统规范.md opens with "Obsidian canonical 是唯一事实源；所有 Agent
只读，唯一写者 Hermes". This package used to be a silent second writer. The
declaration file added in common.py turns that into an explicit refusal, and
these tests pin both halves of the contract: an absent declaration keeps the
historical behaviour, a declaration naming another owner stops the write before
any byte is touched.
"""
import io
import unittest
from contextlib import redirect_stderr

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import forgetter, maintenance, promoter
from unified_memory.common import (
    CanonicalOwnerError,
    canonical_dir,
    canonical_owner,
    canonical_path,
    claim_canonical_owner,
    owner_lock_path,
    read_maybe,
    release_canonical_owner,
)


class CanonicalOwnerTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        release_canonical_owner()

    def tearDown(self):
        release_canonical_owner()
        destroy_scratch(self.vault)

    # -- helpers ---------------------------------------------------------

    def write_inbox(self, name, facts):
        path = canonical_dir(self.vault) / "Agent提交区" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def promote_one(self, fact="服务器使用阿里云 47.105.34.8"):
        self.write_inbox("dsh-20261019-140000-01.md", [fact])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        return promoter.apply_pending(self.vault, verbose=False)

    def canonical_text(self, doc="env"):
        return read_maybe(canonical_path(self.vault, doc))

    # -- declaration lifecycle -------------------------------------------

    def test_owner_is_undeclared_by_default(self):
        self.assertIsNone(canonical_owner())
        self.assertFalse(owner_lock_path().exists())

    def test_claim_and_release_round_trip(self):
        claim_canonical_owner("hermes")
        self.assertEqual(canonical_owner(), "hermes")
        self.assertTrue(release_canonical_owner())
        self.assertIsNone(canonical_owner())
        # Releasing twice is a no-op, not an error.
        self.assertFalse(release_canonical_owner())

    def test_claim_rejects_an_unknown_owner(self):
        with self.assertRaises(ValueError):
            claim_canonical_owner("codex")

    # -- promotion gate ---------------------------------------------------

    def test_undeclared_owner_keeps_promotion_working(self):
        """No declaration = nobody claimed it; historical behaviour is preserved."""
        self.assertEqual(self.promote_one(), 1)
        self.assertIn("47.105.34.8", self.canonical_text())

    def test_declared_hermes_refuses_promotion_without_touching_files(self):
        claim_canonical_owner("hermes")
        before = self.canonical_text()
        with self.assertRaises(CanonicalOwnerError) as ctx:
            self.promote_one()
        self.assertIn("hermes", str(ctx.exception))
        # The refusal happens before any write: the note is byte-identical.
        self.assertEqual(before, self.canonical_text())
        self.assertNotIn("47.105.34.8", self.canonical_text())

    def test_declared_core_keeps_promotion_working(self):
        claim_canonical_owner("core")
        self.assertEqual(self.promote_one(), 1)
        self.assertIn("47.105.34.8", self.canonical_text())

    def test_release_restores_promotion_after_a_hermes_claim(self):
        claim_canonical_owner("hermes")
        with self.assertRaises(CanonicalOwnerError):
            self.promote_one()
        release_canonical_owner()
        self.assertEqual(self.promote_one(), 1)

    # -- forgetting gate --------------------------------------------------

    def test_forgetting_dry_run_is_still_allowed_under_a_hermes_claim(self):
        """A dry run writes nothing, so the single-writer rule does not apply."""
        claim_canonical_owner("hermes")
        forgetter.demote(self.vault, dry_run=True)  # must not raise

    def test_forgetting_refuses_a_real_run_under_a_hermes_claim(self):
        claim_canonical_owner("hermes")
        with self.assertRaises(CanonicalOwnerError):
            forgetter.demote(self.vault, dry_run=False)

    # -- hygiene gate -----------------------------------------------------
    #
    # `--repair-existing` is the third canonical writer and the easiest to
    # forget: it reads as housekeeping, but it rewrites the notes.

    def test_repair_dry_run_is_still_allowed_under_a_hermes_claim(self):
        claim_canonical_owner("hermes")
        maintenance.repair_existing(self.vault, dry_run=True)  # must not raise

    def test_repair_refuses_a_real_run_under_a_hermes_claim(self):
        claim_canonical_owner("hermes")
        before = self.canonical_text()
        with self.assertRaises(CanonicalOwnerError):
            maintenance.repair_existing(self.vault, dry_run=False)
        self.assertEqual(before, self.canonical_text())

    # -- CLI surface ------------------------------------------------------
    #
    # A declared owner is a configuration decision, not a crash. The CLI has to
    # say so in one line and exit non-zero, instead of printing a traceback.

    def test_cli_reports_the_refusal_as_one_line_and_exits_non_zero(self):
        claim_canonical_owner("hermes")
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as raised:
            promoter.main(["--apply", "--vault", str(self.vault)])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("refused:", err.getvalue())
        self.assertIn("hermes", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())

    def test_cli_repair_reports_the_refusal_too(self):
        claim_canonical_owner("hermes")
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as raised:
            promoter.main(["--repair-existing", "--vault", str(self.vault)])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("refused:", err.getvalue())


if __name__ == "__main__":
    unittest.main()
