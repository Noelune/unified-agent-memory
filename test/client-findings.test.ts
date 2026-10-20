/**
 * The health pane's "what do I do about it" half.
 *
 * The pane used to stop at "2 项需要处理（索引、冲突）" — a diagnosis with no
 * treatment. `healthFindings` (doctor issues → cards) and `rowFindings` (the
 * fallback when the doctor never ran) are the logic that closes that gap, and
 * both live in `view.ts` so they run here without React or a DOM.
 *
 * Every block below carries a mutation check: the function is replaced by a
 * plausible-but-wrong implementation and the guard is asserted to go red. A
 * test that cannot fail is decoration.
 *
 * @module test/client-findings.test
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  COMMAND_NOTE,
  NO_AGENT,
  SEVERITY_LABEL,
  agentAction,
  healthFindings,
  issueTitle,
  healthRows,
  rowFindings,
} from '../src/client/view.ts'
import type { DoctorIssue } from '../src/client/types.ts'

const CONSOLE = readFileSync(new URL('../src/client/Console.tsx', import.meta.url), 'utf8')
const STYLES = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')

const HEALTH_PY = new URL('../core/unified_memory/health.py', import.meta.url)
const MEMORY_PY = new URL('../core/unified_memory/memory.py', import.meta.url)

/** Comments stripped: assertions about call sites must not match prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const CONSOLE_CODE = stripComments(CONSOLE)

/**
 * The issue codes the core can emit, read out of the core's own source.
 *
 * A literal array here would be the bug it is meant to catch. The day the core
 * grows a tenth check, a hard-coded list keeps passing while the pane renders
 * that finding with a raw `some-new-code` for a title, a generic "本版面板还不
 * 认识" for a next step and no hand-off button — i.e. exactly the "it looks
 * fine from here" failure this whole audit exists to eliminate.
 *
 * Two emit sites feed the set:
 *   1. `health.doctor()` — `_issue("<severity>", "<code>", …)`, the nine checks.
 *   2. `cmd_doctor`'s fallback envelope — a one-line `code = A if … else B`,
 *      the only place `vault-missing` and `doctor-failed` are born.
 */
