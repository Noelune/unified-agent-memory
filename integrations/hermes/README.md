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
