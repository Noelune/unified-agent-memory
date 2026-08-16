# Changelog

All notable changes to this project are documented in this file.

## [0.3.0] — 2026-08-16

### Added — fused memory architecture (informed by rohitg00/agentmemory & TencentDB-Agent-Memory)

- **`index.py` — memory database (derived copy of the vault)**. Per-vault SQLite
  now holds `memories` (one record per canonical fact line: type / importance /
  status / version / superseded_by / source_agent / created / updated /
  access_count), `embeddings` (Float32 vectors), `access_log`, `graph_nodes` /
  `graph_edges` and `audit`, alongside the legacy `docs`/`fts` tables. Incremental
  rebuild by content digest.
- **`embed.py` — optional semantic vectors**. `memory embed` uses SiliconFlow
  `Qwen/Qwen3-Embedding-4B` (1024 dims) to embed every memory line; API key from
  `SILICONFLOW_API_KEY` or `~/.unified-memory/secrets.yaml`; graceful degradation
  to BM25 when unavailable.
- **`search.py` — hybrid retrieval**. `memory search --hybrid` fuses BM25 +
  vectors + concept graph with weighted RRF, diversifies per note, and caps
  output by a token budget (`--format`, `--budget`).
- **`digest.py` — session summarization (default on)**. Extracts durable facts
  from archived sessions via a lightweight LLM call into the submission inbox;
  cursor-idempotent, `--dry-run` preview, `--off` to disable.
- **`graph.py` — optional concept graph** (ASCII + CJK-bigram co-occurrence)
  feeding the third retrieval stream.
- **Supersession in the promoter**. Replacement cues (“改用/迁移到/instead of”)
  move the superseded old line under a `已取代` section instead of the conflict
  queue; the index marks it `superseded`.
- **Scored forgetting**. `forgetter.py` now uses `importance × (durable floor +
  decay) + access-reinforcement` instead of a plain 90-day rule.
- **Chinese-aware classification** in the promoter (偏好/路径/端口/服务器/规则 …)
  so non-English facts route to the correct canonical note.
- **Canonical filenames aligned to the live vault** (`工具可用性检查.md`,
  `UI审美准则.md`, `Codex-Claude-Hermes协作规则.md`) and the vault template /
  fallback template updated to match.

### Changed

- `core` index/search logic consolidated into `index.py`; `memory.py` delegates
  and keeps its public call shapes (`search_index`, `index_db_for`,
  `update_index`) so the remote server and existing tests keep working.
- **HKMemory SSH recall deprecated and removed.** The external Hermes semantic
  memory provider (`HKMEMORY_SSH_HOST`, `--hk`, the `_hkmemory` SSH bridge) is
  deleted. Its recall role is fully replaced by the fused local hybrid
  retrieval (`search.py`: BM25 + SiliconFlow vectors + concept graph) — the
  same capability the two reference projects provide, but local-first, faster
  and without an SSH/server dependency. The dsh plugin no longer passes
  `--hk`/`noHk`.

## [0.2.1] — 2026-08-15

### Fixed

- `memory search --remote` no longer requires a local vault: a pure remote
  client can query the remote index without any local vault (the local
  fallback still needs one). Reported by Codex review.
- `archive_session.py` appends under the vault file lock so concurrent
  post-turn hooks never drop each other's blocks on the same daily file.

## [0.2.0] — 2026-08-15

### Changed — deployment is now agent-driven (the only supported way)

- **New `docs/AGENT-DEPLOY.md`** — a self-contained deploy task book for DSH:
  full memory rules, per-agent global-instruction specs (dsh / Codex / Claude
  Code / Hermes), write conventions, step-by-step flow, verification checklist
  and pitfalls. On a fresh install DSH reads it and wires every agent itself.
- **`setup.py agents` is deprecated** — scripted writing of global instruction
  files was removed on purpose (each agent's prompt must be tailored to its own
  file format); the command now prints the agent-driven guidance only. The dead
  template/wiring code was deleted.
- **Plugin surfaces deployment guidance**: `memory_status` (and the
  not-configured message) now point DSH to `docs/AGENT-DEPLOY.md` and check the
  vault structure, so a fresh install is self-discoverable.

### Fixed

- **npm package now ships the Python core** (`core/` sources in the tarball).
  `corePath` already defaulted to `<plugin>/core`; previously the tarball did
  not include it, so the four tools failed on a bare npm install. No `pip
  install` is needed for the plugin tools (PYTHONPATH is injected). `.npmignore`
  and a glob-based `files` entry keep `__pycache__`/`.pyc` out of the tarball.
- **npm package ships the full deploy surface**: `vault-template/`,
  `integrations/hermes/` scripts and all docs are now in the tarball, so a bare
  npm install can create a complete vault (`memory init`), run the Hermes-style
  scripts, and resolve the doc links. The agent-driven task book documents the
  npm-only equivalents of `setup.py` (`memory init` / `memory status`).
- Removed stale `pip install unified-agent-memory-core` hints — that package is
  not on PyPI yet; the plugin-bundled core is the supported path.

### Added

- `memory search --remote`: real remote-index client — Bearer-token HTTP query
  against `setup/remote_index_server.py`; falls back to the local index (with a
  stderr note) when unconfigured, unreachable, or the token is rejected.
- `setup/remote_index_server.py`: dependency-free remote index server
  (`GET /health`, `POST /search`, Bearer token).
- `promoter --repair-existing`: conservative canonical hygiene (exact
  duplicates + template placeholders) with automatic backup and `--dry-run`.
- `memory show <doc>`: accept any canonical note under `50-Agent-Context`
  (structured-fact notes) in addition to the built-in ids.
- `integrations/hermes/`: runnable `inject_context.py`, `daily_cron.py`,
  `archive_session.py` scripts (context injection, full daily lifecycle,
  session archiving into `会话归档/`).
- Vault template: `50-Agent-Context/会话归档/` session-archive folder.
- dsh plugin `memory_search`: optional `remote` parameter.

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
