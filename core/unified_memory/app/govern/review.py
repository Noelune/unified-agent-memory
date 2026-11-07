# -*- coding: utf-8 -*-
"""review — scan the inbox, classify each fact, and stage a pending list.

Read-only until `write_pending_list` is called: `review` decides for every
submitted fact whether it duplicates something already canonical, contradicts
it (conflict queue), supersedes it (取代 entry), or is simply new, and returns
that verdict as data. `promote`/`apply_pending` then execute it.

Split out of promoter.py in B5.4 (the file was 1000+ lines and every command
paid for all of it).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from ...domain.conflict import best_similarity, classify_against, similarity
from ...domain.facts import SUPERSESSION_RE, active_fact_lines
from ...domain.markdown import bare_fact_line, fact_lines, redact
from ...domain.policy import (
    ADJUDICATED_FILE,
    CANONICAL_DOCS,
    NON_SUBMISSION_FILES,
    PENDING_FILE,
    UNCLASSIFIED_FACT_REL,
)
from ...infra.store import lexical_search, update_index
from ...infra.vault import (
    atomic_write,
    canonical_dir,
    canonical_path,
    ensure_vault,
    read_maybe,
    situation_dir,
)
from .queue import append_conflict


CATEGORY_RULES: list[tuple[str, re.Pattern, str]] = [
    ("ui", re.compile(r"\bui\b|user interface|interface|design|theme|color|aesthetic|layout|style|dashboard|界面|设计|审美|主题|颜色|布局|风格", re.I), "ui"),
    ("rules", re.compile(r"rule|workflow|process|policy|must|should|always|never|verify|audit|rollback|deploy|red line|红线|规则|必须|验证|审计|回滚|部署|流程|步骤", re.I), "rules"),
    ("prefs", re.compile(r"prefer|like|dislike|default|language|format|tone|writing|偏好|喜欢|希望|语言|格式|语气|风格", re.I), "prefs"),
    ("env", re.compile(r"path|directory|install|version|environment|config|port|server|model|provider|endpoint|host|url|account|backup|cache|storage|home|路径|目录|端口|服务器|服务|环境|安装|版本|地址|配置|账号|依赖|工具版本", re.I), "env"),
    ("tools", re.compile(r"tool|available|broken|status|doctor|install|uninstall|health|工具|插件|状态|健康|排查", re.I), "tools"),
    ("coord", re.compile(r"coordinat|collaborat|agent|relay|handoff|ownership|boundary|inbox|协作|代理|边界|共享|隔离|提交|relay", re.I), "coord"),
]


UNCLASSIFIED_TARGET = UNCLASSIFIED_FACT_REL


UNCLASSIFIED_DOC = UNCLASSIFIED_FACT_REL


def classify(fact: str) -> str:
    for _name, pattern, doc_id in CATEGORY_RULES:
        if pattern.search(fact):
            return doc_id
    return "other"


def target_path(vault: Path, doc_id: str) -> Path:
    if doc_id == "other" or doc_id not in CANONICAL_DOCS:
        # Unknown category (an old pending list, a hand-edited entry): keep the
        # fact instead of failing the whole apply with a KeyError.
        return situation_dir(vault) / "未归类事实.md"
    return canonical_path(vault, doc_id)


def _cross_doc_hit(vault: Path, fact: str, target: Path) -> tuple[str, str] | None:
    """Find an ACTIVE line in another note that contradicts ``fact``.

    The target-note comparison cannot see a contradiction that lives in a
    different canonical note: "同步端口为 9443" classified into env while the
    old "同步端口为 8443" sat in rules was invisible forever (batch-A audit).
    A cheap lexical recall (top-20 per stream, same streams the search path
    uses) fetches candidates across the whole corpus; the SAME subject/value
    rules as the target comparison decide whether a candidate is a genuine
    contradiction. Exact matches are not conflicts — two notes holding the
    same sentence is allowed, each keeping its provenance (occurrence
    identity); they are simply not queued.

    Returns (candidate_doc_name, candidate_line) or None.
    """
    candidates: dict[str, str] = {}
    try:
        rows = lexical_search(vault, fact, limit=20)
    except Exception:  # noqa: BLE001 — a broken stream must not stop review
        rows = []
    for row in rows:
        if row["doc"] != str(target) and row["line"] != fact:
            candidates.setdefault(row["line"], Path(row["doc"]).name)
    for line, doc_name in candidates.items():
        status, _hit = classify_against(fact, [line])
        if status == "conflict":
            return doc_name, line
    return None


def _best_overlap(fact: str, existing: list[str], min_sim: float) -> str | None:
    """Return the existing line with the highest similarity ≥ min_sim (or None)."""
    sim, line = best_similarity(fact, existing)
    return line if sim >= min_sim else None


def _digest_source(text: str) -> str:
    """The provenance origin a digest file carries (3A), "" for plain submits.

    `_write_digest_facts` stamps every digest artifact with a one-line
    ``<!-- digest-source: … -->`` header; review reads it back so the origin
    survives promotion on the fact line itself.
    """
    for raw in text.splitlines():
        line = raw.strip().lstrip("﻿")
        if line.startswith("<!-- digest-source: ") and line.endswith(" -->"):
            return line[len("<!-- digest-source: "):-len(" -->")].strip()
        if line and not line.startswith("<!--"):
            break  # past the header zone — plain submission file
    return ""


def _entry(
    vault: Path,
    clean: str,
    doc_id: str,
    target: Path,
    src_name: str,
    supersede: str | None = None,
    origin: str = "",
) -> dict:
    """Build a pending-list entry (shared by pending and supersede kinds)."""
    entry = {
        "fact": clean,
        "doc": doc_id,
        "target": str(target.relative_to(vault)) if target.is_relative_to(vault) else str(target),
        "source": src_name,
    }
    if supersede is not None:
        entry["supersede"] = supersede
    if origin:
        entry["溯源"] = origin
    return entry


def _verdict(
    vault: Path,
    clean: str,
    src_name: str,
    adjudicated: set[str],
    existing_cache: dict[Path, list[str]],
    origin: str = "",
) -> tuple[str, dict | None]:
    """Decide one submitted fact and do the queue I/O it needs.

    Returns (kind, entry). kind ∈ settled | duplicate | supersede | conflict |
    cross | pending; entry is the pending-list entry for supersede/pending and
    None otherwise. Queue writes (append_conflict) happen here, exactly where
    the inline loop did them — same module, same layer, same order. ``origin``
    is the file's digest provenance (3A), attached to every entry it yields.
    """
    if bare_fact_line(f"- {clean}") in adjudicated:
        # A human already ruled on this fact; honouring the adjudication log
        # is what makes adjudication final (see _adjudicated_facts).
        return "settled", None
    doc_id = classify(clean)
    target = target_path(vault, doc_id)
    # Canonical notes do not change during a review pass, so parse each target
    # once instead of once per submitted fact. On a large inbox that turns an
    # O(facts × lines) file-read loop into one read per note.
    #
    # Only *active* facts are compared. Reading the whole note made history
    # indistinguishable from truth: once an old value moved under 已取代 it
    # stayed in the pool, so the replacement that had just superseded it was
    # reported as a fresh conflict on every run.
    if target not in existing_cache:
        existing_cache[target] = active_fact_lines(
            read_maybe(target), drop_examples=True
        )
    existing = existing_cache[target]
    status, hit = classify_against(clean, existing)
    if status == "duplicate":
        return "duplicate", None
    if status == "conflict":
        if hit and SUPERSESSION_RE.search(clean):
            # Replacement cue: keep both in history, mark old superseded.
            return "supersede", _entry(vault, clean, doc_id, target, src_name, supersede=hit, origin=origin)
        append_conflict(vault, clean, hit or "", src_name, doc_id)
        return "conflict", None
    # Below the conflict threshold, a replacement cue with a looser
    # topic overlap still supersedes (e.g. "端口已改为 9090" vs "端口为 8080").
    if SUPERSESSION_RE.search(clean):
        topic_hit = _best_overlap(clean, existing, min_sim=0.3)
        if topic_hit:
            return "supersede", _entry(vault, clean, doc_id, target, src_name, supersede=topic_hit, origin=origin)
    # Contradictions living in ANOTHER note are invisible to the
    # target-note comparison above; recall candidates corpus-wide and
    # apply the same subject/value rules before queueing.
    cross = _cross_doc_hit(vault, clean, target)
    if cross is not None:
        append_conflict(vault, clean, cross[1], src_name, doc_id, cross_doc=cross[0])
        return "cross", None
    return "pending", _entry(vault, clean, doc_id, target, src_name, origin=origin)


def _print_review(result: dict) -> None:
    """Print the human summary; data comes from the result dict, bytes unchanged."""
    pending = result["pending"]
    duplicates = result["duplicates"]
    conflicts = result["conflicts"]
    cross_conflicts = result["cross_conflicts"]
    supersessions = result["supersessions"]
    settled = result["adjudicated"]
    settled_note = f", {settled} already adjudicated" if settled else ""
    cross_note = f", {cross_conflicts} cross-doc" if cross_conflicts else ""
    print(
        f"review: {len(pending)} pending, {duplicates} duplicate(s), "
        f"{conflicts} conflict(s){cross_note}, {supersessions} supersession(s){settled_note}"
    )
    for p in pending:
        mark = f" [取代→{p['supersede'][:40]}]" if p.get("supersede") else ""
        print(f"  -> {p['doc']:6s} | {p['fact'][:60]}{mark}")


def review(vault: Path, verbose: bool = True, only: set[str] | None = None) -> dict:
    """Build the pending list.

    ``only`` restricts the pass to a set of inbox file names. It exists so the
    panel can accept ONE submission: the queue is a list of independent
    decisions, and a per-row 收录 that quietly promoted every other row would be
    the same lie as a per-row 不采纳 that emptied the whole inbox.
    """
    ensure_vault(vault)
    inbox = canonical_dir(vault) / "Agent提交区"
    if not inbox.is_dir():
        raise SystemExit(f"inbox missing at {inbox} — run \"memory init --vault <path>\"")
    # The cross-document pass reads the derived index; a stale index would
    # miss candidates that a just-written note holds. Incremental and cheap.
    update_index(vault)
    pending: list[dict] = []
    duplicates = conflicts = cross_conflicts = supersessions = settled = 0
    conflicted_sources: set[str] = set()
    source_files: set[str] = set()
    # Conflicts a human already ruled on (why this matters: see _verdict).
    adjudicated = _adjudicated_facts(vault)
    existing_cache: dict[Path, list[str]] = {}
    for src in sorted(inbox.glob("*.md")):
        if src.name in NON_SUBMISSION_FILES or (only is not None and src.name not in only):
            continue
        source_files.add(src.name)
        text = src.read_text(encoding="utf-8", errors="replace")
        origin = _digest_source(text)
        for fact in fact_lines(text):
            clean = redact(fact.strip())
            kind, entry = _verdict(vault, clean, src.name, adjudicated, existing_cache, origin=origin)
            if kind == "settled":
                settled += 1
            elif kind == "duplicate":
                duplicates += 1
            elif kind == "supersede":
                supersessions += 1
                pending.append(entry)
            elif kind == "conflict":
                conflicts += 1
                conflicted_sources.add(src.name)
            elif kind == "cross":
                conflicts += 1
                cross_conflicts += 1
                conflicted_sources.add(src.name)
            else:
                pending.append(entry)
    result = {
        "pending": pending,
        "duplicates": duplicates,
        "conflicts": conflicts,
        "cross_conflicts": cross_conflicts,
        "supersessions": supersessions,
        "adjudicated": settled,
        "source_files": source_files,
        "conflicted_sources": conflicted_sources,
    }
    if verbose:
        _print_review(result)
    return result


def _adjudicated_facts(vault: Path) -> set[str]:
    """Bare text of every new fact a human has already ruled on.

    Read straight from ``情境信息/事实冲突已裁决.md``, which is written in two
    shapes for the same reason the pending queue is (see `conflict.py`):

      core     ``- <stamp>｜裁决：<choice>｜新：<fact>｜旧：<old>``
      Hermes   ``## <stamp> 裁决 #<n>（…）`` + ``- **新提交**：<fact>``

    Only the first was recognised, so on a vault whose log was written by the
    other runtime every past decision was invisible — and a conflict the human
    had already settled came back on the next pass, forever. Unparseable lines
    are skipped rather than fatal: the file is user-visible and hand-editable.
    """
    path = situation_dir(vault) / ADJUDICATED_FILE
    if not path.is_file():
        return set()
    facts: set[str] = set()
    for raw in read_maybe(path).splitlines():
        line = raw.strip()
        # Both shapes are bullets. Requiring the bullet matters because the
        # reason for a verdict is now appended underneath it as free text, and
        # `record_adjudication` only guarantees the verdict line is parseable —
        # a reason that happens to quote `｜新：` would otherwise be read back as
        # a fact that was never ruled on, and re-queued as new.
        if not line.startswith("-"):
            continue
        new = ""
        if "｜新：" in line:
            new = line.split("｜新：", 1)[1].split("｜旧：", 1)[0].strip()
        else:
            # `- 新提交：…` / `- **新提交**：…`
            match = re.match(r"^-\s*\**\s*新提交\s*\**\s*[：:]\s*(.*)$", line)
            if match:
                new = match.group(1).strip()
        if not new:
            continue
        bare = bare_fact_line(f"- {new}")
        if bare:
            facts.add(bare)
    return facts


def write_pending_list(vault: Path, result: dict) -> None:
    path = situation_dir(vault) / PENDING_FILE
    lines = [
        "# 待晋升清单",
        "",
        f"> 生成于 {time.strftime('%Y-%m-%d %H:%M')}。运行 \"python -m unified_memory.promoter --apply\" 晋升；",
        "> 或 \"--auto\" 一步完成（需显式开启）。",
        "<!-- sources: " + json.dumps(sorted(result["source_files"]), ensure_ascii=False) + " -->",
        "",
    ]
    if not result["pending"]:
        lines.append("_无待晋升事实。_")
    for i, p in enumerate(result["pending"], 1):
        extra = f"｜取代:{p['supersede']}" if p.get("supersede") else ""
        origin = f"｜溯源:{p['溯源']}" if p.get("溯源") else ""
        lines.append(f"- [ ] {i}. 分类:{p['doc']}｜目标:{p['target']}｜来源:{p['source']}{extra}{origin}｜内容:{p['fact']}")
    lines.append("")
    atomic_write(path, "\n".join(lines))
    return path


def pending_sources(vault: Path, entries: list[dict]) -> set[str]:
    """Return the review snapshot's source files, with legacy-list fallback."""
    for raw in read_maybe(situation_dir(vault) / PENDING_FILE).splitlines():
        line = raw.strip()
        if not (line.startswith("<!-- sources: ") and line.endswith(" -->")):
            continue
        try:
            values = json.loads(line[len("<!-- sources: "):-len(" -->")])
        except json.JSONDecodeError:
            break
        if isinstance(values, list) and all(isinstance(value, str) for value in values):
            return set(values)
        break
    return {entry.get("来源", "") for entry in entries}


def parse_pending_list(vault: Path) -> list[dict]:
    path = situation_dir(vault) / PENDING_FILE
    entries = []
    for raw in read_maybe(path).splitlines():
        line = raw.strip()
        m = re.match(r"^- \[ \]\s*\d+\.\s+(分类:.*)$", line)
        if not m:
            continue
        fields: dict[str, str] = {}
        payload = m.group(1)
        markers = [(key, payload.find(key + ":")) for key in ("分类", "目标", "来源", "取代", "溯源", "内容")]
        markers = [(key, pos) for key, pos in markers if pos >= 0]
        for key, pos in markers:
            end = min((other for _, other in markers if other > pos), default=len(payload))
            fields[key] = payload[pos + len(key) + 1:end].rstrip("｜ ")
        entries.append(fields)
    return entries
