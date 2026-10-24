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

### 5. (Recommended) lifecycle schedules — owned by dsh, out of the box

The two lifecycle jobs are **daily promotion (03:00)** and **weekly forgetting
(Monday 04:00)**. Register both with one command:

```sh
python setup/setup.py cron --vault ~/Documents/AgentMemory
# Linux/macOS: crontab entries · Windows: Task Scheduler (schtasks)
# Equivalent manual flow: promoter --review → --apply (default, human-confirmed)
```

**dsh owns the lifecycle by default** (this project's primary audience runs
dsh; Hermes is not required). The dsh plugin additionally performs
**missed-run recovery**: when a schedule fired while dsh was not running, the
plugin replays the overdue job at its next startup (and re-checks hourly), so
submissions are promoted late rather than never. The run stamps live in
`50-Agent-Context/调度状态.json` inside the vault, which keeps a synced fleet
from double-running.

The OS schedules are the timer; dsh is the owner that catches what the timer
missed. In human-confirmed promotion mode, prefer having dsh drive
`promoter --review` → adjudicate → `--apply` as its daily task instead of the
registered `--auto` script (see *Full mode* below).

### What a working round trip looks like

```sh
memory submit "the staging server runs on 127.0.0.1:8080" --agent alpha
memory search "staging server"
# <memory-data> ... doc: 常用路径与环境.md ... </memory-data>
python -m unified_memory.promoter --review     # builds 待晋升.md
python -m unified_memory.promoter --apply      # promotes into canonical
python -m unified_memory.promoter --auto       # or one step (explicit opt-in)
```

### Conflicts — the agent decides first, you get asked only when it can't

When a new fact resembles an existing one but disagrees on the value, the
promoter does not overwrite: it queues the pair in
`情境信息/事实冲突待裁决.md`. Reading two lines, discarding the noise and
spotting the one differing slot is mechanical work, so the agent adjudicates
by default; a human is only asked when it genuinely cannot tell:

```bash
# What is in the queue (the panel and scripts both read this)
memory preview conflicts --json

# Agent can tell: rule directly, the reasoning lands in 事实冲突已裁决.md
memory decide <key> 并存  --why "一个是文件、一个是目录，两者不冲突"

# Agent cannot tell: leave a suggestion in plain words, the row stays for a human
memory advise <key> 并存  --why "两条都成立，取决于你要用哪个"

# Human does not want to click through: skim and skip (skip = defer, not a ruling)
memory decide <key> 跳过
```

The four rulings: `用新` (old line moves under `已取代`, new fact goes live),
`保留旧` (nothing written), `并存` (both stay live), `跳过` (nothing written and
the row stops asking). The panel shows the agent's judgement above the buttons
and tags the suggested one with `（Agent 建议）`; the ruling and its reasoning
are logged together, so six months later you can still see why it was decided.

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

### Daily promotion — owned by dsh by default, not a bare script

The daily promotion should be **run by an agent that has a scheduler**, not by
a dumb `cron` that fires a Python script. The promoter needs judgment: review
the pending list before promoting, adjudicate conflicts, decide on ambiguous
facts, and handle failures — that is agent work.

**dsh is the default owner** — this project ships as a dsh plugin and its
users do not necessarily run anything else. Give it an explicit daily task
(e.g. a scheduled prompt or a behavior rule):

1. Run `python -m unified_memory.promoter --review --vault <vault>` and **read
   the pending list** — do not blindly `--auto`.
2. For facts it cannot confidently classify, run
   `python -m unified_memory.promoter adjudicate --vault <vault>` and resolve
   each conflict.
3. Apply the reviewed promotion (`--apply`), run canonical hygiene, and the
   weekly forgetting scan.
4. **Missed-run recovery is built in**: every successful lifecycle run stamps
   its date into `50-Agent-Context/调度状态.json`, and `python -m
   unified_memory.catchup` replays whatever is overdue — the dsh plugin calls
   it automatically at startup and hourly. Submissions are promoted late,
   never lost.

Hermes users can alternatively point their existing daily dream-cron at the
promoter, and Codex / Claude Code schedulers work the same way. The promoter
itself is scheduler-agnostic — it only needs the vault path. The bare system
cron registered by `setup.py cron` (running `--auto`) is the fully-automatic
fallback; prefer the agent-driven review flow in human-confirmed mode.

### Scripts (generic lifecycle drivers)

`integrations/hermes/` ships three runnable, dependency-free scripts that let
any agent runtime (or, as a last resort, a bare system cron) drive the full
lifecycle — despite the directory name they are runtime-agnostic:

- `inject_context.py` — print a compact, redacted pack of the canonical notes
  for pre-turn injection (adapt the hook to your runtime's API).
- `daily_cron.py` — the full daily lifecycle: `--auto` promotes, `--repair`
  runs canonical hygiene, `--forget` runs the weekly scan on Mondays. Safe
  default (no flags) is review-only.
- `archive_session.py` — append a redacted session summary to
  `50-Agent-Context/会话归档/`.

For missed runs prefer the built-in `python -m unified_memory.catchup`
(`--check` to inspect, default runs the overdue jobs) over re-wiring
`daily_cron.py`; it shares the same state stamps as the OS schedules and the
dsh plugin.

All three scripts take `--vault` or `UNIFIED_MEMORY_VAULT`. Example hook
wiring is in `integrations/hermes/README.md` — the pattern works for any
Python-based agent.

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

`dsh plugin update` only replaces `lib/` and `core/`. **The other artifacts stay
on disk untouched**, and they are the ones that decide how agents behave:

| Artifact that can go stale | Symptom | What the reconcile pass does |
|---|---|---|
| `~/.unified-memory/bin/memory` (CLI shim) | Non-DSH agents fail with `No module named unified_memory` — reads like a broken install, but the shim's absolute path just points at a deleted directory | Reads the `PYTHONPATH=` line back, re-points at the current core |
| Managed sections in the agent instruction files | Agent follows last version's rules while tools enforce this version's behaviour; both look "fine" and logs show no conflict | Re-delegates to `deploy.py apply` (timestamped backup, nothing outside the section moves) |
| Vault template files | Documents mentioned in a new release's notes come back as `unknown document` | Adds only missing files (`COPYFILE_EXCL`); existing ones are never overwritten |
| Derived index | None (core rebuilds on open when `SCHEMA_VERSION` moved) | Reported, so the version switch is never silent |

The reconcile pass runs itself after the plugin loads — **never blocks startup,
never prompts, never throws into the host**. Order is `shim → vault →
instructions → registry → version record`, with the version written last: any
failed step leaves the record untouched and the whole pass retries on the next
boot. Writing the version first would stamp a half-applied upgrade as "done"
and it would never retry.

State lives in `~/.unified-memory/upgrade.json` (version, `corePath`, time, which
artifacts actually changed); the `/status` route's `upgrade` field hands
`fromVersion` / `toVersion` / `needsAttention` plus a problem summary to the
panel. On a machine that was never set up the pass does nothing — no recorded
version, no vault and no `~/.unified-memory` together mean `memory_setup` owns
the first install.

For maintainers: bumping `package.json`'s version is the only act required —
files added to `vault-template/`, changed section rules, a new `SCHEMA_VERSION`
and moved install directories all follow automatically. Design notes:
[docs/superpowers/specs/2026-10-20-plugin-upgrade-design.md](superpowers/specs/2026-10-20-plugin-upgrade-design.md).

- Core CLI is versioned; check CHANGELOG.md for changes.
- The DSH plugin targets DSH `0.2.0-rc.2`, `0.2.1-rc.2` and `0.2.1-rc.3`
  (CLI/Web and
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
