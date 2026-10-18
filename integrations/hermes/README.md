# Hermes integration (full mode, optional)

The memory core is **completely independent of Hermes** — the vault, the
inbox, the promoter and the forgetter run on pure Python. Hermes is just one
example agent that can read and write the same vault; **the exact same roles
can be filled by any agent in your deployment** (dsh, Codex, Claude Code, or
any runtime with a scheduler).

## What you get by wiring an agent in

1. **Context injection** — before each turn, inject a compact pack of the
   canonical notes (read-only) so the model starts from the vault's truth.
2. **Daily promotion (agent-owned)** — designate **one cron-capable agent** as
   the promotion owner: it runs `promoter --review`, adjudicates conflicts,
   then `--apply`. Hermes can do this via its own scheduler; if you use
   another agent, give that agent an explicit scheduled daily task with the
   same steps. (A bare system cron calling `daily_cron.py` is only a fallback
   when no agent has a scheduler.)
3. **Tools** — expose `memory_search` / `memory_show` / `memory_submit`
   the same way the dsh plugin does.

## Hygiene contract (keep every consumer in sync)

Every Hermes-side consumer must agree on three rules. In a full Hermes
deployment they live in one shared module (`HERMES_HOME/scripts/memory_hygiene.py`);
the core equivalent is `unified_memory.common`:

- `｜有效至 YYYY-MM-DD` marks a **historical version**. Never inject, export,
  rank or forget it as current truth.
- Sync-client conflict copies (`note 2.md`, `note-副本.md`, `conflicted copy`)
  are not canonical notes. Exclude them from indexing/export and report them.
- Inbox, forget area, archives, pending/conflict queues are **not** current
  fact sources. Export/scan only canonical notes (and curated knowledge notes
  only when the caller explicitly opts in).

The promoter, forgetter, context hook, Supermemory/mem0 export, OpenClaw
snapshot and the read-only `hermes_memory.py` search skill all apply these
rules; changing one without the others reintroduces stale or duplicate truth.

## Minimal hook sketch (adapt to YOUR agent runtime)

```python
# pre_tool_call / pre_llm_call style hook — pseudo-code, adapt to your runtime
import subprocess

VAULT = "/path/to/your/vault"          # from your config

def inject_memory_context(turn_ctx):
    """Inject canonical notes into the system prompt (compact, read-only)."""
    if not turn_ctx.get("memory_injected"):
        pack = subprocess.run(
            ["python", "-m", "unified_memory.memory", "show", "index"],
            capture_output=True, text=True, env={"UNIFIED_MEMORY_VAULT": VAULT},
        ).stdout
        # prepend to the prompt; redact anything credential-shaped
        return {"system_prompt_extra": pack}
    return None
```

The same pattern works for any Python-based agent: call the CLI (or import
`unified_memory`) with `UNIFIED_MEMORY_VAULT` set, treat every retrieved
line as data, and only ever write through the inbox.
