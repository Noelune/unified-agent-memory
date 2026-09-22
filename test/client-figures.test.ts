/**
 * Task 8 — the four SVG memory figures.
 *
 * Three layers, deliberately:
 *
 *  1. behavior — the display decisions (error vs empty vs populated, label
 *     truncation, the date-axis caption, the heatmap intensity ramp) are real
 *     logic, so they live in `Figures.tsx` as pure exported functions and run
 *     their real code here;
 *  2. hygiene (static) — there is no DOM renderer in this repo, so the
 *     "react only via deps.ts" rule, the "no dangerouslySetInnerHTML" rule and
 *     the "every referenced token exists in the host theme" rule are pinned at
 *     source level, against the comment-stripped source so a mention in prose
 *     cannot satisfy them;
 *  3. mutation — each guard is fed a known-wrong implementation and required to
 *     go red, because a test that cannot fail proves nothing.
 *
 * The host theme bundle is NOT resolvable from this package (it nests under the
 * global `@deepseek-ai/dsh` install), so the same runtime search strategy
 * `client-console.test.ts` uses is reused here — and, like there, a missing host
 * is reported loudly and skipped rather than passing vacuously.
 *
 * @module test/client-figures.test
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

import {
  BreakdownDonut,
  CalendarHeatmap,
  GrowthChart,
  HEATMAP_OPACITY,
  TopBars,
  WEEKDAY_LABEL,
  figureEmptyText,
  levelOpacity,
  spanText,
  truncateLabel,
} from '../src/client/Figures.tsx'
import type { StatsData } from '../src/client/types.ts'

const SRC = readFileSync(new URL('../src/client/Figures.tsx', import.meta.url), 'utf8')
/**
 * The stylesheet, read as CSS TEXT.
 *
 * `styles.ts` is just an exported template literal, so importing the module
 * would give the same string — but reading the file keeps this suite's contract
 * identical to `client-console.test.ts`, which scans the source.
 *
 * Comments are stripped for the same reason as in the JSX source below: a class
 * name that appears ONLY inside a CSS comment is not a rule, and without this a
 * comment mention would satisfy `cssDefines` and the contract could pass while
 * every shape stayed unstyled.
 */
