# -*- coding: utf-8 -*-
"""cli_snapshot — byte-exact freeze of every memory subcommand (batch B, B0).

Invariant I1: the 21 subcommands' text output, JSON keys, exit codes, file
names and Markdown formats must not change during batch B. This script is the
ruler:

  * every subcommand registered in ``unified_memory.memory.build_parser`` is
    executed against a FRESH fixture vault (built from
    ``bench/golden_fixture.py``; mutating commands each get their own copy);
  * stdout / stderr / exit code are captured from a REAL child process
    (`python -m unified_memory.memory ...`), the same shape the DSH host
    spawns;
  * volatile content is normalized (temp paths, dates, times, submission
    stamps, mtimes) and the result stored as text in the snapshot JSON;
  * ``--compare`` regenerates everything and diffs against a stored snapshot,
    failing on the first difference per case.

Usage:
    python bench/cli_snapshot.py --out bench/cli-snapshot-before.json
    python bench/cli_snapshot.py --compare bench/cli-snapshot-before.json
    python bench/cli_snapshot.py --out bench/cli-snapshot-after.json

Isolation: each case runs in its own temp root with
``UNIFIED_MEMORY_VAULT`` / ``UNIFIED_MEMORY_INDEX_DB`` pointed inside it and
``USERPROFILE``/``HOME`` redirected to a scratch home, so the real
``~/.unified-memory.yaml`` and real vault are never read or written. Network
providers are forced off by stripping ``SILICONFLOW_API_KEY`` and the remote
env overrides from the child environment.

Run the generator with the SAME interpreter for before/after (Python version
affects nothing in the output bytes, but keep it consistent anyway).

Note: the taskbook says "21 subcommands" and then lists 22 names. The parser
defines 22; the coverage check below fails if the case table ever stops
matching ``build_parser`` exactly.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
sys.path.insert(0, str(CORE))

GOLDEN_TIMEOUT_S = 120
CHILD_TIMEOUT_S = 120

# --------------------------------------------------------------------------
# Scenario pre-states (plain file writes; the parent imports no vault code)
# --------------------------------------------------------------------------

CONFLICT_BLOCK = "\n".join(
    [
        "# 事实冲突待裁决队列",
        "",
        "（当前无待裁决冲突）",
        "",
        "---",
        "## 2026-10-19 03:01 冲突 #20261019030125-1",
        "- 状态：[待裁决]",
        "- 新提交：备份目录已迁移到 D:/backups",
        "- 来源：[[Hermes会话自动归档/2026-10-18]]",
        "- 既有：- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）",
        "- 所在：50-Agent-Context\\常用路径与环境.md",
        "",
    ]
)

INBOX_NOTE_NAME = "tester-20260101-000001-01.md"
INBOX_NOTE_BODY = (
    "# 提交\n\n- 测试事实一：备份服务器是 192.0.2.55\n- 测试事实二：使用统一记忆系统记录\n"
)

NOTE_WITH_OLD_LINE = (
    "# 常用路径与环境\n\n"
    "- 生产服务器地址是 203.0.113.10（写入 2026-02-01｜来源：Agent提交区/bob-20260201-01.md）\n"
    "- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）\n"
    "- 同步端口为 9443（写入 2026-03-01｜来源：Agent提交区/bob-20260301-01.md）\n"
)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# Fixed mtime for every fixture file: `preview recent` orders by mtime and
# three files written within one clock tick otherwise order by whichever run
# the filesystem clock handed out.
FIXED_MTIME = time.mktime((2026, 1, 1, 12, 0, 0, 0, 0, -1))


def _pin_mtimes(vault: Path) -> None:
    for md in vault.rglob("*.md"):
        os.utime(md, (FIXED_MTIME, FIXED_MTIME))


def prepare_scenario(kind: str, root: Path) -> Path:
    """Build the scenario's vault under ``root``; returns the vault path."""
    sys.path.insert(0, str(ROOT / "bench"))
    import golden_fixture  # noqa: E402  (parent-side; parent is not the child)

    vault = root / "vault"
    if kind == "fresh":
        return root / "fresh-vault"  # intentionally not built; `init` creates it
    if kind == "use-vault":
        # `use` points at a SECOND vault (the case's own argv names it), so
        # build the fixture directly at the path the argv will pass.
        target = root / "use-vault"
        golden_fixture.build_fixture_vault(target)
        _write(target / "50-Agent-Context" / "上下文索引.md", "# 上下文索引\n\n> 话题 → 文件映射表。\n")
        _pin_mtimes(target)
        return target
    golden_fixture.build_fixture_vault(vault)
    ctx = vault / "50-Agent-Context"
    if kind == "use-vault":
        _write(ctx / "上下文索引.md", "# 上下文索引\n\n> 话题 → 文件映射表。\n")
    elif kind == "inbox":
        _write(ctx / "Agent提交区" / INBOX_NOTE_NAME, INBOX_NOTE_BODY)
    elif kind == "conflict":
        _write(ctx / "情境信息" / "事实冲突待裁决.md", CONFLICT_BLOCK)
        _write(ctx / "常用路径与环境.md", NOTE_WITH_OLD_LINE)
    _pin_mtimes(vault)
    return vault


