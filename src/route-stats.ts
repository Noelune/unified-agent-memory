/**
 * GET /stats — the read-only aggregate feed for the memory console.
 *
 * Two layers live here, not three: buildStatsArgs (argv) and shapeStatsResult
 * (parse). Both are pure, so each is unit-testable alone. Nothing here writes.
 *
 * There is deliberately no `handleStats`: this module stays pure — no `runCore`,
 * no `guard`, no `sendJson` — and the wire layer is registered in `src/index.ts`
 * beside the other five routes, exactly as /preview, /note, /search and
 * /dismiss are. That registration (the `r.ok ? … : {ok:false,…}` branch and the
 * `sendJson(res, 200, …)` call) is the part no unit test on this file can see,
 * so it is covered end to end by `test/route-stats-route.test.ts` driving the
 * real handler.
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
