# -*- coding: utf-8 -*-
"""Conflict detection: char-bigram similarity + pending/adjudicated queues.

Rule (same as the vault's coordination convention):
  - similarity >= 0.9 and identical text  -> duplicate (skip silently)
  - similarity >= 0.5 but different value -> conflict (goes to the pending
    queue for human adjudication; canonical keeps the old value meanwhile)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from .common import (
    ADJUDICATED_FILE,
    CONFLICT_FILE,
    atomic_write,
    file_lock,
    read_maybe,
    situation_dir,
)


def char_bigrams(text: str) -> set[tuple[str, str]]:
    text = text.strip()
    return {(text[i], text[i + 1]) for i in range(len(text) - 1)}


def similarity(a: str, b: str) -> float:
    """Jaccard-style overlap of char-bigram sets, 0.0 .. 1.0."""
    ba, bb = char_bigrams(a), char_bigrams(b)
    if not ba and not bb:
        return 1.0 if a == b else 0.0
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / max(len(ba), len(bb))


CONFLICT_SIM_THRESHOLD = 0.5


def classify_against(new_fact: str, existing_lines: list[str]) -> tuple[str, str | None]:
    """Return ('duplicate'|'conflict'|'new', existing_line_or_None).

    Only an exact (whitespace-normalized) match is a duplicate. A similar-but-
    different fact is a CONFLICT for human adjudication — the conservative
    choice, since similar wording with a different value is usually a state
    change or a contradiction.
    """
    for line in existing_lines:
        bare = line.strip()
        if new_fact.strip() == bare:
            return ("duplicate", line)
        if similarity(new_fact, bare) >= CONFLICT_SIM_THRESHOLD:
            return ("conflict", line)
    return ("new", None)


# --------------------------------------------------------------------------
# Pending conflict queue (情境信息/事实冲突待裁决.md)
# --------------------------------------------------------------------------


def append_conflict(vault: Path, new_fact: str, existing_line: str, source: str, target_file: str = "") -> None:
    """Queue one conflict; never touches canonical notes."""
    path = situation_dir(vault) / CONFLICT_FILE
    fields = {"新": new_fact, "旧": existing_line, "来源": source}
    if target_file:
        fields["目标"] = target_file
    with file_lock(vault):
        if not path.exists():
            atomic_write(
                path,
                "# 事实冲突待裁决\n\n"
                "> 新提交事实与 canonical 既有行高度相似但值不同。裁决命令：\n"
                "> \"python -m unified_memory.promoter adjudicate\"（交互式）。\n\n",
            )
        if fields in read_conflicts(vault):
            return
        entry = "- [ ] 冲突 " + json.dumps(fields, ensure_ascii=False, separators=(",", ":")) + "\n"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(entry)


def read_conflicts(vault: Path) -> list[dict]:
    path = situation_dir(vault) / CONFLICT_FILE
    entries = []
    for raw in read_maybe(path).splitlines():
        line = raw.strip()
        if not line.startswith("- [ ] 冲突"):
            continue
        body = line[len("- [ ] 冲突"):].strip()
        if body.startswith("{"):
            try:
                fields = json.loads(body)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(fields, dict):
                entries.append({str(key): str(value) for key, value in fields.items()})
            continue
        body = body.lstrip("｜")
        fields: dict[str, str] = {}
        for part in body.split("｜"):
            key, _, value = part.partition("：")
            if key and value:
                fields[key.strip()] = value.strip()
        entries.append(fields)
    return entries


def remove_conflict(vault: Path, entry: dict, *, locked: bool = False) -> None:
    if not locked:
        with file_lock(vault):
            remove_conflict(vault, entry, locked=True)
        return
    path = situation_dir(vault) / CONFLICT_FILE
    lines = []
    removed = False
    for line in read_maybe(path).splitlines():
        if not removed and line.strip().startswith("- [ ] 冲突"):
            body = line.strip()[len("- [ ] 冲突"):].strip()
            try:
                parsed = json.loads(body) if body.startswith("{") else None
            except (json.JSONDecodeError, TypeError):
                parsed = None
            if isinstance(parsed, dict) and parsed == entry:
                removed = True
                continue
            if parsed is None and entry.get("新", "") and f"｜新：{entry['新']}｜" in line:
                removed = True
                continue
        lines.append(line)
    atomic_write(path, "\n".join(lines) + ("\n" if lines else ""))


def record_adjudication(vault: Path, entry: dict, decision: str, *, locked: bool = False) -> None:
    if not locked:
        with file_lock(vault):
            record_adjudication(vault, entry, decision, locked=True)
        return
    path = situation_dir(vault) / ADJUDICATED_FILE
    if not path.exists():
        atomic_write(
            path,
            "# 事实冲突已裁决\n\n"
            "> 裁决记录（decision ∈ 用新 / 保留旧 / 并存 / 跳过）。\n\n",
        )
    stamp = time.strftime("%Y-%m-%d %H:%M")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"- {stamp}｜裁决：{decision}｜新：{entry.get('新', '')}｜旧：{entry.get('旧', '')}\n")