# --------------------------------------------------------------------------
# Case table
# --------------------------------------------------------------------------


def build_cases(root: Path) -> dict[str, dict]:
    """{case_id: {scenario, argv}} for one generation run. ``root`` is the
    per-case temp dir; every case gets its own. Paths inside argv use the
    placeholders ``{vault}`` / ``{fresh-vault}`` / ``{use-vault}``, which
    ``run_case`` substitutes with the case's own directories."""
    cases: dict[str, dict] = {}

    def add(case_id: str, scenario: str, argv: list[str]) -> None:
        cases[case_id] = {"scenario": scenario, "argv": argv}

    # search (bare)
    add("search-text", "bare", ["search", "typecheck"])
    add("search-json", "bare", ["search", "typecheck", "--json"])
    add("search-hybrid", "bare", ["search", "同步端口", "--hybrid"])
    add("search-hybrid-empty", "bare", ["search", "量子色动力学的耦合常数", "--hybrid"])
    # show (bare)
    add("show-text", "bare", ["show", "prefs"])
    add("show-json", "bare", ["show", "prefs", "--json"])
    add("show-missing", "bare", ["show", "没有这份.md"])
    # status / sync / embed
    add("status-text", "bare", ["status"])
    add("status-json", "bare", ["status", "--json"])
    add("sync-text", "bare", ["sync"])
    add("sync-json", "bare", ["sync", "--json"])
    add("embed-missing-key", "bare", ["embed"])
    # digest
    add("digest-dry-run", "bare", ["digest", "--dry-run"])
    add("digest-off", "bare", ["digest", "--off"])
    # preview
    add("preview-pending", "bare", ["preview", "pending"])
    add("preview-conflicts", "conflict", ["preview", "conflicts"])
    add("preview-forgetting", "bare", ["preview", "forgetting"])
    add("preview-recent", "bare", ["preview", "recent"])
    add("preview-pending-json", "inbox", ["preview", "pending", "--json"])
    # graph
    add("graph", "bare", ["graph"])
    # note / dismiss / accept
    add("note-text", "inbox", ["note", INBOX_NOTE_NAME])
    add("note-missing", "bare", ["note", "no-such.md"])
    add("note-missing-json", "bare", ["note", "no-such.md", "--json"])
    add("dismiss", "inbox", ["dismiss", INBOX_NOTE_NAME])
    add("accept", "inbox", ["accept", INBOX_NOTE_NAME])
    # decide / advise
    add("decide-用新", "conflict", ["decide", "20261019030125-1", "用新"])
    add("advise-并存", "conflict", ["advise", "20261019030125-1", "并存", "--why", "两边都可能为真，需要人来判断"])
    # stats / doctor / gc
    add("stats-text", "bare", ["stats"])
    add("stats-json", "bare", ["stats", "--json"])
    add("doctor-text", "bare", ["doctor"])
    add("doctor-json", "bare", ["doctor", "--json"])
    add("gc-dry-run", "bare", ["gc"])
    add("gc-json", "bare", ["gc", "--json"])
    # batch D: the Claim Ledger backfill (dry-run so the fixture is untouched;
    # the dry-run diff goes to stderr and only the summary line is captured)
    add("backfill-dry-run", "bare", ["backfill-ids", "--dry-run"])
    add("backfill-json", "bare", ["backfill-ids", "--dry-run", "--json"])
    # drift
    add("drift-template", "bare", ["drift", "--template"])
    add("drift-vault", "bare", ["drift", "--vault", "{vault}"])
    # audit / cite
    add("audit-list", "bare", ["audit"])
    add("audit-json", "bare", ["audit", "--json"])
    add("audit-verify", "bare", ["audit", "--verify"])
    add("cite", "bare", ["cite", "--ids", "abcdef1234"])
    # submit / init / use (mutating)
    add("submit", "bare", ["submit", "备份服务器是 192.0.2.55"])
    add("init", "fresh", ["init", "--vault", "{fresh-vault}"])
    add("use", "use-vault", ["use", "--vault", "{use-vault}"])
    return cases


