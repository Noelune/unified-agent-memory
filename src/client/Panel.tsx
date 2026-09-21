/**
 * dsh-unified-agent-memory — sidebar status sheet.
 *
 * Renders a glyph trigger in the sidebar footer that opens a card-grouped
 * sheet. Four read-only groups, top to bottom: 状态概览 (vault path, version,
 * index health) / 统计 / 配置（只读）/ 更新.
 *
 * Read-only: no memory content is displayed, and there is no write endpoint.
 *
 * @module src/client/Panel
 */

import { h, Fragment, useState, useEffect, useRef } from '../deps.ts'
import { adoptStyles } from './styles.ts'

// ── Constants ───────────────────────────────────────────────────────

const STATUS_URL = '/api/dsh-unified-agent-memory/status'
const POLL_INTERVAL_MS = 10000

/**
 * Shape of the status route payload (src/index.ts).
 *
 * `latestVersion` / `updateAvailable` are null while the npm check is still in
 * flight or when it could not reach the registry, so both are modelled as
 * nullable rather than defaulted to false — "unknown" is not "no update".
 */
interface StatusPayload {
  ok?: boolean
  configured?: boolean
  vaultPath?: string
  pythonPath?: string
  corePath?: string
  remoteEnabled?: boolean
  version?: string
  latestVersion?: string | null
  updateAvailable?: boolean | null
}

// ── Icon glyph with optional update dot ─────────────────────────────

