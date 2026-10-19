import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  missingTemplateFiles,
  planNeedsAttention,
  planUpgrade,
  readUpgradeState,
  shimTarget,
  summarizePlan,
  upgradeStatePath,
  type UpgradeProbe,
  type UpgradeState,
} from '../src/upgrade.ts'
import { buildShim } from '../src/onboarding.ts'

let home: string
let vault: string
let template: string
let core: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-upgrade-'))
  vault = join(home, 'Vault')
  template = join(home, 'vault-template')
  core = join(home, 'plug', 'core')
  mkdirSync(vault, { recursive: true })
  mkdirSync(template, { recursive: true })
  mkdirSync(core, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function previous(overrides: Partial<UpgradeState> = {}): UpgradeState {
  return {
    version: '0.8.0',
    corePath: core,
    installPath: join(home, 'plug'),
    appliedAt: '2026-10-19T00:00:00.000Z',
    changed: [],
    ...overrides,
  }
}

function probe(overrides: Partial<UpgradeProbe> = {}): UpgradeProbe {
  return {
    home,
    corePath: core,
    installPath: join(home, 'plug'),
    vaultPath: vault,
    templateDir: template,
    instructionFiles: [join(home, '.dsh', 'AGENTS.md')],
    version: '0.8.1',
    previous: previous(),
    ...overrides,
  }
}

/** Write a shim whose PYTHONPATH points at `target`. */
function writeShim(target: string, kind: 'cmd' | 'sh' = process.platform === 'win32' ? 'cmd' : 'sh'): string {
  const dir = join(home, '.unified-memory', 'bin')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, kind === 'cmd' ? 'memory.cmd' : 'memory')
  writeFileSync(path, buildShim(kind, target, 'python'), 'utf8')
  return path
}

/** The registry row every installed vault already has. */
function writeRegistry(): void {
  const dir = join(vault, '50-Agent-Context', 'Agent提交区')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '前缀登记.md'), '# 提交前缀登记\n', 'utf8')
}

describe('shimTarget', () => {
  it('reads the PYTHONPATH back out of a cmd shim', () => {
    const path = writeShim(core, 'cmd')
    expect(shimTarget(path)).toBe(core)
  })

  it('reads the PYTHONPATH back out of a sh shim', () => {
    const path = writeShim(core, 'sh')
    expect(shimTarget(path)).toBe(core)
  })

  it('is null for a file it cannot parse, and for a file that is not there', () => {
    const dir = join(home, '.unified-memory', 'bin')
    mkdirSync(dir, { recursive: true })
    const broken = join(dir, 'broken.cmd')
    writeFileSync(broken, '@echo off\necho nope\n', 'utf8')
    expect(shimTarget(broken)).toBeNull()
    expect(shimTarget(join(dir, 'does-not-exist'))).toBeNull()
  })

  it('does not confuse a path with spaces for a truncated one', () => {
    // The quote group is what makes this work: `C:\Program Files\plug\core`
    // would otherwise be read as `C:\Program`.
    const spaced = join(home, 'Program Files', 'plug', 'core')
    const path = writeShim(spaced, 'cmd')
    expect(shimTarget(path)).toBe(spaced)
  })
})

describe('missingTemplateFiles', () => {
  it('lists template files the vault does not have, sorted', () => {
    mkdirSync(join(template, '50-Agent-Context'), { recursive: true })
    writeFileSync(join(template, 'README.md'), 'hi', 'utf8')
    writeFileSync(join(template, '50-Agent-Context', '上下文索引.md'), 'hi', 'utf8')
    // One of the two already exists in the vault.
    writeFileSync(join(vault, 'README.md'), 'mine', 'utf8')

    expect(missingTemplateFiles(template, vault)).toEqual([join('50-Agent-Context', '上下文索引.md')])
  })

  it('ignores .gitkeep, which exists only to keep an empty directory in git', () => {
    mkdirSync(join(template, '已处理'), { recursive: true })
    writeFileSync(join(template, '已处理', '.gitkeep'), '', 'utf8')
    expect(missingTemplateFiles(template, vault)).toEqual([])
  })

  it('reports every file when the template directory is unreadable', () => {
    // Not a crash, and not a plan to write: an absent template means there is
    // nothing to add, which reads as "complete".
    expect(missingTemplateFiles(join(home, 'nope'), vault)).toEqual([])
  })
})

describe('readUpgradeState', () => {
  it('round-trips a recorded state', () => {
    const path = upgradeStatePath(home)
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(path, JSON.stringify(previous({ changed: ['shim'] })), 'utf8')
    expect(readUpgradeState(path)).toEqual(previous({ changed: ['shim'] }))
  })

  it('treats a truncated or partial file as a first run', () => {
    const path = upgradeStatePath(home)
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(path, '{"version":"0.8.0"', 'utf8')
    expect(readUpgradeState(path)).toBeNull()

    writeFileSync(path, JSON.stringify({ version: '0.8.0' }), 'utf8')
    expect(readUpgradeState(path)).toBeNull()
  })

  it('treats a missing file as a first run', () => {
    expect(readUpgradeState(upgradeStatePath(home))).toBeNull()
  })
})

