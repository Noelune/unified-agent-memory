# -*- coding: utf-8 -*-
"""embed — optional semantic-vector enrichment for the memory database.

Uses the user's SiliconFlow embedding model (Qwen/Qwen3-Embedding-4B) to
compute a 1024-dim vector per memory line, stored as a Float32 BLOB in the
per-vault SQLite db. Fully optional:

  - No API key configured  → ``embed_texts`` returns None, callers degrade to
    lexical search silently.
  - Network/HTTP failure    → same graceful None, never crashes a search.
  - Incremental             → ``embed_missing`` only embeds memory lines that
    lack a vector yet.

The API key is a secret: it is read from ``SILICONFLOW_API_KEY`` env or from
``~/.unified-memory/secrets.yaml`` (``siliconflow_api_key: <key>``, file
permissions should be 0600). It is never logged or written into the vault.

Stdlib only (urllib.request). Endpoint is OpenAI-compatible.
"""
from __future__ import annotations

import array
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import index
from .common import parse_config, resolve_vault

EMBED_URL = "https://api.siliconflow.cn/v1/embeddings"
EMBED_MODEL = "Qwen/Qwen3-Embedding-4B"
EMBED_DIMS = 1024
BATCH_SIZE = 32  # SiliconFlow accepts up to 32 inputs per call
TIMEOUT_S = 15
SECRETS_PATH = Path.home() / ".unified-memory" / "secrets.yaml"
API_KEY_ENV = "SILICONFLOW_API_KEY"

# Minimal token budget below which we do not even try (no point sending a
# 1-token query to a 4B embedding model).
MIN_TEXT_LEN = 2


def get_api_key() -> str:
    """Return the SiliconFlow API key from env or secrets.yaml ('' when unset)."""
    key = os.environ.get(API_KEY_ENV, "") or ""
    if key:
        return key.strip()
    try:
        cfg = parse_config(SECRETS_PATH)
    except OSError:
        return ""
    return (cfg.get("siliconflow_api_key") or "").strip()


def configured() -> bool:
    return bool(get_api_key())


def _request_body(texts: list[str]) -> bytes:
    payload = {
        "model": EMBED_MODEL,
        "input": texts,
        "encoding_format": "float",
        "dimensions": EMBED_DIMS,
    }
    return json.dumps(payload).encode("utf-8")


def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """Embed ``texts`` (≤32) in one call. Returns a list of float vectors, or
    None on any failure (missing key, network error, HTTP error, bad JSON)."""
    texts = [t for t in texts if t and len(t.strip()) >= MIN_TEXT_LEN]
    if not texts:
        return None
    key = get_api_key()
    if not key:
        return None
    body = _request_body(texts)
    req = urllib.request.Request(
        EMBED_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError):
        return None
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    vectors: list[list[float]] = []
    for item in sorted(items, key=lambda it: it.get("index", 0)):
        vec = item.get("embedding")
        if not isinstance(vec, list) or len(vec) != EMBED_DIMS:
            return None
        vectors.append([float(x) for x in vec])
    if len(vectors) != len(texts):
        return None
    return vectors


def embed_one(text: str) -> list[float] | None:
    result = embed_texts([text])
    return result[0] if result else None


# --------------------------------------------------------------------------
# Vector <-> BLOB helpers (Float32, little-endian)
# --------------------------------------------------------------------------


def vector_to_blob(vector: list[float]) -> bytes:
    return array.array("f", vector).tobytes()


def blob_to_vector(blob: bytes) -> list[float]:
    return list(array.array("f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    n = min(len(a), len(b))
    dot = ab = bb = 0.0
    for i in range(n):
        dot += a[i] * b[i]
        ab += a[i] * a[i]
        bb += b[i] * b[i]
    if ab == 0.0 or bb == 0.0:
        return 0.0
    return dot / (ab ** 0.5 * bb ** 0.5)


# --------------------------------------------------------------------------
# Incremental enrichment of the memory database
# --------------------------------------------------------------------------


def embed_missing(vault: Path, limit: int = 400) -> dict:
    """Embed memory lines that lack a vector yet.

    Returns {"ok": bool, "embedded": int, "total": int, "reason": str}. On any
    provider failure returns ok=False with a short reason (caller decides
    whether to surface it). Never raises.
    """
    if not configured():
        return {"ok": False, "embedded": 0, "total": 0, "reason": "no SiliconFlow API key (set SILICONFLOW_API_KEY or ~/.unified-memory/secrets.yaml)"}
    index.update_index(vault)  # self-healing: memories must exist before we embed
    conn = index.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, line FROM memories WHERE id NOT IN (SELECT memory_id FROM embeddings) LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return {"ok": True, "embedded": 0, "total": 0, "reason": "all memory lines already embedded"}
    vectors: list[list[float]] = []
    for start in range(0, len(rows), BATCH_SIZE):
        batch = rows[start : start + BATCH_SIZE]
        result = embed_texts([r["line"] for r in batch])
        if result is None:
            return {"ok": False, "embedded": start, "total": len(rows), "reason": "embedding provider failed mid-batch"}
        vectors.extend(result)
    conn = index.get_conn(vault)
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for row, vec in zip(rows, vectors):
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (memory_id, dim, vector) VALUES (?, ?, ?)",
                (row["id"], EMBED_DIMS, vector_to_blob(vec)),
            )
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (now, row["id"]))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "embedded": len(rows), "total": len(rows), "reason": ""}


def vector_search(vault: Path, query_vec: list[float], limit: int = 8) -> list[dict]:
    """Cosine-similarity scan over embedded memory lines (exact, in-process).

    Returns the top-``limit`` active memories with a ``score`` in 0..1.
    """
    conn = index.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT m.id, m.doc, m.line, m.type, m.importance, e.vector "
            "FROM memories m JOIN embeddings e ON e.memory_id = m.id "
            "WHERE m.status = 'active'"
        ).fetchall()
    finally:
        conn.close()
    scored: list[dict] = []
    for row in rows:
        vec = blob_to_vector(row["vector"])
        if len(vec) != len(query_vec):
            continue
        score = cosine(query_vec, vec)
        scored.append(
            {
                "id": row["id"],
                "doc": row["doc"],
                "line": row["line"],
                "type": row["type"],
                "importance": row["importance"],
                "score": score,
            }
        )
    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:limit]


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="memory embed", description="enrich the memory index with semantic vectors")
    parser.add_argument("--vault", default=None, help="vault path (default: config/env)")
    parser.add_argument("--limit", type=int, default=400, help="max memory lines to embed per run")
    args = parser.parse_args(argv)

    vault = Path(args.vault) if args.vault else resolve_vault()
    result = embed_missing(vault, limit=args.limit)
    if not result["ok"]:
        print(f"embed: {result['reason']}")
        raise SystemExit(1)
    print(f"embed: {result['embedded']} line(s) embedded ({result['total']} total pending → {result['reason'] or 'done'})")


if __name__ == "__main__":
    main()
