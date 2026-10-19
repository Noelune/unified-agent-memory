import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runUpgrade, shimContent, type UpgradeDeps } from '../src/upgrade-run.ts'
import { readUpgradeState, upgradeStatePath } from '../src/upgrade.ts'
import { buildShim } from '../src/onboarding.ts'

let home: string
let vault: string
let template: string
let core: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-run-'))
  vault = join(home, 'Vault')
  template = join(home, 'vault-template')
  core = join(home, 'plug', 'core')
  for (const dir of [vault, template, core]) mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

interface Recorder {
  calls: string[][]
  apply: UpgradeDeps['deployApply']
}

function recorder(code = 0, stdout = '{"written": "True"}\n', stderr = ''): Recorder {
  const calls: string[][] = []
  return {
    calls,
    apply: async (argv) => {
      calls.push(argv)
      return { code, stdout, stderr }
    },
  }
}

function deps(overrides: Partial<UpgradeDeps> = {}, deploy: Recorder = recorder()): UpgradeDeps {
  return {
    home,
    version: '0.8.1',
    corePath: core,
    installPath: join(home, 'plug'),
    vaultPath: vault,
    templateDir: template,
    pythonPath: 'python',
    agentName: 'dsh-desktop',
    deployApply: deploy.apply,
    now: () => new Date('2026-10-19T12:00:00.000Z'),
    ...overrides,
  }
}

function shimPath(): string {
  const name = process.platform === 'win32' ? 'memory.cmd' : 'memory'
  return join(home, '.unified-memory', 'bin', name)
}

function stepOf(result: Awaited<ReturnType<typeof runUpgrade>>, name: string) {
  return result.steps.find((s) => s.name === name)
}

describe('shimContent', () => {
  it('is exactly what setup would generate, so an upgrade is not a rewrite', () => {
    expect(shimContent('cmd', core, 'python')).toBe(buildShim('cmd', core, 'python'))
    expect(shimContent('sh', core, 'python')).toBe(buildShim('sh', core, 'python'))
  })
})

describe('runUpgrade — the shim', () => {
  it('creates the shim when it is missing', async () => {
    const result = await runUpgrade(deps())
    expect(stepOf(result, 'shim')?.ok).toBe(true)
    expect(existsSync(shimPath())).toBe(true)
  })

  it('leaves a correct shim byte-identical', async () => {
    mkdirSync(join(home, '.unified-memory', 'bin'), { recursive: true })
    const wanted = shimContent(process.platform === 'win32' ? 'cmd' : 'sh', core, 'python')
    writeFileSync(shimPath(), wanted, 'utf8')

    const result = await runUpgrade(deps())
    expect(stepOf(result, 'shim')?.detail).toContain('未改动')
    expect(readFileSync(shimPath(), 'utf8')).toBe(wanted)
  })

  it('repoints a shim at a dead core', async () => {
    mkdirSync(join(home, '.unified-memory', 'bin'), { recursive: true })
    writeFileSync(shimPath(), buildShim(process.platform === 'win32' ? 'cmd' : 'sh', join(home, 'gone'), 'python'), 'utf8')

    const result = await runUpgrade(deps())
    expect(stepOf(result, 'shim')?.detail).toContain('改指')
    expect(readFileSync(shimPath(), 'utf8')).toContain(core)
  })
})

describe('runUpgrade — the vault', () => {
  it('adds a missing template file', async () => {
    writeFileSync(join(template, 'STARTER.md'), 'from template', 'utf8')
    const result = await runUpgrade(deps())

    expect(stepOf(result, 'vault')?.detail).toContain('补建 1 个')
    expect(readFileSync(join(vault, 'STARTER.md'), 'utf8')).toBe('from template')
  })

  it('never overwrites a file the user already has under a template name', async () => {
    writeFileSync(join(template, 'STARTER.md'), 'from template', 'utf8')
    writeFileSync(join(vault, 'STARTER.md'), 'mine, edited', 'utf8')

    const result = await runUpgrade(deps())
    expect(stepOf(result, 'vault')?.detail).toContain('齐全')
    expect(readFileSync(join(vault, 'STARTER.md'), 'utf8')).toBe('mine, edited')
  })

  it('creates nested template directories rather than failing on them', async () => {
    mkdirSync(join(template, '50-Agent-Context'), { recursive: true })
    writeFileSync(join(template, '50-Agent-Context', '上下文索引.md'), 'x', 'utf8')

    await runUpgrade(deps())
    expect(existsSync(join(vault, '50-Agent-Context', '上下文索引.md'))).toBe(true)
  })
})

