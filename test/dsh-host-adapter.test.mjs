/**
 * Host-adapter contract tests (node:test).
 *
 * These exercise the BUILT host bundle (`lib/index.js`) against the shape DSH
 * 0.2.0 actually provides, so they fail loudly when the adapter drifts from the
 * host. The previous revision of this file had stopped doing that: it asserted
 * a `plugin.default` namespace, an optional `webServer`, four tools, an
 * `apply()` return value, and a redaction layer — none of which exist any more.
 * Because nothing ran the file, all of it went unnoticed.
 *
 * Run with `npm run test:node` (also part of `npm run check`, after `build`).
 *
 * Design notes:
 *   - `lib/index.js` is ESM with `@deepseek-ai/dsh-tools` external, so importing
 *     it needs devDependencies installed. It does NOT need a vault, Python, or a
 *     live harness: every case here either stays in the degraded path or is
 *     rejected before the core is spawned.
 *   - The context is a hand-rolled stand-in, not a real Cordis context. Cordis's
 *     `inject` guard only exists inside a harness scope, so a fake ctx cannot
 *     reproduce it; these tests assert the *declaration* (`export const inject`)
 *     and the registration calls, not the guard itself.
 *   - Degraded mode is exercised in a CHILD PROCESS with HOME/USERPROFILE
 *     pointed at an empty temp directory. `resolveConfig` falls back to the
 *     core's own `~/.unified-memory.yaml`, so an in-process assertion would pass
 *     on CI and fail on any developer machine that has a vault configured —
 *     which is exactly what happened when the fallback was added.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  validateDocId, clampLimit, buildSearchArgv, buildPreviewArgv, resolveConfig,
} from '../lib/utils.js'

const plugin = await import('../lib/index.js')

/** Every exact HTTP route the host half registers, in registration order. */
const ROUTE_PATHS = [
  '/api/dsh-unified-agent-memory/status',
  '/api/dsh-unified-agent-memory/search',
  '/api/dsh-unified-agent-memory/preview',
  '/api/dsh-unified-agent-memory/note',
  // Canonical-note reader for the search pane. `/note` above reads the
  // submission inbox and answers `outside-inbox` for a canonical note, so the
  // two name spaces need two routes.
  '/api/dsh-unified-agent-memory/doc',
  '/api/dsh-unified-agent-memory/dismiss',
  '/api/dsh-unified-agent-memory/stats',
]

/** Every model tool the host half registers, in registration order. */
const TOOL_NAMES = [
  'memory_search',
  'memory_show',
  'memory_submit',
  'memory_status',
  'memory_preview',
  'memory_setup',
]

/**
 * Minimal stand-in for the harness context.
 *
 * `tools.register` and `webServer.register` are the only two services the
 * adapter touches, and both are recorded so the assertions can see exactly what
 * was registered without booting Cordis.
 */
