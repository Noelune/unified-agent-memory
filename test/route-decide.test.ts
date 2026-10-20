/**
 * Tests for POST /decide — ruling on one queued conflict.
 *
 * The route has the same shape discipline as `/dismiss` and `/accept`, plus one
 * rule of its own that carries the design weight: `跳过` is refused here even
 * though the CLI accepts it. Skipping records the decision and dequeues the
 * entry, and the core then suppresses that fact forever — so a client that
 * could send "skip" would permanently silence a question the user declined to
 * answer. That refusal is pinned as a positive assertion, not left to the
 * absence of a button.
 *
 * @module test/route-decide.test
 */

import { describe, expect, it, vi } from 'vitest'

import {
  DECIDE_CHOICES,
  DECIDE_PATH,
  buildDecideArgs,
  handleDecide,
  parseDecideBody,
  shapeDecideResult,
} from '../src/route-decide.ts'
import type { PluginConfig } from '../src/types.ts'

// `runCore` spawns a Python process; every test in this file is about what the
// host does with an answer, so only the process boundary is stubbed.
vi.mock('../src/utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils.ts')>()),
  runCore: vi.fn(),
}))

import { runCore } from '../src/utils.ts'

const cfg: PluginConfig = { vaultPath: 'C:/tmp/vault', pythonPath: 'python', remoteEnabled: false }

describe('DECIDE_PATH', () => {
  it('is the documented endpoint', () => {
    expect(DECIDE_PATH).toBe('/api/dsh-unified-agent-memory/decide')
  })
})

describe('parseDecideBody', () => {
  it('reads a key and a choice', () => {
    expect(parseDecideBody('{"key":"20261019030125-1","choice":"用新"}'))
      .toEqual({ key: '20261019030125-1', choice: '用新' })
  })

  it('accepts the three verdicts and refuses 跳过', () => {
    for (const choice of DECIDE_CHOICES) {
      expect(parseDecideBody(JSON.stringify({ key: 'k1', choice }))).not.toBeNull()
    }
    // 跳过 dequeues the entry and suppresses the fact forever. It exists for a
    // terminal prompt where a human is deciding to wait; it must never be
    // something a browser button can send.
    expect(parseDecideBody('{"key":"k1","choice":"跳过"}')).toBeNull()
  })

  it('refuses an unknown or non-string choice', () => {
    expect(parseDecideBody('{"key":"k1","choice":"用旧的"}')).toBeNull()
    expect(parseDecideBody('{"key":"k1","choice":1}')).toBeNull()
    expect(parseDecideBody('{"key":"k1"}')).toBeNull()
  })

  it('refuses a key that could become a flag', () => {
    // The key is forwarded as argv. `--json` in the key position would be eaten
    // by argparse and slide the choice into the key slot.
    expect(parseDecideBody('{"key":"--json","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"-k","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"~k","choice":"用新"}')).toBeNull()
  })

  it('refuses a path-shaped or empty key before spawning a process', () => {
    expect(parseDecideBody('{"key":"../etc/passwd","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"a/b","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"a b","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"","choice":"用新"}')).toBeNull()
    expect(parseDecideBody('{"key":"x".repeat(200),"choice":"用新"}')).toBeNull()
  })

  it('returns null for a body that is not JSON', () => {
    expect(parseDecideBody('not json')).toBeNull()
    expect(parseDecideBody('[]')).toBeNull()
  })
})

describe('buildDecideArgs', () => {
  it('invokes the core decide command', () => {
    expect(buildDecideArgs('k1', '用新')).toEqual(['decide', '--json', '--', 'k1', '用新'])
  })

  it('puts every flag before the terminator, and both positionals after it', () => {
    // Same trap as dismiss: argparse reads EVERY token after `--` as
    // positional, so `decide -- k1 用新 --json` makes `--json` a third
    // positional and exits 2 with empty stdout. The integration test proves
    // this against the real parser; this pins the shape it depends on.
    const argv = buildDecideArgs('k1', '并存')
    const cut = argv.indexOf('--')

    expect(cut).toBeGreaterThan(-1)
    expect(argv.slice(0, cut).some((t) => t.startsWith('-'))).toBe(true)
    expect(argv.slice(cut + 1).some((t) => t.startsWith('-'))).toBe(false)
    expect(argv.slice(cut + 1)).toEqual(['k1', '并存'])
  })
})

describe('shapeDecideResult', () => {
  it('reads a success and keeps the note it wrote to', () => {
    const raw = JSON.stringify({
      ok: true,
      command: 'decide',
      data: { ok: true, key: 'k1', choice: '用新', reason: null, applied: true, target: 'a.md' },
    })

    expect(shapeDecideResult(raw)).toEqual({
      ok: true, key: 'k1', choice: '用新', reason: null, applied: true, target: 'a.md',
    })
  })

  it('reads a refusal instead of walking away from it', () => {
    // The core copies data.ok into the outer ok, so a refusal arrives with
    // ok:false at BOTH levels. Gating on the outer key would flatten every
    // business answer into "unavailable" — the reason is the answer.
    const raw = JSON.stringify({
      ok: false,
      command: 'decide',
      data: { ok: false, key: 'k1', choice: '用新', reason: 'not-found', applied: false, target: null },
    })

    const got = shapeDecideResult(raw)

    expect(got.ok).toBe(false)
    expect(got.reason).toBe('not-found')
  })

  it('degrades malformed output to unavailable', () => {
    expect(shapeDecideResult('').reason).toBe('unavailable')
    expect(shapeDecideResult('{"ok":true}').reason).toBe('unavailable')
    expect(shapeDecideResult('not json').reason).toBe('unavailable')
  })

  it('never reports applied for a refusal', () => {
    const raw = JSON.stringify({ data: { ok: false, reason: 'unknown-choice', applied: 'yes' } })

    expect(shapeDecideResult(raw).applied).toBe(false)
  })
})

describe('handleDecide transport failures', () => {
  it('reports a bare crash with no stdout as invalid-key', async () => {
    // Exit 2 + empty stdout is argparse refusing the argv — here that means the
    // key, not the interpreter. Same split as `handleDismiss`.
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'crash' } as never)

    const got = await handleDecide(cfg, 'k1', '用新')

    expect(got.ok).toBe(false)
    expect(got.reason).toBe('invalid-key')
  })

  it('reports a missing interpreter as unavailable, not as a bad key', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'missing' } as never)

    const got = await handleDecide(cfg, 'k1', '用新')

    expect(got.reason).toBe('unavailable')
  })

  it('reports a hung core as unavailable', async () => {
    vi.mocked(runCore).mockResolvedValue({ ok: false, output: '', kind: 'timeout' } as never)

    expect((await handleDecide(cfg, 'k1', '用新')).reason).toBe('unavailable')
  })

  it('never throws when the runner rejects', async () => {
    vi.mocked(runCore).mockRejectedValue(new Error('spawn ENOENT'))

    await expect(handleDecide(cfg, 'k1', '用新')).resolves.toEqual({
      ok: false, key: 'k1', choice: '用新', reason: 'unavailable', applied: false, target: null,
    })
  })

  it('carries the success envelope through untouched', async () => {
    vi.mocked(runCore).mockResolvedValue({
      ok: true,
      output: JSON.stringify({
        ok: true,
        command: 'decide',
        data: { ok: true, key: 'k1', choice: '并存', reason: null, applied: true, target: 'x.md' },
      }),
    } as never)

    const got = await handleDecide(cfg, 'k1', '并存')

    expect(got.ok).toBe(true)
    expect(got.target).toBe('x.md')
  })
})
