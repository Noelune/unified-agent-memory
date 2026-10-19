/**
 * dsh-unified-agent-memory — console display logic.
 *
 * The decisions the console makes about *what to show* live here,
 * apart from `Console.tsx`, for one concrete reason: the component imports
 * `../deps.ts` (React) and cannot be loaded by the Node test runner. Anything
 * left inside the component is only reachable by asserting on source strings,
 * and a string assertion cannot tell whether "unsupported" and "empty" render
 * the same sentence — which is exactly the bug this module exists to prevent.
 *
 * Nothing here touches React, the DOM, or the network.
 *
 * @module src/client/view
 */

import type { PreviewData, StatsData } from './types.ts'

/** Tab ids, in display order. The console renders these left to right. */
export const CONSOLE_TABS = ['inbox', 'search', 'health', 'stats'] as const

/** One tab id. */
export type TabId = (typeof CONSOLE_TABS)[number]

/** Chinese label per tab. */
export const TAB_LABEL: Record<TabId, string> = {
  inbox: '待确认',
  search: '搜索',
  health: '健康',
  stats: '统计',
}

/**
 * The tab that carries the pending-inbox count.
 *
 * It rides on 待确认 because that tab IS the queue: the number and the list it
 * counts are the same fact, and a user who sees "3" expects the tab to open on
 * those three. (It rode on 搜索 while the inbox pane did not exist — a count
 * you could not act on.)
 */
export const PENDING_BADGE_TAB: TabId = 'inbox'

/** One fragment of an annotated string. */
export interface Part {
  text: string
  hit: boolean
}

/** The copy an empty preview shows. */
export interface EmptyText {
  title: string
  hint: string
}

/**
 * What an empty preview pane should say, or null when there is content to show.
 *
 * A view the core has not implemented answers `status:"unsupported"` with no
 * items, which is NOT the same fact as an implemented view that happens to be
 * empty. Collapsing the two tells the user their library is empty when the
 * truth is that this console cannot read it — so they must return different
 * copy, and the tests assert that they do.
 *
 * A null payload is "still loading or the transport failed", which the console
 * renders as its error/loading state, so this returns null and leaves it alone.
 */
export function previewEmptyText(data: PreviewData | null): EmptyText | null {
  if (!data) return null
  if (data.status === 'unsupported') {
    return { title: '该视图暂不支持', hint: '核心尚未实现该治理视图' }
  }
  if ((data.items?.length ?? 0) > 0) return null
  return { title: '暂无内容', hint: '这里还没有条目' }
}

/**
 * Turn a `dismissItem` refusal reason into a sentence a user can act on.
 *
 * `dismissItem` resolves a reason ∈ `invalid-name` / `not-found` /
 * `outside-inbox` / `io-error:*` / `unavailable`. Showing the raw token makes
 * the user read the machine's vocabulary; this maps it to theirs.
 */
export function dismissReasonText(reason: string | null | undefined): string {
  const r = String(reason ?? '')
  if (r === 'invalid-name') return '文件名不合法，只能处理提交区里的条目'
  if (r === 'not-found') return '条目不存在，可能已被处理'
  if (r === 'outside-inbox') return '该条目不在提交区，不能在这里处理'
  if (r === 'unavailable') return '记忆核心暂不可用，请稍后再试'
  if (r === 'io-error') return '处理失败，读写提交区出错'
  if (r.startsWith('io-error:')) {
    return '处理失败：' + r.slice('io-error:'.length)
  }
  return '处理失败，未能完成该操作'
}

/**
 * The sentence shown when the search route itself failed.
 *
 * Distinct from "没有匹配的记忆": a broken request and a genuinely empty result
 * look identical to the user otherwise, and only one of them is worth retrying.
 */
export function searchFailureText(): string {
  return '搜索暂不可用，请稍后重试'
}

/**
 * Turn a `loadDoc` refusal into a sentence, the same way `dismissReasonText`
 * does for the inbox.
 *
 * The three reasons are not interchangeable: a refused name means the request
 * was wrong, a missing note means the index and the vault disagree, and an
 * unavailable core means trying again later could work. Telling the user the
 * wrong one sends them to fix something that is not broken.
 */
export function openFailureText(reason: string | null | undefined): string {
  const r = String(reason ?? '')
  if (r === 'invalid-name') return '文件名不合法，无法打开'
  if (r === 'not-found') return '这条记忆的文件已不在库里，索引可能过期了'
  if (r === 'unavailable') return '记忆核心暂不可用，请稍后再试'
  return '打开失败，未能读取该文档'
}

/** What the sheet's header and note should say about a newer release. */
export interface UpdateNotice {
  /** Latest version on npm, or null when there is nothing newer to show. */
  next: string | null
  /** One sentence under the console, or null when there is nothing to say. */
  text: string | null
}

