# DSH memory adapters

This document separates the three layers that are often called “Agent-memory”.
They are related, but they do different jobs and have different write rights.

## Components

| Component | What it does | Write boundary |
|---|---|---|
| `unified-agent-memory` | Pure-Python core: vault index, BM25/vector/graph recall, promotion, conflict handling, forgetting and optional digest | Reviewed promoter writes canonical notes; normal tools write only the inbox |
| `dsh-hermes-memory` | DSH host tools (`memory_status`, `memory_search`, `memory_show`, `memory_submit`), loopback HTTP routes and optional settings/sidebar UI | Never writes canonical notes; `memory_submit` creates a `dsh-*.md` inbox file |
| `dsh-memory-discipline` | Optional automatic pre-step recall and discipline instructions for every relevant DSH turn | Never writes the vault; only injects plugin messages |

## Data flow

```text
user turn
  -> dsh-memory-discipline (optional sensitive-topic recall)
  -> dsh-hermes-memory / core search
  -> model context wrapped as <memory-data>

agent fact
  -> memory_submit
  -> 50-Agent-Context/Agent提交区/dsh-*.md
  -> promoter --review
  -> human adjudication when needed
  -> promoter --apply
  -> canonical notes + derived local index
```

## `dsh-memory-discipline` configuration

The plugin listens to `agent/pre-step` only at `step === 1`. In `auto` mode it
searches only when the first real user message matches a memory-sensitive topic;
`always` searches every turn. Relay messages and plugin-injected messages are
excluded to prevent recursive recall.

Supported configuration values are:

- `core`: explicit path to the bundled or checked-out `unified-agent-memory/core`
- `python`: allowlisted key `default` or `uv312`, never an arbitrary executable
- `enabled`: default `true`
- `mode`: `auto` (default) or `always`
- `limit`: default `5`
- `maxChars`: default `1600`

Search failure and timeout are logged and the turn continues without recall;
an exit code of zero with empty output is treated as a legitimate no-hit result.
If the configured core directory is missing, the plugin warns at startup.

## Security boundary

Search output is data, not instructions, and is wrapped in `<memory-data>`.
Plaintext credential-shaped submissions are rejected by the memory tool/core.
The discipline adapter cannot promote, adjudicate, edit canonical notes or
change the vault path through an executable string.

## Verification

Verify the core with the Python test suite. Verify the dsh tool/UI adapter with
its host and HTTP smoke tests. Verify the discipline adapter with tests covering
the sensitive-topic gate, relay-message exclusion, allowlisted interpreters,
failure logging and frozen-message behavior.