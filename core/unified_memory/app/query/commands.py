# -*- coding: utf-8 -*-
"""app.query.commands — search / show / preview / stats / audit bodies.

Moved verbatim from memory.py (batch B5). Legacy imports (search, preview,
stats) are recorded in test_architecture's layers whitelist; the lazy
``unified_memory.memory`` import inside cmd_search exists because the remote
HTTP client cannot move into a layer package yet (security scanner's SSRF rule
on new urllib files — see BATCH-REPORT.md).
"""
from __future__ import annotations

import re
import sys
from argparse import Namespace

from . import preview as preview_mod
from . import stats as stats_mod
from ..retrieve import pipeline as search_mod
from ...domain import envelope
from ...domain.markdown import encode_untrusted, redact
from ...domain.model import Evidence
from ...domain.policy import CANONICAL_DOCS
from ...infra.config import resolve_vault
from ...infra.console import emit_json
from ...infra.store import audit_rows, audit_verify, get_conn
from ...infra.store.ledger import claim_timeline, claims_valid_at
from ...infra.vault import (
    canonical_path,
    ensure_vault,
    is_bare_note_name,
    note_named,
    read_maybe,
    resolve_canonical_note,
)
from ..remote import REMOTE_TOKEN_ENV, remote_config, remote_search
from ...infra.store import fts_search as store_fts_search


def preview_views() -> tuple[str, ...]:
    """The preview view names, imported lazily to keep module load order free."""

    return preview_mod.VIEWS


def _search_hybrid(args: Namespace, vault: Path, want_json: bool) -> None:
    """hybrid 模式：融合检索 + 渲染/JSON。"""
    ensure_vault(vault)
    result = search_mod.hybrid_search(
        vault, args.query, limit=args.limit, format_=getattr(args, "format", "full"), budget=getattr(args, "budget", None)
    )
    if want_json:
        results = [dict(r, untrusted=True) for r in result["results"]]
        emit_json(
            "search",
            {"query": args.query, "mode": "hybrid", "count": result["count"], "confidence": result["confidence"], "streams": result["streams"], "results": results},
        )
        return
    print(search_mod.render_hybrid(result["results"], args.query))


def _search_remote(args: Namespace, vault: Path, want_json: bool) -> None:
    """remote 模式：远端索引 + 本地回退。"""
    rc = remote_config()
    if rc is None:
        raise SystemExit(
            "remote index is not configured — set UNIFIED_MEMORY_REMOTE_URL "
            f"(plus {REMOTE_TOKEN_ENV}) or add remote.url to the config. "
            "See docs/DEPLOY.md."
        )
    url, token = rc
    mode = "remote"
    try:
        results = remote_search(url, token, args.query, args.limit)
    except Exception as exc:  # noqa: BLE001
        print(f"note: remote search failed ({exc}) — fell back to local index", file=sys.stderr)
        # Fallback needs a local vault; search_index would otherwise
        # silently return no matches for a missing vault.
        ensure_vault(vault)
        results = store_fts_search(vault, args.query, args.limit)["results"]
        mode = "local"
    if want_json:
        # Every other search mode honours --json; this branch used to print
        # the fenced text regardless, so a caller asking for JSON got a
        # human panel and failed to parse it (regression test:
        # test_remote_json_mode_returns_a_json_envelope).
        emit_json(
            "search",
            {
                "query": args.query,
                "mode": mode,
                "count": len(results),
                "results": [dict(r, untrusted=True) for r in results],
            },
        )
        return
    print_memory_data(args.query, results)


def _search_local(args: Namespace, vault: Path, want_json: bool) -> None:
    """local 模式：本地 FTS。"""
    ensure_vault(vault)
    result = store_fts_search(vault, args.query, args.limit)
    if want_json:
        results = [dict(r, untrusted=True) for r in result["results"]]
        emit_json("search", {"query": args.query, "mode": "local", "count": len(results), "results": results})
        return
    print_memory_data(args.query, result["results"])


def _search_as_of(args: Namespace, vault: Path, want_json: bool) -> None:
    """as-of mode (batch D3): what did the memory believe on that date.

    The corpus is the Claim Ledger projection (claims valid at the date),
    token-filtered in Python — the ledger is small (one row per fact), so a
    dedicated FTS would be overhead, not speed. Rendered under the same
    envelope discipline as every other search surface.
    """
    ensure_vault(vault)
    date = getattr(args, "as_of", "")
    conn = get_conn(vault)
    try:
        rows = claims_valid_at(conn, date)
    finally:
        conn.close()
    query = (args.query or "").strip()
    if query:
        tokens = [t.lower() for t in re.split(r"[\s,，]+", query) if t]
        rows = [r for r in rows if any(t in r["text"].lower() for t in tokens)]
    if want_json:
        results = [
            {
                "id": r["id"],
                "text": r["text"],
                "status": r["status"],
                "valid_from": r["valid_from"],
                "valid_to": r["valid_to"],
                "untrusted": True,
            }
            for r in rows
        ]
        emit_json(
            "search",
            {"query": query, "mode": "as-of", "date": date, "count": len(results), "results": results},
        )
        return
    if not rows:
        print(envelope.NO_MATCHES)
        return
    body = ""
    for r in rows:
        window = f"{r['valid_from']} → {r['valid_to'] or 'present'}"
        body += f"  {envelope.cite_prefix(r['id'])}- {encode_untrusted(redact(r['text']))}  [{window}]\n"
    print(envelope.data_block(envelope.BANNER_SHARED_DB, body))


