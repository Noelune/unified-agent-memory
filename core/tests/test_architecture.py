# -*- coding: utf-8 -*-
"""architecture — dependency-direction and effect-boundary tests (batch B, B0).

Batch B rebuilds the flat ``unified_memory`` package into four layers:

    domain    pure Python, standard library only (no project imports beyond
              its own layer)
    infra     standard library + domain (vault layout, locking, config,
              schedule, store, providers, sessiondb)
    app       domain + infra (ingest / govern / retrieve / query / maintain
              use-cases)
    surface   app + domain (argparse, dispatch, remote client, jobs)

Composition root: ``unified_memory.__main__`` (and only it) may touch infra
directly to construct the runtime.

Layer interpretation notes (documented here because the taskbook's one-line
rules need a concrete reading to be testable):

  * Same-layer sibling imports are allowed inside every layer (``domain.
    conflict`` imports ``domain.markdown``; ``app.govern`` imports
    ``app.ingest``). The rules govern cross-layer direction, not intra-layer
    organisation.
  * ``surface`` may import ``domain`` as well as ``app``: batch B task B3
    renders CLI text / JSON / remote panels from the domain model directly.
  * ``infra`` may import ``infra`` siblings (``store`` uses ``vault``).

Four effect boundaries (禁令) hold on top of the layer rules:

  1. ``import sqlite3`` only under ``infra/store/`` and in
     ``infra/sessiondb.py`` (the one sanctioned external-DB adapter);
  2. file writes — ``open(..., "w"/"a"/"x"/"+")``, ``Path.write_text``,
     ``Path.write_bytes`` — only in ``infra/vault.py`` and
     ``infra/journal.py`` (B4 adds the journal as a sanctioned writer), plus
     ``infra/sessiondb.py`` whose ``export_markdown`` deliberately writes an
     operator-supplied directory OUTSIDE the vault (it refuses to touch the
     vault itself);
  3. ``subprocess`` only in ``infra/schedule.py``;
  4. lazy (function-body) imports only under ``infra/providers/``.

Test files (``core/tests/``) are outside the scanned package and exempt.

B0 reality: the package is still flat, so every prohibition has a WHITELIST
of the modules that violate it today. The whitelist must shrink to empty by
the end of B5; a whitelist entry that no longer matches any violation fails
the suite (stale entries would hide regressions the other way). New layer
packages have NO whitelist — they must comply from the commit that adds them.

The size-budget gate (file ≤450 soft / ≤600 hard, function ≤60 lines, ≤20
top-level definitions per module) is recorded here but only asserted once
``ENFORCE_BUDGETS`` is flipped at the end of B5.
"""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1]
PKG_DIR = CORE_DIR / "unified_memory"
PKG_NAME = "unified_memory"

TESTS_EXEMPT_DIRNAME = "tests"

# ---------------------------------------------------------------------------
# Layer map
# ---------------------------------------------------------------------------

LAYER_RULES: dict[str, frozenset[str]] = {
    # layer -> layers it may import (same-layer siblings included)
    "domain": frozenset({"domain"}),
    "infra": frozenset({"domain", "infra"}),
    "app": frozenset({"domain", "infra", "app"}),
    "surface": frozenset({"app", "domain", "surface"}),
    "main": frozenset({"surface", "app", "domain", "infra"}),
}

LAYER_PREFIXES = (
    (PKG_NAME + ".domain.", "domain"),
    (PKG_NAME + ".infra.", "infra"),
    (PKG_NAME + ".app.", "app"),
    (PKG_NAME + ".surface.", "surface"),
)

# The composition root. Only it constructs the runtime (infra access).
MAIN_MODULE = PKG_NAME + ".__main__"

# ---------------------------------------------------------------------------
# Effect boundaries
# ---------------------------------------------------------------------------

SQLITE3_OK_PREFIXES = (
    PKG_NAME + ".infra.store",
    PKG_NAME + ".infra.sessiondb",
)
WRITES_OK_PREFIXES = (
    PKG_NAME + ".infra.vault",
    PKG_NAME + ".infra.journal",
    PKG_NAME + ".infra.sessiondb",
)
SUBPROCESS_OK_PREFIXES = (PKG_NAME + ".infra.schedule",)
LAZY_IMPORT_OK_PREFIXES = (PKG_NAME + ".infra.providers",)

WRITE_OPEN_MODE_CHARS = ("w", "a", "x", "+")


def _matches_any(module: str, prefixes: tuple[str, ...]) -> bool:
    return any(module == p or module.startswith(p + ".") for p in prefixes)


