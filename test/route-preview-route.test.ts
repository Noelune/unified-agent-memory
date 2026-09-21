/**
 * Route-level tests for GET /preview's host-side validation (I1).
 *
 * An unknown `view` used to travel to the core verbatim, where argparse exits 2
 * with empty stdout and the caller saw a generic `status: 'error'` — the same
 * shape as "the core is down". An operator reading that goes looking at the
 * core. Validating against PREVIEW_VIEWS here makes a typo a 400 instead.
 *
 * Reuses the fake-cordis harness from plugin.test.ts so the real handler runs.
 *
 * @module test/route-preview-route.test
 */

import { describe, it, expect, vi } from 'vitest'

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
import { PREVIEW_VIEWS } from '../src/route-preview.ts'
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

async function getPreview(url: string) {
  vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
    ok: true, command: 'preview',
    data: { view: 'pending', status: 'ok', count: 0, items: [] } }) })

  const { ctx, routes } = makeCtx()
  host.apply(ctx as never, { vaultPath: 'C:/tmp/vault' })
  const route = routes.find((r) => r.path.endsWith('/preview'))!
  const { res, out } = capture()
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url }, res)
  return out
}

describe('GET /preview view validation', () => {
  it('rejects an unknown view with 400 instead of blaming the core', async () => {
    const out = await getPreview('/api/dsh-unified-agent-memory/preview?view=peding')
    expect(out.code).toBe(400)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'unknown view' })
    // The typo must not have reached the core at all.
    expect(vi.mocked(runCore)).not.toHaveBeenCalled()
  })

  it.each([...PREVIEW_VIEWS])('lets the legal view %s through', async (view) => {
    const out = await getPreview(`/api/dsh-unified-agent-memory/preview?view=${view}`)
    expect(out.code).toBe(200)
  })

  it('treats an absent view as the default rather than an error', async () => {
    const out = await getPreview('/api/dsh-unified-agent-memory/preview')
    expect(out.code).toBe(200)
  })
})