describe('runUpgrade — the registry', () => {
  it('creates the registry when the vault has none', async () => {
    const result = await runUpgrade(deps())
    expect(stepOf(result, 'registry')?.detail).toBe('已创建')

    const text = readFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), 'utf8')
    expect(text).toContain('`dsh-desktop-`')
  })

  it('is idempotent: a second run does not rewrite the file', async () => {
    await runUpgrade(deps())
    const before = readFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), 'utf8')

    const second = await runUpgrade(deps())
    expect(stepOf(second, 'registry')?.detail).toContain('未改动')
    expect(readFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), 'utf8')).toBe(before)
  })

  it('keeps lines other runtimes wrote', async () => {
    mkdirSync(join(vault, '50-Agent-Context', 'Agent提交区'), { recursive: true })
    const existing = [
      '# 提交前缀登记',
      '',
      '| 前缀 | 运行时 | 说明 |',
      '| --- | --- | --- |',
      '| `codex-` | Codex | 手动登记 |',
      '',
    ].join('\n')
    writeFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), existing, 'utf8')

    await runUpgrade(deps())
    const text = readFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), 'utf8')
    expect(text).toContain('`codex-`')
    expect(text).toContain('`dsh-desktop-`')
  })
})

describe('runUpgrade — instruction sections', () => {
  it('delegates to deploy.py with this home, vault and prefix', async () => {
    const deploy = recorder()
    await runUpgrade(deps({}, deploy))

    expect(deploy.calls).toHaveLength(1)
    const argv = deploy.calls[0] as string[]
    expect(argv[0]).toBe('apply')
    expect(argv).toContain(home)
    expect(argv).toContain(vault)
    expect(argv).toContain('dsh-desktop')
  })

  it('turns a non-zero deploy into one failed step, not a thrown error', async () => {
    const result = await runUpgrade(deps({}, recorder(2, '', 'boom: no such vault')))
    const step = stepOf(result, 'instructions')
    expect(step?.ok).toBe(false)
    expect(step?.detail).toContain('boom')
    expect(result.ok).toBe(false)
  })

  it('reports a deploy that wrote nothing as "already current"', async () => {
    const result = await runUpgrade(deps({}, recorder(0, '{"written": "False"}\n')))
    expect(stepOf(result, 'instructions')?.detail).toContain('已是最新')
  })

  it('distinguishes the strings "True"/"False" deploy actually prints', async () => {
    // deploy emits Python's str(bool), so these are the six-character strings
    // "True" / "False". A truthiness check would read "False" as changed.
    const result = await runUpgrade(
      deps({}, recorder(0, '{"changed": "False", "written": "False"}\n')),
    )
    expect(stepOf(result, 'instructions')?.detail).toContain('已是最新')
  })

  it('does not mark instructions as changed on an idempotent deploy', async () => {
    // The version record's `changed` list is what a later reader uses to see
    // what a pass touched. A no-op deploy must not appear there — otherwise
    // every boot claims it rewrote the instruction sections.
    await runUpgrade(deps({}, recorder(0, '{"changed": "False", "written": "False"}\n')))
    const state = readUpgradeState(upgradeStatePath(home))
    expect(state?.changed ?? []).not.toContain('instructions')
  })

  it('does mark instructions as changed when deploy rewrote them', async () => {
    await runUpgrade(deps({}, recorder(0, '{"changed": "True", "written": "True"}\n')))
    const state = readUpgradeState(upgradeStatePath(home))
    expect(state?.changed).toContain('instructions')
  })

  it('counts per target instead of per line', async () => {
    // Two targets, one rewritten: the sentence has to say 1, not 2.
    const stdout = [
      '{"changed": "True", "written": "True"}',
      '{"changed": "False", "written": "False"}',
    ].join('\n')
    const result = await runUpgrade(deps({}, recorder(0, stdout)))
    expect(stepOf(result, 'instructions')?.detail).toContain('1 个指令文件')
  })

  it('does not fail on a human-readable deploy line', async () => {
    const stdout = ['deploying...', '{"changed": "False", "written": "False"}', 'done'].join('\n')
    const result = await runUpgrade(deps({}, recorder(0, stdout)))
    expect(stepOf(result, 'instructions')?.ok).toBe(true)
    expect(stepOf(result, 'instructions')?.detail).toContain('已是最新')
  })

  it('handles deploy printing nothing at all without claiming a rewrite', async () => {
    const result = await runUpgrade(deps({}, recorder(0, '')))
    expect(stepOf(result, 'instructions')?.ok).toBe(true)
    // The old fallback said "已按当前版本重写托管段" — a rewrite claim for a
    // run that reported nothing at all.
    expect(stepOf(result, 'instructions')?.detail).not.toContain('重写')
  })
})

