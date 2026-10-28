# -*- coding: utf-8 -*-
"""surface.cli — the argument grammar and dispatch, nothing else (batch B5).

The command bodies live in app/ and reference domains/infra directly; this
module owns only the grammar (build_parser), the dispatch (main) and the two
helpers the grammar itself needs (plain_reason). The compatibility surface
``unified_memory.memory`` re-exports everything from here.
"""
from __future__ import annotations

import argparse

from ..app.govern.commands import (
    cmd_accept_cli,
    cmd_advise_cli,
    cmd_decide_cli,
)
from ..app.ingest.commands import (
    cmd_cite,
    cmd_digest,
    cmd_dismiss_cli,
    cmd_note_cli,
    cmd_submit,
)
from ..app.maintain.commands import cmd_doctor, cmd_drift, cmd_gc
from ..app.query.commands import (
    cmd_audit,
    cmd_preview,
    cmd_search,
    cmd_show,
    cmd_stats_cli,
    preview_views,
)
from ..app.system import (
    VaultMissing,
    cmd_embed,
    cmd_graph,
    cmd_init,
    cmd_status,
    cmd_sync,
    cmd_use,
)
from ..domain.markdown import collapse_whitespace


def plain_reason(value: str) -> str:
    """Collapse a free-text reason, refusing one that carries no words.

    argparse's ``required=True`` asks only whether the flag was *given*, so
    ``--why ""`` and ``--why "   "`` both pass it — and the entry then carried
    ``- 解释：`` with nothing after it, which is precisely the unreadable
    advice this command exists to replace. The value is therefore validated,
    not just its presence, and collapsed so a pasted multi-line reason lands as
    one line in the queue like every other field.
    """
    note = collapse_whitespace(value)
    if not note:
        raise argparse.ArgumentTypeError(
            "a reason is required — advising without saying why is the "
            "question handed back untouched"
        )
    return note


