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

import time
from datetime import datetime, timedelta
from pathlib import Path

from ... import embed as embed_mod
from ...domain.markdown import bare_fact_line, redact
from ...domain.policy import (
    CONFLICT_FILE,
    NON_SUBMISSION_FILES,
    SITUATION_DIR,
    is_conflict_copy,
)
from ...infra.store import (
    index_db_for as store_index_db_for,
    update_index as store_update_index,
    get_meta,
    index_counts,
    orphan_index_report,
    prune_access_log,
    prune_query_cache,
    vacuum_index,
)
from ...infra.vault import canonical_dir, ensure_vault, indexed_files as vault_indexed_files
from ...app.govern.queue import read_conflicts

ACCESS_RETENTION_DAYS = 180
QUERY_CACHE_RETENTION_DAYS = 30
ORPHAN_INDEX_DAYS = 30
BLOAT_BYTES = 100 * 1024 * 1024
STALE_INBOX_DAYS = 7
UNCLASSIFIED_FILE = "未归类事实.md"


def _days_ago(timestamp: float, now: float | None = None) -> float:
    return max(0.0, ((now or time.time()) - timestamp) / 86400)


def _issue(severity: str, code: str, message: str, hint: str = "") -> dict:
    return {"severity": severity, "code": code, "message": message, "hint": hint}


# _orphan_indexes lives in infra.store.maintain now (it opens OTHER databases
# read-only, which only the store is allowed to do).
_orphan_indexes = orphan_index_report


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

    db_path = store_index_db_for(vault)
    store_update_index(vault)
    counts = index_counts(vault)
    report["index"] = {
        "path": str(db_path),
        "bytes": db_path.stat().st_size if db_path.exists() else 0,
        **counts,
    }
    report["digest"] = {"cursor": get_meta(vault, "digest_cursor")}

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

    canonical_files = vault_indexed_files(vault)
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
        # Count bullets the same way the duplicate scan above does. A bare
        # `startswith("-")` also matches a markdown `---` rule, so the note
        # reported one phantom "fact" per horizontal line and the "N fact(s)
        # landed in 未归类事实" finding overstated the backlog. The file is
        # written by this module, so both readers must agree on what a fact
        # line is.
        "unclassifiedLines": (
            sum(
                1
                for line in unclassified.read_text(encoding="utf-8", errors="replace").splitlines()
                if line.strip().startswith(("- ", "• ", "* "))
            )
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
    prune_orphans: bool = True,
) -> dict:
    """Remove derived data only. Dry-run unless ``apply`` is true.

    The rebuild_graph parameter and its report keys are gone (batch A): the
    persisted concept graph had no readers — expand_search recomputes its
    postings from memories in memory — so the capped 5000-edge table was pure
    write amplification and the v8 migration drops it.
    """
    ensure_vault(vault)
    db_path = store_index_db_for(vault)
    cutoff = (datetime.now() - timedelta(days=older_than_days)).timestamp()
    report: dict = {
        "apply": apply,
        "orphanIndexes": [],
        "accessPruned": 0,
        "queryCachePruned": 0,
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

    report["accessPruned"] = prune_access_log(vault, ACCESS_RETENTION_DAYS, apply)
    report["queryCachePruned"] = prune_query_cache(vault, QUERY_CACHE_RETENTION_DAYS, apply)

    if apply and vacuum:
        report["vacuumed"] = vacuum_index(vault)
        try:
            report["indexBytes"] = db_path.stat().st_size
        except OSError:
            pass
    return report
