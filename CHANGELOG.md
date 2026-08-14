# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] — 2026-08-15

### Fixed

- **`file_lock` now prints a one-time "waiting for lock …" notice to stderr**
  while another writer holds the lock, instead of waiting silently for up to
  30 s (the timeout error itself was already clear; the wait in between was not).

### Docs

- **DEPLOY.md: Windows vault-path note** — paths like `/tmp/...` are
  drive-relative on Windows (`C:\tmp\...`); use `C:/...` or `$HOME/...` forms.

## [0.1.0] — 2026-08-14

### Added

- **Dependency-free Python core** (core/): memory init/search/show/submit (local SQLite FTS5 index with <memory-data> output markers), promoter review/apply/auto/adjudicate (classification, dedup, char-bigram conflict detection, file lock + atomic writes, inbox archiving), forgetter (90-day decay, reversible).
- **Vault template** (vault-template/): 7 canonical notes, 提交区 inbox, 情境信息 (pending/conflicts), 记忆遗忘区.
- **dsh plugin** (repo root): memory_search / memory_show / memory_submit / memory_status model tools; graceful degradation when unconfigured; optional sidebar status panel.
- **Integrations**: AGENTS.md (Codex), CLAUDE.md (Claude Code), Hermes hook examples.
- **Setup**: setup.py init/cron/selfcheck; standalone deployment documented (no Hermes required; Hermes dream-cron is just one optional scheduler).
- **Docs**: ARCHITECTURE / DEPLOY (standalone + full mode) / SECURITY; bilingual README.
- **CI**: core unit tests (unittest), gitleaks secrets scan, license check on every push.
