/**
 * Tests for citation feedback (batch A): the model echoing a [short-id] from
 * the previous recall block is the only `used` signal, and it must reach the
 * core without ever blocking or failing the turn.
 *
 * @module test/cite-feedback.test
 */
import { describe, it, expect, vi } from 'vitest'
import {
  RECALL_FORM,
  createInjectedMessage,
  extractCitedShortIds,
  makeRecallHandler,
  previousRecallShortIds,
} from '../src/recall.ts'

const PRODUCER = 'dsh-unified-agent-memory'

function userMessage(text: string, extra: Record<string, unknown> = {}) {
  return { role: 'user', content: [{ type: 'text', text }], ...extra }
}

describe('extractCitedShortIds', () => {
  it('finds ids and deduplicates', () => {
    const text = 'per [a1b2c3d4e5] and also [a1b2c3d4e5] plus [0123456789]'
    expect(extractCitedShortIds(text)).toEqual(['a1b2c3d4e5', '0123456789'])
  })

  it('ignores non-id brackets', () => {
    expect(extractCitedShortIds('see [1] and [note] and []')).toEqual([])
  })
})

describe('previousRecallShortIds', () => {
  it('reads only the NEWEST recall block', () => {
    const older = createInjectedMessage(RECALL_FORM, '- [1111111111] old fact', PRODUCER)
    const newer = createInjectedMessage(RECALL_FORM, '- [2222222222] new fact', PRODUCER)
    const messages = [userMessage('hi'), older, userMessage('mid'), newer]
    expect(previousRecallShortIds(messages)).toEqual(['2222222222'])
  })

  it('returns empty without a recall block', () => {
    expect(previousRecallShortIds([userMessage('hello')])).toEqual([])
    expect(previousRecallShortIds(undefined)).toEqual([])
  })
})

describe('makeRecallHandler citation reporting', () => {
  function payload(messages: unknown[]) {
    return { step: 1, messages }
  }

  function handlerCfg() {
    // vaultPath must be set: the hook refuses to run unconfigured, before it
    // ever reaches the citation block.
    return { recall: 'always', vaultPath: 'C:/tmp/vault' } as never
  }

  it('reports citations that appear in the newest user text', async () => {
    const prior = createInjectedMessage(RECALL_FORM, '- [a1b2c3d4e5] staging port fact', PRODUCER)
    const markUsed = vi.fn(async () => undefined)
    const next = vi.fn()
    const handler = makeRecallHandler(
      handlerCfg(),
      {
        search: vi.fn(async () => ''),
        warn: vi.fn(),
        producer: PRODUCER,
        markUsed,
      },
    )
    await handler(payload([prior, userMessage('please check [a1b2c3d4e5] again')]), next)
    expect(markUsed).toHaveBeenCalledWith(['a1b2c3d4e5'])
    expect(next).toHaveBeenCalled()
  })

  it('does not report ids that were never offered', async () => {
    const prior = createInjectedMessage(RECALL_FORM, '- [a1b2c3d4e5] staging port fact', PRODUCER)
    const markUsed = vi.fn(async () => undefined)
    const next = vi.fn()
    const handler = makeRecallHandler(
      handlerCfg(),
      {
        search: vi.fn(async () => ''),
        warn: vi.fn(),
        producer: PRODUCER,
        markUsed,
      },
    )
    await handler(payload([prior, userMessage('check [9999999999] please')]), next)
    expect(markUsed).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it('survives a failing markUsed', async () => {
    const prior = createInjectedMessage(RECALL_FORM, '- [a1b2c3d4e5] fact', PRODUCER)
    const warn = vi.fn()
    const next = vi.fn()
    const handler = makeRecallHandler(
      handlerCfg(),
      {
        search: vi.fn(async () => ''),
        warn,
        producer: PRODUCER,
        markUsed: vi.fn(async () => {
          throw new Error('core down')
        }),
      },
    )
    await handler(payload([prior, userMessage('cite [a1b2c3d4e5]')]), next)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mark-used failed'))
    expect(next).toHaveBeenCalled()
  })
})
