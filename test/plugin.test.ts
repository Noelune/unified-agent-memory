/**
 * Tests for the host plugin entry (src/index.ts).
 *
 * These exist because of a real regression: the entry read `ctx.webServer` from
 * inside a nested `ctx.inject(['webServer'], ...)` callback. Cordis guards
 * service access against the plugin's own declared `inject`, so that read threw
 * `cannot get property "webServer" without inject`, the loader failed the entry,
 * and neither the memory tools nor the status route ever registered —
 * while the harness still looked healthy.
 *
 * A plain `new Context()` does not reproduce it, so the fake context below
 * enforces the same guard.
 *
 * @module test/plugin.test
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

import * as host from '../src/index.ts'

interface FakeRoute {
  kind: string
  path: string
  handler: (
    req: { socket?: { remoteAddress?: string }; method?: string },
    res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void },
  ) => void | Promise<void>
}

/** Build a cordis-like context that refuses services the plugin did not declare. */
function makeCtx() {
  const declared = host.inject as readonly string[]
  const tools: string[] = []
  const routes: FakeRoute[] = []

  const services: Record<string, unknown> = {
    tools: {
      register: (tool: { name?: string }) => {
        tools.push(tool?.name ?? 'anonymous')
        return () => {}
      },
    },
    webServer: {
      register: (route: FakeRoute) => {
        routes.push(route)
        return () => {}
      },
    },
  }

  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (prop === 'then') return undefined // not a thenable
      if (!(prop in services)) return undefined
      if (!declared.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return services[prop]
    },
  })

  return { ctx, tools, routes }
}

function capture() {
  const out: { code: number; headers: Record<string, string>; body: string } = {
    code: 0,
    headers: {},
    body: '',
  }
  const res = {
    writeHead: (code: number, headers: Record<string, string>) => {
      out.code = code
      out.headers = headers
      return res
    },
    end: (body: string) => {
      out.body = body
    },
  }
  return { res, out }
}

describe('host plugin contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('declares every service it reads off its own context', () => {
    // The regression was tools-only here while ctx.webServer was still read.
    expect(host.inject).toContain('tools')
    expect(host.inject).toContain('webServer')
  })

  it('exposes a cordis plugin shape', () => {
    expect(typeof host.apply).toBe('function')
    expect(host.name).toBe('dsh-unified-agent-memory')
  })

  it('registers the five tools and the status route without tripping the guard', () => {
    const { ctx, tools, routes } = makeCtx()

    expect(() => host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })).not.toThrow()

    expect(tools.sort()).toEqual([
      'memory_preview',
      'memory_search',
      'memory_show',
      'memory_status',
      'memory_submit',
    ])
    expect(routes).toHaveLength(1)
    expect(routes[0].path).toBe('/api/dsh-unified-agent-memory/status')
    expect(routes[0].kind).toBe('exact')
  })

  it('answers a loopback GET with the status payload', async () => {
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault', pythonPath: 'python' })

    const { res, out } = capture()
    // The handler now awaits a read-only core call, so completion is observed
    // by awaiting it rather than by reading `out` synchronously.
    await routes[0].handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)

    expect(out.code).toBe(200)
    const body = JSON.parse(out.body)
    expect(body.ok).toBe(true)
    expect(body.configured).toBe(true)
    expect(body.vaultPath).toBe('C:/tmp/vault')
    // The route always advertises the new read-only keys; with no working core
    // in this test they degrade to null rather than erroring.
    expect(body).toHaveProperty('index')
    expect(body).toHaveProperty('stats')
  })

  it('refuses non-loopback callers, since the payload carries local paths', () => {
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })

    const { res, out } = capture()
    routes[0].handler({ socket: { remoteAddress: '203.0.113.7' }, method: 'GET' }, res)

    expect(out.code).toBe(403)
    expect(JSON.parse(out.body).ok).toBe(false)
  })

  it('rejects non-GET methods', () => {
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })

    const { res, out } = capture()
    routes[0].handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST' }, res)

    expect(out.code).toBe(405)
  })
})
