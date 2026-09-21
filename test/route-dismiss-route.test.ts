/**
 * Route-level tests for POST /dismiss through the real host entry.
 *
 * The unit tests above check `parseDismissBody` and `handleDismiss` in
 * isolation; these drive the registered handler end to end, because the pieces
 * that only exist at the HTTP layer — the POST-only guard, the 413 on an
 * oversized body, the 400-vs-409 split and the `no-store` header — are exactly
 * the ones a unit test cannot see. Task 5's reviewer showed that an unexercised
 * handler branch can be mutated with the suite still green.
 *
 * Reuses the fake-cordis harness from plugin.test.ts so the real handler runs.
 *
 * @module test/route-dismiss-route.test
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
import { DISMISS_PATH } from '../src/route-dismiss.ts'
import { runCore } from '../src/utils.ts'

interface FakeRoute {
  kind: string
  path: string
  handler: (
    req: {
      socket?: { remoteAddress?: string }
      method?: string
      url?: string
      on?: (ev: string, cb: (chunk?: unknown) => void) => void
    },
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

/** A request whose `on` replays `body` as one data chunk then ends. */
function reqWithBody(body: string, method = 'POST', remoteAddress = '127.0.0.1') {
  return {
    socket: { remoteAddress },
    method,
    on(ev: string, cb: (chunk?: unknown) => void) {
      if (ev === 'data') cb(body)
      if (ev === 'end') cb()
    },
  }
}

function dismissRoute() {
  const { ctx, routes } = makeCtx()
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  return routes.find((r) => r.path === DISMISS_PATH)!
}

async function post(body: string, method = 'POST', remoteAddress = '127.0.0.1') {
  const route = dismissRoute()
  const { res, out } = capture()
  await route.handler(reqWithBody(body, method, remoteAddress), res)
  return out
}

describe('POST /dismiss route', () => {
  beforeEach(() => {
    vi.mocked(runCore).mockReset()
  })

  it('moves an entry and answers 200, uncached', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}')

    expect(out.code).toBe(200)
    expect(out.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(out.body)).toEqual({ ok: true, name: 'a.md', reason: null })
    // The name reaches the core as argv, never through a shell, and sits behind
    // the `--` option terminator. The flag comes BEFORE the terminator — argparse
    // treats everything after `--` as positional, so a trailing `--json` would be
    // a stray positional and exit 2.
    expect(vi.mocked(runCore)).toHaveBeenCalledWith(
      expect.anything(),
      ['dismiss', '--json', '--', 'a.md'],
    )
  })

  it('answers 409 — not 500 — when the core refuses the move', async () => {
    // Real core refusal envelope: the outer `ok` is false as well (the core
    // copies `result["ok"]` into both levels). The old `ok:true` fake made this
    // route look correct while `shapeDismissResult` was flattening every real
    // refusal to 'unavailable'.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: false, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'not-found' } }) })

    const out = await post('{"name":"a.md"}')

    expect(out.code).toBe(409)
    expect(JSON.parse(out.body)).toEqual({ ok: false, name: 'a.md', reason: 'not-found' })
  })

  it('carries the core reason through to the 409 body, distinct from an outage', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: false, command: 'dismiss',
      data: { ok: false, name: 'ghost.md', movedTo: null, reason: 'not-found' } }) })
    const refused = await post('{"name":"ghost.md"}')

    vi.mocked(runCore).mockResolvedValue({
      ok: false, output: '', kind: 'missing', error: 'python not found',
    })
    const outage = await post('{"name":"ghost.md"}')

    // Same status code, different reason: the client reads `reason`, and that
    // distinction is exactly what the outer-`ok` precondition used to erase.
    expect(refused.code).toBe(409)
    expect(outage.code).toBe(409)
    expect(JSON.parse(refused.body).reason).toBe('not-found')
    expect(JSON.parse(outage.body).reason).toBe('unavailable')
  })

  it('answers 409 when the core call itself fails, without a 500', async () => {
    vi.mocked(runCore).mockResolvedValue({
      ok: false, output: '', kind: 'missing', error: 'python not found',
    })

    const out = await post('{"name":"a.md"}')

    expect(out.code).toBe(409)
    expect(JSON.parse(out.body).reason).toBe('unavailable')
  })

  it('rejects GET with 405', async () => {
    const out = await post('', 'GET')
    expect(out.code).toBe(405)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('rejects HEAD with 405', async () => {
    const out = await post('', 'HEAD')
    expect(out.code).toBe(405)
  })

  it('refuses a non-loopback caller with 403', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '203.0.113.7')
    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('answers 413 for a body over the 2048-byte cap', async () => {
    const out = await post(JSON.stringify({ name: 'a'.repeat(4096) }))

    expect(out.code).toBe(413)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'body too large' })
    // An oversized body must not have spawned the core.
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'empty body'],
    ['not json', 'malformed JSON'],
    ['{}', 'missing name'],
    ['{"name":123}', 'non-string name'],
    ['{"name":""}', 'empty name'],
    ['{"name":"../x"}', 'parent traversal'],
    ['{"name":"a/b"}', 'forward slash'],
    ['{"name":"a\\\\b"}', 'backslash'],
    ['{"name":"~x"}', 'tilde prefix'],
    ['{"name":"a:b"}', 'colon'],
    ['{"name":"--json"}', 'flag-shaped (dash prefix)'],
    ['{"name":"-x"}', 'single-dash prefix'],
  ])('answers 400 and never spawns the core for %s (%s)', async (body) => {
    const out = await post(body)

    expect(out.code).toBe(400)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'invalid name' })
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })
})
