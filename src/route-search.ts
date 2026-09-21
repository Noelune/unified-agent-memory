import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** Read-only hybrid search over the canonical notes. */
export const SEARCH_PATH = '/api/dsh-unified-agent-memory/search'

export interface SearchPayload {
  ok: boolean
  query: string
  count: number
  results: unknown[]
}

/** Core argv for a search. `--hybrid` widens recall to the vector stream. */
export function buildSearchArgs(query: string, hybrid: boolean): string[] {
  const args = ['search', query, '--json']
  if (hybrid) args.push('--hybrid')
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
): Promise<SearchPayload> {
  try {
    const r = await runCore(cfg, buildSearchArgs(query, hybrid))
    if (!r.ok) return { ok: false, query, count: 0, results: [] }
    return shapeSearchResult(r.output)
  } catch {
    return { ok: false, query, count: 0, results: [] }
  }
}
