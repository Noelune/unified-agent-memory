# -*- coding: utf-8 -*-
"""schedule jobs — the one place that talks to Windows Task Scheduler/crontab.

Before B5.4, `promoter --cron` and `forgetter --cron` each carried their own
copy of the platform dialogue (quoting, PYTHONPATH baking, idempotency marker).
They now hand `infra.schedule.register_job` a `JobSpec`. These tests pin what
each job actually registers, so unifying them cannot silently change a
schedule, and pin that a missing binary degrades instead of raising.
"""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from unified_memory import forgetter, promoter
from unified_memory.infra import schedule

from test_common import destroy_scratch, make_scratch_vault


class JobRegistrationTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.home = Path(tempfile.mkdtemp(prefix="um-home-"))

    def tearDown(self):
        destroy_scratch(self.vault)
        for path in sorted(self.home.rglob("*"), reverse=True):
            path.unlink() if path.is_file() else path.rmdir()
        self.home.rmdir()

    def _install(self, register):
        calls = []

        def capture(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0)

        with patch("platform.system", return_value="Linux"), \
                patch.object(Path, "home", return_value=self.home), \
                patch("unified_memory.infra.schedule.subprocess.run", side_effect=capture):
            register(self.vault)
            register(self.vault)  # a second run must not duplicate the entry
        return calls, (self.home / ".crontab").read_text(encoding="utf-8")

    def test_promoter_job_runs_auto_daily_at_three(self):
        calls, crontab = self._install(promoter.register_cron)
        self.assertIn("0 3 * * *", crontab)
        self.assertIn("unified_memory.promoter", crontab)
        self.assertIn("--auto", crontab)
        self.assertIn("PYTHONPATH=", crontab, "source checkouts must be self-sufficient")
        self.assertEqual(crontab.count("unified_memory.promoter"), 1)
        self.assertEqual(calls[-1][0][0], "crontab")

    def test_forget_job_runs_apply_weekly_on_monday(self):
        calls, crontab = self._install(forgetter.register_cron)
        self.assertIn("0 4 * * 1", crontab)
        self.assertIn("unified_memory.forgetter", crontab)
        self.assertIn("--apply", crontab)
        self.assertEqual(crontab.count("unified_memory.forgetter"), 1)
        self.assertEqual(calls[-1][0][0], "crontab")

    def test_both_jobs_can_live_in_the_same_crontab(self):
        with patch("platform.system", return_value="Linux"), \
                patch.object(Path, "home", return_value=self.home), \
                patch("unified_memory.infra.schedule.subprocess.run"):
            promoter.register_cron(self.vault)
            forgetter.register_cron(self.vault)
        crontab = (self.home / ".crontab").read_text(encoding="utf-8")
        self.assertIn("unified_memory.promoter", crontab)
        self.assertIn("unified_memory.forgetter", crontab)

    def test_the_windows_script_carries_the_bom_and_the_exit_code(self):
        with patch("platform.system", return_value="Windows"), \
                patch("unified_memory.infra.schedule.subprocess.run") as run:
            forgetter.register_cron(self.vault)
        bat = self.vault / "50-Agent-Context" / "forget_weekly.bat"
        raw = bat.read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "cmd.exe needs the UTF-8 BOM")
        body = raw.decode("utf-8-sig")
        self.assertIn("--apply", body)
        self.assertIn("exit /b %errorlevel%", body)
        self.assertEqual(run.call_args[0][0][0], "schtasks")


class RunCommandTest(unittest.TestCase):
    def test_a_missing_binary_returns_none_instead_of_raising(self):
        self.assertIsNone(schedule.run_command(["um-definitely-not-a-binary"]))

    def test_a_real_command_reports_its_output(self):
        result = schedule.run_command([str(Path(__import__("sys").executable)), "-c", "print('ok')"])
        self.assertIsNotNone(result)
        self.assertEqual(result.returncode, 0)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
