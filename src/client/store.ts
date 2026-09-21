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

import { useCallback, useEffect, useState } from '../deps.ts'
import type { PreviewData, PreviewView, SearchHit, StatusPayload } from './types.ts'

export const STATUS_URL = '/api/dsh-unified-agent-memory/status'
export const POLL_INTERVAL_MS = 10000

export const BASE_URL = '/api/dsh-unified-agent-memory'
export const SEARCH_URL = `${BASE_URL}/search`
export const PREVIEW_URL = `${BASE_URL}/preview`
export const DISMISS_URL = `${BASE_URL}/dismiss`

/** Default cap on a preview list, matching the host route. */
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
 * Run a search. Resolves to [] on any failure — the panel shows "none".
 *
 * A transport success is NOT a business success: the host answers 200 with
 * `{ok:false}` when the core is unavailable, so the body gate runs too.
 */
export async function runSearch(query: string, hybrid: boolean): Promise<SearchHit[]> {
  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}${hybrid ? '&hybrid=1' : ''}`
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return []
    const body = (await r.json()) as { ok?: boolean; results?: SearchHit[] }
    return body.ok === true && Array.isArray(body.results) ? body.results : []
  } catch {
    return []
  }
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
    const hits = await runSearch(q[0], q[1])
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

  const run = useCallback(function (q: string, hybrid: boolean) {
    setBusy(true)
    setError(false)
    // Delegates to the shared helper: the guard is written once, in
    // `runSearchSequence`, and the hook only reacts to a verdict it never
    // computes itself. `apply` is the hook's own "the newest result landed"
    // edge, and it fires only for the token that is still current.
    runSearchSequence([[q, hybrid]], function (hits) { setResults(hits) })
      .all()
      .catch(function () { setError(true) })
      .finally(function () { setBusy(false) })
  }, [])

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
 * Preview state for a tab. Loads once on activation; `reload` re-reads.
 *
 * `busy` starts true because the effect's first act is to load, so the tab
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

// ── Dismiss ────────────────────────────────────────────────────────

/**
 * Retire one inbox item. True only when the host confirms the move.
 *
 * The route answers 200 *or* 409 and either can carry `ok:false`, so the HTTP
 * status is not the verdict — `body.ok === true` is. A 200 with `ok:false` is a
 * refusal (e.g. `outside-inbox`), not a success.
 */
export async function dismissItem(name: string): Promise<boolean> {
  try {
    const r = await fetch(DISMISS_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!r.ok) return false
    const body = (await r.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}
