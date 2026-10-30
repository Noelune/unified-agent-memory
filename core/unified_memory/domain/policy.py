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

# Durable topics the forgetter never demotes (batch C2). An EXPLICIT whitelist
# replaces the old broad keyword net: that regex matched 75.5% of the live
# vault's facts (every line mentioning a path/config/model/backup/tool), which
# made forgetting a no-op. Only these classes stay immune — credentials, red
# lines, the endpoint facts others rely on, and agent coordination:
PROTECTED_TOPICS = (
    # credentials — never fade
    "密码", "密钥", "凭据", "口令", "账号", "账户",
    "password", "secret", "credential",
    # red lines — never fade
    "红线",
    # endpoints other agents rely on (pinned by test_forgetter)
    "服务器", "端口", "地址", "server", "port", "endpoint",
    # agent coordination
    "协作", "代理", "coordinat",
)

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


# --------------------------------------------------------------------------
# Memory types & salience (moved verbatim from index.py, B2 — pure policy).
# Borrowed from rohitg00/agentmemory's salience ordering:
# architecture > preference > pattern > bug > workflow > fact.
# --------------------------------------------------------------------------

MEMORY_TYPES = ("architecture", "preference", "pattern", "bug", "workflow", "fact", "other")

SALIENCE: dict[str, float] = {
    "architecture": 0.9,
    "preference": 0.85,
    "pattern": 0.8,
    "bug": 0.7,
    "workflow": 0.6,
    "fact": 0.5,
    "other": 0.4,
}

# Keyword → memory type (best-effort, rule-based, no LLM).
TYPE_RULES: list[tuple[str, re.Pattern]] = [
    ("preference", re.compile(r"prefer|like|dislike|favor|default|language|format|tone|语气|偏好|喜欢|希望|不要|审美|风格|style", re.I)),
    ("architecture", re.compile(r"architecture|architect|微服务|服务架构|模块|组件|依赖|refactor|重构|迁移|migrate|database|db|schema|接口|api design|设计|技术决策|decid|方案", re.I)),
    ("bug", re.compile(r"bug|fix|fixed|issue|error|错误|报错|踩坑|失败|fail|workaround|绕开|故障|异常|exception|crash|崩溃", re.I)),
    ("workflow", re.compile(r"workflow|process|step|步骤|流程|rule|规则|必须|must|always|never|验证|verify|deploy|发布|backup|备份|checklist|清单|red line|红线", re.I)),
    ("pattern", re.compile(r"pattern|模式|习惯|通常|typically|usually|always|惯例|convention|best practice|最佳实践|模板|template", re.I)),
    ("fact", re.compile(r"path|路径|version|版本|install|安装|port|端口|server|服务器|host|地址|url|endpoint|account|账号|config|配置|工具|tool|环境|env|credential|凭据|location|位于", re.I)),
]


def classify_type(fact: str) -> str:
    """Classify a bare fact line into a memory type by keyword rules."""
    for name, pattern in TYPE_RULES:
        if pattern.search(fact):
            return name
    return "other"


def salience_for(mem_type: str) -> float:
    return SALIENCE.get(mem_type, 0.5)