/**
 * Decide what the update surface says.
 *
 * Three states have to stay distinct, because only one of them is actionable:
 *   - unknown (`updateAvailable: null`) — the registry was unreachable or the
 *     check has not finished. Say nothing; a spinner would imply progress the
 *     user did not ask for.
 *   - known-equal (`false`) — say nothing. "You are up to date" on every open
 *     would be noise in a panel that opens on demand.
 *   - newer (`true`, with a version) — show the pair and what to do about it.
 *
 * The `latest` guard is not redundant with `updateAvailable`: the flag and the
 * version come from the same record, but a half-rendered "v0.8.0 → vnull" is
 * worse than silence if they ever disagree.
 */
export function updateNotice(
  latest: string | null | undefined,
  available: boolean | null | undefined,
): UpdateNotice {
  if (available !== true || typeof latest !== 'string' || latest === '') {
    return { next: null, text: null }
  }
  return {
    next: latest,
    text: '有新版本 v' + latest + '，重新安装插件即可升级。',
  }
}

/**
 * Split `text` into fragments, flagging every occurrence of `term`.
 *
 * The term is user input, so it is matched **literally** — never compiled into
 * a RegExp. A regex would treat `a.b` as a wildcard and throw outright on an
 * unbalanced `(` or a trailing `\`, and a snippet highlighted from a corpus of
 * other agents' notes must never break the panel.
 *
 * Matching is case-insensitive but non-overlapping, and the fragments always
 * rejoin to the original text so nothing is dropped or duplicated.
 */
export function highlightParts(text: string, term: string): Part[] {
  const src = String(text ?? '')
  const q = String(term ?? '').trim()
  if (!q) return [{ text: src, hit: false }]

  const hay = src.toLowerCase()
  const needle = q.toLowerCase()
  const parts: Part[] = []
  let from = 0

  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    if (at > from) parts.push({ text: src.slice(from, at), hit: false })
    parts.push({ text: src.slice(at, at + q.length), hit: true })
    from = at + q.length
  }

  if (from < src.length) parts.push({ text: src.slice(from), hit: false })
  if (parts.length === 0) parts.push({ text: src, hit: false })
  return parts
}

// ── Inbox: the queue the panel exists to clear ─────────────────────
//
// Everything below turns the governance views into the three things a person
// opening a side panel actually wants: how much is waiting, how old it is, and
// what is inside it. The figures were pretty and answered none of those.

/**
 * How long ago, in the coarsest unit that still answers "how stale is this".
 *
 * `mtime` is the core's `Path.stat().st_mtime` — SECONDS since the epoch, not
 * milliseconds. Passing it through unchanged (a millisecond assumption) would
 * date every submission to January 1970 and label the whole queue as decades
 * old, which is why the unit is named here rather than left implicit.
 *
 * A timestamp in the future (clock skew between the vault and this machine) is
 * reported as 刚刚 rather than as a negative age.
 */
export function relativeAge(mtimeSeconds: number, nowMs: number): string {
  if (!Number.isFinite(mtimeSeconds) || mtimeSeconds <= 0) return '时间未知'
  const secs = nowMs / 1000 - mtimeSeconds
  if (!Number.isFinite(secs) || secs < 60) return '刚刚'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return mins + ' 分钟前'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + ' 天前'
  const months = Math.floor(days / 30)
  if (months < 12) return months + ' 个月前'
  return Math.floor(months / 12) + ' 年前'
}

/** The one line above the queue: how much is waiting, and how old the worst is. */
export interface InboxSummary {
  count: number
  /** Whole days the oldest item has been waiting, or null when the queue is empty. */
  oldestDays: number | null
  text: string
}

/**
 * Summarize the queue.
 *
 * The count alone is not enough to decide whether to act: "3 条" reads the same
 * whether they arrived this morning or three weeks ago. Staleness is what makes
 * an inbox feel urgent, so it is promoted into the sentence once it crosses a
 * week — and only then, because a "最老 1 小时" line would train people to
 * ignore the line entirely.
 */
export function inboxSummary(
  items: readonly { mtime: number }[],
  nowMs: number,
): InboxSummary {
  const count = items.length
  if (count === 0) {
    return { count: 0, oldestDays: null, text: '提交区是空的，没有等你确认的东西' }
  }
  // The oldest item is the SMALLEST mtime: `mtime` is an absolute timestamp,
  // so "oldest" means "written longest ago". Taking the max here would report
  // the freshest submission's age and make a month-old queue look new.
  let oldest = 0
  for (const it of items) {
    if (!Number.isFinite(it.mtime) || it.mtime <= 0) continue
    if (oldest === 0 || it.mtime < oldest) oldest = it.mtime
  }
  const oldestDays = oldest > 0
    ? Math.max(0, Math.floor((nowMs / 1000 - oldest) / 86_400))
    : null
  if (oldestDays !== null && oldestDays >= 7) {
    return {
      count,
      oldestDays,
      text: count + ' 条待确认，最老一条已经积压 ' + oldestDays + ' 天',
    }
  }
  return { count, oldestDays, text: count + ' 条待确认' }
}

