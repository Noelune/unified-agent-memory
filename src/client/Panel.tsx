/**
 * dsh-unified-agent-memory — sidebar console shell.
 *
 * Renders a glyph trigger in the sidebar footer that opens a floating sheet.
 * The sheet body is the four-tab {@link Console}; this module owns only the
 * chrome around it (trigger, overlay layer, click-outside, styles injection).
 *
 * @module src/client/Panel
 */

import { h, useEffect, useRef } from '../deps.ts'
import { Console } from './Console.tsx'
import { adoptStyles } from './styles.ts'
import { setOpen, toggleOpen, useMemoryOpen, useMemoryState } from './store.ts'

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
            background: 'var(--dsw-alias-state-error-primary)',
          },
        })
      : null,
  )
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
 * The sheet body. Registered as its own occupant of `shell.overlay`, so it
 * reads the shared store rather than receiving props from the trigger.
 *
 * The old read-only KV groups (vault path / pythonPath / corePath /
 * remoteEnabled / update) are gone: they answered no daily question, which is
 * the complaint this console exists to fix. Their live bits — vault health and
 * version — moved into the system tab of {@link Console}.
 */
export function MemorySheet() {
  const { data, fetchError } = useMemoryState()

  return h('div', { className: 'dsh-memory-sheet' },
    h('div', { className: 'dsh-memory-head' },
      h('h3', { className: 'dsh-memory-title' }, 'Unified Memory'),
      h('span', { className: 'dsh-memory-ver' }, 'v' + show(data?.version)),
    ),

    h(Console, {
      status: {
        stats: data?.stats ?? null,
        vaultPath: data?.vaultPath ?? null,
        version: data?.version ?? null,
      },
    }),

    fetchError
      ? h('div', { className: 'dsh-memory-note' }, '轮询已暂停 — 请检查宿主连接。')
      : null,
  )
}

// ── Sidebar trigger (registered in sidebar.footer.action) ──────────

export interface MemoryButtonProps {
  wide?: boolean
}

/**
 * The small inline action beside Settings. It only toggles the shared store —
 * the sheet itself lives in `shell.overlay`, since a frame-wide floating
 * surface does not belong in an inline action seat.
 */
export function MemoryTrigger(props: MemoryButtonProps) {
  const wide = props.wide === true
  const open = useMemoryOpen()
  const { data } = useMemoryState()
  const hasUpdate = data?.updateAvailable === true

  return h('button', {
    className: 'dsh-memory-trigger',
    'data-wide': wide ? 'row' : 'rail',
    'data-open': open ? 'true' : 'false',
    title: hasUpdate ? 'Update available — Unified Memory' : 'Unified Memory status',
    onClick: function () { toggleOpen() },
  }, h(MemoryGlyph, { size: wide ? 14 : 16, hasUpdate }))
}

/**
 * The overlay cell: a click-through layer needs its own wrapper to opt back
 * into pointer events, and it renders nothing at all while closed.
 */
export function MemoryOverlay() {
  const open = useMemoryOpen()
  const ref = useRef<HTMLDivElement | null>(null)

  // Inject styles on mount, remove on unmount.
  useEffect(function () {
    return adoptStyles()
  }, [])

  // Click-outside detection: closing on a press outside the sheet.
  useEffect(function () {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return function () { document.removeEventListener('mousedown', onDown) }
  }, [open])

  if (!open) return null
  return h('div', { className: 'dsh-memory-layer', ref }, h(MemorySheet, null))
}

/** Kept as the default export name for the footer seat registration. */
export { MemoryTrigger as MemoryButton }