const CSS = stripComments(readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8'))

/**
 * Strip `/* … *\/` block comments and `// …` line comments.
 *
 * Same reason (and same ceiling) as the copy in `client-console.test.ts`: the
 * assertions below are source-string checks, and the header comment of the file
 * under test names tokens and functions, so a `toContain` against the raw text
 * could be satisfied by prose. Duplicated rather than shared because a test
 * helper that both suites import becomes a third module with its own contract.
 * CEILING: not a tokenizer — a `//` inside a string literal truncates that line.
 * No assertion below depends on text after such a literal.
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
    out.push(kept)
  }
  return out.join('\n')
}

const CODE = stripComments(SRC)

// ── Host theme resolution ──────────────────────────────────────────

/**
 * Locate the host theme bundle without pinning a machine path.
 *
 * The host ships the theme as a nested dependency of `@deepseek-ai/dsh`, which
 * itself lives in the global npm root — NOT on the `node_modules` chain that
 * `require.resolve` walks up from this repository. Deriving every candidate at
 * runtime (resolution roots, `npm`-provided prefixes) keeps this portable.
 */
function findHostTheme(): string | null {
  const THEME_REL = join('@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js')
  const candidates: string[] = []
  const push = function (p: string | null | undefined) { if (p) candidates.push(p) }
  const safe = function <T>(fn: () => T): T | null {
    try { return fn() } catch { return null }
  }

  const req = createRequire(new URL('../src/client/Figures.tsx', import.meta.url))
  push(safe(() => req.resolve('@deepseek-ai/dsh-client-ui-theme/lib/client.js')))

  const dshManifest = safe(() => req.resolve('@deepseek-ai/dsh/package.json'))
  if (dshManifest) push(join(dirname(dshManifest), 'node_modules', THEME_REL))

  const roots: string[] = []
  const pushRoot = function (prefix: string | undefined) {
    if (prefix) roots.push(join(prefix, 'node_modules'))
  }
  pushRoot(process.env.npm_config_prefix)
  pushRoot(process.env.NPM_CONFIG_PREFIX)
  pushRoot(process.env.PREFIX)
  const npmRoot = safe(function () {
    return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  })
  if (npmRoot) roots.push(npmRoot)
  for (const root of new Set(roots)) {
    push(join(root, '@deepseek-ai', 'dsh', 'node_modules', THEME_REL))
    push(join(root, THEME_REL))
  }

  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * Custom properties are DECLARED as `--name:` in CSS, but may also appear as a
 * quoted `"--name":` key in an inline style object. Accept both, and require the
 * colon so a mere mention inside prose or a class name does not count.
 */
function declares(src: string, token: string): boolean {
  const escaped = token.replace(/[-]/g, '\\-')
  return new RegExp(`(?:^|["'\\s;{,])${escaped}["']?\\s*:`).test(src)
}

const HOST_THEME = findHostTheme()

// ── Behavior: the display decisions ────────────────────────────────

describe('figureEmptyText', () => {
  it('does not let a broken core read as an empty vault', () => {
    // The whole point of the split: `status:'error'` means the route or the core
    // failed and `data` is null. Rendering that as "暂无数据" tells the user their
    // library is empty when the truth is that nothing could be read.
    const error = figureEmptyText('error')
    const empty = figureEmptyText('ok')
    expect(error).not.toBe(empty)
    expect(error).not.toContain('暂无数据')
  })

  it('says the read failed, and says it for the error state only', () => {
    expect(figureEmptyText('error')).toContain('读取失败')
    expect(figureEmptyText('ok')).not.toContain('读取失败')
    expect(figureEmptyText('loading')).not.toContain('读取失败')
  })

  it('keeps loading distinct from both', () => {
    const loading = figureEmptyText('loading')
    expect(loading).not.toBe(figureEmptyText('ok'))
    expect(loading).not.toBe(figureEmptyText('error'))
    expect(loading).toContain('读取中')
  })

  it('gives all three states non-empty text', () => {
    for (const s of ['loading', 'ok', 'error'] as const) {
      expect(figureEmptyText(s).length).toBeGreaterThan(0)
    }
  })
})

describe('truncateLabel', () => {
  it('leaves a short label alone', () => {
    expect(truncateLabel('记忆库入口')).toBe('记忆库入口')
  })

  it('cuts a long label and marks the cut', () => {
    const long = 'a'.repeat(40)
    const got = truncateLabel(long, 10)
    expect([...got]).toHaveLength(11) // 10 kept + the ellipsis
    expect(got.endsWith('…')).toBe(true)
    expect(got.startsWith('aaaaaaaaaa')).toBe(true)
  })

  it('counts by code point, so an emoji is never cut in half', () => {
    // 20 emoji is 20 code points but 40 UTF-16 units. A `.slice()` cut would land
    // mid-surrogate and render a replacement glyph.
    const got = truncateLabel('🌱'.repeat(20), 5)
    expect([...got]).toHaveLength(6)
    expect(got).not.toContain('\uFFFD')
    expect(got.startsWith('🌱🌱🌱🌱🌱')).toBe(true)
  })

  it('uses a default width when none is given', () => {
    expect([...truncateLabel('x'.repeat(80))].length).toBeLessThan(40)
  })
})

describe('spanText', () => {
  it('reads start to end when both are known', () => {
    expect(spanText({ start: '2026-08-16', end: '2026-09-22' }))
      .toBe('2026-08-16 → 2026-09-22')
  })

  it('shows a dash for an unknown end, not "null"', () => {
    expect(spanText({ start: '2026-08-16', end: null })).toBe('2026-08-16 → —')
    expect(spanText({ start: null, end: null })).toBe('— → —')
  })
})

describe('levelOpacity', () => {
  it('ramps strictly upward from an invisible floor to full', () => {
    // Heat levels 0..4 must be visually ORDERED, or the heatmap carries no
    // information: the whole figure is "darker means busier".
    for (let i = 1; i < HEATMAP_OPACITY.length; i++) {
      expect(HEATMAP_OPACITY[i]).toBeGreaterThan(HEATMAP_OPACITY[i - 1])
    }
    expect(HEATMAP_OPACITY[HEATMAP_OPACITY.length - 1]).toBe(1)
  })

  it('clamps out-of-range levels instead of reading undefined', () => {
    expect(levelOpacity(-1)).toBe(levelOpacity(0))
    expect(levelOpacity(99)).toBe(levelOpacity(HEATMAP_OPACITY.length - 1))
    expect(Number.isFinite(levelOpacity(2))).toBe(true)
  })
})

describe('weekday labels', () => {
  it('names all seven rows, because "row = weekday" is otherwise unreadable', () => {
    expect(WEEKDAY_LABEL).toHaveLength(7)
    expect(WEEKDAY_LABEL[0]).toBe('日') // y = 0 is Sunday, per calendarGrid
    expect(WEEKDAY_LABEL[6]).toBe('六')
  })
})

// ── Structure: the four figures ────────────────────────────────────

describe('figures structure', () => {
  it('exports exactly the four figures the console will render', () => {
    for (const name of ['CalendarHeatmap', 'GrowthChart', 'BreakdownDonut', 'TopBars']) {
      expect(CODE).toContain(`export function ${name}`)
    }
  })

  it('drives every figure off the tested geometry helpers, not new maths', () => {
    // The mutation this catches: re-implementing the arc/line/bar maths inline.
    // Each helper must be CALLED (call form), not merely imported or mentioned.
    expect(CODE).toMatch(/calendarGrid\(/)
    expect(CODE).toMatch(/linePath\(/)
    expect(CODE).toMatch(/donutSegments\(/)
    expect(CODE).toMatch(/barRows\(/)
  })

  it('degrades in ONE place, so no figure can be left without notice', () => {
    // The four figures each render through the shared `Frame`, and the error vs
    // empty vs populated decision lives there exactly once. That is the point:
    // four separate copies of the decision are four chances to forget one, and a
    // figure that silently draws nothing on a failed read is the bug this pins.
    expect(CODE).toMatch(/function Frame\(/)
    // `export function figureEmptyText` is itself one hit; strip it so what is
    // counted is call sites only, and require exactly ONE of them (inside
    // `Frame`) rather than one per figure.
    const callSites = CODE.replace(/export function figureEmptyText\(/, '')
    expect(
      (callSites.match(/figureEmptyText\(/g) ?? []).length,
      'the degradation decision should live in Frame, not be copied per figure',
    ).toBe(2)
    // ...and all four figures must go THROUGH it.
    const frames = CODE.match(/h\(Frame,\s*\{/g) ?? []
    expect(frames.length).toBe(4)
    for (const name of ['CalendarHeatmap', 'GrowthChart', 'BreakdownDonut', 'TopBars']) {
      const body = CODE.slice(CODE.indexOf(`export function ${name}`))
      const next = body.indexOf('\nexport function ', 1)
      expect(body.slice(0, next < 0 ? body.length : next)).toContain('h(Frame, {')
    }
  })
})

// ── Hygiene: tokens, trust boundary, imports ───────────────────────

describe('figures token hygiene', () => {
  it('locates the host theme bundle, or says why it cannot', () => {
    if (!HOST_THEME) {
      console.warn(
        '[client-figures] host theme bundle not found via require.resolve or the npm ' +
        'global root; token-existence assertions SKIPPED. Install ' +
        '@deepseek-ai/dsh-client-ui-theme to enable.',
      )
    }
    expect(HOST_THEME === null || existsSync(HOST_THEME)).toBe(true)
  })

  it('references only custom properties the host actually declares', () => {
    if (!HOST_THEME) {
      console.warn('[client-figures] host theme not found; token existence not verified.')
      return
    }
    const theme = readFileSync(HOST_THEME, 'utf8')
    const used = [...CODE.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1])
    // Guard the guard: an empty reference list would make the diff below vacuous.
    expect(used.length, 'Figures.tsx references no tokens at all').toBeGreaterThan(0)

    const missing = [...new Set(used)].filter((t) => !declares(theme, t)).sort()
    expect(
      missing,
      'Figures.tsx references tokens the host theme never declares ' +
      '(var() to these renders colourless): ' + missing.join(', '),
    ).toEqual([])
  })

  it('never hardcodes a colour literal', () => {
    // Two deliberate holes, both theme-neutral and both required by the design:
    //   * `fill-opacity` numbers — the heat ramp is alpha, not new tokens;
    //   * `fill="none"` / `stroke="currentColor"` — keywords, not colours.
    // Everything else must arrive through var(--dsw-…).
    const body = CODE.replace(/var\(--dsw-[a-z0-9-]+\)/g, '')
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/\brgba?\s*\(/)
    expect(body).not.toMatch(/\bhsla?\s*\(/)
    expect(body).not.toMatch(/["'](?:white|black|red|green|blue|gray|grey)["']/)
  })

  it('imports react only from deps.ts and touches no node builtin', () => {
    // Figures.tsx is browser-side: `node:*` would break the bundle and
    // `../utils.ts` is host-side Node ESM, not importable from here.
    expect(CODE).toContain("from '../deps.ts'")
    expect(CODE).not.toMatch(/from\s+['"]react['"]/)
    expect(CODE).not.toMatch(/from\s+['"]node:/)
    expect(CODE).not.toMatch(/from\s+['"]\.\.\/utils/)
  })

  it('never injects memory content as markup', () => {
    // `top[].label` is corpus-authored (untrusted). It may only ever be a text
    // child of an element, which is what `h('text', ...)` gives us.
    expect(CODE).not.toContain('dangerouslySetInnerHTML')
    expect(CODE).not.toContain('innerHTML')
  })
})

// ── Mutation checks ────────────────────────────────────────────────
//
// Each block substitutes a known-wrong implementation for the real one and runs
// the SAME assertion the real function is held to. If the assertion still passes
// under the mutation, the test was decorative.

describe('mutation: figureEmptyText', () => {
  it('goes red when the error state collapses into the empty state', () => {
    // A plausible "simplification": one message for every non-populated state.
    const mutant = function (_s: string) { return '暂无数据' }
    const assert = function (f: typeof figureEmptyText) {
      expect(f('error')).not.toBe(f('ok'))
      expect(f('error')).not.toContain('暂无数据')
    }
    assert(figureEmptyText)
    expect(function () { assert(mutant) }).toThrow()
  })

  it('goes red when the error branch is dropped entirely', () => {
    const mutant = function (s: string) { return s === 'loading' ? '读取中…' : '暂无数据' }
    const assert = function (f: typeof figureEmptyText) {
      expect(f('error')).toContain('读取失败')
    }
    assert(figureEmptyText)
    expect(function () { assert(mutant) }).toThrow()
  })
})

describe('mutation: truncateLabel', () => {
  it('goes red when the cut ignores surrogate pairs', () => {
    // `.slice()` on UTF-16 units splits an emoji into two lone surrogates.
    const mutant = function (s: string, max = 18) {
      const t = String(s ?? '')
      return t.length <= max ? t : t.slice(0, max) + '…'
    }
    const assert = function (f: typeof truncateLabel) {
      const got = f('🌱'.repeat(20), 5)
      expect([...got]).toHaveLength(6)
      expect(got).not.toContain('\uFFFD')
    }
    assert(truncateLabel)
    expect(function () { assert(mutant) }).toThrow()
  })
})

describe('mutation: token check', () => {
  it('goes red when a phantom token is introduced', () => {
    // The T8 lesson, mechanised: a plausible-looking token the host never
    // declares renders colourless while every "no hardcoded colour" check stays
    // green. Feed the checker a phantom and require it to be reported.
    const phantom = CODE + "\nconst x = 'var(--dsw-alias-accent)'"
    const used = [...phantom.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(used).toContain('--dsw-alias-accent')
    // Sanity: the real host theme must NOT declare it (the token the old bug
    // shipped). If the host ever declares it, this test's premise is gone.
    if (HOST_THEME) {
      const theme = readFileSync(HOST_THEME, 'utf8')
      expect(declares(theme, '--dsw-alias-accent')).toBe(false)
      expect(declares(theme, '--dsw-alias-brand-primary')).toBe(true)
    }
  })
})

// ── Contract: every className has a rule ───────────────────────────
//
// The escape this closes (C-1): all 17 classes `Figures.tsx` renders were
// defined in NO stylesheet. `npm run test:js` was 393/393 green and
// `figures-smoke.mjs` 20/20 green while the ranking bars rendered as plain
// text, because both layers only ever asked "does the component produce
// geometry" — neither asked "does the stylesheet style what it produces".
//
// The two directions are complementary and both are needed:
//   * here (Figures side): every class the component RENDERS is defined;
//   * `client-console.test.ts` (styles side): every class the sheet DEFINES is
//     rendered by some component.
//
// The check reads the SOURCE TEXT on both sides, so it cannot be satisfied by a
// component that computes a class name at runtime and never renders it.

/** The `className: '…'` literals in the comment-stripped Figures source. */
function renderedClassNames(): string[] {
  const found: string[] = []
  for (const m of CODE.matchAll(/className:\s*'([^']+)'/g)) found.push(m[1])
  return [...new Set(found)].sort()
}

/**
 * True when the sheet declares a rule for `cls`.
 *
 * The trailing `(?![\w-])` matters: without it `dsh-memory-figure` would be
 * "declared" by the selector `.dsh-memory-figure-bar-fill`, so the parent
 * container could stay unstyled while this test stayed green.
 */
function cssDefines(cls: string): boolean {
  return new RegExp('\\.' + cls + '(?![\\w-])').test(CSS)
}

describe('figure class/style contract', () => {
  it('styles every class Figures.tsx renders', () => {
    const classNames = renderedClassNames()
    // Guard the guard: an empty list would make the assertion below vacuous.
    expect(classNames.length, 'no className literals found in Figures.tsx')
      .toBeGreaterThan(0)

    const undefinedClasses = classNames.filter((c) => !cssDefines(c))
    expect(
      undefinedClasses,
      'Figures.tsx renders classes with no rule in styles.ts (they render as ' +
      'unstyled inline elements — the ranking bars vanish): ' +
      undefinedClasses.join(', '),
    ).toEqual([])
  })

  it('gives the ranking bar a fill that can actually draw a bar', () => {
    // The C-1 defect in one assertion: `<i class="…-bar-fill">` is inline by
    // default, and inline elements ignore width/height. Without a `display`,
    // a `height` and a `background`, `style="width:96%"` is inert and the bar
    // is invisible no matter how correct the geometry is.
    const at = CSS.indexOf('.dsh-memory-figure-bar-fill')
    expect(at, '.dsh-memory-figure-bar-fill rule missing').toBeGreaterThanOrEqual(0)
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    expect(rule).toMatch(/display:\s*(block|flex|inline-block)/)
    expect(rule).toMatch(/height:/)
    expect(rule).toMatch(/background:\s*var\(--dsw-alias-brand-primary\)/)
  })

  it('gives the bar a track to be a share OF', () => {
    // A 96%-wide fill is meaningless unless the 100% it is a fraction of is a
    // visible element; the track also has to clip the fill to its radius.
    const at = CSS.indexOf('.dsh-memory-figure-bar-track')
    expect(at, '.dsh-memory-figure-bar-track rule missing').toBeGreaterThanOrEqual(0)
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    expect(rule).toMatch(/display:\s*block/)
    expect(rule).toMatch(/height:\s*\d/)
    expect(rule).toMatch(/width:\s*\d/)
  })

  it('strips the list markers off the donut legend', () => {
    // Measured in the review: without this the legend degraded to a <ul>
    // bulleted list, which reads as prose, not as a colour key.
    const at = CSS.indexOf('.dsh-memory-legend')
    expect(at, '.dsh-memory-legend rule missing').toBeGreaterThanOrEqual(0)
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    expect(rule).toMatch(/list-style:\s*none/)
  })
})

// ── Rendering: the four figures, actually executed ─────────────────
//
// `environment: 'node'` has no DOM and no react-dom, so nothing here mounts.
// But React IS installed as a devDependency and `h` is bare `createElement`, so
// calling a component returns a plain element tree (`type` / `props` /
// `props.children`). Walking that tree and INVOKING the function components is
// what a renderer does between `<Component/>` and the host nodes, and it is
// enough to observe which nodes a figure emits.
//
// Why this layer is required for the degradation guard: with `data:null` three
// of the four figures produce zero geometry whether or not `Frame` degrades, so
// "Frame silently stopped degrading" is unobservable for them. `status:'error'`
// with NON-EMPTY data is the only input under which all four figures have
// something to draw and therefore a visible decision to make.

interface El { type: unknown; props: Record<string, unknown> }

/** Render a component tree, calling function components, as a renderer does. */
function renderTree(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(renderTree).filter((c) => c !== null && c !== undefined)
  }
  if (node === null || node === undefined || typeof node !== 'object') return node
  const el = node as El
  if (typeof el.type === 'function') {
    const fn = el.type as (p: Record<string, unknown>) => unknown
    return renderTree(fn(el.props))
  }
  return { type: el.type, props: { ...el.props, children: renderTree(el.props.children) } }
}

/** Every host element in a rendered tree. */
function elements(node: unknown): El[] {
  if (node === null || node === undefined) return []
  if (Array.isArray(node)) return node.flatMap(elements)
  if (typeof node !== 'object') return []
  const el = node as El
  return [el, ...elements(el.props.children)]
}

/** Every string in a rendered tree, concatenated. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf((node as El).props.children)
  return ''
}

/** Non-empty data for ALL FOUR figures — the point of the block above. */
const FULL: StatsData = {
  daily: [{ date: '2026-09-01', count: 2 }, { date: '2026-09-02', count: 5 }],
  access: [{ date: '2026-09-01', count: 3 }, { date: '2026-09-02', count: 7 }],
  types: [{ type: 'fact', count: 4 }, { type: 'pattern', count: 2 }],
  importance: [{ value: 0.9, count: 3 }],
  top: [{ id: 'a', label: '记忆库入口', count: 9, untrusted: true }],
  span: { start: '2026-09-01', end: '2026-09-02' },
  totals: { memories: 6, vectors: 6, accesses: 10, inbox: 0 },
}

/**
 * Each figure, with the one host node that proves it actually drew something.
 *
 * Three figures draw SVG; `TopBars` is DOM markup (a track + fill pair per
 * row), so a `<svg>` assertion would be wrong for it — the marker differs per
 * figure on purpose.
 */
const FIGURES = [
  ['CalendarHeatmap', CalendarHeatmap, { tag: 'svg' }],
  ['GrowthChart', GrowthChart, { tag: 'svg' }],
  ['BreakdownDonut', BreakdownDonut, { tag: 'svg' }],
  ['TopBars', TopBars, { cls: 'dsh-memory-figure-bar-fill' }],
] as const

describe('degradation is observable for every figure', () => {
  it('draws geometry for all four when the read succeeded', () => {
    // Guard the guard: if the walker produced an empty tree, the block below
    // would pass vacuously — "nothing is drawn" is trivially true of nothing.
    for (const [name, Figure, marker] of FIGURES) {
      const nodes = elements(renderTree(Figure({ status: 'ok', data: FULL })))
      const cls = nodes.map((n) => String(n.props.className ?? ''))
      const drew = 'tag' in marker
        ? nodes.some((n) => String(n.type) === marker.tag)
        : cls.some((c) => c.includes(marker.cls))
      expect(drew, `${name} drew nothing on populated data`).toBe(true)
      expect(textOf(renderTree(Figure({ status: 'ok', data: FULL }))), name)
        .not.toContain('读取失败')
    }
  })

  it('degrades all four on a failed read even when data is non-empty', () => {
    // The specific hole I-3 names: `status:'error'` is the degradation signal
    // and it must win over a non-empty `data` — the contract is that a failed
    // read is never drawn as if it were a successful one.
    for (const [name, Figure] of FIGURES) {
      const tree = renderTree(Figure({ status: 'error', data: FULL }))
      const nodes = elements(tree)
      const tags = nodes.map((n) => String(n.type))

      expect(textOf(tree), `${name} shows no degradation notice`).toContain('读取失败')
      expect(textOf(tree), `${name} claims the vault is empty`).not.toContain('暂无数据')

      for (const tag of ['svg', 'rect', 'path', 'ul']) {
        expect(tags, `${name} still drew <${tag}> on a failed read`).not.toContain(tag)
      }
      const barClasses = nodes
        .map((n) => String(n.props.className ?? ''))
        .filter((c) => c.includes('dsh-memory-figure-bar'))
      expect(barClasses, `${name} still drew ranking bars on a failed read`).toEqual([])
    }
  })
})
