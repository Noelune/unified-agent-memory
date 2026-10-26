# -*- coding: utf-8 -*-
"""golden_fixture — a deterministic fixture vault + hand-labeled golden queries.

The fixture vault is rebuilt from the literals below on every run, so its
labels never rot with the live vault. Categories that need controlled state
(update / abstention / cross-doc / synonym) live here; categories that need
real data volume (exact word / CJK substring) are derived from a vault copy
by build_golden.py instead.
"""
from __future__ import annotations

from pathlib import Path

NOTES: dict[str, str] = {
    "工程执行规则.md": (
        "# 工程执行规则\n\n"
        "- 构建产物必须经过 typecheck 才能合并。（写入 2026-01-01｜来源：Agent提交区/alice-20260101-01.md）\n"
        "- 发布前必须跑完整回归测试。（写入 2026-01-02｜来源：Agent提交区/alice-20260102-01.md）\n"
        "- 统一记忆系统的晋升时间是每天 03:00。（写入 2026-01-03｜来源：Agent提交区/alice-20260103-01.md）\n"
        "\n## 已取代\n\n"
        "- 部署脚本放在 scripts/deploy-old.sh（写入 2025-12-01｜来源：Agent提交区/alice-20251201-01.md）\n"
    ),
    "常用路径与环境.md": (
        "# 常用路径与环境\n\n"
        "- 生产服务器地址是 203.0.113.10（写入 2026-02-01｜来源：Agent提交区/bob-20260201-01.md）\n"
        "- 备份目录是 D:/backups/uam（写入 2026-02-02｜来源：Agent提交区/bob-20260202-01.md）\n"
        "- 同步端口为 9443（写入 2026-03-01｜来源：Agent提交区/bob-20260301-01.md）\n"
        "- 默认模型是 GLM-5.3（写入 2026-02-03｜来源：Agent提交区/bob-20260203-01.md）\n"
        "- 统一记忆系统的索引库在 ~/.unified-memory。（写入 2026-02-04｜来源：Agent提交区/bob-20260204-01.md）\n"
        "\n## 已取代\n\n"
        "- 同步端口为 8443（写入 2026-01-15｜来源：Agent提交区/bob-20260115-01.md）\n"
    ),
    "我的偏好摘要.md": (
        "# 我的偏好摘要\n\n"
        "- 用户偏好简洁的结论先行回答。（写入 2026-01-05｜来源：Agent提交区/carol-20260105-01.md）\n"
        "- 用户不喜欢回答里堆砌术语。（写入 2026-01-06｜来源：Agent提交区/carol-20260106-01.md）\n"
    ),
}

# Each item: query, expected docs (Recall), optional must-contain (top-1 line
# must contain it), optional expect_empty. Category names are stable keys.
GOLDEN: list[dict] = [
    {"query": "typecheck", "docs": ["工程执行规则.md"], "category": "exact"},
    {"query": "203.0.113.10", "docs": ["常用路径与环境.md"], "category": "exact"},
    {"query": "backups", "docs": ["常用路径与环境.md"], "category": "exact"},
    {"query": "备份目录", "docs": ["常用路径与环境.md"], "category": "cjk_substring"},
    {"query": "结论先行", "docs": ["我的偏好摘要.md"], "category": "cjk_substring"},
    {"query": "回归测试", "docs": ["工程执行规则.md"], "category": "cjk_substring"},
    {"query": "怎么部署上线", "docs": ["工程执行规则.md"], "category": "paraphrase"},
    {"query": "回答风格上有什么要求", "docs": ["我的偏好摘要.md"], "category": "paraphrase"},
    {"query": "同步端口", "docs": ["常用路径与环境.md"], "category": "update",
     "must_contain": "9443"},
    {"query": "部署脚本放在哪里", "expect_empty": True, "category": "update"},
    {"query": "统一记忆系统", "docs": ["工程执行规则.md", "常用路径与环境.md"],
     "category": "cross_doc"},
    {"query": "备份路径", "docs": ["常用路径与环境.md"], "category": "synonym"},
    {"query": "主模型", "docs": ["常用路径与环境.md"], "category": "synonym"},
    {"query": "量子色动力学的耦合常数是多少", "expect_empty": True, "category": "abstain"},
    {"query": "用户的小学班主任叫什么", "expect_empty": True, "category": "abstain"},
    {"query": "巴西利亚的年平均降雨量", "expect_empty": True, "category": "abstain"},
]


def build_fixture_vault(root: Path) -> Path:
    """Write the fixture vault; returns the vault root."""
    ctx = root / "50-Agent-Context"
    ctx.mkdir(parents=True, exist_ok=True)
    for name, text in NOTES.items():
        (ctx / name).write_text(text, encoding="utf-8")
    return root
