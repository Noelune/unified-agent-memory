# -*- coding: utf-8 -*-
"""Shim surface — the one-minor compatibility promise of B5.2–B5.4.

Four big flat modules were split across layers: ``memory`` (B5.2),
``conflict`` (B5.4a), ``promoter`` and ``maintenance`` (B5.4c). Every old path
survives as a re-export shim so that callers we do not control — a user's own
script, the panel integrations, ``python -m unified_memory.promoter --auto`` —
keep working (taskbook §0.7).

A promise nobody checks is not a promise, so this file freezes the public
surface measured at the pre-B5 baseline (commit 805fad8) and asserts two
things about it:

  1. every frozen name still resolves from the old path;
  2. where the name has exactly one implementation home, the shim attribute is
     *the same object* — that is what distinguishes a re-export from a copy
     that can silently drift away from the code it claims to expose.

The name lists are deliberately written out rather than discovered from the
current modules: discovering them would make this test agree with whatever the
code happens to do today. Adding a name here is harmless; deleting one is an
API break and should be a conscious edit to the list.
"""
import importlib
import unittest

# shim module -> every top-level name the pre-split module exposed
SURFACE = {
    "unified_memory.memory": (
        # constants and vault plumbing
        "INDEX_DB", "index_db_for", "TEMPLATE_FILES", "SUBMISSION_README",
        "is_agent_file_prefix", "find_template_dir", "init_vault",
        # remote search (the client itself moved to app.remote in batch D5)
        "REMOTE_URL_ENV", "REMOTE_TOKEN_ENV", "remote_config",
        # index
        "update_index", "search_index",
        # commands
        "print_memory_data", "cmd_init", "cmd_use", "cmd_search", "cmd_show",
        "cmd_submit", "cmd_sync", "cmd_embed", "preview_views", "cmd_preview",
        "cmd_note_result", "cmd_note", "cmd_note_cli", "cmd_dismiss",
        "cmd_dismiss_cli", "cmd_accept", "cmd_accept_cli", "plain_reason",
        "cmd_advise", "cmd_advise_cli", "cmd_decide", "cmd_decide_cli",
        "cmd_stats_cli", "cmd_doctor", "cmd_gc", "cmd_graph", "cmd_digest",
        "emit_json", "cmd_status", "cmd_audit", "cmd_cite", "cmd_drift",
        # surface
        "build_parser", "main",
    ),
    "unified_memory.conflict": (
        # pure rules -> domain.conflict
        "char_bigrams", "similarity", "CONFLICT_SIM_THRESHOLD",
        "_SUBJECT_COLON", "_SUBJECT_DASH", "_SUBJECT_VERB", "_DATE_ONLY",
        "_NOT_A_SUBJECT", "subject_of", "same_subject", "classify_against",
        "_signature", "entry_key", "ADVICE_CHOICE", "ADVICE_WHY",
        "_BLOCK_FIELD", "_BLOCK_KEYS", "_BLOCK_ID", "_SETTLED_MARKERS",
        "_parse_inline_conflict", "_ADVICE_LINE", "_BULLET",
        "_PROVENANCE_TAIL", "_RECORDED_AT", "_SOURCE_IN_STAMP", "_WIKILINK",
        "describe", "_BOUNDARY", "_SNAP_LIMIT", "split_change",
        # vault queue I/O -> app.govern.queue
        "append_conflict", "record_advice", "read_conflicts", "find_conflict",
        "_drop_block", "remove_conflict", "record_adjudication",
    ),
    "unified_memory.promoter": (
        # review
        "CATEGORY_RULES", "UNCLASSIFIED_TARGET", "UNCLASSIFIED_DOC",
        "classify", "target_path", "_cross_doc_hit", "_best_overlap",
        "review", "_adjudicated_facts", "write_pending_list",
        "pending_sources", "parse_pending_list",
        # promote
        "plan_promotion", "promote", "archive_sources", "apply_pending",
        "accept", "auto_promote", "_resolve_target", "_refresh_index",
        # decide
        "DECISIONS", "ADVISABLE", "DECISION_LABELS", "decide", "adjudicate",
        "archive_settled_source",
        # facts
        "SUPERSESSION_RE", "HISTORY_HEADING_RE", "history_start",
        "active_fact_lines", "append_active_facts", "move_to_superseded",
        "_move_to_superseded", "_STAMP_TAIL", "_comparable",
        # cron + entry point + the odd neighbours the old module re-exported
        "register_cron", "main", "shlex_quote", "repair_existing",
    ),
    "unified_memory.maintenance": (
        "TEMPLATE_PLACEHOLDER_RE", "plan_repair", "repair_existing",
    ),
}

