/**
 * dsh-unified-agent-memory — shared client state.
 *
 * The trigger (registered in `sidebar.footer.action`) and the sheet (registered
 * in `shell.overlay`) are two independent Slot occupants, so they cannot share
 * React state through a common parent. This tiny module-level store bridges
 * them: it owns the poll loop and the open/closed flag, and both occupants
 * subscribe with `useSyncExternalStore`-style semantics implemented on top of
 * `useState` + `useEffect` (React 18 is not guaranteed in the client runtime,
 * so the hook is hand-rolled from the APIs `deps.ts` already exposes).
 *
 * @module src/client/store
 */

import { useCallback, useEffect, useRef, useState } from '../deps.ts'
import { buildRepairPrompt } from '../repair-prompt.ts'
import type { RepairEnv } from '../repair-prompt.ts'
import { runningOf, sendBrief, sessionsOf } from './agent-bridge.ts'
import type { HealthFinding } from './view.ts'
import type {
  DoctorCounts, DoctorIssue, DoctorPayload,
  PreviewData, PreviewView, SearchHit, StatsData, StatsPayload, StatusPayload,
} from './types.ts'

export const STATUS_URL = '/api/dsh-unified-agent-memory/status'
export const POLL_INTERVAL_MS = 10000

export const BASE_URL = '/api/dsh-unified-agent-memory'
export const SEARCH_URL = `${BASE_URL}/search`
export const PREVIEW_URL = `${BASE_URL}/preview`
export const NOTE_URL = `${BASE_URL}/note`
/** One canonical note's body, by file name — the search pane's open action. */
export const DOC_URL = `${BASE_URL}/doc`
export const DISMISS_URL = `${BASE_URL}/dismiss`
export const ACCEPT_URL = `${BASE_URL}/accept`
export const DECIDE_URL = `${BASE_URL}/decide`
export const STATS_URL = `${BASE_URL}/stats`
/** The core's own issue list — the health pane's "what do I do about it". */
export const DOCTOR_URL = `${BASE_URL}/doctor`

/**
 * Default cap on a preview list, matching the host route.
 *
 * MUST stay equal to `PREVIEW_LIMIT` in `src/route-preview.ts`. This file is
 * bundled for the browser (React arrives via `../deps.ts`) and the route is
 * host-side Node ESM, so they cannot share the constant and it is duplicated by
 * necessity. Drift means the console asks for one page size and the route
 * serves another, silently. Change both, or neither.
 */
export const PREVIEW_LIMIT = 20

export interface MemoryState {
  /** Latest payload, or null before the first successful poll. */
  data: StatusPayload | null
  /** True when the last poll failed (route unreachable). */
  fetchError: boolean
}

let state: MemoryState = { data: null, fetchError: false }
let open = false
let pollers = 0
let timer: number | null = null
let abort: AbortController | null = null
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach(function (fn) { fn() })
}

function setState(next: MemoryState): void {
  state = next
  emit()
}

/** Begin polling; returns the disposer that stops it once the last reader leaves. */
function startPolling(): () => void {
  pollers += 1
  if (pollers === 1) {
    abort = new AbortController()
    const tick = function (): void {
      window
        .fetch(STATUS_URL, { signal: abort!.signal, cache: 'no-store' })
        .then(function (r: Response) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json() as Promise<StatusPayload>
        })
        .then(function (d) { setState({ data: d, fetchError: false }) })
        .catch(function (err: Error) {
          if (err.name === 'AbortError') return
          setState({ data: state.data, fetchError: true })
        })
      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  }
  return function () {
    pollers -= 1
    if (pollers > 0) return
    if (timer !== null) { window.clearTimeout(timer); timer = null }
    if (abort) { abort.abort(); abort = null }
  }
}

/** Subscribe to store changes; returns the unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return function () { listeners.delete(fn) }
}

export function isOpen(): boolean { return open }

export function setOpen(next: boolean): void {
  if (open === next) return
  open = next
  emit()
}

export function toggleOpen(): void { setOpen(!open) }

export function current(): MemoryState { return state }

/**
 * Read the shared state from a Slot occupant.
 *
 * Polling is reference-counted: the first subscriber starts it, the last
 * unmount stops it, so the rail and the wide sidebar can both mount without
 * hitting the route twice.
 */
export function useMemoryState(): MemoryState {
  const [snap, setSnap] = useState<MemoryState>(current)
  useEffect(function () {
    const unsub = subscribe(function () { setSnap(current()) })
    const stop = startPolling()
    setSnap(current())
    return function () { unsub(); stop() }
  }, [])
  return snap
}

/** Read the shared open/closed flag. */
export function useMemoryOpen(): boolean {
  const [snap, setSnap] = useState<boolean>(isOpen)
  useEffect(function () {
    const unsub = subscribe(function () { setSnap(isOpen()) })
    setSnap(isOpen())
    return unsub
  }, [])
  return snap
}

// ── Search ─────────────────────────────────────────────────────────

/**
 * Run a search.
 *
 * **Rejects on failure; resolves only with a real answer.** This is the whole
 * point of the function: a search that could not run and a search that found
 * nothing are different facts, and the panel renders them as different things
 * ("检查没跑起来" vs "没有匹配的记忆"). The earlier version resolved to `[]` on
 * every failure, which made the caller's `.catch` dead code — `useSearchRun`
 * sets `error` there, so `error` could never become true and a dead core was
 * indistinguishable from an empty vault. That is a lie the user cannot detect.
 *
 * A transport success is NOT a business success: the host answers 200 with
 * `{ok:false}` when the core is unavailable, so the body gate rejects too.
 */
