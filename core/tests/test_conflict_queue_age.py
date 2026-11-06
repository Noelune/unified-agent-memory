# -*- coding: utf-8 -*-
"""Queue age: timestamps, legacy fallback, idempotency, doctor and ordering."""
import io
import json
import re
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.govern.decide import adjudicate
from unified_memory.app.govern.queue import append_conflict, read_conflicts
from unified_memory.app.maintain import health
from unified_memory.domain.policy import CONFLICT_FILE
from unified_memory.infra.vault import atomic_write, read_maybe, situation_dir

AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
AT = "%Y-%m-%d %H:%M"


def _write_line(vault: Path, fields: dict) -> None:
    """Append one queue line the way the human-readable format expects."""
    path = situation_dir(vault) / CONFLICT_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    current = read_maybe(path)
    if not current.endswith("\n"):
        current += "\n"
    body = json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
    atomic_write(path, current + "- [ ] 冲突 " + body + "\n")


class QueueAgeTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_new_entries_carry_a_timestamp(self):
        append_conflict(self.vault, "端口是 9443", "端口是 8443", "test")
        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 1)
        self.assertRegex(str(entries[0].get("at", "")), AT_RE)
        # The reader's mtime fallback would also produce a valid timestamp,
        # so assert the writer really persisted the key.
        text = (situation_dir(self.vault) / CONFLICT_FILE).read_text(encoding="utf-8")
        self.assertIn('"at":', text)

    def test_legacy_entries_fall_back_to_file_mtime(self):
        _write_line(self.vault, {"新": "旧条目新值", "旧": "旧条目旧值", "来源": "legacy"})
        entries = read_conflicts(self.vault)
        self.assertEqual(len(entries), 1)
        self.assertRegex(str(entries[0].get("at", "")), AT_RE)

    def test_duplicate_submission_stays_idempotent(self):
        for _ in range(2):
            append_conflict(self.vault, "端口是 9443", "端口是 8443", "test")
        self.assertEqual(len(read_conflicts(self.vault)), 1)

    def test_doctor_reports_oldest_and_stale(self):
        old = (datetime.now() - timedelta(days=40)).strftime(AT)
        fresh = (datetime.now() - timedelta(days=1)).strftime(AT)
        _write_line(self.vault, {"新": "旧矛盾新值", "旧": "旧矛盾旧值", "来源": "test", "at": old})
        _write_line(self.vault, {"新": "新矛盾新值", "旧": "新矛盾旧值", "来源": "test", "at": fresh})
        report = health.doctor(self.vault)
        self.assertEqual(report["conflicts"]["count"], 2)
        self.assertGreaterEqual(report["conflicts"]["oldestDays"], 39)
        self.assertEqual(report["conflicts"]["staleCount"], 1)
        codes = [issue["code"] for issue in report["issues"]]
        self.assertIn("conflicts-pending", codes)
        self.assertIn("conflicts-stale", codes)

    def test_adjudicate_shows_oldest_first(self):
        old = (datetime.now() - timedelta(days=40)).strftime(AT)
        fresh = (datetime.now() - timedelta(days=1)).strftime(AT)
        _write_line(self.vault, {"新": "新的那条", "旧": "新侧旧值", "来源": "test", "at": fresh})
        _write_line(self.vault, {"新": "最老那条", "旧": "旧侧旧值", "来源": "test", "at": old})
        out = io.StringIO()
        with patch("builtins.input", return_value="跳过"), redirect_stdout(out):
            adjudicate(self.vault)
        printed = out.getvalue()
        self.assertLess(printed.index("最老那条"), printed.index("新的那条"))


if __name__ == "__main__":
    unittest.main()
