import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineSetupTool, type SetupDepsForTool } from '../src/tools.ts'
import type { OnboardingState } from '../src/onboarding.ts'
import type { PluginConfig } from '../src/types.ts'

type ExecCall = { file: string; args: string[]; env: Record<string, string> }

function cfg(): PluginConfig {
  return {
    vaultPath: 'C:\\Vault',
    pythonPath: 'C:\\Python311\\python.exe',
    corePath: 'C:\\plug\\core',
    remoteEnabled: false,
    agentName: 'dsh-desktop',
  }
}

function deps(overrides: Partial<SetupDepsForTool> = {}) {
  const calls: ExecCall[] = []
  const written: Array<{ path: string; content: string }> = []
  const states: OnboardingState[] = []
  let reloaded = 0
  const base: SetupDepsForTool = {
    cfg: cfg(),
    home: 'C:\\Users\\z',
    deployScript: 'C:\\plug\\setup\\deploy.py',
    storagePath: join('C:\\Users\\z', '.unified-memory', 'onboarding.json'),
    readState: () => null,
    writeState: (state) => states.push(state),
    detectTargets: () => [{ agent: 'dsh' as const, path: join('C:\\Users\\z', '.dsh', 'AGENTS.md') }],
    reload: () => {
      reloaded += 1
    },
    spawnExec: async (file, args, env) => {
      calls.push({ file, args, env })
      return { code: 0, stdout: '', stderr: '' }
    },
    writeFile: (path, content) => written.push({ path, content }),
    ...overrides,
  }
  return {
    calls,
    written,
    states,
    get reloaded() {
      return reloaded
    },
    deps: base,
  }
}

const grantedState: OnboardingState = {
  version: 1,
  consent: 'granted',
  grantedAt: '2026-10-19T00:00:00+08:00',
  vaultPath: 'C:\\Vault',
  scope: ['vault', 'config', 'instructions', 'shim', 'registry'],
  targets: ['.dsh/AGENTS.md'],
}

describe('memory_setup consent gate', () => {
  it('plans without writing anything when no grant exists', async () => {
    const h = deps()
    const tool = defineSetupTool(h.deps)
    const result = (await tool.execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(true)
    expect(result.reason).toContain('不上传、不联网、不改凭据')
    expect(result.plan).toContain('C:\\Vault')
    expect(result.hint).toContain('同意')
    expect(h.calls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('fails closed when the harness offers no approval channel', async () => {
    const h = deps()
    // No `approval` dep at all: this session's "prompts are disabled" case.
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('writes nothing when the user declines', async () => {
    const h = deps({
      approval: () => ({ request: async () => ({ outcome: 'rejected' }) }),
      readState: () => null,
    })
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(true)
    expect(result.hint).toContain('取消')
    expect(h.calls).toEqual([])
  })

  it('runs the plan and records the grant after approval', async () => {
    const h = deps({ approval: () => ({ request: async () => ({ outcome: 'allowed-once' }) }) })
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(false)
    expect(result.ok).toBe(true)
    const state = result.onboarding as OnboardingState
    expect(state.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect({ ...state, grantedAt: grantedState.grantedAt }).toEqual(grantedState)
    expect({ ...(h.states[0] as OnboardingState), grantedAt: grantedState.grantedAt }).toEqual(grantedState)
    expect(h.reloaded).toBe(1)
  })

  it('runs with apply:true and no approval channel, but does not claim consent', async () => {
    const h = deps()
    const result = (await defineSetupTool(h.deps).execute({ apply: true }, { agent: 'dsh-desktop' })) as Record<
      string,
      unknown
    >
    expect(result.needsConsent).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.onboarding).toBeUndefined()
    expect(h.calls.length).toBeGreaterThan(0)
  })

  it('skips the whole flow when the stored grant still matches', async () => {
    const h = deps({ readState: () => grantedState })
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(false)
    expect(result.steps).toEqual([])
    expect(String(result.message)).toContain('已配置')
    expect(h.calls).toEqual([])
  })
})
