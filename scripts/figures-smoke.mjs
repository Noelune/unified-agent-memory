/**
 * Render smoke for the four figures — a LOCAL DEBUGGING PROBE, not evidence.
 *
 * WHAT IT PROVES: the four components execute on a real `/stats` payload and
 * produce geometry. `environment: 'node'` has no DOM and React is not loadable
 * in the test runner, so this substitutes a minimal `h()` (a plain object
 * builder) via a loader hook and calls the REAL components, then walks the
 * returned tree. That is genuinely more than a source-string assertion can do,
 * and it is why the shim is worth keeping.
 *
 * WHAT IT DOES NOT PROVE, and must never be cited as proving:
 *   - It is NOT in CI. `vitest.config.ts` sets `include: ['test/**\/*.test.ts']`,
 *     so neither `npm run test:js` nor `npm run check` ever runs this file. A
 *     green run here says nothing about the suite.
 *   - It checks NO stylesheet contract. Measured in the fix-round-1 review:
 *     deleting the ranking bar's `className` outright still printed SMOKE OK
 *     and vitest still reported 25 passed. It cannot see CSS at all.
 *   - It renders NO real browser, so it cannot see layout, sizing, or colour.
 *
 * The lesson it now carries: round 1 shipped four figures whose 17 class names
 * were defined in no stylesheet — the bars rendered as bare text — while this
 * probe and all 393 vitest tests were green. "The component runs" is not "the
 * figure is visible". The style contract is asserted in
 * test/client-figures.test.ts (every rendered className must have a rule);
 * visual confirmation lives in the fix report, via a rendered screenshot.
 *
 * Usage: node scripts/figures-smoke.mjs
 */

import { register } from 'node:module'
import { writeFileSync } from 'node:fs'

// `src/deps.ts` re-exports bare `react`, which is not installed here. Redirect
// that one specifier to a shim so the REAL components can execute. Both files
// are written into `scripts/` and are gitignored-by-suffix helpers.
//
// The shim INVOKES function components (that is what React does when it meets
// `h(Frame, props)`); a shim that only recorded the element would leave every
// figure's body unevaluated and make this smoke pass vacuously.
writeFileSync(new URL('./.react-shim.mjs', import.meta.url), `
const isEl = (v) => v && typeof v === 'object' && 'type' in v && 'children' in v
function build(node) {
  if (Array.isArray(node)) return node.flat(Infinity).map(build).filter((c) => c !== null && c !== undefined && c !== false)
  if (!isEl(node)) return node
  // React calls a function component and renders what it RETURNS, so the node
  // here is replaced by its result — otherwise the figure body never runs and
  // the whole smoke passes on an empty tree.
  if (typeof node.type === 'function') return build(node.type({ ...node.props, children: node.children }))
  return { type: node.type, props: node.props, children: build(node.children) }
}
export function createElement(type, props, ...children) {
  const kids = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false)
  const node = type === Fragment
    ? { type: 'fragment', props: {}, children: kids }
    : { type, props: props ?? {}, children: kids }
  return build(node)
}
export const Fragment = Symbol('Fragment')
export const useState = (v) => [v, () => {}]
export const useEffect = () => {}
export const useRef = (v) => ({ current: v })
export const useCallback = (f) => f
`)
const shimUrl = new URL('./.react-shim.mjs', import.meta.url).href
writeFileSync(new URL('./.figures-shim-hook.mjs', import.meta.url), `
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

export async function resolve(specifier, context, next) {
  if (specifier === 'react') return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true }
  return next(specifier, context)
}

// Node has no idea what a .tsx is. Compile on the way through with the esbuild
// already in devDependencies (same tool the real bundle uses), so this smoke
// runs the REAL component source rather than a copy.
export async function load(url, context, next) {
  if (url.endsWith('.tsx') || url.endsWith('.ts')) {
    const src = readFileSync(new URL(url), 'utf8')
    const out = await transform(src, { loader: 'tsx', format: 'esm', target: 'es2022' })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
  return next(url, context)
}
`)
register(new URL('./.figures-shim-hook.mjs', import.meta.url))

const { CalendarHeatmap, GrowthChart, BreakdownDonut, TopBars } = await import('../src/client/Figures.tsx')

// A payload shaped exactly like `GET /stats` serves (spec §5.1), with the
// measured magnitudes: 38 days, peak 122 accesses, 7 types, 20 top rows.
const day = (i) => `2026-08-${String(i + 1).padStart(2, '0')}`
const daily = Array.from({ length: 28 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, count: i % 7 === 0 ? 40 : 3 }))
const access = Array.from({ length: 28 }, (_, i) => ({
  date: `2026-08-${String(i + 1).padStart(2, '0')}`,
  count: i === 5 ? 122 : i % 4 === 0 ? 9 : 0,
}))
const types = [
  { type: 'other', count: 198 }, { type: 'fact', count: 88 }, { type: 'pattern', count: 44 },
  { type: 'bug', count: 30 }, { type: 'decision', count: 16 }, { type: 'architecture', count: 9 },
  { type: 'preference', count: 3 },
]
const top = Array.from({ length: 20 }, (_, i) => ({
  id: 'm' + i,
  label: i === 0 ? 'api_key=<REDACTED> 某条很长很长很长的记忆标签' : 'memory ' + i,
  count: 11 - Math.floor(i / 2),
  untrusted: true,
}))
const data = {
  daily, access, types, importance: [{ value: 0.5, count: 200 }], top,
  span: { start: '2026-08-01', end: '2026-08-28' },
  totals: { memories: 388, vectors: 370, accesses: 350, inbox: 17 },
}

