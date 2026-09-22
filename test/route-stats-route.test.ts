/**
 * Route-level tests for GET /stats through the real host entry.
 *
 * Task 5's reviewer showed the wiring branch had ZERO coverage: `readStats`
 * (the `/status` route) and `shapeStatsResult` (a pure unit under
 * route-stats.test.ts) were both tested, but the decision that joins them in
 * `src/index.ts` — `r.ok ? shapeStatsResult(r.output) : {ok:false,...}` — was
 * not. The proving mutation was invisible:
 *
 *   M1  ignore `r.ok`, always call shapeStatsResult  → suite unchanged
 *   M2  sendJson(res, 200, ...) → 500                → suite unchanged
 *
 * Two reasons the existing suites cannot see either mutation:
 *   1. `/status` never reaches the branch — it calls `runCore` directly.
 *   2. The unit test calls `shapeStatsResult` by hand, so the *caller's* `r.ok`
 *      check is never on the path.
 * Both are satisfied by driving the registered handler instead of the shaper.
 *
 * Why (b) is the load-bearing case: the core copies `result["ok"]` into BOTH
 * envelope levels, so a failed call can still produce a perfectly legal
 * `ok:true` inner envelope. Feeding that shape with an outer `ok:false` pins
 * two contracts at once — "honour `r.ok`" (read `ok:false`, never the inner
 * `ok:true`) and "a dead core is not a 500" (a dashboard feed degrades to 200).
 * That is also the identity gate the mutation runs use: the correct code
 * answers `ok:false`, the M1 mutant leaks `ok:true`.
 *
 * Reuses the fake-cordis harness from plugin.test.ts so the real handler runs.
 *
 * @module test/route-stats-route.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/updater.ts', () => ({
  checkForUpdate: vi.fn(),
  getUpdateInfo: vi.fn(() => ({
    currentVersion: '0.0.0-test',
    latestVersion: '0.0.0-test',
    updateAvailable: false,
  })),
}))

// Partial mock: index.ts also imports resolveConfig, so stubbing the whole
// module would break plugin.apply with "No resolveConfig export is defined".
vi.mock('../src/utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils.ts')>()),
  runCore: vi.fn(),
}))

import * as host from '../src/index.ts'
import { STATS_PATH, buildStatsArgs } from '../src/route-stats.ts'
import { runCore } from '../src/utils.ts'

interface FakeRoute {
  kind: string
  path: string
  handler: (
    req: { socket?: { remoteAddress?: string }; method?: string; url?: string },
    res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void },
  ) => void | Promise<void>
}

function makeCtx() {
  const routes: FakeRoute[] = []
  const services: Record<string, unknown> = {
    tools: { register: () => () => {} },
    webServer: { register: (route: FakeRoute) => { routes.push(route); return () => {} } },
  }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined
      if (!(prop in services)) return undefined
      return services[prop]
    },
  })
  return { ctx, routes }
}

function capture() {
  const out: { code: number; headers: Record<string, string>; body: string } = {
    code: 0, headers: {}, body: '',
  }
  const res = {
    writeHead: (code: number, headers: Record<string, string>) => { out.code = code; out.headers = headers; return res },
    end: (body: string) => { out.body = body },
  }
  return { res, out }
}

/** Drive the REAL `/stats` handler registered by `index.ts`, not the shaper. */
async function get(
  method = 'GET',
  url = STATS_PATH,
  remoteAddress = '127.0.0.1',
) {
  const { ctx, routes } = makeCtx()
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  // Looked up by path, never by index: appending a route must not silently
  // retarget this test at a different handler.
  const route = routes.find((r) => r.path === STATS_PATH)!
  if (!route) throw new Error(`no route registered at ${STATS_PATH}`)
  const { res, out } = capture()
  await route.handler({ socket: { remoteAddress }, method, url }, res)
  return out
}

describe('GET /stats route', () => {
  beforeEach(() => {
    vi.mocked(runCore).mockReset()
  })

  it('answers 200 with the core figures carried field by field', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'stats',
      data: { total: 12, pending: 3, byType: { fact: 9 } } }) })

    const out = await get()

    expect(out.code).toBe(200)
    // Field by field, not just "200 and something": a handler that dropped
    // `data` or mislabelled `status` would still be green on a status-only
    // assertion, and the console renders exactly these keys.
    expect(JSON.parse(out.body)).toEqual({
      ok: true,
      command: 'stats',
      status: 'ok',
      data: { total: 12, pending: 3, byType: { fact: 9 } },
    })
    // The args the handler actually chose, not merely that some call happened.
    expect(vi.mocked(runCore)).toHaveBeenCalledWith(
      expect.anything(),
      buildStatsArgs(),
    )
  })

  it('answers 200 + ok:false — not 500 — when the core call fails, ignoring a legal inner envelope', async () => {
    // The load-bearing case. `ok:false` with a VALID `ok:true` body is exactly
    // what a failed core call looks like once the real envelope is involved
    // (`preview.py` copies the inner `ok` into both levels), and it is the only
    // input that separates "honour r.ok" from "just parse whatever came back":
    //
    //   correct  → r.ok is false      → {ok:false, data:null}
    //   M1 mutant→ ignores r.ok       → shaper unwraps the inner ok:true → data leaks
    //
    // A bare `output: ''` would NOT do this: the shaper also returns ok:false
    // for unparseable input, so the mutant would stay green.
    vi.mocked(runCore).mockResolvedValue({
      ok: false, output: JSON.stringify({
        ok: true, command: 'stats', data: { total: 999 } }),
      kind: 'missing', error: 'python not found',
    })

    const out = await get()

    expect(out.code).toBe(200)
    expect(JSON.parse(out.body)).toEqual({
      ok: false,
      command: 'stats',
      status: 'error',
      data: null,
    })
  })

  it('answers 200 + ok:false when the core emits garbage', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: 'not json' })

    const out = await get()

    expect(out.code).toBe(200)
    expect(JSON.parse(out.body)).toEqual({
      ok: false, command: 'stats', status: 'error', data: null,
    })
  })

  it('answers 200 + ok:false when the core envelope omits data', async () => {
    // `ok:true` but no `data` is a legal-looking envelope the shaper must still
    // reject — otherwise the console renders `undefined` figures as real zeros.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'stats' }) })

    const out = await get()

    expect(out.code).toBe(200)
    expect(JSON.parse(out.body)).toEqual({
      ok: false, command: 'stats', status: 'error', data: null,
    })
  })

  it('rejects POST with 405 and never spawns the core', async () => {
    const out = await get('POST')

    expect(out.code).toBe(405)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'method not allowed' })
    // Read-only route: a refused method must not have reached the subprocess.
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('lets HEAD through', async () => {
    // `guard(req, res, ['GET','HEAD'])` — HEAD is allowed, unlike the POST-only
    // /dismiss route. Pinned here because the allowed-method list is part of the
    // wire contract, and dropping 'HEAD' would 405 a healthy probe.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'stats', data: { total: 1 } }) })

    const out = await get('HEAD')

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('refuses a non-loopback caller with 403 and never spawns the core', async () => {
    const out = await get('GET', STATS_PATH, '203.0.113.7')

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })
})
