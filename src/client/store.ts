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
import type {
  PreviewData, PreviewView, SearchHit, StatsData, StatsPayload, StatusPayload,
} from './types.ts'

export const STATUS_URL = '/api/dsh-unified-agent-memory/status'
export const POLL_INTERVAL_MS = 10000

export const BASE_URL = '/api/dsh-unified-agent-memory'
export const SEARCH_URL = `${BASE_URL}/search`
export const PREVIEW_URL = `${BASE_URL}/preview`
export const DISMISS_URL = `${BASE_URL}/dismiss`
export const STATS_URL = `${BASE_URL}/stats`

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
      .catch(function () { if (isCurrentSearch(seq, mine)) setError(true) })
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

// ── Stats ──────────────────────────────────────────────────────────

/** Coerce a value to an array; anything else is an empty series. */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Keep only object entries, so a stray null cannot reach the geometry. */
function rows(v: unknown): Record<string, unknown>[] {
  return asArray(v).filter(function (r): r is Record<string, unknown> {
    return typeof r === 'object' && r !== null
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
  const span = (typeof d.span === 'object' && d.span !== null ? d.span : {}) as Record<string, unknown>
  const totals = (typeof d.totals === 'object' && d.totals !== null ? d.totals : {}) as Record<string, unknown>
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
