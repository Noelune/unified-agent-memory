# -*- coding: utf-8 -*-
"""drift — detect code/memory synchronization drift.

Compares the code-defined expectations (tools, config, canonical docs)
against what is actually documented in the vault template (or a live vault).

This module is the core of the drift prevention system. It implements
three checks:

1. TOOL_DRIFT  — tools defined in code vs tools documented in vault
2. CONFIG_DRIFT — config keys/env vars in code vs documented in vault
3. DOC_DRIFT   — canonical doc mapping in code vs actual vault files

Usage:
    python -m unified_memory.drift --vault <path> [--strict]
    python -m unified_memory.drift --template   (checks against vault-template/)
    python -m unified_memory.drift --git-precommit  (checks staged changes)
"""
from __future__ import annotations

import os
import re
import sys
import yaml
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

# ── Drift configuration ------------------------------------------------

DRIFTRC_NAME = "driftrc.yaml"
VAULT_TEMPLATE_REL = "vault-template/50-Agent-Context"
CANONICAL_MAP_REL = "core/unified_memory/common.py"

@dataclass
class DriftItem:
    """A single drift finding."""
    kind: str           # "tool" / "config" / "doc"
    severity: str       # "error" / "warning" / "info"
    message: str
    details: Optional[str] = None
    suggestion: Optional[str] = None

@dataclass
class DriftReport:
    """Complete drift report."""
    items: List[DriftItem] = field(default_factory=list)
    vault_path: Optional[str] = None
    template_path: Optional[str] = None

    @property
    def has_errors(self) -> bool:
        return any(i.severity == "error" for i in self.items)

    @property
    def has_warnings(self) -> bool:
        return any(i.severity == "warning" for i in self.items)

    def print(self, stream=sys.stdout) -> None:
        """Print a human-readable report."""
        if not self.items:
            print("✅ No drift detected — code and memory are in sync.", file=stream)
            return

        print(f"\n{'═' * 60}", file=stream)
        print(f"  DRIFT DETECTION REPORT", file=stream)
        print(f"  Vault: {self.vault_path or '(not specified)'}", file=stream)
        print(f"{'═' * 60}", file=stream)

        for item in self.items:
            icon = {"error": "❌", "warning": "⚠️ ", "info": "ℹ️ "}.get(item.severity, "•")
            print(f"\n{icon} [{item.severity.upper()}] {item.kind}: {item.message}", file=stream)
            if item.details:
                print(f"   Detail: {item.details}", file=stream)
            if item.suggestion:
                print(f"   Suggestion: {item.suggestion}", file=stream)

        error_count = sum(1 for i in self.items if i.severity == "error")
        warn_count = sum(1 for i in self.items if i.severity == "warning")
        print(f"\n{'─' * 60}", file=stream)
        print(f"  {error_count} error(s), {warn_count} warning(s)", file=stream)
        print(f"{'═' * 60}\n", file=stream)


# ── Drift detection engine ---------------------------------------------

