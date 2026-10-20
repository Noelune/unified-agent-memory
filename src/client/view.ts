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

import type { DoctorCounts, DoctorIssue, PreviewData, StatsData } from './types.ts'

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
  // The inbox gets its own sentence: "暂无内容" reads like the panel failed to
  // find something, while an empty inbox is a healthy queue and the reader's
  // question is whether anything is waiting on them.
  if (data.view === 'pending') {
    return { title: '没有待确认的提交', hint: 'Agent 提交的事实会先出现在这里' }
  }
  // An empty conflict queue is good news, not an empty view: nothing an agent
  // submitted contradicts what memory already holds.
  if (data.view === 'conflicts') {
    return { title: '没有要裁决的冲突', hint: '提交和已有记忆对不上时会出现在这里' }
  }
  return { title: '暂无内容', hint: '这里还没有条目' }
}

/**
 * Turn a `dismissItem` refusal reason into a sentence a user can act on.
 *
 * `dismissItem` resolves a reason ∈ `invalid-name` / `not-a-submission` /
 * `not-found` / `outside-inbox` / `io-error:*` / `unavailable`. Showing the raw
 * token makes the user read the machine's vocabulary; this maps it to theirs.
 */
export function dismissReasonText(reason: string | null | undefined): string {
  const r = String(reason ?? '')
  if (r === 'invalid-name') return '文件名不合法，只能处理提交区里的条目'
  if (r === 'not-a-submission') return '这个是提交区自带的说明/登记文件，不是待确认内容'
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

// ── Health findings: what is wrong, and what fixes it ───────────────

/**
 * One actionable finding: a problem plus the next step.
 *
 * The pane's previous answer to a warning was a label in a headline — "2 项需要
 * 处理（索引、冲突）" — which names the symptom and stops. A user who does not
 * already know the CLI cannot act on it. `fix` and `command` are the missing
 * half: the sentence that says what to do, and the string to paste.
 */
export interface HealthFinding {
  /** Stable React key. The issue code, or `row:<key>` for the fallback list. */
  key: string
  severity: 'error' | 'warn' | 'info'
  title: string
  /** The consequence, so the reader knows why it matters before the fix. */
  detail: string
  /** The next step, in one sentence. */
  fix: string
  /** A paste-ready command, or null when there is nothing to run. */
  command: string | null
  /**
   * Whether this finding can be handed to an agent, and under what terms.
   *
   * Not every code deserves the same button. "Rebuild a derived index" and
   * "delete twenty thousand duplicate lines" are both `warn`, both one click
   * away, and only one of them is safe to start without a conversation.
   */
  agent: AgentAction
  /**
   * The core's own sentence and remedy, kept verbatim.
   *
   * The card shows the localized copy, but the task handed to an agent must
   * carry what the core actually said: a translation is a rendering, and the
   * brief is the only place the original survives.
   */
  core: { message: string; hint: string } | null
}

/**
 * How far an agent should go without coming back for permission.
 *
 * `judge` is the one that is not a straight answer to that question: for a
 * queued conflict the agent is expected to settle the ones it can actually
 * settle, and hand back only the ones it cannot — with a recommendation and a
 * reason in plain words. The point is to stop the queue from being a pile of
 * questions the user has to adjudicate alone, without letting an agent silently
 * overwrite a fact it merely guessed at.
 */
export type AgentMode = 'fix' | 'judge' | 'analyze' | 'none'

/** What the card's action row offers, if anything. */
export interface AgentAction {
  mode: AgentMode
  /** Button text. Empty when `mode` is `none` and no button is drawn. */
  label: string
  /** The small print beside the button: does this touch the vault? */
  risk: string
}

/** No action row at all — rows, unknown codes, and anything we cannot brief. */
export const NO_AGENT: AgentAction = { mode: 'none', label: '', risk: '' }

/**
 * Per-code terms, keyed like `ISSUE_COPY`.
 *
 * `fix` means "go change the vault, listing the changes first". `analyze` means
 * "read, then come back with a recommendation" — used wherever the decision is
 * the user's (which of two conflicting facts wins, which of two copies to
 * keep). `judge` sits between them: settle what can be settled, and come back
 * only with what cannot — carrying a recommendation and a reason. Anything
 * absent gets no button: a card that says `fix: 让 agent 读一遍`
 * without a command is better served by reading it in the conversation than by
 * a button that starts an agent with nothing to do.
 */
const AGENT_PLAN: Record<string, AgentAction> = {
  'unclassified-facts': { mode: 'fix', label: '让 Agent 归类', risk: '会写笔记' },
  'inbox-stale': { mode: 'fix', label: '让 Agent 处理', risk: '会写库' },
  'duplicate-facts': { mode: 'fix', label: '让 Agent 去重', risk: '会写库 · 先备份' },
  'graph-bloat': { mode: 'fix', label: '让 Agent 处理', risk: '会重建派生数据' },
  'index-bloat': { mode: 'fix', label: '让 Agent 处理', risk: '会重建派生数据' },
  'doctor-failed': { mode: 'fix', label: '让 Agent 处理', risk: '会重建派生数据' },
  'orphan-indexes': { mode: 'fix', label: '让 Agent 处理', risk: '会删旧索引 · 可重建' },
  'embedding-coverage': { mode: 'fix', label: '让 Agent 补向量', risk: '会写向量 · 需要 key' },
  'conflicts-pending': { mode: 'judge', label: '让 Agent 判断', risk: '能定就直接定 · 定不了写清理由问你' },
  'sync-conflict-copies': { mode: 'analyze', label: '让 Agent 分析', risk: '不动文件，只给合并建议' },
  'vault-missing': { mode: 'analyze', label: '让 Agent 诊断', risk: '可能要改配置，先问你' },
}

/** The terms for one core code; unknown codes get no action row. */
export function agentAction(code: string): AgentAction {
  return AGENT_PLAN[code] ?? NO_AGENT
}

/**
 * A code's display title, for places that only have the code.
 *
 * The "a repair introduced a new problem" line names findings without building
 * cards for them, and a bare `index-bloat` in a Chinese sentence reads like a
 * log line.
 */
export function issueTitle(code: string): string {
  return ISSUE_COPY[code]?.title ?? code
}

/** Severity chip text. */
export const SEVERITY_LABEL: Record<HealthFinding['severity'], string> = {
  error: '错误',
  warn: '待处理',
  info: '提示',
}

/** How to read the command lines, printed once under the list. */
export const COMMAND_NOTE =
  '命令里的 `memory` 是核心自带的命令行；没装它时等价于 `python -m unified_memory.memory <子命令>`。'

/**
 * What the 待确认 list actually is, printed above it.
 *
 * The pane used to open straight into file names and two buttons named 查看 and
 * 归档, and neither word said what was being confirmed: these files are facts an
 * agent wanted remembered, and 归档 is a REFUSAL — the file moves to 已处理/ and
 * never reaches memory. A reader who took 归档 for "file it into memory" would
 * empty the queue while believing they had accepted everything, which is the
 * worst possible reading of a button: it looks like it worked.
 */
export const INBOX_LEAD = '这些是 Agent 提交、还没进记忆的事实。'

/**
 * The two exits from the submissions list, said plainly.
 *
 * An earlier revision could only say "this pane refuses; run the command to
 * accept". That was true while promotion was vault-wide, but it made the pane a
 * dead end: the one thing a reader wants to do with a submission is decide, and
 * the only button refused it. The core now promotes one named file, so both
 * answers exist and the sentence can describe them instead of apologising.
 */
export const INBOX_ACCEPT_NOTE =
  '「收录」把这条写进记忆；「不采纳」移到 已处理/，不进记忆也不删文件。'

/**
 * Why the queue has two kinds of row.
 *
 * A plain submission is a yes/no. A conflicting one is not: the new fact and an
 * existing line describe the same thing differently, so "yes" and "no" are not
 * enough — someone has to say which reading is true. The core has queued these
 * separately for exactly that reason; this is the sentence that explains why
 * they get their own block and their own three buttons.
 */
export const CONFLICT_LEAD =
  '同一个位置出现了两种说法。上面是记忆里现在的，下面是这次提交想换成的。' +
  '这类判断默认交给 Agent：它能定的已经定掉，才轮到这里的 — 有 Agent 的判断就直接照着点，没有就自己看哪个对。'

/**
 * The two sides, named by their role rather than by their age.
 *
 * 「新的」/「旧的」 makes the reader work out which one is currently stored, and
 * on a screen full of near-identical paths that is exactly the wrong thing to
 * ask. 记忆里现在是 / 这次提交的是 says what each line IS.
 */
export const CONFLICT_NOW_LABEL = '记忆里现在是'
export const CONFLICT_INCOMING_LABEL = '这次提交的是'

/**
 * The line above a recommendation the agent left behind.
 *
 * This block is the whole answer to "我不想自己当裁判，但我也不敢乱点": when the
 * agent could not tell the two sides apart it still has to say so in words a
 * person can act on, next to the buttons it is recommending.
 */
export const CONFLICT_ADVICE_LABEL = 'Agent 的判断'

/**
 * What the three buttons do, in one line under the buttons.
 *
 * The same text was in a `title`, which only appears on hover — the one moment
 * it is useless, because the reader is already deciding whether to click.
 */
export const CONFLICT_RULES_NOTE =
  '取代＝删掉记忆里那行、换成新的 · 保留旧＝记忆不动、这条作废 · 共存＝两条都留着'

/**
 * The three rulings, in the words a person uses.
 *
 * Values are the core's own decision tokens (`用新` / `保留旧` / `并存`); labels
 * are what the button says. `跳过` is absent on purpose: it records the decision
 * and dequeues the entry, so a "skip" button would permanently silence a
 * question the user declined to answer.
 */
export const CONFLICT_CHOICES = [
  { value: '用新', label: '取代', hint: '删掉旧的那行，换成新的' },
  { value: '保留旧', label: '保留旧', hint: '记忆不动，这条提交作废' },
  { value: '并存', label: '共存', hint: '两条都留下' },
] as const

/** One side of a conflict, ready to render. */
export interface ConflictSide {
  text: string
  meta: string
  /** The substring that differs from the other side, or null when unknown. */
  diff: string | null
  before: string
  after: string
}

/** What an agent recommended, when it left a recommendation behind. */
export interface ConflictAdvice {
  /** The ruling it suggests: `用新` / `保留旧` / `并存`. */
  choice: string
  /** The same ruling in button words (`取代` / `保留旧` / `共存`), or '' if unknown. */
  label: string
  /** Why, in the agent's own plain language. */
  why: string
}

/** Both sides plus the note they belong to, already cleaned for reading. */
export interface ConflictSides {
  doc: string
  now: ConflictSide
  incoming: ConflictSide
  advice: ConflictAdvice | null
}

/** `记录于 2026-10-16 · 来自 [[…]]` out of the fields the core extracted. */
function sideMeta(recorded?: string, source?: string, fallbackSource?: string): string {
  const parts: string[] = []
  if (recorded) parts.push(`记录于 ${recorded}`)
  const from = source || fallbackSource || ''
  if (from) parts.push(`来自 ${from}`)
  return parts.join(' · ')
}

/**
 * Turn one queued conflict into two readable sides.
 *
 * Falls back to the raw strings when the core did not send `detail` (an older
 * core, or a hand-written queue the parser could only half read). A missing
 * detail must degrade to "less pretty", never to an empty row: the reader still
 * has to be able to rule on it.
 */
export function conflictSides(item: {
  new?: string
  old?: string
  source?: string
  doc?: string
  detail?: {
    doc?: string
    new?: { text?: string; recorded?: string; source?: string }
    old?: { text?: string; recorded?: string; source?: string }
    change?: { prefix?: string; new?: string; old?: string; suffix?: string } | null
    advice?: { choice?: string; why?: string } | null
  } | null
}): ConflictSides {
  const detail = item.detail ?? null
  const change = detail?.change ?? null
  const fallbackDoc = (item.doc || '').split(/[\\/]/).pop() || ''
  return {
    doc: detail?.doc || fallbackDoc || '未指定笔记',
    now: {
      text: detail?.old?.text || item.old || '（没有对应的旧记录）',
      meta: sideMeta(detail?.old?.recorded, detail?.old?.source),
      diff: change?.old ?? null,
      before: change?.prefix ?? '',
      after: change?.suffix ?? '',
    },
    incoming: {
      text: detail?.new?.text || item.new || '',
      meta: sideMeta(detail?.new?.recorded, detail?.new?.source, item.source),
      diff: change?.new ?? null,
      before: change?.prefix ?? '',
      after: change?.suffix ?? '',
    },
    advice: adviceOf(detail?.advice),
  }
}

/**
 * A recommendation, in the words the buttons use.
 *
 * The raw value is a core token (`用新`), which reads as a verb the agent
 * performed rather than an option the reader can pick. Same mapping as the
 * buttons, so `并存` in the advice and `共存` on the button cannot disagree.
 */
function adviceOf(raw: { choice?: string; why?: string } | null | undefined): ConflictAdvice | null {
  if (!raw) return null
  const choice = (raw.choice || '').trim()
  const why = (raw.why || '').trim()
  if (!choice && !why) return null
  const known = CONFLICT_CHOICES.find(function (c) { return c.value === choice })
  return { choice, label: known ? known.label : '', why }
}

/** What one of the three rulings did, said in a sentence. */
export function decideOutcomeText(
  result: { applied: boolean; target: string | null; choice: string },
): string {
  const target = result.target ? `（写进 ${result.target}）` : ''
  if (result.choice === '保留旧') return '已保留旧值，这条冲突清掉了'
  if (result.choice === '并存') return `已并存，两条都留下${target}`
  return `已取代，旧的那行删掉了${target}`
}

/**
 * Turn a `decideConflict` refusal into a sentence.
 *
 * `not-found` is the interesting one: the queue is a file other tools also
 * write, so a row can be resolved elsewhere between the read and the click.
 * Saying "已不在了，刷新看看" is the only honest answer, and it is different
 * from "核心不可用".
 */
export function decideReasonText(reason: string | null | undefined): string {
  const r = String(reason ?? '')
  if (r === 'not-found') return '这条冲突已经不在队列里了，可能刚被裁决过 — 刷新看一下'
  if (r === 'invalid-key') return '这条冲突的编号不被接受，刷新后再试'
  if (r === 'unknown-choice') return '这个选择不被支持，刷新后再试'
  if (r === 'unavailable') return '记忆核心暂不可用，请稍后再试'
  return '裁决没有完成，请稍后重试'
}

/**
 * Turn an `acceptItem` refusal into a sentence.
 *
 * `conflicts` is not a failure: it means the submission contradicts memory, so
 * the core neither promoted nor retired it. The next step is a ruling, not a
 * retry, and the sentence has to send the reader to the block above rather than
 * to the same button.
 */
export function acceptReasonText(reason: string | null | undefined): string {
  const r = String(reason ?? '')
  if (r === 'conflicts') return '这条和已有记忆冲突，先在「需要你裁决」里定一下'
  if (r === 'not-a-submission') return '这个是提交区自带的说明/登记文件，不是待确认内容'
  if (r === 'not-found') return '条目不存在，可能已被处理'
  if (r === 'invalid-name') return '文件名不合法，只能处理提交区里的条目'
  if (r === 'unavailable') return '记忆核心暂不可用，请稍后再试'
  return '收录没有完成，请稍后重试'
}

/**
 * What one accept actually did.
 *
 * Zero promoted is not a failure and must not read like one: the submission may
 * have carried only facts memory already holds ("都是重复的") or no fact lines at
 * all. Both are legitimate outcomes of a correct click, and saying "已收录 0 条"
 * would look like the button is broken.
 */
export function acceptOutcomeText(
  result: { promoted: number; duplicates: number },
): string {
  if (result.promoted > 0) {
    const dup = result.duplicates > 0 ? `，另跳过 ${result.duplicates} 条重复` : ''
    return `已收录 ${result.promoted} 条${dup}`
  }
  if (result.duplicates > 0) return '没有新事实，都是记忆里已有的'
  return '这条里没有可收录的事实'
}

/**
 * Chinese copy per core issue code.
 *
 * Keyed by CODE rather than by severity or position: the core's codes are its
 * stable identifiers, while messages carry counts and file names that change on
 * every read. An unknown code falls through to the core's own English text —
 * worse prose, but never a blank card.
 */
const ISSUE_COPY: Record<string, { title: string; detail: string; fix: string; command: string | null }> = {
  'sync-conflict-copies': {
    title: '有同步冲突副本',
    detail: '网盘或 OneDrive 生成了同名副本，库里存在两份内容重叠的笔记，索引会跳过它们。',
    fix: '打开两份副本，把有用的内容并进保留的那份，再删掉另一份。',
    command: null,
  },
  'conflicts-pending': {
    title: '事实互相矛盾',
    detail: '在你裁决之前，冲突双方都不算生效，检索会绕开这段记忆。',
    fix: '先交给 Agent 判断：能定的它直接定掉并说明理由，定不了才留在这里，并写明推荐哪一种。',
    command: 'python -m unified_memory.promoter --adjudicate',
  },
  'inbox-stale': {
    title: '待确认积压太久',
    detail: '收件箱里的提交放了两周以上，越积越多，新事实会排在后面。',
    fix: '先复查一遍待晋升清单，确认没问题再批量入库。',
    command: 'python -m unified_memory.promoter --review',
  },
  'duplicate-facts': {
    title: '规范笔记里有重复事实',
    detail: '完全相同的行出现多次，占掉检索名额，也让「重要度」虚高。',
    fix: '去重会先备份再删重复行，可以放心跑。',
    command: 'python -m unified_memory.promoter --repair-existing',
  },
  'embedding-coverage': {
    title: '向量覆盖不全',
    detail: '部分记忆没有向量，语义检索会退化成关键词匹配——换个说法就搜不到。',
    fix: '补齐向量，需要先配好 SiliconFlow 的 key。',
    command: 'memory embed',
  },
  'graph-bloat': {
    title: '概念图边数超标',
    detail: '联想图超出上限，联想结果会变得又散又慢。',
    fix: '重建一张有界的概念图。',
    command: 'memory gc --apply',
  },
  'index-bloat': {
    title: '索引库体积过大',
    detail: '每次打开索引都要多读一块，搜索会越来越慢。',
    fix: '整理并压缩索引库。',
    command: 'memory gc --apply',
  },
  'orphan-indexes': {
    title: '有残留的孤儿索引',
    detail: '旧 vault 留下的索引文件，和现在的库无关，只是占磁盘。',
    fix: '清掉孤儿索引库，不影响当前 vault；不过刚生成的会等满 30 天才自动清，要立刻清加 --older-than 0。',
    command: 'memory gc --apply',
  },
  'unclassified-facts': {
    title: '有未归类的事实',
    detail: '这些行还停在「未归类事实」里，没归到具体笔记，检索时容易被埋掉。',
    fix: '让 agent 读一遍，把它们归到对应的笔记。',
    command: null,
  },
  'vault-missing': {
    title: '核心找不到 vault',
    detail: '配置里的路径不存在，所有读写都会失败。',
    fix: '检查 ~/.unified-memory.yaml 里的 vault 是否还在，或重新指定一次。',
    command: 'memory status',
  },
  'doctor-failed': {
    title: '体检脚本自身失败',
    detail: '多半是索引库损坏，导致体检读不下去。',
    fix: '先重建派生数据，再体检一次。',
    command: 'memory gc --apply',
  },
}

/**
 * Turn the core's issues into cards.
 *
 * Three rules:
 *
 *  1. **Every card ends in a verb.** A finding without `fix` is just a louder
 *     warning, and the whole point of this list is to close that gap.
 *  2. **The count goes in the sentence when the core gave one**, because "有 3
 *     条冲突" tells the reader the size of the job while "有冲突" does not.
 *  3. **Unknown codes keep the core's message and hint.** Dropping them would
 *     hide a genuine finding; showing untranslated English is the lesser cost,
 *     and the sentence still names the command to run.
 */
export function healthFindings(
  issues: readonly DoctorIssue[],
  counts?: DoctorCounts | null,
): HealthFinding[] {
  return issues.map(function (issue, i) {
    const copy = ISSUE_COPY[issue.code]
    const key = issue.code || 'issue-' + i
    if (!copy) {
      return {
        key,
        severity: issue.severity,
        title: '核心报了一个问题',
        detail: issue.message || issue.code,
        fix: issue.hint || '这条本版面板还不认识，先跑一次 `memory doctor` 看原文。',
        command: null,
        // Unknown code: the pane cannot say what it would cost, so it offers
        // no button. Copying the core's own hint still works.
        agent: NO_AGENT,
        core: { message: issue.message, hint: issue.hint },
      }
    }
    return {
      key,
      severity: issue.severity,
      title: copy.title,
      detail: countedDetail(issue.code, copy.detail, counts),
      fix: copy.fix,
      command: copy.command,
      agent: agentAction(issue.code),
      core: { message: issue.message, hint: issue.hint },
    }
  })
}

/**
 * Put the core's count into the sentence when there is one.
 *
 * Only the four codes whose message is essentially a number get rewritten, and
 * each gets a WHOLE sentence rather than a phrase spliced into the base copy:
 * string surgery on Chinese prose ("有 2 个" + "网盘或 OneDrive 生成了同名副本")
 * produces grammar that reads like a mail merge. Every other code keeps its
 * prose, because "部分记忆没有向量" is already as specific as the count.
 */
function countedDetail(code: string, base: string, counts?: DoctorCounts | null): string {
  if (!counts) return base
  if (code === 'conflicts-pending' && counts.conflicts > 0) {
    return '共 ' + counts.conflicts + ' 条事实和已有记录互相矛盾；裁决前两条都不生效，检索会绕开这段记忆。'
  }
  if (code === 'duplicate-facts' && counts.duplicates > 0) {
    return '共 ' + counts.duplicates + ' 行完全重复的事实，占掉检索名额，也让「重要度」虚高。'
  }
  if (code === 'orphan-indexes' && counts.orphans > 0) {
    return counts.orphans + ' 个孤儿索引库（旧 vault 留下的），和现在的库无关，只占磁盘。'
  }
  if (code === 'inbox-stale' && counts.inbox > 0) {
    return '收件箱有 ' + counts.inbox + ' 条待确认，最老的超过两周，新事实会排在它们后面。'
  }
  return base
}

/**
 * The fallback list, built from the pane's own rows.
 *
 * Used when `doctor` could not run: the status route already flags three states,
 * and each has a known remedy. Kept separate from `healthFindings` rather than
 * merged into it — the doctor's list is authoritative and covers cases the rows
 * cannot see (duplicates, bloat, orphan indexes), so mixing the two would
 * double-report the same problem with different wording.
 */
export function rowFindings(rows: readonly HealthRow[]): HealthFinding[] {
  const byKey: Record<string, HealthFinding> = {
    index: {
      key: 'row:index',
      severity: 'warn',
      title: '索引异常',
      detail: '派生索引损坏或读不到，搜索会退回逐文件扫描。',
      fix: '重建一次派生索引，不会动你的笔记。',
      command: 'memory sync',
      // Row-derived findings carry no core message, and the rows are a
      // fallback for "the doctor never ran" — handing one to an agent would
      // ask it to work from a guess.
      agent: NO_AGENT,
      core: null,
    },
    conflicts: {
      key: 'row:conflicts',
      severity: 'warn',
      title: '事实互相矛盾',
      detail: '冲突裁决前，两条都不算生效，检索会绕开这段记忆。',
      fix: '逐条选保留哪一条。',
      command: 'python -m unified_memory.promoter --adjudicate',
      agent: NO_AGENT,
      core: null,
    },
    prefix: {
      key: 'row:prefix',
      severity: 'warn',
      title: '提交前缀没识别出来',
      detail: '写进库的事实会署名为 fallback，多个 agent 共库时分不清是谁写的。',
      fix: '在插件设置里填 agentName，或设环境变量 UNIFIED_MEMORY_AGENT。',
      command: null,
      agent: NO_AGENT,
      core: null,
    },
  }
  return rows
    .filter(function (r) { return r.tone === 'warn' })
    .map(function (r) { return byKey[r.key] })
    .filter(function (f): f is HealthFinding { return f !== undefined })
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

