# sessiondb — reading `state.db` without inheriting it

`digest` distils durable facts from archive Markdown. Sessions that were never
archived as Markdown therefore never became facts: they sit in Hermes's
`state.db` and nothing reads them.

This document records the measurement that made that worth fixing, and the
constraints the fix had to respect.

## The measured gap

Read on 2026-10-19 from `%LOCALAPPDATA%\hermes\state.db`
(`schema_version = 32`, 841 MB):

| Quantity | Value |
| --- | --- |
| Sessions in `state.db` | 369 |
| Messages | 22 198 |
| Date range | 2026-05-16 .. 2026-10-19 |
| Days with an archive file | 42 of 61 |
| Sessions on days **without** an archive file | 191 |
| Messages on those days | 8 616 |
| …all of them between | 2026-05-30 and 2026-08-28 |

So the gap is real but historical: it is the window before the archiver was
running. From 2026-09 onward the archive is complete, which means this is not a
standing leak — it is a backlog that was never backfilled.

That distinction drives the design. A permanent, tightly coupled reader would
be the wrong shape for a historical backlog.

## What was built

`core/unified_memory/sessiondb.py`, a read-only adapter with three guarantees:

1. **It cannot write.** The connection is opened as `file:<path>?mode=ro`,
   so no statement in the module — or in a future edit to it — can modify an
   841 MB production database. `test_the_database_is_opened_read_only` asserts
   both that the file's mtime/size are unchanged after a read *and* that a
   `DELETE` through the module's own connection is refused by SQLite.

2. **It cannot silently break on an upgrade.** Hermes owns this schema and
   bumps `schema_version` across releases. `probe()` checks the four columns
   the module actually uses (`sessions.id`, `sessions.started_at`,
   `messages.session_id`, `messages.role`, `messages.content`,
   `messages.timestamp`) and raises `SessionDbUnavailable` naming the ones that
   disappeared. A digest run then degrades to a reported skip instead of dying
   with a `KeyError` halfway through.

3. **It sends nothing sensitive downstream.** Transcripts are redacted inside
   this module, before they can reach the LLM, and `tool` / `session_meta`
   messages are dropped — 11 615 of 22 198 messages on the measured machine are
   tool output, which is both noise and the most likely place for a credential
   to appear.

## Where the boundary is

The adapter does **not** teach `digest` about SQLite, and `digest` does not
teach `sessiondb` about fact extraction. The only thing that crosses is the
contract the archive already produced:

```python
[(date: str, transcript: str), ...]
```

`digest(..., source="state")` uses it; `digest(..., source="archive")` keeps
its own path. Each source stores its own cursor (`digest_cursor` vs
`digest_cursor_state`), so switching sources never consumes a date the other
one handled or replays one it already did.

## Chunking, not truncation

A day is not a unit of work. On the measured machine, 2026-06-01 alone holds
126 sessions and 5 925 messages; clipping the day to digest's 6 000-character
LLM budget would keep one session's tail and discard the rest. Sessions are
therefore packed into `cap`-sized chunks on **session** boundaries, so a busy
day produces several digest units. Measured effect on the backlog window
(`--since 2026-05-29`): 19 units / 97 633 chars before, 171 units / 764 620
chars after.

## Backfill is not a canonical write

`export_markdown()` writes archive-format `YYYY-MM-DD.md` files into a
directory **the caller names** — never into the vault. Canonical notes have a
single declared writer (`common.assert_canonical_writable`), and a read-only
adapter does not get to become a second writer just because its output looks
like an archive file. The operator decides whether to import the result:

```bash
python -m unified_memory.sessiondb --status
python -m unified_memory.sessiondb --since 2026-05-29 --dry-run
python -m unified_memory.sessiondb --since 2026-05-29 --export ./staging
```

## Not done, on purpose

- **No automatic scheduling.** `--source state` is opt-in on every run. Pointing
  a cron entry at an 841 MB database and an LLM is a decision the operator
  makes with the numbers in hand.
- **No write-back.** Nothing here is ever written back into `state.db`.
- **No L4 revival.** `memory_store.db` remains marked as retired in the memory
  spec; this module does not feed it.
