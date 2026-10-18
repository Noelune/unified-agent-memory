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
