# -*- coding: utf-8 -*-
"""Tests for the platform-independent hook runtime (integrations/hooks/memory_hook.py).

The Claude Code stdin shapes come from the official hooks documentation; every
test runs against a scratch vault and a temporary hook-state directory — the
real ~/.unified-memory.yaml and the real Obsidian vault are never touched.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.common import canonical_dir

HOOK_PATH = Path(__file__).resolve().parents[2] / "integrations" / "hooks" / "memory_hook.py"

spec = importlib.util.spec_from_file_location("memory_hook_under_test", HOOK_PATH)
mh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mh)

REPO = HOOK_PATH.parents[2]


class HookEnv(unittest.TestCase):
    """Scratch vault + scratch hook-state dir; the real home is never touched."""

    def setUp(self):
        self.vault = make_scratch_vault()
        self.state = Path(tempfile.mkdtemp(prefix="um-hook-state-"))
        self._env = patch.dict(
            os.environ,
            {
                "UNIFIED_MEMORY_VAULT": str(self.vault),
                "UNIFIED_MEMORY_HOOK_STATE": str(self.state),
            },
        )
        self._env.start()
        os.environ.pop("UNIFIED_MEMORY_HOOK_RECALL_MODE", None)
        os.environ.pop("UNIFIED_MEMORY_HOOK_MAX_CHARS", None)
        os.environ.pop("UNIFIED_MEMORY_HOOK_TIMEOUT_MS", None)

    def tearDown(self):
        self._env.stop()
        destroy_scratch(self.vault)

    def _seed(self, doc_id: str, facts: list[str]) -> None:
        name = {
            "env": "常用路径与环境.md",
            "prefs": "我的偏好摘要.md",
            "rules": "工程执行规则.md",
            "ui": "界面与外观.md",
            "tools": "常用工具与状态.md",
            "coord": "协作与边界.md",
            "index": "统一记忆索引.md",
        }[doc_id]
        path = canonical_dir(self.vault) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        body = path.read_text(encoding="utf-8") if path.exists() else f"# {path.stem}\n"
        path.write_text(body + "".join(f"- {f}\n" for f in facts), encoding="utf-8")


class SessionStartTest(HookEnv):
    def test_claude_code_shape_prints_the_resident_pack(self):
        # Official SessionStart payload keys (session_id/source are the ones we
        # read; everything else is tolerated and ignored).
        payload = {
            "session_id": "abc123",
            "transcript_path": "/tmp/t.jsonl",
            "cwd": "/tmp",
            "hook_event_name": "SessionStart",
            "source": "startup",
        }
        self._seed("env", ["同步端口为 9443"])
        text = mh.handle("session-start", payload, json.dumps(payload))
        self.assertIn("<memory-context>", text)
        self.assertIn("同步端口为 9443", text)
        self.assertIn("</memory-context>", text)

    def test_pack_honours_the_max_chars_budget(self):
        self._seed("env", ["同步端口为 9443"])
        self._seed("prefs", ["- 用户偏好简洁的结论先行回答。" + "很长的句子" * 80])
        os.environ["UNIFIED_MEMORY_HOOK_MAX_CHARS"] = "300"
        text = mh.handle("session-start", {}, "")
        self.assertLessEqual(len(text), 300 + len("\n</memory-context>") + 40)
        self.assertIn("<memory-context>", text)

    def test_vault_unconfigured_is_silent(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_VAULT": str(Path(self.state) / "no-such-vault")}):
            text = mh.handle("session-start", {}, "")
        self.assertEqual(text, "")


class PromptSubmitTest(HookEnv):
    def test_claude_code_shape_recalls_and_attaches_discipline_once(self):
        self._seed("env", ["同步端口为 9443"])
        payload = {
            "session_id": "sess-1",
            "transcript_path": "/tmp/t.jsonl",
            "prompt": "上次配置的同步端口是多少",
            "hook_event_name": "UserPromptSubmit",
        }
        first = mh.handle("prompt-submit", payload, json.dumps(payload))
        self.assertIn("<memory-data>", first)
        self.assertIn("同步端口为 9443", first)
        self.assertIn("[memory discipline", first)
        second = mh.handle("prompt-submit", payload, json.dumps(payload))
        self.assertIn("<memory-data>", second)
        self.assertNotIn("[memory discipline", second)
        self.assertTrue(mh._marker_path("sess-1").exists())

    def test_query_priority_prompt_beats_text_beats_latestUserText(self):
        self._seed("env", ["同步端口为 9443"])
        row = mh.extract_query(
            {"prompt": "甲", "text": "乙", "latestUserText": "丙"}, ""
        )
        self.assertEqual(row, "甲")
        self.assertEqual(mh.extract_query({"text": "乙", "latestUserText": "丙"}, ""), "乙")
        self.assertEqual(mh.extract_query({"latestUserText": "丙"}, ""), "丙")

    def test_full_text_fallback_when_no_known_key(self):
        raw = '{"cwd": "/tmp"} 的裸文本兜底'
        self.assertEqual(mh.extract_query({"cwd": "/tmp"}, raw), raw[: mh.QUERY_CAP].strip())

    def test_redact_applies_to_recalled_lines(self):
        self._seed("env", ["数据库 password=hunter2secret 存在保险柜"])
        payload = {"session_id": "s", "prompt": "数据库的密码配置在哪"}
        text = mh.handle("prompt-submit", payload, json.dumps(payload))
        self.assertNotIn("hunter2secret", text)
        # encode_untrusted escapes < > inside the envelope, so the redaction
        # marker reaches the model in its escaped form.
        self.assertIn("REDACTED", text)
        self.assertIn("<memory-data>", text)

    def test_budget_truncates_long_recall(self):
        long_fact = "同步端口为 9443，" + "补充说明" * 400
        self._seed("env", [long_fact])
        os.environ["UNIFIED_MEMORY_HOOK_MAX_CHARS"] = "200"
        payload = {"session_id": "s", "prompt": "同步端口是多少"}
        text = mh.handle("prompt-submit", payload, json.dumps(payload))
        # The budget caps the DATA block itself (recallMaxChars semantics);
        # the recall header and the once-per-session discipline text sit
        # outside it.
        start = text.index("<memory-data>")
        end = text.index("</memory-data>") + len("</memory-data>")
        block = text[start:end]
        self.assertLessEqual(len(block), 200)
        self.assertTrue(block.rstrip().endswith("</memory-data>"), block[-60:])
        self.assertIn("truncated", text)

    def test_empty_vault_and_broken_stdin_stay_silent(self):
        self.assertEqual(mh.handle("prompt-submit", {}, ""), "")
        self.assertEqual(mh.handle("prompt-submit", {}, "{not json"), "")
        self.assertEqual(mh.handle("prompt-submit", {"prompt": "   "}, '{"prompt": "   "}'), "")

    def test_mode_off_disables_and_always_skips_the_gate(self):
        self._seed("env", ["同步端口为 9443"])
        # A query that MATCHES the seeded fact but is not memory-sensitive:
        # auto would skip it, always must not.
        payload = {"session_id": "s", "prompt": "同步完成后再运行测试"}
        os.environ["UNIFIED_MEMORY_HOOK_RECALL_MODE"] = "off"
        self.assertEqual(mh.handle("prompt-submit", payload, json.dumps(payload)), "")
        os.environ["UNIFIED_MEMORY_HOOK_RECALL_MODE"] = "always"
        text = mh.handle("prompt-submit", payload, json.dumps(payload))
        self.assertIn("<memory-data>", text)

    def test_auto_mode_gate_positive_and_negative(self):
        self._seed("env", ["部署流程是先跑回归再上线"])
        positive = {"session_id": "s1", "prompt": "记得我们项目的部署流程吗"}
        text = mh.handle("prompt-submit", positive, json.dumps(positive))
        self.assertIn("<memory-data>", text)
        negative = {"session_id": "s2", "prompt": "运行 npm test 并修复失败的用例"}
        self.assertEqual(mh.handle("prompt-submit", negative, json.dumps(negative)), "")

    def test_sensitivity_gate_pins_the_ported_classes(self):
        for positive in ("偏好", "路径", "服务器", "配置", "上次", "记得", "红线", "password"):
            self.assertTrue(mh.looks_memory_sensitive(f"这是关于{positive}的问题"), positive)
        for negative in ("写一个快速排序函数", "运行 npm test 并修复用例", "把这段代码重构一下"):
            self.assertFalse(mh.looks_memory_sensitive(negative), negative)

    def test_search_timeout_returns_empty(self):
        self._seed("env", ["同步端口为 9443"])
        os.environ["UNIFIED_MEMORY_HOOK_TIMEOUT_MS"] = "1"
        payload = {"session_id": "s", "prompt": "同步端口是多少"}

        def slow(*args, **kwargs):
            time.sleep(0.5)
            return []

        # The timeout guard lives inside _lexical_rows, so the patch must hit
        # the real search function it imports, not the wrapper.
        with patch("unified_memory.infra.store.lexical_search", side_effect=slow):
            text = mh.handle("prompt-submit", payload, json.dumps(payload))
        self.assertEqual(text, "")


class SessionEndTest(HookEnv):
    def test_queue_append_with_existing_transcript(self):
        transcript = self.state / "t.jsonl"
        transcript.write_text('{"type":"user"}\n', encoding="utf-8")
        payload = {
            "session_id": "sess-9",
            "transcript_path": str(transcript),
            "source": "clear",
            "hook_event_name": "SessionEnd",
        }
        text = mh.handle("session-end", payload, json.dumps(payload))
        self.assertEqual(text, "")
        lines = (self.state / "queue.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        entry = json.loads(lines[0])
        self.assertEqual(entry["source"], "clear")
        self.assertEqual(entry["session_id"], "sess-9")
        self.assertEqual(entry["path"], str(transcript))
        self.assertIn("ts", entry)

    def test_missing_transcript_is_silent(self):
        text = mh.handle("session-end", {"session_id": "x", "transcript_path": ""}, "")
        self.assertEqual(text, "")
        text = mh.handle("session-end", {"session_id": "x", "transcript_path": "/no/such/file.jsonl"}, "")
        self.assertEqual(text, "")
        self.assertFalse((self.state / "queue.jsonl").exists())


class HookMainTest(HookEnv):
    def test_main_reads_stdin_and_prints(self):
        self._seed("env", ["同步端口为 9443"])
        payload = {"session_id": "m", "prompt": "同步端口是多少"}
        stdout = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(sys, "stdout", stdout):
            code = mh.main(["prompt-submit"])
        self.assertEqual(code, 0)
        self.assertIn("<memory-data>", stdout.getvalue())

    def test_main_unknown_event_is_silent_success(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO("")), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
            code = mh.main(["no-such-event"])
        self.assertEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")

    def test_subprocess_entry_session_start(self):
        """The real entry point: same command line the E2 docs will ship."""
        self._seed("env", ["同步端口为 9443"])
        env = os.environ.copy()
        completed = subprocess.run(
            [sys.executable, str(HOOK_PATH), "session-start"],
            input=json.dumps({"session_id": "sub", "source": "startup"}),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("<memory-context>", completed.stdout)
        self.assertIn("同步端口为 9443", completed.stdout)


if __name__ == "__main__":
    unittest.main()
