/**
 * dsh-unified-agent-memory — the memory console: one search tab, four figures.
 *
 * Replaces the old read-only KV sheet, which showed system metadata (vault
 * path, pythonPath, remoteEnabled) the user never opened the sidebar to see.
 * Each tab answers a question the user actually asks:
 *
 *   search   — "I want to look something up"     → useSearch
 *   activity — "when do I actually use this?"    → CalendarHeatmap
 *   growth   — "is my library still growing?"    → GrowthChart
 *   makeup   — "what is it made of?"             → BreakdownDonut
 *   top      — "what do I keep coming back to?"  → TopBars
 *
 * The three list tabs (待处理 / 库全貌 / 系统) are gone: the figures answer
 * their questions from the aggregate feed with less plumbing, and the panes
 * that survived them are asserted in test/client-console to be unrunnable —
 * their call sites are gone, not merely unreferenced.
 *
 * Display decisions (empty-vs-unsupported copy, refusal wording, highlight
 * splitting, which tab carries the pending badge) live in `./view.ts` so they
 * can be unit-tested without a DOM.
 *
 * The four figures share ONE `useStats()` read: four calls would be four
 * requests per mount, and four payload copies that can drift between panes.
 *
 * @module src/client/Console
 */

import { h, useState } from '../deps.ts'
import type { SearchHit, StatsPayload } from './types.ts'
import { useSearch, useStats } from './store.ts'
import {
  BreakdownDonut, CalendarHeatmap, GrowthChart, TopBars,
} from './Figures.tsx'
import {
  CONSOLE_TABS, PENDING_BADGE_TAB, TAB_LABEL, highlightParts, searchFailureText,
} from './view.ts'
import type { TabId } from './view.ts'

export { CONSOLE_TABS }
export type { TabId }

/**
 * The tab id → pane renderer map.
 *
 * The strip draws a button per `CONSOLE_TABS` entry and looks the pane up
 * here, so the constant stays the single source of truth: adding a tab to
 * `CONSOLE_TABS` without giving it a pane is a type error, and the render path
 * holds no tab-id literal of its own that could drift from the constant.
 */
type PaneOf = (props: { status: ConsoleStatus | null; stats: StatsPayload }) => Child

/**
 * Tab id → pane renderer, and the shared feed every figure pane reads.
 *
 * The pane is handed the console's single `useStats()` result rather than
 * calling the hook itself: one request per mount, one payload, no chance of two
 * figures drawing from different reads of the same library.
 */
const TAB_PANE: Record<TabId, PaneOf> = {
  search: function SearchPane() { return h(SearchTab, null) },
  activity: function ActivityPane(props) {
    return h(CalendarHeatmap, { status: props.stats.status, data: props.stats.data })
  },
  growth: function GrowthPane(props) {
    return h(GrowthChart, { status: props.stats.status, data: props.stats.data })
  },
  makeup: function MakeupPane(props) {
    return h(BreakdownDonut, { status: props.stats.status, data: props.stats.data })
  },
  top: function TopPane(props) {
    return h(TopBars, { status: props.stats.status, data: props.stats.data })
  },
}

export interface ConsoleStats {
  memories?: number
  vectors?: number
  pending?: number
}

export interface ConsoleStatus {
  stats?: ConsoleStats | null
  vaultPath?: string | null
  version?: string | null
}

/** Anything `h()` accepts as a child. `deps.ts` exports no ReactNode type. */
type Child = ReturnType<typeof h> | string | number | boolean | null | undefined

// ── Primitives ──────────────────────────────────────────────────────

/** Tab strip. The pending count rides on `PENDING_BADGE_TAB` only — see view.ts. */
function TabBar(props: { active: TabId; onPick: (t: TabId) => void; pending: number }): Child {
  return h('div', { className: 'dsh-memory-tabs' },
    ...CONSOLE_TABS.map(function (t: TabId) {
      return h('button', {
        key: t,
        type: 'button',
        className: 'dsh-memory-tab',
        'data-active': props.active === t ? 'true' : 'false',
        'aria-selected': props.active === t ? 'true' : 'false',
        role: 'tab',
        onClick: function () { props.onPick(t) },
      },
        h('i', { className: 'dsh-memory-tab-dot' }),
        TAB_LABEL[t],
        // The count is the inbox queue, and the tab it rides on is the console's
        // only non-figure pane — so the number needs its subject spelled out.
        t === PENDING_BADGE_TAB && props.pending > 0
          ? h('span', { className: 'dsh-memory-pill', title: String(props.pending) + ' 条待处理' },
              String(props.pending))
          : null,
      )
    }))
}

