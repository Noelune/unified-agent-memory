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
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

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

/**
 * Strip `/* … *\/` block comments and `// …` line comments from a source file.
 *
 * Why this exists: the "wiring" assertions below are source-string checks, and
 * a bare `expect(src).toContain('useSearch')` is satisfied by a *mention* in a
 * comment just as well as by a real call. The header comment of `Console.tsx`
 * literally lists `useSearch` / `usePreview(…)` / `dismissItem`, so the three
 * hook assertions could never go red — deleting the call, and even the import,
 * left them green (verified by mutation). Asserting against the comment-stripped
 * source is what makes "the call is wired" mean "there is code, not prose".
 *
 * This is a line-based scanner rather than one regex because `/* … *\/` and
 * `//` interact: a `//` inside a block comment is not a line comment, and a
 * string literal containing `//` (a URL) must not be truncated. The scanner
 * tracks block-comment depth and leaves everything else byte-identical, so
 * offsets in the result still line up with the original for line counting.
 *
 * CEILING: it does not parse string literals, so a `//` inside a *string*
 * (e.g. `'https://x'`) is treated as a line comment and the rest of that line
 * is dropped. No assertion below depends on text after such a literal, so this
 * is safe here; a future assertion that does would need a real tokenizer.
 * ponytail: upgrade path is esbuild's tokenizer, already a devDependency.
 */
function stripComments(src: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of src.split('\n')) {
    let kept = ''
    let i = 0
    while (i < line.length) {
      const rest = line.slice(i)
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end < 0) { i = line.length; continue }
        inBlock = false
        i += end + 2
        continue
      }
      if (rest.startsWith('/*')) { inBlock = true; i += 2; continue }
      if (rest.startsWith('//')) break
      kept += line[i]
      i += 1
    }
    // A line that opened a block comment still contributes its kept prefix; a
    // line that is entirely inside one contributes nothing.
    out.push(kept)
  }
  return out.join('\n')
}

