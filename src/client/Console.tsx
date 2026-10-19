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
import { dismissItem, loadDoc, loadNote, useDoctor, usePreview, useRepair, useSearch, useStats } from './store.ts'
import type { RepairApi, RepairEntry } from './store.ts'
import {
  BreakdownDonut, CalendarHeatmap, GrowthChart, TopBars,
} from './Figures.tsx'
import {
  COMMAND_NOTE, CONSOLE_TABS, PENDING_BADGE_TAB, SEVERITY_LABEL, TAB_LABEL,
  dismissReasonText, healthFindings, healthRows, healthSummary, highlightParts,
  inboxSummary, issueTitle, noteDigest, oldestFirst, openFailureText, previewEmptyText,
  relativeAge, rowFindings, searchFailureText, splitHealth, statKpis,
} from './view.ts'
import type { HealthFinding, TabId } from './view.ts'

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
/**
 * The shape `useStats()` returns, reused so a pane can offer `reload`.
 *
 * Declaring the pane's feed as a bare `StatsPayload` would type-check while the
 * object handed in also carries `reload` — and then the 统计 pane could not
 * offer a retry button, because the only type it knows about does not have one.
 */
type StatsFeed = ReturnType<typeof useStats>

type PaneOf = (props: { status: ConsoleStatus | null; stats: StatsFeed }) => Child

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

/**
 * One search hit: type bar, highlighted doc name, trailing title, open toggle.
 *
 * The toggle is the difference between a search result and a search RESULT you
 * can use. `doc` is a file name; without a reader, every hit ends at "this note
 * matched", which is the one thing the user already knew.
 *
 * The opened body shows the whole note, not a digest: `noteDigest` exists to
 * keep a queue scannable, while opening a document is a request to read it.
 * The path is printed above the text so the note can be taken to an editor —
 * the panel cannot hand a file to the host, so naming it is the handoff.
 */
function Hit(props: {
  hit: SearchHit
  query: string
  open: boolean
  loading: boolean
  body: string | null
  path: string | null
  error: string | null
  onToggle: () => void
}): Child {
  const parts = highlightParts(props.hit.doc, props.query)
  return h('div', { className: 'dsh-memory-item' },
    h('div', { className: 'dsh-memory-row' },
      h('i', { className: 'dsh-memory-bar dsh-memory-bar-doc' }),
      h('span', { className: 'dsh-memory-rowname' },
        ...parts.map(function (p, i) {
          return p.hit
            ? h('mark', { key: i }, p.text)
            : h('span', { key: i }, p.text)
        })),
      h('span', { className: 'dsh-memory-rowmeta' }, props.hit.title),
      h('button', {
        type: 'button',
        className: 'dsh-memory-action',
        'aria-expanded': props.open ? 'true' : 'false',
        onClick: props.onToggle,
      }, props.open ? '收起' : '打开'),
    ),
    props.open
      ? h('div', { className: 'dsh-memory-body dsh-memory-doc' },
          props.error
            ? props.error
            : props.loading
              ? '读取中…'
              : h('span', null,
                  props.path
                    ? h('span', { className: 'dsh-memory-docpath' }, props.path)
                    : null,
                  props.body || '（空文档）',
                ))
      : null,
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

/**
 * Look something up, then READ it.
 *
 * The pane used to stop at the hit list. Search returns a note's file NAME and
 * title, which is enough to recognise a note and not enough to use one, so
 * every hit now carries an 打开 toggle that fetches the note through `/doc` and
 * renders it inline.
 *
 * Per-hit state is kept in two maps keyed by file name: `openName` is the single
 * expanded row (one at a time — two open documents in a 380px panel is a scroll
 * fight), and `docs` caches what was read so re-opening costs nothing and does
 * not re-hit the core.
 */
function SearchTab(): Child {
  const [query, setQuery] = useState('')
  const [hybrid, setHybrid] = useState(false)
  const [openName, setOpenName] = useState<string | null>(null)
  const [docs, setDocs] = useState<Record<string, { body: string | null; path: string | null }>>({})
  const [docError, setDocError] = useState<string | null>(null)
  const [docBusy, setDocBusy] = useState(false)
  const search = useSearch()

  function submit(): void {
    const q = query.trim()
    if (q) search.run(q, hybrid)
  }

  function toggle(name: string): void {
    if (openName === name) { setOpenName(null); return }
    setOpenName(name)
    setDocError(null)
    if (docs[name] !== undefined) return
    setDocBusy(true)
    loadDoc(name).then(function (r) {
      setDocBusy(false)
      if (!r.ok) { setDocError(openFailureText(r.reason)); return }
      setDocs(function (prev) {
        const next: Record<string, { body: string | null; path: string | null }> = {}
        for (const k of Object.keys(prev)) next[k] = prev[k]
        next[name] = { body: r.body, path: r.path }
        return next
      })
    })
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
                  const open = openName === r.doc
                  const doc = docs[r.doc]
                  return h(Hit, {
                    key: r.doc,
                    hit: r,
                    query: query.trim(),
                    open,
                    loading: open && docBusy && doc === undefined,
                    body: doc?.body ?? null,
                    path: doc?.path ?? null,
                    error: open ? docError : null,
                    onToggle: function () { toggle(r.doc) },
                  })
                })),
    ))
}

