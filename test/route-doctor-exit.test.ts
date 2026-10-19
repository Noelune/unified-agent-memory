/**
 * `runCore({ keepOutputOnFailure })` — the one escape hatch that keeps a report
 * whose command exits non-zero.
 *
 * Driven against a real Python subprocess rather than a mock, because the
 * behaviour under test lives in the callback's handling of `err` + `stdout`, and
 * a mocked `execFile` would assert that the code calls the mock, not that the
 * bytes survive. A fake `unified_memory` package on PYTHONPATH prints a JSON
 * envelope and then exits 1 — exactly what `doctor --json` does when it finds an
 * error-severity issue.
 *
 * @module test/route-doctor-exit.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCore } from '../src/utils.ts'
import type { PluginConfig } from '../src/types.ts'

const ENVELOPE = '{"ok": true, "command": "doctor", "data": {"issues": []}}'

let corePath = ''

beforeAll(() => {
  corePath = mkdtempSync(join(tmpdir(), 'um-core-'))
  mkdirSync(join(corePath, 'unified_memory'))
  writeFileSync(join(corePath, 'unified_memory', '__init__.py'), '')
  // Prints the report, then fails the way a health check with an error does.
  writeFileSync(
    join(corePath, 'unified_memory', 'memory.py'),
    'import sys\n' +
      'print(' + JSON.stringify(ENVELOPE) + ')\n' +
      'sys.stdout.flush()\n' +
      'sys.exit(1)\n',
  )
})

afterAll(() => {
  if (corePath) rmSync(corePath, { recursive: true, force: true })
})

function cfg(): PluginConfig {
  return { pythonPath: 'python', corePath, vaultPath: '' } as unknown as PluginConfig
}

describe('runCore keepOutputOnFailure', () => {
  it('drops stdout on a non-zero exit by default', async () => {
    // The default exists because for most commands a non-zero exit means "no
    // answer", and a partial write is worse than none.
    const r = await runCore(cfg(), ['doctor', '--json'])
    expect(r.ok).toBe(false)
    expect(r.output).toBe('')
  })

  it('keeps stdout when the caller asks for it', async () => {
    const r = await runCore(cfg(), ['doctor', '--json'], { keepOutputOnFailure: true })
    // Still a failure — the exit code is reported honestly — but the report
    // made it back, which is the whole point.
    expect(r.ok).toBe(false)
    expect(r.output).toContain('"issues"')
  })
})