export async function runSearch(query: string, hybrid: boolean): Promise<SearchHit[]> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}${hybrid ? '&hybrid=1' : ''}`
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`search: HTTP ${r.status}`)
  const body = (await r.json()) as { ok?: boolean; results?: SearchHit[] }
  if (body.ok !== true || !Array.isArray(body.results)) {
    throw new Error('search: core unavailable')
  }
  return body.results
}

/** A monotonic request counter; the newest token wins. */
export interface SearchSeq { current: number }

/** Claim the next token. Mirrors `++seq.current` inside the hook's `run`. */
export function nextSeq(seq: SearchSeq): number {
  seq.current += 1
  return seq.current
}

/** True when `mine` has not been superseded by a newer `run`. */
export function isCurrentSearch(seq: SearchSeq, mine: number): boolean {
  return mine === seq.current
}

/**
 * Race harness for the search guard.
 *
 * This is the ONE place the sequence guard lives. `useSearch.run` calls it
 * rather than re-implementing the check, so there is a single implementation to
 * test — a mutation here is a mutation in production, not in a test-only copy.
 *
 * Every query goes out immediately (`fire`, never awaited — exactly like the
 * hook, which does not await `runSearch` either), and a settling response is
 * dropped unless its token is still the newest. `newest()` exposes what the
 * hook would have in state afterwards.
 *
 * Awaiting every request would deadlock this: the point of the scenario is that
 * the OLDEST request settles LAST, so "all settled" never arrives.
 */
export function runSearchSequence(
  queries: readonly (readonly [string, boolean])[],
  apply: (hits: SearchHit[]) => void = () => {},
  fail: (error: unknown) => void = () => {},
): {
  settled: SearchHit[][]
  newest: () => SearchHit[]
  one: (i: number) => Promise<void>
  all: () => Promise<void>
} {
  const seq: SearchSeq = { current: 0 }
  const settled: SearchHit[][] = []
  let live: SearchHit[] = []
  const pending = queries.map(async function (q, i) {
    const mine = nextSeq(seq)
    // `runSearch` rejects on failure precisely so this branch exists: a failed
    // run must reach `fail` (the hook's `setError(true)`), not be mistaken for
    // "found nothing". The seq guard applies here too — a stale failure must
    // not flip the error flag for a newer run that is about to succeed.
    let hits: SearchHit[]
    try {
      hits = await runSearch(q[0], q[1])
    } catch (error) {
      if (isCurrentSearch(seq, mine)) fail(error)
      return
    }
    if (!isCurrentSearch(seq, mine)) return
    live = hits
    settled[i] = hits
    apply(hits)
  })
  return {
    settled,
    newest: function () { return live },
    one: function (i) { return pending[i].then(function () {}) },
    all: function () { return Promise.all(pending).then(function () {}) },
  }
}

/**
 * The body of `useSearch.run`, lifted out of the hook so the production path is
 * directly testable (there is no renderer in this repo, so the hook itself
 * cannot be mounted).
 *
 * `useSearch` passes its three `useState` setters and a `useRef({current:0})`
 * cell. The seq MUST survive across `run()` calls — that is the whole point. An
 * earlier revision allocated a fresh `{current:0}` per call, so every call saw
 * `mine === seq.current` and the guard could never fire: a slow older response
 * silently overwrote the newest results. Sharing one seq across calls is what
 * makes "the newer run wins" true, and it is exactly what this function does.
 */
export function useSearchRun(
  setResults: (hits: SearchHit[]) => void,
  setBusy: (busy: boolean) => void,
  setError: (error: boolean) => void,
  seq: SearchSeq = { current: 0 },
): (q: string, hybrid: boolean) => void {
  return function (q: string, hybrid: boolean) {
    const mine = nextSeq(seq)
    setBusy(true)
    setError(false)
    runSearch(q, hybrid)
      .then(function (hits) {
        // A slower earlier run must not overwrite a newer one's results.
        if (!isCurrentSearch(seq, mine)) return
        setResults(hits)
      })
      .catch(function () {
        if (!isCurrentSearch(seq, mine)) return
        // Clear the previous run's hits. The pane renders `error` ahead of the
        // results, so they are not drawn either way — but leaving them in state
        // makes them reappear the instant anything else flips `error` off, as
        // stale hits under a new query. A failed search has no results.
        setResults([])
        setError(true)
      })
      .finally(function () { if (isCurrentSearch(seq, mine)) setBusy(false) })
  }
}

/** Search state for the panel's first tab. Runs on demand, never polls. */
export function useSearch(): {
  results: SearchHit[]
  busy: boolean
  error: boolean
  run: (q: string, hybrid: boolean) => void
} {
  const [results, setResults] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  // Persistent across every `run()` call in this hook's lifetime. See
  // `useSearchRun` for why a per-call token here was the bug.
  const seq = useRef<SearchSeq>({ current: 0 })

  const run = useCallback(
    useSearchRun(setResults, setBusy, setError, seq.current),
    [],
  )

  return { results, busy, error, run }
}

// ── Preview ────────────────────────────────────────────────────────

/**
 * Load one governance view. Returns null when the host cannot answer.
 *
 * A view that is not implemented yet still answers `ok:true` with
 * `status:"unsupported"` — that travels through untouched, because the panel
 * must render it differently from a view that is implemented and empty.
 */
export async function loadPreview(
  view: PreviewView, limit: number = PREVIEW_LIMIT,
): Promise<PreviewData | null> {
  try {
    const url = `${PREVIEW_URL}?view=${encodeURIComponent(view)}&limit=${limit}`
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as Partial<PreviewData> & { ok?: boolean }
    if (body.ok !== true) return null
    return {
      view: String(body.view ?? view),
      status: String(body.status ?? 'ok'),
      count: Number(body.count ?? 0),
      items: Array.isArray(body.items) ? body.items : [],
    }
  } catch {
    return null
  }
}

/**
 * The liveness token an in-flight preview load checks before it setStates.
 *
 * React's effect cleanup flips this on unmount and on every dependency change,
 * so a response that lands after either is discarded instead of writing to a
 * component that has moved on. Kept as a plain object because a bare boolean
 * cannot be flipped by the effect's cleanup closure.
 */
export interface PreviewGate {
  alive: boolean
  dispose: () => void
}

/** Open a gate for one effect run. */
export function newPreviewGate(): PreviewGate {
  const gate: PreviewGate = {
    alive: true,
    dispose: function () { gate.alive = false },
  }
  return gate
}

/** True when a settling preview load may still touch state. */
export function canApplyPreview(gate: PreviewGate): boolean {
  return gate.alive
}

/**
 * Identity of one effect run: it changes iff the load must be re-fired.
 *
 * This is the `[view, nonce]` dependency array expressed as a value, so the
 * "which changes refetch" decision is testable without a renderer.
 */
export function previewEffectKey(view: PreviewView, nonce: number): string {
  return `${view}#${nonce}`
}

