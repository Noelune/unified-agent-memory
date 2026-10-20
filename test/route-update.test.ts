/**
 * /update — the click that installs a newer version, from both ends.
 *
 * Two layers are covered here, because they fail differently:
 *
 *  - `applyUpdate` decides *what* happens (install, retry after the host's
 *    `already-installed` refusal, or explain why nothing happened). It must
 *    never run pnpm itself — `pluginManager` is the host's own package
 *    operation, with its own rollback of `package.json` / `pnpm-lock.yaml`.
 *  - the route decides *whether* it happens at all: POST only, behind the
 *    cross-site write guard, and 409 (not 500) when the host cannot do it.
 *
 * The install path is the one place this plugin mutates the user's machine, so
 * every branch asserts the package manager was NOT called when it should not
 * have been.
 *
 * @module test/route-update.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry reading, held in a hoisted cell so the mock factory can see it.
const state = vi.hoisted(() => ({ latest: '0.8.5' as string | null, current: '0.8.4' }))

vi.mock('../src/updater.ts', () => ({
  checkForUpdate: vi.fn(),
  startUpdateWatch: vi.fn(),
  getUpdateInfo: vi.fn(() => ({
    currentVersion: state.current,
    latestVersion: state.latest,
    updateAvailable: state.latest !== null && state.latest !== state.current,
  })),
}))

import * as host from '../src/index.ts'
import { UPDATE_PATH, applyUpdate } from '../src/route-update.ts'

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

interface Calls {
  install: [string, { saveExact?: boolean } | undefined][]
  remove: string[]
}

/** A stand-in for the host's plugin manager, recording how it was asked. */
function fakeManager(behaviour: {
  install?: (spec: string) => Promise<unknown>
  remove?: (name: string) => Promise<unknown>
} = {}) {
  const calls: Calls = { install: [], remove: [] }
  const pm = {
    installBundle: vi.fn(async (spec: string, options?: { saveExact?: boolean }) => {
      calls.install.push([spec, options])
      if (behaviour.install) return behaviour.install(spec)
      return {}
    }),
    removeBundle: vi.fn(async (name: string) => {
      calls.remove.push(name)
      if (behaviour.remove) return behaviour.remove(name)
      return {}
    }),
  }
  return { pm, calls }
}

