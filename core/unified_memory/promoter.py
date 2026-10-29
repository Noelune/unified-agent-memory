# -*- coding: utf-8 -*-
"""promoter — compatibility shim (B5.4 split).

The 1000-line implementation is now four focused modules plus the scheduler:

  domain/facts.py          which bullets are active, where a fact is appended,
                           how a replaced value moves into history
  app/govern/review.py     scan + classify + stage the pending list
  app/govern/promote.py    plan/apply/archive (promote, apply_pending, accept,
                           auto_promote)
  app/govern/decide.py     rule on one conflict (decide, adjudicate)
  app/govern/cli.py        the argparse entry point and `--cron` registration

This module re-exports the old flat surface — including the names the CLI,
`python -m unified_memory.promoter`, catchup, the panels and the tests reach
for — for exactly one minor (taskbook §0.7).

Note for patching: a re-export is a separate binding. `catchup` calls through
this module object (``promoter.auto_promote``), so patching here works for it;
anything that calls the implementation directly must patch
``unified_memory.app.govern.<module>`` instead.

Deliberately NOT re-exported: the incidental stdlib/plumbing imports the old
module happened to pull in (``json``, ``re``, ``time``, ``argparse``,
``shutil``, ``Path``, ``index_mod``, ``schedule_mod``, ``vault_mod``,
``atomic_write``, ``file_lock``, ``read_maybe``, ``redact`` and friends).
They were never this module's API, no caller in the repo reaches for them, and
the layer rules now point such code at ``infra.vault`` / ``infra.store``.
"""
from __future__ import annotations

from .app.govern.cli import main, register_cron
from .app.govern.decide import (
    ADVISABLE,
    DECISION_LABELS,
    DECISIONS,
    adjudicate,
    archive_settled_source,
    decide,
)
from .app.govern.promote import (
    _refresh_index,
    _resolve_target,
    accept,
    apply_pending,
    archive_sources,
    auto_promote,
    plan_promotion,
    promote,
)
from .app.govern.queue import (  # noqa: F401  (compat re-export)
    append_conflict,
    read_conflicts,
    record_adjudication,
    remove_conflict,
)
from .app.govern.review import (
    CATEGORY_RULES,
    UNCLASSIFIED_DOC,
    UNCLASSIFIED_TARGET,
    _adjudicated_facts,
    _best_overlap,
    _cross_doc_hit,
    classify,
    parse_pending_list,
    pending_sources,
    review,
    target_path,
    write_pending_list,
)
from .app.maintain.repair import repair_existing  # noqa: F401  (compat re-export)
from .domain.conflict import classify_against, similarity  # noqa: F401  (compat)
from .domain.facts import (
    HISTORY_HEADING_RE,
    SUPERSESSION_RE,
    _STAMP_TAIL,
    _comparable,
    _move_to_superseded,
    active_fact_lines,
    append_active_facts,
    history_start,
    move_to_superseded,
)
from .domain.model import Change, ChangeSet  # noqa: F401  (compat re-export)
from .domain.policy import (  # noqa: F401  (compat re-export: the note names)
    ADJUDICATED_FILE,
    CANONICAL_DOCS,
    CONFLICT_FILE,
    NON_SUBMISSION_FILES,
    PENDING_FILE,
    SUBMISSION_DIR,
    UNCLASSIFIED_FACT_REL,
)
from .infra import schedule as _schedule


def shlex_quote(value: str) -> str:
    """Kept as a thin alias: POSIX quoting now lives with the scheduler."""
    return _schedule.shlex_quote(value)


if __name__ == "__main__":
    main()
