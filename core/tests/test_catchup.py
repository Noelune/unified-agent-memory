# -*- coding: utf-8 -*-
import datetime as dt
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import catchup, forgetter, promoter
from unified_memory.common import canonical_dir, canonical_path, read_maybe, read_schedule_state

WEDNESDAY = dt.datetime(2026, 10, 28, 12, 0)  # after both anchors this week
MONDAY_EARLY = dt.datetime(2026, 10, 26, 2, 0)  # Monday before 04:00
MONDAY_LATE = dt.datetime(2026, 10, 26, 5, 0)  # Monday after 04:00


class WeeklyAnchorTest(unittest.TestCase):
    def test_before_monday_04_the_anchor_is_last_week(self):
        self.assertEqual(catchup.weekly_anchor(MONDAY_EARLY), dt.date(2026, 10, 19))

    def test_after_monday_04_the_anchor_is_this_week(self):
        self.assertEqual(catchup.weekly_anchor(MONDAY_LATE), dt.date(2026, 10, 26))

    def test_midweek_anchor_is_that_weeks_monday(self):
        self.assertEqual(catchup.weekly_anchor(WEDNESDAY), dt.date(2026, 10, 26))


class DueTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_fresh_vault_is_all_due(self):
        report = catchup.due(self.vault, now=WEDNESDAY)
        self.assertTrue(report["promote"])
        self.assertTrue(report["forget"])

    def test_todays_promote_stamp_suppresses_daily_due(self):
        catchup.run(self.vault, now=WEDNESDAY)  # stamps both jobs for WEDNESDAY
        report = catchup.due(self.vault, now=WEDNESDAY)
        self.assertFalse(report["promote"])
        self.assertFalse(report["forget"])

    def test_yesterdays_promote_stamp_is_due_again(self):
        catchup.run(self.vault, now=WEDNESDAY)
        report = catchup.due(self.vault, now=WEDNESDAY + dt.timedelta(days=1))
        self.assertTrue(report["promote"])
        self.assertFalse(report["forget"], "same week: forgetting must stay satisfied")

    def test_forget_stamp_before_anchor_is_due(self):
        catchup.run(self.vault, now=WEDNESDAY)
        next_monday = dt.datetime(2026, 11, 2, 5, 0)
        report = catchup.due(self.vault, now=next_monday)
        self.assertTrue(report["forget"])

    def test_monday_before_04_owes_last_weeks_run_only(self):
        # Satisfied last Friday, checked Monday 02:00: this week's run is not
        # scheduled yet, so nothing is owed.
        catchup.run(self.vault, now=dt.datetime(2026, 10, 23, 12, 0))
        report = catchup.due(self.vault, now=MONDAY_EARLY)
        self.assertFalse(report["forget"])


class RunTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_run_fires_exactly_the_overdue_jobs(self):
        called = []
        with patch.object(promoter, "auto_promote", side_effect=lambda v: called.append("promote")), \
                patch.object(forgetter, "demote", side_effect=lambda v, dry_run: called.append(("forget", dry_run))):
            report = catchup.run(self.vault, now=WEDNESDAY)
        self.assertEqual(called, ["promote", ("forget", False)])
        self.assertEqual(report["jobs"]["promote"]["status"], "ran")
        self.assertEqual(report["jobs"]["forget"]["status"], "ran")
        state = read_schedule_state(self.vault)
        self.assertEqual(state["last_promote"], "2026-10-28")
        self.assertEqual(state["last_forget"], "2026-10-28")

    def test_run_skips_satisfied_jobs(self):
        catchup.run(self.vault, now=WEDNESDAY)
        with patch.object(promoter, "auto_promote", side_effect=AssertionError("must not fire")):
            report = catchup.run(self.vault, now=WEDNESDAY)
        self.assertEqual(report["jobs"]["promote"]["status"], "skipped")
        self.assertEqual(report["jobs"]["forget"]["status"], "skipped")

    def test_a_failing_job_does_not_cost_the_other(self):
        with patch.object(promoter, "auto_promote", side_effect=RuntimeError("boom")), \
                patch.object(forgetter, "demote", side_effect=lambda v, dry_run: "ok"):
            report = catchup.run(self.vault, now=WEDNESDAY)
        self.assertEqual(report["jobs"]["promote"]["status"], "failed")
        self.assertIn("boom", report["jobs"]["promote"]["detail"])
        self.assertEqual(report["jobs"]["forget"]["status"], "ran")

    def test_end_to_end_promotion_stamps_the_state(self):
        inbox = canonical_dir(self.vault) / "Agent提交区" / "dsh-20261028-120000-01.md"
        inbox.write_text("- the staging server runs on 127.0.0.1:8080\n", encoding="utf-8")
        report = catchup.run(self.vault, now=WEDNESDAY)
        self.assertEqual(report["jobs"]["promote"]["status"], "ran")
        self.assertIn("staging server runs on 127.0.0.1:8080", read_maybe(canonical_path(self.vault, "env")))
        self.assertEqual(read_schedule_state(self.vault)["last_promote"], "2026-10-28")


class ForgetterStampTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_demote_apply_stamps_forget(self):
        ui = canonical_path(self.vault, "ui")
        ui.write_text(
            read_maybe(ui) + "- 临时会议纪要备忘（写入 2020-01-01｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )
        from unified_memory import index

        index.update_index(self.vault)
        forgetter.demote(self.vault, dry_run=False)
        self.assertEqual(read_schedule_state(self.vault).get("last_forget"), dt.date.today().isoformat())

    def test_demote_dry_run_does_not_stamp(self):
        forgetter.demote(self.vault, dry_run=True)
        self.assertNotIn("last_forget", read_schedule_state(self.vault))


class ForgetterPosixCronTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.tmp = Path(tempfile.mkdtemp(prefix="um-cron-"))

    def tearDown(self):
        destroy_scratch(self.vault)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_posix_register_installs_crontab_line(self):
        calls = []

        def capture(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0)

        with patch("platform.system", return_value="Linux"), \
                patch.object(Path, "home", return_value=self.tmp), \
                patch.object(forgetter.subprocess, "run", side_effect=capture):
            forgetter.register_cron(self.vault)
            forgetter.register_cron(self.vault)  # idempotent

        crontab = (self.tmp / ".crontab").read_text(encoding="utf-8")
        self.assertIn("0 4 * * 1", crontab)
        self.assertIn("unified_memory.forgetter", crontab)
        self.assertIn("--apply", crontab)
        # From a source checkout the entry must be self-sufficient: the
        # scheduled interpreter does not need a prior pip install of the core.
        self.assertIn("PYTHONPATH=", crontab)
        self.assertEqual(crontab.count("unified_memory.forgetter"), 1, "second register must not duplicate")
        self.assertEqual(calls[-1][0], "crontab")


if __name__ == "__main__":
    unittest.main()
