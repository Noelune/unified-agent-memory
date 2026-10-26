# -*- coding: utf-8 -*-
"""build_golden — derive labeled retrieval queries from a vault copy.

Labels are DERIVED, not hand-verified: a query is a distinctive token or CJK
substring of one active fact line, so the relevant document is known by
construction. This makes the set self-supervised and reproducible; its
limitation (documented in the batch A report) is that queries are lexical,
close to the source line.

Usage: python bench/build_golden.py --vault <path> [--out bench/golden-real.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))

from unified_memory import index  # noqa: E402

_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "have", "must",
    "users", "user", "写入", "来源", "agent", "commit", "md",
}
_ASCII = re.compile(r"[A-Za-z][A-Za-z0-9_.\-]{3,}")
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}")
_MAX_PER_DOC = 10
_MAX_TOTAL = 60
_ABSTAIN = [
    "量子色动力学的耦合常数",
    "用户的小学班主任叫什么",
    "巴西利亚的年平均降雨量",
    "1943 年的诺曼底登陆日期",
    "斐波那契数列第 88 项",
]


def _queries_from_line(bare: str) -> list[str]:
    out: list[str] = []
    for word in _ASCII.findall(bare):
        low = word.lower()
        if low not in _STOP and not low[0].isdigit():
            out.append(low)
            break
    runs = _CJK.findall(bare)
    if runs:
        run = runs[0]
        if len(run) >= 3:
            out.append(run[1:3])  # skip the most generic leading bigram
        elif len(run) == 2:
            out.append(run)
    return out


def build(vault: Path) -> list[dict]:
    items: list[dict] = []
    per_doc: dict[str, int] = {}
    seen_queries: set[str] = set()
    for path in index.indexed_files(vault):
        text = path.read_text(encoding="utf-8", errors="replace")
        for status, bare, _raw in index._doc_lines(text):
            if status != "active" or len(items) >= _MAX_TOTAL:
                continue
            if per_doc.get(path.name, 0) >= _MAX_PER_DOC:
                continue
            for query in _queries_from_line(bare):
                if query in seen_queries:
                    continue
                seen_queries.add(query)
                items.append(
                    {"query": query, "docs": [path.name], "category": "derived"}
                )
                per_doc[path.name] = per_doc.get(path.name, 0) + 1
                break
    for query in _ABSTAIN:
        items.append({"query": query, "expect_empty": True, "category": "abstain"})
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--out", default=str(ROOT / "bench" / "golden-real.json"))
    args = parser.parse_args()
    items = build(Path(args.vault))
    Path(args.out).write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "method": "derived from active fact lines (self-supervised); "
                "labels are by construction, not hand-verified",
                "items": items,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"golden: {len(items)} queries -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