def build_parser() -> argparse.ArgumentParser:
    """The CLI surface, built separately so it can be inspected by tests.

    `main()` used to build this inline. That made the one thing worth
    asserting about the grammar — which verbs exist — unobservable without
    spawning a subprocess, so a removed verb could come back unnoticed.
    """
    parser = argparse.ArgumentParser(prog="memory", description="unified agent memory CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create the vault structure")
    p_init.add_argument("--vault", required=True)
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(fn=cmd_init)

    p_use = sub.add_parser("use", help="point the config at an existing vault (no writes inside it)")
    p_use.add_argument("--vault", required=True)
    p_use.set_defaults(fn=cmd_use)

    p_search = sub.add_parser("search", help="search canonical notes")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=8)
    p_search.add_argument("--remote", action="store_true", help="use the remote index (advanced)")
    p_search.add_argument("--hybrid", action="store_true", help="hybrid retrieval: BM25 + semantic vectors + graph")
    p_search.add_argument("--format", choices=("full", "compact", "narrative"), default="full", help="result format (hybrid only)")
    p_search.add_argument("--budget", type=int, default=None, help="token budget cap (hybrid only)")
    p_search.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_search.set_defaults(fn=cmd_search)

    p_show = sub.add_parser("show", help="print a canonical document")
    p_show.add_argument("doc", help="canonical id (index/prefs/env/rules/tools/ui/coord) or a *.md note under 50-Agent-Context")
    p_show.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_show.set_defaults(fn=cmd_show)

    p_submit = sub.add_parser("submit", help="write a fact into the inbox")
    p_submit.add_argument("fact")
    p_submit.add_argument("--agent", default=None, help="agent name used in the file prefix (default dsh)")
    p_submit.set_defaults(fn=cmd_submit)

    p_status = sub.add_parser("status", help="show configuration and index health")
    p_status.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_status.set_defaults(fn=cmd_status)

    p_sync = sub.add_parser("sync", help="update the derived index and top up vectors (maintenance, not retrieval)")
    p_sync.add_argument("--limit", type=int, default=400, help="max memory lines to embed per run")
    p_sync.add_argument("--no-embed", action="store_true", help="skip the vector top-up (index only)")
    p_sync.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_sync.set_defaults(fn=cmd_sync)

    p_embed = sub.add_parser("embed", help="enrich the index with semantic vectors (SiliconFlow)")
    p_embed.add_argument("--limit", type=int, default=400, help="max memory lines to embed per run")
    p_embed.set_defaults(fn=cmd_embed)

    p_digest = sub.add_parser("digest", help="extract durable facts from archived sessions (LLM, default on)")
    p_digest.add_argument("--dry-run", action="store_true", help="preview extractions without writing")
    p_digest.add_argument("--limit", type=int, default=0, help="max archive files to process (0 = all)")
    p_digest.add_argument("--off", action="store_true", help="disable the session digest")
    p_digest.set_defaults(fn=cmd_digest)

    p_preview = sub.add_parser("preview", help="read-only governance views (pending/conflicts/forgetting/recent)")
    # `view` is positional, and that is what every doc and the plugin's own
    # argv builder use. `--view` is kept as an alias because it is the spelling
    # a caller reaches for after reading `search --limit` / `doctor --strict`:
    # argparse rejected it outright, so the mistake surfaced as exit 2 and
    # "unrecognized arguments" rather than a hint.
    #
    # The alias gets its own dest on purpose. Sharing `view` looks tidier but
    # does not work: argparse processes the optional first and the positional
    # second, so a bare positional would overwrite the already-parsed value
    # with its own default. Two names, reconciled once in cmd_preview.
    p_preview.add_argument("view", nargs="?", choices=preview_views(), help="which view to render")
    p_preview.add_argument("--view", dest="view_option", choices=preview_views(), help=argparse.SUPPRESS)
    p_preview.add_argument("--limit", type=int, default=20)
    p_preview.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_preview.set_defaults(fn=cmd_preview)

    p_graph = sub.add_parser("graph", help="build the lightweight concept graph (optional, feeds hybrid search)")
    p_graph.set_defaults(fn=cmd_graph)

    p_note = sub.add_parser("note", help="print one inbox submission")
    p_note.add_argument("name")
    p_note.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_note.set_defaults(fn=cmd_note_cli)

    p_dismiss = sub.add_parser("dismiss", help="retire one inbox submission")
    p_dismiss.add_argument("name")
    p_dismiss.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_dismiss.set_defaults(fn=cmd_dismiss_cli)

    # The positive counterpart of `dismiss`: promote ONE submission. Separate
    # from `promoter --apply`, which executes the whole pending list.
    p_accept = sub.add_parser("accept", help="promote one inbox submission into canonical notes")
    p_accept.add_argument("name")
    p_accept.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_accept.set_defaults(fn=cmd_accept_cli)

    # One conflict, one ruling. The panel's 待确认 page asks 取代 / 保留旧 / 共存
    # per conflicting fact; `promoter --adjudicate` asks the same questions but
    # reads from a terminal, so it can never be the surface a button calls.
    p_decide = sub.add_parser("decide", help="resolve one pending conflict (用新/保留旧/并存/跳过)")
    p_decide.add_argument("key")
    p_decide.add_argument("choice")
    p_decide.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_decide.add_argument("--why", default="", help="why this ruling is right; written to the history log")
    p_decide.set_defaults(fn=cmd_decide_cli)

    # The agent's half of the queue: it read both sides and could not decide.
    # Writing the recommendation down (with its reason) is what lets the panel
    # ask a question the reader can actually answer.
    p_advise = sub.add_parser("advise", help="attach a recommendation to a conflict you cannot settle")
    p_advise.add_argument("key")
    p_advise.add_argument("choice", help=" / ".join(("用新", "保留旧", "并存")))
    p_advise.add_argument("--why", required=True, type=plain_reason, help="the reason, in plain language")
    p_advise.add_argument("--json", action="store_true", help="emit a machine-readable JSON envelope")
    p_advise.set_defaults(fn=cmd_advise_cli)

    p_stats = sub.add_parser("stats", help="read-only aggregates for the memory console")
    p_stats.add_argument("--json", action="store_true", help="emit the JSON envelope")
    p_stats.set_defaults(fn=cmd_stats_cli)

    p_doctor = sub.add_parser("doctor", help="read-only health report (vault, index, queues)")
    p_doctor.add_argument("--json", action="store_true", help="emit the machine-readable report")
    p_doctor.add_argument("--strict", action="store_true", help="exit non-zero on warnings too")
    p_doctor.set_defaults(fn=cmd_doctor)

    p_gc = sub.add_parser("gc", help="prune derived data (orphan indexes, old access log, graph)")
    p_gc.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    p_gc.add_argument("--older-than", type=int, default=30, help="only orphan indexes older than N days (default 30)")
    p_gc.add_argument("--no-vacuum", action="store_true", help="skip VACUUM")
    p_gc.add_argument("--no-graph", action="store_true", help="(deprecated) the graph is computed in memory; kept for compatibility")
    p_gc.add_argument("--keep-orphans", action="store_true", help="do not delete orphan index databases")
    p_gc.add_argument("--json", action="store_true", help="emit the machine-readable report")
    p_gc.set_defaults(fn=cmd_gc)

    p_drift = sub.add_parser("drift", help="detect code-memory synchronization drift")
    p_drift.add_argument("--vault", "-v", help="path to the vault (default: UNIFIED_MEMORY_VAULT env)")
    p_drift.add_argument("--template", "-t", action="store_true", help="check against vault-template/")
    p_drift.add_argument("--strict", action="store_true", help="treat warnings as errors")
    p_drift.set_defaults(fn=cmd_drift)

    p_audit = sub.add_parser("audit", help="read or verify the hash-chained audit log")
    p_audit.add_argument("--agent", help="filter by agent/source")
    p_audit.add_argument("--target", help="substring filter on target")
    p_audit.add_argument("--since", help="only entries on/after YYYY-MM-DD")
    p_audit.add_argument("--limit", type=int, default=200, help="max entries to list")
    p_audit.add_argument("--verify", action="store_true", help="recompute the hash chain")
    p_audit.add_argument("--json", action="store_true", help="machine-readable output")
    p_audit.set_defaults(fn=cmd_audit)

    p_cite = sub.add_parser("cite", help="record citations ([short-id] echoes) as used events")
    p_cite.add_argument("--ids", help="comma/space separated 10-char short ids")
    p_cite.add_argument("--json", action="store_true", help="machine-readable output")
    p_cite.set_defaults(fn=cmd_cite)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.fn(args)
    except VaultMissing as exc:
        # One condition, one shape of answer: the message already names the
        # command that fixes it, so the stack trace added nothing but noise —
        # and `status`/`doctor` still receive it as a RuntimeError, because
        # this class is a subclass of one.
        raise SystemExit(str(exc)) from None