describe('runUpgrade — the version record', () => {
  it('records the version after every step succeeds', async () => {
    const result = await runUpgrade(deps())
    const state = readUpgradeState(upgradeStatePath(home))
    expect(state?.version).toBe('0.8.1')
    expect(state?.corePath).toBe(core)
    expect(state?.appliedAt).toBe('2026-10-19T12:00:00.000Z')
    expect(stepOf(result, 'state')?.ok).toBe(true)
  })

  it('records which artifacts it actually rewrote', async () => {
    // deploy reports a rewrite, so `instructions` belongs in `changed`.
    await runUpgrade(deps({}, recorder(0, '{"changed": "True", "written": "True"}\n')))
    const state = readUpgradeState(upgradeStatePath(home))
    expect(state?.changed).toContain('shim')
    expect(state?.changed).toContain('registry')
    expect(state?.changed).toContain('instructions')
  })

  it('does NOT record the version when a step failed, so the next boot retries', async () => {
    // This is the whole ordering guarantee: a half-applied upgrade must not be
    // stamped as done. The failed deploy leaves no record, and the old version
    // (or nothing) is what the next plan compares against.
    const result = await runUpgrade(deps({}, recorder(1, '', 'nope')))

    expect(readUpgradeState(upgradeStatePath(home))).toBeNull()
    expect(result.ok).toBe(false)
    expect(stepOf(result, 'state')?.detail).toContain('版本记录未更新')
    expect(stepOf(result, 'state')?.detail).toContain('instructions')
  })

  it('keeps a good record when a later run fails, so the retry is still a retry', async () => {
    await runUpgrade(deps())
    const good = readUpgradeState(upgradeStatePath(home))

    await runUpgrade(deps({ version: '0.8.2' }, recorder(1, '', 'nope')))
    // Still the last *successful* version. Recording 0.8.2 here would hide the
    // failed instruction refresh forever.
    expect(readUpgradeState(upgradeStatePath(home))).toEqual(good)
  })
})

describe('runUpgrade — failure isolation', () => {
  it('still refreshes instructions when the shim cannot be written', async () => {
    // A directory where the shim's parent file should be: mkdirSync fails.
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(join(home, '.unified-memory', 'bin'), 'not a directory', 'utf8')

    const deploy = recorder()
    const result = await runUpgrade(deps({}, deploy))

    expect(stepOf(result, 'shim')?.ok).toBe(false)
    expect(stepOf(result, 'instructions')?.ok).toBe(true)
    expect(deploy.calls).toHaveLength(1)
  })

  it('skips vault-owned steps without failing when no vault is configured', async () => {
    const result = await runUpgrade(deps({ vaultPath: null }))
    expect(stepOf(result, 'vault')?.detail).toContain('跳过')
    expect(stepOf(result, 'registry')?.detail).toContain('跳过')
    expect(result.ok).toBe(true)
  })

  it('leaves no temp file behind after writing', async () => {
    await runUpgrade(deps())
    expect(existsSync(`${shimPath()}.tmp-upgrade`)).toBe(false)
    expect(existsSync(`${upgradeStatePath(home)}.tmp-upgrade`)).toBe(false)
  })
})
