# Deployment Guide

Two modes:

- **Standalone mode (default)** — the core + vault + your agents. No Hermes,
  no servers, no cloud. Everything runs on your machine.
- **Full mode (advanced)** — additionally wiring an agent runtime's scheduler
  (e.g. Hermes' daily cron) and, optionally, a remote semantic index on your
  own server.

---

## Standalone mode (default)

### 1. Get the code and install the core

```sh
git clone https://github.com/Noelune/unified-agent-memory.git
cd unified-agent-memory
pip install -e ./core          # dependency-free; standard library only
```

### 2. Initialize a vault (one command)

```sh
python setup/setup.py init --vault ~/Documents/AgentMemory
```

This creates the full vault template (7 canonical notes, 提交区 inbox,
情境信息, 记忆遗忘区), writes the vault path into ~/.unified-memory.yaml, and
drops AGENTS.md / CLAUDE.md next to the vault.

> **Windows note**: use a native Windows path (e.g. `C:\Users\you\Documents\AgentMemory`)
> or a plain absolute POSIX-style path (`C:/Users/...`). Paths starting with a
> single slash like `/tmp/...` are interpreted as drive-relative (`C:\tmp\...`)
> by Python on Windows — if you are inside Git-Bash/MSYS, prefer
> `$HOME/Documents/AgentMemory` or the explicit `C:/` form.

### 3. Connect agents — agent-driven (the only supported way)

Wiring agents into the shared memory is done **by DSH, not by a script**: each
agent's global instruction file has its own format and conventions, so the
deployer reads the task book and writes each file itself.

1. `dsh plugin --profile web add dsh-unified-agent-memory`
2. In the next DSH session, call `memory_status` — on a fresh install it
   prints a deployment notice pointing to `docs/AGENT-DEPLOY.md`.
3. Have DSH read **`docs/AGENT-DEPLOY.md`** and follow it end-to-end. It:
   - checks/creates the vault and installs the Python core;
   - writes the shared memory rules into `~/.dsh/AGENTS.md`, `~/.codex/AGENTS.md`,
     `~/.claude/CLAUDE.md` and the Hermes-style agent's behavior file (per-agent
     specs, backups, idempotent, no overwrites);
   - verifies with `selfcheck` and reports per-agent results.

> The old `setup.py agents` scripted wiring is **deprecated** and only prints
> this guidance now. `setup.py init / cron / selfcheck` are still the
> deterministic parts (vault creation, cron registration, verification) and
> remain available.

### 4. Verify

```sh
python setup/setup.py selfcheck
```

### 5. (Optional) schedule daily promotion

```sh
python setup/setup.py cron --vault ~/Documents/AgentMemory
# Linux/macOS: crontab entry · Windows: Task Scheduler (schtasks)
# Equivalent manual flow: promoter --review → --apply (default, human-confirmed)
```

### What a working round trip looks like

```sh
memory submit "the staging server runs on 127.0.0.1:8080" --agent alpha
memory search "staging server"
# <memory-data> ... doc: 常用路径与环境.md ... </memory-data>
python -m unified_memory.promoter --review     # builds 待晋升.md
python -m unified_memory.promoter --apply      # promotes into canonical
python -m unified_memory.promoter --auto       # or one step (explicit opt-in)
```

---

## Full mode (advanced, optional)

### Daily promotion via an agent runtime's scheduler

The promoter itself is scheduler-agnostic. Hermes users can point their
existing daily dream-cron at the open-source promoter:

```sh
python -m unified_memory.promoter --auto --vault ~/Documents/AgentMemory
```

That is the ONLY Hermes involvement — the promoter, vault and index run
without Hermes. See integrations/hermes/README.md for context-injection hook
examples (adapt to your runtime's API).

### Main-agent scheduling (recommended)

For a fleet of agents, designate **one agent that has a built-in scheduler
as the main agent** and let it own the daily promotion cron. Give that cron
the full lifecycle — promote with `--auto`, surface conflicts for
adjudication, run canonical hygiene, and the weekly forgetting scan — and
implement **missed-run recovery**: if the scheduled time passes while the
agent is not running, fire the promotion immediately on the agent's next
startup. Submissions are then promoted late, never lost.

### Hermes integration scripts (ready to run)

`integrations/hermes/` ships three runnable, dependency-free scripts that let
any agent runtime behave like the full reference deployment:

- `inject_context.py` — print a compact, redacted pack of the canonical notes
  for pre-turn injection (adapt the hook to your runtime's API).
- `daily_cron.py` — the full daily lifecycle: `--auto` promotes, `--repair`
  runs canonical hygiene, `--forget` runs the weekly scan on Mondays. Safe
  default (no flags) is review-only.
- `archive_session.py` — append a redacted session summary to
  `50-Agent-Context/会话归档/`.

All three take `--vault` or `UNIFIED_MEMORY_VAULT`. Example hook wiring is in
`integrations/hermes/README.md` — the pattern works for any Python-based agent.

### Remote index server (optional)

To let other machines search the same facts without sharing the vault, run the
included dependency-free server on a machine that can reach the vault:

```sh
python setup/remote_index_server.py --vault ~/Documents/AgentMemory --token <t> --host 127.0.0.1 --port 8437
```

Then point clients at it:

```sh
export UNIFIED_MEMORY_REMOTE_URL=http://127.0.0.1:8437
export UNIFIED_MEMORY_REMOTE_TOKEN=<t>
memory search "staging server" --remote
```

A token stops forgery, NOT eavesdropping — for anything beyond localhost,
terminate TLS in front of the port. If the server is unreachable or the token
is wrong, `--remote` falls back to the local index with a stderr note.

**Structured facts (advanced):** keep entity-style facts in their own note
under `50-Agent-Context/` (e.g. `实体.md`) and read them with
`memory show 实体.md`.

Details are deployment-specific; the core never sends vault content anywhere
unless you configure a remote endpoint yourself.

## Upgrading

- Core CLI is versioned; check CHANGELOG.md for changes.
- The dsh plugin is tested against dsh 0.1.0-rc.6; dsh API changes are
  tracked with upgrade notes in CHANGELOG.md.