// ── Health ──────────────────────────────────────────────────────────

/**
 * The library's own vitals: a verdict, four counts, then the configuration.
 *
 * Three visual groups, because the previous version was eight identical rows
 * and left the reader to decide which of them mattered:
 *
 *   - a headline (`healthSummary`) that states the conclusion — "运行正常" or
 *     "2 项需要处理" with the offending labels named, so the verdict is
 *     auditable instead of decorative;
 *   - the four counts as large figures, since a count is read at a glance and a
 *     count in 13px grey beside a config string reads as the same kind of fact;
 *   - the config rows (index / recall / prefix / version) as label→value pairs,
 *     which is what they are.
 *
 * The conflict count is a second read (`conflicts` view) fired when this pane
 * mounts — not on every panel open, since it costs a core call and the answer
 * only matters to someone already asking about health. `null` means "could not
 * be read", which renders as "—" and is deliberately not 0.
 */
function HealthTab(props: { status: ConsoleStatus | null; stats: StatsPayload }): Child {
  const conflicts = usePreview('conflicts')
  const doctor = useDoctor()
  const rows = healthRows({
    stats: props.status?.stats ?? null,
    indexOk: props.status?.index?.ok ?? null,
    conflicts: conflicts.data && conflicts.data.status === 'ok' ? conflicts.data.count : null,
    recallMode: props.status?.recall?.mode ?? null,
    agentName: props.status?.agentName ?? null,
    agentSource: props.status?.agentSource ?? null,
    version: props.status?.version ?? null,
  })
  const summary = healthSummary(rows)
  const groups = splitHealth(rows)

  // The doctor's list wins when it ran: it sees duplicates, bloat and orphan
  // indexes that the status rows cannot. The row-derived list is a fallback for
  // "the doctor never ran", never a supplement — both describe the same
  // conflicts, and printing them twice reads as two separate problems.
  const findings = doctor.status === 'ok'
    ? healthFindings(doctor.issues, doctor.counts)
    : doctor.status === 'unavailable'
      ? rowFindings(rows)
      : []
  const hasCommand = findings.some(function (f) { return f.command !== null })

  const vault = props.status?.vaultPath
  const repair = useRepair({
    doctorStatus: doctor.status,
    issues: doctor.issues,
    onVerify: doctor.reload,
    env: {
      // "(not set)" is the route's placeholder for an unconfigured host, not a
      // directory — passing it through would put a path that does not exist
      // into the brief, which is worse than admitting we do not know it.
      vault: !vault || vault === '(not set)' ? null : vault,
      coreVersion: props.status?.version ?? 'unknown',
      counts: doctor.counts,
    },
  })
  const inFlight = Object.keys(repair.entries).filter(function (code) {
    const phase = repair.entries[code].phase
    return phase === 'sending' || phase === 'sent' || phase === 'running' || phase === 'verifying'
  }).length

  return h('div', { className: 'dsh-memory-pane dsh-memory-pane-scroll' },
    h('div', { className: 'dsh-memory-health', 'data-tone': summary.tone },
      h('i', { className: 'dsh-memory-health-dot', 'aria-hidden': 'true' }),
      h('div', { className: 'dsh-memory-health-copy' },
        h('b', null, summary.title),
        h('span', null, summary.detail),
      ),
      // The verdict is a measurement, so the control that re-measures belongs
      // on it. Burying it under the list would make it disappear in the one
      // state where someone most wants to re-check: everything green.
      h('button', {
        type: 'button',
        className: 'dsh-memory-health-retry',
        title: '重新跑一次体检',
        onClick: doctor.reload,
      }, doctor.status === 'loading' ? '体检中…' : '重新体检'),
    ),
    inFlight > 0
      ? h('p', { className: 'dsh-memory-finding-note' }, 'Agent 正在处理 ' + inFlight + ' 项；以它跑完后重新体检的结果为准。')
      : null,
    // A repair that removes one finding and adds another is still a repair that
    // broke something. Checking only the subtraction is how that goes unnoticed.
    repair.added.length > 0
      ? h('div', { className: 'dsh-memory-added' },
          h('span', { className: 'dsh-memory-added-text' },
            '这次修复后多出 ' + repair.added.length + ' 个问题：' + repair.added.map(issueTitle).join('、'),
          ),
          h('button', {
            type: 'button',
            className: 'dsh-memory-act',
            onClick: repair.dismissAdded,
          }, '知道了'),
        )
      : null,
    findings.length > 0
      ? h('div', { className: 'dsh-memory-findings' },
          ...findings.map(function (f) {
            return h(FindingCard, { key: f.key, finding: f, repair })
          }),
          hasCommand ? h('p', { className: 'dsh-memory-finding-note' }, COMMAND_NOTE) : null,
        )
      : null,
    // "No findings" and "no doctor" must not look alike: the first is a clean
    // bill, the second is a blind spot, and the rows below are all this pane
    // can still see.
    doctor.status === 'unavailable'
      ? h('p', { className: 'dsh-memory-finding-note' }, '详细体检没跑起来，下面是面板能直接读到的几项。')
      : null,
    h('div', { className: 'dsh-memory-metrics' },
      ...groups.metrics.map(function (r) {
        return h('div', {
          key: r.key,
          className: 'dsh-memory-metric',
          'data-tone': r.tone,
        },
          h('b', { className: 'dsh-memory-metric-value' }, r.value),
          h('span', { className: 'dsh-memory-metric-label' }, r.label),
        )
      })),
    h('div', { className: 'dsh-memory-card' },
      h('div', { className: 'dsh-memory-cardhead' },
        '运行与配置',
        conflicts.busy ? h('span', { className: 'dsh-memory-cardcount' }, '读取中…') : null,
      ),
      h('div', { className: 'dsh-memory-rows' },
        ...groups.settings.map(function (r) {
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

/**
 * One finding: the problem, its consequence, and the command that closes it.
 *
 * The command is rendered in a `code` element on its own line so it can be
 * selected with one drag without catching the surrounding prose — a fix you
 * cannot copy is a fix you retype.
 *
 * The action row below it is the other half of the same argument. A command is
 * only actionable for someone who already has a terminal open on the right
 * machine; `让 Agent 处理` hands the same job to the agent that is already
 * running here. Confirmation is inline rather than modal: it has one fact to
 * convey (which conversation this lands in) and one risk (it may write), and a
 * dialog for that would cost more attention than the decision is worth.
 */
function FindingCard(props: { finding: HealthFinding; repair: RepairApi }): Child {
  const f = props.finding
  const entry = props.repair.entries[f.key]
  // Purely local: where the brief goes is not a choice any more (always a
  // conversation of its own), so a boolean is the whole state. It stays on the
  // card rather than in `repair` so cancelling one card cannot close another.
  const [confirming, setConfirming] = useState(false)

  return h('div', { className: 'dsh-memory-finding', 'data-severity': f.severity },
    h('div', { className: 'dsh-memory-finding-head' },
      h('i', { className: 'dsh-memory-finding-mark', 'aria-hidden': 'true' }),
      h('b', { className: 'dsh-memory-finding-title' }, f.title),
      h('span', { className: 'dsh-memory-finding-tag' }, SEVERITY_LABEL[f.severity]),
    ),
    h('p', { className: 'dsh-memory-finding-detail' }, f.detail),
    h('p', { className: 'dsh-memory-finding-fix' }, f.fix),
    f.command ? h('code', { className: 'dsh-memory-finding-cmd' }, f.command) : null,
    f.agent.mode === 'none' && !entry ? null : h('div', { className: 'dsh-memory-finding-actions' },
      entry
        ? h(RepairStatus, { entry, finding: f, repair: props.repair })
        : confirming
          ? h('div', { className: 'dsh-memory-confirm' },
              h('p', { className: 'dsh-memory-confirm-target' },
                '将发送到：一个新会话（不动你正在聊的这个）',
              ),
              h('p', { className: 'dsh-memory-confirm-note' },
                f.agent.mode === 'analyze'
                  ? '它会先只读核对，然后给你建议；不会直接改库。'
                  : '它会先只读核对，改库之前会再问你一次。',
              ),
              h('div', { className: 'dsh-memory-confirm-row' },
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-act dsh-memory-act-primary',
                  onClick: function () { setConfirming(false); props.repair.send(f) },
                }, '发送给 Agent'),
                h('button', {
                  type: 'button',
                  className: 'dsh-memory-act',
                  onClick: function () { setConfirming(false) },
                }, '取消'),
              ),
            )
          : h('div', { className: 'dsh-memory-confirm-row' },
              h('button', {
                type: 'button',
                className: 'dsh-memory-act dsh-memory-act-primary',
                onClick: function () { setConfirming(true) },
              }, f.agent.label),
              h('span', { className: 'dsh-memory-risk' }, f.agent.risk),
            ),
    ),
  )
}

/**
 * Copy the brief, or show it so it can be selected by hand.
 *
 * The clipboard is not guaranteed in every shell and `writeText` rejects
 * without focus, so a failed copy degrades to the text in a selectable block
 * rather than to a button that silently does nothing.
 */
function CopyBrief(props: { text: string }): Child {
  const [state, setState] = useState<'idle' | 'done' | 'manual'>('idle')
  if (state === 'manual') return h('pre', { className: 'dsh-memory-brief' }, props.text)

  // Built through a local on purpose. `Child` is a union that includes
  // `ReturnType<typeof h>`, and returning the call directly feeds that union
  // back in as the contextual type: the `createElement` overloads then resolve
  // `P` to `{}` and every prop — `type` included — reads as an excess
  // property. A local carries no contextual type, so the overloads line up.
  const copy = h('button', {
    type: 'button',
    className: 'dsh-memory-act',
    onClick: function () {
      const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (!clip || typeof clip.writeText !== 'function') { setState('manual'); return }
      clip.writeText(props.text).then(
        function () { setState('done') },
        function () { setState('manual') },
      )
    },
  }, state === 'done' ? '已复制' : '复制任务包')

  return copy
}

/**
 * The one-line state of a hand-off, with whatever control is still useful.
 *
 * Elapsed seconds are printed rather than a spinner: the panel cannot see the
 * turn's stream (the sheet is frame-level, the turn is session-level), so the
 * only progress it can honestly report is time. `mismatch` is the interesting
 * one — the agent claimed success and the doctor disagreed, which usually means
 * the two are looking at different vaults.
 */
function RepairStatus(props: { entry: RepairEntry; finding: HealthFinding; repair: RepairApi }): Child {
  const e = props.entry
  const code = props.finding.key
  const seconds = Math.max(0, Math.round((Date.now() - e.startedAt) / 1000))
  const elapsed = seconds < 60 ? seconds + ' 秒' : Math.round(seconds / 60) + ' 分钟'

  if (e.phase === 'failed') {
    return h('div', { className: 'dsh-memory-repair', 'data-phase': 'failed' },
      h('span', { className: 'dsh-memory-repair-text' }, '没送出去：' + (e.note ?? '未知原因')),
      h('button', {
        type: 'button',
        className: 'dsh-memory-act',
        onClick: function () { props.repair.clear(code) },
      }, '重试'),
      // The last thing that still works when the host cannot be driven from
      // here — and the only thing that works at all for a finding whose fix is
      // a conversation rather than a command.
      e.brief ? h(CopyBrief, { text: e.brief }) : null,
    )
  }

  if (e.phase === 'mismatch') {
    return h('div', { className: 'dsh-memory-repair', 'data-phase': 'mismatch' },
      h('span', { className: 'dsh-memory-repair-text' }, e.note ?? ''),
      h('button', {
        type: 'button',
        className: 'dsh-memory-act',
        onClick: function () { props.repair.clear(code) },
      }, '知道了'),
    )
  }

  const text = e.phase === 'sending'
    ? '正在发送…'
    : e.phase === 'sent'
      // Names the destination: the host may or may not move focus to a session
      // it was asked to create, and a card that just says "handed over" leaves
      // the user looking at this conversation for a turn happening elsewhere.
      ? '已交给新会话里的 Agent，等它开始…'
      : e.phase === 'running'
        ? 'Agent 正在处理 · 已 ' + elapsed
        : 'Agent 停了，正在重新体检…'

  return h('div', { className: 'dsh-memory-repair', 'data-phase': e.phase },
    h('i', { className: 'dsh-memory-repair-dot', 'aria-hidden': 'true' }),
    h('span', { className: 'dsh-memory-repair-text' }, text),
  )
}

// ── Figures ─────────────────────────────────────────────────────────

/**
 * The aggregate feed: four numbers first, then two figures, then the rest.
 *
 * The pane used to be four figures stacked in a scroll area — 500-odd pixels of
 * chart with no answer at the top. What a reader wants first is the scale, so a
 * summary strip leads; the two figures that carry the most signal (growth over
 * time, what gets re-read) follow; the composition donut and the access calendar
 * — both useful, both the least actionable — sit behind one disclosure.
 *
 * Nothing is removed: every figure is still rendered and still degrades on its
 * own. The disclosure only decides what costs a scroll.
 */
function StatsTab(props: { stats: StatsFeed }): Child {
  const data = props.stats.data
  const kpis = statKpis(data)

  if (!data) {
    return h('div', { className: 'dsh-memory-pane' },
      h(Failure, {
        text: props.stats.status === 'loading'
          ? '正在读取统计数据…'
          : '统计数据读取失败，记忆核心暂不可用',
        onRetry: props.stats.status === 'error' ? props.stats.reload : undefined,
      }),
    )
  }

  return h('div', { className: 'dsh-memory-pane dsh-memory-pane-scroll' },
    h('div', { className: 'dsh-memory-kpis' },
      ...kpis.map(function (k) {
        return h('div', { key: k.key, className: 'dsh-memory-kpi' },
          h('b', { className: 'dsh-memory-kpi-value' }, k.value),
          h('span', { className: 'dsh-memory-kpi-label' }, k.label),
        )
      })),
    h(GrowthChart, { status: props.stats.status, data: data }),
    h(TopBars, { status: props.stats.status, data: data }),
    h('details', { className: 'dsh-memory-more' },
      h('summary', { className: 'dsh-memory-more-summary' }, '更多：构成与访问热力图'),
      h('div', { className: 'dsh-memory-more-body' },
        h(BreakdownDonut, { status: props.stats.status, data: data }),
        h(CalendarHeatmap, { status: props.stats.status, data: data }),
      ),
    ),
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
