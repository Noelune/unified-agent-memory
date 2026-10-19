/**
 * Reaching a conversation from a frame-level panel.
 *
 * The console is registered in `shell.overlay`, whose layout scope is `root`,
 * so `ctx.conversation.send()` throws there by design. Everything in
 * `agent-bridge.ts` exists to address a session explicitly instead, and the
 * paths it takes are host contracts, not our invention — which is exactly why
 * they need tests: a host that renames `binding.session` would otherwise fail
 * at the one moment the user asked for help.
 *
 * Each failure path is asserted to return `ok:false` with a reason rather than
 * throw: the card renders "复制任务包" from that, and a rejected promise would
 * leave the pane stuck on "正在发送…" forever.
 *
 * @module test/client-agent-bridge.test
 */

import { describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_SOURCE,
  clearBridgeContext,
  runningOf,
  sendBrief,
  sessionsOf,
  setBridgeContext,
} from '../src/client/agent-bridge.ts'
import type { SessionsLike } from '../src/client/agent-bridge.ts'

/** A sessions service whose prompt succeeds. */
function workingSessions(): SessionsLike & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn()
  return {
    release,
    list: {
      getSnapshot: () => ({
        ids: ['a'],
        byId: { a: { id: 'a', displayTitle: '修复记忆索引', updatedAt: 5 } },
      }),
    },
    create: async () => 'new-id',
    retain: () => ({
      ready: Promise.resolve(undefined),
      binding: { session: { prompt: async () => ({ ok: true }) } },
      release,
    }),
  }
}

describe('sessionsOf', () => {
  it('reads the service off the stored context', () => {
    const sessions = workingSessions()
    const ctx = { get: (name: string) => (name === 'sessions' ? sessions : undefined) }
    expect(sessionsOf(ctx)).toBe(sessions)
  })

  it('returns null on a host without the service', () => {
    expect(sessionsOf({})).toBeNull()
    expect(sessionsOf(null)).toBeNull()
    expect(sessionsOf({ get: () => undefined })).toBeNull()
  })

  it('returns null instead of throwing when the service lookup fails', () => {
    // Cordis can throw for an undeclared service. A panel that crashes on
    // render is worse than one that renders without a button.
    const ctx = { get: () => { throw new Error('not declared') } }
    expect(sessionsOf(ctx)).toBeNull()
  })

  it('uses the context stored by apply() when called without one', () => {
    const sessions = workingSessions()
    setBridgeContext({ get: () => sessions })
    expect(sessionsOf()).toBe(sessions)
    clearBridgeContext()
    expect(sessionsOf()).toBeNull()
  })
})

describe('runningOf', () => {
  const sessions: SessionsLike = {
    list: { getSnapshot: () => ({ byId: { a: { id: 'a', running: true }, b: { id: 'b', running: false } } }) },
  }

  it('reports the session’s own flag', () => {
    expect(runningOf(sessions, 'a')).toBe(true)
    expect(runningOf(sessions, 'b')).toBe(false)
  })

  it('reports null — not false — when the row is gone or unknown', () => {
    // "No row" must not read as "finished": that would trigger a verify
    // against a session we never reached.
    expect(runningOf(sessions, 'zzz')).toBeNull()
    expect(runningOf(sessions, null)).toBeNull()
    expect(runningOf(null, 'a')).toBeNull()
  })
})

describe('sendBrief', () => {
  it('retains the target, prompts it in queue mode, then releases', async () => {
    const prompt = vi.fn(async () => ({ ok: true }))
    const release = vi.fn()
    const sessions: SessionsLike = {
      retain: () => ({ ready: Promise.resolve(undefined), binding: { session: { prompt } }, release }),
    }
    const result = await sendBrief(sessions, 'brief', 's1')
    expect(result).toEqual({ ok: true, sessionId: 's1' })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][1]).toBe('queue')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('creates a session for every hand-off', async () => {
    const seen: string[] = []
    const sessions: SessionsLike = {
      create: async () => { seen.push('create'); return 'made' },
      retain: (id) => {
        seen.push('retain:' + id)
        return { ready: Promise.resolve(undefined), binding: { session: { prompt: async () => ({ ok: true }) } } }
      },
    }
    const result = await sendBrief(sessions, 'brief', null)
    expect(result).toEqual({ ok: true, sessionId: 'made' })
    expect(seen).toEqual(['create', 'retain:made'])
  })

  it('never reads the session list to decide where the brief goes', async () => {
    // The list is how the brief used to land in the user's own thread. Send a
    // service whose list throws: a hand-off that still succeeds proves the
    // bridge never asks which conversation is "current".
    const sessions: SessionsLike = {
      list: { getSnapshot: () => { throw new Error('should not be read') } },
      create: async () => 'made',
      retain: () => ({
        ready: Promise.resolve(undefined),
        binding: { session: { prompt: async () => ({ ok: true }) } },
      }),
    }
    const result = await sendBrief(sessions, 'brief', null)
    expect(result).toEqual({ ok: true, sessionId: 'made' })
  })

  it('surfaces a refused prompt as a reason, not an exception', async () => {
    const sessions: SessionsLike = {
      retain: () => ({
        ready: Promise.resolve(undefined),
        binding: { session: { prompt: async () => ({ ok: false, error: { code: 'session/queue-full' } }) } },
        release: () => {},
      }),
    }
    const result = await sendBrief(sessions, 'brief', 's1')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('session/queue-full')
  })

  it('falls back to the scope’s conversation when retain cannot open', async () => {
    // The host's own error message points at this path; it must work.
    const send = vi.fn(async () => undefined)
    const sessions: SessionsLike = {
      retain: () => { throw new Error('scope unavailable') },
      scope: () => ({ conversation: { send } }),
    }
    const result = await sendBrief(sessions, 'brief', 's1')
    expect(result).toEqual({ ok: true, sessionId: 's1' })
    expect(send).toHaveBeenCalledWith('brief')
  })

  it('reports a failed create instead of pretending it has a session', async () => {
    const sessions: SessionsLike = {
      create: async () => { throw new Error('workspace/not-found') },
    }
    const result = await sendBrief(sessions, 'brief', null)
    expect(result.ok).toBe(false)
    expect(result.sessionId).toBeNull()
    expect(result.reason).toContain('workspace/not-found')
  })

  it('reports a host with no sessions service', async () => {
    const result = await sendBrief(null, 'brief', 's1')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有会话服务')
  })

  it('reports a host that can neither create nor prompt', async () => {
    const result = await sendBrief({}, 'brief', null)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不能新建')
  })

  it('attributes the retained reference to this plugin', async () => {
    // The host logs retention sources; an anonymous retain would be a leak we
    // cannot trace back to the panel.
    const retain = vi.fn(() => ({
      ready: Promise.resolve(undefined),
      binding: { session: { prompt: async () => ({ ok: true }) } },
    }))
    await sendBrief({ retain } as SessionsLike, 'brief', 's1')
    expect(retain).toHaveBeenCalledWith('s1', { source: BRIDGE_SOURCE })
  })
})
