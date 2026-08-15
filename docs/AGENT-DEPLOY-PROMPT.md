# Agent Deployment Prompt

Use with: `https://github.com/Noelune/unified-agent-memory`

Hand the **repository URL** and the **entire code block below** to any AI
coding agent (Claude Code, Codex, DeepSeek Harness, …). The agent will ask
you 4 questions, install the system, verify it works, and report back.

```text
You are deploying **unified-agent-memory** for the user: a shared
Obsidian-vault memory system for AI agents, with a dependency-free Python
core (search / promotion / conflict adjudication / forgetting). One vault is
the single source of truth; every agent reads canonical notes and writes new
facts into a submission inbox.

## Step 1 — Read before doing anything
Clone or open the repository, then read, in order:
1. README.md
2. docs/DEPLOY.md
3. docs/ARCHITECTURE.md
4. docs/SECURITY.md

Do not start installing until you understand standalone mode (default: local
machine, no server, no cloud).

## Step 2 — Ask 4 questions (one at a time, with defaults)
Ask exactly these four questions. For each: state the default, wait for the
answer, record it. If the user says "default" / "your call", use the default.

Q1. **Main agent** — who should own the daily promotion cron?
    a) This agent (the one you are talking to)      [default]
    b) A specific runtime you name (dsh, Codex, Claude Code, ...)
    c) Nobody — promotion stays manual only
Q2. **Index location** — local machine or remote server?
    a) Local machine — zero-config, privacy stays local   [default]
    b) Remote server — advanced; the user must have their own server
Q3. **Promotion mode** — human-confirmed or fully automatic?
    a) Human-confirmed — `promoter --review` → `--apply`   [default]
    b) Fully automatic — `promoter --auto` on a schedule (explicit opt-in)
Q4. **Agents to connect** — which integrations should be installed?
    a) dsh plugin     b) Codex (AGENTS.md)
    c) Claude Code (CLAUDE.md)    d) None for now (CLI only)
    Default: install the ones the user actually uses (ask if unsure).

## Step 3 — Install and configure
1. Get the code: `pip install -e ./core` (from the repo). If the user
   prefers, `npm install dsh-unified-agent-memory` for the dsh plugin.
2. Initialize the vault:
   `python setup/setup.py init --vault <path>`
   Default path: `~/Documents/AgentMemory` (confirm if unclear).
3. Configure per Q2:
   - Local (default): nothing to do — the index lives at
     `~/.unified-memory/index-<vault-hash>.db`, is isolated per vault, and is
     built on first search. Old fixed-path `index.db` files are not read.
   - Remote: ask for the server address/credentials, write the remote index
     config, and confirm local search still works when remote is unreachable
     (graceful degradation). Never store the server password in the vault or
     config — point the user at their OS secret store.
4. Scheduling per Q1 + Q3:
   - If a main agent was chosen AND Q3 is fully automatic: register a
     **daily promotion cron** on that agent running the full lifecycle:
     `promoter --auto`, surface conflicts for adjudication, canonical
     hygiene, and the weekly forgetting scan. Enable **missed-run recovery**
     so a run due while the agent was offline fires immediately on the
     agent's next startup:
       - systemd timer: `Persistent=true`
       - Windows Task Scheduler: check "Run task as soon as possible after
         a scheduled start is missed"
       - an agent runtime's built-in scheduler: run the promotion right at
         startup when the previous run was missed
     Goal: promotion is delayed at worst, never skipped.
   - If Q3 is human-confirmed: leave the default `--review` → `--apply`
     flow. Do NOT enable `--auto`.
5. Connect agents per Q4:
   - dsh: `dsh plugin --profile web add dsh-unified-agent-memory`, then set
     `vaultPath` (or `UNIFIED_MEMORY_VAULT`) to the vault.
   - Codex: copy `AGENTS.md` to `~/.codex/AGENTS.md`.
   - Claude Code: copy `CLAUDE.md` to `~/.claude/CLAUDE.md`.
   - None: just document the `memory search|show|submit` CLI.

## Step 4 — Verify (mandatory)
1. `python setup/setup.py selfcheck --vault <path>` — must pass.
2. Round trip with neutral data only:
   `memory submit "deployment smoke test <today>" --agent alpha`
   `python -m unified_memory.promoter --review`  → the fact appears in the
        pending list
   `python -m unified_memory.promoter --apply`   → promotes it (neutral data)
   `memory search "deployment smoke test"`       → returns the match inside
        `<memory-data>` markers
   In fully automatic mode the cron does the same thing; running `--apply`
   here just confirms the loop works on neutral data.
3. If dsh was installed: confirm `dsh plugin --profile web list` shows it and
   the `memory_*` tools are registered.

## Step 5 — Report
Tell the user, in plain language:
- what was installed and where (paths)
- the answers they gave to Q1–Q4
- what they still must do manually (restart dsh, first promotion, adjudicate
  conflicts, remote-server setup, ...)
- any errors you hit and how you fixed them

## Hard rules
- NEVER ask for, store, echo, or log API keys, tokens, passwords, or private
  keys. If the user offers a credential, refuse to write it into the vault or
  any config file; recommend their OS secret store.
- Touch only the vault path and config files you declared. Do not scan or
  modify anything else on the machine.
- If `selfcheck` fails, do NOT claim success — report the failure and what is
  needed to fix it.
- Use only neutral test data (no real personal facts).
- If anything is ambiguous, ask one focused question instead of guessing.
```
