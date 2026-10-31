# -*- coding: utf-8 -*-
"""app.system — vault lifecycle, index maintenance and feedback commands.

Moved verbatim from memory.py (batch B5) with one import shift: the legacy
``index``/``embed``/``graph`` module references stay (embed's migration is
blocked by the security scanner's SSRF rule — see BATCH-REPORT.md), recorded
in test_architecture's layers whitelist.
"""
from __future__ import annotations

import os
import re
import shutil
import time
from argparse import Namespace
from pathlib import Path

from ..infra.providers import embed as embed_mod
from .maintain.backfill import ensure_backfilled
from .retrieve import graph as graph_mod
from ..domain.policy import AGENT_CONTEXT, CANONICAL_DOCS, NON_SUBMISSION_FILES, VAULT_ENV
from ..infra import config as config_mod
from ..infra.config import VaultMissing, parse_config, resolve_vault  # noqa: F401  (re-exported for surface)
from ..infra.console import emit_json
from ..infra.store import (
    fts_search as store_fts_search,
    index_db_for as store_index_db_for,
    memory_count,
    update_index as store_update_index,
    vector_count,
)
from ..infra.vault import atomic_write, canonical_dir, canonical_path, ensure_vault


def is_agent_file_prefix(value: str) -> bool:
    """Return whether ``value`` is a portable, single-segment file prefix."""
    return (
        1 <= len(value) <= 64
        and value[0].isalnum()
        and all(char.isalnum() or char in "._-" for char in value)
    )


def index_db_for(vault: Path) -> Path:
    return store_index_db_for(vault)


# --------------------------------------------------------------------------
# Minimal built-in template (fallback when the repository template is absent,
# e.g. after a bare pip install). The repository vault-template/ is richer and
# is used automatically when available.
# --------------------------------------------------------------------------

TEMPLATE_FILES: dict[str, str] = {
    "上下文索引.md": "# 上下文索引\n\n> 话题 → 文件映射表。用 <VAULT>/50-Agent-Context 替换所有占位符。\n\n- 偏好 → 我的偏好摘要.md\n- 环境与路径 → 常用路径与环境.md\n- 规则 → 工程执行规则.md\n- 工具状态 → 工具可用性检查.md\n- UI 审美 → UI审美准则.md\n- 协作规则 → Codex-Claude-Hermes协作规则.md\n",
    "我的偏好摘要.md": "# 我的偏好摘要\n\n> 该用户的稳定偏好（语言、格式、工作方式）。逐行一条事实。\n\n- 示例：prefers concise bullet-point answers（示例，替换为你自己的偏好）\n",
    "常用路径与环境.md": "# 常用路径与环境\n\n> 常用路径、工具版本、环境事实。逐行一条。以下为 dsh-unified-agent-memory 插件配置项。\n\n- UNIFIED_MEMORY_VAULT — path to the Obsidian vault (required; config key vaultPath)\n- UNIFIED_MEMORY_PYTHON — Python interpreter for the memory core (default \"python\"; config key pythonPath)\n- UNIFIED_MEMORY_COREPATH — path to core/ directory for PYTHONPATH (auto-set by plugin; config key corePath)\n- UNIFIED_MEMORY_REMOTE_URL — optional remote index server URL\n- UNIFIED_MEMORY_REMOTE_TOKEN — optional remote index auth token\n",
    "工程执行规则.md": "# 工程执行规则\n\n> 跨会话执行规则（验证、审计、安全红线）。逐行一条。\n\n- 示例：verify builds before claiming success（示例）\n",
    "工具可用性检查.md": "# 工具可用性\n\n> 工具/服务可用状态与故障记录。逐行一条。以下为 dsh-unified-agent-memory 插件提供的模型工具。\n\n- memory_search — search canonical notes in the shared agent memory vault (local SQLite FTS5 index; pass --remote for remote index)\n- memory_show — print one canonical memory document (index, prefs, env, rules, tools, ui, coord, or a *.md note)\n- memory_submit — write new durable facts into the Agent提交区 inbox (the ONLY write path to canonical memory)\n- memory_status — show configuration and index health (vault path, FTS5 availability, pending inbox count)\n",
    "UI审美准则.md": "# UI审美准则\n\n> 界面与设计偏好。逐行一条。\n\n- 示例：dark theme preferred（示例）\n",
    "Codex-Claude-Hermes协作规则.md": "# Codex-Claude-Hermes协作规则\n\n> 多 Agent 协作约定（读写边界、提交格式）。逐行一条。\n\n- 示例：agents read canonical notes and write only to the inbox（示例）\n",
}