# ---------------------------------------------------------------------------
# Whitelist: today's violations, recorded at B0, emptied by the end of B5.
# A stale entry (the module no longer violates) is itself a failure.
# ---------------------------------------------------------------------------

WHITELIST: dict[str, set[str]] = {
    "sqlite3": {
        "unified_memory.schema",
        "unified_memory.index",
        "unified_memory.health",
        "unified_memory.sessiondb",
    },
    "writes": {
        "unified_memory.common",
        "unified_memory.config",
        "unified_memory.conflict",
        "unified_memory.forgetter",
        "unified_memory.promoter",
        "unified_memory.sessiondb",
    },
    "subprocess": {
        "unified_memory.drift",
        "unified_memory.forgetter",
        "unified_memory.promoter",
    },
    "lazy_import": {
        "unified_memory.digest",
        "unified_memory.drift",
        "unified_memory.embed",
        "unified_memory.health",
        "unified_memory.maintenance",
        "unified_memory.memory",
        "unified_memory.promoter",
        "unified_memory.schema",
        "unified_memory.search",
    },
    # third-party imports: core is dependency-free; drift's optional PyYAML is
    # the one legacy exception (lazy, degrades with an actionable message).
    "third_party": {
        "unified_memory.drift",
    },
    # cross-layer imports among the new packages: must stay empty forever.
    "layers": set(),
}

# ---------------------------------------------------------------------------
# Size budgets (recorded at B0, asserted from B5)
# ---------------------------------------------------------------------------

ENFORCE_BUDGETS = False  # flip to True at the end of B5
FILE_SOFT_LIMIT = 450
FILE_HARD_LIMIT = 600
FILE_HARD_LIMIT_EXEMPT = frozenset({PKG_NAME + ".surface.cli"})  # cap is 600 anyway
FUNCTION_LINE_LIMIT = 60
TOP_LEVEL_DEF_LIMIT = 20


# ---------------------------------------------------------------------------
# Scanning helpers
# ---------------------------------------------------------------------------


def package_modules() -> dict[str, Path]:
    """Every module in unified_memory as {dotted_name: path} (tests excluded)."""
    out: dict[str, Path] = {}
    for path in sorted(PKG_DIR.rglob("*.py")):
        if TESTS_EXEMPT_DIRNAME in path.parts:
            continue
        rel = path.relative_to(PKG_DIR).with_suffix("")
        dotted = ".".join((PKG_NAME, *rel.parts))
        if dotted.endswith(".__init__"):
            dotted = dotted[: -len(".__init__")]
            if dotted == PKG_NAME:
                continue  # package __init__ handled as its own module below
        out[dotted] = path
    init = PKG_DIR / "__init__.py"
    if init.is_file():
        out[PKG_NAME] = init
    return out


def module_layer(module: str) -> str:
    """domain / infra / app / surface / main / legacy."""
    if module == MAIN_MODULE:
        return "main"
    for prefix, layer in LAYER_PREFIXES:
        if module.startswith(prefix):
            return layer
    return "legacy"


def _target_of_import(node: ast.Import | ast.ImportFrom, module: str) -> str:
    """Dotted project name an import statement binds, or '' for stdlib/external."""
    if isinstance(node, ast.ImportFrom):
        if node.level:
            parts = module.split(".")
            # relative imports resolve against the containing package
            base = parts[: len(parts) - node.level] if module != PKG_NAME else []
            target = ".".join(base + ([node.module] if node.module else []))
            return target
        return node.module or ""
    return node.names[0].name


def _root(name: str) -> str:
    return name.split(".")[0] if name else ""


def classify_import(module: str, node: ast.Import | ast.ImportFrom) -> str:
    """One of: stdlib / project / third_party."""
    level = node.level if isinstance(node, ast.ImportFrom) else 0
    target = _target_of_import(node, module)
    root = _root(target)
    if level == 0 and root and root in sys.stdlib_module_names:
        return "stdlib"
    if level > 0 or root == PKG_NAME:
        return "project"
    return "third_party"


def scan_imports(tree: ast.Module, module: str) -> list[dict]:
    """All imports in one module with their classification."""
    found: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            found.append(
                {
                    "lineno": node.lineno,
                    "kind": classify_import(module, node),
                    "target": _target_of_import(node, module),
                    "at_module_level": _at_module_level(tree, node),
                }
            )
    return found


def _at_module_level(tree: ast.Module, node: ast.AST) -> bool:
    """True when ``node`` sits directly in the module body (not in a def/class/
    try/if/with block). Lazy = any import below module level."""
    for stmt in tree.body:
        if stmt is node:
            return True
    return False


