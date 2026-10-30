# -*- coding: utf-8 -*-
"""hook_bench — end-to-end latency of the three hook events (batch E4).

Each sample is a REAL subprocess invocation of integrations/hooks/memory_hook.py
with a synthetic stdin payload on the golden fixture vault: interpreter start +
in-process core import + the event's work, i.e. exactly what a platform hook
pays per event. Numbers land verbatim in BATCH-REPORT.md — nothing here is
fabricated or smoothed.

Usage:
    python bench/hook_bench.py [--runs 10] [--out <path.json>]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "core"))
sys.path.insert(0, str(REPO / "bench"))

import golden_fixture  # noqa: E402

HOOK = REPO / "integrations" / "hooks" / "memory_hook.py"


def _percentile(sorted_values: list[float], pct: int) -> float:
    if not sorted_values:
        return 0.0
    idx = min(len(sorted_values) - 1, max(0, round(pct / 100 * (len(sorted_values) - 1))))
    return sorted_values[idx]


def _run_event(event: str, payload_file: Path, env: dict, runs: int) -> dict:
    samples: list[float] = []
    with payload_file.open("rb") as stdin:
        for _ in range(runs):
            t0 = time.perf_counter()
            proc = subprocess.run(
                [sys.executable, str(HOOK), event],
                stdin=stdin,
                capture_output=True,
                env=env,
            )
            samples.append((time.perf_counter() - t0) * 1000)
            stdin.seek(0)
            if proc.returncode != 0:
                raise SystemExit(
                    f"hook {event} failed: {proc.stderr.decode(errors='replace')}"
                )
    samples.sort()
    return {
        "p50_ms": round(_percentile(samples, 50), 1),
        "p95_ms": round(_percentile(samples, 95), 1),
        "runs": runs,
        "samples_ms": [round(s, 1) for s in samples],
    }


def main() -> int:
    ap = argparse.ArgumentParser(prog="hook_bench")
    ap.add_argument("--runs", type=int, default=10, help="samples per event")
    ap.add_argument("--out", default=None, help="also write the JSON report here")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="um-hook-bench-"))
    vault = golden_fixture.build_fixture_vault(tmp / "fixture")
    import run as bench_run  # noqa: E402 — bench/run.py pins INDEX_DB/journal

    bench_run._pin_state(tmp, "hookbench")
    os.environ["UNIFIED_MEMORY_HOOK_STATE"] = str(tmp / "hooks")
    (tmp / "hooks").mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()

    payloads = tmp / "payloads"
    payloads.mkdir(parents=True)
    (payloads / "session-start.json").write_text(
        json.dumps({"session_id": "bench", "source": "startup", "hook_event_name": "SessionStart"}),
        encoding="utf-8",
    )
    (payloads / "prompt-submit.json").write_text(
        json.dumps({"session_id": "bench", "hook_event_name": "UserPromptSubmit",
                    "prompt": "上次配置的同步端口是多少"}),
        encoding="utf-8",
    )
    transcript = tmp / "hooks" / "transcript.jsonl"
    transcript.write_text(
        '{"type":"user","message":{"content":[{"type":"text","text":"决定把缓存目录迁到 D 盘"}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"已迁移完成"}]}}\n',
        encoding="utf-8",
    )
    (payloads / "session-end.json").write_text(
        json.dumps({"session_id": "bench", "source": "clear", "hook_event_name": "SessionEnd",
                    "transcript_path": str(transcript)}),
        encoding="utf-8",
    )

    report = {
        "runs": args.runs,
        "events": {
            "session-start": _run_event("session-start", payloads / "session-start.json", env, args.runs),
            "prompt-submit": _run_event("prompt-submit", payloads / "prompt-submit.json", env, args.runs),
            "session-end": _run_event("session-end", payloads / "session-end.json", env, args.runs),
        },
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
