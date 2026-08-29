# -*- coding: utf-8 -*-
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from unified_memory import forgetter, index
from unified_memory.common import canonical_path, forget_dir, read_maybe

from test_common import destroy_scratch, make_scratch_vault


class ForgetterScoreTest(unittest.TestCase):
    def test_score_keeps_high_importance_facts_indefinitely(self):
        # 6 years old, no accesses: an architecture decision stays above threshold.
        score = forgetter.memory_score(0.9, 0, 2190)
        self.assertGreaterEqual(score, forgetter.FORGET_THRESHOLD)

    def test_score_fades_low_importance_facts(self):
        # 6 months old, no accesses: an ordinary fact drops below threshold.
        score = forgetter.memory_score(0.5, 0, 180)
        self.assertLess(score, forgetter.FORGET_THRESHOLD)

    def test_score_reinforcement_rescues_used_facts(self):
        bare = forgetter.memory_score(0.5, 0, 180)
        used = forgetter.memory_score(0.5, 8, 180)
        self.assertGreater(used, bare)
        self.assertGreaterEqual(used, forgetter.FORGET_THRESHOLD)

    def test_demote_only_fades_transient_facts(self):
        vault = make_scratch_vault()
        try:
            ui = canonical_path(vault, "ui")
            ui.write_text(
                ui.read_text(encoding="utf-8")
                + "\n- 架构上采用微服务拆分（写入 2020-01-01｜来源：Agent提交区/codex-20200101-001-01.md）\n"
                + "- 临时服务器地址备忘（写入 2020-01-01｜来源：Agent提交区/codex-20200101-002-01.md）\n",
                encoding="utf-8",
            )
            index.update_index(vault)
            candidates = forgetter.demote(vault, dry_run=True)
            text = "\n".join(candidates)
            self.assertIn("临时服务器地址备忘", text)
            self.assertNotIn("架构上采用微服务拆分", text)
        finally:
            destroy_scratch(vault)


class ForgetterScheduleTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_windows_schedule_runs_apply_and_records_a_log(self):
        stale = "- obsolete release note（写入 2020-01-01｜来源：test.md）\n"
        ui = canonical_path(self.vault, "ui")
        ui.write_text(read_maybe(ui) + stale, encoding="utf-8")
        calls = []

        def capture_schedule(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0)

        with patch("platform.system", return_value="Windows"), patch.object(forgetter.subprocess, "run", side_effect=capture_schedule):
            forgetter.register_cron(self.vault)

        bat = self.vault / "50-Agent-Context" / "forget_weekly.bat"
        content = bat.read_text(encoding="utf-8-sig")
        self.assertIn("--apply", content)
        self.assertIn("exit /b %errorlevel%", content)
        self.assertEqual(calls[0][0][0], "schtasks")
        self.assertIn(f'"{bat}"', calls[0][0])

        # The .bat body is only executable on Windows; the generation + task
        # registration assertions above still run on every platform.
        if sys.platform != "win32":
            self.skipTest("forget_weekly.bat can only be executed on Windows")
        repo_core = str(Path(__file__).resolve().parents[1])
        env = os.environ.copy()
        env["PYTHONPATH"] = repo_core + os.pathsep + env.get("PYTHONPATH", "")
        completed = subprocess.run(["cmd.exe", "/c", str(bat)], env=env, capture_output=True, text=False, timeout=30)
        stderr = (completed.stderr or b"").decode(errors="replace")
        self.assertEqual(completed.returncode, 0, stderr)
        self.assertNotIn(stale.rstrip(), read_maybe(ui))
        self.assertIn(stale.rstrip(), read_maybe(forget_dir(self.vault) / ui.name))
        self.assertIn("demoted 1 line(s)", read_maybe(self.vault / "forget_weekly.log"))


if __name__ == "__main__":
    unittest.main()
