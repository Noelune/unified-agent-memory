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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('status route: corrupt core readings degrade the whole stats object', () => {
  /**
   * Stand in for the Python core without depending on a real vault.
   *
   * runCore spawns `<pythonPath> -m unified_memory.memory status --json` with
   * corePath prepended to PYTHONPATH, so a scratch directory holding a stub
   * `unified_memory/memory.py` makes the route's real parse/coerce path run
   * against a controlled payload. (`pythonPath` cannot point at the .py file
   * itself: Windows refuses to execFile a script it cannot associate — EFTYPE.)
   */
  const PYTHON = process.env.UNIFIED_MEMORY_PYTHON ?? 'python'

  function stubCore(payload: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-stub-core-'))
    mkdirSync(join(dir, 'unified_memory'), { recursive: true })
    writeFileSync(join(dir, 'unified_memory', '__init__.py'), '', 'utf8')
    writeFileSync(
      join(dir, 'unified_memory', 'memory.py'),
      ['import sys', `sys.stdout.write(${JSON.stringify(payload + '\n')})`, ''].join('\n'),
      'utf8',
    )
    return dir
  }

  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function statsFrom(data: Record<string, unknown>) {
    dir = stubCore(JSON.stringify({ ok: true, command: 'status', data }))
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault', pythonPath: PYTHON, corePath: dir })
    const { res, out } = capture()
    await routes[0].handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
    return JSON.parse(out.body)
  }

  it('nulls stats when memories/vectors are non-numeric', async () => {
    const body = await statsFrom({
      memories: { count: 'n/a', vectors: 0 },
      index: { fts5: true },
      inboxPending: 3,
    })
    expect(body.stats).toBe(null)
  })

  it('nulls stats when inboxPending is non-finite, matching its siblings', async () => {
    // A corrupt reading must not be disguised as "0 pending": a genuine 0 and
    // an unreadable value have to stay distinguishable to the client.
    const body = await statsFrom({
      memories: { count: 42, vectors: 7 },
      index: { fts5: true },
      inboxPending: 'corrupt',
    })
    expect(body.stats).toBe(null)
  })

  it('keeps a genuine zero pending reading as zero', async () => {
    const body = await statsFrom({
      memories: { count: 42, vectors: 7 },
      index: { fts5: true },
      inboxPending: 0,
    })
    expect(body.stats).toEqual({ memories: 42, vectors: 7, pending: 0 })
  })

  it('keeps an absent inboxPending as zero', async () => {
    const body = await statsFrom({
      memories: { count: 42, vectors: 7 },
      index: { fts5: true },
    })
    expect(body.stats).toEqual({ memories: 42, vectors: 7, pending: 0 })
  })
})

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

  it('registers the five tools and every route without tripping the guard', () => {
    const { ctx, tools, routes } = makeCtx()

    expect(() => host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })).not.toThrow()

    expect(tools.sort()).toEqual([
      'memory_preview',
      'memory_search',
      'memory_show',
      'memory_status',
      'memory_submit',
    ])
    // Looked up by path, not by index: appending a route must not silently
    // re-point an assertion at a different endpoint.
    expect(routes).toHaveLength(4)
    const byPath = new Map(routes.map((r) => [r.path, r.kind]))
    expect(byPath.get('/api/dsh-unified-agent-memory/status')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/search')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/preview')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/note')).toBe('exact')
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
