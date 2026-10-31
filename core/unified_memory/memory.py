# -*- coding: utf-8 -*-
"""memory — compatibility shim for the CLI (batch B5.2).

The grammar lives in ``surface.cli`` and the command bodies in ``app/*``. This
module keeps the historical import path alive plus ONE deliberate resident:

  * ``INDEX_DB`` — the rebindable base every per-vault index path derives from.
    ``infra.store.schema.index_db_for`` reads it through ``sys.modules`` (it
    never imports memory), and the test isolation guard rebinds it, so the
    global has to stay at this exact import path. The env override exists
    because a test that spawns a child process (forgetter's generated .bat)
    cannot patch this in-process.

``remote_search`` moved to ``app.remote`` in batch D5 (the scanner's SSRF rule
used to block urllib files; it no longer does). Everything else is a
re-export. The shim is scheduled for deletion one minor after the migration
(taskbook §0.7) — the ``python -m unified_memory.memory`` entry keeps it alive
until then.
"""
from __future__ import annotations

import os
from pathlib import Path

from .app.govern.commands import (
    cmd_accept,
    cmd_accept_cli,
    cmd_advise,
    cmd_advise_cli,
    cmd_decide,
    cmd_decide_cli,
)
from .app.ingest.commands import (
    cmd_cite,
    cmd_digest,
    cmd_dismiss,
    cmd_dismiss_cli,
    cmd_note,
    cmd_note_cli,
    cmd_note_result,
    cmd_submit,
)
from .app.maintain.commands import cmd_doctor, cmd_drift, cmd_gc
from .app.query.commands import (
    cmd_audit,
    cmd_preview,
    cmd_search,
    cmd_show,
    cmd_stats_cli,
    preview_views,
    print_memory_data,
)
from .app.remote import REMOTE_TOKEN_ENV, REMOTE_URL_ENV, remote_config
from .app.system import (
    SUBMISSION_README,
    TEMPLATE_FILES,
    cmd_embed,
    cmd_graph,
    cmd_init,
    cmd_status,
    cmd_sync,
    cmd_use,
    find_template_dir,
    index_db_for,
    init_vault,
    is_agent_file_prefix,
    search_index,
    update_index,
)
from .domain.markdown import encode_untrusted, redact
from .domain.policy import AGENT_CONTEXT, CANONICAL_DOCS, NON_SUBMISSION_FILES
from .infra.config import (
    CONFIG_PATH,
    VAULT_ENV,
    VaultMissing,
    parse_config,
    resolve_vault,
)
from .infra.console import emit_json
from .infra.vault import ensure_vault
from .surface.cli import build_parser, main, plain_reason

# Single redirectable base path for every per-vault index DB (see
# schema.index_db_for). Kept here on purpose — see the module docstring.
INDEX_DB = Path(
    os.environ.get("UNIFIED_MEMORY_INDEX_DB")
    or Path.home() / ".unified-memory" / "index.db"
)


if __name__ == "__main__":
    main()
