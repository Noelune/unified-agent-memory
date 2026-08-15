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

### 5. (Recommended) daily promotion is owned by a cron-capable agent

Do **not** rely on a bare system cron. Designate one agent in your deployment
that has a scheduler (dsh / Codex / Claude Code / Hermes) as the promotion
owner and give it a scheduled daily task: `promoter --review` → adjudicate →
`--apply` (see *Full mode* below). Only when **no** agent has a scheduler,
fall back to the script:

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

### Daily promotion — owned by a cron-capable AGENT, not a bare script

The daily promotion should be **run by an agent in your deployment that has a
scheduler** (dsh, Codex, Claude Code, Hermes, or any agent runtime with cron),
**not** by a dumb `cron` that fires a Python script. The promoter needs
judgment: review the pending list before promoting, adjudicate conflicts,
decide on ambiguous facts, and handle failures — that is agent work.

Pick **one agent with a built-in scheduler as the promotion owner** and give
it an explicit daily task (e.g. a scheduled prompt or a behavior rule):

1. Run `python -m unified_memory.promoter --review --vault <vault>` and **read
   the pending list** — do not blindly `--auto`.
2. For facts it cannot confidently classify, run
   `python -m unified_memory.promoter adjudicate --vault <vault>` and resolve
   each conflict.
3. Apply the reviewed promotion (`--apply`), run canonical hygiene, and the
   weekly forgetting scan.
4. Implement **missed-run recovery**: if the scheduled time passes while the
   agent is not running, fire the promotion on its next startup — submissions
   are then promoted late, never lost.

Hermes users can point their existing daily dream-cron at the promoter; if
Hermes is not present, **the same role goes to whichever of dsh / Codex /
Claude Code has a scheduler**. The promoter itself is scheduler-agnostic — it
only needs the vault path. A bare system cron calling the script is a fallback
only when **no** agent in the deployment has a scheduler.

### Scripts (fallback, when no cron-capable agent exists)

`integrations/hermes/` ships three runnable, dependency-free scripts that let
an agent runtime (or, as a last resort, a bare system cron) drive the full
lifecycle:

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
