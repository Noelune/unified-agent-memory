/**
 * Built-artifact contract tests (node:test).
 *
 * These assert on the SHIPPED bundles (`lib/client-ui.js`, `lib/index.js`) —
 * the bytes the harness actually loads — rather than on `src/`. That is the
 * point: a client bundle that builds cleanly but no longer exposes a Cordis
 * plugin shape fails at runtime with
 * `invalid plugin, expect function or object with an "apply" method`,
 * and a host bundle that drops a status field makes the sidebar console render
 * a blank figure with no error. Neither is visible to the vitest suite, which
 * runs against TypeScript sources.
 *
 * Run with `npm run test:node` AFTER `npm run build` (both are part of
 * `npm run check`, where build precedes test:node).
 *
 * The previous revision of this file asserted `exports.apply = apply` and a set
 * of retired host fields (`contextPath`, `indexExists`, `memoryUiStatus`). The
 * esbuild CJS interop emits `apply: () => apply`, and those fields were removed
 * on purpose — so the file was red for reasons that were never real defects.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const client = await readFile(new URL('../lib/client-ui.js', import.meta.url), 'utf8')
const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

// ── Client bundle: must be loadable as a Cordis plugin ──────────────

test('client bundle is wrapped in a ModuleLoader factory', () => {
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: 'dsh-unified-agent-memory'/)
  assert.match(client, /factory: \(require\)/)
  assert.match(client, /return module\.exports/)
})

test('client factory exports the Cordis plugin shape, not just side effects', () => {
  // esbuild's CJS interop emits getters named `apply`/`inject`; the client
  // runtime's `registry.plugin()` rejects anything without `apply`.
  assert.match(client, /apply: \(\) => apply/)
  assert.match(client, /inject: \(\) => inject/)
})

test('client half mounts through the slots service, not the global DOM', () => {
  // The two seats the plugin occupies. Renaming either id in
  // src/client/index.ts without updating the contract drops the UI silently.
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /shell\.overlay/)
  // The client contract forbids reaching for product globals or hard-coded DOM.
  assert.doesNotMatch(client, /__DSH_SIDEBAR_SEATS__/)
})

// ── Client bundle: executed, not just pattern-matched ──────────────

test('client bundle runs in a ModuleLoader harness and mounts both slots', async () => {
  // Pattern-matching the bundle proves it *contains* the right strings; this
  // proves the harness can actually evaluate it and that `apply()` reaches the
  // `slots` service. A DSH update that changes the client-plugin contract
  // (loader globals, the plugin shape, the slot names) shows up here.
  const loaded = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => loaded.push(mod) } },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(client, sandbox, { filename: 'client-ui.js' })

  assert.equal(loaded.length, 1, 'bundle must announce itself exactly once')
  const [{ id, factory }] = loaded
  assert.equal(id, 'dsh-unified-agent-memory')

  // Only `react` is external. Nothing renders, so a callable stand-in is enough.
  const react = new Proxy({}, { get: () => () => null })
  const mod = factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require("${name}") in the client bundle`)
  })

  assert.equal(mod.name, 'dsh-unified-agent-memory')
  assert.deepEqual([...mod.inject], ['slots'], 'the client half needs the slots service')
  assert.equal(typeof mod.apply, 'function')

  const mounted = []
  const slots = {
    inject(slot, callback) {
      mounted.push({ slot })
      callback()
      return () => {}
    },
    register(entry, component) {
      Object.assign(mounted[mounted.length - 1], {
        id: entry.id,
        name: entry.name,
        component,
      })
      return () => {}
    },
  }
  mod.apply({ slots })

  assert.deepEqual(mounted.map((m) => m.slot), ['sidebar.footer.action', 'shell.overlay'])
  assert.deepEqual(mounted.map((m) => m.id),
    ['dsh-unified-agent-memory', 'dsh-unified-agent-memory-sheet'])
  for (const seat of mounted) {
    assert.equal(seat.name, seat.slot, 'register() must target the slot it was injected into')
    assert.equal(typeof seat.component, 'function', `${seat.slot} needs a React component`)
  }
})

// ── Host bundle: the /status payload the console polls ──────────────

test('host exposes the status route the browser half polls', () => {
  assert.match(host, /\/api\/dsh-unified-agent-memory\/status/)
})

test('host status payload still carries the fields the console reads', () => {
  for (const field of ['configured', 'latestVersion', 'updateAvailable', 'inboxPending']) {
    assert.match(host, new RegExp(field), `host bundle lost the "${field}" field`)
  }
})

test('host bundle has retired the pre-refactor status exports', () => {
  // Regression guard: these were removed deliberately. Their return would mean
  // an old branch was merged back in.
  for (const retired of ['contextPath', 'indexExists', 'memoryUiStatus']) {
    assert.doesNotMatch(host, new RegExp(retired), `"${retired}" was retired and must not come back`)
  }
})