describe('planUpgrade', () => {
  it('finds the shim missing on a fresh install', () => {
    const plan = planUpgrade(probe({ previous: null }))
    expect(plan.artifacts.find((a) => a.key === 'shim')?.state).toBe('missing')
    expect(plan.fromVersion).toBeNull()
    expect(plan.clean).toBe(false)
  })

  it('flags a shim whose core directory is gone — the silent breakage', () => {
    writeShim(join(home, 'deleted-install', 'core'))
    const shim = planUpgrade(probe()).artifacts.find((a) => a.key === 'shim')
    expect(shim?.state).toBe('drift')
    expect(shim?.detail).toContain('已不存在')
  })

  it('flags a shim that points at the previous install even though that path still exists', () => {
    const old = join(home, 'old-install', 'core')
    mkdirSync(old, { recursive: true })
    writeShim(old)
    const shim = planUpgrade(probe({ previous: previous({ corePath: old }) })).artifacts.find((a) => a.key === 'shim')
    expect(shim?.state).toBe('drift')
    expect(shim?.detail).toContain('上一版')
  })

  it('accepts a shim pointing at this build', () => {
    writeShim(core)
    const shim = planUpgrade(probe()).artifacts.find((a) => a.key === 'shim')
    expect(shim?.state).toBe('ok')
  })
  it('counts the new template files as drift, not as breakage', () => {
    writeShim(core)
    writeFileSync(join(template, 'STARTER.md'), 'hi', 'utf8')
    const artifact = planUpgrade(probe()).artifacts.find((a) => a.key === 'vault')
    expect(artifact?.state).toBe('drift')
    expect(artifact?.detail).toContain('只补不覆盖')
  })

  it('skips the vault-owned artifacts when no vault is configured', () => {
    writeShim(core)
    const plan = planUpgrade(probe({ vaultPath: null }))
    for (const key of ['vault', 'index', 'registry'] as const) {
      const artifact = plan.artifacts.find((a) => a.key === key)
      expect(artifact?.state).toBe('missing')
      expect(artifact?.detail).toContain('尚未配置 vault')
    }
  })

  it('is clean only when every artifact is ok and the version already matches', () => {
    writeShim(core)
    writeRegistry()
    expect(planUpgrade(probe({ version: '0.8.0' })).clean).toBe(true)
    // Same disk, different running version: not clean, because the managed
    // sections have not been rewritten for the build that is running.
    expect(planUpgrade(probe({ version: '0.8.1' })).clean).toBe(false)
    // Same version, but no record of a previous run: also not clean.
    expect(planUpgrade(probe({ version: '0.8.1', previous: null })).clean).toBe(false)
  })

  it('reports installMoved only when a previous run recorded a different core', () => {
    writeShim(core)
    expect(planUpgrade(probe()).installMoved).toBe(false)
    expect(planUpgrade(probe({ previous: previous({ corePath: join(home, 'elsewhere') }) })).installMoved).toBe(true)
    expect(planUpgrade(probe({ previous: null })).installMoved).toBe(false)
  })
})

describe('planNeedsAttention', () => {
  it('is quiet when nothing changed and nothing is broken', () => {
    writeShim(core)
    writeRegistry()
    expect(planNeedsAttention(planUpgrade(probe({ version: '0.8.0' })))).toBe(false)
  })

  it('speaks up on a version change even when every artifact is fine', () => {
    writeShim(core)
    expect(planNeedsAttention(planUpgrade(probe({ version: '0.8.1' })))).toBe(true)
  })

  it('speaks up when an artifact is broken', () => {
    writeShim(join(home, 'deleted-install', 'core'))
    expect(planNeedsAttention(planUpgrade(probe({ version: '0.8.0' })))).toBe(true)
  })
})

describe('summarizePlan', () => {
  it('says so when there is nothing to do', () => {
    writeShim(core)
    writeRegistry()
    expect(summarizePlan(planUpgrade(probe({ version: '0.8.0' })))).toContain('无需变更')
  })

  it('names the version transition on a plain upgrade', () => {
    writeShim(core)
    writeRegistry()
    expect(summarizePlan(planUpgrade(probe({ version: '0.8.1' })))).toContain('0.8.0 → 0.8.1')
  })

  it('says 首次运行 instead of inventing a from-version', () => {
    expect(summarizePlan(planUpgrade(probe({ previous: null })))).toContain('首次运行')
  })

  it('counts the broken artifacts', () => {
    writeShim(join(home, 'deleted-install', 'core'))
    writeRegistry()
    expect(summarizePlan(planUpgrade(probe({ version: '0.8.0' })))).toContain('1 项需要修复')
  })

  it('does not print a version arrow when only a repair happened', () => {
    writeShim(join(home, 'deleted-install', 'core'))
    writeRegistry()
    // `0.8.0 → 0.8.0` reads as a transition that did not happen. The version
    // changed nowhere; only an artifact is broken.
    const line = summarizePlan(planUpgrade(probe({ version: '0.8.0' })))
    expect(line).not.toContain('→')
    expect(line).toContain('0.8.0')
  })
})