function coreIssueCodes(): string[] {
  const health = readFileSync(HEALTH_PY, 'utf8')
  const memory = readFileSync(MEMORY_PY, 'utf8')

  const fromDoctor = [...health.matchAll(/_issue\(\s*"(?:error|warn|info)"\s*,\s*"([a-z][a-z0-9-]*)"/g)]
    .map(function (m) { return m[1] })

  // Both branches of the ternary sit on the assignment line; every kebab-case
  // literal on it is a code.
  const fromFallback = [...memory.matchAll(/^\s*code\s*=\s*(.+)$/gm)]
    .flatMap(function (line) {
      return [...line[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map(function (s) { return s[1] })
    })

  return [...new Set([...fromDoctor, ...fromFallback])].sort()
}

/** The codes `AGENT_PLAN` in view.ts carries terms for, read from the source. */
function agentPlanCodes(): string[] {
  const src = readFileSync(new URL('../src/client/view.ts', import.meta.url), 'utf8')
  const at = src.indexOf('const AGENT_PLAN')
  const end = src.indexOf('\n}', at)
  return [...src.slice(at, end).matchAll(/^\s*'([a-z][a-z0-9-]*)':/gm)]
    .map(function (m) { return m[1] })
    .sort()
}

function issue(
  code: string,
  severity: DoctorIssue['severity'] = 'warn',
  message = '',
): DoctorIssue {
  return { severity, code, message, hint: '' }
}

const COUNTS = { memories: 476, vectors: 377, conflicts: 3, inbox: 2, duplicates: 5, orphans: 2 }

describe('healthFindings', () => {
  it('has translated copy and a next step for every code the core can emit', () => {
    // The bug this module exists to fix: a warning that names a symptom and
    // stops. A card without `fix` is the same dead end one scroll further down.
    //
    // The assertions below are the ones that can actually fail. A `fix.length >
    // 6` check passes on the generic unknown-code card too — so a missing
    // ISSUE_COPY entry would slip through a length guard while the user reads
    // "本版面板还不认识" against a real problem. Both fallbacks are therefore
    // asserted against directly: `issueTitle` returns the RAW CODE when it has
    // no copy, and `healthFindings` returns a fixed sentence.
    const codes = coreIssueCodes()
    const got = healthFindings(codes.map((c) => issue(c)), COUNTS)
    expect(got).toHaveLength(codes.length)
    for (const f of got) {
      expect(f.title, f.key).not.toBe(f.key)
      expect(f.title, f.key).toMatch(/[\u4e00-\u9fa5]/)
      expect(f.title, f.key).not.toContain('undefined')
      expect(f.fix, f.key).not.toContain('本版面板还不认识')
      expect(f.fix.length, f.key).toBeGreaterThan(6)
      expect(f.detail.length, f.key).toBeGreaterThan(6)
      // The "a repair introduced a problem" line builds its sentence from
      // `issueTitle`, which returns the RAW CODE when it has no copy — a
      // different function, a different fallback, so it is asserted separately.
      expect(issueTitle(f.key), f.key).not.toBe(f.key)
    }
  })

  it('accounts for every `_issue` call site, so a parse failure is loud', () => {
    // The parser above is a regex, and a regex that quietly matches nothing
    // reports green — a blind spot wearing the same colour as a clean bill.
    // Counting the call sites makes an unparseable new check a failure here
    // rather than a silent omission there.
    const health = readFileSync(HEALTH_PY, 'utf8')
    const callSites = [...health.matchAll(/_issue\(/g)].length - 1 // minus `def _issue(`
    const parsed = [...health.matchAll(/_issue\(\s*"(?:error|warn|info)"\s*,\s*"([a-z][a-z0-9-]*)"/g)]
    expect(parsed.length).toBe(callSites)
    expect(callSites).toBeGreaterThanOrEqual(9)
  })

  it('reads the fallback envelope’s two codes too', () => {
    // `vault-missing` and `doctor-failed` never appear in health.py — they are
    // minted in the CLI catch block. A parser pointed only at the doctor would
    // report a complete set while missing the two codes the user is most likely
    // to see (a broken vault is why the pane is empty in the first place).
    const codes = coreIssueCodes()
    expect(codes).toContain('vault-missing')
    expect(codes).toContain('doctor-failed')
  })

  it('offers a paste-ready command where one exists', () => {
    expect(healthFindings([issue('index-bloat')])[0].command).toBe('memory gc --apply')
    expect(healthFindings([issue('embedding-coverage')])[0].command).toBe('memory embed')
  })

  it('leaves command null when the fix is a human decision', () => {
    // Merging two sync-conflict copies is not a command; printing a fake one
    // would be worse than printing none.
    const got = healthFindings([issue('sync-conflict-copies', 'error')])
    expect(got[0].command).toBeNull()
    expect(got[0].severity).toBe('error')
  })

  it('quotes the core count so the reader knows the size of the job', () => {
    expect(healthFindings([issue('conflicts-pending')], COUNTS)[0].detail).toContain('3')
    expect(healthFindings([issue('duplicate-facts')], COUNTS)[0].detail).toContain('5')
    expect(healthFindings([issue('orphan-indexes')], COUNTS)[0].detail).toContain('2')
  })

  it('does not invent a count when the doctor carried none', () => {
    // No counts means the number is unknown, not zero — the sentence falls back
    // to prose rather than claiming "共 0 条".
    const got = healthFindings([issue('conflicts-pending')], null)
    expect(got[0].detail).not.toContain('0')
  })

  it('keeps a finding this build does not recognize, in the core words', () => {
    // Dropping an unknown code would hide a real problem; English is the lesser
    // cost, and the hint still names the command.
    const got = healthFindings([
      { severity: 'warn', code: 'brand-new-check', message: 'something odd', hint: 'memory gc --apply' },
    ])
    expect(got).toHaveLength(1)
    expect(got[0].detail).toBe('something odd')
    expect(got[0].fix).toBe('memory gc --apply')
  })

  it('falls back to a sentence when an unknown finding has no hint', () => {
    const got = healthFindings([{ severity: 'warn', code: 'mystery', message: 'm', hint: '' }])
    expect(got[0].fix).toContain('memory doctor')
  })

  it('keys by code so a re-read does not remount the whole list', () => {
    const got = healthFindings([issue('index-bloat'), issue('graph-bloat')])
    expect(got.map((f) => f.key)).toEqual(['index-bloat', 'graph-bloat'])
  })

  it('gives a codeless finding a stable positional key', () => {
    const got = healthFindings([{ severity: 'warn', code: '', message: 'm', hint: '' }])
    expect(got[0].key).toBe('issue-0')
  })

  it('labels every severity the route can emit', () => {
    expect(SEVERITY_LABEL.error).toBe('错误')
    expect(SEVERITY_LABEL.warn).toBe('待处理')
    expect(SEVERITY_LABEL.info).toBe('提示')
  })

  it('documents how to read the command lines', () => {
    expect(COMMAND_NOTE).toContain('python -m unified_memory.memory')
  })
})

describe('rowFindings', () => {
  const base = {
    stats: { memories: 460, vectors: 455, pending: 2 },
    indexOk: true,
    conflicts: 0,
    recallMode: 'auto',
    agentName: 'dsh-desktop',
    agentSource: 'profile',
    version: '0.8.0',
  }

  it('says nothing when no row is warning', () => {
    expect(rowFindings(healthRows(base))).toEqual([])
  })

  it('turns a broken index into a rebuild command', () => {
    const got = rowFindings(healthRows({ ...base, indexOk: false }))
    expect(got).toHaveLength(1)
    expect(got[0].command).toBe('memory sync')
  })

  it('turns pending conflicts into the adjudication command', () => {
    const got = rowFindings(healthRows({ ...base, conflicts: 4 }))
    expect(got).toHaveLength(1)
    expect(got[0].command).toContain('adjudicate')
  })

  it('turns an unidentified prefix into an instruction, not a command', () => {
    const got = rowFindings(healthRows({ ...base, agentSource: 'fallback' }))
    expect(got).toHaveLength(1)
    expect(got[0].command).toBeNull()
    expect(got[0].fix).toContain('agentName')
  })

  it('does not turn an unknown reading into a finding', () => {
    // A muted row means the core said nothing. Inventing a problem from that is
    // the same mistake as reporting "0 条记忆".
    expect(rowFindings(healthRows({
      stats: null, indexOk: null, conflicts: null, recallMode: null,
      agentName: null, agentSource: null, version: null,
    }))).toEqual([])
  })
})

describe('mutation: healthFindings', () => {
  it('goes red when a finding is emitted without a next step', () => {
    const assert = function (f: typeof healthFindings) {
      expect(f([issue('index-bloat')])[0].fix.length).toBeGreaterThan(6)
    }
    const mutant = function (issues: readonly DoctorIssue[]) {
      return healthFindings(issues).map((f) => ({ ...f, fix: '' }))
    }
    assert(healthFindings)
    expect(function () { assert(mutant as typeof healthFindings) }).toThrow()
  })

  it('goes red when the core count is dropped from the sentence', () => {
    const assert = function (f: typeof healthFindings) {
      expect(f([issue('conflicts-pending')], COUNTS)[0].detail).toContain('3')
    }
    const mutant = function (issues: readonly DoctorIssue[]) {
      // The plausible simplification: the base prose reads fine on its own.
      return healthFindings(issues)
    }
    assert(healthFindings)
    expect(function () { assert(mutant as typeof healthFindings) }).toThrow()
  })

  it('goes red when an unknown code is dropped instead of shown', () => {
    const unknown = [{ severity: 'warn' as const, code: 'brand-new', message: 'x', hint: '' }]
    const assert = function (f: typeof healthFindings) {
      expect(f(unknown)).toHaveLength(1)
    }
    const mutant = function (issues: readonly DoctorIssue[]) {
      return healthFindings(issues).filter((i) => i.key !== 'brand-new')
    }
    assert(healthFindings)
    expect(function () { assert(mutant as typeof healthFindings) }).toThrow()
  })
})

describe('mutation: rowFindings', () => {
  it('goes red when a muted row is promoted to a finding', () => {
    const allUnknown = healthRows({
      stats: null, indexOk: null, conflicts: null, recallMode: null,
      agentName: null, agentSource: null, version: null,
    })
    const assert = function (f: typeof rowFindings) {
      expect(f(allUnknown)).toEqual([])
    }
    const mutant = function (rows: Parameters<typeof rowFindings>[0]) {
      return rows.map((r) => ({
        key: 'row:' + r.key, severity: 'warn' as const, title: r.label,
        detail: '', fix: 'see', command: null,
      }))
    }
    assert(rowFindings)
    expect(function () { assert(mutant as typeof rowFindings) }).toThrow()
  })
})

describe('wiring: the health pane says how to fix what it found', () => {
  function healthBody(): string {
    const at = CONSOLE_CODE.indexOf('function HealthTab(')
    const end = CONSOLE_CODE.indexOf('// ── Figures', at)
    return at < 0 ? '' : CONSOLE_CODE.slice(at, end < 0 ? CONSOLE_CODE.length : end)
  }

  it('reads the doctor list and falls back to the rows only when it is missing', () => {
    const body = healthBody()
    expect(body).toMatch(/useDoctor\(\)/)
    expect(body).toMatch(/healthFindings\(doctor\.issues/)
    expect(body).toMatch(/rowFindings\(rows\)/)
    // The fallback is gated on `unavailable`, never merged: both lists describe
    // the same conflicts, and printing both reads as two separate problems.
    expect(body).toMatch(/doctor\.status === 'unavailable'/)
  })

  it('renders one card per finding, with its command on its own line', () => {
    expect(CONSOLE_CODE).toMatch(/function FindingCard/)
    expect(CONSOLE_CODE).toMatch(/dsh-memory-finding-cmd/)
    expect(CONSOLE_CODE).toMatch(/dsh-memory-finding-fix/)
    expect(STYLES).toMatch(/\.dsh-memory-finding\[data-severity='error'\]/)
    expect(STYLES).toMatch(/user-select: all/)
  })

  it('offers a re-measure control on the verdict, not buried under the list', () => {
    const body = healthBody()
    expect(body).toMatch(/doctor\.reload/)
    expect(body).toMatch(/dsh-memory-health-retry/)
  })

  it('does not print a clean bill when the doctor never ran', () => {
    // "No findings" and "no doctor" must not look alike: the second is a blind
    // spot, and the pane says so instead of borrowing the green verdict.
    const body = healthBody()
    expect(body).toMatch(/详细体检没跑起来/)
  })
})

describe('agentAction — who does the work, and on what terms', () => {
  /** The health pane and its card, comments stripped. */
  function healthBody(): string {
    const at = CONSOLE_CODE.indexOf('function HealthTab(')
    const end = CONSOLE_CODE.indexOf('// ── Figures', at)
    return at < 0 ? '' : CONSOLE_CODE.slice(at, end < 0 ? CONSOLE_CODE.length : end)
  }

  it('routes the codes an agent can settle into "fix"', () => {
    const fixable = [
      'unclassified-facts', 'inbox-stale', 'duplicate-facts', 'graph-bloat',
      'index-bloat', 'doctor-failed', 'orphan-indexes', 'embedding-coverage',
    ]
    for (const code of fixable) {
      expect(agentAction(code).mode, code).toBe('fix')
      expect(agentAction(code).label.length, code).toBeGreaterThan(0)
    }
  })

  it('routes the codes that are the user’s decision into "analyze"', () => {
    // Two overlapping copies, a missing vault: an agent that "fixes" these
    // deletes something the user wanted.
    for (const code of ['sync-conflict-copies', 'vault-missing']) {
      expect(agentAction(code).mode, code).toBe('analyze')
    }
  })

  it('routes queued conflicts into "judge", not "analyze"', () => {
    // The queue was never a decision the user was better at — it was a decision
    // nobody was making, which is why it only ever grew. `judge` keeps what
    // `analyze` was protecting (nothing is written that the agent cannot
    // justify) without the dead end: what it cannot settle comes back carrying
    // a recommendation and a reason.
    expect(agentAction('conflicts-pending').mode).toBe('judge')
    expect(agentAction('conflicts-pending').risk).toContain('定不了')
  })

  it('offers no button for a code this build does not understand', () => {
    expect(agentAction('some-future-code')).toEqual(NO_AGENT)
    expect(healthFindings([issue('some-future-code')])[0].agent).toEqual(NO_AGENT)
  })

  it('keeps the hand-off table in step with the core’s codes, both directions', () => {
    // Direction 1 — every code the core can emit has terms here. A missing
    // entry does not crash: the card simply grows no button, which is the
    // quietest regression this pane can have.
    // Direction 2 — every entry names a code the core still emits. After a
    // rename in the core, a stale entry keeps offering "analyze" for a check
    // that no longer runs.
    const codes = coreIssueCodes()
    expect(agentPlanCodes()).toEqual(codes)
    for (const code of codes) {
      const act = agentAction(code)
      expect(act.mode, code).not.toBe('none')
      expect(act.label.length, code).toBeGreaterThan(0)
      // The risk label is the only thing on the card that distinguishes
      // "rebuild a derived index" from "delete duplicate lines" before the
      // click; a button without one is worse than no button.
      expect(act.risk.length, code).toBeGreaterThan(2)
    }
  })

  it('carries the core’s own sentence into the card model', () => {
    // The brief is built from this; without it the agent would get only our
    // translation of what the core said.
    const got = healthFindings([{ severity: 'warn', code: 'index-bloat', message: '0.5 MB', hint: 'gc' }])
    expect(got[0].core).toEqual({ message: '0.5 MB', hint: 'gc' })
  })

  it('gives the row-derived fallback no hand-off', () => {
    // Those rows exist because the doctor never ran; asking an agent to work
    // from them would be asking it to work from a guess.
    const rows = healthRows({
      stats: { memories: 1, vectors: 1, pending: 0 },
      indexOk: false,
      conflicts: null,
      recallMode: 'auto',
      agentName: 'dsh',
      agentSource: 'config',
      version: '0.8.0',
    })
    for (const f of rowFindings(rows)) expect(f.agent).toEqual(NO_AGENT)
  })

  it('names a code for the "this repair added a problem" line', () => {
    expect(issueTitle('index-bloat')).toBe('索引库体积过大')
    // Unknown codes keep the raw id: a blank or a guess would be worse.
    expect(issueTitle('some-future-code')).toBe('some-future-code')
  })

  it('reports problems the repair ADDED, not only the ones it removed', () => {
    const body = healthBody() + CONSOLE_CODE
    expect(body).toMatch(/repair\.added/)
    expect(body).toMatch(/dsh-memory-added/)
    expect(STYLES).toMatch(/\.dsh-memory-added\s*\{/)
  })

  it('wires the hand-off in the card, inline and without a dialog', () => {
    const body = healthBody()
    expect(body).toMatch(/repair\.send/)
    expect(body).toMatch(/dsh-memory-finding-actions/)
    expect(body).toMatch(/f\.agent\.risk/)
    // A native confirm() would block the renderer and cannot be styled by the
    // host theme; the confirmation belongs in the card.
    expect(CONSOLE_CODE).not.toMatch(/window\.confirm/)
  })

  it('always sends into a conversation of its own', () => {
    // Reusing whatever session was most recently active put a vault-wide
    // read-and-edit turn in the middle of the user's own thread, and left the
    // agent carrying repair context into unrelated work. The confirm row must
    // promise a fresh one, and the send must carry no target at all.
    const body = healthBody()
    expect(body).toContain('一个新会话')
    expect(body).toMatch(/repair\.send\(f\)/)
    expect(body).not.toMatch(/最近在用|resolveTarget|setTarget/)
  })
})
