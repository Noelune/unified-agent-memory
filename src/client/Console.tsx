/**
 * dsh-unified-agent-memory — four-tab memory console.
 *
 * Replaces the old read-only KV sheet, which showed system metadata (vault
 * path, pythonPath, remoteEnabled) the user never opened the sidebar to see.
 * Each tab answers a question the user actually asks:
 *
 *   search — "I want to look something up"      → useSearch
 *   inbox  — "what did an agent just write?"    → usePreview('pending')
 *   vault  — "what does my library look like?"  → usePreview('recent') + stats
 *   system — "is anything broken?"              → status payload
 *
 * Display decisions (empty-vs-unsupported copy, refusal wording, highlight
 * splitting) live in `./view.ts` so they can be unit-tested without a DOM.
 *
 * Every tab owns its own data loading; nothing here polls except the status
 * payload the caller already holds.
 *
 * @module src/client/Console
 */

import { h, useState } from '../deps.ts'
import type { SearchHit } from './types.ts'
import { dismissItem, usePreview, useSearch } from './store.ts'
import {
  CONSOLE_TABS, TAB_LABEL, dismissReasonText, highlightParts, previewEmptyText,
  searchFailureText,
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
type PaneOf = (props: { status: ConsoleStatus | null }) => Child

const TAB_PANE: Record<TabId, PaneOf> = {
  search: function SearchPane() { return h(SearchTab, null) },
  inbox: function InboxPane(props) {
    return h('div', { className: 'dsh-memory-pane' },
      h(StatusStrip, { status: props.status }),
      h(ListTab, { view: 'pending', head: '提交区 · 等待晋升' }))
  },
  vault: function VaultPane(props) {
    return h(VaultTab, {
      stats: props.status?.stats ?? null,
      version: props.status?.version ?? '—',
    })
  },
  system: function SystemPane(props) { return h(SystemTab, { status: props.status }) },
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

/** Tab strip. The pending count rides on the inbox tab only. */
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
        t === 'inbox' && props.pending > 0
          ? h('span', { className: 'dsh-memory-pill' }, String(props.pending))
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

function ListTab(props: {
  view: 'pending' | 'recent'
  head: string
}): Child {
  const { data, busy, reload } = usePreview(props.view)
  const [refusal, setRefusal] = useState('')

  function onDismiss(name: string): void {
    setRefusal('')
    // `dismissItem` resolves a boolean per its declared signature, but the host
    // also carries a refusal reason on the wire; surface the boolean verdict and
    // a readable sentence rather than silently doing nothing on refusal.
    dismissItem(name).then(function (ok: boolean) {
      if (ok) { reload(); return }
      setRefusal(dismissReasonText('not-found'))
    })
  }

  const items = data?.items ?? []
  const empty = previewEmptyText(data)

  return h('div', { className: 'dsh-memory-pane' },
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' },
        props.head,
        h('span', { className: 'dsh-memory-cardcount' },
          String(items.length) + ' items')),
      refusal ? h(Failure, { text: refusal }) : null,
      busy
        ? h(Skeleton, null)
        : empty
          ? h(Empty, { title: empty.title, hint: empty.hint })
          : h('div', { className: 'dsh-memory-rows' },
              ...items.map(function (it) {
                return h('div', { key: it.name, className: 'dsh-memory-row' },
                  h('i', { className: 'dsh-memory-bar dsh-memory-bar-doc' }),
                  h('span', { className: 'dsh-memory-rowname' }, it.name),
                  props.view === 'pending'
                    ? h('button', {
                        type: 'button',
                        className: 'dsh-memory-action',
                        title: '移入已处理',
                        onClick: function () { onDismiss(it.name) },
                      }, '已处理')
                    : null,
                )
              })),
    ))
}