/**
 * Oldest first, so the top of the list is the thing to deal with first.
 *
 * The core returns newest-first. That ordering is right for "what did I just
 * submit" and wrong for a work queue: the item most likely to have been
 * forgotten is the one at the bottom, i.e. the one nobody scrolls to.
 */
export function oldestFirst<T extends { mtime: number }>(items: readonly T[]): T[] {
  return items.slice().sort(function (a, b) { return a.mtime - b.mtime })
}

/**
 * The readable part of a submission body, clipped for a side panel.
 *
 * Clipping counts CODE POINTS, not UTF-16 units: submissions are written by
 * other agents in any script, and a `.slice()` can land between the halves of
 * an astral character and render a replacement box.
 *
 * The tail of the raw file carries the write stamp (`（写入 …｜来源：…）`), which
 * is provenance for the core and noise for a human reading a preview — it is
 * dropped when it is the last non-empty line, and left alone when the note
 * happens to end with something else.
 */
export function noteDigest(body: string | null | undefined, maxChars = 280): string {
  const raw = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const lines = raw.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim()
    if (last === '') { lines.pop(); continue }
    if (/^（(?:写入|来源)[：\s]/.test(last) || /^\((written|source)[:\s]/i.test(last)) lines.pop()
    break
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join('').trimEnd() + '…'
}

// ── Health: the numbers that decide whether the library is working ──

/** One labelled fact in the health pane. */
export interface HealthRow {
  key: string
  label: string
  value: string
  /** `warn` marks a row a user may need to act on; `muted` marks "not known". */
  tone: 'ok' | 'warn' | 'muted'
}

/** Everything the health pane reads. Nullable fields are "the core did not say". */
export interface HealthInput {
  /**
   * Counts, each independently optional: the host assembles them from a core
   * read, and a partially degraded read can return some of them. A missing
   * count renders as "—" — see `num()` in `healthRows`.
   */
  stats: { memories?: number; vectors?: number; pending?: number } | null
  indexOk: boolean | null
  /** Conflict-note count from the `conflicts` view; null when it could not be read. */
  conflicts: number | null
  recallMode: string | null
  agentName: string | null
  agentSource: string | null
  version: string | null
}

/**
 * Build the health rows.
 *
 * Three rules, each of which was a bug in an earlier shape of this panel:
 *
 *  1. **unknown is not zero.** A null reading renders as `—` and never as `0`;
 *     "0 条记忆" is a claim about the vault, and a core that did not answer has
 *     made no such claim.
 *  2. **a warning says what to do next.** 索引异常 / 冲突 3 条 / 前缀未识别 are
 *     the three states where the number alone leaves the user stuck.
 *  3. **off is not the same as silent.** Automatic recall prints its mode, since
 *     "关闭" and "开着但没命中" look identical from the outside.
 */
export function healthRows(input: HealthInput): HealthRow[] {
  const stats = input.stats
  const num = function (n: number | undefined): string {
    return typeof n === 'number' && Number.isFinite(n) ? String(n) : '—'
  }
  const rows: HealthRow[] = [
    { key: 'memories', label: '记忆', value: num(stats?.memories), tone: stats ? 'ok' : 'muted' },
    { key: 'vectors', label: '向量', value: num(stats?.vectors), tone: stats ? 'ok' : 'muted' },
    {
      key: 'pending',
      label: '待确认',
      value: stats ? num(stats.pending) + ' 条' : '—',
      tone: stats ? 'ok' : 'muted',
    },
    {
      key: 'index',
      label: '索引',
      value: input.indexOk === null ? '—' : input.indexOk ? '正常' : '异常',
      tone: input.indexOk === null ? 'muted' : input.indexOk ? 'ok' : 'warn',
    },
    {
      key: 'conflicts',
      label: '冲突',
      value: input.conflicts === null ? '—' : input.conflicts > 0 ? input.conflicts + ' 条' : '无',
      tone: input.conflicts === null ? 'muted' : input.conflicts > 0 ? 'warn' : 'ok',
    },
    {
      key: 'recall',
      label: '自动召回',
      value: input.recallMode === null ? '—' : input.recallMode === 'off' ? '已关闭' : input.recallMode,
      tone: input.recallMode === null || input.recallMode === 'off' ? 'muted' : 'ok',
    },
    {
      key: 'prefix',
      label: '提交前缀',
      value: input.agentName === null
        ? '—'
        : input.agentSource === 'fallback'
          ? input.agentName + '（未识别 profile）'
          : input.agentName,
      tone: input.agentName === null ? 'muted' : input.agentSource === 'fallback' ? 'warn' : 'ok',
    },
    {
      key: 'version',
      label: '版本',
      value: input.version === null ? '—' : 'v' + input.version,
      tone: input.version === null ? 'muted' : 'ok',
    },
  ]
  return rows
}

/**
 * The four reading that get a large number in the health pane.
 *
 * Split by MEANING, not by position: these are the counts that answer "how big
 * is the library and is anything jammed". The rest are configuration facts, and
 * a config fact set at 13px beside a count set at 13px makes the pane a wall of
 * equal-weight text — which is what the previous layout was.
 */
export const HEALTH_METRIC_KEYS = ['memories', 'vectors', 'pending', 'conflicts'] as const

/** The configuration rows: they describe the install, they do not measure it. */
export const HEALTH_SETTING_KEYS = ['index', 'recall', 'prefix', 'version'] as const

/** Split the health rows into the two groups the pane renders differently. */
export function splitHealth(rows: readonly HealthRow[]): {
  metrics: HealthRow[]
  settings: HealthRow[]
} {
  const metricSet: readonly string[] = HEALTH_METRIC_KEYS
  const settingSet: readonly string[] = HEALTH_SETTING_KEYS
  return {
    // Order follows the constant, not the input, so the grid is stable even if
    // `healthRows` is reordered — a card that jumps between reads is worse than
    // one in a fixed spot.
    metrics: metricSet
      .map(function (k) { return rows.find(function (r) { return r.key === k }) })
      .filter(function (r): r is HealthRow { return r !== undefined }),
    settings: settingSet
      .map(function (k) { return rows.find(function (r) { return r.key === k }) })
      .filter(function (r): r is HealthRow { return r !== undefined }),
  }
}

/** The one-line verdict above the health grid. */
export interface HealthSummary {
  tone: 'ok' | 'warn' | 'muted'
  /** The verdict itself — "运行正常" / "2 项需要处理". */
  title: string
  /** What the verdict is based on, so the headline is auditable. */
  detail: string
}

/**
 * Decide the headline for the health pane.
 *
 * The previous pane opened on eight equal-weight rows and left the reader to
 * work out whether any of them mattered. A verdict first, the evidence under
 * it.
 *
 * Three states, and the muted one is not a footnote: if EVERY row is muted the
 * core answered nothing, and "运行正常" would be a lie told by an absence. A
 * PARTIALLY muted pane (say the conflict count failed) still gets a verdict,
 * because the rows that did answer are real.
 */
export function healthSummary(rows: readonly HealthRow[]): HealthSummary {
  const known = rows.filter(function (r) { return r.tone !== 'muted' })
  if (known.length === 0) {
    return { tone: 'muted', title: '体检数据未读取到', detail: '记忆核心暂不可用，稍后再看' }
  }
  const warn = rows.filter(function (r) { return r.tone === 'warn' })
  if (warn.length > 0) {
    return {
      tone: 'warn',
      title: warn.length + ' 项需要处理',
      detail: warn.map(function (r) { return r.label }).join('、'),
    }
  }
  return { tone: 'ok', title: '运行正常', detail: '记忆、索引、召回都在正常工作' }
}

/**
 * A count as a short string.
 *
 * Four-digit numbers get a separator and five-digit ones switch to 万, because
 * "12480" and "1.2 万" read at the same speed while the first one costs a
 * digit-by-digit parse. No decimals below 万: the value is a scale hint, not an
 * accounting figure.
 */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const v = Math.max(0, Math.floor(n))
  if (v < 10000) return v.toLocaleString('en-US')
  const wan = v / 10000
  return (wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '')) + ' 万'
}

/** One cell of the stats summary strip. */
export interface StatKpi {
  key: string
  label: string
  value: string
}

/**
 * The four numbers a reader wants BEFORE any chart.
 *
 * The stats pane used to open on a heatmap: four figures, no summary, so the
 * answer to "how big is this library" was a visual estimate of an area. These
 * cells give the numbers first and leave the figures to explain the shape.
 *
 * Values come from `data` and are never defaulted: a null payload yields an
 * empty list, and the pane renders its failure notice instead of four zeroes —
 * "0 条记忆" is a claim about the vault that a failed read did not make.
 */
export function statKpis(data: StatsData | null): StatKpi[] {
  if (!data) return []
  return [
    { key: 'memories', label: '记忆', value: compactCount(data.totals.memories) },
    { key: 'accesses', label: '被取用', value: compactCount(data.totals.accesses) },
    { key: 'types', label: '类型', value: compactCount(data.types.length) },
    { key: 'inbox', label: '待确认', value: compactCount(data.totals.inbox) },
  ]
}

/** How many bars the ranking figure shows. */
export const TOP_VISIBLE = 6

