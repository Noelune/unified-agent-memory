# unified-agent-memory — core

The dependency-free Python core of the unified agent memory system.

## Install

```sh
pip install -e ./core        # from this repository (editable, stdlib only)
# or from PyPI once published:  pip install unified-agent-memory-core
```

## Usage

```sh
memory init --vault ~/Documents/AgentMemory      # create the vault structure
memory submit "the staging server runs on 127.0.0.1:8080" --agent alpha
memory search "staging server"                   # output is <memory-data> wrapped
memory show prefs
memory status
memory doctor                                    # read-only health report
memory gc                                        # dry-run: what derived data could be pruned
memory gc --apply                                # prune orphan indexes, old logs, graph; VACUUM
memory scan-conflicts                            # re-scan stored facts for contradictions (dry-run; --apply enqueues)
memory verify-drift                              # re-check provenance facts against their session archives (dry-run; --apply enqueues; calls the LLM)

# promotion (the ONLY entry point, human-confirmed by default):
python -m unified_memory.promoter --review       # build the pending list
python -m unified_memory.promoter --apply        # promote into canonical notes
python -m unified_memory.promoter --auto         # one step (explicit opt-in)
python -m unified_memory.promoter adjudicate     # resolve conflicts interactively

# optional decay:
python -m unified_memory.forgetter --dry-run     # list candidates
python -m unified_memory.forgetter --apply       # demote into 记忆遗忘区/
```

`memory init` is the ONE initializer: it creates the vault skeleton, the
template notes and the config entry, and it is the only command that does.
Every other command (`status` / `submit` / `search` / …) reports
`vault structure: MISSING` and points here instead of creating anything —
so a stray read-only command can never stand up a half-initialized vault.

## Design

- Pure Python standard library — zero third-party dependencies.
- Config: `UNIFIED_MEMORY_VAULT` env or ~/.unified-memory.yaml.
- Local-first index: SQLite FTS5 at `~/.unified-memory/index-<vault-hash>.db`,
  isolated per vault and populated with redacted text. Schema upgrades rebuild
  the index automatically; old fixed-path `index.db` files are not read.
  Privacy stays on your machine; remote index is an optional advanced mode.
- Agents submit new content only into the submission inbox; core's own
  lifecycle (promotion / forgetting / repair / backfill) rewrites canonical
  notes through `infra.vault.apply` under the vault file lock.
- Both promotion-stamp dialects are parsed: the repo form
  `（写入 2026-08-16｜来源：Agent提交区/x.md）` and the Hermes form
  ``（写入 2026-09-22｜来源：[[Agent提交区/x.md]]，事件 `…`｜有效至 …）``.
  Lines carrying `｜有效至` are indexed as superseded history.
- Search output is wrapped in <memory-data> markers: vault content is DATA,
  never instructions. Credential-shaped lines are rejected/redacted.

See the repository root README and docs/DEPLOY.md for the full system.