def cmd_explain(args: Namespace) -> None:
    """One claim's full ledger timeline (batch D3)."""
    vault = resolve_vault()
    ensure_vault(vault)
    ref = args.claim.strip().lower()
    if len(ref) < 6:
        raise SystemExit("explain: give the 16-hex claim id or at least its first 6 characters")
    conn = get_conn(vault)
    try:
        row = conn.execute(
            "SELECT id FROM claims WHERE id = ? OR id LIKE ? ORDER BY id LIMIT 1",
            (ref, ref + "%"),
        ).fetchone()
        if row is None:
            raise SystemExit(f"explain: no claim matches {args.claim!r}")
        timeline = claim_timeline(conn, row["id"])
    finally:
        conn.close()
    if getattr(args, "json", False):
        emit_json("explain", dict(timeline, untrusted=True))
        return
    print(f"claim {timeline['id']} [{timeline['status']}] {timeline['type']} scope={timeline['scope']}")
    print(f"  text: {timeline['text']}")
    print(f"  valid: {timeline['valid_from'] or '?'} → {timeline['valid_to'] or 'present'} (recorded {timeline['recorded_at']})")
    for occ in timeline["occurrences"]:
        print(f"  occurrence: {occ['doc']}:{occ['line']} (written {occ['written_at'] or '?'})")
    for link in timeline["links"]:
        arrow = "→" if link["src"] == timeline["id"] else "←"
        print(f"  link {arrow} {link['kind']}: {link['dst'] if arrow == '→' else link['src']} (by {link['decided_by'] or '?'} at {link['decided_at'] or '?'})")
    for event in timeline["events"]:
        print(f"  event #{event['seq']}: {event['op']} by {event['actor'] or '?'} at {event['at']}")


def cmd_search(args: Namespace) -> None:
    vault = resolve_vault()
    want_json = getattr(args, "json", False)
    if getattr(args, "as_of", None):
        _search_as_of(args, vault, want_json)
        return
    if getattr(args, "hybrid", False):
        _search_hybrid(args, vault, want_json)
        return
    if args.remote:
        _search_remote(args, vault, want_json)
        return
    _search_local(args, vault, want_json)


def cmd_show(args: Namespace) -> None:
    vault = resolve_vault()
    ensure_vault(vault)
    doc = args.doc
    as_json = bool(getattr(args, "json", False))
    if doc in CANONICAL_DOCS:
        path = canonical_path(vault, doc)
        reason = None
    else:
        # Any canonical note directly under 50-Agent-Context (a structured-facts
        # note the user added), plus the one nested note the index also covers.
        # No path traversal: the name must be a single segment.
        #
        # `note_named` first, so the wikilink spelling the vault itself uses
        # (`[[我的偏好摘要]]`) resolves: the suffix is added when it is missing,
        # never stripped. The refusal reason is computed on the *normalised*
        # name, or a bare `我的偏好摘要` would report `invalid-name`.
        path = resolve_canonical_note(vault, doc)
        reason = None if path is not None else (
            "invalid-name" if not is_bare_note_name(note_named(doc)) else "not-found"
        )
    if path is None:
        # `--json` keeps ok:true and carries the miss in `data.reason`, exactly
        # like `note --json`: the panel needs to tell a refused name from a
        # missing file, and runCore discards stdout from a failed subprocess.
        if as_json:
            emit_json("show", {
                "doc": doc, "name": None, "path": None, "body": None,
                "reason": reason, "untrusted": True,
            })
            return
        if reason == "invalid-name":
            raise SystemExit(f"invalid document name {doc!r}")
        raise SystemExit(f"no such canonical note: {doc}")
    body = redact(read_maybe(path))
    if as_json:
        emit_json("show", {
            "doc": doc, "name": path.name, "path": str(path), "body": body,
            "reason": None, "untrusted": True,
        })
        return
    # The text path hands a whole note to the model, so it needs the same
    # envelope as search output: a note can carry any instruction, and
    # redact() only removes credentials, not prompt injection. No blank line
    # after the banner on this path — that is the historical byte shape.
    block_body = f"doc: {encode_untrusted(path.name)}\n{encode_untrusted(body)}"
    print(envelope.data_block(envelope.BANNER_VAULT_FILE, block_body, blank_after_banner=False))


