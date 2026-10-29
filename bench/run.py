# -*- coding: utf-8 -*-
"""run — deterministic retrieval benchmark for the golden sets.

Two passes per invocation:

  offline  `embed.embed_query_cached` is patched to return None, so ranking is
           fully deterministic and network-free. All quality metrics come from
           this pass.
  latency  the real embed path (network) runs with a 0.12s/0.8s budget —
           wall-clock p50/p95 come from here and are inherently noisy; they
           gate the hot-path budget, not the ranking.

Usage:
    python bench/run.py --vault <real vault> --out bench/baseline-v0.json [--latency]
    python bench/run.py --fixture-only --out bench/fixture-check.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))
sys.path.insert(0, str(ROOT / "bench"))

import golden_fixture  # noqa: E402

from unified_memory import index, search  # noqa: E402
from unified_memory import memory as memory_mod  # noqa: E402


def copy_vault_to_temp(src: Path, dst: Path) -> Path:
    """Copy <src>/50-Agent-Context into an empty temp vault; never writes src."""
    (dst / "50-Agent-Context").mkdir(parents=True)
    for item in (src / "50-Agent-Context").iterdir():
        target = dst / "50-Agent-Context" / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    return dst


def _pin_state(tmp_root: Path, name: str) -> None:
    """Keep this pass's index database and journal inside the temp root.

    The vault is already a temp copy, but the index DB and the write-ahead
    journal both default to the user's real ``~/.unified-memory/``. Without
    this pin every ``--fixture-only`` verification left an ``index-<hash>.db``
    in the developer's profile. One DB per pass, so the fixture rows can never
    bleed into the real-vault pass.
    """
    memory_mod.INDEX_DB = tmp_root / f"index-{name}.db"
    os.environ["UNIFIED_MEMORY_INDEX_DB"] = str(memory_mod.INDEX_DB)
    os.environ["UNIFIED_MEMORY_JOURNAL_DIR"] = str(tmp_root / "journal")


def _patch_embed_off() -> None:
    # Patch the implementation module, not the legacy shim: consumers import
    # infra.providers.embed directly since B5.5c, so rebinding the shim's
    # attribute would silently leave the offline channel on the network path.
    import unified_memory.infra.providers.embed as em

    em.embed_query_cached = lambda *a, **k: None  # type: ignore[method-assign]


def _evaluate(vault: Path, items: list[dict], limit: int = 10) -> list[dict]:
    rows = []
    for item in items:
        t0 = time.perf_counter()
        result = search.hybrid_search(vault, item["query"], limit=limit)
        elapsed_ms = 1000 * (time.perf_counter() - t0)
        docs = [r["doc"] for r in result["results"]]
        expected = set(item.get("docs", []))
        expect_empty = bool(item.get("expect_empty"))

        if expect_empty:
            rows.append(
                {
                    **item,
                    "count": result["count"],
                    "abstain_correct": result["count"] == 0,
                    "latency_ms": round(elapsed_ms, 1),
                }
            )
            continue

        def recall_at(k: int) -> float:
            if not expected:
                return 1.0
            hit = len(expected & set(docs[:k]))
            return hit / len(expected)

        first_rank = next(
            (i + 1 for i, d in enumerate(docs) if d in expected), None
        )
        # One occurrence per doc: several lines of the same note must not
        # inflate DCG past the ideal (which grants each relevant doc once).
        seen_docs: set[str] = set()
        unique_docs: list[str] = []
        for d in docs:
            if d not in seen_docs:
                seen_docs.add(d)
                unique_docs.append(d)
        dcg = sum(
            1.0 / math.log2(i + 2)
            for i, d in enumerate(unique_docs[:limit])
            if d in expected
        )
        ideal = sum(1.0 / math.log2(i + 2) for i in range(min(limit, len(expected))))
        rows.append(
            {
                **item,
                "count": result["count"],
                "recall@5": round(recall_at(5), 4),
                "recall@10": round(recall_at(10), 4),
                "mrr": round(1.0 / first_rank, 4) if first_rank else 0.0,
                "ndcg@10": round(dcg / ideal, 4) if ideal else 0.0,
                "top1_ok": (
                    bool(result["results"])
                    and item.get("must_contain", "") in result["results"][0]["line"]
                    if item.get("must_contain")
                    else None
                ),
                "latency_ms": round(elapsed_ms, 1),
            }
        )
    return rows


def _aggregate(rows: list[dict]) -> dict:
    normal = [r for r in rows if not r.get("expect_empty")]
    abstain = [r for r in rows if r.get("expect_empty")]
    latencies = [r["latency_ms"] for r in rows]
    lat_sorted = sorted(latencies)
    p95 = lat_sorted[math.ceil(0.95 * len(lat_sorted)) - 1] if lat_sorted else 0.0
    out = {
        "queries": len(rows),
        "recall@5": round(statistics.mean(r["recall@5"] for r in normal), 4) if normal else None,
        "recall@10": round(statistics.mean(r["recall@10"] for r in normal), 4) if normal else None,
        "mrr": round(statistics.mean(r["mrr"] for r in normal), 4) if normal else None,
        "ndcg@10": round(statistics.mean(r["ndcg@10"] for r in normal), 4) if normal else None,
        "abstain_accuracy": (
            round(sum(1 for r in abstain if r["abstain_correct"]) / len(abstain), 4)
            if abstain
            else None
        ),
        "update_top1_ok": None,
        "empty_result_rate": round(
            sum(1 for r in rows if r["count"] == 0) / len(rows), 4
        ),
        "latency_p50_ms": round(statistics.median(latencies), 1) if latencies else 0.0,
        "latency_p95_ms": round(p95, 1),
    }
    update_rows = [r for r in rows if r.get("must_contain") is not None]
    if update_rows:
        out["update_top1_ok"] = round(
            sum(1 for r in update_rows if r["top1_ok"]) / len(update_rows), 4
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", help="real vault path (copies it to temp)")
    parser.add_argument("--fixture-only", action="store_true")
    parser.add_argument("--latency", action="store_true", help="also run the network pass")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    report: dict = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    tmp_root = Path(tempfile.mkdtemp(prefix="um-bench-"))

    try:
        # fixture pass
        fixture_vault = golden_fixture.build_fixture_vault(tmp_root / "fixture")
        memory_mod.UNIFIED_MEMORY_VAULT = fixture_vault
        _pin_state(tmp_root, "fixture")
        index.update_index(fixture_vault)
        _patch_embed_off()
        fixture_rows = _evaluate(fixture_vault, golden_fixture.GOLDEN)
        report["fixture"] = {"aggregate": _aggregate(fixture_rows), "items": fixture_rows}

        # real-vault pass (derived labels)
        if not args.fixture_only:
            if not args.vault:
                raise SystemExit("--vault is required unless --fixture-only")
            real_vault = copy_vault_to_temp(Path(args.vault), tmp_root / "real")
            memory_mod.UNIFIED_MEMORY_VAULT = real_vault
            _pin_state(tmp_root, "real")
            index.update_index(real_vault)
            from build_golden import build as build_real  # noqa: E402

            real_items = build_real(real_vault)
            real_rows = _evaluate(real_vault, real_items)
            report["real"] = {"aggregate": _aggregate(real_rows), "items": real_rows}

        # latency pass (real embed path, noisy by design)
        if args.latency:
            try:
                import importlib

                import unified_memory.infra.providers.embed as em

                importlib.reload(em)
            except Exception:  # noqa: BLE001 — latency pass is best-effort
                report["latency_note"] = "embed reload failed; latency pass skipped"
            lat_vault = (
                fixture_vault
                if args.fixture_only
                else copy_vault_to_temp(Path(args.vault), tmp_root / "lat")
            )
            memory_mod.UNIFIED_MEMORY_VAULT = lat_vault
            _pin_state(tmp_root, "latency")
            index.update_index(lat_vault)
            items = (
                golden_fixture.GOLDEN
                if args.fixture_only
                else report["real"]["items"]
            )
            lat_rows = []
            for item in items:
                t0 = time.perf_counter()
                search.hybrid_search(lat_vault, item["query"], limit=10)
                lat_rows.append(round(1000 * (time.perf_counter() - t0), 1))
            lat_sorted = sorted(lat_rows)
            report["latency"] = {
                "note": "real embed path; network-dependent, noisy by design",
                "p50_ms": round(statistics.median(lat_rows), 1),
                "p95_ms": round(lat_sorted[math.ceil(0.95 * len(lat_sorted)) - 1], 1),
                "max_ms": round(max(lat_rows), 1),
            }
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {k: v.get("aggregate") for k, v in report.items() if isinstance(v, dict) and "aggregate" in v}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
