# -*- coding: utf-8 -*-
"""Audit trail (batch A): record_audit existed since v1 with zero call sites,
so the audit table README pointed at was always empty. Every write path now
appends hash-chained rows and ``memory audit --verify`` recomputes the chain.
"""
from __future__ import annotations

import io
import unittest
from argparse import Namespace
from contextlib import redirect_stdout

from unified_memory import promoter
from unified_memory.infra.store import audit_rows, audit_verify, get_conn, record_audit
from test_common import destroy_scratch, make_scratch_vault

from unified_memory.memory import cmd_audit
from unified_memory.infra.vault import canonical_dir, canonical_path

def _audit_args(**overrides) -> Namespace:
    defaults = {
        "agent": None,
        "target": None,
        "since": None,
        "limit": 10,
        "recompute": False,
        "as_json": False,
    }
    defaults.update(overrides)
    # cmd_audit reads them under their CLI names.
    values = dict(defaults)
    values["verify"] = values.pop("recompute")
    values["json"] = values.pop("as_json")
    return Namespace(**values)

class AuditTrailTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def _count(self) -> int:
        conn = get_conn(self.vault)
        try:
            return conn.execute("SELECT COUNT(*) AS c FROM audit").fetchone()["c"]
        finally:
            conn.close()

    def test_submit_leaves_one_row(self) -> None:
        from unified_memory.memory import cmd_submit

        cmd_submit(Namespace(fact="a fact worth keeping", agent="tester"))
        cmd_submit(Namespace(fact="another fact worth keeping", agent="tester"))
        self.assertGreaterEqual(self._count(), 2)
        rows = audit_rows(self.vault)
        self.assertTrue(any(r["action"] == "submit" for r in rows))

    def test_promote_and_decide_leave_chained_rows(self) -> None:
        env = canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- 同步端口为 8443（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        inbox = canonical_dir(self.vault) / "Agent提交区"
        inbox.mkdir(parents=True, exist_ok=True)
        # One promotable fact (drives a promote row) + one contradiction
        # (drives a decide row after adjudication).
        (inbox / "tester-20260101-01.md").write_text(
            "- 构建产物必须经过 typecheck 才能合并\n- 同步端口为 9443\n",
            encoding="utf-8",
        )
        promoter.auto_promote(self.vault, verbose=False)
        from unified_memory.app.govern.queue import read_conflicts

        entry = read_conflicts(self.vault)[0]
        promoter.decide(self.vault, entry, "用新")
        rows = audit_rows(self.vault)
        actions = [r["action"] for r in rows]
        self.assertIn("promote", actions)
        self.assertTrue(any(a.startswith("decide:") for a in actions))
        ok, broken = audit_verify(self.vault)
        self.assertTrue(ok, broken)

    def test_forget_leaves_a_row(self) -> None:
        from unified_memory import forgetter

        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            "- prefers the legacy staging alias（写入 2025-01-01｜来源：Agent提交区/old-20250101-01.md）\n",
            encoding="utf-8",
        )
        forgetter.demote(self.vault, dry_run=False)
        rows = audit_rows(self.vault)
        self.assertTrue(any(r["action"] == "demote" for r in rows))
        ok, broken = audit_verify(self.vault)
        self.assertTrue(ok, broken)

    def test_tampering_breaks_verify(self) -> None:
        record_audit(self.vault, "a", "op1", "t1", "one")
        record_audit(self.vault, "a", "op2", "t2", "two")
        ok, _ = audit_verify(self.vault)
        self.assertTrue(ok)
        conn = get_conn(self.vault)
        try:
            conn.execute("UPDATE audit SET detail = 'forged' WHERE action = 'op1'")
            conn.commit()
        finally:
            conn.close()
        ok, broken = audit_verify(self.vault)
        self.assertFalse(ok)
        self.assertIn("chain", broken)

    def test_cli_lists_and_verifies(self) -> None:
        record_audit(self.vault, "tester", "submit", "f.md", "hello")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            cmd_audit(_audit_args(agent="tester"))
        self.assertIn("submit", buffer.getvalue())
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            cmd_audit(_audit_args(recompute=True, limit=0))
        self.assertIn("audit chain OK", buffer.getvalue())

    def test_pre_chain_rows_do_not_break_verify(self) -> None:
        # A database written before the chain carries NULL hashes; verification
        # treats those as unlinked history, not tampering.
        record_audit(self.vault, "a", "op1", "t1", "one")
        conn = get_conn(self.vault)
        try:
            conn.execute("UPDATE audit SET prev_hash = NULL, entry_hash = NULL")
            conn.commit()
        finally:
            conn.close()
        ok, _ = audit_verify(self.vault)
        self.assertTrue(ok)

if __name__ == "__main__":
    unittest.main()