function makeCtx(pm: unknown) {
  const routes: FakeRoute[] = []
  const services: Record<string, unknown> = {
    tools: { register: () => () => {} },
    webServer: { register: (route: FakeRoute) => { routes.push(route); return () => {} } },
    // `apply` is Cordis' plugin(): the callback receives a CHILD context that
    // may read the injected service. The host entry relies on that, so the fake
    // must honour it rather than handing back the parent.
    inject: (deps: string[], apply: (child: Record<string, unknown>) => void) => {
      const child: Record<string, unknown> = {}
      if (deps.includes('approval')) child.approval = undefined
      if (deps.includes('pluginManager')) child.pluginManager = pm
      apply(child)
      return () => {}
    },
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
  const out = { code: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead: (code: number, headers: Record<string, string>) => { out.code = code; out.headers = headers; return res },
    end: (body: string) => { out.body = body },
  }
  return { res, out }
}

async function post(
  pm: unknown,
  opts: { method?: string; origin?: string } = {},
) {
  const { ctx, routes } = makeCtx(pm)
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  const route = routes.find((r) => r.path === UPDATE_PATH)
  if (!route) throw new Error('/update was never registered')
  const headers: Record<string, string> = { host: '127.0.0.1:3081' }
  if (opts.origin !== undefined) headers.origin = opts.origin
  const { res, out } = capture()
  await route.handler({
    socket: { remoteAddress: '127.0.0.1' },
    method: opts.method ?? 'POST',
    url: '/api/dsh-unified-agent-memory/update',
    headers,
  }, res)
  return { out, body: out.body ? JSON.parse(out.body) : null }
}

beforeEach(() => {
  state.latest = '0.8.5'
  state.current = '0.8.4'
})

// ── applyUpdate: the decision ──────────────────────────────────────

describe('applyUpdate', () => {
  it('installs the newer version through the host and asks for a restart', async () => {
    const { pm, calls } = fakeManager()
    const outcome = await applyUpdate(pm, { currentVersion: '0.8.4', latestVersion: '0.8.5' })

    expect(outcome).toEqual({
      ok: true, status: 'installed', version: '0.8.5', restartRequired: true, reason: null,
    })
    // Exact pin, not a range: the badge names one version and that is the one
    // that must land in the profile.
    expect(calls.install).toEqual([['dsh-unified-agent-memory@0.8.5', { saveExact: true }]])
    expect(calls.remove).toEqual([])
  })

  it('recovers from the host’s already-installed refusal by removing first', async () => {
    // The desktop app runs with HMR, and in that mode `installBundle` refuses a
    // package that is already a profile dependency. The official UI handles the
    // refusal the same way (update = remove, then install); reporting failure
    // here would make the badge permanently dead for every existing user.
    let first = true
    const { pm, calls } = fakeManager({
      install: async () => {
        if (first) {
          first = false
          throw new Error('already-installed: dsh-unified-agent-memory')
        }
        return {}
      },
    })

    const outcome = await applyUpdate(pm, { currentVersion: '0.8.4', latestVersion: '0.8.5' })

    expect(outcome.status).toBe('installed')
    expect(calls.remove).toEqual(['dsh-unified-agent-memory'])
    expect(calls.install).toHaveLength(2)
  })

  it('does not delete anything when the failure is not that refusal', async () => {
    // A network or registry error must not cost the user their installed copy.
    const { pm, calls } = fakeManager({
      install: async () => { throw new Error('ERR_PNPM_FETCH_404') },
    })

    const outcome = await applyUpdate(pm, { currentVersion: '0.8.4', latestVersion: '0.8.5' })

    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('ERR_PNPM_FETCH_404')
    expect(calls.remove).toEqual([])
  })

  it('reports the second failure as a failure, not as a half-done install', async () => {
    const { pm } = fakeManager({
      install: async () => { throw new Error('already-installed') },
      remove: async () => { throw new Error('EACCES: profile is read-only') },
    })

    const outcome = await applyUpdate(pm, { currentVersion: '0.8.4', latestVersion: '0.8.5' })

    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('failed')
    expect(outcome.restartRequired).toBe(false)
    expect(outcome.reason).toContain('read-only')
  })

  it('refuses to guess when the registry never answered', async () => {
    // `latestVersion: null` is "unknown", not "you are current". Installing
    // `@null` or claiming success would both be inventions.
    const { pm, calls } = fakeManager()
    const outcome = await applyUpdate(pm, { currentVersion: '0.8.4', latestVersion: null })

    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('unknown-version')
    expect(calls.install).toEqual([])
  })

  it('does nothing at all when the versions already match', async () => {
    const { pm, calls } = fakeManager()
    const outcome = await applyUpdate(pm, { currentVersion: '0.8.5', latestVersion: '0.8.5' })

    expect(outcome.status).toBe('up-to-date')
    expect(calls.install).toEqual([])
  })

  it('says the host cannot do it instead of installing behind its back', async () => {
    // Headless and CLI hosts have no plugin manager. The route must not fall
    // back to spawning pnpm against a profile it does not own.
    const outcome = await applyUpdate(undefined, { currentVersion: '0.8.4', latestVersion: '0.8.5' })

    expect(outcome).toEqual({
      ok: false, status: 'unsupported', version: null,
      restartRequired: false, reason: '宿主的插件管理器不可用，请手动更新',
    })
  })
})

// ── The route: who may ask ─────────────────────────────────────────

describe('POST /update', () => {
  it('registers the route exactly once', () => {
    const { ctx, routes } = makeCtx(fakeManager().pm)
    host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
    expect(routes.filter((r) => r.path === UPDATE_PATH)).toHaveLength(1)
  })

  it('installs and answers 200 with the version it installed', async () => {
    const { pm, calls } = fakeManager()
    const { out, body } = await post(pm)

    expect(out.code).toBe(200)
    expect(body.status).toBe('installed')
    expect(body.version).toBe('0.8.5')
    expect(calls.install).toHaveLength(1)
  })

  it('refuses a read method without touching the package manager', async () => {
    const { pm, calls } = fakeManager()
    const { out } = await post(pm, { method: 'GET' })

    expect(out.code).toBe(405)
    expect(calls.install).toEqual([])
  })

  it('refuses a cross-site origin without touching the package manager', async () => {
    // The reason guardWrite exists on this route specifically: an install is a
    // write to the user's profile, and any page in the browser can POST to
    // loopback. Origin is the fence.
    const { pm, calls } = fakeManager()
    const { out } = await post(pm, { origin: 'https://evil.example' })

    expect(out.code).toBe(403)
    expect(calls.install).toEqual([])
  })

  it('accepts the app’s own origin', async () => {
    const { pm } = fakeManager()
    const { out } = await post(pm, { origin: 'http://127.0.0.1:3081' })
    expect(out.code).toBe(200)
  })

  it('answers 409 — not 500 — when the host has no plugin manager', async () => {
    const { out, body } = await post(undefined)

    expect(out.code).toBe(409)
    expect(body.status).toBe('unsupported')
    expect(body.ok).toBe(false)
  })

  it('answers 409 when the registry reading is still unknown', async () => {
    state.latest = null
    const { pm, calls } = fakeManager()
    const { out, body } = await post(pm)

    expect(out.code).toBe(409)
    expect(body.status).toBe('unknown-version')
    expect(calls.install).toEqual([])
  })

  it('answers 409 with the host’s words when the install fails', async () => {
    const { pm } = fakeManager({ install: async () => { throw new Error('pnpm exited 1') } })
    const { out, body } = await post(pm)

    expect(out.code).toBe(409)
    expect(body.status).toBe('failed')
    expect(body.reason).toContain('pnpm exited 1')
  })
})