function makeContext() {
  const tools = []
  const routes = []
  return {
    toolsList: tools,
    routeList: routes,
    ctx: {
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
}

/** The smallest argument set each tool needs to reach its own logic. */
function argsFor(name) {
  if (name === 'memory_search') return { query: 'anything' }
  if (name === 'memory_show') return { doc: 'index' }
  if (name === 'memory_submit') return { facts: '- a fact' }
  if (name === 'memory_preview') return { view: 'pending' }
  return {}
}

// ── Plugin shape ────────────────────────────────────────────────────

test('exports the Cordis plugin shape DSH requires', () => {
  assert.equal(plugin.name, 'dsh-unified-agent-memory')
  assert.equal(typeof plugin.apply, 'function')
  // Declaring webServer here (rather than pulling it in with a nested
  // ctx.inject) is what keeps the route half alive; a regression to the nested
  // form fails at boot with `cannot get property "webServer" without inject`.
  assert.deepEqual([...plugin.inject], ['tools', 'webServer'])
})

// ── Registration ────────────────────────────────────────────────────

test('registers all six memory tools', () => {
  const { ctx, toolsList } = makeContext()
  plugin.apply(ctx, {})

  assert.deepEqual(toolsList.map((tool) => tool.name), TOOL_NAMES)
  for (const tool of toolsList) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`)
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output && tool.output.schema, `${tool.name} needs an output schema`)
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('registers the seven exact HTTP routes for the browser half', () => {
  const { ctx, routeList } = makeContext()
  plugin.apply(ctx, {})

  assert.deepEqual(routeList.map((route) => route.path), ROUTE_PATHS)
  for (const route of routeList) {
    // 'exact' (not 'prefix') is what keeps these routes off the host's /api
    // prefix auth path; switching kinds would silently change the security
    // posture of the only write route.
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})

// ── Degraded mode ───────────────────────────────────────────────────

test('answers with a setup guide instead of failing when no vault is configured', () => {
  // Run in a child process with a scrubbed HOME so the core-config fallback
  // cannot find a real ~/.unified-memory.yaml and mask the degraded path.
  const emptyHome = mkdtempSync(join(tmpdir(), 'uam-nohome-'))
  const pluginUrl = pathToFileURL(fileURLToPath(new URL('../lib/index.js', import.meta.url))).href
  const script = `
    const plugin = await import(${JSON.stringify(pluginUrl)})
    const tools = []
    plugin.apply(
      { tools: { register: (d) => { tools.push(d); return () => {} } },
        webServer: { register: () => () => {} } },
      {},
    )
    const args = {
      memory_search: { query: 'anything' },
      memory_show: { doc: 'index' },
      memory_submit: { facts: '- a fact' },
      memory_preview: { view: 'pending' },
      memory_status: {},
    }
    const out = []
    for (const t of tools) {
      const r = await t.execute(args[t.name] ?? {})
      out.push({ name: t.name, ok: r.ok, output: String(r.output ?? '') })
    }
    console.log(JSON.stringify(out))
  `
  try {
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        // A stale UNIFIED_MEMORY_VAULT would defeat the point of the test.
        UNIFIED_MEMORY_VAULT: '',
      },
    })
    const results = JSON.parse(raw.trim().split('\n').pop())
    assert.equal(results.length, 6, 'all six tools should be registered')
    // memory_setup is the documented way OUT of the unconfigured state; it
    // answers with a plan instead of a "not configured" refusal, so it is
    // asserted separately below rather than excluded silently.
    const readers = results.filter((r) => r.name !== 'memory_setup')
    assert.equal(readers.length, 5)
    for (const r of readers) {
      assert.equal(r.ok, false, `${r.name} should degrade, not throw`)
      assert.match(r.output, /not configured/)
      assert.match(r.output, /UNIFIED_MEMORY_VAULT/)
    }
    const setup = results.find((r) => r.name === 'memory_setup')
    assert.equal(setup.ok, true, 'the setup tool answers with a plan, not a refusal')
    assert.match(setup.output, /UnifiedAgentMemory/)
  } finally {
    rmSync(emptyHome, { recursive: true, force: true })
  }
})

// ── Input validation (no core spawn) ────────────────────────────────

test('rejects path traversal document names without invoking the core', async () => {
  const { ctx, toolsList } = makeContext()
  plugin.apply(ctx, { vaultPath: 'C:/fixture-vault' })

  const show = toolsList.find((tool) => tool.name === 'memory_show')
  const result = await show.execute({ doc: '../secret.md' })

  assert.equal(result.ok, false)
  assert.match(result.output, /unknown document/)
})

test('rejects an unknown preview view without invoking the core', async () => {
  const { ctx, toolsList } = makeContext()
  plugin.apply(ctx, { vaultPath: 'C:/fixture-vault' })

  const preview = toolsList.find((tool) => tool.name === 'memory_preview')
  const result = await preview.execute({ view: 'nonsense' })

  assert.equal(result.ok, false)
  assert.match(result.output, /unknown view/)
})

// ── Pure helpers the adapter delegates to ───────────────────────────

test('validateDocId accepts built-in ids and *.md notes, rejects traversal', () => {
  for (const doc of ['index', 'prefs', 'env', 'rules', 'tools', 'ui', 'coord', '实体.md']) {
    assert.equal(validateDocId(doc).valid, true, `${doc} should be accepted`)
  }
  for (const doc of ['../secret.md', 'sub/dir.md', 'sub\\dir.md', 'index.md.exe', '']) {
    assert.equal(validateDocId(doc).valid, false, `${doc} should be rejected`)
  }
})

test('clampLimit bounds the search limit into [1, 50]', () => {
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit(-5), 1)
  assert.equal(clampLimit(999), 50)
  assert.equal(clampLimit(undefined), 8)
  assert.equal(clampLimit('12'), 12)
})

test('buildSearchArgv only forwards known hybrid formats and positive budgets', () => {
  assert.deepEqual(buildSearchArgv('q'), ['search', 'q', '--limit', '8'])
  assert.deepEqual(
    buildSearchArgv('q', { limit: 3, hybrid: true, format: 'compact', budget: 500 }),
    ['search', 'q', '--limit', '3', '--hybrid', '--format', 'compact', '--budget', '500'],
  )
  // An unknown format or a non-positive budget is dropped rather than passed
  // on: argparse would exit 2 with empty stdout, which the caller reads as a
  // dead core instead of a bad argument.
  assert.deepEqual(buildSearchArgv('q', { format: 'yaml', budget: 0 }), ['search', 'q', '--limit', '8'])
})

test('buildPreviewArgv validates the view and forwards json', () => {
  assert.deepEqual(buildPreviewArgv('pending', { limit: 5 }), ['preview', 'pending', '--limit', '5'])
  assert.deepEqual(buildPreviewArgv('recent', { json: true }), ['preview', 'recent', '--limit', '20', '--json'])
  assert.throws(() => buildPreviewArgv('nope'), /unknown view/)
})

test('resolveConfig prefers explicit config over environment defaults', () => {
  const cfg = resolveConfig({ vaultPath: '/from/config', pythonPath: 'py3' })
  assert.equal(cfg.vaultPath, '/from/config')
  assert.equal(cfg.pythonPath, 'py3')
  // corePath defaults to the package's own core/ so no pip install is needed.
  assert.match(cfg.corePath, /core$/)
  assert.equal(cfg.remoteEnabled, false)
})
