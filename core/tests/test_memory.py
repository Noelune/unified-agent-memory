# -*- coding: utf-8 -*-
import os
import io
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from threading import Barrier
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory as mem_mod
from unified_memory import promoter
from unified_memory.common import atomic_create, canonical_dir, canonical_path, resolve_vault


class MemoryCoreTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_init_creates_structure(self):
        ctx = canonical_dir(self.vault)
        for name in mem_mod.CANONICAL_DOCS.values():
            self.assertTrue((ctx / name).is_file(), name)
        self.assertTrue((ctx / "Agent提交区").is_dir())
        self.assertTrue((ctx / "情境信息").is_dir())
        self.assertTrue((ctx / "记忆遗忘区").is_dir())

    def test_resolve_vault_from_env(self):
        self.assertEqual(resolve_vault(), self.vault)

    def test_submit_writes_inbox_file(self):
        result = mem_mod.cmd_submit(type("A", (), {"agent": "dsh", "fact": "- the test server runs on 127.0.0.1:9999"})())
        # cmd_submit prints; verify the file exists
        inbox = canonical_dir(self.vault) / "Agent提交区"
        files = list(inbox.glob("dsh-*.md"))
        self.assertEqual(len(files), 1)
        text = files[0].read_text(encoding="utf-8")
        self.assertIn("test server runs on 127.0.0.1:9999", text)

    def test_submit_rejects_credentials(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_submit(type("A", (), {"agent": "dsh", "fact": "- api_key: replace-with-your-real-key"})())

    def test_submit_rejects_agent_names_that_are_not_file_name_prefixes(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_submit(type("A", (), {"agent": "../outside", "fact": "safe fact"})())
        self.assertFalse((canonical_dir(self.vault) / "outside-20260815-01.md").exists())

    def test_atomic_create_allows_only_one_concurrent_writer(self):
        inbox = canonical_dir(self.vault) / "Agent提交区"
        target = inbox / "race-20260815-000000-01.md"
        barrier = Barrier(2)

        def create(body):
            barrier.wait()
            return atomic_create(target, body)

        with ThreadPoolExecutor(max_workers=2) as pool:
            created = list(pool.map(create, ("first concurrent fact\n", "second concurrent fact\n")))

        self.assertEqual(sum(created), 1)
        self.assertIn(target.read_text(encoding="utf-8"), {"first concurrent fact\n", "second concurrent fact\n"})
        self.assertFalse(list(inbox.glob(".race-20260815-000000-01.md.*.tmp")))

    def test_submit_retries_the_next_sequence_when_name_is_taken(self):
        inbox = canonical_dir(self.vault) / "Agent提交区"
        existing = inbox / "race-20260815-000000-01.md"
        self.assertTrue(atomic_create(existing, "first concurrent fact\n"))
        with patch("unified_memory.memory.time.strftime", return_value="20260815-000000"):
            mem_mod.cmd_submit(type("A", (), {"agent": "race", "fact": "second concurrent fact"})())

        files = sorted(inbox.glob("race-20260815-000000-*.md"))
        self.assertEqual(len(files), 2)
        contents = "\n".join(path.read_text(encoding="utf-8") for path in files)
        self.assertIn("first concurrent fact", contents)
        self.assertIn("second concurrent fact", contents)

    def test_archive_sources_ignores_paths_outside_the_inbox(self):
        outside = canonical_dir(self.vault) / "outside.md"
        outside.write_text("do not move\n", encoding="utf-8")
        promoter.archive_sources(self.vault, {"../outside.md"})
        self.assertTrue(outside.is_file())
        self.assertEqual(outside.read_text(encoding="utf-8"), "do not move\n")

    def test_show_prints_document(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_show(type("A", (), {"doc": "index"}))
        self.assertIn("上下文索引", buf.getvalue())

    def test_search_wraps_in_memory_data(self):
        # seed a fact
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(prefs.read_text(encoding="utf-8") + "\n- prefers indigo-colored terminal prompts\n", encoding="utf-8")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_search(type("A", (), {"query": "indigo", "limit": 8, "remote": False})())
        out = buf.getvalue()
        self.assertTrue(out.startswith("<memory-data>"))
        self.assertIn("indigo", out)
        self.assertTrue(out.rstrip().endswith("</memory-data>"))

    def test_search_output_redacts_snippets(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.print_memory_data("test", [{"doc": "note.md", "snippet": "api_key: local-test-secret"}])
        self.assertIn("<REDACTED>", buf.getvalue())
        self.assertNotIn("local-test-secret", buf.getvalue())

    def test_index_does_not_persist_or_return_canonical_credentials(self):
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text("# Preferences\n\n- api_key: local-index-secret\n", encoding="utf-8")
        result = mem_mod.search_index("api_key", 8, self.vault)
        self.assertNotIn("local-index-secret", str(result))
        import sqlite3
        with sqlite3.connect(mem_mod.index_db_for(self.vault)) as conn:
            content = "\n".join(row[0] for row in conn.execute("SELECT content FROM fts"))
        self.assertNotIn("local-index-secret", content)

    def test_index_is_isolated_per_vault_and_removes_deleted_files(self):
        second = self.vault.parent / "second-vault"
        mem_mod.init_vault(second)
        first_doc = canonical_path(self.vault, "prefs")
        first_doc.write_text("# First\n\n- first-vault-only-token\n", encoding="utf-8")
        second_doc = canonical_path(second, "prefs")
        second_doc.write_text("# Second\n\n- second-vault-only-token\n", encoding="utf-8")
        first = mem_mod.search_index("first-vault-only-token", 8, self.vault)
        second_result = mem_mod.search_index("first-vault-only-token", 8, second)
        self.assertNotEqual(mem_mod.index_db_for(self.vault), mem_mod.index_db_for(second))
        self.assertEqual(first["count"], 1)
        self.assertEqual(second_result["count"], 0)
        first_doc.unlink()
        after_delete = mem_mod.search_index("first-vault-only-token", 8, self.vault)
        self.assertEqual(after_delete["count"], 0)

    def test_index_refreshes_when_content_changes_without_mtime_or_size_change(self):
        prefs = canonical_path(self.vault, "prefs")
        old_fact = "stableindexold001"
        new_fact = "stableindexnew001"
        original = f"# Preferences\n\n- {old_fact}\n".encode("utf-8")
        updated = original.replace(old_fact.encode("utf-8"), new_fact.encode("utf-8"))
        self.assertEqual(len(updated), len(original))
        prefs.write_bytes(original)
        self.assertEqual(mem_mod.search_index(old_fact, 8, self.vault)["count"], 1)
        stat = prefs.stat()
        self.assertEqual(len(updated), stat.st_size)
        prefs.write_bytes(updated)
        os.utime(prefs, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(mem_mod.search_index(old_fact, 8, self.vault)["count"], 0)
        self.assertEqual(mem_mod.search_index(new_fact, 8, self.vault)["count"], 1)

    def test_concurrent_local_searches_finish_without_sqlite_lock_errors(self):
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text("# Preferences\n\n- concurrent-local-search-token\n", encoding="utf-8")
        barrier = Barrier(8)

        def search(_):
            barrier.wait()
            return mem_mod.search_index("concurrent-local-search-token", 8, self.vault)

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(search, range(8)))

        self.assertTrue(all(result["count"] == 1 for result in results))

    def test_force_init_creates_distinct_backups_when_repeated_in_one_second(self):
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text("# My preference\n\n- customized fact\n", encoding="utf-8")
        with patch("unified_memory.memory.time.strftime", return_value="20260815-120000"):
            mem_mod.init_vault(self.vault, force=True)
            mem_mod.init_vault(self.vault, force=True)
        backups = sorted(self.vault.parent.glob("vault-backup-20260815-120000*"))
        self.assertEqual(len(backups), 2)
        self.assertIn("customized fact", (backups[0] / "50-Agent-Context" / "我的偏好摘要.md").read_text(encoding="utf-8"))

    def test_remote_reports_not_configured(self):
        with self.assertRaises(SystemExit) as cm:
            mem_mod.cmd_search(type("A", (), {"query": "x", "limit": 8, "remote": True})())
        self.assertIn("remote index is not configured", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
