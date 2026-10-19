import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** Read-only hybrid search over the canonical notes. */
export const SEARCH_PATH = '/api/dsh-unified-agent-memory/search'

/**
 * Result cap when the caller does not ask for one.
 *
 * Matches the core's own `memory search --limit` default, so the route's
 * no-parameter answer and the CLI's bare answer are the same list.
 */
export const SEARCH_LIMIT = 8

/**
 * Hard ceiling on an accepted `limit`; a larger ask is clamped, not refused.
 *
 * Same reasoning as `/preview`: the value is caller-supplied and reaches
 * argparse, where `--limit abc` exits non-zero and turns a renderable result
 * into a silent `{ok:false}`. Clamp here, keep the core's grammar clean.
 */
const SEARCH_LIMIT_MAX = 50

/** Clamp a caller-supplied `limit` into `[1, SEARCH_LIMIT_MAX]`. */
export function clampSearchLimit(raw: string | null): number {
  const n = Number(raw)
  if (raw === null || raw === '' || !Number.isFinite(n) || n < 1) return SEARCH_LIMIT
  return Math.min(Math.floor(n), SEARCH_LIMIT_MAX)
}

export interface SearchPayload {
  ok: boolean
  query: string
  count: number
  results: unknown[]
}

/**
 * Core argv for a search. `--hybrid` widens recall to the vector stream;
 * `limit` caps how many lines come back (the core defaults to 8, this route
 * used to pass nothing at all — so `?limit=20` was accepted and silently
 * ignored, which reads as a broken parameter rather than an unsupported one).
 */
export function buildSearchArgs(query: string, hybrid: boolean, limit?: number): string[] {
  const args = ['search', query, '--json']
  if (hybrid) args.push('--hybrid')
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 1) {
    args.push('--limit', String(Math.floor(limit)))
  }
  return args
}

/**
 * Unwrap the core's `{ok, command, data}` envelope into what the panel needs.
 *
 * Any failure — unparseable output, a non-zero exit, a failing envelope —
 * collapses to the same quiet empty result. The panel renders "no results"
 * for this, which is honest: from the caller's side an unavailable index and
 * an empty index both mean "nothing to show".
 */
export function shapeSearchResult(raw: string): SearchPayload {
  let parsed: { ok?: boolean; data?: { count?: number; results?: unknown[]; query?: string } }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, query: '', count: 0, results: [] }
  }
  if (parsed.ok !== true || !parsed.data) {
    return { ok: false, query: '', count: 0, results: [] }
  }
  const results = Array.isArray(parsed.data.results) ? parsed.data.results : []
  return {
    ok: true,
    query: String(parsed.data.query ?? ''),
    count: Number.isFinite(Number(parsed.data.count)) ? Number(parsed.data.count) : results.length,
    results,
  }
}

/** Run one search against the configured vault. Never throws. */
export async function handleSearch(
  cfg: PluginConfig,
  query: string,
  hybrid: boolean,
  limit?: number,
): Promise<SearchPayload> {
  try {
    const r = await runCore(cfg, buildSearchArgs(query, hybrid, limit))
    if (!r.ok) return { ok: false, query, count: 0, results: [] }
    return shapeSearchResult(r.output)
  } catch {
    return { ok: false, query, count: 0, results: [] }
  }
}
