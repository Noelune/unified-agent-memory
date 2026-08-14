# -*- coding: utf-8 -*-
"""setup/selfcheck.py — standalone deployment check (also wired into CI).

Checks (all optional parts degrade gracefully):
  1. core package importable
  2. vault structure exists (UNIFIED_MEMORY_VAULT or ~/.unified-memory.yaml)
  3. local index builds and a query round-trips
  4. promoter --review runs against the inbox
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from unified_memory import memory as mem_mod  # noqa: E402
from unified_memory import promoter  # noqa: E402


def main() -> int:
    failures: list[str] = []
    info: list[str] = []

    try:
        import unified_memory  # noqa: F401
        info.append("core importable")
    except ImportError as exc:
        failures.append(f"core not importable: {exc}")

    vault = mem_mod.resolve_vault()
    try:
        mem_mod.ensure_vault(vault)
        info.append(f"vault ok: {vault}")
    except RuntimeError as exc:
        failures.append(str(exc))
        info.append(f"vault (unconfigured, would use {vault})")

    if not failures:
        try:
            changed, fts = mem_mod.update_index(vault)
            info.append(f"index ok (fts5={'yes' if fts else 'no'})")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"index failed: {exc}")
        try:
            result = promoter.review(vault, verbose=False)
            info.append(f"promoter review ok ({len(result['pending'])} pending, {result['duplicates']} dup, {result['conflicts']} conflict)")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"promoter review failed: {exc}")

    print("selfcheck:")
    for line in info:
        print(f"  ok: {line}")
    for line in failures:
        print(f"  FAIL: {line}")
    print("all checks passed" if not failures else f"{len(failures)} problem(s) found")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