# shim -> {name: the module that now owns the implementation}. Only names with
# a single unambiguous home are listed: `main` and `register_cron` exist in
# several entry-point modules, and `index_db_for` / `update_index` are thin
# app-side wrappers over the store, so identity says nothing useful there.
OWNERS = {
    "unified_memory.memory": {
        "TEMPLATE_FILES": "unified_memory.app.system",
        "SUBMISSION_README": "unified_memory.app.system",
        "is_agent_file_prefix": "unified_memory.app.system",
        "find_template_dir": "unified_memory.app.system",
        "init_vault": "unified_memory.app.system",
        "REMOTE_URL_ENV": "unified_memory.app.remote",
        "REMOTE_TOKEN_ENV": "unified_memory.app.remote",
        "remote_config": "unified_memory.app.remote",
        "search_index": "unified_memory.app.system",
        "print_memory_data": "unified_memory.app.query.commands",
        "cmd_search": "unified_memory.app.query.commands",
        "cmd_preview": "unified_memory.app.query.commands",
        "cmd_stats_cli": "unified_memory.app.query.commands",
        "cmd_audit": "unified_memory.app.query.commands",
        "cmd_submit": "unified_memory.app.ingest.commands",
        "cmd_note": "unified_memory.app.ingest.commands",
        "cmd_dismiss": "unified_memory.app.ingest.commands",
        "cmd_cite": "unified_memory.app.ingest.commands",
        "cmd_accept": "unified_memory.app.govern.commands",
        "cmd_decide": "unified_memory.app.govern.commands",
        "cmd_advise": "unified_memory.app.govern.commands",
        "cmd_doctor": "unified_memory.app.maintain.commands",
        "cmd_drift": "unified_memory.app.maintain.commands",
        "plain_reason": "unified_memory.surface.cli",
        "build_parser": "unified_memory.surface.cli",
        "emit_json": "unified_memory.infra.console",
    },
    "unified_memory.conflict": {
        "char_bigrams": "unified_memory.domain.conflict",
        "similarity": "unified_memory.domain.conflict",
        "classify_against": "unified_memory.domain.conflict",
        "entry_key": "unified_memory.domain.conflict",
        "split_change": "unified_memory.domain.conflict",
        "describe": "unified_memory.domain.conflict",
        "append_conflict": "unified_memory.app.govern.queue",
        "record_advice": "unified_memory.app.govern.queue",
        "read_conflicts": "unified_memory.app.govern.queue",
        "find_conflict": "unified_memory.app.govern.queue",
        "remove_conflict": "unified_memory.app.govern.queue",
        "record_adjudication": "unified_memory.app.govern.queue",
    },
    "unified_memory.promoter": {
        "review": "unified_memory.app.govern.review",
        "classify": "unified_memory.app.govern.review",
        "target_path": "unified_memory.app.govern.review",
        "parse_pending_list": "unified_memory.app.govern.review",
        "promote": "unified_memory.app.govern.promote",
        "plan_promotion": "unified_memory.app.govern.promote",
        "apply_pending": "unified_memory.app.govern.promote",
        "accept": "unified_memory.app.govern.promote",
        "auto_promote": "unified_memory.app.govern.promote",
        "archive_sources": "unified_memory.app.govern.promote",
        "decide": "unified_memory.app.govern.decide",
        "adjudicate": "unified_memory.app.govern.decide",
        "DECISIONS": "unified_memory.app.govern.decide",
        "history_start": "unified_memory.domain.facts",
        "active_fact_lines": "unified_memory.domain.facts",
        "append_active_facts": "unified_memory.domain.facts",
        "move_to_superseded": "unified_memory.domain.facts",
        "register_cron": "unified_memory.app.govern.cli",
        "main": "unified_memory.app.govern.cli",
        "repair_existing": "unified_memory.app.maintain.repair",
        # `shlex_quote` is a delegate, not a re-export — see the test below.
    },
}


