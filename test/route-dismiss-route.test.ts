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
      headers?: Record<string, string>
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

/**
 * A request whose `on` replays `body` as one data chunk then ends.
 *
 * `Host` defaults to the loopback authority the real client would send: every
 * HTTP/1.1 client emits it, so omitting it made these fakes model a request that
 * cannot occur, and the Host fence (H-1 round 2) surfaced that as failures.
 */
function reqWithBody(
  body: string,
  method = 'POST',
  remoteAddress = '127.0.0.1',
  headers: Record<string, string> = {},
) {
  return {
    socket: { remoteAddress },
    method,
    headers: { host: '127.0.0.1:3081', ...headers },
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

async function post(
  body: string,
  method = 'POST',
  remoteAddress = '127.0.0.1',
  headers: Record<string, string> = {},
) {
  const route = dismissRoute()
  const { res, out } = capture()
  await route.handler(reqWithBody(body, method, remoteAddress, headers), res)
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

  // ---- cross-site write guard (H-1) ----
  //
  // The exact route bypasses the host's `/api` prefix auth, so a hostile page
  // reaches this handler with `remoteAddress` still 127.0.0.1. These cases pin
  // the Origin/Sec-Fetch-Site check that closes it — and each asserts the core
  // was never spawned, because "refused late, after the move" is not a fix.

  it('refuses a cross-site Origin with 403 and never spawns the core', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'https://evil.example.com',
      // A real cross-site request reaches us addressed to the loopback authority;
      // the Origin is what marks it cross-site.
      host: '127.0.0.1:3081',
    })

    expect(out.code).toBe(403)
    expect(out.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(out.body).ok).toBe(false)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a cross-site Origin even when the Host is a rebinding name', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'https://evil.example.com',
      host: 'evil.example.com',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('allows a same-origin local write through to the core', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://127.0.0.1:3081',
      host: '127.0.0.1:3081',
    })

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('refuses a DNS-rebinding request: loopback Origin, foreign Host', async () => {
    // The browser believes the page is on 127.0.0.1 (so Origin says so), but the
    // attacker's own name is in Host. Origin != Host fails it closed.
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://127.0.0.1:3081',
      host: 'evil.example.com',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a DNS-rebinding request whose Origin and Host both say evil.com', async () => {
    // The bypass this round fixes: after the DNS answer flips to 127.0.0.1 the
    // page and the target look same-origin, so Origin == Host == evil.com and a
    // same-origin compare passes. Host must be loopback, independent of Origin.
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://evil.com',
      host: 'evil.com',
    })

    expect(out.code).toBe(403)
    expect(out.headers['cache-control']).toBe('no-store')
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a rebinding request with no Sec-Fetch-Site', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://evil.com',
      host: 'evil.com',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a bare rebinding request carrying only a foreign Host', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', { host: 'evil.com' })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a rebinding request that claims Sec-Fetch-Site: same-origin', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      host: 'evil.com',
      'sec-fetch-site': 'same-origin',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('allows a localhost Host with a matching Origin', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      host: 'localhost:3081',
      origin: 'http://localhost:3081',
    })

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('allows the IPv6 loopback Host spelling with a matching Origin', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      host: '[::1]:3081',
      origin: 'http://[::1]:3081',
    })

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('refuses Sec-Fetch-Site: cross-site with no Origin', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      'sec-fetch-site': 'cross-site',
      host: '127.0.0.1:3081',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('allows Sec-Fetch-Site: same-origin with no Origin', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      'sec-fetch-site': 'same-origin',
      host: '127.0.0.1:3081',
    })

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('allows a headerless local CLI caller', async () => {
    // curl and the other agents send Host (curl sends `127.0.0.1:3081`) but no
    // Origin / Sec-Fetch-Site / Referer. Keeping that working is a deliberate
    // product decision; see the guardWrite comment for its ceiling.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })

    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', { host: '127.0.0.1:3081' })

    expect(out.code).toBe(200)
    expect(vi.mocked(runCore)).toHaveBeenCalledTimes(1)
  })

  it('answers 400 for a request with no Host at all, never spawning the core', async () => {
    // HTTP/1.1 requires Host, so a request without one is malformed. The write
    // fence refuses it rather than treating "no Host" as permission.
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', { host: '' })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses an Origin that hides a foreign host behind a backslash (F-1)', async () => {
    // `Origin: http://127.0.0.1:3081\.evil.com` with a loopback Host. The regex
    // prefilter let the backslash through to WHATWG URL, which folds it to `/`
    // and reports host `127.0.0.1:3081` — same-origin with the Host, so the write
    // was admitted. Unreachable from a browser (Edge normalises `\` and Origin is
    // a forbidden header) but live for a hand-rolled HTTP client. Must be 403.
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://127.0.0.1:3081\\.evil.com',
      host: '127.0.0.1:3081',
    })

    expect(out.code).toBe(403)
    expect(out.headers['cache-control']).toBe('no-store')
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a Host that only starts with a loopback spelling (F-2)', async () => {
    // The exact-match in `isLoopbackHost` is a single point of protection: relax
    // it to `startsWith('127.0.0.1')` and a rebinding name slips through. A Host
    // that merely begins with the loopback name is a foreign origin, not us.
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://127.0.0.1.evil.com',
      host: '127.0.0.1.evil.com',
    })

    expect(out.code).toBe(403)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a Host that only starts with localhost (F-2)', async () => {
    const out = await post('{"name":"a.md"}', 'POST', '127.0.0.1', {
      origin: 'http://localhost.evil.com',
      host: 'localhost.evil.com',
    })

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