def registered_subcommands() -> set[str]:
    """The subcommand names build_parser actually registers (coverage check)."""
    from unified_memory.memory import build_parser

    parser = build_parser()
    subparsers_action = next(
        a for a in parser._actions if isinstance(a, argparse._SubParsersAction)
    )
    return set(subparsers_action.choices)


# --------------------------------------------------------------------------
# Execution + normalization
# --------------------------------------------------------------------------

_STRIP_ENV = (
    "SILICONFLOW_API_KEY",
    "UNIFIED_MEMORY_REMOTE_URL",
    "UNIFIED_MEMORY_REMOTE_TOKEN",
    "UNIFIED_MEMORY_SESSION_DB",
    "UNIFIED_MEMORY_TEMPLATE",
)


def child_env(root: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _STRIP_ENV}
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    env["USERPROFILE"] = str(home)
    env["HOME"] = str(home)
    env["UNIFIED_MEMORY_VAULT"] = str(root / "vault")
    env["UNIFIED_MEMORY_INDEX_DB"] = str(root / "index.db")
    env["PYTHONPATH"] = str(CORE)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def normalize(text: str, root: Path) -> str:
    text = text.replace("\r\n", "\n")
    # --json output carries json.dumps-escaped paths (backslash doubled), so
    # every spelling of the case root has to be replaced.
    native = str(root)
    for variant in (
        native,
        native.replace("\\", "\\\\"),
        native.replace("\\", "/"),
        native.replace("/", "\\\\"),
        native.replace("/", "\\"),
    ):
        if variant in text:
            text = text.replace(variant, "<TMP>")
    # The per-vault index DB file name embeds sha256(vault path)[:16], which
    # changes with every temp root: abstract the hash, keep the name shape.
    text = re.sub(r"index-[0-9a-f]{16}\.db", "index-<VAULTHASH>.db", text)
    # Memory ids are sha256(absolute doc path + line), so the short [10-hex]
    # citation markers and the full JSON ids move with the temp root too.
    text = re.sub(r"\[[0-9a-f]{10}\]", "[<SHORTID>]", text)
    text = re.sub(r"\b[0-9a-f]{64}\b", "<MEMID>", text)
    # Batch D: claim ids are uuid4-drawn per fact (nondeterministic by design,
    # 改文字不改 ID) — mask them like the other random values.
    text = re.sub(r"\^c-[0-9a-f]{16}\b", "^c-<CLAIMID>", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}", "<DATE>", text)
    text = re.sub(r"\b\d{2}:\d{2}(?::\d{2})?\b", "<TIME>", text)
    text = re.sub(r"\b\d{8}-\d{6}\b", "<STAMP>", text)
    text = re.sub(r"\b\d{10}(?:\.\d+)?\b", "<MTIME>", text)
    return text


