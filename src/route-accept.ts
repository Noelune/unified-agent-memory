import { runCore } from './utils.ts'
import { parseDismissBody } from './route-dismiss.ts'
import type { PluginConfig } from './types.ts'

/**
 * Accept one inbox submission — the yes button on the 待晋升的提交 queue.
 *
 * The sibling of `/dismiss`, and narrow in the same way: it promotes the facts
 * of exactly one file and moves that one file into `已处理/`. It is NOT
 * `promoter --apply`, which executes the whole pending-list snapshot and
 * archives every source behind it: wiring a per-row button to that would accept
 * the other rows too while looking like it accepted one.
 *
 * Two refusals are business answers the panel has to render, not faults:
 *
 *   conflicts         the submission's facts contradict memory. Nothing is
 *                     promoted and the file stays put, because moving it would
 *                     make "waiting for your ruling" look like "handled".
 *   not-a-submission  README.md / 前缀登记.md — infrastructure, not a queue item.
 */
export const ACCEPT_PATH = '/api/dsh-unified-agent-memory/accept'

export interface AcceptPayload {
  ok: boolean
  name: string
  reason: string | null
  promoted: number
  duplicates: number
  conflicts: number
}

/**
 * argv for one accept.
 *
 * Flags BEFORE the `--` terminator, for the reason documented on
 * `buildDismissArgs`: argparse treats every token after `--` as positional, so
 * `['accept', '--', name, '--json']` makes `--json` a second positional, exits 2
 * with empty stdout, and the host blames the name. `route-accept-integration`
 * spawns the real core so this cannot drift from the real parser.
 */
export function buildAcceptArgs(name: string): string[] {
  return ['accept', '--json', '--', name]
}

/**
 * Unwrap an accept envelope.
 *
 * Same contract as `shapeDismissResult`: the core's outer `ok` is a copy of
 * `data.ok`, so it cannot be a precondition — a refusal arrives with `ok:false`
 * at both levels and still has to be read. Only a missing `data` (malformed or
 * non-JSON output) degrades to `unavailable`, which is the one case that really
 * is not a business answer.
 */
export function shapeAcceptResult(raw: string): AcceptPayload {
  const empty = { ok: false, name: '', reason: 'unavailable', promoted: 0, duplicates: 0, conflicts: 0 }
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        ok?: boolean
        name?: string
        reason?: string | null
        promoted?: unknown
        duplicates?: unknown
        conflicts?: unknown
      }
    }
    if (!parsed.data) return empty
    const count = function (v: unknown): number {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    return {
      ok: parsed.data.ok === true,
      name: String(parsed.data.name ?? ''),
      reason: parsed.data.reason == null ? null : String(parsed.data.reason),
      promoted: count(parsed.data.promoted),
      duplicates: count(parsed.data.duplicates),
      conflicts: count(parsed.data.conflicts),
    }
  } catch {
    return empty
  }
}

/** Run one accept against the configured vault. Never throws. */
export async function handleAccept(cfg: PluginConfig, name: string): Promise<AcceptPayload> {
  try {
    const r = await runCore(cfg, buildAcceptArgs(name))
    if (!r.ok) {
      // `missing`/`timeout`/`aborted` are process-level faults; a bare crash with
      // no stdout is argparse refusing the argv. Same split as `handleDismiss`.
      const infra = r.kind === 'missing' || r.kind === 'timeout' || r.kind === 'aborted'
      const reason = !infra && r.output.trim() === '' ? 'invalid-name' : 'unavailable'
      return { ok: false, name, reason, promoted: 0, duplicates: 0, conflicts: 0 }
    }
    return shapeAcceptResult(r.output)
  } catch {
    return { ok: false, name, reason: 'unavailable', promoted: 0, duplicates: 0, conflicts: 0 }
  }
}

export { parseDismissBody as parseAcceptBody }
