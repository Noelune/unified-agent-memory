import { describe, it, expect } from 'vitest'
import { buildStatsArgs, shapeStatsResult, STATS_PATH } from '../src/route-stats.ts'

describe('stats route', () => {
  it('pins the exact path the client imports', () => {
    expect(STATS_PATH).toBe('/api/dsh-unified-agent-memory/stats')
  })

  it('asks core for the json envelope', () => {
    expect(buildStatsArgs()).toEqual(['stats', '--json'])
  })

  it('passes a well-formed envelope through', () => {
    const raw = JSON.stringify({ ok: true, command: 'stats', data: { daily: [] } })
    const got = shapeStatsResult(raw)
    expect(got.ok).toBe(true)
    expect(got.data).toEqual({ daily: [] })
  })

  it('degrades to ok:false on a core failure envelope', () => {
    const got = shapeStatsResult(JSON.stringify({ ok: false, command: 'stats' }))
    expect(got.ok).toBe(false)
    expect(got.data).toBeNull()
  })

  it('degrades to ok:false on unparseable output', () => {
    expect(shapeStatsResult('not json').ok).toBe(false)
    expect(shapeStatsResult('not json').data).toBeNull()
  })
})
