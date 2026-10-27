# -*- coding: utf-8 -*-
"""Shim — every name moved to domain/infra in B1; no logic lives here.

Kept for one minor release (batch-B taskbook §0.7) so cron scripts, setup
helpers and tests importing ``unified_memory.common`` keep working. New code
imports ``unified_memory.domain.*`` / ``unified_memory.infra.*`` directly.
Importing this module still arms the console-encoding guard (infra.console
runs it at import, exactly as common.py did).
"""
from .domain.envelope import MEMORY_DATA_TAG  # the fence tag lives in envelope (B3)
from .domain.markdown import (
    CREDENTIAL_LINE_RE, EN_STAMP_RE, SECRET_PATTERNS, STAMP_RE,
    USAGE_TAG_RE, VERSIONED_RE, WRITTEN_SUFFIX_RE, bare_fact_line,
    collapse_whitespace, encode_untrusted, fact_lines, is_versioned,
    looks_like_credential, parse_stamp, redact, source_agent, strip_suffix,
    write_stamp,
)
from .domain.policy import (
    ADJUDICATED_FILE, AGENT_CONTEXT, CANONICAL_DOCS, CONFLICT_COPY_RE,
    CONFLICT_FILE, FORGET_DIR, NON_SUBMISSION_FILES, PENDING_FILE, PROCESSED_DIR,
    SESSION_DIR, SITUATION_DIR, SUBMISSION_DIR, UNCLASSIFIED_FACT_REL, VAULT_ENV,
    is_conflict_copy,
)
from .infra.config import (
    CONFIG_PATH, DEFAULT_VAULT, VaultMissing, parse_config, resolve_vault,
)
from .infra.console import ensure_utf8_console
from .infra.lock import LOCK_FILE, file_lock
from .infra.schedule import (
    SCHEDULE_STATE_FILE, core_source_dir, mark_schedule_run, read_schedule_state,
    schedule_state_path,
)
from .infra.vault import (
    atomic_create, atomic_write, canonical_dir, canonical_path, ensure_vault,
    forget_dir, is_bare_note_name, note_named, processed_dir, read_maybe,
    resolve_canonical_note, session_dir, situation_dir, submission_dir,
)
