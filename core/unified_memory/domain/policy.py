# -*- coding: utf-8 -*-
"""Vault layout policy: canonical documents, folder names, submission rules.

Moved verbatim from common.py (B1). Pure data + one filename predicate; the
paths themselves are built by infra.vault on top of these constants.
"""
from __future__ import annotations

import re
from pathlib import Path

AGENT_CONTEXT = "50-Agent-Context"

# Canonical documents: stable ids (used by `memory show <id>`) -> file names.
# Names match the live vault's 50-Agent-Context layout (对齐真实 vault 文件名).
CANONICAL_DOCS = {
    "index": "上下文索引.md",
    "prefs": "我的偏好摘要.md",
    "env": "常用路径与环境.md",
    "rules": "工程执行规则.md",
    "tools": "工具可用性检查.md",
    "ui": "UI审美准则.md",
    "coord": "Codex-Claude-Hermes协作规则.md",
}

SUBMISSION_DIR = "Agent提交区"
PROCESSED_DIR = "已处理"

# Files that live in the submission directory but are NOT submissions.
#
#   README.md      documents the directory.
#   前缀登记.md    the prefix registry that `memory_setup` and the upgrade flow
#                 merge into (src/upgrade-run.ts). A bookkeeping table, never a
#                 batch of facts.
#
# Every inbox reader used to hard-code `name != "README.md"`, and that is exactly
# how the registry became a phantom pending item: the panel listed it under
# 待确认, `status` counted it, the doctor reported "1 inbox file". There was
# nothing to confirm — the file is the plugin's own note to itself.
#
# The consequences were not merely cosmetic. `promote --review` reads every
# unmasked `*.md` as fact lines, so it would have ingested the table rows as
# memories; `dismiss` (the panel's 归档) moves the file into 已处理/, where the
# next upgrade cannot merge it and recreates it with only this runtime's row —
# silently dropping every other runtime's registrations, which the merge exists
# to preserve. One constant, checked at every reader, is what keeps those three
# paths consistent.
NON_SUBMISSION_FILES = frozenset({"README.md", "前缀登记.md"})

SITUATION_DIR = "情境信息"
PENDING_FILE = "待晋升.md"
CONFLICT_FILE = "事实冲突待裁决.md"
ADJUDICATED_FILE = "事实冲突已裁决.md"
# The one note under 情境信息/ that holds facts rather than workflow state.
# Written by promoter's `other` fallback; indexed by index.indexed_files().
UNCLASSIFIED_FACT_REL = "情境信息/未归类事实.md"
FORGET_DIR = "记忆遗忘区"
SESSION_DIR = "会话归档"

# The env var that overrides config-file vault resolution (kept next to the
# layout constants because both the config reader and `ensure_vault`'s error
# text name it; B1 moved it here from common.py so infra.config and
# infra.vault can share it without importing each other).
VAULT_ENV = "UNIFIED_MEMORY_VAULT"

# Sync clients (OneDrive, Dropbox, iCloud) create a second file instead of
# merging when two machines edit the same note. Those copies are not canonical
# notes: indexing them makes every fact appear twice with different "truth",
# and the promoter may then classify conflicts against the copy. Detect the
# common naming schemes and keep them out of the derived index. The user still
# sees the files in Obsidian and can decide which copy wins.
CONFLICT_COPY_RE = re.compile(
    r"(?:[ _]\d+\.md$"                       # "note 2.md" / "note_2.md"
    r"|[（(]\d+[)）]\.md$"                    # "note(2).md"
    r"|[-_ ](?:副本|冲突副本|copy)\.md$"       # "note-副本.md"
    r"|(?:conflicted copy|冲突副本)[^/]*\.md$)",  # "note (conflicted copy).md"
    re.I,
)


def is_conflict_copy(name: str) -> bool:
    """True for a sync-client conflict copy, never for a normal dated note."""
    return bool(CONFLICT_COPY_RE.search(Path(name).name))
