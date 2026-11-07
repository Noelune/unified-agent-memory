# -*- coding: utf-8 -*-
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from unified_memory import forgetter
from unified_memory.infra.store import active_memories, record_access, update_index
from unified_memory.common import canonical_path, forget_dir, read_maybe

from test_common import destroy_scratch, index_db_name_for, make_scratch_vault


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
                + "- 临时会议纪要备忘（写入 2020-01-01｜来源：Agent提交区/codex-20200101-002-01.md）\n"
                + "- 服务器地址备忘（写入 2020-01-01｜来源：Agent提交区/codex-20200101-003-01.md）\n",
                encoding="utf-8",
            )
            update_index(vault)
            candidates = forgetter.demote(vault, dry_run=True)
            text = "\n".join(candidates)
            self.assertIn("临时会议纪要备忘", text)
            self.assertNotIn("架构上采用微服务拆分", text)
            # Chinese durable topics must be protected too: the live vault is
            # mostly Chinese, and the old English-only regex forgot them.
            self.assertNotIn("服务器地址备忘", text)
        finally:
            destroy_scratch(vault)


class ForgetterSafetyTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _append(self, fact):
        ui = canonical_path(self.vault, "ui")
        ui.write_text(ui.read_text(encoding="utf-8") + fact, encoding="utf-8")

    def test_versioned_history_is_never_demoted(self):
        self._append(
            "- 旧配色是蓝色（写入 2020-01-01｜来源：[[Agent提交区/x-1.md]]｜有效至 2020-02-01）\n"
        )
        update_index(self.vault)
        self.assertNotIn("旧配色是蓝色", "\n".join(forgetter.demote(self.vault, dry_run=True)))

    def test_recent_access_rescues_an_old_transient_fact(self):
        self._append("- 临时会议纪要备忘（写入 2020-01-01｜来源：Agent提交区/x-1.md）\n")
        update_index(self.vault)
        target = next(m for m in active_memories(self.vault) if m["line"] == "临时会议纪要备忘")
        # Before any read receipt the old transient fact is a candidate…
        self.assertIn("临时会议纪要备忘", "\n".join(forgetter.demote(self.vault, dry_run=True)))
        # …after a read receipt it is not: reinforcement resets the decay clock.
        record_access(self.vault, [target["id"]])
        self.assertNotIn("临时会议纪要备忘", "\n".join(forgetter.demote(self.vault, dry_run=True)))


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

        # B5.4: the schtasks/crontab dialogue moved into infra/schedule.register_job,
        # so subprocess is patched where it is now called.
        with patch("platform.system", return_value="Windows"), patch("unified_memory.infra.schedule.subprocess.run", side_effect=capture_schedule):
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
        # The .bat runs as a child process, so it cannot see the in-process
        # memory.INDEX_DB redirect done by make_scratch_vault(); the factory also
        # exports UNIFIED_MEMORY_INDEX_DB so the child lands in the scratch dir.
        projected = Path(env.get("UNIFIED_MEMORY_INDEX_DB", ""))
        self.assertTrue(projected.name, "make_scratch_vault() must export UNIFIED_MEMORY_INDEX_DB")
        completed = subprocess.run(["cmd.exe", "/c", str(bat)], env=env, capture_output=True, text=False, timeout=30)
        stderr = (completed.stderr or b"").decode(errors="replace")
        self.assertEqual(completed.returncode, 0, stderr)
        # The child must honor the injected redirect. Without it the .bat builds
        # its index under the real ~/.unified-memory/, so the leak comes back
        # silently; asserting on the injected path is what turns that red.
        self.assertTrue(
            (projected.parent / index_db_name_for(self.vault)).is_file(),
            "the .bat child ignored UNIFIED_MEMORY_INDEX_DB and indexed elsewhere",
        )
        self.assertNotIn(stale.rstrip(), read_maybe(ui))
        self.assertIn(stale.rstrip(), read_maybe(forget_dir(self.vault) / ui.name))
        self.assertIn("demoted 1 line(s)", read_maybe(self.vault / "forget_weekly.log"))


class ProtectedTopicsTest(unittest.TestCase):
    """Batch C2: the explicit PROTECTED_TOPICS whitelist, not the old net."""

    def test_credentials_and_red_lines_stay_protected(self):
        for fact in ("生产环境密码在密码管理器", "部署红线：不得直接改主分支", "API 密钥轮换周期是 90 天"):
            self.assertTrue(forgetter.PROTECTED_RE.search(fact), fact)

    def test_endpoint_and_coordination_facts_stay_protected(self):
        for fact in ("生产服务器地址是 203.0.113.10", "同步端口为 9443", "协作边界：各代理只写自己的提交区"):
            self.assertTrue(forgetter.PROTECTED_RE.search(fact), fact)

    def test_ordinary_topics_are_reachable_for_decay(self):
        # These were caught by the old broad regex (model/backup/preference/
        # script/config/path) and made forgetting a no-op; the whitelist keeps
        # them reachable so the score decides, not a keyword.
        for fact in (
            "默认模型是 GLM-5.3",
            "备份目录是 D:/backups/uam",
            "用户偏好简洁的结论先行回答。",
            "部署脚本放在 scripts/deploy-old.sh",
            "构建产物必须经过 typecheck 才能合并。",
        ):
            self.assertFalse(forgetter.PROTECTED_RE.search(fact), fact)

    def test_promotion_stamp_is_not_a_protected_topic(self):
        # The check runs on the bare fact text; the stamp (来源：Agent提交区/…)
        # must never leak into the decision or every promoted fact would match
        # its "agent" token.
        line = "- 临时会议纪要备忘（写入 2020-01-01｜来源：Agent提交区/x-1.md）"
        self.assertFalse(forgetter.PROTECTED_RE.search(forgetter.parse_line(line)["bare"]))

    def test_forget_reachability_on_the_representative_corpus(self):
        # Batch C2 acceptance: >=60% of facts must be reachable (not protected).
        corpus = [
            "构建产物必须经过 typecheck 才能合并。",
            "发布前必须跑完整回归测试。",
            "统一记忆系统的晋升时间是每天 03:00。",
            "部署脚本放在 scripts/deploy-old.sh",
            "生产服务器地址是 203.0.113.10",
            "备份目录是 D:/backups/uam",
            "同步端口为 9443",
            "默认模型是 GLM-5.3",
            "统一记忆系统的索引库在 ~/.unified-memory。",
            "用户偏好简洁的结论先行回答。",
        ]
        protected = [f for f in corpus if forgetter.PROTECTED_RE.search(f)]
        reachable = 1 - len(protected) / len(corpus)
        self.assertEqual(protected, ["生产服务器地址是 203.0.113.10", "同步端口为 9443"])
        self.assertGreaterEqual(reachable, 0.6, f"protected: {protected}")


if __name__ == "__main__":
    unittest.main()
