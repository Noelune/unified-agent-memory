import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from setup.deploy import (
    END_MARKER,
    START_MARKER,
    apply_file,
    build_section,
    detect_targets,
    replace_section,
    resolved_prefix,
)


class DeployTests(unittest.TestCase):
    def test_marker_replacement_is_idempotent_and_preserves_unrelated_text(self):
        original = "before\n" + START_MARKER + "\nold\n" + END_MARKER + "\nafter\n"
        section = build_section("codex", "<vault>", "codex")
        once = replace_section(original, section)
        twice = replace_section(once, section)
        self.assertEqual(once, twice)
        self.assertEqual(once.count(START_MARKER), 1)
        self.assertTrue(once.startswith("before\n"))
        self.assertTrue(once.endswith("after\n"))

    def test_legacy_section_replacement_keeps_neighbouring_headings(self):
        original = "## 0. 全局\n\n保留我\n\n## 1. 统一记忆\n\n旧内容\n\n## 2. 其他\n\n也保留\n"
        section = build_section("dsh", "<vault>", "dsh")
        once = replace_section(original, section)
        self.assertIn("## 0. 全局", once)
        self.assertIn("保留我", once)
        self.assertIn("## 2. 其他", once)
        self.assertIn("也保留", once)
        self.assertNotIn("旧内容", once)
        self.assertEqual(once.count(START_MARKER), 1)
        self.assertEqual(once.count(END_MARKER), 1)

    def test_legacy_migration_is_idempotent(self):
        # The first deploy migrates a pre-marker section, the second one finds
        # markers. Both must produce the same bytes, or every run rewrites the
        # file and takes another backup.
        original = "## 0. 全局\n\n保留我\n\n## 1. 统一记忆\n\n旧内容\n\n## 2. 其他\n\n也保留\n"
        section = build_section("dsh", "<vault>", "dsh")
        once = replace_section(original, section)
        twice = replace_section(once, section)
        self.assertEqual(once, twice)
        self.assertTrue(once.startswith("## 0. 全局\n\n保留我\n"))

    def test_legacy_match_ignores_a_heading_that_only_mentions_the_token(self):
        # "## 关于 50-Agent-Context 的结构" is the user's own heading. Matching
        # the token anywhere inside a heading deletes a section the plugin never
        # owned.
        original = "## 关于 50-Agent-Context 的结构\n\n用户自己的说明\n\n## 2. 其他\n\n保留\n"
        section = build_section("dsh", "<vault>", "dsh")
        once = replace_section(original, section)
        self.assertIn("用户自己的说明", once)
        self.assertIn("## 关于 50-Agent-Context 的结构", once)
        self.assertEqual(once.count(START_MARKER), 1)

    def test_legacy_match_skips_a_heading_inside_a_code_fence(self):
        # AGENTS.md files legitimately show example headings inside fences. A
        # scan that ignores fences starts deleting at the quoted line and stops
        # at the next real heading, which eats the closing fence and the user's
        # text after it — the same deletion C1 was about.
        original = (
            "## 0. 全局\n\n示例：\n\n```md\n## 统一记忆库\n\n示例文本\n```\n\n"
            "## 1. 用户正文\n\n必须保留\n"
        )
        section = build_section("dsh", "<vault>", "dsh")
        once = replace_section(original, section)
        self.assertIn("示例文本", once)
        self.assertIn("## 1. 用户正文", once)
        self.assertIn("必须保留", once)
        self.assertEqual(once.count("```"), 2)
        self.assertEqual(once.count(START_MARKER), 1)

    def test_fence_mask_ignores_a_quoted_backtick_fence_inside_a_tilde_block(self):
        # Quoting Markdown by nesting ``` inside ~~~ is a normal habit. A
        # character-blind toggle treats the inner ``` as the closer, unmasks the
        # quoted heading that follows, and deletes everything after it.
        original = (
            "## 0. 全局\n\n示例：\n\n~~~md\n```js\n## 统一记忆库\n```\n示例文本\n~~~\n\n"
            "## 1. 用户正文\n\n必须保留\n"
        )
        section = build_section("dsh", "<vault>", "dsh")
        once = replace_section(original, section)
        self.assertIn("示例文本", once)
        self.assertIn("## 1. 用户正文", once)
        self.assertIn("必须保留", once)
        self.assertEqual(once.count("~~~"), 2)
        self.assertEqual(once.count(START_MARKER), 1)

    def test_legacy_numbering_accepts_arabic_digits(self):
        # "## 第3节 统一记忆库" and "## (1) 统一记忆库" are the same legacy heading
        # written by hand; leaving them unmigrated puts two sections in the file.
        for heading in ("## 第3节 统一记忆库", "## (1) 统一记忆库"):
            with self.subTest(heading=heading):
                original = f"## 0. 全局\n\n保留\n\n{heading}\n\n旧内容\n\n## 9. 其他\n\n也保留\n"
                section = build_section("dsh", "<vault>", "dsh")
                once = replace_section(original, section)
                self.assertNotIn("旧内容", once)
                self.assertIn("## 9. 其他", once)
                self.assertEqual(once.count(START_MARKER), 1)

    def test_apply_file_preserves_crlf_line_endings(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "AGENTS.md"
            path.write_bytes("## 自用\r\n\r\n内容\r\n".encode("utf-8"))
            section = build_section("dsh", "<vault>", "dsh")
            apply_file(path, section)
            data = path.read_bytes().decode("utf-8")
            self.assertNotIn("\n", data.replace("\r\n", ""))
            self.assertIn("内容", data)

    def test_mixed_line_endings_survive_a_managed_write(self):
        # Files edited on two machines are often mixed. Normalizing the whole
        # file to one style rewrites every line, so a one-section deploy shows
        # up as a total diff in the user's repo.
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "AGENTS.md"
            original = "## 自用\r\n\r\nA\n## 2. 其他\r\n\r\nB\n"
            path.write_bytes(original.encode("utf-8"))
            apply_file(path, build_section("dsh", "<vault>", "dsh"))
            data = path.read_bytes().decode("utf-8")
            self.assertTrue(data.startswith(original), "the user's lines are byte-identical")
            self.assertEqual(data.count("\n") - data.count("\r\n"), 2, "no bare LF line was converted")
            self.assertIn(START_MARKER, data)

    def test_apply_file_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "AGENTS.md"
            path.write_text("existing\n", encoding="utf-8")
            section = build_section("dsh", "<vault>", "dsh")
            result = apply_file(path, section, dry_run=True)
            self.assertTrue(result["changed"])
            self.assertFalse(result["written"])
            self.assertEqual(path.read_text(encoding="utf-8"), "existing\n")

    def test_apply_file_creates_backup_and_second_apply_is_noop(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "CLAUDE.md"
            path.write_text("用户内容\n", encoding="utf-8")
            section = build_section("claude", "<vault>", "claude")
            first = apply_file(path, section)
            self.assertTrue(first["written"])
            self.assertTrue(first["backup"])
            content = path.read_text(encoding="utf-8")
            second = apply_file(path, section)
            self.assertFalse(second["changed"])
            self.assertEqual(path.read_text(encoding="utf-8"), content)
            self.assertEqual(content.count(START_MARKER), 1)

    def test_detect_targets_only_returns_existing_known_files(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home / ".codex").mkdir()
            (home / ".codex" / "AGENTS.md").write_text("", encoding="utf-8")
            targets = detect_targets(home)
            self.assertEqual([item["agent"] for item in targets], ["codex"])
            self.assertEqual(targets[0]["path"], home / ".codex" / "AGENTS.md")

    def test_resolved_prefix_uses_runtime_declaration_for_dsh(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-desktop"}):
            self.assertEqual(resolved_prefix("dsh"), "dsh-desktop")

    def test_resolved_prefix_falls_back_to_agent_name_without_declaration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolved_prefix("dsh"), "dsh")
            self.assertEqual(resolved_prefix("codex"), "codex")

    def test_resolved_prefix_explicit_override_wins(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-web"}):
            self.assertEqual(resolved_prefix("dsh", "dsh-desktop"), "dsh-desktop")

    def test_dsh_section_carries_the_derived_prefix(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-web"}):
            section = build_section("dsh", "<vault>", resolved_prefix("dsh"))
        self.assertIn("`dsh-web-`", section)
        self.assertIn("--agent dsh-web", section)

    def test_rejects_relative_target_that_is_not_a_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing" / "AGENTS.md"
            section = build_section("dsh", "<vault>", "dsh")
            with self.assertRaises(FileNotFoundError):
                apply_file(path, section, dry_run=False)


if __name__ == "__main__":
    unittest.main()
