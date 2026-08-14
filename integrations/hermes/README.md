# Hermes integration (full mode, optional)

The memory core is **completely independent of Hermes** — the vault, the
inbox, the promoter and the forgetter run on pure Python. Hermes is just one
more agent that can read and write the same vault.

## What you get by wiring Hermes in

1. **Context injection** — before each turn, inject a compact pack of the
   canonical notes (read-only) so the model starts from the vault's truth.
2. **Daily promotion** — schedule `python -m unified_memory.promoter --auto`
   at 03:00 (system cron / Windows Task Scheduler / Hermes' own scheduler).
3. **Tools** — expose `memory_search` / `memory_show` / `memory_submit`
   the same way the dsh plugin does.

## Minimal hook sketch (adapt to YOUR Hermes version)

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
