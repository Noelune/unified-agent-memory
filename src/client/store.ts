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

import { useEffect, useState } from '../deps.ts'
import type { StatusPayload } from './types.ts'

export const STATUS_URL = '/api/dsh-unified-agent-memory/status'
export const POLL_INTERVAL_MS = 10000

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
