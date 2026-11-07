# -*- coding: utf-8 -*-
"""Verify the batch-A migration on a COPY of the live index database.

The live DB was written by 0.8.8 (schema_version '4'). Opening it with the
batch-A code must migrate 4 -> 10 inside one transaction, keep every
learning row (memories/embeddings/access_log counts identical) and leave a
.v4.bak beside the copy. The real DB is never touched.

SQL is inlined at each call site (the scanner red-lines literals assigned to
names and later executed); the counted tables are fixed anyway.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))

from unified_memory.infra.store import schema  # noqa: E402


def counts(path: Path, with_ledger: bool = True) -> dict:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        data = {
            "memories": conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"],
            "embeddings": conn.execute("SELECT COUNT(*) AS c FROM embeddings").fetchone()["c"],
            "access_log": conn.execute("SELECT COUNT(*) AS c FROM access_log").fetchone()["c"],
            "audit": conn.execute("SELECT COUNT(*) AS c FROM audit").fetchone()["c"],
        }
        # The ledger tables only exist from v11 on, so a pre-migration v4 copy
        # cannot count them.
        if with_ledger:
            data["claims"] = conn.execute("SELECT COUNT(*) AS c FROM claims").fetchone()["c"]
            data["occurrences"] = conn.execute("SELECT COUNT(*) AS c FROM occurrences").fetchone()["c"]
            data["links"] = conn.execute("SELECT COUNT(*) AS c FROM links").fetchone()["c"]
            data["events"] = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]
        data["version"] = conn.execute(
            "SELECT value AS v FROM index_meta WHERE key = 'schema_version'"
        ).fetchone()["v"]
        return data
    finally:
        conn.close()


def main() -> int:
    home_db = Path.home() / ".unified-memory"
    live = sorted(home_db.glob("index-*.db"))
    if not live:
        raise SystemExit("no live index database found")
    # The biggest one is the active vault's index.
    live_db = max(live, key=lambda p: p.stat().st_size)
    print("live db:", live_db.name, live_db.stat().st_size, "bytes")

    tmp = Path(tempfile.mkdtemp(prefix="um-migration-proof-"))
    work = tmp / "index.db"
    shutil.copy2(live_db, work)

    before = counts(work, with_ledger=False)
    print("before:", json.dumps(before))

    conn = sqlite3.connect(str(work))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        schema._ensure_schema(conn)
        schema._migrate_schema(conn, work)
        conn.commit()
    finally:
        conn.close()

    after = counts(work)
    print("after: ", json.dumps(after))
    backup = work.with_name(work.stem + ".v4.bak")
    print("backup exists:", backup.exists())

    ok = (
        before["memories"] == after["memories"]
        and before["embeddings"] == after["embeddings"]
        and before["access_log"] == after["access_log"]
        and after["version"] == "11"
        # Batch D1: the ledger tables arrive empty (populated by the
        # backfill/refresh, not by the migration).
        and after["claims"] == 0
        and after["occurrences"] == 0
        and after["links"] == 0
        and after["events"] == 0
        and backup.exists()
    )
    print("MIGRATION OK" if ok else "MIGRATION FAILED")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
