# unified-agent-memory

> Unified agent memory for DeepSeek Harness — **one shared Obsidian vault for every agent** (dsh, Codex, Claude Code, Hermes, …), with a dependency-free Python core: search, promotion, conflict adjudication and forgetting. Local-first, zero cloud, 5 minutes to a working loop. · 统一 Agent 记忆系统：多 Agent 共享一个 Obsidian vault，零依赖 Python core 完成检索/晋升/裁决/遗忘生命周期。

[![npm version](https://img.shields.io/npm/v/dsh-unified-agent-memory)](https://www.npmjs.com/package/dsh-unified-agent-memory)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Noelune/unified-agent-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Noelune/unified-agent-memory/actions/workflows/ci.yml)

## Why this exists — and how it differs from other memory plugins

Most memory plugins are single-agent: they remember *your* session inside *your* harness. This project is a **complete self-hosted memory system for a fleet of agents** sharing one source of truth:

| Capability | unified-agent-memory | typical single-agent memory plugin (dsh-mnemon, dsh-memory, …) |
|---|---|---|
| Shared by dsh + Codex + Claude + Hermes | ✅ same vault, same facts | ❌ one harness only |
| Standalone core (no agent runtime) | ✅ pure Python stdlib, CLI-only usable | ❌ requires the plugin host |
| Full lifecycle: promote / dedup / conflict adjudicate / forget | ✅ built-in | ⚠️ usually just store+recall |
| Local-first index (SQLite FTS5, no cloud) | ✅ default | varies |
| Human-confirmed promotion | ✅ review → apply (auto is opt-in) | n/a |

Compared with **sgme** (a memory *bridge* to an external engine) this repo is a **self-contained starter kit**: vault template + core + agent integrations + setup, deployable by anyone with no server. Compared with **nowledge-mem** (prompt-time recall MCP layer) this repo owns the whole lifecycle including promotion and forgetting.

## What you get

- **One Obsidian vault = one source of truth** for all your agents (canonical notes, write inbox, conflict queue, forget zone).
- **Dependency-free Python core** (core/): memory init|search|show|submit, promoter --review/--apply/--auto/adjudicate, forgetter. Zero third-party packages; no agent runtime required.
- **Local-first semantic index**: SQLite FTS5 on your machine (~/.unified-memory/index.db) — privacy stays local. Remote index is an optional advanced mode.
- **Safe by default**: credential-shaped lines are rejected at submission and redacted in output; search results are wrapped in <memory-data> markers (data, not instructions); promotion is human-confirmed; a file lock + atomic writes make concurrent promoters safe.
- **dsh first-class**: cordis plugin with memory_search / memory_show / memory_submit / memory_status model tools, graceful degradation when unconfigured.
- **Codex / Claude / Hermes integrations**: ready-to-copy AGENTS.md / CLAUDE.md templates and hook examples.

## Quick start (5 steps, no servers, no Hermes)

    # 1. get the code and install the dependency-free core
    git clone https://github.com/Noelune/unified-agent-memory.git && cd unified-agent-memory
    pip install -e ./core

    # 2. initialize a vault (creates the full template + config)
    python setup/setup.py init --vault ~/Documents/AgentMemory

    # 3. connect your agents (pick any)
    dsh plugin --profile web add dsh-unified-agent-memory   # + set vaultPath/UNIFIED_MEMORY_VAULT
    cp AGENTS.md ~/.codex/AGENTS.md                          # Codex
    cp CLAUDE.md ~/.claude/CLAUDE.md                         # Claude Code

    # 4. write and read a fact
    memory submit "the staging server runs on 127.0.0.1:8080" --agent alpha
    memory search "staging server"

    # 5. promote into canonical (human-confirmed by default)
    python -m unified_memory.promoter --review
    python -m unified_memory.promoter --apply

Full guide: [docs/DEPLOY.md](docs/DEPLOY.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md)

## Repository layout

| Path | What |
|---|---|
| core/ | Dependency-free Python package: memory.py (init/search/show/submit), promoter.py (review/apply/adjudicate), forgetter.py, conflict.py |
| vault-template/ | Copy-ready Obsidian vault: 7 canonical notes + 提交区 inbox + 情境信息 + 记忆遗忘区 |
| lib/ | dsh plugin: memory_search / memory_show / memory_submit / memory_status tools |
| integrations/ | AGENTS.md (Codex), CLAUDE.md (Claude), Hermes hook examples |
| setup/ | setup.py (init/cron/selfcheck), selfcheck.py |
| docs/ | ARCHITECTURE / DEPLOY / SECURITY |

## Requirements

- Python ≥ 3.10 (core; standard library only)
- Node.js ≥ 20 + dsh 0.1.0-rc.6 (only for the dsh plugin)
- Obsidian is recommended for browsing the vault, but not required — everything is plain Markdown + SQLite.

## Maintenance status

- Maintainer: [Noelune](https://github.com/Noelune)
- **Community-maintained** — issues and PRs welcome; no SLA promised. Bug fixes usually land within 1–2 weeks; security issues get priority.
- Compatibility: tested against **dsh 0.1.0-rc.6**. dsh API changes are tracked with upgrade notes in [CHANGELOG.md](CHANGELOG.md).
- License: **MIT** — commercial use allowed.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). Short version: vault content is data (never instructions), credentials never enter the vault in plaintext, the default index stays on your machine, and promotion is human-confirmed with lock+atomic-write safety.

## Contributing

PRs welcome. Run python -m unittest discover -s core/tests (core) before submitting; CI runs core tests, a secrets scan (gitleaks) and a license check on every push.