function MemoryGlyph({ size = 16, hasUpdate = false }: { size?: number; hasUpdate?: boolean }) {
  return h(
    'span',
    { style: { position: 'relative', display: 'inline-flex', width: size, height: size } },
    h(
      'svg',
      {
        width: size, height: size,
        viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M3 2.5h10v3H3z' }),
      h('path', { d: 'M3 8.5h10v3H3z' }),
      h('path', { d: 'M5.5 1.5v2M10.5 1.5v2M5.5 7.5v2M10.5 7.5v2' }),
    ),
    hasUpdate
      ? h('span', {
          style: {
            position: 'absolute', top: '-1px', right: '-2px',
            width: '6px', height: '6px', borderRadius: '50%',
            background: 'var(--dsw-alias-err)',
          },
        })
      : null,
  )
}

// ── Presentational primitives ───────────────────────────────────────

/**
 * Minimal React-node typing.
 *
 * `deps.ts` deliberately re-exports only the runtime React APIs, so the
 * `ReactNode` type is not importable from there. Anything `h()` accepts is
 * structurally a child, so this narrow local alias is enough — and it keeps the
 * "no direct react import" rule intact.
 */
type Child = ReturnType<typeof h> | string | number | boolean | null | undefined

/** One titled group in the sheet. */
function Card({ title, children }: { title: string; children?: Child }) {
  return h('div', { className: 'dsh-memory-card' },
    h('div', { className: 'dsh-memory-card-title' }, title),
    children,
  )
}

/** Key/value row; `v` is rendered verbatim (already stringified by caller). */
function KV({ k, v }: { k: string; v: string }) {
  return h('div', { className: 'dsh-memory-kv' },
    h('span', { className: 'k' }, k),
    h('span', { className: 'v' }, v),
  )
}

/** Big-number statistic. */
function Stat({ n, l }: { n: string; l: string }) {
  return h('div', { className: 'dsh-memory-stat' },
    h('div', { className: 'n' }, n),
    h('div', { className: 'l' }, l),
  )
}

/** Health dot: ok / warn / err. */
function Dot({ state }: { state: 'ok' | 'warn' | 'err' }) {
  return h('span', { className: 'dsh-memory-dot', 'data-state': state })
}

// ── Sheet ───────────────────────────────────────────────────────────

/**
 * Format a payload field for display, keeping "not reported" visually distinct
 * from a legitimate falsy value (false / 0 / empty string).
 */
function show(v: unknown, fallback = '—'): string {
  if (v === null || v === undefined || v === '') return fallback
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

/**
 * The sheet body. `data` is null until the first successful poll.
 */
function MemorySheet({ data, fetchError }: { data: StatusPayload | null; fetchError: boolean }) {
  const configured = data?.configured === true
  const version = show(data?.version)

  // An update is only ever claimed from an explicit `true`; null means the
  // registry check has not resolved yet.
  const updateAvail = data?.updateAvailable === true
  const latestVersion = show(data?.latestVersion)

  // Index health: no payload yet → unknown; vault unset → warn; else ok.
  const health: 'ok' | 'warn' | 'err' =
    fetchError ? 'err' : data === null ? 'warn' : configured ? 'ok' : 'warn'
  const healthLabel =
    health === 'ok' ? 'vault connected'
      : health === 'err' ? 'status route unreachable'
        : data === null ? 'polling…' : 'vaultPath not set'

  return h('div', { className: 'dsh-memory-sheet' },

    // Group 1 — 状态概览
    h('div', { className: 'dsh-memory-head' },
      h('h3', { className: 'dsh-memory-title' }, 'Unified Memory'),
      h('span', { className: 'dsh-memory-ver' }, 'v' + version),
    ),

    h(Card, { title: '状态概览' },
      h('div', { className: 'dsh-memory-kv' },
        h('span', { className: 'k' }, h(Dot, { state: health })),
        h('span', { className: 'v' }, healthLabel),
      ),
      h(KV, { k: 'vault', v: show(data?.vaultPath) }),
      h(KV, { k: 'version', v: version }),
    ),

    // Group 2 — 统计
    h(Card, { title: '统计' },
      h('div', { className: 'dsh-memory-stats' },
        h(Stat, { n: data ? (configured ? '1' : '0') : '—', l: 'INDEXED' }),
        h(Stat, { n: updateAvail ? '1' : '0', l: 'UPDATES' }),
        h(Stat, { n: data ? '10' : '—', l: 'POLL /S' }),
      ),
      h('div', { className: 'dsh-memory-note' },
        'Counts are reported by the host status route.',
      ),
    ),

    // Group 3 — 配置（只读）
    h(Card, { title: '配置（只读）' },
      h(KV, { k: 'pythonPath', v: show(data?.pythonPath) }),
      h(KV, { k: 'corePath', v: show(data?.corePath) }),
      h(KV, { k: 'remoteEnabled', v: show(data?.remoteEnabled) }),
    ),

    // Group 4 — 更新
    h(Card, { title: '更新' },
      updateAvail
        ? h('div', null,
            h('div', { className: 'dsh-memory-badge' }, 'Update available → v' + latestVersion),
            h('div', { className: 'dsh-memory-note' },
              'npm install dsh-unified-agent-memory@latest'),
          )
        : h('div', { className: 'dsh-memory-note' },
            data === null ? 'Checking…'
              : data?.updateAvailable === null ? 'Registry unreachable — not checked.'
                : 'Up to date.',
          ),
    ),

    fetchError
      ? h('div', { className: 'dsh-memory-note' }, 'Polling paused — check host connection.')
      : null,
  )
}

// ── Sidebar button ─────────────────────────────────────────────────

export interface MemoryButtonProps {
  wide?: boolean
}

export function MemoryButton(props: MemoryButtonProps) {
  const wide = props.wide === true
  const [open, setOpen] = useState(false)
  const [hasUpdate, setHasUpdate] = useState(false)
  const [data, setData] = useState<StatusPayload | null>(null)
  const [fetchError, setFetchError] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)

  // Inject styles on mount, remove on unmount.
  useEffect(function () {
    return adoptStyles()
  }, [])

  // Single poll loop: feeds both the trigger badge and the sheet body, so the
  // route is hit once per interval regardless of how many instances mount.
  useEffect(function () {
    const abort = new AbortController()
    let timer: number | null = null

    const tick = function () {
      window
        .fetch(STATUS_URL, { signal: abort.signal, cache: 'no-store' })
        .then(function (r: Response) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json() as Promise<StatusPayload>
        })
        .then(function (d) {
          setData(d)
          setHasUpdate(d.updateAvailable === true)
          setFetchError(false)
        })
        .catch(function (err: Error) {
          if (err.name === 'AbortError') return
          setFetchError(true)
        })

      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }

    tick()

    return function () {
      abort.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  // Click-outside detection
  useEffect(function () {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return function () { document.removeEventListener('mousedown', onDown) }
  }, [open])

  return h(Fragment, null,
    h('button', {
      ref,
      className: 'dsh-memory-trigger',
      'data-wide': wide ? 'row' : 'rail',
      'data-open': open ? 'true' : 'false',
      title: hasUpdate ? 'Update available — Unified Memory' : 'Unified Memory status',
      onClick: function () { setOpen(!open) },
    }, h(MemoryGlyph, { size: wide ? 14 : 16, hasUpdate })),
    open ? h(MemorySheet, { data, fetchError }) : null,
  )
}
