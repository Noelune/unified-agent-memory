/**
 * Integration test: /decide against the REAL Python core.
 *
 * Two things only a real subprocess can prove:
 *
 *  1. The argv is accepted by argparse. `decide -- k1 用新 --json` exits 2 with
 *     an empty stdout, which the host reports as `invalid-key` — every ruling
 *     would be refused while the unit tests (which assert the argv literal)
 *     stayed green. Same P0 class as the dismiss argv.
 *  2. The block-shaped conflict a human writes is actually actionable. The
 *     reader in `conflict.py` used to understand only the single-line JSON
 *     shape, so a vault holding `## … 冲突 #…` blocks reported "no pending
 *     conflicts" forever. This test builds that exact file and requires the
 *     ruling to land in the note the block names.
 *
 * Skips when no interpreter is available: a missing Python is an environment
 * fact, not a regression, and the mocked contract tests still run.
 *
 * @module test/route-decide-integration.test
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { handleDecide } from '../src/route-decide.ts'
import type { PluginConfig } from '../src/types.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE_PATH = join(REPO_ROOT, 'core')

const PYTHON_CANDIDATES = [
  process.env.UNIFIED_MEMORY_PYTHON,
  'python3',
  'python',
].filter((p): p is string => Boolean(p))

function findPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

const pythonPath = findPython()

/** The shape the other runtime writes, copied verbatim from a real vault. */
const BLOCK = [
  '# 事实冲突待裁决队列',
  '',
  '（当前无待裁决冲突）',
  '',
  '---',
  '## 2026-10-19 03:01 冲突 #20261019030125-1',
  '- 状态：[待裁决]',
  '- 新提交：备份目录已迁移到 D:/backups',
  '- 来源：[[Hermes会话自动归档/2026-10-18]]',
  '- 既有：- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）',
  '- 所在：50-Agent-Context\\常用路径与环境.md',
  '',
].join('\n')

describe('POST /decide against the real Python core', () => {
  let vault: string
  let cfg: PluginConfig
  let queue: string
  let note: string

  beforeAll(() => {
    if (!pythonPath) return
    vault = mkdtempSync(join(tmpdir(), 'dsh-decide-argv-'))
    const ctx = join(vault, '50-Agent-Context')
    mkdirSync(join(ctx, '情境信息'), { recursive: true })
    queue = join(ctx, '情境信息', '事实冲突待裁决.md')
    note = join(ctx, '常用路径与环境.md')
    writeFileSync(queue, BLOCK, 'utf8')
    writeFileSync(
      note,
      '# 常用路径与环境\n\n- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）\n',
      'utf8',
    )
    cfg = { vaultPath: vault, pythonPath, corePath: CORE_PATH, remoteEnabled: false }
  })

  afterAll(() => {
    if (vault) rmSync(vault, { recursive: true, force: true })
  })

  it.skipIf(!pythonPath)(
    'replaces the old line in the note the block names, and empties the queue',
    async () => {
      const result = await handleDecide(cfg, '20261019030125-1', '用新')

      // A rejected argv would surface as `invalid-key`; a working one writes.
      expect(result.reason).not.toBe('invalid-key')
      expect(result.ok).toBe(true)
      expect(result.applied).toBe(true)

      const text = readFileSync(note, 'utf8')
      expect(text).toContain('备份目录已迁移到 D:/backups')
      expect(text).not.toContain('备份目录是 C:/backups')

      // The queue entry is gone, so the question does not come back.
      expect(readFileSync(queue, 'utf8')).not.toContain('20261019030125-1')
    },
  )

  it.skipIf(!pythonPath)(
    'a second ruling on the same key is not-found, not a double write',
    async () => {
      const again = await handleDecide(cfg, '20261019030125-1', '用新')

      expect(again.ok).toBe(false)
      expect(again.reason).toBe('not-found')
    },
  )

  it.skipIf(!pythonPath)(
    'an unknown key is refused by the core, not by the argv',
    async () => {
      const result = await handleDecide(cfg, 'nosuchkey', '并存')

      expect(result.reason).toBe('not-found')
      expect(result.reason).not.toBe('invalid-key')
    },
  )
})