function VaultTab(props: { stats: ConsoleStats | null; version: string }): Child {
  const s = props.stats
  /** A count that was never reported renders as "—", never as 0. */
  function n(v: number | undefined): string {
    return v === undefined || v === null ? '—' : String(v)
  }
  return h('div', { className: 'dsh-memory-pane' },
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' }, '规模'),
      h('div', { className: 'dsh-memory-stats' },
        h('div', { className: 'dsh-memory-stat' },
          h('b', null, n(s?.memories)), h('span', null, 'memories')),
        h('div', { className: 'dsh-memory-stat' },
          h('b', null, n(s?.vectors)), h('span', null, 'vectors')),
        h('div', { className: 'dsh-memory-stat' },
          h('b', null, n(s?.pending)), h('span', null, 'pending')),
      )),
    h('div', { className: 'dsh-memory-card' },
      h('div', { className: 'dsh-memory-cardhead' }, '最近更新'),
      h(RecentList, null)),
  )
}

function RecentList(): Child {
  const { data, busy } = usePreview('recent')
  const items = (data?.items ?? []).slice(0, 6)
  const empty = previewEmptyText(data)
  if (busy) return h(Skeleton, null)
  if (empty) return h(Empty, { title: empty.title, hint: empty.hint })
  return h('div', { className: 'dsh-memory-rows' },
    ...items.map(function (it) {
      return h('div', { key: it.name, className: 'dsh-memory-row' },
        h('i', { className: 'dsh-memory-bar dsh-memory-bar-doc' }),
        h('span', { className: 'dsh-memory-rowname' }, it.name),
        h('span', { className: 'dsh-memory-rowmeta' }, 'md'),
      )
    }))
}

function SystemTab(props: { status: ConsoleStatus | null }): Child {
  const s = props.status
  const vault = s?.vaultPath
  const ok = typeof vault === 'string' && vault.length > 0
  return h('div', { className: 'dsh-memory-pane' },
    h('div', { className: 'dsh-memory-card dsh-memory-card-lead' },
      h('div', { className: 'dsh-memory-cardhead' }, '系统'),
      h('div', { className: 'dsh-memory-row' },
        h('i', {
          className: 'dsh-memory-bar '
            + (ok ? 'dsh-memory-bar-ok' : 'dsh-memory-bar-warn'),
        }),
        h('span', { className: 'dsh-memory-rowname' },
          ok ? 'vault connected' : 'vaultPath 未配置'),
        h('span', { className: 'dsh-memory-rowmeta' }, ok ? 'ok' : 'warn')),
      h('div', { className: 'dsh-memory-row' },
        h('i', { className: 'dsh-memory-bar' }),
        h('span', { className: 'dsh-memory-rowname' }, 'vault path'),
        h('span', { className: 'dsh-memory-rowmeta' }, vault ?? '—')),
      h('div', { className: 'dsh-memory-row' },
        h('i', { className: 'dsh-memory-bar' }),
        h('span', { className: 'dsh-memory-rowname' }, 'version'),
        h('span', { className: 'dsh-memory-rowmeta' }, s?.version ?? '—')),
    ))
}

// ── Console ─────────────────────────────────────────────────────────

/** The four-tab console. Each tab owns its own data loading. */
export function Console(props: { status?: ConsoleStatus | null }): Child {
  const [active, setActive] = useState<TabId>(CONSOLE_TABS[0])
  const pending = props.status?.stats?.pending ?? 0
  const status = props.status ?? null
  const Pane = TAB_PANE[active]

  return h('div', { className: 'dsh-memory-console' },
    h(TabBar, { active, onPick: setActive, pending }),
    h(Pane, { status }),
  )
}

/** The status summary the inbox tab carries above its list. */
function StatusStrip(props: { status: ConsoleStatus | null }): Child {
  const s = props.status
  const vault = s?.vaultPath
  const ok = typeof vault === 'string' && vault.length > 0
  if (!s) return null
  return h('div', { className: 'dsh-memory-card' },
    h('div', { className: 'dsh-memory-cardhead' }, '连接'),
    h('div', { className: 'dsh-memory-row' },
      h('i', {
        className: 'dsh-memory-bar '
          + (ok ? 'dsh-memory-bar-ok' : 'dsh-memory-bar-warn'),
      }),
      h('span', { className: 'dsh-memory-rowname' },
        ok ? 'vault connected' : 'vaultPath 未配置'),
      h('span', { className: 'dsh-memory-rowmeta' }, s.version ?? '—')),
  )
}
