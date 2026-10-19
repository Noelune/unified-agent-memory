/**
 * dsh-unified-agent-memory — the memory console.
 *
 * Four panes, ordered by how often a person needs them:
 *
 *   inbox  — "is anything waiting for me?"   → the queue, with actions
 *   search — "I want to look something up"   → useSearch
 *   health — "is the library working?"       → counts, index, conflicts, prefix
 *   stats  — "how do I actually use this?"   → the four figures, demoted
 *
 * The inbox comes first because it is the only pane with a WRITE control. An
 * earlier revision led with four charts and put the pending count on the search
 * tab: a number you could see, could not click, and could not act on. The
 * figures are still here — they answer a real question — but a side panel that
 * opens on a heatmap is a dashboard, not a tool.
 *
 * Display decisions (empty-vs-unsupported copy, refusal wording, age text,
 * health rows, which tab carries the badge) live in `./view.ts` so they can be
 * unit-tested without a DOM.
 *
 * The four figures share ONE `useStats()` read: four calls would be four
 * requests per mount, and four payload copies that can drift between panes.
 *
 * @module src/client/Console
 */

import { h, useState } from '../deps.ts'
import type { SearchHit, StatsPayload } from './types.ts'
import { dismissItem, loadNote, usePreview, useSearch, useStats } from './store.ts'
import {
  BreakdownDonut, CalendarHeatmap, GrowthChart, TopBars,
} from './Figures.tsx'
import {
  CONSOLE_TABS, PENDING_BADGE_TAB, TAB_LABEL, dismissReasonText, healthRows,
  highlightParts, inboxSummary, noteDigest, oldestFirst, previewEmptyText,
  relativeAge, searchFailureText,
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
  inbox: function InboxPane() { return h(InboxTab, null) },
  search: function SearchPane() { return h(SearchTab, null) },
  health: function HealthPane(props) {
    return h(HealthTab, { status: props.status, stats: props.stats })
  },
  stats: function StatsPane(props) {
    return h(StatsTab, { stats: props.stats })
  },
}

export interface ConsoleStats {
  memories?: number
  vectors?: number
  pending?: number
}

/**
 * The slice of `/status` the console reads.
 *
 * Every field is optional and nullable on purpose: the payload is assembled
 * host-side from a config and a core read, and either can be missing. The panes
 * render "—" for an absent reading rather than inventing a zero.
 */
