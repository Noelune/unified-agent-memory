# -*- coding: utf-8 -*-
"""health — read-only diagnostics and reversible housekeeping.

Two commands live here:

  doctor   one read-only pass over the vault, the derived index and the
           lifecycle queues. It returns a machine-readable report plus a list
           of issues with a severity, so a cron job or an agent can decide
           what to do without scraping prose.
  gc       removes only *derived* data: orphaned per-vault index databases,
           access_log rows older than a retention window, and a bloated
           concept graph. It never touches canonical notes, the inbox, the
           session archives or the forget area. Dry-run by default.

Nothing here promotes, adjudicates, edits canonical notes or deletes user
data. Both entry points are safe to call from a scheduler.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import graph as graph_mod
from . import index as index_mod
from .common import (
    CONFLICT_FILE,
    NON_SUBMISSION_FILES,
    SITUATION_DIR,
    bare_fact_line,
    canonical_dir,
    ensure_vault,
    is_conflict_copy,
    redact,
)
from .conflict import read_conflicts

ACCESS_RETENTION_DAYS = 180
QUERY_CACHE_RETENTION_DAYS = 30
ORPHAN_INDEX_DAYS = 30
BLOAT_BYTES = 100 * 1024 * 1024
BLOAT_GRAPH_EDGES = 50_000
STALE_INBOX_DAYS = 7
UNCLASSIFIED_FILE = "未归类事实.md"


def _days_ago(timestamp: float, now: float | None = None) -> float:
    return max(0.0, ((now or time.time()) - timestamp) / 86400)


def _issue(severity: str, code: str, message: str, hint: str = "") -> dict:
    return {"severity": severity, "code": code, "message": message, "hint": hint}


def _orphan_indexes(vault: Path) -> list[dict]:
    """Index DBs under ~/.unified-memory whose source vault no longer exists.

    A DB is orphaned when it has no docs rows, or when none of the vault paths
    it indexed still exist. The current vault's DB is always excluded, so a
    healthy install reports zero.
    """
    current = index_mod.index_db_for(vault).resolve()
    root = current.parent
    found: list[dict] = []
    for db in sorted(root.glob("index-*.db")):
        try:
            if db.resolve() == current:
                continue
        except OSError:
            continue
        try:
            conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            try:
                rows = conn.execute("SELECT path FROM docs").fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            continue
        if not rows:
            orphaned = True
        else:
            orphaned = not any(Path(str(row[0])).exists() for row in rows)
        if not orphaned:
            continue
        try:
            size = db.stat().st_size
        except OSError:
            size = 0
        found.append({"path": str(db), "bytes": size, "ageDays": round(_days_ago(db.stat().st_mtime), 1)})
    return found


def doctor(vault: Path) -> dict:
    """Return a complete health report. Read-only; never raises on a bad index."""
    ensure_vault(vault)
    now = time.time()
    ctx = canonical_dir(vault)
    report: dict = {
        "vault": str(vault),
        "ok": True,
        "index": {},
        "inbox": {},
        "canonical": {},
        "conflicts": {},
        "embeddings": {},
        "digest": {},
        "issues": [],
    }
    issues: list[dict] = report["issues"]

    db_path = index_mod.index_db_for(vault)
    index_mod.update_index(vault)
    conn = index_mod.get_conn(vault)
    try:
        report["index"] = {
            "path": str(db_path),
            "bytes": db_path.stat().st_size if db_path.exists() else 0,
            "journalMode": conn.execute("PRAGMA journal_mode").fetchone()[0],
            "docs": conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0],
            "memories": conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0],
            "active": conn.execute("SELECT COUNT(*) FROM memories WHERE status = 'active'").fetchone()[0],
            "superseded": conn.execute("SELECT COUNT(*) FROM memories WHERE status = 'superseded'").fetchone()[0],
            "vectors": conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0],
            "accesses": conn.execute("SELECT COUNT(*) FROM access_log").fetchone()[0],
            "graphNodes": conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0],
            "graphEdges": conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0],
        }
        cursor_row = conn.execute("SELECT value FROM index_meta WHERE key = 'digest_cursor'").fetchone()
        report["digest"] = {"cursor": cursor_row[0] if cursor_row else ""}
    finally:
        conn.close()

    inbox_files = (
        sorted((ctx / "Agent提交区").glob("*.md"))
        if (ctx / "Agent提交区").is_dir()
        else []
    )
    inbox_files = [p for p in inbox_files if p.name not in NON_SUBMISSION_FILES]
    oldest = min((p.stat().st_mtime for p in inbox_files), default=None)
    report["inbox"] = {
        "count": len(inbox_files),
        "oldestDays": round(_days_ago(oldest), 1) if oldest is not None else None,
        "files": [p.name for p in inbox_files],
    }

    canonical_files = index_mod.indexed_files(vault)
    copies = sorted(p.name for p in ctx.glob("*.md") if is_conflict_copy(p.name))
    duplicates: list[dict] = []
    for path in canonical_files:
        seen: set[str] = set()
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line.startswith(("- ", "• ", "* ")):
                continue
            bare = bare_fact_line(line)
            if not bare:
                continue
            if bare in seen:
                duplicates.append({"doc": path.name, "line": redact(bare)})
            seen.add(bare)
    unclassified = ctx / SITUATION_DIR / UNCLASSIFIED_FILE
    report["canonical"] = {
        "files": len(canonical_files),
        "conflictCopies": copies,
        "duplicateLines": duplicates,
        "unclassifiedLines": (
            sum(1 for line in unclassified.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip().startswith("-"))
            if unclassified.is_file()
            else 0
        ),
    }

    conflicts = read_conflicts(vault)
    report["conflicts"] = {"count": len(conflicts)}

    active = max(1, report["index"]["active"])
    report["embeddings"] = {
        "configured": False,
        "coverage": round(report["index"]["vectors"] / active, 3),
    }
    try:
        from . import embed as embed_mod

        report["embeddings"]["configured"] = embed_mod.configured()
    except Exception:  # noqa: BLE001 — diagnostics must never crash
        pass

    orphaned = _orphan_indexes(vault)
    # `gc` refuses to delete an orphan younger than ORPHAN_INDEX_DAYS, so a report
    # that counts every orphan makes its own hint a no-op: the reader runs
    # `memory gc --apply`, nothing is removed, and the item stays on the page
    # saying the same thing tomorrow. Split the two, and let each one carry the
    # command that actually applies to it.
    prunable = [item for item in orphaned if item["ageDays"] >= ORPHAN_INDEX_DAYS]
    report["orphanIndexes"] = {
        "count": len(orphaned),
        "bytes": sum(item["bytes"] for item in orphaned),
        "files": [item["path"] for item in orphaned],
        "prunable": len(prunable),
        "newestAgeDays": min((item["ageDays"] for item in orphaned), default=None),
    }

    # ---- issues ---------------------------------------------------------
    if copies:
        issues.append(
            _issue(
                "error",
                "sync-conflict-copies",
                f"{len(copies)} sync conflict copy file(s) in 50-Agent-Context",
                "Open both copies, merge the winner, delete the other; these files are excluded from the index.",
            )
        )
    if conflicts:
        issues.append(
            _issue(
                "warn",
                "conflicts-pending",
                f"{len(conflicts)} fact conflict(s) awaiting adjudication",
                f"Run `python -m unified_memory.promoter --adjudicate` (queue: {SITUATION_DIR}/{CONFLICT_FILE}).",
            )
        )
    if report["inbox"]["count"] and (report["inbox"]["oldestDays"] or 0) > STALE_INBOX_DAYS:
        issues.append(
            _issue(
                "warn",
                "inbox-stale",
                f"{report['inbox']['count']} inbox file(s), oldest {report['inbox']['oldestDays']} day(s)",
                "Run `python -m unified_memory.promoter --review` then `--apply`.",
            )
        )
    if duplicates:
        issues.append(
            _issue(
                "warn",
                "duplicate-facts",
                f"{len(duplicates)} exact duplicate fact line(s) in canonical notes",
                "Run `python -m unified_memory.promoter --repair-existing` (backed up first).",
            )
        )
    if report["embeddings"]["configured"] and report["embeddings"]["coverage"] < 0.5:
        issues.append(
            _issue(
                "warn",
                "embedding-coverage",
                f"only {report['embeddings']['coverage'] * 100:.0f}% of active memories have vectors",
                "Run `memory embed`; hybrid search degrades to lexical until then.",
            )
        )
    if report["index"]["graphEdges"] > BLOAT_GRAPH_EDGES:
        issues.append(
            _issue(
                "warn",
                "graph-bloat",
                f"{report['index']['graphEdges']} graph edges",
                "Run `memory gc --apply` to rebuild the bounded graph.",
            )
        )
    if report["index"]["bytes"] > BLOAT_BYTES:
        issues.append(
            _issue(
                "warn",
                "index-bloat",
                f"index database is {report['index']['bytes'] / 1e6:.0f} MB",
                "Run `memory gc --apply` to checkpoint and vacuum.",
            )
        )
    if report["orphanIndexes"]["count"]:
        total = report["orphanIndexes"]["count"]
        ready = report["orphanIndexes"]["prunable"]
        waiting = total - ready
        message = (
            f"{total} orphan index database(s), "
            f"{report['orphanIndexes']['bytes'] / 1e6:.1f} MB"
        )
        if waiting and ready:
            message += f" — {ready} older than {ORPHAN_INDEX_DAYS} days, {waiting} newer"
        elif waiting:
            message += f" — all newer than {ORPHAN_INDEX_DAYS} days"
        # Three cases, because two of them used to share a sentence that was
        # only true for one: "removes the N that are old enough" reads as an
        # instruction even when N is 0, and the reader has no way to know the
        # command they just ran was a no-op by design.
        if not waiting:
            hint = "Run `memory gc --apply` to remove indexes whose vault no longer exists."
        elif not ready:
            hint = (
                f"All {waiting} are younger than {ORPHAN_INDEX_DAYS} days, so the default "
                "`memory gc --apply` keeps them — a vault can only be temporarily unavailable, "
                "and deleting its index over a disconnected drive would be worse than the disk "
                "it costs. To remove them now: `memory gc --apply --older-than 0`."
            )
        else:
            hint = (
                f"`memory gc --apply` removes the {ready} that are old enough; the other "
                f"{waiting} are younger than {ORPHAN_INDEX_DAYS} days and are kept for the same "
                "reason. To remove all of them now: `memory gc --apply --older-than 0`."
            )
        issues.append(_issue("info", "orphan-indexes", message, hint))
    if report["canonical"]["unclassifiedLines"]:
        issues.append(
            _issue(
                "info",
                "unclassified-facts",
                f"{report['canonical']['unclassifiedLines']} fact(s) landed in {SITUATION_DIR}/{UNCLASSIFIED_FILE}",
                "Classify and move them into a canonical note, or extend CATEGORY_RULES.",
            )
        )

    report["ok"] = not any(issue["severity"] == "error" for issue in issues)
    return report


def gc(
    vault: Path,
    *,
    apply: bool = False,
    older_than_days: int = ORPHAN_INDEX_DAYS,
    vacuum: bool = True,
    rebuild_graph: bool = True,
    prune_orphans: bool = True,
) -> dict:
    """Remove derived data only. Dry-run unless ``apply`` is true."""
    ensure_vault(vault)
    db_path = index_mod.index_db_for(vault)
    cutoff = (datetime.now() - timedelta(days=older_than_days)).timestamp()
    report: dict = {
        "apply": apply,
        "orphanIndexes": [],
        "accessPruned": 0,
        "queryCachePruned": 0,
        "graphRebuilt": False,
        "vacuumed": False,
    }

    if prune_orphans:
        for item in _orphan_indexes(vault):
            if Path(item["path"]).stat().st_mtime > cutoff:
                continue
            report["orphanIndexes"].append(item)
    if apply:
        for item in report["orphanIndexes"]:
            target = Path(item["path"])
            for suffix in ("", "-wal", "-shm"):
                try:
                    Path(str(target) + suffix).unlink(missing_ok=True)
                except OSError:
                    pass

    conn = index_mod.get_conn(vault)
    try:
        cutoff_text = (datetime.now() - timedelta(days=ACCESS_RETENTION_DAYS)).strftime("%Y-%m-%d")
        report["accessPruned"] = conn.execute(
            "SELECT COUNT(*) FROM access_log WHERE at < ?", (cutoff_text,)
        ).fetchone()[0]
        query_cutoff = (datetime.now() - timedelta(days=QUERY_CACHE_RETENTION_DAYS)).strftime("%Y-%m-%d")
        report["queryCachePruned"] = conn.execute(
            "SELECT COUNT(*) FROM query_cache WHERE at < ?", (query_cutoff,)
        ).fetchone()[0]
        if apply:
            conn.execute("DELETE FROM access_log WHERE at < ?", (cutoff_text,))
            conn.execute("DELETE FROM query_cache WHERE at < ?", (query_cutoff,))
            conn.commit()
    finally:
        conn.close()

    if rebuild_graph:
        before = 0
        before_conn = index_mod.get_conn(vault)
        try:
            before = before_conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        finally:
            before_conn.close()
        if apply:
            graph_mod.build_graph(vault)
            after_conn = index_mod.get_conn(vault)
            try:
                after = after_conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
            finally:
                after_conn.close()
            report["graphRebuilt"] = True
            report["graphEdges"] = {"before": before, "after": after}
        else:
            report["graphEdges"] = {"before": before, "after": None}

    if apply and vacuum:
        conn = index_mod.get_conn(vault)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
            conn.execute("VACUUM")
            report["vacuumed"] = True
        finally:
            conn.close()
        try:
            report["indexBytes"] = db_path.stat().st_size
        except OSError:
            pass
    return report
