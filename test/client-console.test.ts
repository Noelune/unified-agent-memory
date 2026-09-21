/**
 * Task 8 — the four-tab memory console.
 *
 * Two layers, deliberately:
 *
 *  1. structure assertions (static): the browser half is bundled against the DSH
 *     client runtime and there is no DOM here, so the tab list, the store-hook
 *     usage and the "react only via deps.ts" rule are pinned at source level;
 *  2. behavior assertions (dynamic): the display decisions the console makes are
 *     real logic, so they live in `src/client/view.ts` — a module with no React
 *     import — and run their real code here. A static `toContain` cannot tell
 *     whether "unsupported" and "empty" render the same text.
 *
 * Why `view.ts` is separate from `Console.tsx`: the component imports
 * `../deps.ts`, which resolves to `react` and cannot be loaded in this Node
 * environment. Keeping the pure display logic in a React-free module is what
 * makes it testable at all — the alternative is asserting on strings and
 * hoping, which is exactly the escape this file exists to close.
 *
 * Every pure function below carries a mutation check in `describe('mutation')`:
 * the function is replaced by a known-wrong implementation and the test that
 * guards it is asserted to go red. A test that cannot fail proves nothing.
 *
 * @module test/client-console.test
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  CONSOLE_TABS,
  dismissReasonText,
  highlightParts,
  previewEmptyText,
  searchFailureText,
} from '../src/client/view.ts'
import type { PreviewData } from '../src/client/types.ts'

const CONSOLE = readFileSync(new URL('../src/client/Console.tsx', import.meta.url), 'utf8')
const STYLES = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const INDEX = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** Build a PreviewData with the fields the display logic reads. */
function preview(over: Partial<PreviewData>): PreviewData {
  return { view: 'pending', status: 'ok', count: 0, items: [], ...over }
}

// ── Structure ──────────────────────────────────────────────────────

