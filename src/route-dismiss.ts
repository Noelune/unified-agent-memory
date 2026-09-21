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
 * The `--` terminator is load-bearing: without it argparse reads any leading
 * `-` on the name as a flag and the following token slides into the `name`
 * position — `dismiss --json extra` really moves `extra`. With the argv pinned
 * at three tokens that is unreachable today, but it arms itself the moment
 * dismiss grows a flag (say `--force`), so the terminator is here now.
 */
export function buildDismissArgs(name: string): string[] {
  return ['dismiss', '--', name, '--json']
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
 * `missing`, SIGTERM → `timeout`); anything else is a non-zero exit from the
 * command itself, and if that ran it would have printed a JSON envelope. So a
 * wait-status `crash` with *no* stdout is argparse rejecting the argv before
 * the command body ever ran — a request-shaped problem, reported as
 * `invalid-name`. A spawn failure, a timeout, or an exit that did print an
 * envelope is a genuine infrastructure fault and stays `unavailable`.
 *
 * This matters because the two send an operator to different places: a
 * flag-shaped name blamed on `unavailable` has them debugging a core that is
 * working fine. Note this branch is belt-and-braces only — `isSafeName` already
 * refuses a leading `-`, so no name reaching here should be able to trip
 * argparse.
 */
export async function handleDismiss(cfg: PluginConfig, name: string): Promise<DismissPayload> {
  try {
    const r = await runCore(cfg, buildDismissArgs(name))
    if (!r.ok) {
      // `missing`/`timeout` are process-level faults; a bare crash with no
      // stdout is argparse refusing the argv before the command ran.
      const infra = r.kind === 'missing' || r.kind === 'timeout'
      const reason = !infra && r.output.trim() === '' ? 'invalid-name' : 'unavailable'
      return { ok: false, name, reason }
    }
    return shapeDismissResult(r.output)
  } catch {
    return { ok: false, name, reason: 'unavailable' }
  }
}
