# -*- coding: utf-8 -*-
"""Shim — schema lives in unified_memory.infra.store.schema (B2); no logic here.

Kept for exactly one minor release (batch-B taskbook §0.7): tests,
bench/verify_live_migration.py and any external caller import
``unified_memory.schema``. The implementation no longer imports
``unified_memory.memory``; the per-vault index path resolves through an
explicit argument, the rebindable ``memory.INDEX_DB`` global (via sys.modules)
or the env/home default — see infra/store/schema.py.
"""
from .infra.store.schema import (  # noqa: F401
    INDEX_DB,
    MIGRATIONS,
    SCHEMA_VERSION,
    _backup_db_file,
    _ensure_schema,
    _migrate_schema,
    _read_version,
    _write_version,
    get_conn,
    index_db_for,
)