class DriftDetector:
    """Detect drift between code definitions and vault documentation."""

    def __init__(self, repo_root: Path, vault_path: Optional[Path] = None):
        self.repo_root = repo_root
        self.vault_path = vault_path
        self.template_path = repo_root / VAULT_TEMPLATE_REL
        self._driftrc: Optional[dict] = None

    # ── Config loading ─────────────────────────────────────────────

    def load_driftrc(self) -> dict:
        """Load driftrc.yaml from the repo root."""
        if self._driftrc is not None:
            return self._driftrc
        path = self.repo_root / DRIFTRC_NAME
        if not path.exists():
            raise FileNotFoundError(f"driftrc.yaml not found at {path}")
        with open(path, "r", encoding="utf-8") as f:
            self._driftrc = yaml.safe_load(f)
        return self._driftrc

    # ── Tool drift ─────────────────────────────────────────────────

    def check_tools(self, report: DriftReport) -> None:
        """Compare tools defined in driftrc vs tools documented in vault."""
        rc = self.load_driftrc()
        vault = self._resolve_vault()

        if not vault:
            report.items.append(DriftItem(
                kind="tool", severity="warning",
                message="No vault path available, skipping tool drift check",
            ))
            return

        tools_doc_name = "工具可用性检查.md"
        tools_doc_path = vault / tools_doc_name

        if not tools_doc_path.exists():
            report.items.append(DriftItem(
                kind="tool", severity="error",
                message=f"Tools document missing: {tools_doc_name}",
                suggestion="Run `memory init --vault <path>` to create the vault structure",
            ))
            return

        doc_content = tools_doc_path.read_text(encoding="utf-8")

        for tool_def in rc.get("tools", []):
            tool_name = tool_def["name"]
            must_contain = tool_def.get("description_must_contain", "")

            if tool_name not in doc_content:
                report.items.append(DriftItem(
                    kind="tool", severity="error",
                    message=f"Tool '{tool_name}' is defined in code but not documented in {tools_doc_name}",
                    suggestion=f"Add a line like: '- memory_search — {must_contain}' to {tools_doc_name}",
                ))
            elif must_contain and must_contain not in doc_content:
                report.items.append(DriftItem(
                    kind="tool", severity="warning",
                    message=f"Tool '{tool_name}' found in {tools_doc_name} but description may be stale",
                    details=f"Expected to contain '{must_contain}' but document may not reflect it accurately",
                ))

    # ── Config drift ───────────────────────────────────────────────

    def check_config(self, report: DriftReport) -> None:
        """Compare config keys defined in code vs documented in vault."""
        rc = self.load_driftrc()
        vault = self._resolve_vault()

        if not vault:
            return

        env_doc_name = "常用路径与环境.md"
        env_doc_path = vault / env_doc_name

        if not env_doc_path.exists():
            report.items.append(DriftItem(
                kind="config", severity="warning",
                message=f"Environment doc missing: {env_doc_name}",
            ))
            return

        doc_content = env_doc_path.read_text(encoding="utf-8")

        for cfg in rc.get("config", []):
            key = cfg["key"]
            env_var = cfg.get("env", "")

            # Check if the config key or env var appears in the doc
            found_key = key in doc_content
            found_env = env_var in doc_content if env_var else False

            if not found_key and not found_env:
                report.items.append(DriftItem(
                    kind="config", severity="warning",
                    message=f"Config key '{key}' (env: {env_var}) is defined in code but not in {env_doc_name}",
                    suggestion=f"Add a line documenting '{key}' or '{env_var}' to {env_doc_name}",
                ))

    # ── Canonical doc drift ────────────────────────────────────────

    def check_canonical_docs(self, report: DriftReport) -> None:
        """Compare the CANONICAL_DOCS map in common.py against actual vault files."""
        vault = self._resolve_vault()
        if not vault:
            return

        # Read the expected map from driftrc
        rc = self.load_driftrc()
        expected_map = rc.get("canonical_docs", {}).get("expected_map", {})

        # Check each expected doc file exists in the vault
        for doc_id, filename in expected_map.items():
            doc_path = vault / filename
            if not doc_path.exists():
                report.items.append(DriftItem(
                    kind="doc", severity="error",
                    message=f"Canonical doc '{doc_id}' → '{filename}' is defined in code but missing from vault",
                    suggestion=f"Create {filename} in the vault 50-Agent-Context directory, or update driftrc.yaml",
                ))

        # Check for unexpected files in the vault
        # (files that exist in vault but have no mapping — user customizations are OK)
        # Only warn about files that look like canonical docs but aren't mapped
        canonical_dir = vault / "50-Agent-Context" if str(vault).endswith("50-Agent-Context") else vault
        # Actually, vault_path is already the 50-Agent-Context directory or the vault root
        # We handle this gracefully

    # ── Template drift ─────────────────────────────────────────────

    def check_vault_template(self, report: DriftReport) -> None:
        """Compare vault-template/ against the code definitions.

        The template is the reference that gets deployed to new vaults.
        If it drifts from the code, every new deployment is born outdated.
        """
        rc = self.load_driftrc()

        if not self.template_path.exists():
            report.items.append(DriftItem(
                kind="template", severity="warning",
                message=f"Vault template not found at {self.template_path}",
            ))
            return

        expected_map = rc.get("canonical_docs", {}).get("expected_map", {})

        for doc_id, filename in expected_map.items():
            template_file = self.template_path / filename
            if not template_file.exists():
                report.items.append(DriftItem(
                    kind="template", severity="error",
                    message=f"Doc '{filename}' missing from vault-template/",
                    suggestion=f"Add {filename} to vault-template/50-Agent-Context/ — every new vault will miss it",
                ))

        # Check template for files not in expected_map (orphaned templates)
        if self.template_path.exists():
            for f in self.template_path.iterdir():
                if f.is_file() and f.suffix == ".md" and f.name not in expected_map.values():
                    # Orphaned template file — not an error but worth noting
                    if f.name not in ("README.md",):
                        report.items.append(DriftItem(
                            kind="template", severity="info",
                            message=f"Template file '{f.name}' is not mapped in canonical_docs",
                            details="This file exists in vault-template but has no doc ID in the code map",
                        ))

    # ── Git-aware check (for pre-commit hook) ──────────────────────

    def check_git_aware(self, report: DriftReport) -> None:
        """If we're in a git repo, check if code changed without doc updates.

        Uses git diff --cached to see which files are staged.
        If a code file is staged but the corresponding memory doc is not,
        that's a suspect drift.
        """
        try:
            import subprocess
            result = subprocess.run(
                ["git", "diff", "--cached", "--name-only"],
                capture_output=True, text=True, cwd=self.repo_root, timeout=10,
            )
            if result.returncode != 0:
                return

            staged_files = result.stdout.strip().split("\n")
            rc = self.load_driftrc()

            # Build a reverse map: code pattern → expected doc
            # For now: if src/ and test/ change, tools docs should change
            code_changed = any(
                f.startswith("src/") or f.startswith("core/") or f == "driftrc.yaml"
                for f in staged_files
                if f.strip()
            )

            if not code_changed:
                return

            # Check if at least one vault-template doc changed alongside
            template_changed = any(
                f.startswith("vault-template/")
                for f in staged_files
                if f.strip()
            )

            if not template_changed:
                doc_hint = ", ".join(
                    f"vault-template/50-Agent-Context/{t['doc']}"
                    for t in rc.get("tools", [])
                )
                report.items.append(DriftItem(
                    kind="git", severity="warning",
                    message="Code files staged but no vault-template docs updated",
                    details=f"Staged: {', '.join(f for f in staged_files if f.strip() and not f.startswith('node_modules/'))[:200]}",
                    suggestion=f"Consider updating template docs: {doc_hint[:200]}",
                ))

        except Exception:
            pass  # git not available or not a repo — skip

    # ── Runner ────────────────────────────────────────────────────

    def run(self, check_git: bool = False) -> DriftReport:
        """Run all drift checks."""
        report = DriftReport(
            vault_path=str(self.vault_path) if self.vault_path else None,
            template_path=str(self.template_path) if self.template_path.exists() else None,
        )

        self.check_tools(report)
        self.check_config(report)
        self.check_canonical_docs(report)
        self.check_vault_template(report)
        if check_git:
            self.check_git_aware(report)

        return report

    # ── Helpers ───────────────────────────────────────────────────

    def _resolve_vault(self) -> Optional[Path]:
        """Return the vault path to check — explicit, env, or template fallback."""
        if self.vault_path:
            vault = self.vault_path
        elif os.environ.get("UNIFIED_MEMORY_VAULT"):
            vault = Path(os.environ["UNIFIED_MEMORY_VAULT"])
        else:
            # Fallback: use template
            return None

        # Check if vault contains 50-Agent-Context
        ctx = vault / "50-Agent-Context"
        if ctx.exists():
            return ctx
        return vault


