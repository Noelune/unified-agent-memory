import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ONBOARDING_SCOPE,
  buildConsentReason,
  buildRegistry,
  buildShim,
  consentSatisfied,
  detectInstructionTargets,
  onboardingStatePath,
  readOnboardingState,
  resolveSetupVault,
  writeOnboardingState,
  type OnboardingState,
} from '../src/onboarding.ts'
import type { PluginConfig } from '../src/types.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-onboard-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    vaultPath: '',
    pythonPath: 'python',
    corePath: '',
    remoteEnabled: false,
    agentName: 'dsh-desktop',
    ...overrides,
  }
}

function grantedState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    version: 1,
    consent: 'granted',
    grantedAt: '2026-10-19T00:00:00+08:00',
    vaultPath: join(home, 'Vault'),
    scope: [...ONBOARDING_SCOPE],
    targets: ['.dsh/AGENTS.md'],
    ...overrides,
  }
}

describe('onboarding state', () => {
  it('lives under ~/.unified-memory/onboarding.json', () => {
    expect(onboardingStatePath(home)).toBe(join(home, '.unified-memory', 'onboarding.json'))
  })

  it('round-trips through disk and creates the parent directory', () => {
    writeOnboardingState(grantedState(), onboardingStatePath(home))
    expect(readOnboardingState(onboardingStatePath(home))).toEqual(grantedState())
  })

  it('treats a missing or malformed file as no consent', () => {
    expect(readOnboardingState(onboardingStatePath(home))).toBeNull()
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(onboardingStatePath(home), '{"version":1,"consent":"declined"}', 'utf8')
    expect(readOnboardingState(onboardingStatePath(home))).toBeNull()
  })

  it('needs a new consent when the vault or the scope changes', () => {
    const state = grantedState()
    expect(consentSatisfied(state, { vaultPath: state.vaultPath, scope: ONBOARDING_SCOPE })).toBe(true)
    expect(consentSatisfied(state, { vaultPath: join(home, 'Other'), scope: ONBOARDING_SCOPE })).toBe(false)
    expect(consentSatisfied(state, { vaultPath: state.vaultPath, scope: [...ONBOARDING_SCOPE, 'cron'] })).toBe(false)
    expect(consentSatisfied(null, { vaultPath: state.vaultPath, scope: ONBOARDING_SCOPE })).toBe(false)
  })
})

describe('instruction targets', () => {
  it('only reports files that already exist', () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '', 'utf8')
    expect(detectInstructionTargets(home)).toEqual([{ agent: 'codex', path: join(home, '.codex', 'AGENTS.md') }])
  })
})

describe('setup plan text', () => {
  it('names the vault, the targets and the no-network guarantee', () => {
    const reason = buildConsentReason({ vaultPath: 'C:\\Vault', targets: ['.codex/AGENTS.md'], reusesVault: false })
    expect(reason).toContain('在 C:\\Vault 创建记忆库')
    expect(reason).toContain('.codex/AGENTS.md')
    expect(reason).toContain('不上传、不联网、不改凭据')
  })

  it('says "reuse" for an existing vault and tolerates zero targets', () => {
    const reason = buildConsentReason({ vaultPath: 'C:\\Vault', targets: [], reusesVault: true })
    expect(reason).toContain('复用已存在的记忆库')
    expect(reason).toContain('不修改任何 Agent 指令文件')
  })

  it('prefers the explicit path, then config, then a home default', () => {
    expect(resolveSetupVault(cfg(), join(home, 'Explicit'), home)).toBe(join(home, 'Explicit'))
    expect(resolveSetupVault(cfg({ vaultPath: join(home, 'FromConfig') }), undefined, home)).toBe(
      join(home, 'FromConfig'),
    )
    expect(resolveSetupVault(cfg(), undefined, home)).toBe(join(home, 'UnifiedAgentMemory'))
  })
})

describe('shim and registry content', () => {
  it('quotes the core path so spaces survive', () => {
    const cmd = buildShim('cmd', 'C:\\Program Files\\core', 'C:\\Python311\\python.exe')
    expect(cmd).toContain('set "PYTHONPATH=C:\\Program Files\\core"')
    expect(cmd).toContain('"C:\\Python311\\python.exe" -m unified_memory.memory %*')
    const sh = buildShim('sh', '/opt/my core', '/usr/bin/python3')
    expect(sh).toContain("PYTHONPATH='/opt/my core'")
  })

  it('renders a prefix registry table naming every writer', () => {
    const md = buildRegistry('C:\\Vault', [
      { prefix: 'dsh-desktop-', runtime: 'dsh 桌面端', note: 'DSH_PROFILE=desktop' },
      { prefix: 'dsh-', runtime: '历史遗留', note: '不改名' },
    ])
    expect(md).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |')
    expect(md).toContain('canonical')
  })
})
