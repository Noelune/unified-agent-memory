# -*- coding: utf-8 -*-
"""index — compatibility facade over the store (B2).

The memory database's implementation lives in ``unified_memory.infra.store``
(schema/connections, the docs/fts/fts_lex rebuild, lexical search, the
memory-row use cases and the audit chain) plus ``domain.markdown`` /
``domain.policy`` (parsing, tokens, classification) and ``infra.vault``
(indexed_files). This module keeps the pre-B2 import surface — including the
names tests and the remote index server reach for — for exactly one minor
release (batch-B taskbook §0.7). New code imports the store directly.
"""
from __future__ import annotations

from .domain.markdown import (  # noqa: F401  (compat re-exports)
    SUPERSEDED_HEADING_RE,
    cjk_tokens,
)
from .domain.markdown import doc_lines as _doc_lines  # noqa: F401  (compat)
from .domain.markdown import parse_write_stamp  # noqa: F401  (compat)
from .domain.policy import (  # noqa: F401  (compat re-exports)
    MEMORY_TYPES,
    SALIENCE,
    TYPE_RULES,
    classify_type,
    salience_for,
)
from .infra.store import (  # noqa: F401  (compat re-exports)
    SCHEMA_VERSION,
    audit_entry_hash,
    audit_rows,
    audit_verify,
    active_memories,
    fts_search,
    get_conn,
    index_db_for,
    lexical_search,
    memory_count,
    record_access,
    record_audit,
    record_used_events,
    resolve_short_ids,
    update_index,
    update_memories,
    used_count,
)
from .infra.store.audit import _append_audit_row  # noqa: F401  (compat)
from .infra.store.search_index import (  # noqa: F401  (compat re-exports)
    INDEX_LOGIC_VERSION,
    _backfill_fts_lex,
    _doc_match,
    _ensure_logic_version,
    _fts_lex_delete,
    _fts_lex_upsert,
    _fts_or_query,
    _fts_supported,
)
from .infra.vault import indexed_files  # noqa: F401  (compat re-export)

__all__ = [
    "SCHEMA_VERSION", "index_db_for", "get_conn", "indexed_files",
    "update_memories", "update_index", "fts_search", "lexical_search",
    "cjk_tokens",
    "record_access", "record_audit", "audit_rows", "audit_verify",
    "audit_entry_hash", "used_count", "resolve_short_ids",
    "record_used_events", "active_memories", "memory_count",
]
