import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetUpgradeForTesting,
  getUpgradeReport,
  reconcile,
  startUpgradeReconcile,
  upgradeInfo,
  upgradeNeedsAttention,
  upgradeSummary,
} from '../src/upgrade-boot.ts'
import { buildShim } from '../src/onboarding.ts'
import type { PluginConfig } from '../src/types.ts'

let home: string
let vault: string
let core: string

beforeEach(() => {
  _resetUpgradeForTesting()
  home = mkdtempSync(join(tmpdir(), 'uam-boot-'))
  vault = join(home, 'Vault')
  core = join(home, 'plug', 'core')
  for (const dir of [vault, core]) mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  _resetUpgradeForTesting()
})

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    vaultPath: vault,
    pythonPath: 'python-does-not-exist',
    corePath: core,
    remoteEnabled: false,
    agentName: 'dsh-desktop',
    agentNameSource: 'profile',
    ...overrides,
  }
}

const REPO = join(import.meta.dirname, '..', 'vault-template')

/** The version the running build reports, read the way the boot pass reads it. */
function readPackageVersion(): string {
  return String((JSON.parse(readFileSync(join(REPO, '..', 'package.json'), 'utf8')) as { version?: string }).version)
}

/** Copy the shipped template into a vault, so the vault has nothing missing. */
function copyTemplate(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    const dest = join(to, name)
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true })
      copyTemplate(src, dest)
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
  }
}

describe('the boot pass never reports before it has planned', () => {
  it('is null on a fresh process', () => {
    expect(getUpgradeReport()).toBeNull()
    expect(upgradeInfo()).toBeNull()
    expect(upgradeSummary()).toBeNull()
    expect(upgradeNeedsAttention()).toBe(false)
  })
})

describe('reconcile — first run on a machine that was never set up', () => {
  it('leaves everything to memory_setup instead of pre-empting consent', async () => {
    // No vault configured and no ~/.unified-memory: this is a fresh install.
    // Writing a shim here would point at nothing and would claim consent the
    // user has not given yet.
    const report = await reconcile(cfg({ vaultPath: '' }), home)

    expect(report).not.toBeNull()
    expect(report?.result?.ok).toBe(true)
    expect(report?.result?.steps[0]?.detail).toContain('memory_setup')
  })
})

describe('reconcile — an installed machine', () => {
  it('plans and runs, and the report carries both halves', async () => {
    const report = await reconcile(cfg(), home)

    expect(report).not.toBeNull()
    expect(report?.plan.toVersion).toBeTruthy()
    expect(report?.result).not.toBeNull()
    // deploy.py cannot run (the interpreter does not exist), so the pass is
    // expected to fail its instruction step — but it must still have run the
    // other steps and must not have thrown.
    expect(report?.result?.steps.some((s) => s.name === 'shim')).toBe(true)
  })

  it('writes nothing when the plan is clean', async () => {
    // A clean plan needs every artifact ok AND a recorded version equal to the
    // running one. Build that state by hand: shim in place, registry present,
    // template files copied, one instruction file detected.
    const version = readPackageVersion()
    const shimName = process.platform === 'win32' ? 'memory.cmd' : 'memory'
    mkdirSync(join(home, '.unified-memory', 'bin'), { recursive: true })
    writeFileSync(
      join(home, '.unified-memory', 'bin', shimName),
      buildShim(process.platform === 'win32' ? 'cmd' : 'sh', core, 'python'),
      'utf8',
    )
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'AGENTS.md'), '# host instructions\n', 'utf8')
    mkdirSync(join(vault, '50-Agent-Context', 'Agent提交区'), { recursive: true })
    writeFileSync(join(vault, '50-Agent-Context', 'Agent提交区', '前缀登记.md'), '# 提交前缀登记\n', 'utf8')
    copyTemplate(REPO, vault)
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(
      join(home, '.unified-memory', 'upgrade.json'),
      JSON.stringify({ version, corePath: core, installPath: join(home, 'plug'), appliedAt: '', changed: [] }),
      'utf8',
    )

    const report = await reconcile(cfg(), home)

    expect(report?.plan.clean).toBe(true)
    // No result means the runner was never called: "clean" is a no-op, not a
    // run that happened to write nothing.
    expect(report?.result).toBeNull()
  })

  it('turns the plan into the few fields the panel draws', async () => {
    await reconcile(cfg(), home)
    const info = upgradeInfo()

    expect(info).not.toBeNull()
    expect(typeof info?.needsAttention).toBe('boolean')
    expect(typeof info?.done).toBe('boolean')
    expect(Array.isArray(info?.problems)).toBe(true)
    // Problems are sentences, not artifact records.
    for (const problem of info?.problems ?? []) expect(problem).toContain('：')
  })

  it('reports what is on disk after the pass, not before it', async () => {
    // The reproduced bug: a pass created the shim and then the panel still said
    // "shim missing" next to `done: true` — the two halves of one payload
    // contradicting each other. The report has to be re-planned.
    const report = await reconcile(cfg(), home)

    expect(report?.result).not.toBeNull()
    const shim = report?.plan.artifacts.find((a) => a.key === 'shim')
    // This pass creates the shim (it did not exist), so the plan it reports
    // must say `ok`, not `missing`.
    expect(shim?.state).toBe('ok')
    expect(upgradeInfo()?.problems.join('\n') ?? '').not.toContain('不存在，其它 Agent 无法通过')
  })

  it('keeps the version it came from, even though the pass already recorded the new one', async () => {
    // The re-plan reads the record the pass just wrote, so its own `fromVersion`
    // is already the new version. Copying it would turn every upgrade summary
    // into `0.8.1 → 0.8.1` and erase the transition from the only place that
    // ever showed it.
    const old = '0.7.9'
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(
      join(home, '.unified-memory', 'upgrade.json'),
      JSON.stringify({ version: old, corePath: core, installPath: join(home, 'plug'), appliedAt: '', changed: [] }),
      'utf8',
    )

    const report = await reconcile(cfg(), home)

    expect(report?.plan.fromVersion).toBe(old)
    expect(report?.plan.toVersion).not.toBe(old)
  })

  it('caps the problems it hands the client', async () => {
    await reconcile(cfg(), home)
    // The pane is 380px wide; a fourth line is already below the fold.
    expect((upgradeInfo()?.problems ?? []).length).toBeLessThanOrEqual(3)
  })
})

describe('startUpgradeReconcile', () => {
  it('returns immediately instead of waiting for the pass', () => {
    // The whole point: a slow deploy.py must not delay the tools and the panel
    // on every boot. If this ever awaited, the call would block here.
    const started = Date.now()
    startUpgradeReconcile(cfg(), home)
    expect(Date.now() - started).toBeLessThan(1000)
    // The pass has been scheduled but has not planned yet.
    expect(getUpgradeReport()).toBeNull()
  })

  it('swallows a failure instead of rejecting into the host', async () => {
    const onUnhandled = vi.fn()
    process.once('unhandledRejection', onUnhandled)

    // A core path under a file, not a directory: the probe's version read and
    // the shim write both misbehave. Nothing may escape.
    const broken = cfg({ corePath: join(home, 'Vault', 'a-file') })
    writeFileSync(join(home, 'Vault', 'a-file'), 'x', 'utf8')

    expect(() => startUpgradeReconcile(broken, home)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onUnhandled).not.toHaveBeenCalled()
  })
})
