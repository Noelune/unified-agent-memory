# -*- coding: utf-8 -*-
"""app.ingest.commands — submit / note / dismiss / digest / cite bodies.

Moved verbatim from memory.py (batch B5). Legacy imports (digest, inbox,
index, promoter) are recorded in test_architecture's layers whitelist: their
own migrations are either blocked by the security scanner's SSRF rule
(digest) or scheduled as the follow-up promoter/conflict split.
"""
from __future__ import annotations

import json
import re
import sys
import time
from argparse import Namespace
from pathlib import Path

from ... import digest as digest_mod
from ... import preview as preview_mod
from ... import inbox as inbox_mod
from ... import promoter as promoter_mod
from ...domain.markdown import looks_like_credential
from ...infra import config as config_mod
from ...infra.config import resolve_vault
from ...infra.console import emit_json
from ...infra.store import record_audit, record_used_events
from ...infra.vault import atomic_create, canonical_dir, ensure_vault
from ..system import is_agent_file_prefix


def cmd_submit(args: Namespace) -> None:
    vault = resolve_vault()
    ensure_vault(vault)
    agent = args.agent or "dsh"
    if not is_agent_file_prefix(agent):
        raise SystemExit(
            "invalid agent name: use 1-64 letters, digits, dots, underscores, or hyphens "
            "and start with a letter or digit"
        )
    lines = args.fact.splitlines()
    if not lines or not any(l.strip() for l in lines):
        raise SystemExit("nothing to submit — pass a fact string")
    rejected = [ln for ln in lines if looks_like_credential(ln)]
    if rejected:
        raise SystemExit(
            "submission rejected: line looks like a plaintext credential "
            "(only store a label/location reference, never the secret)."
        )
    inbox = canonical_dir(vault) / "Agent提交区"
    inbox.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(f"- {ln.strip()}" if not ln.strip().startswith("-") else ln.strip() for ln in lines if ln.strip())
    for seq in range(1, 1000):
        candidate = inbox / f"{agent}-{stamp}-{seq:02d}.md"
        if atomic_create(candidate, body + "\n"):
            record_audit(vault, agent, "submit", candidate.name, lines[0][:120])
            print(f"submitted {len(lines)} fact line(s) -> {candidate}")
            print("the promoter (python -m unified_memory.promoter --review) will classify these")
            return
    raise SystemExit("could not allocate a submission file name")


def cmd_note_result(vault: str, name: str, as_json: bool = False) -> tuple[bool, str]:
    """Print one inbox submission's body, reporting whether it worked.

    The `ok` flag exists for the *text* path only. `note --json` keeps
    ``ok: true`` on a miss and expresses the failure in ``data.body`` (null) +
    ``data.reason``, because the browser panel needs that reason to tell
    "rejected name" from "no such file" — docs/JSON-CONTRACT.md §5.2.
    The CLI used to exit 0 on that same miss while printing an empty line, so
    a script could not tell a missing submission from an empty one.
    """

    result = preview_mod.read_inbox_item(vault, name)
    ok = result.get("body") is not None
    if as_json:
        return ok, json.dumps(
            {"ok": True, "command": "note", "data": result},
            ensure_ascii=False,
        )
    if not ok:
        # Nothing on stdout: an empty body and a missing file must not look
        # alike in a pipe.
        print(
            f"note: {result.get('reason') or 'not-found'}: {name}",
            file=sys.stderr,
        )
        return False, ""
    return True, result["body"] or ""


def cmd_note(vault: str, name: str, as_json: bool = False) -> str:
    """Print one inbox submission's body."""
    return cmd_note_result(vault, name, as_json)[1]


def cmd_note_cli(args: Namespace) -> None:
    """CLI adapter for cmd_note: resolves the vault and prints the result."""
    vault = resolve_vault()
    ensure_vault(vault)
    ok, text = cmd_note_result(vault=str(vault), name=args.name, as_json=args.json)
    if text:
        print(text)
    # JSON output carries the miss inside the envelope (see cmd_note_result);
    # the human/script path has only the exit status to carry it.
    if not ok and not args.json:
        sys.exit(1)


def cmd_dismiss(vault: str, name: str, as_json: bool = False) -> str:
    """Retire one inbox item without promoting it.

    One of four mutating commands (`dismiss`, `accept`, `decide`, and the
    promoter's own `--apply`); `dismiss` used to be the only one, which is why
    the panel treated "no" as the whole vocabulary of the queue.
    """
    result = inbox_mod.process_inbox_item(vault, name)
    if as_json:
        # Envelope shape and exit-0-on-rejection are contractual: §1.1. The
        # panel reads data.reason, which only survives if the command exits 0
        # (runCore discards stdout from a failed subprocess).
        return json.dumps(
            {"ok": result["ok"], "command": "dismiss", "data": result},
            ensure_ascii=False,
        )
    if result["ok"]:
        return f"moved to {result['movedTo']}"
    print(f"dismiss: {result['reason']}", file=sys.stderr)
    return ""


def cmd_dismiss_cli(args: Namespace) -> None:
    """CLI adapter for cmd_dismiss: resolves the vault and prints the result."""
    vault = resolve_vault()
    ensure_vault(vault)
    text = cmd_dismiss(vault=str(vault), name=args.name, as_json=args.json)
    if text:
        print(text)
    # Same rule as `note` (see cmd_note_cli): the text path has only the exit
    # status to carry a refusal, and printing the reason to stderr while exiting
    # 0 told a script the dismiss had happened. The `--json` path keeps exit 0
    # on purpose — the panel reads `data.reason` and runCore discards stdout
    # from a failed subprocess (§1.1).
    if not text and not args.json:
        sys.exit(1)


def cmd_digest(args: Namespace) -> None:
    vault = resolve_vault()
    ensure_vault(vault)
    if args.off:
        digest_mod._set_enabled(config_mod.default_path(), False)
        print("session digest disabled (digest.enabled=false)")
        return
    if not digest_mod.digest_enabled(config_mod.default_path()):
        print("session digest is disabled (set digest.enabled=true to re-enable)")
        return
    report = digest_mod.digest(vault, dry_run=args.dry_run, limit=getattr(args, "limit", 0))
    print(
        f"digest: {report['pending']} new archive(s), wrote {report['written']} file(s), "
        f"{report['facts']} fact(s)"
    )
    for skipped in report["skipped"]:
        print(f"  skipped: {skipped}")


def cmd_cite(args: Namespace) -> None:
    """Report citations: the host tells us which short ids the model used.

    Named `cite` because `memory use <vault>` already means "point the config
    at this vault" — overloading it would have broken vault selection. Only
    cited ids earn a ``used`` event, the forgetter's reinforcement signal;
    retrieval alone never reinforces (batch A).
    """
    vault = resolve_vault()
    ensure_vault(vault)
    raw = str(getattr(args, "ids", "") or "")
    shorts = [s.strip().lower() for s in re.split(r"[\s,，]+", raw) if s.strip()]
    if not shorts:
        raise SystemExit("usage: memory cite --ids <short-id>[,<short-id>...]")
    matched = record_used_events(vault, shorts)
    if getattr(args, "json", False):
        emit_json("cite", {"requested": len(shorts), "matched": matched})
        return
    print(f"cite: {matched}/{len(shorts)} citation(s) recorded")
