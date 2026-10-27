# -*- coding: utf-8 -*-
"""stage a synthetic "live" v4 database so verify_live_migration.py can run
on a machine without a real ~/.unified-memory — the v4 shape is copied from
core/tests/test_schema_migrations (old column layout, pre-v5 ids).

Usage: python _stage_v4.py <home-dir>
Writes <home-dir>/.unified-memory/index-staged.db at schema_version 4.
"""
import sqlite3
import sys
from pathlib import Path

home = Path(sys.argv[1])
db_dir = home / ".unified-memory"
db_dir.mkdir(parents=True, exist_ok=True)
db = db_dir / "index-staged.db"

conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row
try:
    # v4 shape: memories without text_hash/legacy_id; fts_mem trio present.
    conn.execute("CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        """CREATE TABLE memories (
            id TEXT PRIMARY KEY, doc TEXT NOT NULL, line TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'fact', importance REAL NOT NULL DEFAULT 0.5,
            status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
            superseded_by TEXT, source_agent TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '', access_count INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT NOT NULL DEFAULT '{}')"""
    )
    conn.execute("CREATE TABLE embeddings (memory_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vector BLOB NOT NULL)")
    conn.execute("CREATE TABLE access_log (memory_id TEXT NOT NULL, at TEXT NOT NULL)")
    conn.execute("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')")
    conn.execute("CREATE VIRTUAL TABLE fts_mem USING fts5(memory_id UNINDEXED, tokens)")
    conn.execute("CREATE TABLE docs (path TEXT PRIMARY KEY, digest TEXT NOT NULL, title TEXT NOT NULL)")
    conn.execute("INSERT INTO index_meta VALUES ('schema_version', '4')")
    # Two learning rows + one vector + one access event: these must survive.
    conn.execute(
        "INSERT INTO memories (id, doc, line, type, importance, created_at, updated_at, access_count) VALUES (?, ?, ?, 'rule', 0.9, '2026-01-01T00:00:00', '2026-01-01T00:00:00', 2)",
        ("a" * 64, "C:\\v\\50-Agent-Context\\工程执行规则.md", "构建产物必须经过 typecheck"),
    )
    conn.execute(
        "INSERT INTO memories (id, doc, line, type, importance, created_at, updated_at) VALUES (?, ?, ?, 'fact', 0.5, '2026-02-01T00:00:00', '2026-02-01T00:00:00')",
        ("b" * 64, "C:\\v\\50-Agent-Context\\常用路径与环境.md", "同步端口为 8443"),
    )
    conn.execute("INSERT INTO embeddings VALUES (?, 1024, ?)", ("a" * 64, b"\x00" * 4096))
    conn.execute("INSERT INTO access_log VALUES (?, '2026-03-01T00:00:00')", ("a" * 64,))
    conn.execute("INSERT INTO audit (at, agent, action, target) VALUES ('2026-01-01T00:00:00', 'test', 'seed', 'x')")
    conn.commit()
    print("staged:", db)
finally:
    conn.close()
