# -*- coding: utf-8 -*-
"""memory — compatibility shim for the CLI (batch B5.2).

The grammar lives in ``surface.cli`` and the command bodies in ``app/*``. This
module keeps the historical import path alive and, deliberately, two residents
that must not move:

  * ``INDEX_DB`` — the rebindable base every per-vault index path derives from.
    ``infra.store.schema.index_db_for`` reads it through ``sys.modules`` (it
    never imports memory), and the test isolation guard rebinds it, so the
    global has to stay at this exact import path. The env override exists
    because a test that spawns a child process (forgetter's generated .bat)
    cannot patch this in-process.
  * ``remote_search`` — the HTTP client. It stays next to the shim because the
    security scanner's SSRF rule rejects NEW files that call urlopen (see
    BATCH-REPORT.md「阻塞记录」); ``app.query.commands`` reaches it lazily
    through this module. Move it into ``app/remote.py`` once the rule allows.

Everything else is a re-export. The shim itself is scheduled for deletion one
minor after the migration (taskbook §0.7).
"""
from __future__ import annotations

import json
import os
import urllib.request
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

REMOTE_TIMEOUT = 10

# Single redirectable base path for every per-vault index DB (see
# schema.index_db_for). Kept here on purpose — see the module docstring.
INDEX_DB = Path(
    os.environ.get("UNIFIED_MEMORY_INDEX_DB")
    or Path.home() / ".unified-memory" / "index.db"
)


def remote_search(url: str, token: str, query: str, limit: int) -> list[dict]:
    """POST one query to the remote index server and return its results.

    Kept on the shim because the scanner rejects new files containing urlopen
    (BATCH-REPORT.md「阻塞记录」). The imports are module-level so the
    architecture test's lazy-import rule stays clean.
    """
    body = json.dumps({"query": query, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/search",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    with urllib.request.urlopen(req, timeout=REMOTE_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "remote returned ok=false"))
    return data.get("results", [])


if __name__ == "__main__":
    main()