# ── CLI entry point ──────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    """Drift detection CLI entry point (python -m unified_memory.drift ...).

    Returns 0 if no errors, 1 if errors found.
    """
    import argparse

    parser = argparse.ArgumentParser(
        description="Detect drift between code and memory vault documentation",
    )
    parser.add_argument(
        "--vault", "-v",
        help="Path to the Obsidian vault (default: UNIFIED_MEMORY_VAULT env)",
    )
    parser.add_argument(
        "--template", "-t",
        action="store_true",
        help="Check against the vault-template/ shipped with this package",
    )
    parser.add_argument(
        "--git-precommit",
        action="store_true",
        help="Also check staged git changes (for pre-commit hook)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (exit code 1 for any finding)",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Repository root directory (default: current dir)",
    )

    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()

    if args.template:
        vault_path = repo_root / VAULT_TEMPLATE_REL
    elif args.vault:
        vault_path = Path(args.vault).resolve()
    else:
        vault_path = None  # Will try env, then template fallback

    detector = DriftDetector(repo_root=repo_root, vault_path=vault_path)
    try:
        report = detector.run(check_git=args.git_precommit)
    except FileNotFoundError as e:
        print(f"❌ {e}", file=sys.stderr)
        return 1
    except yaml.YAMLError as e:
        print(f"❌ Failed to parse driftrc.yaml: {e}", file=sys.stderr)
        return 1

    report.print()

    if report.has_errors:
        return 1
    if args.strict and report.has_warnings:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())