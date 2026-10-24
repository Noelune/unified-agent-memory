# DSH memory adapter

One package, `dsh-unified-agent-memory`, is the whole story: a dependency-free
Python core, a DSH host half that exposes it as tools and routes, and one
inbox directory that is the only write path.

Earlier releases spread the same idea across three package names —
`unified-agent-memory` for the core, `dsh-hermes-memory` for the host tools and
`dsh-memory-discipline` for per-turn recall. The host tools now ship inside the
package that implements them, and the recall layer was merged into it, because
a DSH user should not have to install two plugins to get "the agent looks it up
when asked" and "the agent already knows". See
[Retired names](#retired-names) for the mapping.

## Compatibility target

The primary host targets are DSH `0.2.0-rc.2`, `0.2.1-rc.2` and `0.2.1-rc.3`
(both the
CLI/Web profile and the Desktop app's own profile), with Node.js `>=20`. Since
DSH `0.2.0` the host validates the plugin's `@deepseek-ai/dsh*` peer ranges
before importing it and skips a non-matching bundle entirely, so the two version
lines are declared explicitly rather than covered by one open range. The plugin
keeps its tools available when optional HTTP or injection capabilities are
absent; route registration is best-effort and returns cleanup when the host
supports it. The automatic recall hook is registered the same way — a host
without `agent/pre-step` simply gets no automatic recall and the tools keep
working.

## Components

| Component | What it does | Write boundary |
|---|---|---|
| `core/` (Python, stdlib only) | Vault index, five-stream hybrid recall (BM25 + CJK bigram + vector + graph + trigram), promotion, conflict handling, forgetting, health/GC and optional digest | Exactly three writers touch canonical notes — `promoter.promote`, `forgetter.demote`, `maintenance.repair_existing` — and each takes the vault's `file_lock` |
| `src/` (DSH host half) | Six tools (`memory_search`, `memory_show`, `memory_submit`, `memory_status`, `memory_preview`, `memory_setup`), loopback HTTP routes, the `agent/pre-step` recall hook, and optional settings/sidebar UI | Never writes canonical notes; `memory_submit` creates a `dsh-*.md` inbox file |
| `Agent提交区/` | Isolated cross-agent submission files, read by `promoter --review` | Submission files only |

## Data flow

```text
user turn
  -> agent/pre-step (step 1 only)
     -> topic gate            (recall=auto: memory-sensitive topics only)
     -> memory search --hybrid (limit recallLimit, abort after recallTimeoutMs)
     -> <memory-data> block + discipline instructions as plugin messages
  -> model answers with the recall already in context
  -> memory_show for the full canonical note when recall is not enough

agent fact
  -> memory_submit
  -> 50-Agent-Context/Agent提交区/dsh-*.md
  -> promoter --review
  -> human adjudication when needed
  -> promoter --apply
  -> canonical notes + derived local index
```

## Automatic recall

The hook listens to `agent/pre-step` and acts only at `step === 1`, so the
messages it injects are never re-read by a later step of the same turn. In
`auto` mode it searches only when the newest real user message matches a
memory-sensitive topic (preferences, paths, servers, project facts,
coordination rules, history, credentials, configuration); `always` searches
every turn; `off` disables the hook entirely. The gate is matched against the
user's message only — never against vault content — so a note containing the
word "server" cannot widen it.

Recall skips a turn rather than guessing when:

- the message is shorter than `recallMinQueryChars` (replies like "继续" or "ok"
  carry no topic, and searching them returns noise worse than no recall);
- the newest user message is an `agent-relay` collaboration message — that would
  search the vault with another agent's prompt and inject the result here;
- the newest user message is plugin-injected (`source.kind` is `plugin` or
  `plugin:<package>`) — otherwise the next turn would recall on the previous
  turn's own recall and feed itself;
- `vaultPath` is unset, `recall` is `off`, or the host froze the message array.

Search failure, timeout and abort are logged once with the exit kind and the
turn continues without recall. An exit code of zero with empty output is a
legitimate no-hit result, not an error. A recall bug is caught and never takes
the turn down with it.

The discipline instructions (read the recall, do not guess about preferences or
paths, submit what broke) are injected **once per session**: the message stays
in the history, so re-sending it every turn would be a few hundred tokens of
pure waste. Setting `recallInstructions: false` removes them and leaves the
recall block alone.

### Configuration

Plugin settings (camelCase) or environment variables:

| Key | Env | Default | Notes |
|---|---|---|---|
| `recall` | `UNIFIED_MEMORY_RECALL` | `auto` | `auto` \| `always` \| `off` |
| `recallLimit` | — | `5` | clamped to 1–20 |
| `recallMaxChars` | — | `1600` | clamped to 200–20000; compresses the block, never the vault |
| `recallMinQueryChars` | — | `6` | 0–200; raise it if short replies trigger recall |
| `recallTimeoutMs` | — | `8000` | clamped to 1000–60000; abort is a distinct exit kind from timeout |
| `recallInstructions` | — | `true` | once-per-session discipline rules |

Recall shares `vaultPath`, `pythonPath` and `corePath` with the tools, so there
is no second interpreter, no second core path, and no separate allowlist to keep
in step. The live values are published in the `/status` payload under `recall`,
because "off", "no topic match" and "broken core" are otherwise
indistinguishable from outside.

## Retired names

| Old name | Now |
|---|---|
| `unified-agent-memory` (npm package) | `dsh-unified-agent-memory` — same repo, same `core/` |
| `dsh-hermes-memory` | The host half of `dsh-unified-agent-memory` (`src/`). The name is gone: it described a Hermes-specific deployment that no longer exists in this repo |
| `dsh-memory-discipline` | `src/recall.ts` in this package. Its `core`/`python`/`enabled`/`mode`/`limit`/`maxChars` keys became `corePath`/`pythonPath`/`recall`/`recall*` shared with the tools |

A vault written by any of the old versions needs no migration: the note format,
the inbox directory and the index are unchanged.

## Security boundary

Search and recall output is data, not instructions, and is wrapped in
`<memory-data>` — the same marker the tools use, on purpose, so one marker means
one rule. Plaintext credential-shaped submissions are rejected by the memory
tool and the core. The plugin cannot promote, adjudicate, or edit canonical
notes, and it cannot change the vault path through an executable string.

## Verification

Verify the core with the Python test suite (`python -m unittest discover -s
core/tests`). Verify the host half with its host and HTTP smoke tests
(`npm run test:js`, `npm run test:node`). Verify recall with the tests covering
the topic gate in both languages, relay and plugin-message exclusion, newest-turn
selection, the six "must not search" paths, injection shape, failure logging and
frozen-message tolerance (`test/recall.test.ts`).

For repository checkout deployment, run `python setup/deploy.py detect`, then
`preview --target <allowlisted-file>`, review the result, and only then run
`apply`. The deployer is idempotent, backup-protected, atomic, and rollbackable;
it never edits canonical notes, session archives, credentials, or arbitrary
runtime configuration.