/**
 * Preview state for the inbox pane. Loads once on activation; `reload` re-reads.
 *
 * `busy` starts true because the effect's first act is to load, so the pane
 * renders its spinner on mount instead of a flash of "nothing here".
 */
export function usePreview(view: PreviewView): {
  data: PreviewData | null
  busy: boolean
  reload: () => void
} {
  const [data, setData] = useState<PreviewData | null>(null)
  const [busy, setBusy] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(function () {
    // Guards the unmount: a late response must not setState on a dead component.
    const gate = newPreviewGate()
    setBusy(true)
    loadPreview(view)
      .then(function (d) { if (canApplyPreview(gate)) setData(d) })
      .catch(function () { if (canApplyPreview(gate)) setData(null) })
      .finally(function () { if (canApplyPreview(gate)) setBusy(false) })
    return gate.dispose
    // Deps are exactly the pair `previewEffectKey` encodes.
  }, [view, nonce])

  return { data, busy, reload: function () { setNonce(function (n) { return n + 1 }) } }
}

/**
 * Read one submission's body, by file name.
 *
 * `/note` is the only read that carries a whole record rather than a list row,
 * which is what makes the inbox usable: a queue of file names is a list of
 * things you cannot judge, and judging is the entire task. The body is vault
 * text written by another agent, so it is returned as a string to be rendered
 * as text — never parsed, never treated as markup.
 *
 * The core refuses a name it does not accept (`invalid-name`) differently from
 * an item that is gone (`not-found`); both travel in `reason` instead of
 * collapsing into "no body".
 */
export async function loadNote(
  name: string,
): Promise<{ ok: boolean; body: string | null; reason: string | null }> {
  try {
    const url = `${NOTE_URL}?name=${encodeURIComponent(name)}`
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return { ok: false, body: null, reason: 'unavailable' }
    const body = (await r.json()) as { ok?: boolean; body?: unknown; reason?: unknown } | null
    if (!body || body.ok !== true) {
      return {
        ok: false,
        body: null,
        reason: typeof body?.reason === 'string' ? body.reason : 'unavailable',
      }
    }
    return {
      ok: true,
      body: typeof body.body === 'string' ? body.body : null,
      reason: null,
    }
  } catch {
    return { ok: false, body: null, reason: 'unavailable' }
  }
}

// ── Doc (one canonical note, opened from search) ────────────────────

/**
 * Read one canonical note, by the file name a search hit reported.
 *
 * This is NOT `loadNote`: `/note` reads the submission inbox and refuses a
 * canonical note, which is right for the queue and useless for a search result.
 * `/doc` wraps the core's `show`, which is the reader for `50-Agent-Context`.
 *
 * `path` is returned as well as the body: the panel can display text but cannot
 * hand a file to the user's editor, so the location is the part that lets them
 * finish the job themselves.
 *
 * The route carries the core's `reason` through, so a refused name
 * (`invalid-name`), a note that is gone (`not-found`) and a dead core
 * (`unavailable`) stay three different sentences.
 */
export async function loadDoc(
  name: string,
): Promise<{ ok: boolean; body: string | null; path: string | null; reason: string | null }> {
  try {
    const url = `${DOC_URL}?name=${encodeURIComponent(name)}`
    const r = await fetch(url, { cache: 'no-store' })
    const body = (await r.json().catch(function () { return null })) as
      { ok?: boolean; body?: unknown; path?: unknown; reason?: unknown } | null
    if (!body || body.ok !== true || typeof body.body !== 'string') {
      return {
        ok: false,
        body: null,
        path: null,
        reason: typeof body?.reason === 'string' ? body.reason : 'unavailable',
      }
    }
    return {
      ok: true,
      body: body.body,
      path: typeof body.path === 'string' ? body.path : null,
      reason: null,
    }
  } catch {
    return { ok: false, body: null, path: null, reason: 'unavailable' }
  }
}

// ── Dismiss ────────────────────────────────────────────────────────

/**
 * Retire one inbox item.
 *
 * `ok` is true only when the host confirms the move. The route answers 200 *or*
 * 409 and either can carry `ok:false`, so the HTTP status is not the verdict —
 * `body.ok === true` is. A 200 with `ok:false` is a refusal (e.g.
 * `outside-inbox`), not a success.
 *
 * `reason` is returned alongside the verdict rather than folded into a boolean:
 * "该条目不在提交区" and "记忆核心暂不可用" need different words and different
 * next steps, and a bare `false` cannot tell a user which one happened.
 */
