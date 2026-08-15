# -*- coding: utf-8 -*-
import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "integrations" / "hermes"))

import archive_session  # noqa: E402
import inject_context  # noqa: E402

from test_common import destroy_scratch, make_scratch_vault  # noqa: E402


class ArchiveSessionTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_append_is_under_file_lock(self):
        # Concurrent post-turn hooks must not race on the daily file: the
        # read-append-write sequence has to run under the vault file lock.
        entered = []

        class _Lock:
            def __init__(self, _vault, *a, **k):
                entered.append(True)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with patch.object(archive_session, "file_lock", _Lock):
            with patch("sys.stdin", io.StringIO("some session line\n")):
                with redirect_stdout(io.StringIO()):
                    archive_session.main(["--vault", str(self.vault)])
        self.assertEqual(entered, [True], "archive append must run under the vault file lock")

    def test_archives_redacted_block(self):
        with patch("sys.stdin", io.StringIO("line one\napi_key: secret123\n")):
            with redirect_stdout(io.StringIO()):
                archive_session.main(["--vault", str(self.vault)])
        target = next((self.vault / "50-Agent-Context" / "会话归档").glob("*.md"))
        text = target.read_text(encoding="utf-8")
        self.assertIn("line one", text)
        self.assertIn("<REDACTED>", text)
        self.assertNotIn("secret123", text)

    def test_redacts_and_normalizes_header_metadata(self):
        with patch("sys.stdin", io.StringIO("safe line\n")):
            with redirect_stdout(io.StringIO()):
                archive_session.main([
                    "--vault", str(self.vault),
                    "--agent", "api_key: header-secret\n# injected",
                    "--title", "token: title-secret\n## injected",
                ])
        target = next((self.vault / "50-Agent-Context" / "会话归档").glob("*.md"))
        text = target.read_text(encoding="utf-8")
        self.assertNotIn("header-secret", text)
        self.assertNotIn("title-secret", text)
        self.assertNotIn("## injected", text)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("## ")), 1)


class InjectContextTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_outputs_memory_context_markers(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            inject_context.main(["--vault", str(self.vault)])
        out = buf.getvalue()
        self.assertTrue(out.startswith("<memory-context>"))
        self.assertTrue(out.rstrip().endswith("</memory-context>"))
        self.assertIn("content below comes from vault files", out)


if __name__ == "__main__":
    unittest.main()
