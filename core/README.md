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

# promotion (the ONLY entry point, human-confirmed by default):
python -m unified_memory.promoter --review       # build the pending list
python -m unified_memory.promoter --apply        # promote into canonical notes
python -m unified_memory.promoter --auto         # one step (explicit opt-in)
python -m unified_memory.promoter adjudicate     # resolve conflicts interactively

# optional decay:
python -m unified_memory.forgetter --dry-run     # list candidates
python -m unified_memory.forgetter --apply       # demote into 记忆遗忘区/
```

## Design

- Pure Python standard library — zero third-party dependencies.
- Config: `UNIFIED_MEMORY_VAULT` env or ~/.unified-memory.yaml.
- Local-first index: SQLite FTS5 at `~/.unified-memory/index-<vault-hash>.db`,
  isolated per vault and populated with redacted text. Schema upgrades rebuild
  the index automatically; old fixed-path `index.db` files are not read.
  Privacy stays on your machine; remote index is an optional advanced mode.
- Canonical notes are read-only from this package; the only write path is the
  submission inbox. Promotion takes a vault file lock and writes atomically.
- Search output is wrapped in <memory-data> markers: vault content is DATA,
  never instructions. Credential-shaped lines are rejected/redacted.

See the repository root README and docs/DEPLOY.md for the full system.