/** Count every node of a given type in a shim tree. */
function count(tree, type, out = { n: 0 }) {
  if (!tree || typeof tree !== 'object') return out
  if (tree.type === type) out.n += 1
  for (const c of tree.children ?? []) count(c, type, out)
  return out
}

function walk(tree, fn) {
  if (!tree || typeof tree !== 'object') return fn(tree)
  fn(tree)
  for (const c of tree.children ?? []) walk(c, fn)
}

let failures = 0
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures += 1
}

for (const [name, Comp, expectType] of [
  ['CalendarHeatmap', CalendarHeatmap, 'rect'],
  ['GrowthChart', GrowthChart, 'path'],
  ['BreakdownDonut', BreakdownDonut, 'path'],
  ['TopBars', TopBars, 'div'],
]) {
  const ok = Comp({ status: 'ok', data })
  const drawn = count(ok, expectType).n
  check(`${name} draws ${expectType} on real data`, drawn > 0, `${drawn} × <${expectType}>`)

  // Every figure must SAY something on a failed read instead of drawing nothing.
  const err = Comp({ status: 'error', data: null })
  let errText = ''
  walk(err, (n) => { if (typeof n === 'string') errText += n })
  const errDrawn = count(err, expectType).n
  check(`${name} degrades on status=error (no silent empty drawing)`,
    errText.includes('读取失败') && errDrawn === 0, JSON.stringify(errText))

  // And an empty-but-ok vault must NOT say "读取失败".
  const empty = Comp({ status: 'ok', data: null })
  let emptyText = ''
  walk(empty, (n) => { if (typeof n === 'string') emptyText += n })
  check(`${name} says 暂无数据 (not a failure) on an empty vault`,
    emptyText.includes('暂无数据') && !emptyText.includes('读取失败'), JSON.stringify(emptyText))
}

// Heatmap-specific: the weekday axis must be present, else rows are unreadable.
const heat = CalendarHeatmap({ status: 'ok', data })
const ticks = []
walk(heat, (n) => { if (n && n.type === 'text') ticks.push(n.children.join('')) })
check('heatmap renders all 7 weekday labels', ticks.length === 7, ticks.join(','))

// Growth: the area fill closes the line path, and the span is in the caption.
const growth = GrowthChart({ status: 'ok', data })
const paths = []
walk(growth, (n) => { if (n && n.type === 'path') paths.push(n.props.d) })
check('growth chart has a line AND a closed area fill',
  paths.length === 2 && paths[0].endsWith('Z') && !paths[1].endsWith('Z'))
let cap = ''
walk(growth, (n) => { if (typeof n === 'string') cap += n })
check('growth chart captions the date span', cap.includes('2026-08-01 → 2026-08-28'), JSON.stringify(cap))

// Donut: one arc per type, with a matching legend entry.
const donut = BreakdownDonut({ status: 'ok', data })
check('donut has one arc per type', count(donut, 'path').n === types.length)
const legend = count(donut, 'li').n
check('donut legend lists every slice', legend === types.length, `${legend} entries`)

// Top: the untrusted label is TEXT, and long ones are truncated.
const bars = TopBars({ status: 'ok', data })
const texts = []
walk(bars, (n) => { if (typeof n === 'string') texts.push(n) })
check('top bar labels are text and truncated', texts.some((t) => t.endsWith('…')))
// The trust boundary: an untrusted label must arrive as a TEXT CHILD, never as
// markup. Asserting "no text contains <" would be plain wrong — the label is
// corpus prose and may legitimately contain one. What matters is that no node
// carries a raw-HTML prop.
const rawHtml = []
walk(bars, (n) => {
  if (n && n.props && typeof n.props.dangerouslySetInnerHTML !== 'undefined') rawHtml.push(String(n.type))
})
check('top bars never inject the untrusted label as markup', rawHtml.length === 0, rawHtml.join(','))

// And the over-long label really was cut, so a 500-char label cannot break the row.
const names = []
walk(bars, (n) => {
  if (n && n.type === 'span' && n.props.className === 'dsh-memory-figure-bar-name') names.push(n.children.join(''))
})
check('long labels are cut with an ellipsis', names.some((t) => t.endsWith('…')), JSON.stringify(names[0]))

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