def print_memory_data(query: str, results: list[dict]) -> None:
    evidences = [
        Evidence(
            claim_id=str(r.get("id", "")),
            doc=str(r.get("doc", "")),
            line=str(r.get("snippet", "")),
        )
        for r in results
    ]
    body = ""
    if not evidences:
        body += envelope.NO_MATCHES_INBOX + "\n"
    for ev in evidences:
        body += f"doc: {encode_untrusted(ev.doc)}\n"
        if ev.line:
            body += f"  {envelope.cite_prefix(ev.claim_id)}…{encode_untrusted(redact(ev.line))}…\n"
    print(envelope.data_block(envelope.BANNER_VAULT_FILES, body))


def cmd_preview(args: Namespace) -> None:

    # Reconcile the positional and the `--view` alias here, once.
    positional = args.view
    option = getattr(args, "view_option", None)
    if positional and option and positional != option:
        # Two spellings, two different answers: silently picking one would
        # render a view the caller did not ask for.
        raise SystemExit(
            f"preview got two views — {positional!r} positionally and {option!r} via --view"
        )
    view = positional or option
    if not view:
        # `view` is optional only so `--view` can exist as an alias; with
        # neither spelling the subcommand has nothing to render. Say which
        # views exist instead of letting preview.build() receive None.
        raise SystemExit(
            "preview needs a view — one of: " + ", ".join(preview_views())
        )
    args.view = view
    vault = resolve_vault()
    ensure_vault(vault)
    data = preview_mod.build(vault, args.view, limit=args.limit)
    if getattr(args, "json", False):
        print(preview_mod.envelope(args.view, data))
        return
    body = ""
    if not data["items"]:
        # An unsupported view must not read like a successful negative answer.
        if data.get("status") == "unsupported":
            body += f"view {args.view!r} is unsupported: {data['reason']}\n"
        else:
            body += f"no items in view {args.view!r}\n"
    for item in data["items"]:
        evidence = Evidence(
            claim_id=str(item.get("id", "")),
            doc=str(item.get("name") or item.get("doc") or item.get("id", "")),
            line=str(item.get("line", "")),
        )
        body += f"doc: {evidence.doc}\n"
        if evidence.line:
            body += f"  - {evidence.line}\n"
    print(envelope.data_block(envelope.BANNER_VAULT_FILES, body))


def cmd_stats_cli(args: Namespace) -> None:
    """CLI adapter for stats: resolves the vault and prints the result."""

    vault = resolve_vault()
    ensure_vault(vault)
    data = stats_mod.build(vault)
    if getattr(args, "json", False):
        print(stats_mod.envelope(data))
        return
    print(f"memories={data['totals']['memories']} accesses={data['totals']['accesses']}")


def cmd_audit(args: Namespace) -> None:
    """Read the hash-chained audit log, or verify the chain end to end."""
    vault = resolve_vault()
    ensure_vault(vault)
    if getattr(args, "verify", False):
        ok, broken = audit_verify(vault)
        if getattr(args, "json", False):
            emit_json("audit", {"ok": ok, "broken_at": broken or None})
            return
        if ok:
            print("audit chain OK")
        else:
            print(f"audit chain BROKEN: {broken}")
            raise SystemExit(1)
        return
    rows = audit_rows(vault, limit=int(getattr(args, "limit", 0) or 0))
    agent = getattr(args, "agent", None)
    target = getattr(args, "target", None)
    since = getattr(args, "since", None)
    if agent:
        rows = [r for r in rows if r["agent"] == agent]
    if target:
        rows = [r for r in rows if target in r["target"]]
    if since:
        rows = [r for r in rows if r["at"][:10] >= since]
    # A summary (audit finding #20): the raw event stream alone made `audit`
    # a dump of 200 lines where the answer ("what happened at all?") had to be
    # re-derived by hand. Counts by agent/action plus the observed time span
    # answer that in one glance.
    summary = {
        "count": len(rows),
        "byAgent": {},
        "byAction": {},
        "span": [rows[-1]["at"] if rows else None, rows[0]["at"] if rows else None],
    }
    for r in rows:
        summary["byAgent"][r["agent"]] = summary["byAgent"].get(r["agent"], 0) + 1
        summary["byAction"][r["action"]] = summary["byAction"].get(r["action"], 0) + 1
    if getattr(args, "json", False):
        emit_json("audit", {"count": len(rows), "summary": summary, "rows": [dict(r) for r in rows]})
        return
    if not rows:
        print("no audit entries")
        return
    print(
        f"summary: {summary['count']} entries"
        f" | span {summary['span'][0] or '-'} → {summary['span'][1] or '-'}"
    )
    print("byAgent: " + ", ".join(f"{k}={v}" for k, v in sorted(summary["byAgent"].items())))
    print("byAction: " + ", ".join(f"{k}={v}" for k, v in sorted(summary["byAction"].items())))
    print()
    for r in rows:
        detail = (r["detail"] or "")[:80]
        print(f"#{r['id']} {r['at']} {r['agent']} {r['action']} {r['target']} {detail}")
