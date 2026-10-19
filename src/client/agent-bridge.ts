/**
 * agent-bridge — hand a repair brief to the agent, from a frame-level panel.
 *
 * The console lives in `shell.overlay`, which the layout declares with
 * `scope: "root"`. Two consequences decide this whole module:
 *
 *  1. `ctx.conversation.send()` cannot be used here. The conversation service
 *     resolves its target through `sessions.scopeOf(ctx)`, which reads a private
 *     Symbol that only session-scoped contexts carry, and throws
 *     `conversation.send requires a session scope` on a root context. The
 *     documented way around it is `ctx.sessions.scope(id).conversation` — which
 *     still needs an id, and needs the scope to exist first.
 *  2. Therefore the bridge addresses a session explicitly: pick the most
 *     recently used conversation (or create one), `retain()` it so the scope is
 *     materialized and its binding is live, then `prompt()` on the binding.
 *
 * `retain()` is also what makes "is the agent still working?" observable later:
 * the session's summary row carries `running`, and `sessions.list` is a snapshot
 * store, so progress costs a memory read instead of a `doctor` run.
 *
 * Every step is optional at the type level and guarded at runtime. A host
 * without the sessions service, an older client, a create that the workspace
 * refuses — all of them return `ok:false` with a reason and leave the caller
 * free to fall back to "copy the brief". Nothing here throws at the call site.
 *
 * @module src/client/agent-bridge
 */

/** The part of a session summary this module reads. */
export interface SessionRow {
  id: string
  displayTitle?: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  parentId?: string
  origin?: string
}

/** The part of `sessions.list` this module reads. */
export interface SessionListLike {
  getSnapshot?: () => { ids?: readonly string[]; byId?: Record<string, SessionRow> } | undefined
}

/** A session face that can accept a turn. */
interface PromptableSession {
  prompt?: (
    content: ReadonlyArray<{ type: 'text'; text: string }>,
    mode: 'queue' | 'steer',
  ) => Promise<{ ok?: boolean; error?: { code?: string; message?: string } } | undefined>
}

/** A retained reference (`sessions.retain`). Only the used fields are typed. */
interface RetainedLike {
  ready?: Promise<unknown>
  binding?: { session?: PromptableSession }
  release?: () => void
}

/**
 * The sessions service, structurally.
 *
 * Deliberately not imported from the host package: the client bundle must load
 * in hosts that predate this service, and a value import would drag the whole
 * controller in. Structural typing also lets tests pass a plain object.
 */
export interface SessionsLike {
  list?: SessionListLike
  create?: (opts?: { cwd?: string; workspaceId?: string; sessionId?: string }) => Promise<string>
  retain?: (id: string, opts: { source: string; signal?: AbortSignal }) => RetainedLike
  scope?: (id: string) => { conversation?: { send?: (text: string) => Promise<unknown> } } | undefined
}

/** Attribution recorded on the retained reference; shows up in the host log. */
export const BRIDGE_SOURCE = 'dsh-unified-agent-memory'

/** Where a hand-off should go. `id === null` means "make a new session". */
export interface BridgeTarget {
  id: string | null
  /** Human label for the confirm row. */
  label: string
}

/** The outcome. `reason` is a short, already-human-readable string. */
export interface BridgeResult {
  ok: boolean
  sessionId: string | null
  reason?: string
}

/** Set once by `apply()`; the panel renders before any hook could read props. */
let bridgeCtx: unknown = null

/**
 * Remember the plugin context so the panel can reach host services later.
 *
 * Stored rather than threaded through props because slot occupants are rendered
 * by the shell with no arguments — there is no prop path from `apply()` to
 * `MemorySheet`.
 */
export function setBridgeContext(ctx: unknown): void {
  bridgeCtx = ctx
}

/** Drop the reference on dispose, so a reload cannot post into a dead context. */
export function clearBridgeContext(): void {
  bridgeCtx = null
}

/**
 * Read the sessions service, or null.
 *
 * `ctx.get` is used instead of adding `sessions` to the plugin's `inject` list:
 * that list is a hard dependency, and a missing service there fails the whole
 * client module with `invalid plugin, expect function or object with an "apply"
 * method` — a panel that refuses to load is worse than one without a button.
 */
