/**
 * Route-level tests for GET /doc through the real host entry.
 *
 * Drives the registered handler end to end, because the parts that only exist at
 * the HTTP layer — the GET-only guard, the 400 on an absent name, and the
 * `untrusted` marker on the bytes that leave — are exactly the ones a unit test
 * on the shaper cannot see.
 *
 * Reuses the fake-cordis harness from plugin.test.ts.
 *
 * @module test/route-doc-route.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/updater.ts', () => ({
  checkForUpdate: vi.fn(),
  startUpdateWatch: vi.fn(),
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
import { DOC_PATH } from '../src/route-doc.ts'
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

async function get(url: string, method = 'GET') {
  const { ctx, routes } = makeCtx()
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  const route = routes.find((r) => r.path === DOC_PATH)
  if (!route) throw new Error('/doc was never registered')
  const { res, out } = capture()
  await route.handler({
    socket: { remoteAddress: '127.0.0.1' },
    method,
    url,
    headers: { host: '127.0.0.1:3081' },
  }, res)
  return out
}

beforeEach(() => {
  vi.mocked(runCore).mockReset()
})

describe('GET /doc', () => {
  it('registers the route exactly once', () => {
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
    expect(routes.filter((r) => r.path === DOC_PATH)).toHaveLength(1)
  })

  it('returns the note body for a readable name', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'show',
      data: {
        doc: '工程执行规则.md',
        name: '工程执行规则.md',
        path: 'C:/vault/50-Agent-Context/工程执行规则.md',
        body: '# 工程执行规则\n- 先跑测试\n',
        reason: null,
        untrusted: true,
      },
    }) })

    const out = await get('/api/dsh-unified-agent-memory/doc?name=' + encodeURIComponent('工程执行规则.md'))

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.ok).toBe(true)
    expect(body.body).toContain('先跑测试')
    expect(body.path).toContain('50-Agent-Context')
    // §2 wire contract: this is vault free text, so the marker must survive the
    // flatten — a consumer needs to know without unwrapping anything.
    expect(body.untrusted).toBe(true)
  })

  it('passes the name to the core as one argv element', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'show', data: { name: 'a.md', path: null, body: '', reason: null },
    }) })

    await get('/api/dsh-unified-agent-memory/doc?name=a.md')

    expect(vi.mocked(runCore)).toHaveBeenCalledWith(
      expect.anything(),
      ['show', 'a.md', '--json'],
    )
  })

  it('answers 400 for an absent name and never spawns the core', async () => {
    // An absent name is a malformed request, not a missing note. Forwarding it
    // would make the core answer `invalid-name` for "" — which reads like a
    // fact about the vault.
    const out = await get('/api/dsh-unified-agent-memory/doc')

    expect(out.code).toBe(400)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'missing name' })
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('refuses a write method', async () => {
    // Read-only route: `guard`, not `guardWrite`. A POST must not reach the core.
    const out = await get('/api/dsh-unified-agent-memory/doc?name=a.md', 'POST')

    expect(out.code).toBe(405)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it('carries the core refusal reason through to the client', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'show',
      data: { name: null, path: null, body: null, reason: 'not-found', untrusted: true },
    }) })

    const out = await get('/api/dsh-unified-agent-memory/doc?name=gone.md')

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.ok).toBe(true)
    expect(body.reason).toBe('not-found')
    expect(body.body).toBeNull()
  })

  it('degrades to unavailable when the core subprocess fails', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '' })

    const out = await get('/api/dsh-unified-agent-memory/doc?name=a.md')

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('unavailable')
  })
})
