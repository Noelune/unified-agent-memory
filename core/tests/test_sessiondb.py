# -*- coding: utf-8 -*-
"""sessiondb — reading Hermes's state.db without becoming its second writer.

The gap this closes: digest only ever read archive Markdown, so a session that
was never archived could never become a fact. On the measured machine that was
191 of 369 sessions, all between 2026-05-30 and 2026-08-28.

The properties pinned here are the ones that make a cross-product reader safe:

  * the database is opened read-only, so a bug cannot corrupt an 841 MB file;
  * a schema that moved raises a message naming the columns, instead of a
    KeyError halfway through a digest run (Hermes owns this schema and bumps
    ``schema_version`` across releases);
  * tool output and session_meta are not sent to the LLM;
  * everything is redacted before it leaves the module, because an LLM is the
    next hop;
  * a busy day is chunked on session boundaries instead of being cut down to
    its final 6000 characters.
"""
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import sessiondb


def _ts(date: str, hour: int = 12) -> float:
    """Local epoch for ``YYYY-MM-DD HH:00`` (matches _iso's localtime)."""
    y, m, d = (int(x) for x in date.split("-"))
    return time.mktime((y, m, d, hour, 0, 0, 0, 0, -1))


def build_db(
    path: Path,
    sessions: list[tuple[str, str, float, list[tuple[str, str]]]],
    *,
    drop_columns: tuple[str, ...] = (),
) -> Path:
    """Create a fixture state.db shaped like Hermes's (only the columns we use)."""
    session_cols = ["id", "started_at", "title"]
    message_cols = ["session_id", "role", "content", "timestamp", "id"]
    for col in drop_columns:
        session_cols = [c for c in session_cols if c != col]
        message_cols = [c for c in message_cols if c != col]

    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "CREATE TABLE sessions ("
            + ", ".join(_session_ddl(c) for c in session_cols)
            + ")"
        )
        conn.execute(
            "CREATE TABLE messages ("
            + ", ".join(_message_ddl(c) for c in message_cols)
            + ")"
        )
        conn.execute("CREATE TABLE schema_version (version INTEGER)")
        conn.execute("INSERT INTO schema_version (version) VALUES (32)")
        for sid, title, started, messages in sessions:
            conn.execute(
                "INSERT INTO sessions (id, started_at, title) VALUES (?, ?, ?)",
                (sid, started, title),
            )
            for role, content in messages:
                conn.execute(
                    "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                    (sid, role, content, started),
                )
        conn.commit()
    finally:
        conn.close()
    return path


_SESSION_DDL = {"id": "TEXT PRIMARY KEY", "started_at": "REAL", "title": "TEXT"}
_MESSAGE_DDL = {
    "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "session_id": "TEXT",
    "role": "TEXT",
    "content": "TEXT",
    "timestamp": "REAL",
}


def _session_ddl(col: str) -> str:
    return f"{col} {_SESSION_DDL.get(col, 'TEXT')}"


def _message_ddl(col: str) -> str:
    return f"{col} {_MESSAGE_DDL.get(col, 'TEXT')}"


class SessionDbTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="um-sessiondb-"))
        self.db = self.dir / "state.db"

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def test_probe_reports_the_schema(self):
        build_db(self.db, [("s1", "第一天", _ts("2026-06-01"), [("user", "你好")])])
        info = sessiondb.probe(self.db)
        self.assertEqual(info["schema_version"], 32)
        self.assertEqual(info["sessions"], 1)
        self.assertEqual(info["messages"], 1)
        self.assertEqual(info["first_session"], "2026-06-01")

    def test_a_moved_schema_names_the_missing_columns(self):
        """Hermes owns this table; an upgrade must produce a diagnosis, not a KeyError."""
        build_db(self.db, [], drop_columns=("role",))
        with self.assertRaises(sessiondb.SessionDbUnavailable) as ctx:
            sessiondb.probe(self.db)
        self.assertIn("role", str(ctx.exception))
        self.assertIn("schema", str(ctx.exception).lower())
        self.assertFalse(sessiondb.available(self.db))

    def test_a_missing_database_is_unavailable_not_an_exception(self):
        self.assertFalse(sessiondb.available(self.dir / "nope.db"))
        with self.assertRaises(sessiondb.SessionDbUnavailable):
            sessiondb.probe(self.dir / "nope.db")

    def test_the_database_is_opened_read_only(self):
        """A read-only connection is the whole reason this is safe to run."""
        build_db(self.db, [("s1", "", _ts("2026-06-01"), [("user", "hi")])])
        before = self.db.stat().st_mtime_ns
        size_before = self.db.stat().st_size
        sessiondb.dated_transcripts(self.db)
        self.assertEqual(before, self.db.stat().st_mtime_ns, "reading must not write")
        self.assertEqual(size_before, self.db.stat().st_size)
        # And a write through this module's own connection is refused by SQLite.
        conn = sessiondb._connect(self.db)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM messages")
        finally:
            conn.close()

    def test_tool_noise_and_session_meta_are_not_sent_to_the_llm(self):
        build_db(
            self.db,
            [("s1", "", _ts("2026-06-01"), [
                ("user", "用 uv 而不是 pip"),
                ("assistant", "好的，记下了"),
                ("tool", "TOTAL SECRET TOOL DUMP"),
                ("session_meta", "internal bookkeeping"),
            ])],
        )
        transcripts = sessiondb.dated_transcripts(self.db)
        self.assertEqual(len(transcripts), 1)
        _day, text = transcripts[0]
        self.assertIn("uv", text)
        self.assertIn("助手: 好的", text)
        self.assertNotIn("TOOL DUMP", text)
        self.assertNotIn("bookkeeping", text)

    def test_transcripts_are_redacted_before_leaving_the_module(self):
        build_db(
            self.db,
            [("s1", "", _ts("2026-06-01"), [("user", "api_key: sk-abcdef123456 别外传")])],
        )
        [(_day, text)] = sessiondb.dated_transcripts(self.db)
        self.assertNotIn("sk-abcdef123456", text)
        self.assertIn("<REDACTED>", text)

    def test_since_excludes_that_date_and_older(self):
        build_db(
            self.db,
            [
                ("s1", "", _ts("2026-05-30"), [("user", "older")]),
                ("s2", "", _ts("2026-06-01"), [("user", "that day")]),
                ("s3", "", _ts("2026-06-02"), [("user", "newer")]),
            ],
        )
        days = [d for d, _ in sessiondb.dated_transcripts(self.db, since="2026-06-01")]
        self.assertEqual(days, ["2026-06-02"])

    def test_a_busy_day_is_chunked_instead_of_truncated(self):
        """126 sessions on 2026-06-01 must not collapse to one session's tail."""
        sessions = [
            (f"s{i}", "", _ts("2026-06-01"), [("user", f"决定{i:02d}: " + "x" * 400)])
            for i in range(20)
        ]
        build_db(self.db, sessions)
        chunks = sessiondb.dated_transcripts(self.db)
        self.assertGreater(len(chunks), 1, "a busy day must produce several chunks")
        self.assertTrue(all(day == "2026-06-01" for day, _ in chunks))
        self.assertTrue(all(len(text) <= sessiondb.MAX_TRANSCRIPT_CHARS for _, text in chunks))
        # Every session is still represented somewhere.
        joined = "\n".join(text for _, text in chunks)
        for i in range(20):
            self.assertIn(f"决定{i:02d}", joined)

    def test_an_oversized_single_session_keeps_its_tail(self):
        build_db(
            self.db,
            [("s1", "", _ts("2026-06-01"), [("user", "head " + "y" * 9000 + " CONCLUSION")])],
        )
        [(_day, text)] = sessiondb.dated_transcripts(self.db)
        self.assertLessEqual(len(text), sessiondb.MAX_TRANSCRIPT_CHARS)
        self.assertIn("CONCLUSION", text, "the end of a session is where conclusions land")

    def test_untitled_sessions_still_produce_a_transcript(self):
        build_db(self.db, [("s1", None, _ts("2026-06-01"), [("user", "no title here")])])
        [(day, text)] = sessiondb.dated_transcripts(self.db)
        self.assertEqual(day, "2026-06-01")
        self.assertIn("s1", text)


