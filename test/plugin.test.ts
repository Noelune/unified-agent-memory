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
import { existsSync, mkdtempSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { upgradeStatePath } from '../src/upgrade.ts'

vi.mock('../src/updater.ts', () => ({
  checkForUpdate: vi.fn(),
  startUpdateWatch: vi.fn(),
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
function makeCtx(opts: { profile?: string } = {}) {
  const declared = host.inject as readonly string[]
  const tools: string[] = []
  const routes: FakeRoute[] = []
  const events: Array<{ event: string; handler: unknown }> = []
  const warnings: string[] = []

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
      // `on` and `logger` are Context members, not injected services: Cordis
      // provides them on every context, so they are exempt from the guard this
      // fake enforces. Without them here the recall hook could not be observed
      // at all — which is exactly why the standalone discipline package had no
      // test of its registration path.
      if (prop === 'on') {
        return (event: string, handler: unknown) => {
          events.push({ event, handler })
          return () => {}
        }
      }
      if (prop === 'logger') {
        return { warn: (message: string) => { warnings.push(message) } }
      }
      // `ctx.get(name)` is a Context method, not a service: Cordis answers it
      // from the service registry. Only `profileContext` is modelled, because
      // it is the one service the plugin reads through it (the write prefix).
      if (prop === 'get') {
        return (name: string) =>
          name === 'profileContext' && opts.profile !== undefined
            ? { name: opts.profile, dir: '/profiles/' + opts.profile }
            : undefined
      }
      if (!(prop in services)) return undefined
      if (!declared.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return services[prop]
    },
  })

  return { ctx, tools, routes, events, warnings }
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

  it('does not let a boot of the plugin write into the real home directory', async () => {
    // `apply()` schedules the upgrade reconcile, whose default home is
    // `homedir()`. Under a test runner that is the developer's actual home, and
    // this really happened: `npm run check` wrote `~/.unified-memory/bin/memory`
    // and `~/.unified-memory/upgrade.json`, with the shim pointing at the source
    // checkout instead of the installed package. The guard is `isTestProcess()`
    // in upgrade-boot.ts; this test is what keeps it there.
    const { ctx } = makeCtx()
    const before = existsSync(upgradeStatePath(homedir()))
    const beforeMtime = before ? statSync(upgradeStatePath(homedir())).mtimeMs : 0

    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
    // Let the scheduled setImmediate (if any) run and its writes land.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const after = existsSync(upgradeStatePath(homedir()))
    expect(after).toBe(before)
    if (before) expect(statSync(upgradeStatePath(homedir())).mtimeMs).toBe(beforeMtime)
  })

  it('registers the automatic recall hook under the real package name', () => {
    // The merged discipline layer. What matters here is not that a listener
    // exists but which EVENT it is on and that it is registered at all: the
    // standalone package had no test of this, so a rename of the host event
    // would have silently disabled recall without failing anything.
    const { ctx, events } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })

    expect(events.map((e) => e.event)).toEqual(['agent/pre-step'])
    expect(typeof events[0]?.handler).toBe('function')
  })

  it('publishes the live recall settings in the status payload', async () => {
    // "Nothing was injected" is ambiguous from outside: off, no match, and a
    // broken core all look the same. The payload is how a user tells them apart.
    const { ctx, routes } = makeCtx()
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault', recall: 'always', recallTimeoutMs: 3000 })

    const { res, out } = capture()
    await routes[0].handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
    const body = JSON.parse(out.body)
    expect(body.recall.mode).toBe('always')
    expect(body.recall.timeoutMs).toBe(3000)
    expect(body.recall.instructions).toBe(true)
  })

  it('takes the write prefix from the host profile, not from the environment', async () => {
    // End-to-end for the bug the panel used to show as "dsh（未识别 profile）":
    // the host publishes its profile through `profileContext`, and nothing
    // about this process looks like DSH_PROFILE.
    const { ctx, routes } = makeCtx({ profile: 'desktop' })
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })

    const { res, out } = capture()
    await routes[0].handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
    const body = JSON.parse(out.body)
    expect(body.agentName).toBe('dsh-desktop')
    expect(body.agentSource).toBe('profile')
  })

  it('registers the six tools and every route without tripping the guard', () => {
    const { ctx, tools, routes } = makeCtx()

    expect(() => host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })).not.toThrow()

    expect(tools.sort()).toEqual([
      'memory_preview',
      'memory_search',
      'memory_setup',
      'memory_show',
      'memory_status',
      'memory_submit',
    ])
    // Looked up by path, not by index: appending a route must not silently
    // re-point an assertion at a different endpoint.
    expect(routes).toHaveLength(8)
    const byPath = new Map(routes.map((r) => [r.path, r.kind]))
    expect(byPath.get('/api/dsh-unified-agent-memory/status')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/search')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/preview')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/note')).toBe('exact')
    // `/doc` reads a canonical note for the search pane; `/note` reads the
    // submission inbox for the queue. Two name spaces, two routes.
    expect(byPath.get('/api/dsh-unified-agent-memory/doc')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/dismiss')).toBe('exact')
    expect(byPath.get('/api/dsh-unified-agent-memory/stats')).toBe('exact')
    // `/doctor` carries the core's issue list — the "what do I do about it"
    // half of the health verdict. Read-only, like the rest.
    expect(byPath.get('/api/dsh-unified-agent-memory/doctor')).toBe('exact')
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
