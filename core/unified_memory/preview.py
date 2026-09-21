# -*- coding: utf-8 -*-
"""preview — read-only governance views over the shared memory.

Four views, all strictly read-only (no writes, no index mutation beyond the
self-healing update_index call every command performs):

  pending     inbox files awaiting promotion (Agent提交区)
  conflicts   memories flagged as conflicting
  forgetting  low-salience active memories, decay-ordered
  recent      canonical notes by modification time

Vault content is returned under ``line``/``doc``/``name`` fields and is always
redacted. Callers must treat these as DATA. The CLI wraps them in
<memory-data> on the text path; the JSON path marks records ``untrusted``.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import index as index_mod
from .common import canonical_dir, redact

VIEWS = ("pending", "conflicts", "forgetting", "recent")


def build(vault: Path, view: str, limit: int = 20) -> dict:
    """Return one view as {"view", "count", "items"}. Read-only."""
    if vault is None:
        raise SystemExit("preview needs a vault")
    if view not in VIEWS:
        raise SystemExit(f"unknown view {view!r} — choose from {', '.join(VIEWS)}")
    index_mod.update_index(vault)  # self-healing derived db, same as every command
    builders = {
        "pending": _pending,
        "conflicts": _conflicts,
        "forgetting": _forgetting,
        "recent": _recent,
    }
    items = builders[view](vault, limit)
    return {"view": view, "count": len(items), "items": items}


def envelope(view: str, data: dict) -> str:
    """Wrap a view in the same JSON envelope the rest of the CLI uses."""
    return json.dumps({"ok": True, "command": "preview", "data": data}, ensure_ascii=False)


def _pending(vault: Path, limit: int) -> list[dict]:
    inbox = canonical_dir(vault) / "Agent提交区"
    if not inbox.is_dir():
        return []
    files = sorted(inbox.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    return [
        {"name": p.name, "path": str(p), "mtime": p.stat().st_mtime, "untrusted": True}
        for p in files
    ]


def _conflicts(vault: Path, limit: int) -> list[dict]:
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance FROM memories "
            "WHERE status = 'active' AND type = 'conflict' LIMIT ?",
            (limit,),
        ).fetchall()
    except Exception:  # noqa: BLE001 — a missing column/table must not crash the view
        return []
    finally:
        conn.close()
    return [
        {"id": r["id"], "doc": redact(Path(r["doc"]).name), "line": redact(r["line"]),
         "type": r["type"], "importance": r["importance"], "untrusted": True}
        for r in rows
    ]


def _forgetting(vault: Path, limit: int) -> list[dict]:
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance, access_count FROM memories "
            "WHERE status = 'active' ORDER BY access_count ASC, importance ASC LIMIT ?",
            (limit,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return []
    finally:
        conn.close()
    return [
        {"id": r["id"], "doc": redact(Path(r["doc"]).name), "line": redact(r["line"]),
         "type": r["type"], "importance": r["importance"],
         "accessCount": r["access_count"], "untrusted": True}
        for r in rows
    ]


def _recent(vault: Path, limit: int) -> list[dict]:
    ctx = canonical_dir(vault)
    if not ctx.is_dir():
        return []
    files = [p for p in ctx.glob("*.md") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {"name": p.name, "path": str(p), "mtime": p.stat().st_mtime, "untrusted": True}
        for p in files[:limit]
    ]