describe('console structure', () => {
  it('declares exactly the four tab ids, in order', () => {
    // A pure-value assertion: stronger than four `toContain` string checks,
    // because it also pins the order and the absence of extras.
    expect(CONSOLE_TABS).toEqual(['search', 'inbox', 'vault', 'system'])
  })

  it('renders the console, not just a bare constant', () => {
    expect(CONSOLE).toContain('export function Console')
    expect(CONSOLE).toContain('CONSOLE_TABS')
  })

  it('uses the store hooks, not ad-hoc fetching', () => {
    expect(CONSOLE).toContain('useSearch')
    expect(CONSOLE).toContain('usePreview')
    expect(CONSOLE).toContain('dismissItem')
    expect(CONSOLE).not.toMatch(/fetch\(/)
  })

  it('imports react api from deps only', () => {
    expect(CONSOLE).toContain("from '../deps.ts'")
    expect(CONSOLE).not.toMatch(/from\s+['"]react['"]/)
  })

  it('marks search hits with a highlight element', () => {
    expect(CONSOLE).toContain("'mark'")
  })

  it('gates dismiss on the ok flag, not the http status', () => {
    // dismissItem resolves false on a 200-with-ok:false refusal, so the reload
    // must key off the boolean, never off a response status.
    expect(CONSOLE).toMatch(/dismissItem[\s\S]{0,200}?\bok\b/)
    expect(CONSOLE).not.toMatch(/status\s*===?\s*200/)
  })

  it('keeps the registrations the host contract needs', () => {
    expect(INDEX).toContain("'shell.overlay'")
    expect(INDEX).toContain("'sidebar.footer.action'")
  })
})

// ── previewEmptyText: unsupported vs empty vs populated ─────────────

describe('previewEmptyText', () => {
  it('distinguishes an unsupported view from an empty one', () => {
    const unsupported = previewEmptyText(preview({ status: 'unsupported', items: [] }))
    const empty = previewEmptyText(preview({ status: 'ok', items: [] }))

    expect(unsupported).not.toBeNull()
    expect(empty).not.toBeNull()
    // The whole point: these must not read the same. "Not implemented yet" is
    // a different fact from "implemented, and there is nothing in it".
    expect(unsupported!.title).not.toBe(empty!.title)
    expect(unsupported!.hint).not.toBe(empty!.hint)
  })

  it('says the view is unsupported, not that the list is empty', () => {
    const t = previewEmptyText(preview({ status: 'unsupported' }))!
    expect(t.title).toContain('暂不支持')
  })

  it('says there is no content for a supported, empty view', () => {
    const t = previewEmptyText(preview({ status: 'ok', items: [] }))!
    expect(t.title).toBe('暂无内容')
    expect(t.title).not.toContain('暂不支持')
  })

  it('returns null when there are items to show', () => {
    const t = previewEmptyText(preview({
      status: 'ok',
      count: 1,
      items: [{ name: 'a.md', path: '/tmp/a.md', mtime: 0 }],
    }))
    expect(t).toBeNull()
  })

  it('returns null for a null payload only via the caller', () => {
    // A null payload is "still loading / transport failed", which the console
    // renders as an error state — not as an empty view.
    expect(previewEmptyText(null)).toBeNull()
  })
})

// ── dismissReasonText: machine reason → human sentence ──────────────

describe('dismissReasonText', () => {
  it('explains the invalid-name refusal', () => {
    expect(dismissReasonText('invalid-name')).toContain('文件名')
  })

  it('explains the not-found refusal', () => {
    expect(dismissReasonText('not-found')).toContain('不存在')
  })

  it('explains the outside-inbox refusal', () => {
    expect(dismissReasonText('outside-inbox')).toContain('提交区')
  })

  it('explains an io-error with its detail, and one without', () => {
    expect(dismissReasonText('io-error:EPERM')).toContain('EPERM')
    expect(dismissReasonText('io-error')).not.toContain(':')
  })

  it('explains an unavailable core', () => {
    expect(dismissReasonText('unavailable')).toContain('不可用')
  })

  it('gives every reason a distinct, non-empty sentence', () => {
    const reasons = [
      'invalid-name', 'not-found', 'outside-inbox', 'io-error', 'unavailable',
    ]
    const texts = reasons.map(dismissReasonText)
    for (const t of texts) expect(t.length).toBeGreaterThan(0)
    expect(new Set(texts).size).toBe(reasons.length)
  })

  it('never leaks a raw machine token to the user', () => {
    for (const r of ['invalid-name', 'not-found', 'outside-inbox', 'unavailable']) {
      expect(dismissReasonText(r)).not.toBe(r)
    }
  })

  it('falls back to readable text for an unknown reason', () => {
    const t = dismissReasonText('something-new')
    expect(t.length).toBeGreaterThan(0)
    expect(t).not.toContain('undefined')
  })

  it('handles a missing reason without saying "undefined"', () => {
    expect(dismissReasonText(null)).not.toContain('undefined')
    expect(dismissReasonText(undefined)).not.toContain('undefined')
  })
})

// ── highlightParts: snippet → marked fragments ──────────────────────

describe('highlightParts', () => {
  it('marks the matched term and keeps the surrounding text', () => {
    const parts = highlightParts('共享记忆库的入口', '记忆')
    expect(parts.map(function (p) { return p.text }).join('')).toBe('共享记忆库的入口')
    const hit = parts.filter(function (p) { return p.hit })
    expect(hit.map(function (p) { return p.text })).toEqual(['记忆'])
  })

  it('marks every occurrence, not just the first', () => {
    const parts = highlightParts('记忆 and 记忆 again', '记忆')
    expect(parts.filter(function (p) { return p.hit }).length).toBe(2)
  })

  it('returns one unmarked part when the term is absent', () => {
    const parts = highlightParts('no match here', 'zzz')
    expect(parts).toEqual([{ text: 'no match here', hit: false }])
  })

  it('returns one unmarked part for an empty query', () => {
    expect(highlightParts('some text', '')).toEqual([{ text: 'some text', hit: false }])
    expect(highlightParts('some text', '   ')).toEqual([{ text: 'some text', hit: false }])
  })

  it('treats regex metacharacters as literal text', () => {
    // `a.b` must match only "a.b", never "axb" — the query is user input, not a
    // pattern. A RegExp-based implementation would both over-match and throw on
    // an unbalanced "(".
    const parts = highlightParts('a.b and axb', 'a.b')
    expect(parts.filter(function (p) { return p.hit }).map(function (p) { return p.text }))
      .toEqual(['a.b'])
  })

  it('does not throw on an unbalanced parenthesis', () => {
    expect(function () { highlightParts('f(x) call', '(') }).not.toThrow()
    expect(highlightParts('f(x) call', '(').filter(function (p) { return p.hit }).length).toBe(1)
  })

  it('does not throw on a lone backslash or bracket class', () => {
    for (const q of ['\\', '[', '*', '+', '?', '|', '^', '$', ')']) {
      expect(function () { highlightParts('a+b*c?d|e^f$g(h)i[j]k\\l', q) }).not.toThrow()
    }
  })

  it('is case-insensitive but preserves the original casing', () => {
    const parts = highlightParts('Memory and memory', 'memory')
    const hits = parts.filter(function (p) { return p.hit }).map(function (p) { return p.text })
    expect(hits).toEqual(['Memory', 'memory'])
  })

  it('handles a term spanning the whole string', () => {
    expect(highlightParts('abc', 'abc')).toEqual([{ text: 'abc', hit: true }])
  })

  it('handles empty text', () => {
    expect(highlightParts('', 'x')).toEqual([{ text: '', hit: false }])
  })

  it('does not overlap or drop characters for a repeated term', () => {
    const parts = highlightParts('aaaa', 'aa')
    expect(parts.map(function (p) { return p.text }).join('')).toBe('aaaa')
    // Non-overlapping scan: "aa"+"aa", not "aa" starting at 0 then 1.
    expect(parts.filter(function (p) { return p.hit }).length).toBe(2)
  })
})

// ── Styles ─────────────────────────────────────────────────────────

describe('console styles', () => {
  it('uses only dsw design tokens for colour', () => {
    // The contract is "no hardcoded *colour*", not "no literal anywhere": a
    // layout keyword like `background: none` or `border: none` is theme-neutral
    // and must stay legal. So instead of an allowlist of properties (which
    // silently rots as new ones appear), this flags the actual colour literals:
    // hex, rgb()/hsl(), and the named colours, unless wrapped in a var().
    // `white-space` must not trip the `white` alternative, so a named colour
    // only counts when it stands alone as a value (bounded by space, comma,
    // paren or end) rather than as part of a hyphenated keyword.
    const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?:^|[\s,(])(?:white|black|red|green|blue|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?=[\s,;)]|$)/
    const decls = STYLES.match(/[a-z-]+:\s*[^;]+;/g) ?? []
    for (const d of decls) {
      // Strip every token reference first: what remains is the literal part.
      const withoutTokens = d.replace(/var\(--dsw-[^)]*\)/g, '')
      expect(
        colorLiteral.test(withoutTokens),
        `hardcoded colour in: ${d.trim()}`,
      ).toBe(false)
    }
  })

  it('has the console classes the component references', () => {
    for (const cls of [
      'dsh-memory-tabs', 'dsh-memory-tab', 'dsh-memory-card', 'dsh-memory-row',
      'dsh-memory-console', 'dsh-memory-pane', 'dsh-memory-empty',
      'dsh-memory-skeleton', 'dsh-memory-search', 'dsh-memory-pill',
      'dsh-memory-bar', 'dsh-memory-stat', 'dsh-memory-action',
    ]) {
      expect(STYLES, `missing .${cls}`).toContain(`.${cls}`)
    }
  })

  it('keeps the overlay click-through opt-in', () => {
    expect(STYLES).toContain('pointer-events: auto')
  })

  it('only references classes that Console.tsx or Panel.tsx actually define', () => {
    // Guards the reverse drift: a style rule for a class nothing renders is
    // dead weight, and a class the component renders with no rule is naked.
    const panel = readFileSync(new URL('../src/client/Panel.tsx', import.meta.url), 'utf8')
    const used = new Set<string>()
    for (const src of [CONSOLE, panel]) {
      for (const m of src.matchAll(/dsh-memory-[a-z0-9-]+/g)) used.add(m[0])
    }
    const declared = new Set<string>()
    for (const m of STYLES.matchAll(/\.(dsh-memory-[a-z0-9-]+)/g)) declared.add(m[1])
    for (const cls of declared) {
      expect(used.has(cls), `${cls} is styled but never rendered`).toBe(true)
    }
  })
})

describe('mutation: colour-token guard', () => {
  it('goes red when a hardcoded colour is introduced', () => {
    // The guard must bite, or "no hardcoded colours" is a slogan. Feed it a
    // stylesheet with one literal colour and require it to be reported.
    const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?:^|[\s,(])(?:white|black|red|green|blue|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?=[\s,;)]|$)/
    const scan = function (css: string): boolean {
      for (const d of css.match(/[a-z-]+:\s*[^;]+;/g) ?? []) {
        if (colorLiteral.test(d.replace(/var\(--dsw-[^)]*\)/g, ''))) return true
      }
      return false
    }
    // Clean token-using CSS passes...
    expect(scan('.a { color: var(--dsw-alias-label-primary); }')).toBe(false)
    // ...and any of these mutants is caught.
    expect(scan('.a { color: #ff0000; }')).toBe(true)
    expect(scan('.a { color: rgba(255,0,0,.5); }')).toBe(true)
    expect(scan('.a { background: black; }')).toBe(true)
    // A hyphenated keyword is not a colour: this must stay clean.
    expect(scan('.a { white-space: nowrap; }')).toBe(false)
  })
})

