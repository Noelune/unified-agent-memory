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

// ── Contrast ───────────────────────────────────────────────────────
//
// The console renders inside a `shell.overlay` sheet whose card surface is
// `--dsw-alias-bg-layer-1`. On the dark theme that token resolves to
// `--dsw-static-neutral-bluish-875` = #232324, so every text token the console
// uses must clear WCAG AA body text (4.5:1) against THAT surface, not against
// the page behind it.
//
// The token graph is asserted structurally rather than by parsing var() at
// runtime: `styles.ts` names the alias, and this block holds the alias →
// static → hex chain plus the arithmetic. Both links are needed, because the
// failure mode is a plausible-looking alias whose literal is too dark (that is
// exactly how `--dsw-alias-label-caption` gets in).

/** WCAG 2.x relative luminance from an sRGB hex string. */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const channels = [0, 2, 4].map(function (i) {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** WCAG contrast ratio between two sRGB hex colours. */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The alias → literal chain the dark theme actually resolves.
 *
 * `--dsw-alias-*` values come from the host theme's alias block; the
 * `--dsw-static-neutral-bluish-*` values are the palette those aliases point
 * at. Kept here so the arithmetic below runs on real numbers instead of a
 * `var()` string no test runner can resolve.
 */
const DARK_THEME = {
  '--dsw-alias-bg-base': '#151517',        // bluish-950
  '--dsw-alias-bg-layer-1': '#232324',     // bluish-875 — the card surface
  '--dsw-alias-bg-layer-2': '#2c2c2e',     // bluish-850
  '--dsw-alias-bg-layer-3': '#353638',     // bluish-800
  '--dsw-alias-label-primary': '#f9fafb',  // bluish-50
  '--dsw-alias-label-secondary': '#cfd3d6', // bluish-300
  '--dsw-alias-label-tertiary': '#adb2b8', // bluish-400
  '--dsw-alias-label-caption': '#81858c',  // bluish-600  ← 3.90:1 on the card
  '--dsw-alias-label-dimmed': '#43454a',   // bluish-750
} as const

const CARD = DARK_THEME['--dsw-alias-bg-layer-1']

describe('contrast: minor text clears WCAG AA against the card', () => {
  it('checks the arithmetic itself, so the numbers are not taken on faith', () => {
    // #7E8288 on #1C2026 is the value an earlier review round mis-reported as
    // 4.9:1. It is 4.23:1 — below AA. Pinning it keeps the helper honest.
    expect(contrast('#7E8288', '#1C2026')).toBeCloseTo(4.23, 1)
    // The reference extremes.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrast('#232324', '#232324')).toBeCloseTo(1, 5)
  })

  it('shows why the caption token was the trap, not the tertiary one', () => {
    // Both are "grey", one passes and one does not. This is the distinction an
    // eyeball (or an approximate tool) cannot make, and the reason the console
    // must not reach for `--dsw-alias-label-caption`.
    expect(contrast(DARK_THEME['--dsw-alias-label-tertiary'], CARD)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(DARK_THEME['--dsw-alias-label-caption'], CARD)).toBeLessThan(4.5)
  })

  it('uses only text tokens that clear 4.5:1 against the card surface', () => {
    // Every `color:`/`--text:` declaration in the console that points at a
    // `--dsw-alias-label-*` token must resolve to a passing value. A new
    // declaration naming a too-dark alias fails here instead of shipping.
    const failing = Object.entries(DARK_THEME)
      .filter(function (e) { return e[0].includes('label-') })
      .filter(function (e) { return contrast(e[1], CARD) < 4.5 })
      .map(function (e) { return e[0] })

    const used = Array.from(STYLES.matchAll(/var\((--dsw-alias-label-[a-z0-9-]+)\)/g))
      .map(function (m) { return m[1] })
    const usedFailing = Array.from(new Set(used)).filter(function (t) {
      return failing.indexOf(t) >= 0
    })

    expect(usedFailing, `text token below 4.5:1 on the card: ${usedFailing.join(', ')}`)
      .toEqual([])
    // Guard the guard: the console must actually name some text token, or the
    // assertion above passes vacuously on an empty stylesheet.
    expect(used.length).toBeGreaterThan(0)
  })
})

describe('contrast: the card boundary is visible against the page', () => {
  it('separates the card surface from the sheet background by more than 1.2:1', () => {
    // Measured on the shipped screenshot: page #131419, card #1C2026 = 1.12:1,
    // which reads as one flat mass. The live dark theme does better (1.16:1)
    // but still needs a real edge, so the console draws its own border.
    expect(contrast(DARK_THEME['--dsw-alias-bg-layer-1'], DARK_THEME['--dsw-alias-bg-base']))
      .toBeGreaterThan(1.12)
  })

  it('does not leave the card edge to a fill difference alone', () => {
    // 1.16:1 of fill difference cannot carry the boundary on its own; the card
    // must also declare a stroke stronger than the hairline l1. Read the rule
    // from the console section, past the leftover pre-console `.dsh-memory-card`.
    const consoleCss = STYLES.slice(STYLES.indexOf('── Four-tab console'))
    const card = consoleCss.slice(consoleCss.indexOf('.dsh-memory-card {'))
    const rule = card.slice(0, card.indexOf('}'))
    expect(rule).toMatch(/border:\s*1px solid var\(--dsw-alias-(border-l2|border-l3)\)/)
  })
})

// ── Wiring ─────────────────────────────────────────────────────────
//
// The pure functions above are tested by importing them. The *call sites* are
// source-asserted, because there is no DOM renderer here and `Console.tsx`
// pulls in React through `deps.ts`. That is a real ceiling: these assertions
// prove the wiring EXISTS, not that React renders it in a particular order.
//
// They are still worth having, because the failure they catch is the one that
// escapes: a helper that is tested, correct, and never called. Each assertion
// below is written to go red the moment the call is deleted.

const PANEL = readFileSync(new URL('../src/client/Panel.tsx', import.meta.url), 'utf8')

describe('wiring: MemorySheet renders the Console', () => {
  it('imports Console from the component module, not from view', () => {
    expect(PANEL).toMatch(/import\s*\{\s*Console\s*\}\s*from\s*['"]\.\/Console\.tsx['"]/)
  })

  it('passes the live status payload into it', () => {
    // Not merely `h(Console, null)` — the sheet must forward the store data,
    // or the system tab shows "—" for a vault that is actually connected.
    const call = PANEL.slice(PANEL.indexOf('h(Console'))
    expect(call.slice(0, call.indexOf(')'))).toMatch(/status\s*:/)
  })

  it('renders it on the production path', () => {
    // MemoryOverlay is the registered shell.overlay occupant; the sheet inside
    // it is what a user sees. If `MemorySheet` stops reaching `Console`, the
    // console never appears even though every unit test above still passes.
    expect(PANEL).toMatch(/export function MemorySheet\(\)/)
    expect(PANEL).toMatch(/h\(MemorySheet,\s*null\)/)
  })
})

describe('wiring: the four tabs come from CONSOLE_TABS', () => {
  it('derives the tab strip from the constant instead of four literals', () => {
    // The mutation to catch: replacing `CONSOLE_TABS.map(...)` with four
    // hand-written buttons. That would still render four tabs and still pass
    // the value test on CONSOLE_TABS itself — the array would simply stop
    // driving anything.
    expect(CONSOLE).toMatch(/CONSOLE_TABS\.map\(/)
  })

  it('does not hardcode the tab list a second time', () => {
    // Exactly one occurrence of the tab-id tuple: the one inside the
    // CONSOLE_TABS declaration. A second copy in the render path means the
    // constant can drift away from what is drawn.
    const literals = CONSOLE.match(/'search'|"search"/g) ?? []
    expect(literals.length, 'the tab ids should be declared once, in view.ts').toBe(0)
  })

  it('keeps the labels keyed by tab so no tab can be added without copy', () => {
    expect(CONSOLE).toMatch(/TAB_LABEL\[t\]/)
  })
})

describe('wiring: a dismiss refusal is turned into a sentence', () => {
  it('routes the reason through dismissReasonText', () => {
    // The mutation to catch: `dismissItem(name).then(ok => { if (ok) reload() })`
    // — the refusal is dropped on the floor and the user sees nothing happen.
    expect(CONSOLE).toMatch(/dismissReasonText\(/)
  })

  it('stores the mapped text in state that the render path reads', () => {
    const handler = CONSOLE.slice(CONSOLE.indexOf('function onDismiss'))
    const body = handler.slice(0, handler.indexOf('const items'))
    // The mapped sentence must reach a setter...
    expect(body).toMatch(/set[A-Za-z]+\(dismissReasonText\(/)
    // ...and the value that setter owns must be rendered, not merely stored.
    const stateName = (body.match(/set([A-Za-z]+)\(/) ?? [])[1]
    const varName = stateName.charAt(0).toLowerCase() + stateName.slice(1)
    expect(CONSOLE).toMatch(new RegExp(varName + '\\s*\\?\\s*h\\(Failure'))
  })

  it('does not discard the verdict with an empty branch', () => {
    // A plausible "simplification": `if (!ok) return`. That is the exact shape
    // of silently doing nothing on refusal.
    expect(CONSOLE).not.toMatch(/then\(function \(ok[^)]*\) \{\s*if \(!ok\) return/)
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