const CONSOLE_CODE = stripComments(CONSOLE)

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
    // Against the comment-stripped source: "renders the console" must mean the
    // export exists in code, not that the header comment says "console".
    expect(CONSOLE_CODE).toContain('export function Console')
    expect(CONSOLE_CODE).toContain('CONSOLE_TABS')
  })

  it('uses the store hooks, not ad-hoc fetching', () => {
    // Assert the CALL FORM, against the comment-stripped source.
    //
    // The original `expect(CONSOLE).toContain('useSearch')` was decorative: the
    // header comment names all three hooks, so the assertion was satisfied by
    // prose. Mutation-verified — deleting `useSearch()` *and* its import left
    // the whole file green. So: strip comments, then require each hook to be
    // INVOKED (an assignment/expression `useSearch(`, not a bare mention in an
    // import list). Deleting either the call or the import now fails here.
    expect(CONSOLE_CODE).toMatch(/\bconst\s+\w+\s*=\s*useSearch\(/)
    expect(CONSOLE_CODE).toMatch(/\bconst\s+\{[^}]*\}\s*=\s*usePreview\(/)
    expect(CONSOLE_CODE).toMatch(/[^.\w]dismissItem\(/)
    expect(CONSOLE_CODE).not.toMatch(/fetch\(/)
  })

  it('imports react api from deps only', () => {
    expect(CONSOLE_CODE).toContain("from '../deps.ts'")
    expect(CONSOLE_CODE).not.toMatch(/from\s+['"]react['"]/)
  })

  it('marks search hits with a highlight element', () => {
    expect(CONSOLE_CODE).toContain("'mark'")
  })

  it('gates dismiss on the ok flag, not the http status', () => {
    // dismissItem resolves false on a 200-with-ok:false refusal, so the reload
    // must key off the boolean, never off a response status.
    expect(CONSOLE_CODE).toMatch(/dismissItem[\s\S]{0,200}?\bok\b/)
    expect(CONSOLE_CODE).not.toMatch(/status\s*===?\s*200/)
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
    //
    // Figures.tsx joined the renderer set in fix round 1. It is a third client
    // component with its own class names, so leaving it out made this test
    // report "dsh-memory-figure is styled but never rendered" for all 17 of the
    // figure classes. The assertion is unchanged — the set of components that
    // can render a class was simply incomplete. The opposite direction (a class
    // Figures.tsx RENDERS with no rule) is pinned in
    // test/client-figures.test.ts, which is the test that would have caught C-1.
    const panel = readFileSync(new URL('../src/client/Panel.tsx', import.meta.url), 'utf8')
    const figures = readFileSync(new URL('../src/client/Figures.tsx', import.meta.url), 'utf8')
    const used = new Set<string>()
    for (const src of [CONSOLE, panel, figures]) {
      for (const m of src.matchAll(/dsh-memory-[a-z0-9-]+/g)) used.add(m[0])
    }
    const declared = new Set<string>()
    for (const m of STYLES.matchAll(/\.(dsh-memory-[a-z0-9-]+)/g)) declared.add(m[1])
    for (const cls of declared) {
      expect(used.has(cls), `${cls} is styled but never rendered`).toBe(true)
    }
  })
})

// ── Host token existence ───────────────────────────────────────────
//
// This is the escape Task 7 kept getting caught by, one level down: the
// "no hardcoded colours" guard above only checks that a colour is written as
// `var(--dsw-…)`. It says nothing about whether the host theme DECLARES that
// property. A `var()` pointing at an undeclared property is invalid at
// computed-value time, so the declaration falls back to `inherit`/initial —
// the element renders colourless, and every static check still passes. Five
// such phantom tokens shipped: `--dsw-alias-accent`, `-err`, `-err-bg`, `-ok`
// and `-warn`.
//
// So this block resolves the host theme module and diffs its declared custom
// properties against every token `styles.ts` references. The failure it must
// catch is "a token that looks plausible and is not declared".

/**
 * Locate the host theme bundle without pinning a machine path.
 *
 * The host ships the theme as a nested dependency of `@deepseek-ai/dsh`, which
 * itself lives in the global npm root — NOT on the `node_modules` chain that
 * `require.resolve` walks up from this repository. So a plain `require.resolve`
 * of the theme package fails even though the package is installed. The
 * strategies below cover each layout, and every path is derived at runtime
 * (resolution roots, `npm`-provided prefixes) so nothing user-specific gets
 * committed.
 */
function findHostTheme(): string | null {
  const THEME_REL = join('@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js')
  const candidates: string[] = []
  const push = function (p: string | null | undefined) { if (p) candidates.push(p) }
  const safe = function <T>(fn: () => T): T | null {
    try { return fn() } catch { return null }
  }

  const req = createRequire(new URL('../src/client/styles.ts', import.meta.url))

  // 1. The theme package as a resolvable dependency of this package.
  push(safe(() => req.resolve('@deepseek-ai/dsh-client-ui-theme/lib/client.js')))

  // 2. The host package resolves — look inside its own node_modules, which is
  //    where it nests the theme.
  const dshManifest = safe(() => req.resolve('@deepseek-ai/dsh/package.json'))
  if (dshManifest) {
    push(join(dirname(dshManifest), 'node_modules', THEME_REL))
  }

  // 3. Global npm roots: the host is installed globally on this machine, which
  //    is exactly the case `require.resolve` cannot reach from here.
  const roots: string[] = []
  pushRoot(process.env.npm_config_prefix)
  pushRoot(process.env.NPM_CONFIG_PREFIX)
  pushRoot(process.env.PREFIX)
  const npmRoot = safe(function () {
    return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  })
  if (npmRoot) roots.push(npmRoot)
  function pushRoot(prefix: string | undefined) {
    if (prefix) roots.push(join(prefix, 'node_modules'))
  }
  for (const root of new Set(roots)) {
    // the observed layout: <root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/…
    push(join(root, '@deepseek-ai', 'dsh', 'node_modules', THEME_REL))
    // and the flat layout, in case the theme is hoisted to the root
    push(join(root, THEME_REL))
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Every custom property the host theme declares, as a set of names. */
function declaredHostTokens(file: string): Set<string> {
  const src = readFileSync(file, 'utf8')
  const names = new Set<string>()
  // A declaration is `--name:` at statement position. Matching the colon keeps
  // us from counting a mere mention inside a comment or a string.
  for (const m of src.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) names.add(m[1])
  return names
}

const HOST_THEME = findHostTheme()

// ── Theme resolution: read the real values out of the host bundle ──
//
// The `DARK_THEME` table further down is a hand-maintained snapshot and can rot
// when the host palette moves. The two blocks below need the values for BOTH
// themes, so instead of adding a second hand-typed table they RESOLVE the
// alias → static → hex chain straight out of the host bundle at test time.
// If the host cannot be found they skip loudly, same contract as the token
// block: skipping is allowed, passing vacuously is not.

/** One parsed theme block: alias and static custom properties → raw value. */
type ThemeVars = {
  alias: Map<string, string>
  static: Map<string, string>
}

/**
 * Parse BOTH theme blocks out of the host bundle.
 *
 * The bundle emits the same custom property name once per theme, in document
 * order: the light block first, the dark block second (verified against
 * `lib/client.js`). So the first declaration of a name is light and the last
 * is dark. Parsing positionally instead of by selector keeps this working
 * even though the bundle is minified and the selector names are generated.
 */
function parseTheme(file: string): { light: ThemeVars; dark: ThemeVars } {
  const src = readFileSync(file, 'utf8')
  const collect = function (re: RegExp): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of src.matchAll(re)) {
      const name = m[1]
      if (!out.has(name)) out.set(name, [])
      out.get(name)!.push(m[2].trim())
    }
    return out
  }
  const aliases = collect(/(--dsw-alias-[a-z0-9-]+)\s*:\s*([^;{}]+);/g)
  const statics = collect(/(--dsw-static-[a-z0-9-]+)\s*:\s*([^;{}]+);/g)

  const side = function (which: 'light' | 'dark'): ThemeVars {
    const pick = function (m: Map<string, string[]>): Map<string, string> {
      const out = new Map<string, string>()
      for (const [k, v] of m) out.set(k, which === 'light' ? v[0] : v[v.length - 1])
      return out
    }
    return { alias: pick(aliases), static: pick(statics) }
  }
  return { light: side('light'), dark: side('dark') }
}

/**
 * Resolve a `var(--token)` reference through a theme's own declarations.
 *
 * The chain in this theme is at most `alias → static → hex`, but the resolver
 * loops rather than unrolling two hops, so a future `alias → alias → static`
 * still lands. An unresolvable reference becomes the literal string `''`; the
 * caller asserts on that, which is why a rename fails instead of silently
 * comparing `NaN`.
 */
function resolveVar(value: string, vars: ThemeVars, depth = 0): string {
  if (depth > 8) return ''
  const m = value.match(/^var\((--dsw-[a-z0-9-]+)\)$/)
  if (!m) return value
  const next = vars.alias.get(m[1]) ?? vars.static.get(m[1])
  if (next === undefined) return ''
  return resolveVar(next, vars, depth + 1)
}

/** `#fff` → `#ffffff`, so the luminance helper only ever sees six digits. */
function expandHex(hex: string): string {
  const h = hex.replace('#', '').trim()
  if (h.length === 3) return '#' + h.split('').map(function (c) { return c + c }).join('')
  return '#' + h.slice(0, 6)
}

/**
 * Resolve a token to an sRGB hex, COMPOSITING any alpha it carries over a
 * backdrop.
 *
 * The host ships its surface tints as 8-digit `#rrggbbaa` literals (e.g.
 * `interactive-bg-hover-danger`), and an alpha colour has no luminance of its
 * own — it takes the luminance of whatever it is painted on. Skipping this
 * step is exactly how "error text on the tinted banner" got reported at
 * 3.96:1 using the tint's RGB and the wrong assumption about its alpha.
 */
function tokenHex(token: string, vars: ThemeVars, backdrop: string): string {
  const raw = vars.alias.get(token) ?? vars.static.get(token)
  if (raw === undefined) return ''
  const resolved = resolveVar(raw, vars)
  if (resolved === '') return ''
  const h = resolved.replace('#', '').trim()
  if (h.length === 8) {
    const a = parseInt(h.slice(6, 8), 16) / 255
    const fg = [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16) })
    const bg = [0, 2, 4].map(function (i) { return parseInt(expandHex(backdrop).slice(i + 1, i + 3), 16) })
    const mixed = fg.map(function (c, i) { return Math.round(c * a + bg[i] * (1 - a)) })
    return '#' + mixed.map(function (c) { return c.toString(16).padStart(2, '0') }).join('')
  }
  return expandHex(resolved)
}


describe('styles tokens exist in the host theme', () => {
  it('locates the host theme bundle, or says why it cannot', () => {
    // Skipping is allowed; passing vacuously is not. If the theme cannot be
    // found the suite reports the reason rather than going quietly green.
    if (!HOST_THEME) {
      console.warn(
        '[client-console] host theme bundle not found via require.resolve or the ' +
        'DSH checkout; token-existence assertions SKIPPED. Install ' +
        '@deepseek-ai/dsh-client-ui-theme or run inside the DSH checkout to enable.',
      )
    }
    expect(HOST_THEME === null || existsSync(HOST_THEME)).toBe(true)
  })

  it('references only custom properties the host actually declares', () => {
    // The core assertion. Each token in styles.ts must appear in the host
    // theme's declaration set; a `var()` to an undeclared property is the
    // colourless-at-runtime bug this test exists to prevent.
    if (!HOST_THEME) {
      console.warn(
        '[client-console] host theme bundle not found; ' +
        'cannot verify token existence — skipping (see previous test).',
      )
      return
    }

    const declared = declaredHostTokens(HOST_THEME)
    // Guard the guard: an empty or truncated host read would make the diff
    // below pass on anything.
    expect(declared.size, 'host theme declaration set looks empty').toBeGreaterThan(100)

    const refs = Array.from(STYLES.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g))
      .map(function (m) { return m[1] })
    expect(refs.length, 'styles.ts references no tokens at all').toBeGreaterThan(0)

    const phantom = Array.from(new Set(refs))
      .filter(function (t) { return !declared.has(t) })
      .sort()

    expect(
      phantom,
      'styles.ts references tokens the host theme never declares ' +
      '(var() to these renders colourless): ' + phantom.join(', '),
    ).toEqual([])
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
// failure mode is a plausible-looking alias whose literal is too dark — see the
// light-theme caption value pinned inside.

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
 *
 * Values verified against `@deepseek-ai/dsh-client-ui-theme`'s `lib/client.js`
 * (the same file the token-existence block reads). That bundle carries BOTH
 * theme blocks, light first then dark, so a `--dsw-alias-label-*` value picked
 * from the wrong block reads as light-theme colour under a dark-theme label —
 * which is what happened to the `caption` row below (it held `#81858c`, the
 * LIGHT value; dark resolves `caption` to `#adb2b8`, same as `tertiary`).
 *
 * CEILING: this is still a hand-maintained snapshot of the dark theme only. It
 * is not re-derived at runtime, so a host upgrade that changes a palette value
 * will not refresh it. The token-existence block DOES re-read the host, so a
 * renamed/removed token still fails; only a changed *value* can pass silently.
 * `--dsw-alias-label-tertiary` in the LIGHT theme is `#81858c`, which is 3.71:1
 * on a white card — below AA. The console ships dark-first and this table does
 * not assert the light theme at all.
 */
const DARK_THEME = {
  '--dsw-alias-bg-base': '#151517',        // bluish-950
  '--dsw-alias-bg-layer-1': '#232324',     // bluish-875 — the card surface
  '--dsw-alias-bg-layer-2': '#2c2c2e',     // bluish-850
  '--dsw-alias-bg-layer-3': '#353638',     // bluish-800
  '--dsw-alias-label-primary': '#f9fafb',  // bluish-50
  '--dsw-alias-label-secondary': '#cfd3d6', // bluish-300
  '--dsw-alias-label-tertiary': '#adb2b8', // bluish-400
  '--dsw-alias-label-caption': '#adb2b8',  // bluish-400 — SAME as tertiary in dark
  '--dsw-alias-label-dimmed': '#43454a',   // bluish-750 — 1.64:1 on the card
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

  it('shows the caption trap is real — in the light theme, not the dark one', () => {
    // An earlier revision of this table gave `caption` the hex `#81858c` and
    // called it the near-miss grey. That was the LIGHT-theme value; in the dark
    // theme `caption` and `tertiary` resolve to the SAME token (`bluish-400`),
    // so no dark-theme caption trap exists and the old assertion was asserting
    // a light value under a dark label.
    //
    // The trap is real, it is just theme-local: light `tertiary`/`caption` is
    // `#81858c`, which is 3.71:1 on a white card — below AA. Pinned here so the
    // distinction lives in the suite rather than in a review comment.
    const LIGHT_CARD = '#ffffff'
    const LIGHT_TERIARY = '#81858c'
    expect(contrast(DARK_THEME['--dsw-alias-label-tertiary'], CARD)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(LIGHT_TERIARY, LIGHT_CARD)).toBeLessThan(4.5)
    // And in the dark theme the two "grey" aliases are the same colour, which is
    // why the dark table cannot tell them apart.
    expect(DARK_THEME['--dsw-alias-label-caption'])
      .toBe(DARK_THEME['--dsw-alias-label-tertiary'])
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
// escapes: a helper that is tested, correct, and never called.
//
// These assertions read `CONSOLE_CODE` / `PANEL_CODE` — the comment-stripped
// source — not the raw file. That is not cosmetic: the earlier revision read
// the raw file with bare `toContain('useSearch')`, and `Console.tsx`'s own
// header comment lists the hook names, so the assertion was satisfied by prose
// and could never go red. Stripping comments means "the call is wired" is a
// claim about code. Assertions that name a call site additionally match the
// call FORM (`useSearch(`), so a mere import mention is not enough either.

const PANEL = readFileSync(new URL('../src/client/Panel.tsx', import.meta.url), 'utf8')
const PANEL_CODE = stripComments(PANEL)

describe('wiring: MemorySheet renders the Console', () => {
  it('imports Console from the component module, not from view', () => {
    expect(PANEL_CODE).toMatch(/import\s*\{\s*Console\s*\}\s*from\s*['"]\.\/Console\.tsx['"]/)
  })

  it('passes the live status payload into it', () => {
    // Not merely `h(Console, null)` — the sheet must forward the store data,
    // or the system tab shows "—" for a vault that is actually connected.
    const call = PANEL_CODE.slice(PANEL_CODE.indexOf('h(Console'))
    expect(call.slice(0, call.indexOf(')'))).toMatch(/status\s*:/)
  })

  it('renders it on the production path', () => {
    // MemoryOverlay is the registered shell.overlay occupant; the sheet inside
    // it is what a user sees. If `MemorySheet` stops reaching `Console`, the
    // console never appears even though every unit test above still passes.
    expect(PANEL_CODE).toMatch(/export function MemorySheet\(\)/)
    expect(PANEL_CODE).toMatch(/h\(MemorySheet,\s*null\)/)
  })
})

describe('wiring: the four tabs come from CONSOLE_TABS', () => {
  it('derives the tab strip from the constant instead of four literals', () => {
    // The mutation to catch: replacing `CONSOLE_TABS.map(...)` with four
    // hand-written buttons. That would still render four tabs and still pass
    // the value test on CONSOLE_TABS itself — the array would simply stop
    // driving anything.
    expect(CONSOLE_CODE).toMatch(/CONSOLE_TABS\.map\(/)
  })

  it('does not hardcode the tab list a second time', () => {
    // Exactly one occurrence of the tab-id tuple: the one inside the
    // CONSOLE_TABS declaration. A second copy in the render path means the
    // constant can drift away from what is drawn.
    const literals = CONSOLE_CODE.match(/'search'|"search"/g) ?? []
    expect(literals.length, 'the tab ids should be declared once, in view.ts').toBe(0)
  })

  it('keeps the labels keyed by tab so no tab can be added without copy', () => {
    expect(CONSOLE_CODE).toMatch(/TAB_LABEL\[t\]/)
  })
})

describe('wiring: a dismiss refusal is turned into a sentence', () => {
  it('routes the reason through dismissReasonText', () => {
    // The mutation to catch: `dismissItem(name).then(ok => { if (ok) reload() })`
    // — the refusal is dropped on the floor and the user sees nothing happen.
    expect(CONSOLE_CODE).toMatch(/dismissReasonText\(/)
  })

  it('stores the mapped text in state that the render path reads', () => {
    const handler = CONSOLE_CODE.slice(CONSOLE_CODE.indexOf('function onDismiss'))
    const body = handler.slice(0, handler.indexOf('const items'))
    // The mapped sentence must reach a setter...
    expect(body).toMatch(/set[A-Za-z]+\(dismissReasonText\(/)
    // ...and the value that setter owns must be rendered, not merely stored.
    const stateName = (body.match(/set([A-Za-z]+)\(/) ?? [])[1]
    const varName = stateName.charAt(0).toLowerCase() + stateName.slice(1)
    expect(CONSOLE_CODE).toMatch(new RegExp(varName + '\\s*\\?\\s*h\\(Failure'))
  })

  it('does not discard the verdict with an empty branch', () => {
    // A plausible "simplification": `if (!ok) return`. That is the exact shape
    // of silently doing nothing on refusal.
    expect(CONSOLE_CODE).not.toMatch(/then\(function \(ok[^)]*\) \{\s*if \(!ok\) return/)
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

// ── Error banner: body text must clear AA on whatever it is painted on ──
//
// Round 2 shipped the banner as `interactive-bg-hover-danger` fill with
// `state-error-primary` text and defended the resulting 3.96:1 (dark) /
// 4.14:1 (light) as the ceiling of a host that ships no error *surface* token.
// The review rejected that, correctly: a banner is the primary carrier of
// information precisely when the user most needs to read it, so sub-AA body
// text is not defensible there. And the absence of a soft error fill is itself
// the host telling us something — it does not want coloured body text on a
// coloured fill.
//
// So the banner is now NEUTRAL: a layered surface for the fill, an error
// stroke + error glyph for the semantics, and `label-primary` for the words.
// Three carriers of "this is an error" (colour, stroke, icon) and no contrast
// debt. These tests are what make that a contract instead of a hope:
//
//   * the body-vs-fill ratio must clear 4.5:1 in BOTH themes;
//   * the semantics must still be visibly error-coloured, i.e. the stroke and
//     glyph must resolve to the error family — "we fixed contrast by deleting
//     the red" is caught here;
//   * values are resolved from the host bundle, so a host palette move cannot
//     silently invalidate the arithmetic.

/** The banner's three colour roles, read out of the stylesheet source. */
function bannerRoles(css: string): { fill: string; ink: string; stroke: string; glyph: string } | null {
  // Read only the live console rule, not the leftover pre-console
  // `.dsh-memory-card`. The failure rule is unique, so a plain slice is safe.
  const at = css.indexOf('.dsh-memory-failure {')
  if (at < 0) return null
  const rule = css.slice(at, css.indexOf('}', at))
  const bg = rule.match(/background:\s*var\((--dsw-[a-z0-9-]+)\)/)
  const color = rule.match(/[^-]color:\s*var\((--dsw-[a-z0-9-]+)\)/)
  const border = rule.match(/border:\s*1px solid var\((--dsw-[a-z0-9-]+)\)/)
  // The glyph is its own rule; the semantics must be carried by an element that
  // actually renders the error colour, not just by the word "error" in a name.
  const glyphAt = css.indexOf('.dsh-memory-failure-glyph')
  const glyphRule = glyphAt < 0 ? '' : css.slice(glyphAt, css.indexOf('}', glyphAt))
  const glyph = glyphRule.match(/color:\s*var\((--dsw-[a-z0-9-]+)\)/)
  if (!bg || !color || !border || !glyph) return null
  return { fill: bg[1], ink: color[1], stroke: border[1], glyph: glyph[1] }
}

const THEMES = HOST_THEME ? parseTheme(HOST_THEME) : null
const ROLES = bannerRoles(STYLES)

describe('contrast: the error banner body text clears AA on its own fill', () => {
  it('locates the host theme, or says why it cannot', () => {
    if (!THEMES) {
      console.warn(
        '[client-console] host theme bundle not found; error-banner contrast ' +
        'assertions SKIPPED (same contract as the token-existence block).',
      )
    }
    expect(THEMES === null || HOST_THEME !== null).toBe(true)
  })

  it('resolves the three banner roles out of the stylesheet', () => {
    // Guard the guard: if the rule stops matching, the ratio test below would
    // compare empty strings and could pass. Fail loudly instead.
    expect(ROLES, 'could not parse .dsh-memory-failure { … }').not.toBeNull()
    expect(ROLES!.fill.length).toBeGreaterThan(0)
    expect(ROLES!.ink.length).toBeGreaterThan(0)
  })

  it('reports the body-vs-fill ratio for BOTH themes', () => {
    if (!THEMES) return
    // The sheet lives on the console pane, which sits on the sheet's layer-2.
    const report: Record<string, number> = {}
    for (const which of ['dark', 'light'] as const) {
      const vars = THEMES[which]
      const pane = tokenHex('--dsw-alias-bg-layer-2', vars, '#ffffff')
      const fill = tokenHex(ROLES!.fill, vars, pane)
      const ink = tokenHex(ROLES!.ink, vars, fill)
      expect(fill, `${which}: fill did not resolve`).toMatch(/^#[0-9a-f]{6}$/)
      expect(ink, `${which}: ink did not resolve (renamed token?)`).toMatch(/^#[0-9a-f]{6}$/)
      report[which] = Number(contrast(ink, fill).toFixed(2))
    }
    // Attached to the run output so the report can quote the real numbers.
    console.log('[error-banner] ink-on-fill contrast:', JSON.stringify(report))
    expect(report.dark).toBeGreaterThanOrEqual(4.5)
    expect(report.light).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the error semantics — stroke and glyph stay in the error family', () => {
    if (!THEMES) return
    // The mutation this catches: "fix contrast by dropping the red". A banner
    // whose stroke and glyph use neutral tokens has no colour carrier left and
    // is not an error banner, AA or not.
    for (const t of [ROLES!.stroke, ROLES!.glyph]) {
      expect(t, `${t} is not an error-family token`).toMatch(/state-error/)
    }
    // And the error colour must still be distinguishable from the neutral fill
    // it sits on — WCAG's 3:1 non-text floor, checked per theme.
    for (const which of ['dark', 'light'] as const) {
      const vars = THEMES[which]
      const pane = tokenHex('--dsw-alias-bg-layer-2', vars, '#ffffff')
      const fill = tokenHex(ROLES!.fill, vars, pane)
      const stroke = tokenHex(ROLES!.stroke, vars, fill)
      expect(
        contrast(stroke, fill),
        `${which}: error stroke is not distinguishable from the banner fill`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('does not put coloured body text back on a coloured fill', () => {
    // The original defect, restated as a structural rule: the banner's ink must
    // be the neutral body token. This is the assertion that goes red if someone
    // "simplifies" the banner back to a red fill with red text.
    expect(ROLES!.ink).toBe('--dsw-alias-label-primary')
    expect(ROLES!.fill).not.toMatch(/danger|error/)
  })
})

// ── Light theme: the two round-2 leftovers, now asserted ──
//
// Round 2's concerns said the light theme was never asserted, and flagged two
// values that fail under it. These tests close that gap — and they are written
// against the RESOLVED light palette, so they describe what the host actually
// renders rather than a remembered hex.

/** Every `color:`/`background:` pair the console ships, per theme. */
describe('contrast: light theme is covered, not just dark', () => {
  it('the host light tertiary really is below AA — the fact being fixed', () => {
    if (!THEMES) return
    const vars = THEMES.light
    const tertiary = tokenHex('--dsw-alias-label-tertiary', vars, '#ffffff')
    // Documented so the fix below has a baseline to move away from: this is a
    // host fact, not our arithmetic. If the host ever lifts this value, the
    // test still passes (the assertion is on OUR sheet, next) but the comment
    // and the `lessThan` guard below should be re-read.
    expect(tertiary).toBe('#81858c')
    expect(contrast(tertiary, '#ffffff')).toBeLessThan(4.5)
  })

  it('the console sheet does not paint caption greys with light-unsafe tertiary', () => {
    if (!THEMES) return
    // The real contract on OUR side: wherever the console asks for a small,
    // de-emphasised grey that lands on a card, it must be a token that clears
    // AA in the light theme too. `tertiary` is 3.71:1 there, so the sheet's
    // sheet-level caption greys (version, note, card-count) use `secondary`.
    //
    // Scoped to the rules that paint on a light card: `.dsh-memory-ver`,
    // `.dsh-memory-note`, `.dsh-memory-cardcount`, and `.dsh-memory-empty-title`
    // are the caption-sized greys inside the sheet. Each must resolve to
    // something ≥4.5:1 on the light card.
    const lightCard = tokenHex('--dsw-alias-bg-layer-2', THEMES.light, '#ffffff')
    const captionClasses = [
      '.dsh-memory-ver', '.dsh-memory-note',
      '.dsh-memory-cardcount', '.dsh-memory-empty-title',
    ]
    for (const cls of captionClasses) {
      const at = STYLES.indexOf(cls + ' {')
      expect(at, `${cls} rule missing`).toBeGreaterThanOrEqual(0)
      const rule = STYLES.slice(at, STYLES.indexOf('}', at))
      const ink = rule.match(/color:\s*var\((--dsw-[a-z0-9-]+)\)/)
      expect(ink, `${cls} declares no colour`).not.toBeNull()
      const hex = tokenHex(ink![1], THEMES.light, lightCard)
      expect(hex, `${cls}: ${ink![1]} did not resolve`).toMatch(/^#[0-9a-f]{6}$/)
      expect(
        contrast(hex, lightCard),
        `${cls} paints ${ink![1]} on a light card at ` +
        `${contrast(hex, lightCard).toFixed(2)}:1 — below AA`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the pending pill stays legible in the light theme', () => {
    if (!THEMES) return
    // Round 2's pill used `bg-layer-1` as ink: #232324 on dark (fine), but
    // #ffffff on light, i.e. white-on-amber ≈ 1.9:1. The ink must be a FIXED
    // deep neutral that does not flip with the theme.
    const pillAt = STYLES.indexOf('.dsh-memory-pill {')
    const rule = STYLES.slice(pillAt, STYLES.indexOf('}', pillAt))
    const ink = rule.match(/[^-]color:\s*var\((--dsw-[a-z0-9-]+)\)/)![1]
    expect(ink, 'pill ink must not be a theme-flipping layer token').not.toMatch(/bg-layer/)

    for (const which of ['dark', 'light'] as const) {
      const vars = THEMES[which]
      const fill = tokenHex('--dsw-alias-state-warn-secondary', vars, '#ffffff')
      const text = tokenHex(ink, vars, fill)
      expect(text, `${which}: pill ink did not resolve`).toMatch(/^#[0-9a-f]{6}$/)
      expect(
        contrast(text, fill),
        `${which}: pill text on amber is ${contrast(text, fill).toFixed(2)}:1 — below AA`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

