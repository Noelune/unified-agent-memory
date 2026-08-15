# -*- coding: utf-8 -*-
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from unified_memory import forgetter
from unified_memory.common import canonical_path, forget_dir, read_maybe

from test_common import destroy_scratch, make_scratch_vault


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
        completed = subprocess.run(["cmd.exe", "/c", str(bat)], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(stale.rstrip(), read_maybe(ui))
        self.assertIn(stale.rstrip(), read_maybe(forget_dir(self.vault) / ui.name))
        self.assertIn("demoted 1 line(s)", read_maybe(self.vault / "forget_weekly.log"))


if __name__ == "__main__":
    unittest.main()
