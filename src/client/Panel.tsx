/**
 * dsh-unified-agent-memory — sidebar status panel component.
 *
 * Renders a glyph button in the sidebar footer that opens a status panel
 * showing vault configuration and health info, polled from the host route.
 *
 * Read-only: no memory content is displayed.
 *
 * @module src/client/Panel
 */

import { h, Fragment, useState, useEffect, useRef } from '../deps.ts'
import { adoptStyles } from './styles.ts'

// ── Constants ───────────────────────────────────────────────────────

const STATUS_URL = '/api/dsh-unified-agent-memory/status'
const POLL_INTERVAL_MS = 10000

// ── Icon glyph ──────────────────────────────────────────────────────

function MemoryGlyph({ size = 16 }: { size?: number }) {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M3 2.5h10v3H3z' }),
    h('path', { d: 'M3 8.5h10v3H3z' }),
    h('path', { d: 'M5.5 1.5v2M10.5 1.5v2M5.5 7.5v2M10.5 7.5v2' }),
  )
}

// ── Status panel ────────────────────────────────────────────────────

function MemoryPanel() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(false)

  useEffect(function () {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | number | null = null

    const tick = function () {
      setLoading(true)
      window
        .fetch(STATUS_URL, { signal: abort.signal, cache: 'no-store' })
        .then(function (r: Response) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json() as Promise<Record<string, unknown>>
        })
        .then(function (data) {
          setText(JSON.stringify(data, null, 2))
          setFetchError(false)
        })
        .catch(function (err: Error) {
          if (err.name === 'AbortError') return
          setFetchError(true)
          // Keep existing text on transient errors; only blank on first load
          if (!text) setText('status route unreachable — plugin tools still work via chat')
        })
        .finally(function () {
          setLoading(false)
        })

      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }

    tick()

    return function () {
      abort.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  return h('div', { className: 'dsh-memory-panel' },
    h('h3', null, 'Unified Memory'),
    h('div', { className: 'dsh-memory-note' },
      loading && !text
        ? 'Loading…'
        : text || 'status route unavailable — run memory_status from chat',
    ),
    h('div', { className: 'dsh-memory-row' },
      h('span', { className: 'k' }, 'Write path'),
      h('span', null, 'Agent\u63d0\u4ea4\u533a via memory_submit'),
    ),
    fetchError
      ? h('div', {
          className: 'dsh-memory-row',
          style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
        },
          h('span', null, 'Polling paused — check host connection'),
        )
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
  const ref = useRef<HTMLButtonElement | null>(null)

  // Inject styles on mount, remove on unmount.
  useEffect(function () {
    return adoptStyles()
  }, [])

  // Click-outside detection
  useEffect(function () {
    if (!open) return

    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
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
      title: 'Unified Memory status',
      onClick: function () { setOpen(!open) },
    }, h(MemoryGlyph, { size: wide ? 14 : 16 })),
    open ? h(MemoryPanel, null) : null,
  )
}