SUBMISSION_README = """# Agent提交区 — write inbox

All agents write new facts here as individual files:

    <agent>-<YYYYMMDD>-<HHMMSS>-<nn>.md

Format: one fact per line, optional "- " prefix. Example:

    - the build server listens on 127.0.0.1:8080

Rules:
- Never write plaintext credentials — only a label/path reference.
- Never edit other agents' files or canonical notes here.
- The promoter (python -m unified_memory.promoter) classifies, dedups,
  detects conflicts and appends to canonical notes; then files are archived
  into 已处理/.
"""


def find_template_dir() -> Path | None:
    env = os.environ.get("UNIFIED_MEMORY_TEMPLATE")
    if env:
        return Path(env)
    # Repository layout: <repo>/vault-template/50-Agent-Context
    here = Path(__file__).resolve()
    # Two levels deeper than the old memory.py (app/), so the parents shift
    # by one: [3] is <repo>, [4] the installed-package parent.
    for candidate in (here.parents[3] / "vault-template", here.parents[4] / "vault-template"):
        if (candidate / AGENT_CONTEXT).is_dir():
            return candidate
    return None


def _vault_as_read_back(vault: Path) -> str:
    """The value a reader gets from `vault: <path>` — mirrors common.parse_config.

    The config is hand-editable, so readers split the file into lines, cut each
    line at "#" (trailing comment) and strip surrounding quotes. Splitting is
    `str.splitlines()`, which also breaks on U+2028 and U+0085, so a path
    carrying one of those is stored as two lines and read back as the first
    half. The stored text is therefore not always the text that comes back.
    """
    first = f"vault: {vault}".splitlines()[0]
    line = first.split("#", 1)[0].strip()
    return line.partition(":")[2].strip().strip('"').strip("'")


def _reject_unrepresentable_vault(vault: Path) -> None:
    """Refuse a path the config readers would not read back.

    A vault under "notes #2" is stored and then resolved as "notes"; one named
    `notes'` loses its quote. Either way the next call quietly works on a
    different folder, so comparing what a reader would see with the path itself
    is the honest check — and it keeps holding if the reader rules change.
    """
    read_back = _vault_as_read_back(vault)
    if read_back != str(vault):
        raise SystemExit(
            f"unsupported vault path: {vault} would be read back as {read_back!r} from "
            f"~/.unified-memory.yaml (readers cut the value at '#' and strip quotes). "
            f"Move or rename the folder and retry."
        )


def init_vault(vault: Path, force: bool = False) -> None:
    vault = Path(vault)
    _reject_unrepresentable_vault(vault)
    ctx = vault / AGENT_CONTEXT
    if ctx.exists() and force:
        base = vault.with_name(vault.name + f"-backup-{time.strftime('%Y%m%d-%H%M%S')}")
        backup = base
        suffix = 2
        while backup.exists():
            backup = base.with_name(f"{base.name}-{suffix}")
            suffix += 1
        shutil.copytree(vault, backup)
    if ctx.exists() and not force:
        raise SystemExit(f"vault already initialized at {vault} (use --force to re-create)")

    template = find_template_dir()
    ctx.mkdir(parents=True, exist_ok=True)
    if template is not None:
        for item in (template / AGENT_CONTEXT).iterdir():
            target = ctx / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)
    else:
        for name, content in TEMPLATE_FILES.items():
            atomic_write(ctx / name, content)
        (ctx / "Agent提交区").mkdir(parents=True, exist_ok=True)
        (ctx / "Agent提交区" / "已处理").mkdir(parents=True, exist_ok=True)
        (ctx / "情境信息").mkdir(parents=True, exist_ok=True)
        (ctx / "记忆遗忘区").mkdir(parents=True, exist_ok=True)
        (ctx / "会话归档").mkdir(parents=True, exist_ok=True)
        atomic_write(ctx / "Agent提交区" / "README.md", SUBMISSION_README)
        atomic_write(
            ctx / "会话归档" / "README.md",
            "# 会话归档 — session archive\n\n"
            "Raw session history, one dated file per day.\n"
            "Written by integrations/hermes/archive_session.py.\n"
            "Never write plaintext credentials here.\n",
        )

    # Persist the vault path for later invocations.
    previous = _persist_vault(vault)

    print(f"vault initialized at {vault}")
    print(f"config written to {config_mod.default_path()}")
    # Repointing a working machine is a legitimate request (that is what
    # --vault means), but it must never be invisible: a silent overwrite is how
    # a one-off probe moved this laptop's vault to a temp dir that was then
    # deleted. Say what was replaced, and let the caller decide.
    if previous and Path(previous) != Path(vault):
        print(f"note: replaced the configured vault {previous} -> {vault}")
    print("next: copy integrations/AGENTS.md (Codex) and CLAUDE.md (Claude Code)")
    print("      into your agent home directories, or use the dsh plugin.")