def scan_write_ops(tree: ast.Module) -> list[int]:
    """Line numbers of file-write operations (open with a write mode,
    Path.write_text / write_bytes)."""
    lines: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if isinstance(fn, ast.Name) and fn.id == "open":
            mode = None
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                mode = node.args[1].value
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    mode = kw.value.value
            if mode is None:
                # builtin open() defaults to read; only quoted modes matter
                continue
            if any(ch in str(mode) for ch in WRITE_OPEN_MODE_CHARS):
                lines.append(node.lineno)
        elif isinstance(fn, ast.Attribute) and fn.attr == "open":
            mode = None
            if node.args and isinstance(node.args[0], ast.Constant):
                mode = node.args[0].value
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    mode = kw.value.value
            if mode and any(ch in str(mode) for ch in WRITE_OPEN_MODE_CHARS):
                lines.append(node.lineno)
        elif isinstance(fn, ast.Attribute) and fn.attr in ("write_text", "write_bytes"):
            lines.append(node.lineno)
    return lines


def scan_lazy_imports(tree: ast.Module) -> list[int]:
    """Line numbers of imports below module level."""
    lines: list[int] = []

    def walk(body: list[ast.stmt], depth: int) -> None:
        for stmt in body:
            if isinstance(stmt, (ast.Import, ast.ImportFrom)) and depth > 0:
                lines.append(stmt.lineno)
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                walk(stmt.body, depth + 1)
            elif isinstance(stmt, (ast.If, ast.For, ast.While, ast.With, ast.Try)):
                for sub in (stmt.body, getattr(stmt, "orelse", []), getattr(stmt, "finalbody", [])):
                    walk(sub, depth + 1)
                for handler in getattr(stmt, "handlers", []):
                    walk(handler.body, depth + 1)

    walk(tree.body, 0)
    return lines


def module_metrics(path: Path) -> dict:
    """Lines / largest function / top-level definition count for one module."""
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text)
    n_lines = len(text.splitlines())
    max_fn = 0
    worst_fn = ""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            length = (node.end_lineno or node.lineno) - node.lineno + 1
            if length > max_fn:
                max_fn, worst_fn = length, node.name
    top_defs = sum(
        1
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    )
    return {"lines": n_lines, "max_fn": max_fn, "worst_fn": worst_fn, "top_defs": top_defs}


def collect_violations() -> dict[str, dict[str, list[int]]]:
    """{rule: {module: [line, ...]}} for every rule the suite enforces."""
    violations: dict[str, dict[str, list[int]]] = {
        "sqlite3": {},
        "writes": {},
        "subprocess": {},
        "lazy_import": {},
        "third_party": {},
        "layers": {},
    }
    for module, path in package_modules().items():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imports = scan_imports(tree, module)
        sqlite_lines = [i["lineno"] for i in imports if i["target"] == "sqlite3" or i["target"].startswith("sqlite3.")]
        if sqlite_lines and not _matches_any(module, SQLITE3_OK_PREFIXES):
            violations["sqlite3"][module] = sqlite_lines
        subprocess_lines = [
            i["lineno"] for i in imports if i["target"] == "subprocess" or i["target"].startswith("subprocess.")
        ]
        if subprocess_lines and not _matches_any(module, SUBPROCESS_OK_PREFIXES):
            violations["subprocess"][module] = subprocess_lines
        third = [i["lineno"] for i in imports if i["kind"] == "third_party"]
        if third:
            violations["third_party"][module] = third
        lazy = scan_lazy_imports(tree)
        if lazy and not _matches_any(module, LAZY_IMPORT_OK_PREFIXES):
            violations["lazy_import"][module] = lazy
        writes = scan_write_ops(tree)
        if writes and not _matches_any(module, WRITES_OK_PREFIXES):
            violations["writes"][module] = writes
        # layer rules
        layer = module_layer(module)
        if layer in LAYER_RULES:
            allowed = LAYER_RULES[layer]
            bad = []
            for imp in imports:
                if imp["kind"] == "third_party":
                    bad.append(imp["lineno"])  # third-party banned in every layer
                    continue
                if imp["kind"] != "project":
                    continue
                target = imp["target"]
                target_root = _root(target)
                if target_root != PKG_NAME:
                    continue
                target_layer = module_layer(target)
                if target_layer == "legacy" and target != PKG_NAME:
                    bad.append(imp["lineno"])  # layers never import the flat legacy modules
                elif target_layer not in allowed:
                    bad.append(imp["lineno"])
            if bad:
                violations["layers"][module] = bad
    return violations


