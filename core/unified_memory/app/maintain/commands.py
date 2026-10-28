# -*- coding: utf-8 -*-
"""app.maintain.commands — doctor / gc / drift bodies.

Moved verbatim from memory.py (batch B5). The legacy ``health`` and ``drift``
imports are recorded in test_architecture's layers whitelist (their own
migration into app/maintain is the follow-up move).
"""
from __future__ import annotations

import sys
from argparse import Namespace
from pathlib import Path

from ... import drift as drift_mod
from ... import health as health_mod
from ...infra.config import resolve_vault
from ...infra.console import emit_json
from ...infra.vault import ensure_vault


def cmd_doctor(args: Namespace) -> None:
    """Read-only health report over vault, index and lifecycle queues."""

    vault = resolve_vault()
    try:
        report = health_mod.doctor(vault)
    except Exception as exc:  # noqa: BLE001 — doctor must report, not crash
        code = "vault-missing" if isinstance(exc, RuntimeError) else "doctor-failed"
        hint = (
            "Run `memory init --vault <path>` or fix ~/.unified-memory.yaml."
            if code == "vault-missing"
            else "Check the index database; `memory gc --apply` can rebuild derived tables."
        )
        report = {
            "ok": False,
            "vault": str(vault),
            "issues": [
                {
                    "severity": "error",
                    "code": code,
                    "message": str(exc),
                    "hint": hint,
                }
            ],
        }
    if getattr(args, "json", False):
        emit_json("doctor", report)
    else:
        if "index" in report:
            idx = report["index"]
            print(
                f"index: {idx['memories']} memories ({idx['active']} active, "
                f"{idx['superseded']} superseded), {idx['vectors']} vectors, "
                f"{idx['bytes'] / 1e6:.1f} MB, "
                f"journal={idx['journalMode']}"
            )
            print(
                f"inbox: {report['inbox']['count']} file(s)"
                + (
                    f" (oldest {report['inbox']['oldestDays']}d)"
                    if report["inbox"].get("oldestDays") is not None
                    else ""
                )
            )
            print(
                f"canonical: {report['canonical']['files']} note(s), "
                f"{len(report['canonical']['duplicateLines'])} duplicate line(s), "
                f"{len(report['canonical']['conflictCopies'])} conflict copy/copies"
            )
            print(f"conflicts: {report['conflicts']['count']}")
            print(
                f"embeddings: {report['embeddings']['coverage'] * 100:.0f}% coverage "
                f"(configured={report['embeddings']['configured']})"
            )
        issues = report.get("issues", [])
        if issues:
            print("issues:")
            for issue in issues:
                print(f"  [{issue['severity']}] {issue['code']}: {issue['message']}")
                if issue.get("hint"):
                    print(f"           -> {issue['hint']}")
        else:
            print("no issues found")
    has_error = any(issue.get("severity") == "error" for issue in report.get("issues", []))
    has_warning = any(issue.get("severity") == "warn" for issue in report.get("issues", []))
    if has_error or (getattr(args, "strict", False) and has_warning):
        sys.exit(1)


def cmd_gc(args: Namespace) -> None:
    """Prune derived data (orphan indexes, old access log, bloated graph)."""

    vault = resolve_vault()
    ensure_vault(vault)
    report = health_mod.gc(
        vault,
        apply=getattr(args, "apply", False),
        older_than_days=getattr(args, "older_than", 30),
        vacuum=not getattr(args, "no_vacuum", False),
        prune_orphans=not getattr(args, "keep_orphans", False),
    )
    if getattr(args, "json", False):
        emit_json("gc", report)
        return
    mode = "applied" if report["apply"] else "dry-run (re-run with --apply to change anything)"
    print(f"gc: {mode}")
    print(f"orphan index databases: {len(report['orphanIndexes'])}")
    for item in report["orphanIndexes"]:
        print(f"  {item['path']} ({item['bytes'] / 1e6:.1f} MB, {item['ageDays']}d old)")
    print(f"access_log rows pruned: {report['accessPruned']}")
    print(f"query-cache rows pruned: {report.get('queryCachePruned', 0)}")
    if report.get("graphEdges"):
        before = report["graphEdges"]["before"]
        after = report["graphEdges"]["after"]
        print(f"graph edges: {before}" + (f" -> {after}" if after is not None else ""))
    if report["apply"]:
        if report.get("indexBytes") is not None:
            print(f"index size: {report['indexBytes'] / 1e6:.1f} MB")
        print(f"vacuumed: {'yes' if report['vacuumed'] else 'no'}")


def cmd_drift(args: Namespace) -> None:
    """Detect code-memory drift."""
    # drift.py sits at the same depth the old memory.py did (one level under
    # unified_memory), so the repo-root walk is stable across this move.
    repo_root = Path(drift_mod.__file__).resolve().parents[2]
    vault_path = Path(args.vault).resolve() if args.vault else None
    if args.template:
        vault_path = repo_root / "vault-template" / "50-Agent-Context"
    detector = drift_mod.DriftDetector(repo_root=repo_root, vault_path=vault_path)
    # `python -m unified_memory.drift` has always translated these two failures
    # into one actionable line; this subcommand let them escape as tracebacks.
    # An installed package is exactly where they happen: npm's `files` list can
    # omit driftrc.yaml, and PyYAML is not a runtime dependency of the plugin.
    try:
        report = detector.run()
    except FileNotFoundError as exc:
        raise SystemExit(
            f"drift: {exc}\n"
            "There is no drift contract to compare against. driftrc.yaml ships "
            "with the package, so this means the install is incomplete (or you "
            "are running from a partial checkout) — reinstall the plugin, or run "
            "drift from the source repository."
        )
    except ModuleNotFoundError as exc:
        if exc.name != "yaml":
            raise
        raise SystemExit(
            "drift: driftrc.yaml is parsed with PyYAML, which is not installed in "
            f"this interpreter ({sys.executable}). Run `pip install pyyaml`, or set "
            "UNIFIED_MEMORY_PYTHON to one that has it."
        )
    report.print()
    if report.has_errors:
        sys.exit(1)
    if args.strict and report.has_warnings:
        sys.exit(1)
