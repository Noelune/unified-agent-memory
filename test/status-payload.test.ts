import { describe, expect, it } from 'vitest'
import { buildStatusPayload } from '../src/status-payload.ts'
import type { PluginConfig } from '../src/types.ts'

const ui = { currentVersion: '0.8.1', latestVersion: null, updateAvailable: null }

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    vaultPath: 'C:\\Vault',
    pythonPath: 'python',
    corePath: 'C:\\core',
    remoteEnabled: false,
    agentName: 'dsh-desktop',
    agentNameSource: 'profile',
    ...overrides,
  }
}

describe('status payload identity', () => {
  it('reports the prefix and where it came from', () => {
    const payload = buildStatusPayload(cfg(), ui, null)
    expect(payload.agentName).toBe('dsh-desktop')
    expect(payload.agentSource).toBe('profile')
  })

  it('never hides a fallback prefix', () => {
    const payload = buildStatusPayload(cfg({ agentName: 'dsh', agentNameSource: 'fallback' }), ui, null)
    expect(payload.agentName).toBe('dsh')
    expect(payload.agentSource).toBe('fallback')
  })

  it('carries whether first-run setup is done for this vault', () => {
    expect(buildStatusPayload(cfg(), ui, null, { granted: true }).onboarding).toEqual({ granted: true })
    expect(buildStatusPayload(cfg(), ui, null).onboarding).toEqual({ granted: false })
  })
})

describe('status payload upgrade section', () => {
  const upgrade = {
    fromVersion: '0.8.0',
    toVersion: '0.8.1',
    needsAttention: true,
    problems: ['CLI shim：指向的核心已不存在'],
    done: true,
  }

  it('is null until the reconcile pass has planned anything', () => {
    // A few hundred ms after boot this is the normal state. The client has to
    // render "checking", so null must not be turned into a fabricated object.
    expect(buildStatusPayload(cfg(), ui, null).upgrade).toBeNull()
  })

  it('passes the reconcile report through unchanged', () => {
    expect(buildStatusPayload(cfg(), ui, null, { granted: false }, upgrade).upgrade).toEqual(upgrade)
  })

  it('keeps the version pair readable when nothing needs attention', () => {
    const quiet = { ...upgrade, needsAttention: false, problems: [] }
    const payload = buildStatusPayload(cfg(), ui, null, { granted: false }, quiet)
    expect(payload.upgrade?.fromVersion).toBe('0.8.0')
    expect(payload.upgrade?.toVersion).toBe('0.8.1')
    expect(payload.upgrade?.problems).toEqual([])
  })
})
