import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineSetupTool, registerAll, type SetupDepsForTool } from '../src/tools.ts'
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

  it('still runs when a grant exists and apply is requested, so a half-done setup can be repaired', async () => {
    // A grant skips the question, not the work: the already-configured short
    // circuit used to swallow apply=true, so the "run it again to fill in what
    // is missing" instruction in the message did nothing at all.
    const h = deps({ readState: () => grantedState })
    const result = (await defineSetupTool(h.deps).execute({ apply: true }, { agent: 'dsh-desktop' })) as Record<
      string,
      unknown
    >
    expect(result.needsConsent).toBe(false)
    expect(result.ok).toBe(true)
    expect(h.calls.length).toBeGreaterThan(0)
    expect(h.states.length).toBe(1)
  })

  it('falls back to the plan when the approval service throws', async () => {
    // The service can be torn down mid-call (turn closed, plugin reloaded); the
    // tool must degrade to a plan instead of throwing out of the tool contract.
    const h = deps({
      approval: () => ({
        request: async () => {
          throw new Error('approval service is gone')
        },
      }),
    })
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(result.needsConsent).toBe(true)
    expect(String(result.hint)).toContain('未写入任何文件')
    expect(h.calls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('refuses a relative vault path instead of provisioning in the process cwd', async () => {
    const h = deps()
    const result = (await defineSetupTool(h.deps).execute({ vault: 'my-vault' }, { agent: 'dsh-desktop' })) as Record<
      string,
      unknown
    >
    expect(result.ok).toBe(false)
    expect(String(result.output)).toContain('绝对路径')
    expect(h.calls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('does not mistake a sibling directory for a path inside home', async () => {
    // `startsWith(home)` also matches C:\Users\bobby for home C:\Users\bob, which
    // would print "by/.dsh/AGENTS.md" as the target and deploy-nothing.
    const h = deps({
      home: 'C:\\Users\\bob',
      detectTargets: () => [{ agent: 'dsh' as const, path: 'C:\\Users\\bobby\\.dsh\\AGENTS.md' }],
    })
    const result = (await defineSetupTool(h.deps).execute({}, { agent: 'dsh-desktop' })) as Record<string, unknown>
    expect(String(result.plan)).toContain('bobby')
  })
})

describe('tool registration', () => {
  it('reads vaultPath live, so a setup that lands mid-session needs no restart', async () => {
    // The gate used to be a boolean captured at registration time; `reload`
    // only mutated the config object, so every reader kept answering "not
    // configured" until the host restarted. Registration must read the config
    // at call time.
    const live = { ...cfg(), vaultPath: '', pythonPath: join('C:\\nope', 'python.exe') }
    const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    registerAll({ tools: { register: (tool) => tools.push(tool as never) } }, live, {})
    const search = tools.find((tool) => tool.name === 'memory_search')
    expect(search).toBeDefined()

    const before = (await search!.execute({ query: 'x' }, { agent: 'dsh-desktop' })) as { output?: string }
    expect(String(before.output)).toContain('not configured')

    live.vaultPath = 'C:\\Vault'
    const after = (await search!.execute({ query: 'x' }, { agent: 'dsh-desktop' })) as { output?: string }
    expect(String(after.output)).not.toContain('not configured')
  })
})

describe('memory_setup renders readable text', () => {
  // The host shows `output.render(args, value)` to the agent and the user. A
  // result without an `output` string renders as "[object Object]", which would
  // hide the very consent text this tool exists to show. Every branch must set
  // `output`, and the rendered text must never be the object itself.
  const rendered = (tool: ReturnType<typeof defineSetupTool>, result: unknown) =>
    (tool.output.render as (args: unknown, value: unknown) => Array<{ text: string }>)({}, result)[0].text

  it('renders the consent plan, not a stringified object', async () => {
    const tool = defineSetupTool(deps().deps)
    const result = await tool.execute({}, { agent: 'dsh-desktop' })
    expect(String((result as Record<string, unknown>).output)).toContain('C:\\Vault')
    const text = rendered(tool, result)
    expect(text).toContain('C:\\Vault')
    expect(text).toContain('apply=true')
    expect(text).not.toContain('[object Object]')
  })

  it('renders the already-configured message', async () => {
    const tool = defineSetupTool(deps({ readState: () => grantedState }).deps)
    const result = await tool.execute({}, { agent: 'dsh-desktop' })
    expect(rendered(tool, result)).toContain('已配置')
  })

  it('renders the completion summary after apply', async () => {
    const tool = defineSetupTool(deps().deps)
    const result = await tool.execute({ apply: true }, { agent: 'dsh-desktop' })
    const text = rendered(tool, result)
    expect(text).toContain('已完成')
    expect(text).toContain('C:\\Vault')
  })
})
