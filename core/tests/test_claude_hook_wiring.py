# -*- coding: utf-8 -*-
"""Drift guard for the Claude Code hook wiring (batch E2).

Reads integrations/claude/hooks/settings-snippet.json and executes its hook
command lines VERBATIM (after substituting ${CLAUDE_PROJECT_DIR} with the repo
root) for all three events — the commands the documentation ships are exactly
the commands these tests run, so the docs cannot drift from the script.
The interpreter name itself is resolved per OS (python3 on POSIX,
python on Windows) because no single name exists on both: a clean
Debian install has only python3, a Windows install only python/py.
Scratch vault + temporary hook-state dir; the real home is never touched.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.infra.vault import canonical_dir

REPO = Path(__file__).resolve().parents[2]
SNIPPET_PATH = REPO / "integrations" / "claude" / "hooks" / "settings-snippet.json"
HOOK_SCRIPT = REPO / "integrations" / "hooks" / "memory_hook.py"



_HOOK_PYTHON_NAMES = ("python3", "python") if os.name != "nt" else ("python", "python3")


def _resolve_hook_python():
    # Prefer python3 (POSIX), fall back to python (Windows). On Windows the
    # python3 name usually resolves to the Microsoft Store alias — a reparse
    # point that dies with exit 9009 under a non-interactive spawn — so it
    # never leads the order there, and an alias hit is skipped outright.
    for name in _HOOK_PYTHON_NAMES:
        found = shutil.which(name)
        if found and ".windowsapps" not in found.lower():
            return name
    return os.path.basename(sys.executable)


def _snippet_entries() -> dict:
    data = json.loads(SNIPPET_PATH.read_text(encoding="utf-8"))
    hooks = data["hooks"]
    # The shipped shape is {event: [{hooks: [entry]}]}; tests need the entry.
    return {name: entries[0]["hooks"][0] for name, entries in hooks.items()}

class ClaudeHookWiringTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.state = Path(tempfile.mkdtemp(prefix="um-claude-hook-"))
        self._env = patch.dict(
            os.environ,
            {
                "UNIFIED_MEMORY_VAULT": str(self.vault),
                "UNIFIED_MEMORY_HOOK_STATE": str(self.state),
            },
        )
        self._env.start()
        seed = canonical_dir(self.vault) / "常用路径与环境.md"
        seed.parent.mkdir(parents=True, exist_ok=True)
        seed.write_text(
            "# 常用路径与环境\n\n- 同步端口为 9443（写入 2026-10-01｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self._env.stop()
        destroy_scratch(self.vault)

    def _run_event(self, event: str, payload: dict) -> subprocess.CompletedProcess:
        entry = _snippet_entries()[event]
        self.assertEqual(entry.get("type"), "exec", event)
        self.assertIn(entry.get("command"), _HOOK_PYTHON_NAMES, event)
        args = entry["args"]
        self.assertEqual(len(args), 2, event)
        self.assertEqual(args[1], "prompt-submit" if event == "UserPromptSubmit" else
                         "session-end" if event == "SessionEnd" else "session-start", event)
        self.assertIn("${CLAUDE_PROJECT_DIR}", args[0], event)
        cmd = [_resolve_hook_python(), args[0].replace("${CLAUDE_PROJECT_DIR}", str(REPO)), args[1]]
        env = os.environ.copy()
        return subprocess.run(
            cmd,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

    def test_session_start_runs_the_shipped_command(self):
        entries = _snippet_entries()
        self.assertNotIn("matcher", entries["SessionStart"], "startup/resume/clear/compact must all fire")
        payload = {"session_id": "cc-1", "source": "startup", "hook_event_name": "SessionStart"}
        proc = self._run_event("SessionStart", payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("<memory-context>", proc.stdout)
        self.assertIn("同步端口为 9443", proc.stdout)

    def test_user_prompt_submit_runs_the_shipped_command(self):
        entry = _snippet_entries()["UserPromptSubmit"]
        self.assertEqual(entry.get("timeout"), 30)
        payload = {
            "session_id": "cc-1",
            "prompt": "上次配置的同步端口是多少",
            "hook_event_name": "UserPromptSubmit",
        }
        proc = self._run_event("UserPromptSubmit", payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("<memory-data>", proc.stdout)
        self.assertIn("同步端口为 9443", proc.stdout)

    def test_session_end_runs_the_shipped_command(self):
        entry = _snippet_entries()["SessionEnd"]
        self.assertIs(entry.get("async"), True)
        transcript = self.state / "t.jsonl"
        transcript.write_text('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n', encoding="utf-8")
        payload = {
            "session_id": "cc-1",
            "transcript_path": str(transcript),
            "source": "clear",
            "hook_event_name": "SessionEnd",
        }
        proc = self._run_event("SessionEnd", payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")
        queue = self.state / "queue.jsonl"
        self.assertTrue(queue.exists())
        entry_line = json.loads(queue.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(entry_line["path"], str(transcript))

    def test_session_end_missing_transcript_stays_silent(self):
        payload = {"session_id": "cc-1", "transcript_path": "/no/such/file.jsonl", "source": "clear"}
        proc = self._run_event("SessionEnd", payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertFalse((self.state / "queue.jsonl").exists())

if __name__ == "__main__":
    unittest.main()
