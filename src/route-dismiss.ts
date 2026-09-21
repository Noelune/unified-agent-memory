import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/**
 * Retire one inbox submission. The only mutating route in this plugin.
 *
 * The route is deliberately narrow: it can move a file inside the inbox, and
 * nothing else. Canonical notes stay read-only, and no file is ever deleted —
 * the core's dismiss moves the entry into `已处理/` and keeps both copies when
 * the target name is already taken.
 */
export const DISMISS_PATH = '/api/dsh-unified-agent-memory/dismiss'

export interface DismissPayload {
  ok: boolean
  name: string
  reason: string | null
}

/**
 * Host-side name rule: a name that passes here is safe to hand to the core.
 *
 * Stricter than the core's `_safe_inbox_name` on purpose, and deliberately so:
 * this layer also refuses a leading `-`. The core forwards the name as argv, so
 * a flag-shaped name would let argparse consume it and let the *next* token
 * slide into the `name` position — `dismiss --json extra` moves `extra`, an
 * entry the caller never named. `buildDismissArgs` also wraps the name in a
 * `--` terminator, but refusing the shape here keeps such a name from ever
 * spawning a process. Do not relax this to match the core.
 */
function isSafeName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\x00') || name.includes(':')) return false
  return !name.startsWith('~') && !name.startsWith('-')
}

/** Parse `{"name":"..."}`; returns null when the name is absent or unsafe. */
export function parseDismissBody(raw: string): string | null {
  let parsed: { name?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const name = parsed.name
  if (typeof name !== 'string' || !isSafeName(name)) return null
  return name
}

/**
 * argv for one dismissal.
 *
 * Order matters, and getting it wrong is a silent outage rather than an error.
 * argparse treats EVERY token after `--` as positional, so `['dismiss', '--',
 * name, '--json']` hands it *two* positionals — `--json` stops being a flag and
 * the parser exits 2 with an empty stdout. The host then sees a bare crash and
 * blames the name, refusing every legal submission. Flags therefore go BEFORE
 * the terminator: `dismiss --json -- <name>`.
 *
 * The terminator itself is still load-bearing: it stops a leading `-` on the
 * name from being read as a flag and letting the next token slide into the
 * `name` position. `isSafeName` already refuses a leading `-`, so this is
 * belt-and-braces against a future flag (`--force`) arming the same hole.
 *
 * test/route-dismiss-integration.test.ts spawns the real core to keep this
 * argv acceptable to the real parser; the mocked tests cannot see it.
 */
export function buildDismissArgs(name: string): string[] {
  return ['dismiss', '--json', '--', name]
}

/**
 * Unwrap a dismiss envelope.
 *
 * Two levels of `ok` live here and they mean different things. The outer one
 * (`parsed.ok`) is "the command ran"; the inner one (`parsed.data.ok`) is "the
 * entry moved". A refusal such as `not-found` or `outside-inbox` is still a
 * successful command, so it keeps `ok: true` at the envelope level while the
 * payload reports `ok: false` with the core's `reason` passed through verbatim.
 * Collapsing the two would make "the vault had nothing to move" look identical
 * to "the core is broken", which is exactly the distinction an operator needs.
 */
export function shapeDismissResult(raw: string): DismissPayload {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      data?: { ok?: boolean; name?: string; reason?: string | null }
    }
    if (parsed.ok !== true || !parsed.data) {
      return { ok: false, name: '', reason: 'unavailable' }
    }
    return {
      ok: parsed.data.ok === true,
      name: String(parsed.data.name ?? ''),
      reason: parsed.data.reason == null ? null : String(parsed.data.reason),
    }
  } catch {
    return { ok: false, name: '', reason: 'unavailable' }
  }
}

/**
 * Run one dismissal against the configured vault. Never throws.
 *
 * A failed call is split two ways so the label tells the truth about what
 * broke. `runCore` sets `kind` only for a process-level failure (ENOENT →
 * `missing`, SIGTERM → `timeout`); a `crash` means the command exited non-zero,
 * and if it had really run it would have printed a JSON envelope.
 *
 * The `invalid-name` arm was written when `buildDismissArgs` emitted its `--json`
 * *after* the terminator, which made argparse reject every legal name with exit 2
 * and an empty stdout — a bare `crash` that this branch then blamed on the caller.
 * That argv bug is fixed, and with the corrected argv the arm is now unreachable:
 * a flag-shaped name is refused by `isSafeName` before any spawn, and a genuine
 * name reaches the command body and answers inside an envelope (a missing entry
 * comes back exit 0 as `reason: "not-found"` — verified against the real core in
 * test/route-dismiss-integration.test.ts). It is kept as defence in depth, not as
 * a description of a live failure mode: it now guards the one remaining way to
 * reach it, a *future* edit that puts a token after `--` again (or drops the
 * terminator) and re-arms argparse. In that case `invalid-name` is the accurate
 * label — the argv was wrong — and this branch turns a silent write outage into
 * a clear diagnostic instead of the misleading `unavailable`.
 */
export async function handleDismiss(cfg: PluginConfig, name: string): Promise<DismissPayload> {
  try {
    const r = await runCore(cfg, buildDismissArgs(name))
    if (!r.ok) {
      // `missing`/`timeout` are process-level faults; a bare crash with no
      // stdout is argparse refusing the argv (see the doc comment above).
      const infra = r.kind === 'missing' || r.kind === 'timeout'
      const reason = !infra && r.output.trim() === '' ? 'invalid-name' : 'unavailable'
      return { ok: false, name, reason }
    }
    return shapeDismissResult(r.output)
  } catch {
    return { ok: false, name, reason: 'unavailable' }
  }
}