// ── searchFailureText: failure must not read as "no results" ────────

describe('searchFailureText', () => {
  it('does not say the same thing as an empty result set', () => {
    // A failed search and an empty search look identical to the user unless
    // the copy differs — and only one of them deserves a retry.
    const empty = previewEmptyText({ view: 'x', status: 'ok', count: 0, items: [] })!
    expect(searchFailureText()).not.toBe(empty.title)
  })

  it('tells the user to retry, since a transport failure is transient', () => {
    expect(searchFailureText()).toContain('重试')
  })

  it('is stable under mutation: a copy equal to the empty text is caught', () => {
    const mutant = function () { return '没有匹配的记忆' }
    expect(mutant()).toBe('没有匹配的记忆')
    expect(searchFailureText()).not.toBe(mutant())
  })
})

// ── Mutation checks ────────────────────────────────────────────────
//
// Each block substitutes a known-wrong implementation for the real one and
// runs the SAME assertion the real function is held to. If the assertion still
// passes under the mutation, the test was decorative: it would not have caught
// the bug. The pattern is always
//
//   assert(real)                                     // must pass
//   expect(() => assert(mutant)).toThrow()           // must be caught

describe('mutation: previewEmptyText', () => {
  it('goes red when both statuses collapse to one message', () => {
    // A plausible "simplification": treat every empty list the same, ignore
    // status. This is the exact bug the unsupported/empty split exists for.
    const mutant = function (d: PreviewData | null) {
      if (d && (d.items?.length ?? 0) === 0) return { title: '暂无内容', hint: '这里还没有条目' }
      return null
    }
    const assert = function (f: typeof previewEmptyText) {
      const unsupported = f(preview({ status: 'unsupported' }))!
      const empty = f(preview({ status: 'ok', items: [] }))!
      expect(unsupported.title).not.toBe(empty.title)
    }
    assert(previewEmptyText)                        // real: passes
    expect(function () { assert(mutant) }).toThrow() // mutant: caught
  })

  it('goes red when the unsupported branch is dropped', () => {
    const mutant = function (d: PreviewData | null) {
      if (d && d.status === 'unsupported') return null
      return d && d.items.length === 0 ? { title: '暂无内容', hint: 'h' } : null
    }
    const assert = function (f: typeof previewEmptyText) {
      expect(f(preview({ status: 'unsupported' }))).not.toBeNull()
    }
    assert(previewEmptyText)
    expect(function () { assert(mutant) }).toThrow()
  })
})

