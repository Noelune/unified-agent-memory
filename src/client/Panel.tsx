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
import { runUpdate, setOpen, useMemoryOpen, useMemoryState, useUpdateProgress } from './store.ts'
import { updateBadge, updateLine, updateNotice } from './view.ts'

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
  const progress = useUpdateProgress()
  // The npm check reports what the registry has; the sheet used to render only
  // the installed version, so "an update exists" was a 6px dot on the sidebar
  // glyph and a tooltip. Someone who never hovered it had no way to learn the
  // number, let alone what to do about it.
  const notice = updateNotice(data?.latestVersion, data?.updateAvailable)
  // The note is the phase's sentence when an install has run, and the notice's
  // own sentence otherwise. See `updateLine` for why the phase wins.
  const line = updateLine(notice, progress)

  return h('div', { className: 'dsh-memory-sheet' },
    h('div', { className: 'dsh-memory-head' },
      h('h3', { className: 'dsh-memory-title' }, 'Unified Memory'),
      h('span', {
        className: 'dsh-memory-ver',
        'data-update': notice.next ? 'true' : 'false',
      },
        'v' + show(data?.version),
        notice.next ? h('span', { className: 'dsh-memory-ver-next' }, ' → v' + notice.next) : null,
      ),
    ),

    // The whole payload, not a hand-picked subset: the health pane reads the
    // prefix, the recall mode and the index flag, and a subset assembled here
    // would silently drop each new field the console learns to use.
    h(Console, { status: data ?? null }),

    line
      ? h('div', { className: 'dsh-memory-note', 'data-phase': progress.phase }, line)
      : null,

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
 * The small inline action beside Settings.
 *
 * It is two controls in one, because the seat is one button:
 *
 *  - **no update waiting** → it toggles the panel, which is what a footer icon
 *    is expected to do;
 *  - **an update waiting** → it installs, and opens the panel so the progress
 *    and the result are visible. Opening is not incidental: the sheet is where
 *    the reason for a failure is printed, and a click that failed silently
 *    would just look broken.
 *
 * The text label is drawn only in the wide sidebar. The rail seat is a 36px
 * icon, so four characters there would either wrap or push the neighbouring
 * actions over; the rail keeps the 6px dot and the tooltip.
 */
export function MemoryTrigger(props: MemoryButtonProps) {
  const wide = props.wide === true
  const open = useMemoryOpen()
  const { data } = useMemoryState()
  const progress = useUpdateProgress()
  const notice = updateNotice(data?.latestVersion, data?.updateAvailable)
  const badge = updateBadge(notice, progress)

  return h('button', {
    className: 'dsh-memory-trigger',
    'data-wide': wide ? 'row' : 'rail',
    'data-open': open ? 'true' : 'false',
    title: badge.title,
    onClick: function () {
      if (badge.installs) {
        setOpen(true)
        void runUpdate()
        return
      }
      if (open) setOpen(false)
      else setOpen(true)
    },
  },
    h(MemoryGlyph, { size: wide ? 14 : 16, hasUpdate: data?.updateAvailable === true }),
    wide && badge.label !== null
      ? h('span', { className: 'dsh-memory-badge' }, badge.label)
      : null,
  )
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