class ShimSurfaceTest(unittest.TestCase):
    def test_every_pre_split_name_still_resolves(self):
        for shim_name, names in SURFACE.items():
            shim = importlib.import_module(shim_name)
            missing = [n for n in names if not hasattr(shim, n)]
            self.assertEqual(missing, [], f"{shim_name} lost: {missing}")

    def test_reexports_are_the_implementation_object(self):
        for shim_name, owners in OWNERS.items():
            shim = importlib.import_module(shim_name)
            for name, owner_name in owners.items():
                owner = importlib.import_module(owner_name)
                self.assertTrue(
                    hasattr(owner, name),
                    f"{owner_name} does not define {name!r} any more",
                )
                self.assertIs(
                    getattr(shim, name),
                    getattr(owner, name),
                    f"{shim_name}.{name} is a copy, not a re-export of "
                    f"{owner_name}.{name} — fix the shim, do not rebind it",
                )

    def test_no_shim_reimplements_logic(self):
        """A shim is a re-export plus a docstring, nothing else.

        Checked structurally: apart from the two names documented below, the
        deprecated modules define no functions and no classes.
        """
        import ast
        import inspect

        allowed = {
            # `shlex_quote` is an explicit one-line delegate to the scheduler
            # (the promoter's generated .bat needs it at the legacy import
            # path). remote_search moved to app.remote in batch D5.
            "unified_memory.promoter": {"shlex_quote"},
        }
        for shim_name in SURFACE:
            module = importlib.import_module(shim_name)
            tree = ast.parse(inspect.getsource(module))
            defined = {
                node.name
                for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            }
            extra = defined - allowed.get(shim_name, set())
            self.assertEqual(extra, set(), f"{shim_name} grew new code: {sorted(extra)}")

    def test_shlex_quote_delegate_agrees_with_the_scheduler(self):
        """`promoter.shlex_quote` is a delegate, so identity cannot hold.

        What must hold is agreement: the old flat name and the scheduler quote
        the same command line identically, including the Windows path shapes
        that actually reach a registered job.
        """
        promoter = importlib.import_module("unified_memory.promoter")
        schedule = importlib.import_module("unified_memory.infra.schedule")
        for value in (
            "plain",
            "with space",
            "C:\\Program Files\\Python\\python.exe",
            "it's",
            "--flag=值",
        ):
            self.assertEqual(promoter.shlex_quote(value), schedule.shlex_quote(value))

    def test_rebindable_index_db_survives_on_the_shim(self):
        """`memory.INDEX_DB` is the one global that must stay *at this path*.

        `infra.store.schema.index_db_for` reads it through `sys.modules`
        precisely so it never has to import `memory`, and the test isolation
        guard rebinds it per test. If the B5.2 split had left that global
        behind in a new module, rebinding would stop moving the derived index
        path and every test would quietly open the developer's real
        ``~/.unified-memory`` — the exact leak caught during B5.2.

        So the contract is not "equals schema.INDEX_DB" (that one is only the
        import-time fallback, and the guard moves the shim's copy away from it);
        it is "rebinding the shim's global moves the derived path".
        """
        import tempfile
        from pathlib import Path

        memory = importlib.import_module("unified_memory.memory")
        schema = importlib.import_module("unified_memory.infra.store.schema")
        scratch = Path(tempfile.mkdtemp(prefix="um-indexdb-"))
        original = memory.INDEX_DB
        try:
            memory.INDEX_DB = scratch / "rebound.db"
            derived = schema.index_db_for(scratch / "vault")
            self.assertEqual(derived.parent, scratch)
            self.assertTrue(derived.name.startswith("index-"))
        finally:
            memory.INDEX_DB = original
            for leftover in sorted(scratch.rglob("*"), reverse=True):
                leftover.unlink() if leftover.is_file() else leftover.rmdir()
            scratch.rmdir()


if __name__ == "__main__":
    unittest.main()
