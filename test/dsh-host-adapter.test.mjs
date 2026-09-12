import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = await import('../lib/index.js')

function makeContext() {
  const tools = []
  return {
    tools: { register(definition) { tools.push(definition) } },
    inject(_deps, callback) {
      const host = { webServer: undefined, effect(execute) { return execute() } }
      callback(host)
    },
    toolsList: tools,
  }
}

test('loads as a current DSH plugin and registers all four memory tools', () => {
  assert.equal(plugin.default.apply, plugin.apply)
  const ctx = makeContext()
  plugin.apply(ctx, {})
  assert.deepEqual(ctx.toolsList.map((tool) => tool.name), [
    'memory_search', 'memory_show', 'memory_submit', 'memory_status',
  ])
})

test('treats string false as disabled remote configuration', () => {
  const ctx = makeContext()
  const { cfg } = plugin.apply(ctx, { remoteEnabled: 'false' })
  assert.equal(cfg.remoteEnabled, false)
})

test('redacts credentials and truncates core output before returning tool results', async () => {
  const ctx = makeContext()
  const temp = await mkdtemp(join(tmpdir(), 'uam-dsh-'))
  const core = join(temp, 'core')
  const packageDir = join(core, 'unified_memory')
  await writeFile(join(temp, 'marker'), 'fixture', 'utf8')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(packageDir, { recursive: true }))
  await writeFile(join(packageDir, '__init__.py'), '', 'utf8')
  await writeFile(join(packageDir, 'memory.py'), [
    'import sys',
    'if __name__ == "__main__":',
    '    sys.stdout.write("api_key" + "=" + "fixture-value-1234\\n" + ("x" * 1200000))',
  ].join('\n'), 'utf8')
  try {
    plugin.apply(ctx, { vaultPath: temp, corePath: core, pythonPath: process.env.PYTHON || 'python' })
    const search = ctx.toolsList.find((tool) => tool.name === 'memory_search')
    const result = await search.execute({ query: 'fixture' })
    assert.equal(result.ok, true)
    assert.ok(result.output.length <= 1024 * 1024)
    assert.match(result.output, /<REDACTED>/)
    assert.doesNotMatch(result.output, /fixture-value-1234/)
    assert.match(result.output, /truncated/i)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('does not require an optional web server and removes a route on disposal', async () => {
  const ctx = makeContext()
  plugin.apply(ctx, {})

  const server = new EventEmitter()
  let disposed = false
  let registeredDisposer
  const routeCtx = {
    webServer: { httpServer: server },
    effect(execute) {
      const cleanup = execute()
      registeredDisposer = async () => { disposed = true; await cleanup?.() }
      return registeredDisposer
    },
  }
  const injected = {
    tools: { register() {} },
    inject(_deps, callback) { return callback(routeCtx) },
  }
  plugin.apply(injected, {})
  assert.equal(server.listenerCount('request'), 1)
  const handler = server.listeners('request')[0]
  const response = {
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
  assert.equal(handler({ method: 'GET', url: '/api/dsh-unified-agent-memory/status' }, response), true)
  assert.equal(response.status, 200)
  assert.equal(disposed, false)
  await registeredDisposer?.()
  assert.equal(disposed, true)
  assert.equal(server.listenerCount('request'), 0)
})

test('rejects path traversal document names without invoking the core', async () => {
  const ctx = makeContext()
  plugin.apply(ctx, { vaultPath: 'C:/fixture-vault' })
  const show = ctx.toolsList.find((tool) => tool.name === 'memory_show')
  const result = await show.execute({ doc: '../secret.md' })
  assert.equal(result.ok, false)
  assert.match(result.output, /unknown document/)
})