export function sessionsOf(ctx: unknown = bridgeCtx): SessionsLike | null {
  if (!ctx) return null
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return null
    const sessions = get.call(ctx, 'sessions')
    if (!sessions || typeof sessions !== 'object') return null
    return sessions as SessionsLike
  } catch {
    return null
  }
}

/**
 * The conversation a hand-off should join.
 *
 * Most recently updated wins, which in practice is the one on screen: any turn,
 * steer, or rename bumps `updatedAt`. Subagent rows are excluded — they are not
 * conversations a person types into. Returns null when there is nothing to
 * reuse, which the caller reads as "create one".
 */
export function pickTarget(sessions: SessionsLike | null): BridgeTarget | null {
  const snapshot = sessions?.list?.getSnapshot?.()
  const byId = snapshot?.byId
  if (!byId) return null
  let best: SessionRow | null = null
  for (const id of Object.keys(byId)) {
    const row = byId[id]
    if (!row || row.id === undefined) continue
    if (row.parentId !== undefined || row.origin === 'subagent') continue
    if (best === null || (row.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = row
  }
  if (best === null) return null
  return { id: best.id, label: best.displayTitle || best.id }
}

/** What an in-flight hand-off looks like to the watcher. */
export function runningOf(sessions: SessionsLike | null, id: string | null): boolean | null {
  if (id === null) return null
  const snapshot = sessions?.list?.getSnapshot?.()
  const row = snapshot?.byId?.[id]
  if (!row) return null
  return row.running === true
}

/**
 * Send one brief to one session.
 *
 * The three attempts are ordered from the most supported to the least:
 * `retain().binding.session.prompt()` is what the host's own conversation
 * service uses; `scope(id).conversation.send()` is the fallback the host's error
 * message points at; anything else is a host that cannot be driven from here.
 */
export async function sendBrief(
  sessions: SessionsLike | null,
  text: string,
  target: BridgeTarget,
): Promise<BridgeResult> {
  if (sessions === null) return { ok: false, sessionId: null, reason: '这个宿主没有会话服务' }

  let sessionId = target.id
  if (sessionId === null) {
    if (typeof sessions.create !== 'function') {
      return { ok: false, sessionId: null, reason: '没有可复用的会话，也不能新建' }
    }
    try {
      sessionId = await sessions.create({})
    } catch (error) {
      return { ok: false, sessionId: null, reason: '新建会话失败：' + errorText(error) }
    }
  }

  const content = [{ type: 'text' as const, text }]

  if (typeof sessions.retain === 'function') {
    let reference: RetainedLike | null = null
    try {
      reference = sessions.retain(sessionId, { source: BRIDGE_SOURCE })
      if (reference.ready) await reference.ready
      const prompt = reference.binding?.session?.prompt
      if (typeof prompt === 'function') {
        const result = await prompt.call(reference.binding?.session, content, 'queue')
        if (result === undefined || result.ok !== false) return { ok: true, sessionId }
        return {
          ok: false,
          sessionId,
          reason: '会话拒收：' + (result.error?.code ?? '未知错误'),
        }
      }
    } catch (error) {
      // Fall through: a retained scope that never opened is still addressable
      // through the conversation service, and that path reports its own error.
      const reason = errorText(error)
      const viaConversation = await sendViaConversation(sessions, sessionId, text)
      return viaConversation ?? { ok: false, sessionId, reason: '会话打不开：' + reason }
    } finally {
      try { reference?.release?.() } catch { /* release after a failed open is not actionable */ }
    }
  }

  const viaConversation = await sendViaConversation(sessions, sessionId, text)
  return viaConversation ?? { ok: false, sessionId, reason: '没有可用的发送通道' }
}

/** The documented alternative: address the scope, then use its conversation. */
async function sendViaConversation(
  sessions: SessionsLike,
  sessionId: string,
  text: string,
): Promise<BridgeResult | null> {
  if (typeof sessions.scope !== 'function') return null
  let send: ((text: string) => Promise<unknown>) | undefined
  try {
    send = sessions.scope(sessionId)?.conversation?.send
  } catch {
    return null
  }
  if (typeof send !== 'function') return null
  try {
    await send.call(sessions.scope(sessionId)?.conversation, text)
    return { ok: true, sessionId }
  } catch (error) {
    return { ok: false, sessionId, reason: '发送失败：' + errorText(error) }
  }
}

/** Error text for the card, without leaking a stack into a 380px panel. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
