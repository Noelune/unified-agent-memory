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
  mergeRegistry,
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

  describe('mergeRegistry', () => {
    const rows = [{ prefix: 'dsh-desktop-', runtime: 'dsh 桌面端', note: 'DSH_PROFILE=desktop' }]

    it('keeps the user prose, extra columns and CRLF of an existing registry', () => {
      // The registry is a shared file the user may edit and add columns to.
      // Regenerating it from parsed rows silently deletes everything the
      // parser does not understand.
      const existing = [
        '# 提交前缀登记',
        '',
        '说明：只登记前缀，不登记凭据',
        '',
        '| 前缀 | 运行时 | 说明 | 状态 |',
        '| --- | --- | --- | --- |',
        '| `codex-` | codex | 手动登记 | 在用 |',
        '',
        '尾注：新增运行时请提 PR',
        '',
      ].join('\r\n')
      const merged = mergeRegistry(existing, 'C:\\Vault', rows)
      expect(merged).toContain('说明：只登记前缀，不登记凭据')
      expect(merged).toContain('尾注：新增运行时请提 PR')
      expect(merged).toContain('| `codex-` | codex | 手动登记 | 在用 |')
      // A four-column table gets four-cell rows: our own row is padded, not
      // collapsed to three cells, which would break the table for every reader.
      expect(merged).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |  |')
      expect(merged.replace(/\r\n/g, '')).not.toContain('\n')
    })

    it('keeps the extra cell of a row it replaces', () => {
      // The fourth column is the user's ("在用"), and our prefix already has a
      // row. Rewriting that row must not drop the value they typed there.
      const existing = [
        '| 前缀 | 运行时 | 说明 | 状态 |',
        '| --- | --- | --- | --- |',
        '| `codex-` | codex | 手动登记 | 在用 |',
        '| `dsh-desktop-` | 旧说明 | 旧 | 在用 |',
        '',
      ].join('\n')
      const merged = mergeRegistry(existing, 'C:\\Vault', rows)
      expect(merged).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop | 在用 |')
      expect(merged).not.toContain('旧说明')
      expect(merged).toContain('| `codex-` | codex | 手动登记 | 在用 |')
    })

    it('starts an appended row on its own line when the table ends the file', () => {
      // Hand-edited registries often lack the final newline. Appending blindly
      // glues our row onto the last one, and that damaged line stays in a file
      // two machines share — every later reader sees a six-cell row.
      const existing =
        '| 前缀 | 运行时 | 说明 |\n| --- | --- | --- |\n| `codex-` | codex | 手动登记 |'
      const once = mergeRegistry(existing, 'C:\\Vault', rows)
      expect(once).toContain(
        '| `codex-` | codex | 手动登记 |\n| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |',
      )
      expect(once.match(/`dsh-desktop-`/g)).toHaveLength(1)
      expect(mergeRegistry(once, 'C:\\Vault', rows)).toBe(once)
    })

    it('is byte-stable when a cell contains an escaped pipe', () => {
      // `\|` is how a Markdown table carries a literal pipe. Splitting on every
      // pipe re-reads that one cell as two, and each run keeps another copy of
      // its tail, so the row grows without end.
      const piped = [{ prefix: 'dsh-desktop-', runtime: 'dsh 桌面端', note: 'DSH \\| 桌面端' }]
      const existing = '| 前缀 | 运行时 | 说明 |\n| --- | --- | --- |\n| `codex-` | codex | x |\n'
      const once = mergeRegistry(existing, 'C:\\Vault', piped)
      const twice = mergeRegistry(once, 'C:\\Vault', piped)
      const thrice = mergeRegistry(twice, 'C:\\Vault', piped)
      expect(once).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH \\| 桌面端 |')
      expect(twice).toBe(once)
      expect(thrice).toBe(once)
    })

    it('keeps the file when it has prose but no recognisable header', () => {
      // A registry we cannot parse is not ours to regenerate: replacing the file
      // deletes whatever the user wrote. Appending a table of our own cannot.
      const existing = '# 提交前缀登记\n\n说明：这台机器只登记自己\n\n没有表格。\n'
      const merged = mergeRegistry(existing, 'C:\\Vault', rows)
      expect(merged).toContain('说明：这台机器只登记自己')
      expect(merged).toContain('没有表格。')
      expect(merged).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |')
      expect(mergeRegistry(merged, 'C:\\Vault', rows)).toBe(merged)
    })

    it('patches our row when the table has no separator line', () => {
      // A hand-written registry may skip `| --- |`. Writing from header + 2 then
      // treats the first data row as the separator, so our own row is never
      // rewritten: it is appended instead and the table names this runtime twice.
      const existing = '| 前缀 | 运行时 | 说明 |\n| `dsh-desktop-` | 旧说明 | 旧 |\n'
      const merged = mergeRegistry(existing, 'C:\\Vault', rows)
      expect(merged.match(/`dsh-desktop-`/g)).toHaveLength(1)
      expect(merged).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |')
    })

    it('leaves the line endings outside the table untouched', () => {
      // Mixed files come from two machines writing the same registry. Only the
      // rows we touch may change; rewriting the whole file turns a one-row fix
      // into a full-file diff.
      const existing = [
        '# 提交前缀登记',
        '',
        '说明：这一行是 LF',
        '',
        '| 前缀 | 运行时 | 说明 |',
        '| --- | --- | --- |',
        '| `codex-` | codex | 手动登记 |',
        '',
        '尾注：这一行也是 LF',
        '',
      ].join('\n')
      const crlfTable = existing.replace(
        '| 前缀 | 运行时 | 说明 |\n| --- | --- | --- |\n| `codex-` | codex | 手动登记 |\n',
        '| 前缀 | 运行时 | 说明 |\r\n| --- | --- | --- |\r\n| `codex-` | codex | 手动登记 |\r\n',
      )
      const merged = mergeRegistry(crlfTable, 'C:\\Vault', rows)
      expect(merged).toContain('说明：这一行是 LF\n')
      expect(merged).toContain('| `codex-` | codex | 手动登记 |\r\n')
      expect(merged).toContain('尾注：这一行也是 LF')
    })

    it('is idempotent and replaces this runtime row in place', () => {
      const once = mergeRegistry(undefined, 'C:\\Vault', rows)
      const twice = mergeRegistry(once, 'C:\\Vault', rows)
      expect(twice).toBe(once)
      const stale = once.replace(
        '| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |',
        '| `dsh-desktop-` | 旧说明 | 旧 |',
      )
      const updated = mergeRegistry(stale, 'C:\\Vault', rows)
      expect(updated).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |')
      expect(updated).not.toContain('旧说明')
      expect(updated.match(/`dsh-desktop-`/g)).toHaveLength(1)
    })
  })
})
