# -*- coding: utf-8 -*-
"""app.govern.commands — decide / advise / accept bodies.

Moved verbatim from memory.py (batch B5). It used to reach the whole flat
legacy namespace twice: the conflict queue (now next door, ``app/govern/
queue.py``) and the ``promoter`` facade. Both are gone — this module now
imports the implementations it actually calls, so a layer reader can see
every dependency without opening a shim.
"""
from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path

from . import decide as decide_mod
from . import queue as queue_mod
from .promote import accept
from ...domain.markdown import collapse_whitespace
from ...infra.config import resolve_vault
from ...infra.vault import ensure_vault


def cmd_accept(vault: str, name: str, as_json: bool = False) -> str:
    """Promote ONE submission out of the inbox into the canonical notes.

    The positive half of the panel's 待确认 queue. Kept per-file for the same
    reason `dismiss` is: the queue is a list of independent decisions, and the
    vault-wide `promoter --apply` would decide the other rows too.
    """

    result = accept(Path(vault), name)
    if as_json:
        # Same contract as dismiss: exit 0 even on a business refusal, because
        # runCore discards stdout from a failed subprocess and the panel needs
        # `data.reason` to say WHY the accept did not happen.
        return json.dumps(
            {"ok": result["ok"], "command": "accept", "data": result},
            ensure_ascii=False,
        )
    if result["ok"]:
        return f"accepted {result['promoted']} fact(s) from {name}"
    print(f"accept: {result['reason']}", file=sys.stderr)
    return ""


def cmd_accept_cli(args: Namespace) -> None:
    """CLI adapter for cmd_accept: resolves the vault and prints the result."""
    vault = resolve_vault()
    ensure_vault(vault)
    text = cmd_accept(vault=str(vault), name=args.name, as_json=args.json)
    if text:
        print(text)
    # A refused accept must be visible to a script; see cmd_dismiss_cli.
    if not text and not args.json:
        sys.exit(1)


def cmd_advise(vault: str, key: str, choice: str, why: str, as_json: bool = False) -> str:
    """Attach a recommendation to a conflict the agent could not settle.

    The counterpart of `decide` for the honest dead end. Handing the person the
    same two lines the agent has just failed to separate is what made the queue
    unreadable; this writes the recommendation and its plain-language reason
    into the entry so the panel can show them above the buttons.

    Restricted to the three rulings that mean something as a recommendation:
    `跳过` is a way to defer, not advice about which side is true.

    A reason of pure whitespace is refused here as well as in the parser: this
    function is importable API, and the CLI's ``type=plain_reason`` only guards
    the command line. Both refusals exist so that no caller can reach
    ``record_advice`` with nothing to say.
    """

    note = collapse_whitespace(why)
    if not note:
        # Decided before the queue is even read: "there is nothing to say" is a
        # fact about the request, not about the queue, and it must not come back
        # as `not-found` when the key happens to be missing as well.
        result = {"ok": False, "reason": "no-reason", "key": key, "choice": choice}
    else:
        entry = queue_mod.find_conflict(Path(vault), key)
        if entry is None:
            result = {"ok": False, "reason": "not-found", "key": key, "choice": choice}
        elif choice not in decide_mod.ADVISABLE:
            result = {"ok": False, "reason": "unknown-choice", "key": key, "choice": choice,
                      "allowed": list(decide_mod.ADVISABLE)}
        else:
            wrote = queue_mod.record_advice(Path(vault), entry, choice, note)
            result = {
                "ok": wrote,
                "reason": None if wrote else "not-found",
                "key": key, "choice": choice, "why": note,
            }

    if as_json:
        # Same envelope rule as everywhere else: a business refusal exits 0,
        # because runCore discards stdout from a failed subprocess and the panel
        # needs `data.reason` to explain itself.
        return json.dumps({"ok": result["ok"], "command": "advise", "data": result},
                          ensure_ascii=False)
    if result["ok"]:
        return f"{key}: advised {choice}"
    print(f"advise: {result['reason']}", file=sys.stderr)
    return ""


def cmd_advise_cli(args: Namespace) -> None:
    """CLI adapter for cmd_advise: resolves the vault and prints the result."""
    vault = resolve_vault()
    ensure_vault(vault)
    text = cmd_advise(
        vault=str(vault), key=args.key, choice=args.choice,
        why=args.why, as_json=args.json,
    )
    if text:
        print(text)
    # A refused advise must be visible to a script; see cmd_dismiss_cli.
    if not text and not args.json:
        sys.exit(1)


def cmd_decide(vault: str, key: str, choice: str, as_json: bool = False, why: str = "") -> str:
    """Resolve ONE pending conflict: 用新 / 保留旧 / 并存 / 跳过.

    `key` is `conflict.entry_key` — the stamp the human block format carries, or
    a content hash for the JSON shape — never a list index: resolving one row
    shifts every later one, which is exactly when a stale click arrives.

    Both refusals are business answers rather than faults, so they travel as
    `reason` in a normal envelope: `not-found` means someone else already ruled
    (or the file was edited by hand), `unknown-choice` means the client sent a
    word this build does not implement.

    `why` is optional and only ever lands in the history log. An agent that
    decides on someone's behalf should say why in the same breath; a bare verdict
    in `事实冲突已裁决.md` is unreadable a month later.
    """

    entry = queue_mod.find_conflict(Path(vault), key)
    if entry is None:
        result = {"ok": False, "reason": "not-found", "key": key, "choice": choice,
                  "applied": False, "target": None}
    elif choice not in decide_mod.DECISIONS:
        result = {"ok": False, "reason": "unknown-choice", "key": key, "choice": choice,
                  "applied": False, "target": None}
    else:
        result = decide_mod.decide(Path(vault), entry, choice, why=why)
        result["key"] = key

    if as_json:
        return json.dumps({"ok": result["ok"], "command": "decide", "data": result},
                          ensure_ascii=False)
    if result["ok"]:
        tail = f" -> {result['target']}" if result.get("target") else ""
        return f"{key}: {choice}{tail}"
    print(f"decide: {result['reason']}", file=sys.stderr)
    return ""


def cmd_decide_cli(args: Namespace) -> None:
    """CLI adapter for cmd_decide: resolves the vault and prints the result."""
    vault = resolve_vault()
    ensure_vault(vault)
    text = cmd_decide(
        vault=str(vault), key=args.key, choice=args.choice,
        as_json=args.json, why=getattr(args, "why", "") or "",
    )
    if text:
        print(text)
    # A refused decide must be visible to a script; see cmd_dismiss_cli.
    if not text and not args.json:
        sys.exit(1)