def _persist_vault(vault: Path) -> str:
    """Write the `vault:` key without touching any other line; returns the old value.

    Line-preserving on purpose: the config is hand-editable and may carry
    comments and unrelated keys. The write itself goes through ``config``, the
    single writer, so it cannot race the digest toggle or a concurrent `use`.
    """
    # Resolve the path at CALL time. A module-level ``from ..config import
    # CONFIG_PATH`` freezes the value at import, so a test (or the isolation
    # guard) that rebinds infra.config.CONFIG_PATH afterwards would keep
    # writing the real ~/.unified-memory.yaml — the 2026-10-19 incident, which
    # this call shape exists to prevent.
    previous = parse_config(config_mod.default_path()).get("vault", "")
    config_mod.set_key("vault", str(vault), config_mod.default_path())
    return previous


def cmd_use(args: Namespace) -> None:
    """Point this machine at a vault that already exists, without writing into it.

    `init` is the wrong tool here: it refuses a vault that already has
    `50-Agent-Context`, and `--force` copies the template over the user's notes.
    Reusing a vault still has to persist `vault:`, because that key is what the
    reading tools and the PATH shim resolve without any environment variable.
    """
    vault = Path(args.vault).expanduser().resolve()
    _reject_unrepresentable_vault(vault)
    ctx = vault / AGENT_CONTEXT
    if not ctx.is_dir():
        raise SystemExit(
            f"not a memory vault: {ctx} is missing. "
            f'Run `memory init --vault "{vault}"` to create the structure first.'
        )
    index = ctx / CANONICAL_DOCS["index"]
    # A folder that merely carries the directory name is not a vault: every
    # reader resolves the index, so pointing `vault:` here reports success while
    # later calls read an empty memory. The plugin refuses this state before it
    # asks for consent; the CLI has to refuse the same thing.
    if not index.is_file():
        raise SystemExit(
            f"not a memory vault: {index} is missing, so {ctx} is only half-built. "
            f'Move or rename that folder, then run `memory init --vault "{vault}"`.'
        )
    previous = _persist_vault(vault)
    print(f"vault: {vault}")
    print(f"config written to {config_mod.default_path()}")
    if previous and Path(previous) != Path(vault):
        print(f"note: replaced the configured vault {previous} -> {vault}")


# --------------------------------------------------------------------------
# Local index (SQLite memory database, zero dependencies, privacy stays on
# this machine). All index logic lives in the store; these thin wrappers keep
# the legacy CLI/tests/remote-server call shapes stable.
# --------------------------------------------------------------------------


def update_index(vault: Path, verbose: bool = False) -> tuple[int, bool]:
    """Incrementally rebuild the memory database; returns (changed_docs, fts5_ok)."""
    result = store_update_index(vault, verbose=verbose)
    return result["changed_docs"], result["fts"]


def search_index(query: str, limit: int, vault: Path) -> dict:
    return store_fts_search(vault, query, limit)


def cmd_init(args: Namespace) -> None:
    init_vault(args.vault, force=args.force)


