import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const client = await readFile(new URL('../lib/client-ui.js', import.meta.url), 'utf8')
const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

test('client factory returns a Cordis plugin instead of undefined', () => {
  assert.match(client, /exports\.apply\s*=\s*apply/)
  assert.match(client, /exports\.inject\s*=\s*inject/)
  assert.match(client, /return module\.exports/)
})

test('reports local context, inbox, and index health without remote access', () => {
  assert.match(host, /contextPath/)
  assert.match(host, /inboxPending/)
  assert.match(host, /indexExists/)
  assert.match(host, /memoryUiStatus\(cfg\)/)
})
