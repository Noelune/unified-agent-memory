# -*- coding: utf-8 -*-
"""infra.store — the ONLY place in the project allowed to speak SQL.

schema   connection lifecycle + idempotent DDL + v4→v10 migrations
search_index  docs/fts/fts_lex tables: incremental rebuild + lexical search
claims   memory-row use cases: access tracking, vectors, caches
stats_queries  read-only aggregates (stats.py's storage half)
audit    the hash-chained audit log
maintain diagnostics + reversible derived-data pruning (health/gc)

Every statement is a literal inline at its call site (the project's scanner
red-lines SQL constants assigned to names and executed later — batch-A坑1).
"""
from .schema import (
    SCHEMA_VERSION,
    get_conn,
    index_db_for,
)
from .search_index import (
    fts_search,
    lexical_search,
    update_index,
    update_memories,
)
from .claims import (
    active_memories,
    forgetting_candidates,
    forget_stats,
    get_meta,
    memory_count,
    pending_vector_rows,
    query_cache_get,
    query_cache_put,
    record_access,
    record_used_events,
    records_for_ids,
    resolve_short_ids,
    save_vectors,
    set_meta,
    used_count,
    vector_count,
    vector_search_rows,
)
from .stats_queries import (
    stats_access_per_day,
    stats_daily_created,
    stats_importance_counts,
    stats_scalar,
    stats_top_accessed,
    stats_type_counts,
)
from .audit import (
    audit_entry_hash,
    audit_rows,
    audit_verify,
    record_audit,
)
from .maintain import (
    index_counts,
    orphan_index_report,
    prune_access_log,
    prune_query_cache,
    vacuum_index,
)

__all__ = [
    "SCHEMA_VERSION", "get_conn", "index_db_for",
    "fts_search", "lexical_search", "update_index", "update_memories",
    "active_memories", "forgetting_candidates", "forget_stats", "get_meta",
    "memory_count", "pending_vector_rows", "query_cache_get", "query_cache_put",
    "record_access", "records_for_ids", "resolve_short_ids", "save_vectors",
    "set_meta", "used_count", "vector_count", "vector_search_rows",
    "record_used_events",
    "stats_access_per_day", "stats_daily_created", "stats_importance_counts",
    "stats_scalar", "stats_top_accessed", "stats_type_counts",
    "audit_entry_hash", "audit_rows", "audit_verify", "record_audit",
    "index_counts", "orphan_index_report", "prune_access_log",
    "prune_query_cache", "vacuum_index",
]
