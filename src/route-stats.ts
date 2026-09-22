/**
 * GET /stats — the read-only aggregate feed for the memory console.
 *
 * Follows the three-layer split the other read routes use so each layer is
 * testable alone: buildStatsArgs (argv), shapeStatsResult (parse), handleStats
 * (wire). Nothing here writes.
 *
 * The wire layer lives in `src/index.ts` beside the other five routes, so this
 * module stays pure — no `runCore`, no `guard`, no `sendJson` — and every line
 * of it is unit-testable without an HTTP request or a Python subprocess.
 */

export const STATS_PATH = '/api/dsh-unified-agent-memory/stats'

export interface StatsPayload {
  ok: boolean
  status: 'ok' | 'error'
  data: Record<string, unknown> | null
}

export function buildStatsArgs(): string[] {
  return ['stats', '--json']
}

export function shapeStatsResult(raw: string): StatsPayload {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; data?: unknown }
    if (parsed.ok !== true || !parsed.data || typeof parsed.data !== 'object') {
      return { ok: false, status: 'error', data: null }
    }
    return { ok: true, status: 'ok', data: parsed.data as Record<string, unknown> }
  } catch {
    return { ok: false, status: 'error', data: null }
  }
}