def run_case(case: dict, scenario_kind: str, case_root: Path) -> dict:
    vault = prepare_scenario(scenario_kind, case_root)
    argv = [
        a.replace("{vault}", str(vault))
        .replace("{fresh-vault}", str(case_root / "fresh-vault"))
        .replace("{use-vault}", str(case_root / "use-vault"))
        for a in case["argv"]
    ]
    cmd = [sys.executable, "-m", "unified_memory.memory", *argv]
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=child_env(case_root),
        capture_output=True,
        timeout=CHILD_TIMEOUT_S,
    )
    return {
        "argv": argv,
        "exit": proc.returncode,
        "stdout": normalize(proc.stdout.decode("utf-8", errors="replace"), case_root),
        "stderr": normalize(proc.stderr.decode("utf-8", errors="replace"), case_root),
    }


def generate() -> dict:
    cases = build_cases(Path("<root>"))  # argv template; real run substitutes per case
    registered = registered_subcommands()
    covered = {case["argv"][0] for case in cases.values()}
    missing = registered - covered
    extra = covered - registered
    if missing or extra:
        raise SystemExit(
            f"case table out of sync with build_parser — missing: {sorted(missing)}, "
            f"unknown: {sorted(extra)}. Add every subcommand; the snapshot is the contract."
        )
    results: dict[str, dict] = {}
    tmp_root = Path(tempfile.mkdtemp(prefix="um-snapshot-"))
    try:
        for case_id, case in cases.items():
            case_root = tmp_root / case_id
            case_root.mkdir(parents=True)
            results[case_id] = run_case(case, case["scenario"], case_root)
            print(f"  {case_id}: exit {results[case_id]['exit']}", file=sys.stderr)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    return {
        "meta": {
            "subcommands": sorted(registered),
            "note": "normalized: <TMP> temp paths, <DATE>/<TIME>/<STAMP> volatile times, <MTIME> mtimes",
        },
        "cases": results,
    }


def compare(snapshot_path: Path) -> int:
    stored = json.loads(snapshot_path.read_text(encoding="utf-8"))
    fresh = generate()
    failures = 0
    for case_id in sorted(set(stored["cases"]) | set(fresh["cases"])):
        old = stored["cases"].get(case_id)
        new = fresh["cases"].get(case_id)
        if old is None or new is None:
            print(f"FAIL {case_id}: {'missing from snapshot' if old is None else 'not generated'}")
            failures += 1
            continue
        for field in ("exit", "stdout", "stderr"):
            if old[field] != new[field]:
                failures += 1
                print(f"FAIL {case_id}: {field} differs (exit {old['exit']} -> {new['exit']})")
                if field != "exit":
                    diff = difflib.unified_diff(
                        (old[field] or "").splitlines(),
                        (new[field] or "").splitlines(),
                        fromfile=f"snapshot/{case_id}/{field}",
                        tofile=f"current/{case_id}/{field}",
                        lineterm="",
                        n=1,
                    )
                    for line in list(diff)[:40]:
                        print("  " + line)
    if failures:
        print(f"\n{failures} difference(s) against {snapshot_path}")
        return 1
    print(f"OK: {len(fresh['cases'])} case(s) byte-identical against {snapshot_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", help="write a fresh snapshot to this path")
    parser.add_argument("--compare", nargs="?", const=None, default=None,
                        help="regenerate and compare against a stored snapshot (default: bench/cli-snapshot-before.json)")
    args = parser.parse_args()

    if args.compare is not None or "--compare" in sys.argv:
        target = Path(args.compare) if args.compare else ROOT / "bench" / "cli-snapshot-before.json"
        return compare(target)
    out = Path(args.out) if args.out else ROOT / "bench" / "cli-snapshot-before.json"
    payload = generate()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"snapshot written: {out} ({len(payload['cases'])} cases, "
          f"{len(payload['meta']['subcommands'])} subcommands)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
