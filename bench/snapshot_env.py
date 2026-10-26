# -*- coding: utf-8 -*-
"""snapshot_env — record a reproducible environment baseline for batch A.

Copies a vault to a throwaway temp dir, builds the derived index there, and
writes bench/baseline-env.json. The real vault is never written: the copy is
indexed, measured and deleted.

Usage:
    python bench/snapshot_env.py --vault <path-to-vault> [--out bench/baseline-env.json]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "core"))

from unified_memory import index  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--out", default=str(ROOT / "bench" / "baseline-env.json"))
    args = parser.parse_args()

    src = Path(args.vault) / "50-Agent-Context"
    if not src.is_dir():
        raise SystemExit(f"no 50-Agent-Context under {args.vault}")

    tmp = Path(tempfile.mkdtemp(prefix="um-baseline-")) / "vault"
    (tmp / "50-Agent-Context").mkdir(parents=True)
    for item in src.iterdir():
        dst = tmp / "50-Agent-Context" / item.name
        if item.is_dir():
            shutil.copytree(item, dst)
        else:
            shutil.copy2(item, dst)

    os.environ["UNIFIED_MEMORY_VAULT"] = str(tmp)
    from unified_memory import memory as memory_mod  # noqa: E402

    memory_mod.UNIFIED_MEMORY_VAULT = tmp

    t0 = time.perf_counter()
    result = index.update_index(tmp)
    build_ms = 1000 * (time.perf_counter() - t0)

    conn = index.get_conn(tmp)
    try:
        counts = {
            "memories": conn.execute("SELECT COUNT(*) c FROM memories").fetchone()["c"],
            "embeddings": conn.execute("SELECT COUNT(*) c FROM embeddings").fetchone()["c"],
            "access_log": conn.execute("SELECT COUNT(*) c FROM access_log").fetchone()["c"],
            "superseded": conn.execute(
                "SELECT COUNT(*) c FROM memories WHERE status != 'active'"
            ).fetchone()["c"],
        }
        tables = [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
        ]
    finally:
        conn.close()

    payload = {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "head": None,
        "vault_notes": len(list(index.indexed_files(tmp))),
        "active_fact_lines": counts["memories"],
        "db_bytes": index.index_db_for(tmp).stat().st_size,
        "cold_index_build_ms": round(build_ms, 1),
        "changed_docs_on_build": result["changed_docs"],
        "tables": tables,
        **counts,
    }
    try:
        payload["head"] = (
            __import__("subprocess")
            .run(["git", "rev-parse", "HEAD"], cwd=str(ROOT), capture_output=True, text=True)
            .stdout.strip()
        )
    except Exception:  # noqa: BLE001 — git optional for this report
        pass

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    shutil.rmtree(tmp.parent, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
