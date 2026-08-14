# -*- coding: utf-8 -*-
"""unified-agent-memory setup — one-command initialization.

    python setup/setup.py init --vault <path>   create vault + config + agent files
    python setup/setup.py cron [--vault <path>] register daily promotion
    python setup/setup.py selfcheck             verify the deployment

The core is dependency-free; install it once with:
    pip install -e ./core        (from this repository)
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from unified_memory import memory as mem_mod  # noqa: E402
from unified_memory import promoter  # noqa: E402
from unified_memory.common import resolve_vault  # noqa: E402


def copy_integration_files(vault: Path) -> None:
    """Copy AGENTS.md / CLAUDE.md templates next to the vault for easy pickup."""
    repo = Path(__file__).resolve().parents[1]
    for name in ("AGENTS.md", "CLAUDE.md"):
        src = repo / "integrations" / ("codex" if name == "AGENTS.md" else "claude") / name
        if src.is_file():
            target = vault / name
            shutil.copy2(src, target)
            print(f"wrote {target} (copy it into your agent home if needed)")


def cmd_init(args: argparse.Namespace) -> None:
    vault = Path(args.vault)
    mem_mod.init_vault(vault, force=args.force)
    copy_integration_files(vault)
    print()
    print("next steps:")
    print("  1. dsh users:  dsh plugin --profile web add dsh-unified-agent-memory")
    print("     and set vaultPath (env UNIFIED_MEMORY_VAULT) to this vault.")
    print("  2. Codex/Claude: copy AGENTS.md / CLAUDE.md from the vault root")
    print("     into ~/.codex/ and ~/.claude/ (or use them as references).")
    print("  3. Optional daily promotion:")
    print("       python setup/setup.py cron --vault <path>")
    print("     or manually: python -m unified_memory.promoter --review / --apply")


def cmd_cron(args: argparse.Namespace) -> None:
    vault = Path(args.vault) if args.vault else resolve_vault()
    promoter.register_cron(vault)


def cmd_selfcheck(args: argparse.Namespace) -> None:
    vault = Path(args.vault) if args.vault else resolve_vault()
    failures: list[str] = []
    info: list[str] = []

    try:
        mem_mod.ensure_vault(vault)
        info.append(f"vault structure ok at {vault}")
    except RuntimeError as exc:
        failures.append(str(exc))

    try:
        changed, fts = mem_mod.update_index(vault)
        info.append(f"local index ok ({changed} file(s) re-indexed, fts5={'yes' if fts else 'no'})")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"index failed: {exc}")

    try:
        import unified_memory  # noqa: F401
        info.append("core importable")
    except ImportError as exc:
        failures.append(f"core not importable: {exc} (run: pip install -e ./core)")

    inbox = vault / "50-Agent-Context" / "Agent提交区"
    pending = len(list(inbox.glob("*.md"))) if inbox.is_dir() else 0
    info.append(f"inbox pending files: {pending}")

    print("selfcheck:")
    for line in info:
        print(f"  ok: {line}")
    for line in failures:
        print(f"  FAIL: {line}")
    print(failures and f"{len(failures)} problem(s) found" or "all checks passed")
    sys.exit(1 if failures else 0)


def main() -> None:
    parser = argparse.ArgumentParser(prog="setup", description="unified-agent-memory setup")
    sub = parser.add_subparsers(dest="command", required=True)
    p_init = sub.add_parser("init", help="create vault + config + agent files")
    p_init.add_argument("--vault", required=True)
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(fn=cmd_init)
    p_cron = sub.add_parser("cron", help="register daily promotion")
    p_cron.add_argument("--vault", default=None)
    p_cron.set_defaults(fn=cmd_cron)
    p_self = sub.add_parser("selfcheck", help="verify deployment")
    p_self.add_argument("--vault", default=None)
    p_self.set_defaults(fn=cmd_selfcheck)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
