/**
 * Unit tests for the doctor shaper.
 *
 * These cover the branches that decide what the health pane can say: whether the
 * issue list survived, whether `data.ok:false` (a broken vault reporting itself)
 * is treated as data rather than as a dead core, and whether an unknown severity
 * is demoted out of the count.
 *
 * @module test/route-doctor.test
 */

import { describe, it, expect } from 'vitest'
import { DOCTOR_PATH, buildDoctorArgs, shapeDoctorResult } from '../src/route-doctor.ts'

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, command: 'doctor', data })
}

describe('buildDoctorArgs', () => {
  it('asks for the machine-readable report', () => {
    expect(buildDoctorArgs()).toEqual(['doctor', '--json'])
  })

  it('never adds --strict: a warning must not make the read look like a crash', () => {
    expect(buildDoctorArgs()).not.toContain('--strict')
  })
})

describe('shapeDoctorResult', () => {
  it('keeps the issue list verbatim', () => {
    const p = shapeDoctorResult(envelope({
      issues: [{ severity: 'warn', code: 'index-bloat', message: 'index database is 90 MB', hint: 'memory gc --apply' }],
    }))
    expect(p.ok).toBe(true)
    expect(p.status).toBe('ok')
    expect(p.issues).toEqual([
      { severity: 'warn', code: 'index-bloat', message: 'index database is 90 MB', hint: 'memory gc --apply' },
    ])
  })

  it('reads the counts the pane quotes', () => {
    const p = shapeDoctorResult(envelope({
      index: { memories: 476, vectors: 377 },
      conflicts: { count: 3 },
      inbox: { count: 2 },
      canonical: { duplicateLines: [{ doc: 'a.md', line: 'x' }] },
      orphanIndexes: { count: 4 },
      issues: [],
    }))
    expect(p.counts).toEqual({
      memories: 476, vectors: 377, conflicts: 3, inbox: 2, duplicates: 1, orphans: 4,
    })
  })

  it('reads the REAL report a healthy vault produces, field for field', () => {
    // Captured verbatim from `memory doctor --json` against the real vault (477
    // memories / 377 vectors / one inbox item). The values are in the fixture on
    // purpose: a hand-written one only proves the shaper matches my idea of the
    // core's output, and this one proves it matches the core's output.
    const real = JSON.stringify({
      ok: true, command: 'doctor',
      data: {
        vault: 'C:\\Users\\zhaowei\\OneDrive\\Desktop\\Obsidian Vault',
        ok: true,
        index: {
          path: 'C:\\Users\\zhaowei\\.unified-memory\\index-71a0477711752b6b.db',
          bytes: 6062080, journalMode: 'wal', docs: 20,
          memories: 477, active: 477, superseded: 0, vectors: 377,
          accesses: 679, graphNodes: 1202, graphEdges: 5000,
        },
        inbox: { count: 1, oldestDays: 0.4, files: ['前缀登记.md'] },
        canonical: { files: 20, conflictCopies: [], duplicateLines: [], unclassifiedLines: 0 },
        conflicts: { count: 0 },
        embeddings: { configured: true, coverage: 0.79 },
        digest: { cursor: '2026-10-19' },
        issues: [],
        orphanIndexes: { count: 0, bytes: 0, files: [] },
      },
    })
    const p = shapeDoctorResult(real)
    expect(p.status).toBe('ok')
    expect(p.issues).toEqual([])
    expect(p.counts).toEqual({
      memories: 477, vectors: 377, conflicts: 0, inbox: 1, duplicates: 0, orphans: 0,
    })
  })

  it('keeps a broken-vault report as data, not as unavailability', () => {
    // `data.ok:false` is the core reporting a missing vault WITH an issue
    // attached — the single most useful thing the pane can print.
    const p = shapeDoctorResult(JSON.stringify({
      ok: true, command: 'doctor',
      data: { ok: false, vault: 'C:/gone', issues: [
        { severity: 'error', code: 'vault-missing', message: 'vault missing', hint: 'memory init' },
      ] },
    }))
    expect(p.status).toBe('ok')
    expect(p.issues).toHaveLength(1)
    expect(p.issues[0].severity).toBe('error')
  })

  it('never silently demotes an unknown severity', () => {
    // A newer core saying "fatal" must not fall out of the warn count.
    const p = shapeDoctorResult(envelope({ issues: [{ severity: 'fatal', code: 'x', message: 'boom' }] }))
    expect(p.issues[0].severity).toBe('warn')
  })

  it('drops an issue with neither a code nor a sentence', () => {
    const p = shapeDoctorResult(envelope({ issues: [{ severity: 'warn' }, { code: 'ok-one', message: 'm' }] }))
    expect(p.issues).toHaveLength(1)
    expect(p.issues[0].code).toBe('ok-one')
  })

  it('treats a malformed body as unavailable, not as a clean bill', () => {
    expect(shapeDoctorResult('not json').status).toBe('unavailable')
    expect(shapeDoctorResult('{}').status).toBe('unavailable')
    expect(shapeDoctorResult(JSON.stringify({ ok: true })).status).toBe('unavailable')
  })

  it('rejects an ARRAY as data: `typeof [] === "object"` must not pass the gate', () => {
    // An array carries none of the named fields a doctor report has, so every
    // read below it is `undefined` and the pane renders a full set of zeroes —
    // a malformed payload shown as "0 记忆 / 0 向量". An array is never an
    // envelope.
    expect(shapeDoctorResult(envelope([])).status).toBe('unavailable')
    expect(shapeDoctorResult(envelope([])).counts).toBeNull()
    expect(shapeDoctorResult(JSON.stringify({ ok: true, data: 'not an object' })).status).toBe('unavailable')
  })

  it('reports zero counts only when the doctor really measured an empty vault', () => {
    // `index` is the sentinel: the core assigns it inside the one `try` block in
    // `health.doctor()`. Its presence means the counts are a reading, and a
    // reading of 0 is legitimate — the vault is genuinely empty.
    const p = shapeDoctorResult(envelope({ index: { memories: 0, vectors: 0 }, issues: [] }))
    expect(p.status).toBe('ok')
    expect(p.counts).toEqual({
      memories: 0, vectors: 0, conflicts: 0, inbox: 0, duplicates: 0, orphans: 0,
    })
  })

  it('reports counts:null — not zeroes — when the report carries no measurements', () => {
    // The core's CLI fallback for a vault it could not open is
    // `{ok:false, vault, issues}` with no `index`/`inbox`/`canonical`. That is a
    // real answer worth printing (it carries `vault-missing`), but it is not a
    // measurement: counting its absent fields as 0 claims the vault HAS zero
    // memories, which is the opposite of what the finding says. `null` is the
    // honest value, and the pane already renders it as "—".
    const p = shapeDoctorResult(JSON.stringify({
      ok: true, command: 'doctor',
      data: { ok: false, vault: 'C:/gone', issues: [
        { severity: 'error', code: 'vault-missing', message: 'vault missing', hint: 'memory init' },
      ] },
    }))
    expect(p.status).toBe('ok')
    expect(p.issues).toHaveLength(1)
    expect(p.counts).toBeNull()
  })

  it('handles the REAL vault-missing report the core actually emits', () => {
    // Captured verbatim from `memory doctor --json` against a vault path that
    // does not exist (core exits 1 after printing, which is why the route needs
    // `keepOutputOnFailure`). Verbatim because a hand-written fixture encodes my
    // assumptions about the fallback's shape; this one encodes the shape. If the
    // core ever starts emitting counts in the fallback, this test is where that
    // shows up.
    const real = JSON.stringify({
      ok: true, command: 'doctor',
      data: {
        ok: false,
        vault: 'C:\\Users\\zhaowei\\definitely-not-here-xyz',
        issues: [{
          severity: 'error',
          code: 'vault-missing',
          message: 'vault not initialized at C:\\Users\\zhaowei\\definitely-not-here-xyz — run "memory init --vault <path>" (or set UNIFIED_MEMORY_VAULT)',
          hint: 'Run `memory init --vault <path>` or fix ~/.unified-memory.yaml.',
        }],
      },
    })
    const p = shapeDoctorResult(real)
    // The finding survives intact — that is the whole point of not treating
    // `data.ok:false` as unavailability.
    expect(p.status).toBe('ok')
    expect(p.issues).toEqual([{
      severity: 'error',
      code: 'vault-missing',
      message: 'vault not initialized at C:\\Users\\zhaowei\\definitely-not-here-xyz — run "memory init --vault <path>" (or set UNIFIED_MEMORY_VAULT)',
      hint: 'Run `memory init --vault <path>` or fix ~/.unified-memory.yaml.',
    }])
    // And the measurement is absent, not zero. This is the assertion that was
    // failing on the old code: six zeroes claimed a readable empty vault.
    expect(p.counts).toBeNull()
  })
})

describe('DOCTOR_PATH', () => {
  it('is its own endpoint', () => {
    expect(DOCTOR_PATH).toBe('/api/dsh-unified-agent-memory/doctor')
    expect(DOCTOR_PATH).not.toBe('/api/dsh-unified-agent-memory/status')
  })
})
