/**
 * Tests for POST /dismiss — the single write path in this plugin.
 *
 * The route is the one place where a request mutates the vault, so it is also
 * the one place where the negative cases carry the weight: a name that escapes
 * the inbox must never reach the core, and a failed move must not be reported
 * as a success. Task 5 taught the cost of leaving a handler's `!r.ok` and catch
 * branches untested — a mutation there kept the suite green — so both are
 * exercised here with `runCore` stubbed out.
 *
 * @module test/route-dismiss.test
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DISMISS_PATH, buildDismissArgs, parseDismissBody, shapeDismissResult,
} from '../src/route-dismiss.ts'

describe('parseDismissBody', () => {
  it('reads the name', () => {
    expect(parseDismissBody('{"name":"a.md"}')).toBe('a.md')
  })
  it('rejects a missing or empty name', () => {
    expect(parseDismissBody('{}')).toBeNull()
    expect(parseDismissBody('{"name":""}')).toBeNull()
    expect(parseDismissBody('not json')).toBeNull()
  })
  it('rejects a non-string name', () => {
    expect(parseDismissBody('{"name":123}')).toBeNull()
  })
  it('rejects traversal before it ever reaches the core', () => {
    expect(parseDismissBody('{"name":"../x"}')).toBeNull()
    expect(parseDismissBody('{"name":"a/b"}')).toBeNull()
    expect(parseDismissBody('{"name":"a\\\\b"}')).toBeNull()
  })
})

describe('buildDismissArgs', () => {
  it('invokes the core dismiss command', () => {
    expect(buildDismissArgs('a.md')).toEqual(['dismiss', '--json', '--', 'a.md'])
  })
  it('puts every flag before the terminator, and the name after it', () => {
    // argparse reads EVERY token after `--` as positional, so a flag placed
    // after the terminator stops being a flag and becomes a stray positional:
    // `dismiss -- <name> --json` exits 2 with an empty stdout and the whole
    // write path silently refuses legal names. Pin the invariant directly —
    // this is the shape rule test/route-dismiss-integration.test.ts enforces
    // against the real parser.
    const argv = buildDismissArgs('x.md')
    const cut = argv.indexOf('--')
    expect(cut).toBeGreaterThan(-1)
    expect(argv.slice(0, cut).some((t) => t.startsWith('-'))).toBe(true)
    expect(argv.slice(cut + 1).some((t) => t.startsWith('-'))).toBe(false)
    expect(argv[cut + 1]).toBe('x.md')
  })
  it('terminates options so a flag-shaped name stays a name', () => {
    // `dismiss --json extra` would let argparse eat `--json` as a flag and slide
    // the next token into the `name` position, moving an entry the caller never
    // named. `isSafeName` refuses that shape, but the terminator makes the argv
    // safe by construction.
    expect(buildDismissArgs('x.md')).toContain('--')
    expect(buildDismissArgs('-x')).toEqual(['dismiss', '--json', '--', '-x'])
  })
})

describe('shapeDismissResult', () => {
  it('reports success', () => {
    const raw = JSON.stringify({ ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } })
    const got = shapeDismissResult(raw)
    expect(got.ok).toBe(true)
    expect(got.reason).toBeNull()
  })
  it('surfaces the reason on refusal', () => {
    // The core sets the OUTER `ok` from the same `result["ok"]` it puts inside
    // `data` (core/unified_memory/memory.py: `{"ok": result["ok"], ...}`), so a
    // business refusal — not-found / outside-inbox / io-error:* — carries
    // `ok:false` at BOTH levels. Feeding `ok:true` here (as this test used to)
    // is a fake that matches nothing the core emits, and it hid the bug below.
    const raw = JSON.stringify({ ok: true, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'not-found' } })
    expect(shapeDismissResult(raw).reason).toBe('not-found')
  })

  it('surfaces the reason when the core refusal also sets the outer ok false (real shape)', () => {
    // Verbatim from the real core against a temp vault:
    //   dismiss --json -- ghost.md
    //   {"ok": false, "command": "dismiss", "data": {"ok": false,
    //    "name": "ghost.md", "movedTo": null, "reason": "not-found"}}
    // An outer-`ok` precondition would flatten this to 'unavailable', erasing
    // the Task 1/2 failure taxonomy: the panel could no longer tell "the entry
    // was already moved" from "the core is down".
    const raw = JSON.stringify({ ok: false, command: 'dismiss',
      data: { ok: false, name: 'ghost.md', movedTo: null, reason: 'not-found' } })
    const got = shapeDismissResult(raw)
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('not-found')
    expect(got.name).toBe('ghost.md')
    expect(got.reason).not.toBe('unavailable')
  })

  it('passes through an outside-inbox refusal from the real shape', () => {
    const raw = JSON.stringify({ ok: false, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'outside-inbox' } })
    expect(shapeDismissResult(raw).reason).toBe('outside-inbox')
  })

  it('degrades to unavailable only when the envelope itself is broken', () => {
    // `data` missing is a genuinely malformed/non-JSON envelope — the one case
    // that is NOT a business refusal and must stay labelled `unavailable`.
    expect(shapeDismissResult('x').ok).toBe(false)
    expect(shapeDismissResult('x').reason).toBe('unavailable')
    expect(shapeDismissResult('{"ok":false,"command":"dismiss"}').reason).toBe('unavailable')
    expect(shapeDismissResult('{"ok":true}').reason).toBe('unavailable')
  })
})

describe('DISMISS_PATH', () => {
  it('is namespaced', () => {
    expect(DISMISS_PATH.startsWith('/api/dsh-unified-agent-memory/')).toBe(true)
  })
})

// ── Host-side name whitelist ────────────────────────────────────────
// Core repeats this rule, but validation belongs here too: a name that can
// escape the inbox must be refused with a 400, not handed to a spawned process.

describe('parseDismissBody name whitelist', () => {
  it.each([
    ['{"name":"~x"}', 'tilde-prefixed'],
    ['{"name":"a:b"}', 'colon (drive/ADS syntax)'],
    ['{"name":"a\\u0000b"}', 'NUL byte'],
    ['{"name":"."}', 'dot'],
    ['{"name":".."}', 'dot-dot'],
    ['{"name":"--json"}', 'dash-prefixed (argparse would read it as a flag)'],
    ['{"name":"-x"}', 'single-dash-prefixed'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseDismissBody(raw)).toBeNull()
  })

  it('accepts an ordinary inbox filename', () => {
    expect(parseDismissBody('{"name":"dsh-2026-09-22-001.md"}')).toBe('dsh-2026-09-22-001.md')
  })

  it('accepts an interior dash, which is not flag-shaped', () => {
    expect(parseDismissBody('{"name":"dsh-2026-09-22-001.md"}')).toBe('dsh-2026-09-22-001.md')
  })
})

// ── handleDismiss: the two branches Task 5 showed can rot ───────────

vi.mock('../src/utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils.ts')>()),
  runCore: vi.fn(),
}))

import { handleDismiss } from '../src/route-dismiss.ts'
import { runCore } from '../src/utils.ts'

const cfg = { vaultPath: 'C:/tmp/vault' } as never

describe('handleDismiss', () => {
  it('passes a successful move straight through', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: true, command: 'dismiss',
      data: { ok: true, name: 'a.md', movedTo: '已处理/a.md', reason: null } }) })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(true)
    expect(got.name).toBe('a.md')
  })

  it('degrades to unavailable when the core call itself fails (!r.ok)', async () => {
    // The mutation Task 5's reviewer used: flipping this branch to report
    // success kept the old suite green because nothing observed it.
    // `kind` is carried through so this models genuine unavailability (a
    // timeout) rather than an empty-stdout argparse rejection, which the next
    // test pins to `invalid-name`.
    vi.mocked(runCore).mockResolvedValue({
      ok: false, output: '', kind: 'timeout', error: 'timed out',
    })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('unavailable')
  })

  it('blames the name, not the core, when argparse rejected the argv', async () => {
    // argparse exits 2 with EMPTY stdout — no JSON envelope ever reaches us —
    // and runCore reports it as a plain crash. Reporting 'unavailable' here
    // tells an operator the core is down when in fact the caller handed us a
    // flag-shaped name; that is a wild goose chase over a request error.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'crash' })
    const got = await handleDismiss(cfg, '--json')
    expect(got.reason).toBe('invalid-name')
  })

  it('still says unavailable for a timeout even though stdout is empty', async () => {
    // The `kind` guard: a killed process also prints nothing, and calling that
    // an invalid name would invert the same diagnostic mistake.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'timeout' })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.reason).toBe('unavailable')
  })

  it('degrades to unavailable when the core call throws', async () => {
    vi.mocked(runCore).mockRejectedValue(new Error('spawn ENOENT'))
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('unavailable')
  })

  it('reports a refused move as not-ok with the reason from the core', async () => {
    // Real core shape: a refusal sets the outer `ok` false too, because the
    // core mirrors `result["ok"]` into the envelope. The old fake here carried
    // `ok:true` and so exercised a shape the core never emits.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: false, command: 'dismiss',
      data: { ok: false, name: 'a.md', movedTo: null, reason: 'outside-inbox' } }) })
    const got = await handleDismiss(cfg, 'a.md')
    expect(got.ok).toBe(false)
    expect(got.reason).toBe('outside-inbox')
  })

  it('keeps a business refusal distinct from a core outage', async () => {
    // The whole point of the fix: 'the vault had nothing to move' and 'the core
    // is broken' must not collapse into one label. Same `!r.ok`-ish call site,
    // two different reasons.
    vi.mocked(runCore).mockResolvedValue({ ok: true, output: JSON.stringify({
      ok: false, command: 'dismiss',
      data: { ok: false, name: 'ghost.md', movedTo: null, reason: 'not-found' } }) })
    const refused = await handleDismiss(cfg, 'ghost.md')

    vi.mocked(runCore).mockResolvedValue({
      ok: false, output: '', kind: 'missing', error: 'python not found',
    })
    const outage = await handleDismiss(cfg, 'ghost.md')

    expect(refused.reason).toBe('not-found')
    expect(outage.reason).toBe('unavailable')
    expect(refused.reason).not.toBe(outage.reason)
  })
})