class ExportTest(unittest.TestCase):
    """The backfill path must not write into the canonical vault."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="um-sessiondb-export-"))
        self.db = self.dir / "state.db"
        build_db(
            self.db,
            [
                ("s1", "", _ts("2026-06-01"), [("user", "第一条")]),
                ("s2", "", _ts("2026-06-02"), [("user", "第二条")]),
            ],
        )

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def test_dry_run_writes_nothing(self):
        out = self.dir / "out"
        report = sessiondb.export_markdown(out, self.db, dry_run=True)
        self.assertEqual(report["dates"], 2)
        self.assertFalse(out.exists())

    def test_export_writes_one_file_per_date(self):
        out = self.dir / "out"
        report = sessiondb.export_markdown(out, self.db)
        self.assertEqual(report["written"], 2)
        names = sorted(p.name for p in out.glob("*.md"))
        self.assertEqual(names, ["2026-06-01.md", "2026-06-02.md"])
        self.assertIn("第一条", (out / "2026-06-01.md").read_text(encoding="utf-8"))

    def test_export_is_outside_the_vault_and_leaves_canonical_untouched(self):
        vault = make_scratch_vault()
        try:
            ctx = vault / "50-Agent-Context"
            before = sorted(p.name for p in ctx.iterdir())
            out = self.dir / "staging"
            sessiondb.export_markdown(out, self.db)
            self.assertTrue(out.exists())
            after = sorted(p.name for p in ctx.iterdir())
            self.assertEqual(before, after, "a read-only adapter must not write canonical notes")
        finally:
            destroy_scratch(vault)


class DigestStateSourceTest(unittest.TestCase):
    """digest reads state.db through the same (date, transcript) contract."""

    def setUp(self):
        self.vault = make_scratch_vault()
        self.dir = Path(tempfile.mkdtemp(prefix="um-digest-state-"))
        self.db = build_db(
            self.dir / "state.db",
            [("s1", "一个会话", _ts("2026-06-01"), [("user", "用 uv 管理依赖")])],
        )
        self._saved_env = sessiondb.os.environ.get(sessiondb.DB_ENV)
        sessiondb.os.environ[sessiondb.DB_ENV] = str(self.db)

    def tearDown(self):
        import shutil
        from unittest import mock

        if self._saved_env is None:
            sessiondb.os.environ.pop(sessiondb.DB_ENV, None)
        else:
            sessiondb.os.environ[sessiondb.DB_ENV] = self._saved_env
        shutil.rmtree(self.dir, ignore_errors=True)
        destroy_scratch(self.vault)

    def test_state_source_uses_its_own_cursor(self):
        """Switching sources must never consume or replay a date the other one handled."""
        from unified_memory import digest, index

        conn = index.get_conn(self.vault)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)",
                (digest.CURSOR_KEY, "2026-12-31"),
            )
            conn.commit()
        finally:
            conn.close()

        with self._fake_llm(["用 uv 管理依赖"]):
            report = digest.digest(self.vault, dry_run=True, source="state")
        # The archive cursor is far in the future; the state cursor is empty, so
        # this must still find the state-based unit.
        self.assertEqual(report["pending"], 1)

    def test_unavailable_database_degrades_to_a_reported_skip(self):
        from unified_memory import digest

        sessiondb.os.environ[sessiondb.DB_ENV] = str(self.dir / "missing.db")
        report = digest.digest(self.vault, source="state")
        self.assertEqual(report["pending"], 0)
        self.assertTrue(any("state.db" in s for s in report["skipped"]))

    def test_an_unknown_source_is_refused(self):
        from unified_memory import digest

        with self.assertRaises(ValueError):
            digest.digest(self.vault, source="telepathy")

    def _fake_llm(self, facts):
        from unittest import mock

        from unified_memory import digest

        return mock.patch.object(digest, "chat_extract_facts", return_value=list(facts))

    def test_a_real_run_writes_to_the_inbox_not_to_canonical(self):
        import os
        from unittest import mock

        from unified_memory import digest

        os.environ["SILICONFLOW_API_KEY"] = "test-key"
        try:
            canonical_before = (
                self.vault / "50-Agent-Context" / "常用路径与环境.md"
            ).read_text(encoding="utf-8")
            with mock.patch.object(digest.embed, "configured", return_value=True), \
                 self._fake_llm(["依赖用 uv 管理"]):
                report = digest.digest(self.vault, source="state")
            self.assertEqual(report["facts"], 1)
            inbox = sorted((self.vault / "50-Agent-Context" / "Agent提交区").glob("digest-*.md"))
            self.assertTrue(inbox, "facts land in the inbox")
            self.assertIn("uv", inbox[-1].read_text(encoding="utf-8"))
            self.assertEqual(
                canonical_before,
                (self.vault / "50-Agent-Context" / "常用路径与环境.md").read_text(encoding="utf-8"),
                "digest never writes canonical notes",
            )
        finally:
            os.environ.pop("SILICONFLOW_API_KEY", None)


if __name__ == "__main__":
    unittest.main()
