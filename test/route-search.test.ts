import { describe, expect, it, vi } from 'vitest'

// Stub the core runner so the degradation branch is exercised without spawning
// Python. `/status` has the same need; see the stub-core note in plugin.test.ts.
vi.mock('../src/utils.ts', () => ({ runCore: vi.fn() }))

import { SEARCH_PATH, buildSearchArgs, handleSearch, shapeSearchResult } from '../src/route-search.ts'
import { runCore } from '../src/utils.ts'

describe('buildSearchArgs', () => {
  it('passes the query and asks for JSON', () => {
    expect(buildSearchArgs('记忆', false)).toEqual(['search', '记忆', '--json'])
  })

  it('adds --hybrid only when requested', () => {
    expect(buildSearchArgs('记忆', true)).toEqual(['search', '记忆', '--json', '--hybrid'])
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
