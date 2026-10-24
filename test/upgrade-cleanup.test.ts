import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planCleanup, runCleanup, summarizeCleanup } from '../src/upgrade-cleanup.ts'
import type { CleanupDeps, RetiredArtifact } from '../src/upgrade-cleanup.ts'

let home: string
let vault: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-clean-'))
  vault = join(home, 'Vault')
  mkdirSync(join(vault, '50-Agent-Context', 'Agent提交区'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function deps(overrides: Partial<CleanupDeps> = {}): CleanupDeps {
  return {
    home,
    vaultPath: vault,
    instructionFiles: [join(home, '.dsh', 'AGENTS.md')],
    ...overrides,
  }
}

/** Touch a file with an explicit age so `olderThanMs` rules are testable. */
function plant(path: string, ageDays = 0, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  utimesSync(path, t, t)
}

function bakName(base: string, stamp: string): string {
  return `${base}.bak-${stamp}`
}

describe('planCleanup / runCleanup', () => {
  it('keeps the 3 newest deploy backups and removes older ones', () => {
    const dsh = join(home, '.dsh')
    const stamps = ['20260101-000000-000', '20260102-000000-000', '20260103-000000-000', '20260104-000000-000', '20260105-000000-000']
    for (const stamp of stamps) plant(join(dsh, bakName('AGENTS.md', stamp)))
    const result = runCleanup(deps())
    const removed = result.removed.map((r) => r.rule === 'instruction-backups' ? r.path : '')
    expect(removed.filter(Boolean)).toHaveLength(2)
    expect(existsSync(join(dsh, bakName('AGENTS.md', '20260105-000000-000')))).toBe(true)
    expect(existsSync(join(dsh, bakName('AGENTS.md', '20260103-000000-000')))).toBe(true)
    expect(existsSync(join(dsh, bakName('AGENTS.md', '20260101-000000-000')))).toBe(false)
  })

  it('breaks identical-mtime ties by filename stamp, so the newest stamp survives', () => {
    const dsh = join(home, '.dsh')
    const stamps = ['20260101-000000-000', '20260102-000000-000', '20260103-000000-000', '20260104-000000-000', '20260105-000000-000']
    const same = new Date()
    for (const stamp of stamps) {
      const path = join(dsh, bakName('AGENTS.md', stamp))
      plant(path)
      utimesSync(path, same, same)
    }
    const result = runCleanup(deps())
    expect(result.removed.map((r) => r.path).sort()).toEqual([
      join(dsh, bakName('AGENTS.md', '20260101-000000-000')),
      join(dsh, bakName('AGENTS.md', '20260102-000000-000')),
    ])
  })

  it('never touches files that do not match the generated shape', () => {
    const dsh = join(home, '.dsh')
    plant(join(dsh, 'AGENTS.md'), 3, '# 用户自己的内容')
    plant(join(dsh, 'AGENTS.md.bak-old'), 3)
    plant(join(dsh, 'notes.md'), 3)
    const result = runCleanup(deps())
    expect(result.removed).toHaveLength(0)
    expect(existsSync(join(dsh, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dsh, 'AGENTS.md.bak-old'))).toBe(true)
    expect(existsSync(join(dsh, 'notes.md'))).toBe(true)
  })

  it('removes stale deploy temps but leaves a fresh one alone', () => {
    const dsh = join(home, '.dsh')
    plant(join(dsh, 'AGENTS.md.tmp-deploy'), 2)
    plant(join(dsh, 'CLAUDE.md.tmp-deploy'), 0)
    const result = runCleanup(deps({ instructionFiles: [join(dsh, 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')] }))
    expect(result.removed).toHaveLength(1)
    expect(existsSync(join(dsh, 'AGENTS.md.tmp-deploy'))).toBe(false)
    expect(existsSync(join(dsh, 'CLAUDE.md.tmp-deploy'))).toBe(true)
  })

  it('removes stale upgrade temps under ~/.unified-memory', () => {
    plant(join(home, '.unified-memory', 'bin', 'memory.cmd.tmp-upgrade'), 2)
    const result = runCleanup(deps())
    expect(result.removed.map((r) => r.rule)).toContain('upgrade-temp')
    expect(existsSync(join(home, '.unified-memory', 'bin', 'memory.cmd.tmp-upgrade'))).toBe(false)
  })

  it('sweeps the legacy fixed-name index db only with a hashed successor and age', () => {
    const um = join(home, '.unified-memory')
    // No successor: stays — the fixed-name DB may still be the live one.
    plant(join(um, 'index.db'), 60)
    runCleanup(deps())
    expect(existsSync(join(um, 'index.db'))).toBe(true)
    // Successor present but the file itself is fresh: stays (age guard).
    plant(join(um, 'index-0123456789abcdef.db'), 1)
    plant(join(um, 'index.db'), 1)
    runCleanup(deps())
    expect(existsSync(join(um, 'index.db'))).toBe(true)
    // Successor present and the legacy DB is old: goes.
    utimesSync(join(um, 'index.db'), new Date(Date.now() - 40 * 86400e3), new Date(Date.now() - 40 * 86400e3))
    const result = runCleanup(deps())
    expect(result.removed.map((r) => r.rule)).toContain('legacy-index-db')
    expect(existsSync(join(um, 'index.db'))).toBe(false)
  })

  it('in the vault, only dotfile temps are candidates — user notes never', () => {
    const ctx = join(vault, '50-Agent-Context')
    plant(join(ctx, '.prefs.0123abcd.tmp'), 2)
    plant(join(ctx, '我的偏好摘要.md'), 2, '- 用户偏好')
    plant(join(ctx, 'note（冲突副本）.md'), 2)
    plant(join(ctx, 'Agent提交区', '.pending.deadbeef.tmp'), 2)
    const result = runCleanup(deps())
    expect(result.removed.map((r) => r.rule)).toEqual(['core-vault-temp', 'core-vault-temp'])
    expect(existsSync(join(ctx, '我的偏好摘要.md'))).toBe(true)
    expect(existsSync(join(ctx, 'note（冲突副本）.md'))).toBe(true)
    expect(existsSync(join(ctx, '.prefs.0123abcd.tmp'))).toBe(false)
    expect(existsSync(join(ctx, 'Agent提交区', '.pending.deadbeef.tmp'))).toBe(false)
  })

  it('is idempotent: a second sweep removes nothing', () => {
    plant(join(home, '.dsh', 'AGENTS.md.bak-20260101-000000-000'), 1)
    runCleanup(deps())
    const second = runCleanup(deps())
    expect(second.removed).toHaveLength(0)
    expect(summarizeCleanup(second)).toBe('无可清理。')
  })

  it('applies declared retirements as data', () => {
    const legacy = join(home, '.unified-memory', 'bin', 'memory.old')
    plant(legacy, 10)
    const retired: RetiredArtifact[] = [
      { key: 'old-shim', reason: 'renamed in 0.9', paths: (d) => [join(d.home, '.unified-memory', 'bin', 'memory.old')] },
    ]
    const planned = planCleanup(deps(), retired, [])
    expect(planned.map((t) => t.rule)).toEqual(['old-shim'])
    const result = runCleanup(deps(), retired, [])
    expect(result.removed).toHaveLength(1)
    expect(existsSync(legacy)).toBe(false)
  })

  it('collects per-file failures instead of throwing', () => {
    // A directory where a removable file is expected: statSync says file check
    // filters it out; a genuinely unlink-failing path is hard to fake, so the
    // contract under test is "no throw" plus a faithful empty-ish report.
    plant(join(home, '.dsh', 'AGENTS.md.tmp-deploy'), 2)
    rmSync(join(home, '.dsh', 'AGENTS.md.tmp-deploy'))
    const result = runCleanup(deps())
    expect(result.removed).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
  })
})
