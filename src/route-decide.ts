import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/**
 * Resolve one queued conflict — the question the 「需要你裁决」 block asks.
 *
 * The queue is `情境信息/事实冲突待裁决.md`: facts an agent wanted to remember
 * that look like a state change to something already in memory. Only a person
 * can say which reading is right, and there are exactly three answers:
 *
 *   用新     replace the old fact (the old line is removed from its note)
 *   保留旧   memory is right, drop the new fact
 *   并存     both are true (both lines end up in the note)
 *
 * `跳过` is NOT offered here even though the CLI accepts it. Skipping records
 * the decision and dequeues the entry, and `_adjudicated_facts` then suppresses
 * that fact forever — so a button labelled "skip" would permanently silence a
 * question the user declined to answer. A client that wants to defer should
 * simply not call this route.
 */
export const DECIDE_PATH = '/api/dsh-unified-agent-memory/decide'

export const DECIDE_CHOICES = ['用新', '保留旧', '并存'] as const
export type DecideChoice = (typeof DECIDE_CHOICES)[number]

export interface DecidePayload {
  ok: boolean
  key: string
  choice: string
  reason: string | null
  applied: boolean
  /** Vault-relative note the ruling wrote to, when it wrote one. */
  target: string | null
}

const EMPTY: Omit<DecidePayload, 'key' | 'choice'> = {
  ok: false, reason: 'unavailable', applied: false, target: null,
}

/**
 * Host-side key rule.
 *
 * Keys are either a stamp (`20261019030125-1`) or a 16-char content hash, so
 * the charset can be tight. The leading-dash refusal matters for the same
 * reason it does in `route-dismiss`: the key is forwarded as argv, and a
 * flag-shaped key would let argparse consume it and slide `choice` into the
 * key position. `--` is also passed, but a value that cannot be a flag should
 * never reach a spawn at all.
 */
function isSafeKey(key: string): boolean {
  if (!key || key.length > 128 || key === '.' || key === '..') return false
  if (key.startsWith('-') || key.startsWith('~')) return false
  return /^[0-9A-Za-z._-]+$/.test(key)
}

export function isDecideChoice(value: unknown): value is DecideChoice {
  return typeof value === 'string' && (DECIDE_CHOICES as readonly string[]).includes(value)
}

/** Parse `{"key":"…","choice":"…"}`; null when either field is unacceptable. */
export function parseDecideBody(raw: string): { key: string; choice: DecideChoice } | null {
  let parsed: { key?: unknown; choice?: unknown }
  try {
    parsed = JSON.parse(raw) as { key?: unknown; choice?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.key !== 'string' || !isSafeKey(parsed.key)) return null
  if (!isDecideChoice(parsed.choice)) return null
  return { key: parsed.key, choice: parsed.choice }
}

/**
 * argv for one ruling.
 *
 * Flags BEFORE the `--` terminator, for the reason `buildDismissArgs`
 * documents: argparse treats every token after `--` as positional, so
 * `['decide', '--', key, choice, '--json']` stops seeing `--json` as a flag and
 * exits 2 with empty stdout — which the host would report as a bad key.
 * `route-decide-integration` spawns the real core so this cannot drift.
 */
export function buildDecideArgs(key: string, choice: DecideChoice): string[] {
  return ['decide', '--json', '--', key, choice]
}

/**
 * Unwrap a decide envelope.
 *
 * Same contract as `shapeDismissResult`: the core's outer `ok` mirrors
 * `data.ok`, so a business refusal arrives with `ok:false` at both levels and
 * must still be read — `reason` is the whole point of the answer. Only a
 * missing `data` (non-JSON or empty output) degrades to `unavailable`.
 */
export function shapeDecideResult(raw: string): DecidePayload {
  const empty: DecidePayload = { ...EMPTY, key: '', choice: '' }
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        ok?: boolean
        key?: unknown
        choice?: unknown
        reason?: unknown
        applied?: unknown
        target?: unknown
      }
    }
    if (!parsed.data) return empty
    return {
      ok: parsed.data.ok === true,
      key: String(parsed.data.key ?? ''),
      choice: String(parsed.data.choice ?? ''),
      reason: parsed.data.reason == null ? null : String(parsed.data.reason),
      applied: parsed.data.applied === true,
      target: typeof parsed.data.target === 'string' ? parsed.data.target : null,
    }
  } catch {
    return empty
  }
}

/** Run one ruling against the configured vault. Never throws. */
export async function handleDecide(
  cfg: PluginConfig, key: string, choice: DecideChoice,
): Promise<DecidePayload> {
  try {
    const r = await runCore(cfg, buildDecideArgs(key, choice))
    if (!r.ok) {
      // `missing`/`timeout`/`aborted` are process-level faults; clean exit with
      // no stdout is argparse refusing the argv, which here means the key.
      const infra = r.kind === 'missing' || r.kind === 'timeout' || r.kind === 'aborted'
      const reason = !infra && r.output.trim() === '' ? 'invalid-key' : 'unavailable'
      return { ...EMPTY, key, choice, reason }
    }
    return shapeDecideResult(r.output)
  } catch {
    return { ...EMPTY, key, choice }
  }
}
