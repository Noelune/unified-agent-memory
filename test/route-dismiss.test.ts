/**
 * Tests for POST /dismiss — the single write path in this plugin.
 *
 * The route is the one place where a request mutates the vault, so it is also
 * the one place where the negative cases carry the weight: a name that escapes
 * the inbox must never reach the core, and a failed move must not be reported
 * as a success. Task 5 taught the cost of leaving a handler's `!r.ok` and catch
 * branches untested — a mutation there kept the suite green — so both are
 * exercised here with `runCore` stubbed out.
 *
 * @module test/route-dismiss.test
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DISMISS_PATH, buildDismissArgs, parseDismissBody, shapeDismissResult,
} from '../src/route-dismiss.ts'

describe('parseDismissBody', () => {
  it('reads the name', () => {
    expect(parseDismissBody('{"name":"a.md"}')).toBe('a.md')
  })
  it('rejects a missing or empty name', () => {
    expect(parseDismissBody('{}')).toBeNull()
    expect(parseDismissBody('{"name":""}')).toBeNull()
    expect(parseDismissBody('not json')).toBeNull()
  })
  it('rejects a non-string name', () => {
    expect(parseDismissBody('{"name":123}')).toBeNull()
  })
  it('rejects traversal before it ever reaches the core', () => {
    expect(parseDismissBody('{"name":"../x"}')).toBeNull()
    expect(parseDismissBody('{"name":"a/b"}')).toBeNull()
    expect(parseDismissBody('{"name":"a\\\\b"}')).toBeNull()
  })
})

describe('buildDismissArgs', () => {
  it('invokes the core dismiss command', () => {
    expect(buildDismissArgs('a.md')).toEqual(['dismiss', 'a.md', '--json'])
  })
})

describe('shapeDismissResult', () => {
  it('reports success', () => {
    const raw = JSON.stringify({ ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } })
    const got = shapeDismissResult(raw)
    expect(got.ok).toBe(true)
    expect(got.reason).toBeNull()
  })
  it('surfaces the reason on refusal', () => {
    const raw = JSON.stringify({ ok: true, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'not-found' } })
    expect(shapeDismissResult(raw).reason).toBe('not-found')
  })
  it('degrades on bad json', () => {
    expect(shapeDismissResult('x').ok).toBe(false)
  })
})

describe('DISMISS_PATH', () => {
  it('is namespaced', () => {
    expect(DISMISS_PATH.startsWith('/api/dsh-unified-agent-memory/')).toBe(true)
  })
})

// ── Host-side name whitelist ────────────────────────────────────────
// Core repeats this rule, but validation belongs here too: a name that can
// escape the inbox must be refused with a 400, not handed to a spawned process.

describe('parseDismissBody name whitelist', () => {
  it.each([
    ['{"name":"~x"}', 'tilde-prefixed'],
    ['{"name":"a:b"}', 'colon (drive/ADS syntax)'],
    ['{"name":"a\\u0000b"}', 'NUL byte'],
    ['{"name":"."}', 'dot'],
    ['{"name":".."}', 'dot-dot'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseDismissBody(raw)).toBeNull()
  })

  it('accepts an ordinary inbox filename', () => {
    expect(parseDismissBody('{"name":"dsh-2026-09-22-001.md"}')).toBe('dsh-2026-09-22-001.md')
  })
})

// ── handleDismiss: the two branches Task 5 showed can rot ───────────

vi.mock('../src/utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils.ts')>()),
  runCore: vi.fn(),
}))

import { handleDismiss } from '../src/route-dismiss.ts'
import { runCore } from '../src/utils.ts'

const cfg = { vaultPath: 'C:/tmp/vault' } as never

describe('handleDismiss', () => {
  it('passes a successful move straight through', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(true)
    expect(got.name).toBe('a.md')
  })

  it('degrades to unavailable when the core call itself fails (!r.ok)', async () => {
    // The mutation Task 5's reviewer used: flipping this branch to report
    // success kept the old suite green because nothing observed it.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '' })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('unavailable')
  })

  it('degrades to unavailable when the core call throws', async () => {
    vi.mocked(runCore).mockRejectedValue(new Error('spawn ENOENT'))
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('unavailable')
  })

  it('reports a refused move as not-ok with the reason from the core', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'outside-inbox' } }) })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('outside-inbox')
  })
})
