import { describe, expect, it, vi } from 'vitest'

// Stub the core runner so the degradation branches are exercised without
// spawning Python. Same stub-core pattern as route-search.test.ts.
vi.mock('../src/utils.ts', () => ({ runCore: vi.fn() }))

import {
  PREVIEW_VIEWS, buildNoteArgs, buildPreviewArgs, clampPreviewLimit,
  handleNote, handlePreview, shapeNoteResult, shapePreviewResult,
} from '../src/route-preview.ts'
import { runCore } from '../src/utils.ts'

const cfg = {
  vaultPath: 'C:/tmp/vault', pythonPath: 'python',
  corePath: 'C:/tmp/core', remoteEnabled: false,
}

describe('buildPreviewArgs', () => {
  it('names the view and caps the list', () => {
    expect(buildPreviewArgs('pending', 20)).toEqual(
      ['preview', 'pending', '--limit', '20', '--json'])
  })
})

describe('buildNoteArgs', () => {
  it('reads by name', () => {
    expect(buildNoteArgs('a.md')).toEqual(['note', 'a.md', '--json'])
  })
})

describe('PREVIEW_VIEWS', () => {
  it('covers the four governance views', () => {
    expect([...PREVIEW_VIEWS]).toEqual(['pending', 'recent', 'forgetting', 'conflicts'])
  })
})

describe('shapePreviewResult', () => {
  it('carries the unsupported status through', () => {
    const raw = JSON.stringify({ ok: true, command: 'preview',
      data: { view: 'conflicts', status: 'unsupported', count: 0, items: [] } })
    const got = shapePreviewResult(raw)
    expect(got.status).toBe('unsupported')
    expect(got.view).toBe('conflicts')
  })

  it('degrades on bad json', () => {
    const got = shapePreviewResult('{')
    expect(got.ok).toBe(false)
    expect(got.items).toEqual([])
  })
})

describe('shapeNoteResult', () => {
  it('returns the body', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'a.md', body: '- hi' } })
    expect(shapeNoteResult(raw).body).toBe('- hi')
  })

  it('keeps body null when the item is missing', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'a.md', body: null } })
    expect(shapeNoteResult(raw).body).toBeNull()
  })

  it('degrades on bad json', () => {
    expect(shapeNoteResult('nope').ok).toBe(false)
  })

  it('passes the core reason through on a readable item', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'a.md', body: '- hi', reason: null, untrusted: true } })
    expect(shapeNoteResult(raw).reason).toBeNull()
  })

  it('passes the core reason through when the item is unreadable', () => {
    // Mutation-proof: dropping `reason` from the payload must break this.
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: '../evil.md', body: null, reason: 'invalid-name', untrusted: true } })
    const got = shapeNoteResult(raw)
    expect(got.reason).toBe('invalid-name')
    expect(got.body).toBeNull()
  })

  it('passes not-found through as its own reason', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'gone.md', body: null, reason: 'not-found', untrusted: true } })
    expect(shapeNoteResult(raw).reason).toBe('not-found')
  })
})

describe('clampPreviewLimit', () => {
  it.each([
    [null, 20], ['', 20], ['20', 20], ['abc', 20], ['-5', 20], ['0', 20],
    ['1.9', 1], ['100', 100], ['101', 100], ['999999999999', 100],
    ['Infinity', 20], ['NaN', 20], ['x'.repeat(5000), 20],
  ])('clamps %j to %i', (raw, want) => {
    expect(clampPreviewLimit(raw)).toBe(want)
  })
})

describe('handlePreview', () => {
  it('degrades to an empty result when the core call fails', async () => {
    // Mutation-proof: flipping `if (!r.ok)` to return `ok: true` must break
    // this test, not stay green.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'crash', error: 'boom' })

    const got = await handlePreview(cfg, 'pending', 20)

    expect(got.ok).toBe(false)
    expect(got.items).toEqual([])
    expect(got.count).toBe(0)
  })

  it('clamps an over-large limit in the argv sent to the core', async () => {
    // Mutation-proof: deleting the 100 ceiling must break this test.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'preview',
      data: { view: 'recent', status: 'ok', count: 0, items: [] } }) })

    await handlePreview(cfg, 'recent', clampPreviewLimit('999999'))

    const argv = vi.mocked(runCore).mock.calls.at(-1)?.[1]
    expect(argv).toEqual(['preview', 'recent', '--limit', '100', '--json'])
  })
})

describe('handleNote', () => {
  it('degrades to an empty result when the core call fails', async () => {
    // Mutation-proof: flipping `if (!r.ok)` to return `ok: true` must break
    // this test, not stay green.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'crash', error: 'boom' })

    const got = await handleNote(cfg, 'a.md')

    expect(got.ok).toBe(false)
    expect(got.body).toBeNull()
  })

  it('keeps the core reason when the name is refused', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'note',
      data: { name: '../evil.md', body: null, reason: 'invalid-name', untrusted: true } }) })

    expect((await handleNote(cfg, '../evil.md')).reason).toBe('invalid-name')
  })
})
