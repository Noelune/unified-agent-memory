/**
 * Integration test: the dismiss argv must be accepted by the REAL argparse.
 *
 * This file exists because of a P0 that the mocked suite could not see. Every
 * other dismiss test stubs `runCore` and asserts on the argv *literal*, so when
 * `buildDismissArgs` regressed to `['dismiss', '--', name, '--json']` the whole
 * suite stayed green. That shape is wrong for a reason no literal assertion can
 * observe: argparse treats EVERY token after `--` as positional, so the trailing
 * `--json` became a second positional argument, the parser exited 2 with an
 * empty stdout, `runCore` reported it as a bare `crash`, and the caller's
 * fallback labelled a perfectly legal filename `invalid-name` — the write path
 * silently refused every real submission.
 *
 * So this test does not assert the argv shape at all. It spawns the actual
 * Python core against a real temporary vault and requires the move to happen:
 * `runCore` is NOT mocked here, and nothing about the core's internals is faked.
 * The assertion is on the observable outcome ("the file moved"), which is
 * exactly what broke, rather than on the string we happened to write.
 *
 * Skips (rather than fails) when no Python interpreter is available, so the
 * suite still runs on a machine without one — the mocked contract tests cover
 * that case, and a missing interpreter is an environment fact, not a regression.
 *
 * @module test/route-dismiss-integration.test
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildDismissArgs, handleDismiss } from '../src/route-dismiss.ts'
import { runCore } from '../src/utils.ts'
import type { PluginConfig } from '../src/types.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORE_PATH = join(REPO_ROOT, 'core')

/** Candidate interpreters, most specific first; the first that answers wins. */
const PYTHON_CANDIDATES = [
  process.env.UNIFIED_MEMORY_PYTHON,
  'C:/Users/zhaowei/AppData/Local/Programs/Python/Python311/python.exe',
  'python3',
  'python',
].filter((p): p is string => Boolean(p))

/** The interpreter that actually runs, or null when the host has none. */
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

describe('POST /dismiss against the real Python core', () => {
  let vault: string
  let cfg: PluginConfig
  let inbox: string

  beforeAll(() => {
    if (!pythonPath) return
    vault = mkdtempSync(join(tmpdir(), 'dsh-dismiss-argv-'))
    inbox = join(vault, '50-Agent-Context', 'Agent提交区')
    mkdirSync(inbox, { recursive: true })
    cfg = { vaultPath: vault, pythonPath, corePath: CORE_PATH, remoteEnabled: false }
  })

  afterAll(() => {
    if (vault) rmSync(vault, { recursive: true, force: true })
  })

  it.skipIf(!pythonPath)(
    'moves a real entry — the argv is accepted by argparse, not rejected as extra positionals',
    async () => {
      const name = 'dsh-2026-09-22-001.md'
      writeFileSync(join(inbox, name), '# 条目\n\n- 一条事实\n', 'utf8')
      expect(existsSync(join(inbox, name))).toBe(true)

      // Dismiss ONCE through the real handler: real runCore, real subprocess,
      // no mock and no stubbed stdout. (Calling runCore and then handleDismiss
      // would dismiss twice — the second call finds the entry already moved and
      // reports a refusal, which says nothing about the argv.)
      const moved = await handleDismiss(cfg, name)

      // A rejected argv exits 2 with an empty stdout and degrades to
      // `invalid-name`; a working one moves the file. Pin both.
      expect(moved.reason).not.toBe('invalid-name')
      expect(moved.ok).toBe(true)

      // The observable outcome: the file really left the inbox for 已处理/.
      expect(existsSync(join(inbox, name))).toBe(false)
      expect(existsSync(join(inbox, '已处理', name))).toBe(true)
    },
  )

  it.skipIf(!pythonPath)(
    'reports a genuinely absent entry as a core refusal, never as an argv error',
    async () => {
      // Two things are pinned here against the REAL core.
      //
      // 1. The argv reaches the command body. Before the argv fix a legal name
      //    exited 2 with an empty stdout (a bare `crash`); now the core starts,
      //    answers inside an envelope, and exits 0.
      // 2. The refusal's OWN reason survives to the host. The real envelope for
      //    a missing entry sets `ok:false` at BOTH levels (the core copies
      //    `result["ok"]` into the outer key), and `shapeDismissResult` used to
      //    require the outer `ok` to be true — flattening this `not-found` into
      //    `unavailable`. That was a separate defect, fixed alongside this test:
      //    the reason below is what an operator needs to tell "already moved"
      //    from "core is down".
      const result = await runCore(cfg, buildDismissArgs('definitely-absent.md'))

      // Evidence, order matters: exit 0 + a real envelope === argparse accepted
      // the argv. The old shape failed both of these.
      expect(result.ok, `core failed: ${result.error ?? ''}`).toBe(true)
      const envelope = JSON.parse(result.output) as {
        ok?: boolean
        command?: string
        data?: { ok?: boolean; reason?: string }
      }
      expect(envelope.command).toBe('dismiss')
      expect(envelope.data?.reason).toBe('not-found')
      // The premise of the fix, pinned against the real core rather than a fake.
      expect(envelope.ok).toBe(false)
      expect(envelope.data?.ok).toBe(false)

      // And the host surfaces the core's reason instead of 'unavailable'.
      const moved = await handleDismiss(cfg, 'definitely-absent.md')
      expect(moved.reason).toBe('not-found')
      expect(moved.reason).not.toBe('invalid-name')
    },
  )
})