def cmd_status(args: Namespace) -> None:
    vault = resolve_vault()
    data: dict = {"vault": str(vault), "vaultEnv": os.environ.get(VAULT_ENV, ""), "config": str(config_mod.default_path())}
    if not getattr(args, "json", False):
        print(f"vault: {vault} (env {VAULT_ENV}={os.environ.get(VAULT_ENV, '')!r})")
        print(f"config: {config_mod.default_path()}")
    try:
        ensure_vault(vault)
        changed, fts_ok = update_index(vault)
        data["structure"] = "ok"
        data["index"] = {"path": str(index_db_for(vault)), "reindexed": changed, "fts5": fts_ok}
        if not getattr(args, "json", False):
            print("vault structure: ok")
            print(f"index: {index_db_for(vault)} (re-indexed {changed} file(s), fts5={'yes' if fts_ok else 'no'})")
        try:
            memories = memory_count(vault)
            embedded = vector_count(vault)
            data["memories"] = {"count": memories, "vectors": embedded, "embedConfigured": embed_mod.configured()}
            if not getattr(args, "json", False):
                print(f"memories: {memories} (vectors: {embedded}, embed configured: {'yes' if embed_mod.configured() else 'no'})")
        except Exception:  # noqa: BLE001 — status should never crash
            data["memories"] = None
            if not getattr(args, "json", False):
                print("memories: unavailable")
        inbox = canonical_dir(vault) / "Agent提交区"
        # README.md documents the inbox and 前缀登记.md registers submission
        # prefixes; neither is a submission.
        pending = (
            len([p for p in inbox.glob("*.md") if p.name not in NON_SUBMISSION_FILES])
            if inbox.is_dir()
            else 0
        )
        data["inboxPending"] = pending
        if not getattr(args, "json", False):
            print(f"inbox pending files: {pending}")
    except RuntimeError as exc:
        data["structure"] = f"MISSING: {exc}"
        if not getattr(args, "json", False):
            print(f"vault structure: MISSING ({exc})")
    if getattr(args, "json", False):
        emit_json("status", data)


def cmd_sync(args: Namespace) -> None:
    """Bring the derived index — and optionally the vectors — up to date.

    This is the maintenance half that used to run inside every hybrid search.
    Making it explicit keeps recall local and fast, while a write path (the
    promoter) or a schedule pays the network cost exactly once.
    """
    vault = resolve_vault()
    ensure_vault(vault)
    # Batch D7: the Claim Ledger backfill is default-enabled — one append-only
    # pass per vault, on the maintenance path, never inside a search.
    backfill_report = ensure_backfilled(vault)
    result = store_update_index(vault, verbose=False)
    changed = int(result.get("changed_docs", 0) or 0)
    limit = getattr(args, "limit", 400)
    if getattr(args, "no_embed", False):
        vectors = {"ok": True, "embedded": 0, "total": 0, "reason": "skipped (--no-embed)"}
    elif not embed_mod.configured():
        vectors = {"ok": False, "embedded": 0, "total": 0, "reason": "no SiliconFlow API key"}
    elif embed_mod.circuit_open():
        vectors = {"ok": False, "embedded": 0, "total": 0, "reason": "provider circuit is open — retry after the cooldown"}
    else:
        vectors = embed_mod.embed_missing(vault, limit=limit, update=False)
    if getattr(args, "json", False):
        emit_json(
            "sync",
            {
                "changed_docs": changed,
                "fts5": bool(result.get("fts")),
                "index": str(index_db_for(vault)),
                "vectors": vectors,
                "backfill": backfill_report,
            },
        )
        return
    print(f"index: {changed} document(s) changed, fts5={'yes' if result.get('fts') else 'no'}")
    if backfill_report is not None:
        print(f"backfill-ids: {backfill_report['lines']} line(s) in {backfill_report['docs']} note(s) [auto]")
    if vectors["ok"]:
        print(f"vectors: {vectors['embedded']} line(s) embedded ({vectors['reason'] or 'up to date'})")
    else:
        print(f"vectors: skipped — {vectors['reason']}")


def cmd_embed(args: Namespace) -> None:
    vault = resolve_vault()
    ensure_vault(vault)
    result = embed_mod.embed_missing(vault, limit=args.limit)
    if not result["ok"]:
        print(f"embed: {result['reason']}")
        raise SystemExit(1)
    print(f"embed: embedded {result['embedded']} memory line(s)")


def cmd_graph(args: Namespace) -> None:
    vault = resolve_vault()
    ensure_vault(vault)
    store_update_index(vault)
    stats = graph_mod.graph_stats(vault)
    print(f"graph: {stats['nodes']} concept node(s), {stats['edges']} edge(s)")
