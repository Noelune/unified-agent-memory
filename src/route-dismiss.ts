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

/** Mirrors the core-side name rule so a bad name never spawns a process. */
function isSafeName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\x00') || name.includes(':')) return false
  return !name.startsWith('~')
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

export function buildDismissArgs(name: string): string[] {
  return ['dismiss', name, '--json']
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

/** Run one dismissal against the configured vault. Never throws. */
export async function handleDismiss(cfg: PluginConfig, name: string): Promise<DismissPayload> {
  try {
    const r = await runCore(cfg, buildDismissArgs(name))
    if (!r.ok) return { ok: false, name, reason: 'unavailable' }
    return shapeDismissResult(r.output)
  } catch {
    return { ok: false, name, reason: 'unavailable' }
  }
}
