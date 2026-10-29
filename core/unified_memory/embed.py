# -*- coding: utf-8 -*-
"""Legacy import path for the embedding provider (B5.5c: moved to
``unified_memory.infra.providers.embed``).

Kept per taskbook §0.7 (shim outlives one minor so cron jobs, the TS host and
tests keep importing ``unified_memory.embed``). Explicit re-exports only — no
logic lives here.
"""
from __future__ import annotations

from .infra.providers.embed import (
    API_KEY_ENV,
    BATCH_SIZE,
    CIRCUIT_COOLDOWN_S,
    CIRCUIT_FAILURES,
    EMBED_DIMS,
    EMBED_MODEL,
    EMBED_URL,
    MIN_TEXT_LEN,
    QUERY_CACHE_TTL_DAYS,
    QUERY_TIMEOUT_S,
    SECRETS_PATH,
    TIMEOUT_S,
    blob_to_vector,
    circuit_open,
    configured,
    cosine,
    embed_missing,
    embed_one,
    embed_texts,
    embed_query_cached,
    get_api_key,
    main,
    reset_circuit,
    vector_search,
    vector_to_blob,
)

if __name__ == "__main__":
    main()
