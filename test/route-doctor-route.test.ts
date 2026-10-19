/**
 * Route-level tests for GET /doctor through the real host entry.
 *
 * The HTTP layer is what a unit test on the shaper cannot see: the GET-only
 * guard, the 200-instead-of-500 degradation, and — the load-bearing one — the
 * `keepOutputOnFailure` option that keeps a report which exits 1.
 *
 * @module test/route-doctor-route.test
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

vi.mock('../src/utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils.ts')>()),
  runCore: vi.fn(),
}))

import * as host from '../src/index.ts'
import { DOCTOR_PATH } from '../src/route-doctor.ts'
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

async function get(method = 'GET') {
  const { ctx, routes } = makeCtx()
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  const route = routes.find((r) => r.path === DOCTOR_PATH)
  if (!route) throw new Error('/doctor was never registered')
  const { res, out } = capture()
  await route.handler({
    socket: { remoteAddress: '127.0.0.1' },
    method,
    url: '/api/dsh-unified-agent-memory/doctor',
    headers: { host: '127.0.0.1:3081' },
  }, res)
  return out
}

beforeEach(() => {
  vi.mocked(runCore).mockReset()
})

describe('GET /doctor', () => {
  it('registers the route exactly once', () => {
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
    expect(routes.filter((r) => r.path === DOCTOR_PATH)).toHaveLength(1)
  })

  it('asks the core for the report and keeps the output on a failing exit', async () => {
    // The core exits 1 when it finds an error, AFTER printing. Without the flag
    // runCore returns '' and the report is lost exactly when it matters.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'doctor',
      data: { index: { memories: 3, vectors: 3 }, issues: [] },
    }) })

    await get()

    expect(vi.mocked(runCore)).toHaveBeenCalledWith(
      expect.anything(),
      ['doctor', '--json'],
      { keepOutputOnFailure: true },
    )
  })

  it('returns the issues and counts', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'doctor',
      data: {
        index: { memories: 476, vectors: 377 },
        conflicts: { count: 2 },
        inbox: { count: 0 },
        canonical: { duplicateLines: [] },
        orphanIndexes: { count: 2 },
        issues: [{ severity: 'info', code: 'orphan-indexes', message: '2 orphan index database(s)', hint: 'memory gc --apply' }],
      },
    }) })

    const out = await get()

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.status).toBe('ok')
    expect(body.issues).toHaveLength(1)
    expect(body.counts.orphans).toBe(2)
  })

  it('degrades to unavailable on a transport failure, with 200 not 500', async () => {
    // A dead core is not a server fault: this is a read-only dashboard feed.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '' })

    const out = await get()

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.ok).toBe(false)
    expect(body.status).toBe('unavailable')
    expect(body.issues).toEqual([])
  })

  it('refuses a write method without touching the core', async () => {
    const out = await get('POST')

    expect(out.code).toBe(405)
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })
})
