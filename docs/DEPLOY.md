# Deployment Guide

Two modes:

- **Standalone mode (default)** — the core + vault + your agents. No Hermes,
  no servers, no cloud. Everything runs on your machine.
- **Full mode (advanced)** — additionally wiring an agent runtime's scheduler
  (e.g. Hermes' daily cron) and, optionally, a remote semantic index on your
  own server.

---

## Standalone mode (default)

### 0. Which installation do you have?

There are two shapes, and they differ in **what you already have on disk**:

| | npm/plugin install | git clone |
|---|---|---|
| What you ran | `dsh plugin add dsh-unified-agent-memory` (or the Desktop plugin page) | `git clone …` |
| Plugin host/client bundles | ✅ inside the package | ✅ after `npm run build` |
| Python core (`core/`) | ✅ shipped in the package | ✅ |
| Vault template | ✅ shipped | ✅ |
| `setup/` scripts | ✅ shipped (since 0.7.0) | ✅ |
| Agent instruction templates | ✅ shipped (since 0.7.0) | ✅ |
| Docs | ✅ shipped | ✅ |

Everything needed for the standalone flow ships inside the package. Earlier
releases omitted `setup/` and the `integrations/{codex,claude}` templates, so an
npm install could not initialize a vault or copy the agent files; 0.7.0 includes
them. Locate the installed package with:

```sh
npm root -g                      # if installed globally
# or, inside a dsh profile:
<harness home>/profiles/<profile>/node_modules/dsh-unified-agent-memory
```

Throughout this document, `<pkg>` means that directory. A clone is equivalent —
run the same commands from the repository root.

### 1. Install the core (optional)

The plugin auto-adds its bundled `core/` to `PYTHONPATH`, so **no install step is
required** for the tools to work. Install it only if you also want the `memory`
CLI on your `PATH`:

```sh
pip install -e <pkg>/core          # dependency-free; standard library only
```

### 2. Initialize a vault (one command)

```sh
python <pkg>/setup/setup.py init --vault ~/Documents/AgentMemory
```

This creates the full vault template (7 canonical notes, 提交区 inbox,
情境信息, 记忆遗忘区), writes the vault path into ~/.unified-memory.yaml, and
drops AGENTS.md / CLAUDE.md next to the vault.

> The plugin reads that same `~/.unified-memory.yaml`, so **you do not also need
> to set `vaultPath`** in the plugin config. Setting it explicitly is still
> supported and takes precedence; see step 4.

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

   Using the **Desktop** app instead? It runs its own `desktop` profile, so the
   command above has no effect there — and the CLI **cannot** manage that
   profile: `dsh plugin --profile desktop …` is refused with *"profile "desktop"
   is managed exclusively by the Electron application"*. Install from the
   Desktop app's own plugin page instead. See [DESKTOP.md](DESKTOP.md).
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

### Health check and housekeeping

Run `memory doctor` after deployment and whenever memory behaves oddly. It is a
single read-only pass over the vault, the derived index and the lifecycle
queues; `--json` returns the same report for a scheduler. A non-zero exit means
at least one `error` (use `--strict` to fail on warnings too).

```sh
memory doctor              # human-readable issue list
memory doctor --json       # {"ok": bool, "command": "doctor", "data": {...}}
memory gc                  # dry-run: list prunable derived data
memory gc --apply          # remove orphan index DBs older than 30 days,
                           # prune old access log/query cache, rebuild the
                           # bounded graph and VACUUM
```

`memory gc` never touches canonical notes, the inbox, session archives or the
forget area. Use `--keep-orphans` when you only want the graph rebuild/VACUUM,
and `--older-than N` to change the orphan-index age threshold.

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
- The DSH plugin targets DSH `0.2.0-rc.2` and `0.2.1-rc.2` (CLI/Web and
  Desktop); `0.1.5-rc.2` remains inside the declared peer range but is no longer
  re-tested. Since DSH `0.2.0` the host validates the plugin's
  `@deepseek-ai/dsh*` peer ranges *before* importing it and skips a bundle whose
  peers do not match, so a DSH upgrade can remove the tools without any error in
  the UI. Check the version line first; see [DESKTOP.md](DESKTOP.md#2-the-compatibility-gate-read-this-before-upgrading-dsh).
- For global instruction deployment, use `python setup/deploy.py preview`
  first, then `apply` only after reviewing the diff. The deployer recognizes
  only existing allowlisted instruction files, writes one marker-delimited
  section, takes a backup, uses atomic replacement, and supports `rollback`.
  It never edits canonical vault notes, sessions, credentials, or arbitrary
  runtime configuration.