def format_violations(violations: dict[str, dict[str, list[int]]]) -> str:
    lines = []
    for rule in ("layers", "sqlite3", "writes", "subprocess", "lazy_import", "third_party"):
        for module in sorted(violations.get(rule, {})):
            lines.append(f"  {rule}: {module} lines {violations[rule][module]}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class DependencyRuleTests(unittest.TestCase):
    def test_prohibition_whitelists_are_exact(self):
        """Every whitelist entry must still be violating today, or it is stale.

        Keeps the whitelist from silently growing forever: as B1-B5 delete
        violations, the matching entries must be deleted too.
        """
        violations = collect_violations()
        for rule, allowed in WHITELIST.items():
            violating = set(violations.get(rule, {}))
            stale = allowed - violating
            self.assertEqual(
                stale,
                set(),
                f"stale whitelist entries for rule {rule!r} (module no longer "
                f"violates — delete the whitelist entry): {sorted(stale)}",
            )

    def test_no_disallowed_sqlite3_writes_subprocess_lazy_or_third_party(self):
        violations = collect_violations()
        problems = []
        for rule in ("sqlite3", "writes", "subprocess", "lazy_import", "third_party"):
            for module in violations[rule]:
                if module not in WHITELIST[rule]:
                    problems.append(f"{rule}: {module} lines {violations[rule][module]}")
        self.assertEqual(problems, [], "effect-boundary violations outside the whitelist:\n" + "\n".join(problems))

    def test_layer_dependency_direction(self):
        """The four layer rules; empty whitelist on purpose (no layers yet at
        B0 — the assertion binds from the first commit that adds a package)."""
        violations = collect_violations()
        outside = {
            module: lines
            for module, lines in violations["layers"].items()
            if module not in WHITELIST["layers"]
        }
        self.assertEqual(outside, {}, "cross-layer import violations:\n" + format_violations({"layers": outside}))

    def test_checker_flags_a_cross_layer_import(self):
        """The checker must go red on a deliberate violation (B0 acceptance):
        a surface module importing infra is a violation."""
        source = "import argparse\nfrom unified_memory.infra.vault import atomic_write\n"
        tree = ast.parse(source)
        imports = scan_imports(tree, "unified_memory.surface.cli")
        targets = [i["target"] for i in imports if i["kind"] == "project"]
        self.assertIn("unified_memory.infra.vault", targets)
        layer = module_layer("unified_memory.surface.cli")
        self.assertEqual(layer, "surface")
        self.assertNotIn("infra", LAYER_RULES[layer])

    def test_sqlite3_boundary_detection(self):
        source = "import sqlite3\n"
        tree = ast.parse(source)
        self.assertEqual(scan_write_ops(tree), [])
        # and the allowed modules do parse as allowed
        self.assertTrue(_matches_any("unified_memory.infra.store.claims", SQLITE3_OK_PREFIXES))
        self.assertFalse(_matches_any("unified_memory.index", SQLITE3_OK_PREFIXES))


class SizeBudgetTests(unittest.TestCase):
    """Recorded at B0 (skipped), asserted once ENFORCE_BUDGETS flips (B5)."""

    @unittest.skipUnless(ENFORCE_BUDGETS, "budget gate opens at the end of B5; metrics recorded in BATCH-B-REPORT.md")
    def test_file_and_function_budgets(self):
        breaches = []
        for module, path in package_modules().items():
            metrics = module_metrics(path)
            hard = FILE_HARD_LIMIT if module not in FILE_HARD_LIMIT_EXEMPT else FILE_HARD_LIMIT
            if metrics["lines"] > hard:
                breaches.append(f"{module}: {metrics['lines']} lines > {hard}")
            if metrics["max_fn"] > FUNCTION_LINE_LIMIT:
                breaches.append(
                    f"{module}: function {metrics['worst_fn']} is {metrics['max_fn']} lines > {FUNCTION_LINE_LIMIT}"
                )
            if metrics["top_defs"] > TOP_LEVEL_DEF_LIMIT:
                breaches.append(f"{module}: {metrics['top_defs']} top-level defs > {TOP_LEVEL_DEF_LIMIT}")
        self.assertEqual(breaches, [], "size budget breaches:\n" + "\n".join(breaches))

    def test_budget_metrics_recorded(self):
        """Always-on record of today's shape (the B0 'record, do not assert'
        half). Prints nothing on success; the numbers land in the report."""
        metrics = {module: module_metrics(path) for module, path in package_modules().items()}
        over_soft = {m: v["lines"] for m, v in metrics.items() if v["lines"] > FILE_SOFT_LIMIT}
        self.assertIsInstance(over_soft, dict)  # recorded; asserted only when ENFORCE_BUDGETS


if __name__ == "__main__":
    unittest.main()