/** One centred empty / unsupported state. */
function Empty(props: { title: string; hint?: string }): Child {
  return h('div', { className: 'dsh-memory-empty' },
    h('span', { className: 'dsh-memory-empty-glyph' }, '◇'),
    h('span', { className: 'dsh-memory-empty-title' }, props.title),
    props.hint ? h('em', { className: 'dsh-memory-empty-hint' }, props.hint) : null,
  )
}

/** Three pulsing bars — a loader that does not shift layout on arrival. */
function Skeleton(): Child {
  return h('div', { className: 'dsh-memory-skeleton' },
    ...[0, 1, 2].map(function (i) {
      return h('span', { key: i, className: 'dsh-memory-skeleton-row' })
    }))
}

/** An inline failure with an optional retry affordance.
 *
 *  The banner is NEUTRAL-filled with a red stroke and this red glyph; the body
 *  text is `label-primary`. Three carriers of "error" and no contrast debt —
 *  a coloured fill behind coloured text could not clear AA body text. */
function Failure(props: { text: string; onRetry?: () => void }): Child {
  return h('div', { className: 'dsh-memory-failure' },
    h('span', { className: 'dsh-memory-failure-glyph', 'aria-hidden': 'true' }, '⚠'),
    h('span', { className: 'dsh-memory-failure-text' }, props.text),
    props.onRetry
      ? h('button', {
          type: 'button',
          className: 'dsh-memory-action',
          onClick: props.onRetry,
        }, '重试')
      : null,
  )
}

/** One search hit: type bar, highlighted doc name, trailing title. */
function Hit(props: { hit: SearchHit; query: string }): Child {
  const parts = highlightParts(props.hit.doc, props.query)
  return h('div', { className: 'dsh-memory-row' },
    h('i', { className: 'dsh-memory-bar dsh-memory-bar-doc' }),
    h('span', { className: 'dsh-memory-rowname' },
      ...parts.map(function (p, i) {
        return p.hit
          ? h('mark', { key: i }, p.text)
          : h('span', { key: i }, p.text)
      })),
    h('span', { className: 'dsh-memory-rowmeta' }, props.hit.title),
  )
}

// ── Tabs ────────────────────────────────────────────────────────────

function SearchTab(): Child {
  const [query, setQuery] = useState('')
  const [hybrid, setHybrid] = useState(false)
  const search = useSearch()

  function submit(): void {
    const q = query.trim()
    if (q) search.run(q, hybrid)
  }

  return h('div', { className: 'dsh-memory-pane' },
    h('div', { className: 'dsh-memory-search' },
      h('span', { className: 'dsh-memory-search-glyph' }, '◇'),
      h('input', {
        className: 'dsh-memory-search-input',
        value: query,
        placeholder: '搜索记忆库…',
        'aria-label': '搜索记忆库',
        onInput: function (e: { target?: { value?: string } }) {
          setQuery(String(e.target?.value ?? ''))
        },
        onKeyDown: function (e: { key?: string }) { if (e.key === 'Enter') submit() },
      }),
      h('button', {
        type: 'button',
        className: 'dsh-memory-toggle',
        'data-on': hybrid ? 'true' : 'false',
        'aria-pressed': hybrid ? 'true' : 'false',
        onClick: function () { setHybrid(!hybrid) },
      }, 'hybrid'),
    ),
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' },
        '结果',
        h('b', null, hybrid ? 'hybrid' : 'local'),
        h('span', { className: 'dsh-memory-cardcount' },
          String(search.results.length) + ' hits')),
      search.busy
        ? h(Skeleton, null)
        : search.error
          ? h(Failure, {
              text: searchFailureText(),
              onRetry: submit,
            })
          : search.results.length === 0
            ? h(Empty, { title: '没有匹配的记忆', hint: '换个关键词，或打开 hybrid 试试' })
            : h('div', { className: 'dsh-memory-rows' },
                ...search.results.map(function (r: SearchHit) {
                  return h(Hit, { key: r.doc, hit: r, query: query.trim() })
                })),
    ))
}

// ── Console ─────────────────────────────────────────────────────────

/** The five-tab console. Every pane reads the payload the caller already holds. */
export function Console(props: { status?: ConsoleStatus | null }): Child {
  const [active, setActive] = useState<TabId>(CONSOLE_TABS[0])
  const pending = props.status?.stats?.pending ?? 0
  const status = props.status ?? null
  const stats = useStats()
  const Pane = TAB_PANE[active]

  return h('div', { className: 'dsh-memory-console' },
    h(TabBar, { active, onPick: setActive, pending }),
    h(Pane, { status, stats }),
  )
}
