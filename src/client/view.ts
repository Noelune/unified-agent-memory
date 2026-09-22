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

import type { PreviewData } from './types.ts'

/** Tab ids, in display order. The console renders these left to right. */
export const CONSOLE_TABS = ['search', 'activity', 'growth', 'makeup', 'top'] as const

/** One tab id. */
export type TabId = (typeof CONSOLE_TABS)[number]

/** Chinese label per tab. */
export const TAB_LABEL: Record<TabId, string> = {
  search: '搜索',
  activity: '访问',
  growth: '生长',
  makeup: '构成',
  top: '排行',
}

/**
 * The tab that carries the pending-inbox count.
 *
 * The count used to ride on the 待处理 tab, which the figures retired. It has
 * to ride on SOME tab: the console still polls `stats.pending`, and a count that
 * is computed and never rendered is dead weight the class contract would report
 * as a styled-but-unused `.dsh-memory-pill`. WHICH tab is a display decision, so
 * it lives here beside `TAB_LABEL` — the component is asserted to hold no tab-id
 * literal of its own, so a hardcoded `'search'` there would fork the "tab ids
 * are declared once" rule.
 *
 * 搜索 is the choice because it is the console's only non-figure pane: the four
 * figure tabs are charts of the library, and a badge counting the inbox queue
 * sitting beside a chart axis reads as part of the chart.
 */
export const PENDING_BADGE_TAB: TabId = 'search'

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
