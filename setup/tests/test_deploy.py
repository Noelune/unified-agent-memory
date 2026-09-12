import tempfile
import unittest
from pathlib import Path

from setup.deploy import (
    END_MARKER,
    START_MARKER,
    apply_file,
    build_section,
    detect_targets,
    replace_section,
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

    def test_rejects_relative_target_that_is_not_a_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing" / "AGENTS.md"
            section = build_section("dsh", "<vault>", "dsh")
            with self.assertRaises(FileNotFoundError):
                apply_file(path, section, dry_run=False)


if __name__ == "__main__":
    unittest.main()