export async function dismissItem(
  name: string,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const r = await fetch(DISMISS_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = (await r.json().catch(function () { return null })) as
      { ok?: boolean; reason?: unknown } | null
    return {
      ok: body?.ok === true,
      reason: typeof body?.reason === 'string' ? body.reason : null,
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

// ── Accept ─────────────────────────────────────────────────────────

/** What one accept did: how many facts landed, and whether the rest were seen. */
export interface AcceptResult {
  ok: boolean
  reason: string | null
  promoted: number
  duplicates: number
  conflicts: number
}

/**
 * Promote one inbox submission into memory.
 *
 * The yes button. `ok` is true only when the host confirms a promotion, and a
 * 200 can still carry `ok:false` — a refusal (`conflicts`, `not-a-submission`,
 * `not-found`) is a business answer, not a transport failure, so `reason` is
 * returned next to the verdict instead of being flattened into a boolean.
 *
 * The counts travel because the pane has something useful to say afterwards:
 * "收录 3 条" and "3 条重复，没有新事实" are different outcomes of the same
 * click, and a bare `true` renders them identically.
 */
export async function acceptItem(name: string): Promise<AcceptResult> {
  const empty = { ok: false, reason: 'unavailable', promoted: 0, duplicates: 0, conflicts: 0 }
  try {
    const r = await fetch(ACCEPT_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = (await r.json().catch(function () { return null })) as
      { ok?: boolean; reason?: unknown; promoted?: unknown; duplicates?: unknown; conflicts?: unknown } | null
    if (!body) return empty
    const count = function (v: unknown): number {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    return {
      ok: body.ok === true,
      reason: typeof body.reason === 'string' ? body.reason : null,
      promoted: count(body.promoted),
      duplicates: count(body.duplicates),
      conflicts: count(body.conflicts),
    }
  } catch {
    return empty
  }
}

// ── Conflicts: the questions that actually need a person ───────────

/** One queued conflict: a new fact and the existing line it contradicts. */
export interface ConflictSideDetail {
  text?: string
  recorded?: string
  source?: string
}

export interface ConflictDetail {
  /** Note name without the folder path: 常用路径与环境.md */
  doc?: string
  new?: ConflictSideDetail
  old?: ConflictSideDetail
  /** Where the two sides stop agreeing; null when they are identical. */
  change?: { prefix?: string; new?: string; old?: string; suffix?: string } | null
  /**
   * The agent's recommendation, when it left one. Absent for conflicts nobody
   * has analysed yet, and for cores older than this field.
   */
  advice?: { choice?: string; why?: string } | null
}

export interface ConflictItem {
  /** Stable handle for the ruling. Never a list index — resolving shifts them. */
  key: string
  new: string
  old: string
  source: string
  /** Vault-relative note the new fact would land in. */
  doc: string
  /**
   * The same two sides, stripped and diffed. Optional: an older core omits it,
   * and the pane then falls back to the raw text rather than showing nothing.
   */
  detail?: ConflictDetail | null
}

/**
 * Validate the optional `detail` block.
 *
 * It is vault-derived text arriving over HTTP, so every field is checked rather
 * than cast: a missing key must read as "no detail", which the renderer turns
 * into the plain fallback, not as `undefined` leaking into a string template.
 */
function conflictDetail(raw: unknown): ConflictDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const side = function (v: unknown): ConflictSideDetail | undefined {
    if (!v || typeof v !== 'object') return undefined
    const s = v as Record<string, unknown>
    return { text: str(s.text), recorded: str(s.recorded), source: str(s.source) }
  }
  const changeRaw = o.change
  let change: ConflictDetail['change'] = null
  if (changeRaw && typeof changeRaw === 'object') {
    const c = changeRaw as Record<string, unknown>
    change = {
      prefix: str(c.prefix) ?? '',
      new: str(c.new) ?? '',
      old: str(c.old) ?? '',
      suffix: str(c.suffix) ?? '',
    }
  }
  const adviceRaw = o.advice
  let advice: ConflictDetail['advice'] = null
  if (adviceRaw && typeof adviceRaw === 'object') {
    const a = adviceRaw as Record<string, unknown>
    const choice = str(a.choice)
    const why = str(a.why)
    // An advice block with no words in it is not an advice block: the renderer
    // would otherwise draw an empty "Agent 的判断" heading on every row.
    if ((choice && choice.trim()) || (why && why.trim())) advice = { choice, why }
  }
  return { doc: str(o.doc), new: side(o.new), old: side(o.old), change, advice }
}

/**
 * Read the conflict queue.
 *
 * `null` means the read failed; `[]` means the queue really is empty. The two
 * are different sentences in the pane ("读不到" vs "没有要裁决的"), so this
 * never collapses one into the other.
 *
 * A row without a `key` is dropped: it cannot be ruled on, and rendering a row
 * whose buttons would have nothing to send is worse than not showing it.
 */
export async function loadConflicts(limit: number = PREVIEW_LIMIT): Promise<ConflictItem[] | null> {
  try {
    const url = `${PREVIEW_URL}?view=conflicts&limit=${limit}`
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as { ok?: boolean; items?: unknown }
    if (body.ok !== true || !Array.isArray(body.items)) return null
    return body.items.flatMap(function (raw): ConflictItem[] {
      if (!raw || typeof raw !== 'object') return []
      const o = raw as Record<string, unknown>
      const key = typeof o.key === 'string' ? o.key : ''
      if (!key) return []
      return [{
        key,
        new: typeof o.new === 'string' ? o.new : '',
        old: typeof o.old === 'string' ? o.old : '',
        source: typeof o.source === 'string' ? o.source : '',
        doc: typeof o.doc === 'string' ? o.doc : '',
        detail: conflictDetail(o.detail),
      }]
    })
  } catch {
    return null
  }
}

/**
 * Rule on one conflict.
 *
 * `choice` is one of the three verdicts the route accepts (用新 / 保留旧 / 并存).
 * `target` comes back when the ruling wrote to a note, so the pane can name the
 * file it changed instead of saying "done".
 */
export async function decideConflict(
  key: string, choice: string,
): Promise<{ ok: boolean; reason: string | null; applied: boolean; target: string | null }> {
  try {
    const r = await fetch(DECIDE_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, choice }),
    })
    const body = (await r.json().catch(function () { return null })) as
      { ok?: boolean; reason?: unknown; applied?: unknown; target?: unknown } | null
    return {
      ok: body?.ok === true,
      reason: typeof body?.reason === 'string' ? body.reason : null,
      applied: body?.applied === true,
      target: typeof body?.target === 'string' ? body.target : null,
    }
  } catch {
    return { ok: false, reason: 'unavailable', applied: false, target: null }
  }
}

/** Conflict-queue state for the 待确认 pane. Loads on mount; `reload` re-reads. */
export function useConflicts(): {
  items: ConflictItem[] | null
  busy: boolean
  reload: () => void
} {
  const [items, setItems] = useState<ConflictItem[] | null>(null)
  const [busy, setBusy] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(function () {
    const gate = newPreviewGate()
    setBusy(true)
    loadConflicts()
      .then(function (rows) { if (canApplyPreview(gate)) setItems(rows) })
      .catch(function () { if (canApplyPreview(gate)) setItems(null) })
      .finally(function () { if (canApplyPreview(gate)) setBusy(false) })
    return gate.dispose
  }, [nonce])

  return { items, busy, reload: function () { setNonce(function (n) { return n + 1 }) } }
}

// ── Stats ──────────────────────────────────────────────────────────

/** Coerce a value to an array; anything else is an empty series. */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/**
 * Keep only object entries, so a stray null cannot reach the geometry.
 *
 * Arrays are excluded too: `typeof [] === 'object'` would let a nested array in
 * as a row, where every named field reads as `undefined` and normalizes to
 * `''`/`0` — a malformed series rendered as a legitimate zero row.
 */
function rows(v: unknown): Record<string, unknown>[] {
  return asArray(v).filter(function (r): r is Record<string, unknown> {
    return typeof r === 'object' && r !== null && !Array.isArray(r)
  })
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** `string | null`: an absent span end is "unknown", not an empty string. */
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * The top-level keys `shapeStats` renders. A payload missing any of them is a
 * contract break, not an empty vault.
 *
 * MUST stay equal to the key set `stats.build()` returns in
 * `core/unified_memory/stats.py`. This is deliberately a key-EXISTENCE check,
 * not a per-field type check: rename `daily` → `days` core-side and the old
 * normalizer turned the missing series into `[]`, so the console drew a blank
 * heatmap beside a non-zero `totals` — a UI that lies about an empty vault. The
 * value shapes are still normalized by `shapeStats` (an empty array, a 0 and a
 * `''` are legitimate answers from a real, empty vault).
 */
const STATS_KEYS = ['daily', 'access', 'types', 'importance', 'top', 'span', 'totals'] as const

/**
 * Normalize whatever the route sent into the renderable shape.
 *
 * Every key in `STATS_KEYS` must be PRESENT (see the ceiling on that list); the
 * values within it are normalized rather than validated: every series becomes an
 * array, every number a number, every label a string.
 */
function shapeStats(d: Record<string, unknown>): StatsData {
  // `span` and `totals` are objects, never arrays. Excluding arrays matters
  // because these two are read field-by-field: an array would yield `undefined`
  // for every field and normalize into `{start:null,end:null}` and four zeroes —
  // an absent measurement drawn as a real, empty one.
  const span = (typeof d.span === 'object' && d.span !== null && !Array.isArray(d.span) ? d.span : {}) as Record<string, unknown>
  const totals = (typeof d.totals === 'object' && d.totals !== null && !Array.isArray(d.totals) ? d.totals : {}) as Record<string, unknown>
  return {
    daily: rows(d.daily).map(function (r) { return { date: str(r.date), count: num(r.count) } }),
    access: rows(d.access).map(function (r) { return { date: str(r.date), count: num(r.count) } }),
    types: rows(d.types).map(function (r) { return { type: str(r.type), count: num(r.count) } }),
    importance: rows(d.importance).map(function (r) { return { value: num(r.value), count: num(r.count) } }),
    // `untrusted` is forced true: the labels are corpus-authored, so the renderer
    // must never be talked out of treating them as text.
    top: rows(d.top).map(function (r) {
      return { id: str(r.id), label: str(r.label), count: num(r.count), untrusted: true as const }
    }),
    span: { start: nullableStr(span.start), end: nullableStr(span.end) },
    totals: {
      memories: num(totals.memories),
      vectors: num(totals.vectors),
      accesses: num(totals.accesses),
      inbox: num(totals.inbox),
    },
  }
}

/**
 * Read the aggregate feed for the console figures.
 *
 * The route's contract is the shape the brief documents. Three independent
 * gates, exactly like `dismissItem`:
 *
 *  - the HTTP status must be ok, because a 500 body is not ours to trust;
 *  - `body.ok === true` must hold, because the route answers **200 with
 *    `ok:false`,`data:null`** when the core is degraded;
 *  - every key in `STATS_KEYS` must be PRESENT, because a renamed core-side field
 *    would otherwise normalize into an empty series and the console would draw a
 *    blank figure beside a non-zero total — "your vault is empty" is a lie the
 *    user cannot detect.
 *
 * `data:null` is reported as `status:'error'`, never normalized into an empty
 * dataset: "the core could not be read" and "the vault has nothing in it" are
 * different facts and the console renders them differently. Every failure — a
 * non-JSON body (`res.json()` rejects), an aborted transport, a missing top-level
 * key — resolves to an error payload. This function never rejects.
 */
export async function loadStats(): Promise<StatsPayload> {
  try {
    const r = await fetch(STATS_URL, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return { status: 'error', data: null }
    const body = (await r.json()) as { ok?: boolean; data?: unknown } | null
    if (!body || body.ok !== true) return { status: 'error', data: null }
    if (typeof body.data !== 'object' || body.data === null) return { status: 'error', data: null }
    const data = body.data as Record<string, unknown>
    if (!STATS_KEYS.every(function (k) { return k in data })) return { status: 'error', data: null }
    return { status: 'ok', data: shapeStats(data) }
  } catch {
    return { status: 'error', data: null }
  }
}

/**
 * Liveness token for one stats load. Same contract as `PreviewGate`: a response
 * that lands after the effect's cleanup must not setState on a dead component.
 */
export interface StatsGate {
  alive: boolean
  dispose: () => void
}

/** Open a gate for one effect run. */
export function newStatsGate(): StatsGate {
  const gate: StatsGate = {
    alive: true,
    dispose: function () { gate.alive = false },
  }
  return gate
}

/** Identity of one stats effect run: it changes iff the load must re-fire. */
export function statsEffectKey(nonce: number): number {
  return nonce
}

/**
 * Stats state for the console figures. Loads on mount; `reload` re-reads.
 *
 * `loading` is the mount state, so the pane renders its skeleton instead of
 * flashing "no data" before the first response.
 */
export function useStats(): {
  status: StatsPayload['status']
  data: StatsData | null
  reload: () => void
} {
  const [state, setState] = useState<StatsPayload>({ status: 'loading', data: null })
  const [nonce, setNonce] = useState(0)

  useEffect(function () {
    // Guards every settle path, so a late response cannot reach a dead component.
    const gate = newStatsGate()
    setState({ status: 'loading', data: null })
    loadStats()
      .then(function (p) { if (canApplyPreview(gate)) setState(p) })
      .catch(function () { if (canApplyPreview(gate)) setState({ status: 'error', data: null }) })
    return gate.dispose
  }, [nonce])

  return {
    status: state.status,
    data: state.data,
    reload: function () { setNonce(function (n) { return n + 1 }) },
  }
}

// ── Doctor: the findings the health verdict is based on ─────────────

/** Gate for one doctor load. Same lifecycle contract as `StatsGate`. */
export interface DoctorGate {
  alive: boolean
  dispose: () => void
}

export function newDoctorGate(): DoctorGate {
  const gate: DoctorGate = {
    alive: true,
    dispose: function () { gate.alive = false },
  }
  return gate
}

function doctorUnavailable(): DoctorPayload {
  return { status: 'unavailable', issues: [], counts: null }
}

/**
 * Read the core's issue list.
 *
 * `status:'unavailable'` is NOT `issues: []`. The pane prints an empty list as
 * "没有发现问题", which is a claim about the vault; when the doctor never ran
 * the only honest thing to say is that it did not run. Every failure path here
 * — a non-200, a body that is not ours, a transport error — resolves to
 * `unavailable` and never rejects, so the pane can render without a try/catch.
 */
export async function loadDoctor(): Promise<DoctorPayload> {
  try {
    const r = await fetch(DOCTOR_URL, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return doctorUnavailable()
    const body = (await r.json()) as { status?: unknown; issues?: unknown; counts?: unknown } | null
    if (!body || body.status !== 'ok' || !Array.isArray(body.issues)) return doctorUnavailable()
    const issues: DoctorIssue[] = []
    for (const raw of body.issues) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const message = typeof o.message === 'string' ? o.message : ''
      const code = typeof o.code === 'string' ? o.code : ''
      if (!message && !code) continue
      // Unknown severity degrades to `warn`, mirroring the route: a finding
      // this build does not understand must not be demoted to a footnote.
      const severity = o.severity === 'error' || o.severity === 'info' ? o.severity : 'warn'
      issues.push({
        severity,
        code,
        message,
        hint: typeof o.hint === 'string' ? o.hint : '',
      })
    }
    // `Array.isArray` is required, not belt-and-braces: `typeof [] === 'object'`
    // is true, so a counts field that arrived as `[]` would be accepted and then
    // read through `Number([].memories) || 0` — six zeroes, i.e. a missing
    // reading rendered as a measured one. Arrays carry nothing to read.
    const c = Array.isArray(body.counts) ? null : body.counts
    const counts = c && typeof c === 'object'
      ? {
          memories: Number((c as Record<string, unknown>).memories) || 0,
          vectors: Number((c as Record<string, unknown>).vectors) || 0,
          conflicts: Number((c as Record<string, unknown>).conflicts) || 0,
          inbox: Number((c as Record<string, unknown>).inbox) || 0,
          duplicates: Number((c as Record<string, unknown>).duplicates) || 0,
          orphans: Number((c as Record<string, unknown>).orphans) || 0,
        }
      : null
    return { status: 'ok', issues, counts }
  } catch {
    return doctorUnavailable()
  }
}

/**
 * Doctor state for the health pane. Loads on mount; `reload` re-reads.
 *
 * Deliberately NOT polled. `doctor` walks the canonical notes to look for
 * duplicate lines, which is the most expensive read in the core; the status
 * route already carries the numbers that change minute to minute. The pane
 * offers an explicit "重新体检" instead, so the cost is paid when the user asks
 * for an answer rather than every ten seconds.
 */
export function useDoctor(): {
  status: DoctorPayload['status']
  issues: DoctorIssue[]
  counts: DoctorCounts | null
  reload: () => void
} {
  const [state, setState] = useState<DoctorPayload>({ status: 'loading', issues: [], counts: null })
  const [nonce, setNonce] = useState(0)

  useEffect(function () {
    const gate = newDoctorGate()
    setState({ status: 'loading', issues: [], counts: null })
    loadDoctor()
      .then(function (p) { if (canApplyPreview(gate)) setState(p) })
      .catch(function () { if (canApplyPreview(gate)) setState(doctorUnavailable()) })
    return gate.dispose
  }, [nonce])

  return {
    status: state.status,
    issues: state.issues,
    counts: state.counts,
    reload: function () { setNonce(function (n) { return n + 1 }) },
  }
}

// ── Repair hand-off: from a finding to a running agent ──────────────

/**
 * Where one hand-off is in its life.
 *
 * `sent → running → verifying → (gone)` is the happy path. The other three are
 * not failures of the agent; they are the ways this ends without an answer:
 * `failed` (it never got there) and `mismatch` (it says it is done and the
 * doctor disagrees).
 *
 * There is deliberately no `stalled` state. A slow agent is not a broken one,
 * and a phase that means "we stopped caring" would also stop the watcher — so
 * the long-running case is expressed in the card as an elapsed time instead of
 * as a state transition.
 */
export type RepairPhase =
  | 'sending'
  | 'sent'
  | 'running'
  | 'verifying'
  | 'failed'
  | 'mismatch'

export interface RepairEntry {
  phase: RepairPhase
  /** When the brief was sent; drives the elapsed clock the card prints. */
  startedAt: number
  sessionId: string | null
  /** Why it failed, or what the doctor still sees. Shown verbatim. */
  note?: string
  /**
   * The brief itself. Kept only so a failed hand-off can still be copied:
   * on a host with no sessions service, "copy it and paste it yourself" is the
   * last thing that works, and it is the only thing that works for a finding
   * with no command.
   */
  brief?: string
}

/** What a card needs from the hook; one entry per finding, keyed by code. */
export interface RepairApi {
  entries: Record<string, RepairEntry>
  /**
   * Send one finding, into a conversation of its own.
   *
   * No target argument: there is nothing to choose. Reusing whatever session
   * was most recently active put a vault-wide read-and-edit turn in the middle
   * of the user's own thread, and left the agent carrying that context into
   * unrelated work afterwards.
   */
  send: (finding: HealthFinding) => void
  /** Forget one finding's state (the retry / dismiss buttons use it). */
  clear: (code: string) => void
  /**
   * Codes the doctor reports NOW that it did not report when the brief was
   * sent. A repair that fixes one thing and breaks another is still a repair
   * that broke something, and only the subtraction is checked by default.
   */
  added: string[]
  /** Hide the "new problem" line (it is not a modal; it does not block). */
  dismissAdded: () => void
}

/** How long a `sent` brief may sit with no visible turn before we ask the doctor. */
const START_GRACE_MS = 4000
/** How often the session snapshot is re-read while a hand-off is in flight. */
const WATCH_MS = 1000

/**
 * One watcher tick, as a pure function.
 *
 * Extracted because React hooks cannot be mounted in this repo's test
 * environment, and this is the only part of the hand-off with real decisions in
 * it: when does "sent" become "running", and when is it time to ask the doctor.
 *
 * `running` is injected so a test can answer without a host. `verify` is
 * reported once per entry, on the tick that retires it — the caller fires the
 * doctor read, not the state machine.
 */
export function advanceRepairs(
  entries: Record<string, RepairEntry>,
  running: (sessionId: string | null) => boolean | null,
  now: number,
): { entries: Record<string, RepairEntry>; changed: boolean; verify: boolean } {
  const next = { ...entries }
  let changed = false
  let verify = false

  Object.keys(entries).forEach(function (code) {
    const entry = entries[code]
    if (entry.phase !== 'sent' && entry.phase !== 'running') return
    if (running(entry.sessionId) === true) {
      if (entry.phase !== 'running') {
        next[code] = { ...entry, phase: 'running' }
        changed = true
      }
      return
    }
    // The turn ended, or the session row is gone. Only the doctor can say
    // whether that helped, so ask it once — never in a loop.
    if (entry.phase === 'running' || now - entry.startedAt > START_GRACE_MS) {
      next[code] = { ...entry, phase: 'verifying' }
      changed = true
      verify = true
    }
  })

  return { entries: next, changed, verify }
}

/**
 * Reconcile in-flight hand-offs against a fresh doctor read.
 *
 * The doctor is the only referee: an agent saying "已修复" is a sentence, the
 * issue disappearing is a measurement. `mismatch` keeps the disagreement
 * visible — two observers seeing different worlds is itself the diagnosis.
 */
export function reconcileRepairs(
  entries: Record<string, RepairEntry>,
  present: readonly string[],
): { entries: Record<string, RepairEntry>; changed: boolean } {
  const still: Record<string, true> = {}
  present.forEach(function (code) { still[code] = true })

  const next = { ...entries }
  let changed = false
  Object.keys(entries).forEach(function (code) {
    const entry = entries[code]
    if (entry.phase !== 'verifying' && entry.phase !== 'mismatch') return
    if (!still[code]) {
      delete next[code]
      changed = true
      return
    }
    // Already recorded as a disagreement: the next doctor read says the same
    // thing, so there is nothing to write and nothing to re-render.
    if (entry.phase === 'mismatch') return
    next[code] = {
      ...entry,
      phase: 'mismatch',
      note: 'Agent 说处理完了，但体检仍然报这个。可能它读的是另一个 vault，或另一份核心。',
    }
    changed = true
  })
  return { entries: next, changed }
}

/**
 * Drive hand-offs and reconcile them against the doctor.
 *
 * Two deliberate omissions:
 *
 *  - Nothing is persisted. A reload forgets a repair was started, so a problem
 *    still in the doctor list simply reads as "待处理" again. Remembering "I
 *    thought I fixed that" is worse than forgetting.
 *  - No polling of `/doctor`. That read is the most expensive thing the core
 *    does; it runs once per hand-off, triggered by the session's `running` flag
 *    going false. The panel learns "the agent stopped" from a memory snapshot,
 *    which costs nothing.
 */
export function useRepair(opts: {
  doctorStatus: DoctorPayload['status']
  issues: readonly DoctorIssue[]
  onVerify: () => void
  env: RepairEnv
}): RepairApi {
  const [entries, setEntries] = useState<Record<string, RepairEntry>>({})
  const [added, setAdded] = useState<string[]>([])
  const entriesRef = useRef<Record<string, RepairEntry>>({})
  const envRef = useRef(opts.env)
  const verifyRef = useRef(opts.onVerify)
  const issuesRef = useRef<readonly DoctorIssue[]>(opts.issues)
  const sawLoading = useRef(false)
  /**
   * The codes the doctor reported when the brief was written. Null until the
   * first send: without a baseline there is no such thing as "new".
   */
  const baseline = useRef<Record<string, true> | null>(null)

  entriesRef.current = entries
  envRef.current = opts.env
  verifyRef.current = opts.onVerify
  issuesRef.current = opts.issues

  const active = Object.keys(entries).filter(function (code) {
    const phase = entries[code].phase
    return phase === 'sent' || phase === 'running'
  }).length > 0

  useEffect(function () {
    if (!active) return
    const timer = window.setInterval(function () {
      const sessions = sessionsOf()
      const tick = advanceRepairs(
        entriesRef.current,
        function (id) { return runningOf(sessions, id) },
        Date.now(),
      )
      if (tick.changed) {
        entriesRef.current = tick.entries
        setEntries(tick.entries)
      } else if (Object.keys(tick.entries).some(function (code) { return tick.entries[code].phase === 'running' })) {
        // Nothing transitioned, but the card prints elapsed seconds — a new
        // object identity is the cheapest way to re-render it once a second.
        setEntries({ ...tick.entries })
      }
      if (tick.verify) verifyRef.current()
    }, WATCH_MS)
    return function () { window.clearInterval(timer) }
  }, [active])

  // Reconcile only against a doctor read that STARTED after the verify was
  // requested. Without the `sawLoading` gate the first render after a hand-off
  // would compare against the stale payload the brief was built from and call
  // every repair a mismatch.
  useEffect(function () {
    if (opts.doctorStatus === 'loading') { sawLoading.current = true; return }
    if (opts.doctorStatus !== 'ok' || !sawLoading.current) return
    sawLoading.current = false

    const codes = opts.issues.map(function (issue) { return issue.code })
    const result = reconcileRepairs(entriesRef.current, codes)
    if (result.changed) {
      entriesRef.current = result.entries
      setEntries(result.entries)
    }
    const base = baseline.current
    if (base === null) return
    const fresh = codes.filter(function (code) { return base[code] !== true })
    setAdded(function (previous) {
      return sameCodes(previous, fresh) ? previous : fresh
    })
  }, [opts.doctorStatus, opts.issues])

  return {
    entries,
    send: function (finding: HealthFinding) {
      const code = finding.key
      const sessions = sessionsOf()
      const brief = buildRepairPrompt(finding, envRef.current, new Date().toISOString())
      sawLoading.current = false
      // Baseline for the "did this repair introduce something" check: the list
      // this brief was written from.
      const base: Record<string, true> = {}
      issuesRef.current.forEach(function (issue) { base[issue.code] = true })
      baseline.current = base
      setAdded([])
      entriesRef.current = {
        ...entriesRef.current,
        [code]: { phase: 'sending', startedAt: Date.now(), sessionId: null, brief },
      }
      setEntries(entriesRef.current)

      sendBrief(sessions, brief, null)
        .then(function (result) {
          const current = entriesRef.current[code]
          if (!current) return
          entriesRef.current = {
            ...entriesRef.current,
            [code]: result.ok
              ? { phase: 'sent', startedAt: Date.now(), sessionId: result.sessionId }
              : { phase: 'failed', startedAt: current.startedAt, sessionId: result.sessionId, note: result.reason, brief: current.brief },
          }
          setEntries(entriesRef.current)
        })
        .catch(function (error: Error) {
          const current = entriesRef.current[code]
          if (!current) return
          entriesRef.current = {
            ...entriesRef.current,
            [code]: { phase: 'failed', startedAt: current.startedAt, sessionId: current.sessionId, note: error.message, brief: current.brief },
          }
          setEntries(entriesRef.current)
        })
    },
    clear: function (code: string) {
      const next = { ...entriesRef.current }
      delete next[code]
      entriesRef.current = next
      setEntries(next)
    },
    added,
    dismissAdded: function () {
      baseline.current = null
      setAdded([])
    },
  }
}

/** Cheap equality for the code lists the reconcile effect recomputes each read. */
function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
