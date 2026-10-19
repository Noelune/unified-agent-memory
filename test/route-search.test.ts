import { describe, expect, it, vi } from 'vitest'

// Stub the core runner so the degradation branch is exercised without spawning
// Python. `/status` has the same need; see the stub-core note in plugin.test.ts.
vi.mock('../src/utils.ts', () => ({ runCore: vi.fn() }))

import {
  SEARCH_LIMIT,
  SEARCH_PATH,
  buildSearchArgs,
  clampSearchLimit,
  handleSearch,
  shapeSearchResult,
} from '../src/route-search.ts'
import { runCore } from '../src/utils.ts'

describe('buildSearchArgs', () => {
  it('passes the query and asks for JSON', () => {
    expect(buildSearchArgs('记忆', false)).toEqual(['search', '记忆', '--json'])
  })

  it('adds --hybrid only when requested', () => {
    expect(buildSearchArgs('记忆', true)).toEqual(['search', '记忆', '--json', '--hybrid'])
  })

  it('forwards a limit so ?limit= is not silently ignored', () => {
    // The route used to accept `?limit=20` and drop it on the floor, which
    // reads as a broken parameter rather than an unsupported one.
    expect(buildSearchArgs('记忆', false, 20)).toEqual([
      'search', '记忆', '--json', '--limit', '20',
    ])
    expect(buildSearchArgs('记忆', true, 3)).toEqual([
      'search', '记忆', '--json', '--hybrid', '--limit', '3',
    ])
  })

  it('omits a limit that would make argparse exit non-zero', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildSearchArgs('q', false, bad)).toEqual(['search', 'q', '--json'])
    }
  })
})

describe('clampSearchLimit', () => {
  it('defaults to the core default when absent or unusable', () => {
    expect(clampSearchLimit(null)).toBe(SEARCH_LIMIT)
    expect(clampSearchLimit('')).toBe(SEARCH_LIMIT)
    expect(clampSearchLimit('abc')).toBe(SEARCH_LIMIT)
    expect(clampSearchLimit('0')).toBe(SEARCH_LIMIT)
    expect(clampSearchLimit('-5')).toBe(SEARCH_LIMIT)
  })

  it('floors fractional values and clamps the ceiling', () => {
    expect(clampSearchLimit('7.9')).toBe(7)
    expect(clampSearchLimit('999999')).toBe(50)
  })
})

describe('shapeSearchResult', () => {
  it('unwraps the core envelope', () => {
    const raw = JSON.stringify({
      ok: true,
      command: 'search',
      data: { query: '记忆', mode: 'local', count: 1,
              results: [{ doc: 'a.md', title: 'A', snippet: '', query: '记忆', untrusted: true }] },
    })
    const got = shapeSearchResult(raw)
    expect(got.ok).toBe(true)
    expect(got.count).toBe(1)
    expect(got.results).toHaveLength(1)
  })

  it('degrades to an empty result on unparseable output', () => {
    const got = shapeSearchResult('not json')
    expect(got.ok).toBe(false)
    expect(got.results).toEqual([])
    expect(got.count).toBe(0)
  })

  it('degrades when the envelope reports failure', () => {
    const got = shapeSearchResult(JSON.stringify({ ok: false, error: 'nope' }))
    expect(got.ok).toBe(false)
    expect(got.results).toEqual([])
  })
})

describe('handleSearch', () => {
  const cfg = {
    vaultPath: 'C:/tmp/vault', pythonPath: 'python',
    corePath: 'C:/tmp/core', remoteEnabled: false,
  }

  it('degrades to an empty result when the core call fails', async () => {
    // Mutation-proof: flipping `if (!r.ok)` to return `ok: true` must break
    // this test, not stay green.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'crash', error: 'boom' })

    const got = await handleSearch(cfg, '记忆', false)

    expect(got.ok).toBe(false)
    expect(got.results).toEqual([])
    expect(got.count).toBe(0)
  })
})

describe('SEARCH_PATH', () => {
  it('is namespaced under the plugin', () => {
    expect(SEARCH_PATH.startsWith('/api/dsh-unified-agent-memory/')).toBe(true)
  })
})
