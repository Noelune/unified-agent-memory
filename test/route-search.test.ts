import { describe, expect, it } from 'vitest'
import { SEARCH_PATH, buildSearchArgs, shapeSearchResult } from '../src/route-search.ts'

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

describe('SEARCH_PATH', () => {
  it('is namespaced under the plugin', () => {
    expect(SEARCH_PATH.startsWith('/api/dsh-unified-agent-memory/')).toBe(true)
  })
})