describe('mutation: dismissReasonText', () => {
  it('goes red when reasons are passed through raw', () => {
    const mutant = function (r: string | null | undefined) { return String(r) }
    const assert = function (f: typeof dismissReasonText) {
      // The user must not be shown the machine's own vocabulary.
      expect(f('not-found')).not.toBe('not-found')
      expect(f('invalid-name')).not.toBe('invalid-name')
      expect(f('outside-inbox')).not.toBe('outside-inbox')
    }
    assert(dismissReasonText)
    expect(function () { assert(mutant) }).toThrow()
  })
})

describe('mutation: highlightParts', () => {
  it('goes red when nothing is ever marked', () => {
    const mutant = function (text: string, _q: string) { return [{ text, hit: false }] }
    const assert = function (f: typeof highlightParts) {
      expect(f('记忆库', '记忆').filter(function (p) { return p.hit }).length)
        .toBeGreaterThan(0)
    }
    assert(highlightParts)
    expect(function () { assert(mutant) }).toThrow()
  })

  it('goes red when a regex implementation over-matches a literal query', () => {
    // `new RegExp('a.b')` treats "." as a wildcard, so "axb" would be marked —
    // and an unbalanced "(" would throw outright.
    const mutant = function (text: string, q: string) {
      const pieces = text.split(new RegExp(q))
      return pieces.map(function (s) { return { text: s, hit: false } })
    }
    const assert = function (f: typeof highlightParts) {
      // Literal matching: exactly one hit, and it is the literal "a.b".
      const hits = f('a.b and axb', 'a.b').filter(function (p) { return p.hit })
      expect(hits.map(function (p) { return p.text })).toEqual(['a.b'])
      // And a regex-hostile query must not throw.
      expect(function () { f('f(x)', '(') }).not.toThrow()
    }
    assert(highlightParts)
    expect(function () { assert(mutant) }).toThrow()
  })

  it('goes red when an empty query is marked instead of ignored', () => {
    const mutant = function (text: string, _q: string) { return [{ text, hit: true }] }
    const assert = function (f: typeof highlightParts) {
      expect(f('x', '').some(function (p) { return p.hit })).toBe(false)
      expect(f('x', '   ').some(function (p) { return p.hit })).toBe(false)
    }
    assert(highlightParts)
    expect(function () { assert(mutant) }).toThrow()
  })
})