export interface ConsoleStatus {
  stats?: ConsoleStats | null
  vaultPath?: string | null
  version?: string | null
  index?: { ok: boolean } | null
  agentName?: string | null
  agentSource?: string | null
  recall?: { mode?: string | null } | null
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
        // The count is the inbox queue, and the tab it rides on IS that queue
        // — so the digit and the list it counts are one thing. `title` still
        // spells the subject out for a reader who arrives at the badge cold.
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

// ── Inbox ───────────────────────────────────────────────────────────

/**
 * The queue: every submission waiting for a human, oldest first.
 *
 * Three affordances, and each exists because its absence made the pane useless
 * in a different way:
 *
 *   - 查看 reads the submission through `/note`. A list of file names is a list
 *     of things you cannot judge, and judging IS the task.
 *   - 归档 moves one entry to `已处理/`. This is the panel's only write, and
 *     without it "待确认" was a number with no way to lower it.
 *   - the age column. "3 条" tells you the size of the queue; "3 条，最老 21 天"
 *     tells you whether to open the panel at all.
 *
 * A refusal is shown, not swallowed: `dismissItem` resolves a reason
 * (`outside-inbox`, `not-found`, `unavailable`), which says both what happened
 * and whether trying again could help.
 */
function InboxTab(): Child {
  const preview = usePreview('pending')
  const [openName, setOpenName] = useState<string | null>(null)
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  const items = oldestFirst(preview.data?.items ?? [])
  const summary = inboxSummary(items, Date.now())
  const empty = previewEmptyText(preview.data)

  function toggle(name: string): void {
    if (openName === name) { setOpenName(null); return }
    setOpenName(name)
    setBodyError(null)
    if (bodies[name] !== undefined) return
    loadNote(name).then(function (r) {
      if (!r.ok) { setBodyError(dismissReasonText(r.reason)); return }
      setBodies(function (prev) {
        const next: Record<string, string> = {}
        for (const k of Object.keys(prev)) next[k] = prev[k]
        next[name] = r.body ?? ''
        return next
      })
    })
  }

  function retire(name: string): void {
    setWorking(name)
    setRefusal(null)
    dismissItem(name).then(function (r) {
      setWorking(null)
      if (!r.ok) { setRefusal(dismissReasonText(r.reason)); return }
      setOpenName(null)
      preview.reload()
    })
  }

  return h('div', { className: 'dsh-memory-pane' },
    refusal ? h(Failure, { text: refusal }) : null,
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' },
        '待确认',
        h('span', { className: 'dsh-memory-cardcount' }, summary.text)),
      preview.busy
        ? h(Skeleton, null)
        : !preview.data
          // A null payload after a settled load is a failed read, not an empty
          // queue — the same distinction `previewEmptyText` guards, one level up.
          ? h(Failure, { text: '待确认列表读不到，记忆核心暂不可用', onRetry: preview.reload })
          : empty
            ? h(Empty, { title: empty.title, hint: empty.hint })
            : h('div', { className: 'dsh-memory-rows' },
              ...items.map(function (it) {
                const expanded = openName === it.name
                const known = bodies[it.name]
                return h('div', { key: it.name, className: 'dsh-memory-item' },
                  h('div', { className: 'dsh-memory-row' },
                    h('i', { className: 'dsh-memory-bar dsh-memory-bar-doc' }),
                    h('span', { className: 'dsh-memory-rowname' }, it.name),
                    h('span', { className: 'dsh-memory-rowmeta' },
                      relativeAge(it.mtime, Date.now())),
                    h('button', {
                      type: 'button',
                      className: 'dsh-memory-action',
                      'aria-expanded': expanded ? 'true' : 'false',
                      onClick: function () { toggle(it.name) },
                    }, expanded ? '收起' : '查看'),
                    h('button', {
                      type: 'button',
                      className: 'dsh-memory-action',
                      disabled: working === it.name,
                      title: '移到 已处理/，不会删除',
                      onClick: function () { retire(it.name) },
                    }, working === it.name ? '处理中…' : '归档'),
                  ),
                  expanded
                    ? h('div', { className: 'dsh-memory-body' },
                        bodyError ?? (known === undefined ? '读取中…' : noteDigest(known) || '（空）'))
                    : null,
                )
              })),
    ))
}

// ── Search ──────────────────────────────────────────────────────────

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

// ── Health ──────────────────────────────────────────────────────────

/**
 * The library's own vitals, in the order a broken install would show them.
 *
 * The conflict count is a second read (`conflicts` view) fired when this pane
 * mounts — not on every panel open, since it costs a core call and the answer
 * only matters to someone already asking about health. `null` means "could not
 * be read", which renders as "—" and is deliberately not 0.
 */
function HealthTab(props: { status: ConsoleStatus | null; stats: StatsPayload }): Child {
  const conflicts = usePreview('conflicts')
  const rows = healthRows({
    stats: props.status?.stats ?? null,
    indexOk: props.status?.index?.ok ?? null,
    conflicts: conflicts.data && conflicts.data.status === 'ok' ? conflicts.data.count : null,
    recallMode: props.status?.recall?.mode ?? null,
    agentName: props.status?.agentName ?? null,
    agentSource: props.status?.agentSource ?? null,
    version: props.status?.version ?? null,
  })

  return h('div', { className: 'dsh-memory-pane' },
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' }, '运行状态'),
      h('div', { className: 'dsh-memory-rows' },
        ...rows.map(function (r) {
          return h('div', {
            key: r.key,
            className: 'dsh-memory-row',
            'data-tone': r.tone,
          },
            h('i', { className: 'dsh-memory-bar' }),
            h('span', { className: 'dsh-memory-rowname' }, r.label),
            h('span', { className: 'dsh-memory-rowmeta' }, r.value),
          )
        })),
    ))
}

// ── Figures ─────────────────────────────────────────────────────────

/** The four figures, stacked in one scrollable pane — the old tab-per-chart. */
function StatsTab(props: { stats: StatsPayload }): Child {
  return h('div', { className: 'dsh-memory-pane dsh-memory-pane-scroll' },
    h(CalendarHeatmap, { status: props.stats.status, data: props.stats.data }),
    h(GrowthChart, { status: props.stats.status, data: props.stats.data }),
    h(BreakdownDonut, { status: props.stats.status, data: props.stats.data }),
    h(TopBars, { status: props.stats.status, data: props.stats.data }),
  )
}

// ── Console ─────────────────────────────────────────────────────────

/** The four-pane console. Every pane reads the payload the caller already holds. */
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
