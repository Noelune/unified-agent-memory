import { describe, it, expect } from 'vitest'
import { buildStatusPayload } from '../src/status-payload.ts'

describe('buildStatusPayload', () => {
  const cfg = { vaultPath: '/v', pythonPath: 'python', corePath: '/c', remoteEnabled: false }
  const ui = { currentVersion: '0.5.2', latestVersion: '0.5.2', updateAvailable: false }

  it('keeps the existing keys and adds the read-only stats', () => {
    const p = buildStatusPayload(cfg, ui, { memories: 42, vectors: 7, pending: 3, indexOk: true })
    expect(p.ok).toBe(true)
    expect(p.vaultPath).toBe('/v')
    expect(p.version).toBe('0.5.2')
    expect(p.remoteEnabled).toBe(false)
    expect(p.stats).toEqual({ memories: 42, vectors: 7, pending: 3 })
    expect(p.index).toEqual({ ok: true })
  })

  it('degrades to null stats when the core is unavailable', () => {
    const p = buildStatusPayload({ ...cfg, vaultPath: '' }, { ...ui, latestVersion: '' }, null)
    expect(p.ok).toBe(true)
    expect(p.configured).toBe(false)
    expect(p.vaultPath).toBe('(not set)')
    expect(p.stats).toBe(null)
    expect(p.index).toBe(null)
  })
})
