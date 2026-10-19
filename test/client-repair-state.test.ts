/**
 * The hand-off state machine.
 *
 * React hooks cannot be mounted in this test environment, so the two decisions
 * that matter are pure functions in `store.ts` and are exercised here directly:
 * `advanceRepairs` (has the agent started? has it stopped?) and
 * `reconcileRepairs` (did the finding actually go away?).
 *
 * The asymmetry between them is the whole design: progress is inferred from a
 * session snapshot for free, but the RESULT is only ever read from the doctor.
 * An agent saying it fixed something is a sentence; the issue disappearing is a
 * measurement.
 *
 * @module test/client-repair-state.test
 */

import { describe, expect, it } from 'vitest'

import { advanceRepairs, reconcileRepairs } from '../src/client/store.ts'
import type { RepairEntry } from '../src/client/store.ts'

const NOW = 1_700_000_000_000

function entry(over: Partial<RepairEntry> = {}): RepairEntry {
  return { phase: 'sent', startedAt: NOW, sessionId: 's1', ...over }
}

/** Answer `running` for every session at once. */
function always(value: boolean | null) {
  return () => value
}

describe('advanceRepairs — progress from the session snapshot', () => {
  it('promotes "sent" to "running" when the agent starts', () => {
    const out = advanceRepairs({ 'index-bloat': entry() }, always(true), NOW + 1000)
    expect(out.entries['index-bloat'].phase).toBe('running')
    expect(out.changed).toBe(true)
    expect(out.verify).toBe(false)
  })

  it('asks for a verify exactly once, when a running turn ends', () => {
    const out = advanceRepairs({ 'index-bloat': entry({ phase: 'running' }) }, always(false), NOW + 1000)
    expect(out.entries['index-bloat'].phase).toBe('verifying')
    expect(out.verify).toBe(true)
  })

  it('does not verify a brief that has not visibly started yet', () => {
    // A prompt that was accepted but has not produced a turn yet looks exactly
    // like a finished turn from the outside; the grace period is what keeps
    // those two apart, and a false verify here would report "still broken".
    const out = advanceRepairs({ 'index-bloat': entry() }, always(false), NOW + 1000)
    expect(out.entries['index-bloat'].phase).toBe('sent')
    expect(out.verify).toBe(false)
  })

  it('gives up waiting and asks the doctor once the grace period passes', () => {
    const out = advanceRepairs({ 'index-bloat': entry() }, always(false), NOW + 5000)
    expect(out.entries['index-bloat'].phase).toBe('verifying')
    expect(out.verify).toBe(true)
  })

  it('treats a vanished session row like a finished turn', () => {
    // `null` is "no row", not "not running": a session that disappeared can
    // never report again, so the doctor is the only way to settle it.
    const out = advanceRepairs({ 'index-bloat': entry({ phase: 'running' }) }, always(null), NOW + 1000)
    expect(out.entries['index-bloat'].phase).toBe('verifying')
    expect(out.verify).toBe(true)
  })

  it('leaves settled and unrelated phases alone', () => {
    const entries: Record<string, RepairEntry> = {
      failed: entry({ phase: 'failed' }),
      mismatch: entry({ phase: 'mismatch' }),
      verifying: entry({ phase: 'verifying' }),
      sending: entry({ phase: 'sending' }),
    }
    const out = advanceRepairs(entries, always(false), NOW + 60000)
    expect(out.changed).toBe(false)
    expect(out.verify).toBe(false)
    expect(out.entries).toEqual(entries)
  })

  it('verifies once for many hand-offs and only retires the running one', () => {
    const entries: Record<string, RepairEntry> = {
      a: entry({ phase: 'running', sessionId: 'a' }),
      b: entry({ phase: 'sent', startedAt: NOW - 60000, sessionId: 'b' }),
      c: entry({ phase: 'running', sessionId: 'c' }),
    }
    const out = advanceRepairs(entries, (id) => id === 'c', NOW)
    expect(out.verify).toBe(true)
    expect(out.entries.a.phase).toBe('verifying')
    expect(out.entries.b.phase).toBe('verifying')
    expect(out.entries.c.phase).toBe('running')
  })

  it('never mutates the map it was given', () => {
    const entries: Record<string, RepairEntry> = { a: entry({ phase: 'running' }) }
    advanceRepairs(entries, always(false), NOW)
    expect(entries.a.phase).toBe('running')
  })
})

describe('reconcileRepairs — the doctor is the only referee', () => {
  it('retires a finding the doctor no longer reports', () => {
    const out = reconcileRepairs({ 'index-bloat': entry({ phase: 'verifying' }) }, [])
    expect(out.entries['index-bloat']).toBeUndefined()
    expect(out.changed).toBe(true)
  })

  it('records a disagreement when the agent claims success and the issue stays', () => {
    const out = reconcileRepairs({ 'index-bloat': entry({ phase: 'verifying' }) }, ['index-bloat'])
    expect(out.entries['index-bloat'].phase).toBe('mismatch')
    expect(out.entries['index-bloat'].note).toContain('另一个 vault')
  })

  it('retires a mismatch once the doctor agrees it is gone', () => {
    const out = reconcileRepairs({ 'index-bloat': entry({ phase: 'mismatch' }) }, [])
    expect(out.entries['index-bloat']).toBeUndefined()
  })

  it('does not rewrite an unchanged disagreement on every doctor read', () => {
    const out = reconcileRepairs({ 'index-bloat': entry({ phase: 'mismatch' }) }, ['index-bloat'])
    expect(out.changed).toBe(false)
  })

  it('ignores findings that are not waiting on a verify', () => {
    // A failed send was never aimed at the doctor; silence there must not read
    // as "fixed".
    const entries: Record<string, RepairEntry> = {
      a: entry({ phase: 'failed' }),
      b: entry({ phase: 'running' }),
      c: entry({ phase: 'sending' }),
    }
    const out = reconcileRepairs(entries, [])
    expect(out.changed).toBe(false)
    expect(Object.keys(out.entries)).toHaveLength(3)
  })

  it('matches by code, not by position', () => {
    const entries: Record<string, RepairEntry> = {
      'index-bloat': entry({ phase: 'verifying' }),
      'orphan-indexes': entry({ phase: 'verifying' }),
    }
    const out = reconcileRepairs(entries, ['orphan-indexes'])
    expect(out.entries['index-bloat']).toBeUndefined()
    expect(out.entries['orphan-indexes'].phase).toBe('mismatch')
  })
})
