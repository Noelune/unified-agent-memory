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

  it('reports zero counts when the envelope carries no measurements', () => {
    const p = shapeDoctorResult(envelope({ issues: [] }))
    expect(p.counts).toEqual({
      memories: 0, vectors: 0, conflicts: 0, inbox: 0, duplicates: 0, orphans: 0,
    })
  })
})

describe('DOCTOR_PATH', () => {
  it('is its own endpoint', () => {
    expect(DOCTOR_PATH).toBe('/api/dsh-unified-agent-memory/doctor')
    expect(DOCTOR_PATH).not.toBe('/api/dsh-unified-agent-memory/status')
  })
})
