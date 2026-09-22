/**
 * dsh-unified-agent-memory — the four memory figures.
 *
 * Each figure answers a question the earlier spike rounds proved has SIGNAL in
 * the real vault (see `docs/superpowers/specs/2026-09-22-memory-figures-design.md`
 * §2, where four other chart ideas were rejected on measured evidence):
 *
 *   CalendarHeatmap — "when do I actually use this?"  (access log)
 *   GrowthChart     — "is my library still growing?"  (memories.created)
 *   BreakdownDonut  — "what is it made of?"           (types / importance)
 *   TopBars         — "what do I keep coming back to?"(access_count)
 *
 * Three rules this file exists to honour:
 *
 *  1. **No maths here.** Every coordinate comes from `./charts.ts`, which is
 *     pure and unit-tested. Re-deriving a bar width or an arc inline would put
 *     untested geometry in a component no Node runner can load.
 *  2. **No invented tokens.** A `var()` pointing at an undeclared property is
 *     invalid at computed-value time, so the shape renders colourless while
 *     every static "no hardcoded colour" check stays green — five such phantom
 *     tokens shipped once already. The heat ramp is expressed as
 *     `fill-opacity` on `brand-primary` for that reason: alpha needs no new
 *     token. `test/client-figures.test.ts` diffs this file against the host
 *     theme's own declarations.
 *  3. **`error` is not `empty`.** `status:'error'` means the route or core could
 *     not be read and `data` is null; an empty vault is `status:'ok'` with empty
 *     arrays. Collapsing them tells the user their library is empty when the
 *     truth is that nothing could be read — so every figure renders a
 *     degradation notice for one and `暂无数据` for the other.
 *
 * Corpus text (`top[].label`, always `untrusted:true`) is rendered ONLY as a
 * text child of an element; there is no `dangerouslySetInnerHTML` in this file
 * and a test pins that.
 *
 * @module src/client/Figures
 */

import { h } from '../deps.ts'
import { barRows, calendarGrid, donutSegments, linePath } from './charts.ts'
import type { StatsData, StatsPayload } from './types.ts'

/** Anything `h()` accepts as a child. `deps.ts` exports no ReactNode type. */
type Child = ReturnType<typeof h> | string | number | boolean | null | undefined

/** Every figure takes the same pair, so the console wires them uniformly. */
export interface FigureProps {
  status: StatsPayload['status']
  data: StatsData | null
}

// ── Pure display logic (imported by the test runner) ───────────────
//
// These live in this module rather than a sibling `figures-view.ts` because the
// whole set is four one-line functions; a separate file would be a module
// boundary with no behaviour behind it. A `.tsx` module is still importable by
// vitest (esbuild transforms it), so nothing is lost. If this group grows into
// real logic, split it out then.

/**
 * The single line a figure shows instead of drawing.
 *
 * The three states must not read the same: "still reading", "read failed" and
 * "read fine, nothing in it" are three different facts.
 */
export function figureEmptyText(status: StatsPayload['status']): string {
  if (status === 'loading') return '读取中…'
  // The degradation notice. It must never claim the vault is empty.
  if (status === 'error') return '读取失败，记忆核心暂不可用'
  return '暂无数据'
}

/**
 * Shorten a corpus label for an axis, counting by CODE POINT.
 *
 * `label` is written by other agents and can be any length or script. A
 * `.slice()` cut counts UTF-16 units, so it can land between the halves of an
 * astral character (an emoji, a rare CJK glyph) and emit a lone surrogate that
 * renders as a replacement box.
 */
export function truncateLabel(label: string, max = 18): string {
  const chars = [...String(label ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…'
}

/** `span.start → span.end` for the growth chart's date axis. `—` when unknown. */
export function spanText(span: { start: string | null; end: string | null }): string {
  return (span.start ?? '—') + ' → ' + (span.end ?? '—')
}

/**
 * The heat ramp: one alpha per `level` (0..4), darkening with activity.
 *
 * Alpha over `brand-primary` rather than five invented colour tokens. Level 0 is
 * not fully invisible — around a quarter of real days have activity, so the
 * empty cells are themselves the information ("I did not use this then").
 */
export const HEATMAP_OPACITY = [0.06, 0.25, 0.45, 0.7, 1] as const

/** The ramp for a `level`, clamped so an out-of-range value cannot be `undefined`. */
export function levelOpacity(level: number): number {
  const i = Math.max(0, Math.min(HEATMAP_OPACITY.length - 1, Math.floor(level)))
  return HEATMAP_OPACITY[i]
}

/** Row labels, in `calendarGrid`'s `y` order: 0 is Sunday. */
export const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const

/** The height of one calendar row, and the width of one calendar column. */
const CELL = 12
const GAP = 2
const ROW_LABEL_W = 16

// ── Shared chrome ──────────────────────────────────────────────────

/**
 * The figure frame: an accessible figure with a caption, or the one-line
 * fallback. Returning the fallback from HERE rather than from each figure is
 * what makes "every figure degrades" a single decision instead of four.
 */
function Frame(props: {
  title: string
  caption?: string
  status: StatsPayload['status']
  populated: boolean
  body: () => Child
}): Child {
  const text = props.status === 'ok' ? (props.populated ? '' : figureEmptyText('ok')) : figureEmptyText(props.status)
  return h('figure', { className: 'dsh-memory-figure' },
    h('figcaption', { className: 'dsh-memory-figure-cap' },
      h('b', null, props.title),
      props.caption ? h('span', { className: 'dsh-memory-figure-range' }, props.caption) : null,
      text ? h('span', { className: 'dsh-memory-figure-note' }, text) : null,
    ),
    text ? null : props.body(),
  )
}

// ── 1. Access calendar heatmap ─────────────────────────────────────

/**
 * GitHub-style calendar of access events. Column = week, row = weekday.
 *
 * The weekday labels are not decoration: without them a reader cannot tell that
 * the rows mean anything, and the figure degrades to a texture. They are drawn
 * for all seven rows even when the data is thin, so the axis stays readable.
 */
export function CalendarHeatmap(props: FigureProps): Child {
  const days = props.data?.access ?? []
  const cells = calendarGrid(days)
  const cols = cells.reduce((m, c) => Math.max(m, c.x), 0) + 1
  const w = ROW_LABEL_W + cols * (CELL + GAP)
  const hgt = 7 * (CELL + GAP)
  const peak = days.reduce((m, d) => Math.max(m, d.count), 0)

  return h(Frame, {
    title: '访问热力图',
    caption: '行＝星期 · 列＝周 · 峰值 ' + peak,
    status: props.status,
    populated: cells.length > 0,
    body: function () {
      return h('svg', {
        viewBox: `0 0 ${w} ${hgt}`,
        width: '100%',
        height: String(hgt),
        role: 'img',
        'aria-label': '访问热力图：' + String(days.length) + ' 天，峰值 ' + String(peak) + ' 次',
      },
        // Seven row labels, so "row = weekday" is legible.
        ...WEEKDAY_LABEL.map(function (label, row) {
          return h('text', {
            key: 'd' + String(row),
            x: 0,
            y: row * (CELL + GAP) + CELL - 2,
            className: 'dsh-memory-figure-tick',
          }, label)
        }),
        ...cells.map(function (c) {
          return h('rect', {
            key: c.date,
            x: ROW_LABEL_W + c.x * (CELL + GAP),
            y: c.y * (CELL + GAP),
            width: CELL,
            height: CELL,
            rx: 2,
            fill: 'var(--dsw-alias-brand-primary)',
            fillOpacity: String(levelOpacity(c.level)),
            'aria-label': c.date + ': ' + String(c.count),
          })
        }),
      )
    },
  })
}

// ── 2. Growth curve ────────────────────────────────────────────────

const GROWTH_W = 300
const GROWTH_H = 90

/**
 * Cumulative memory growth as a filled area, with the covered date range in the
 * caption. Without `span.start → span.end` the reader has no idea what window
 * the x axis spans — the series carries no dates of its own.
 */
export function GrowthChart(props: FigureProps): Child {
  const daily = props.data?.daily ?? []
  const span = props.data?.span ?? { start: null, end: null }
  // Cumulative, not per-day: the question is "how big is the library", and a
  // per-day series on a vault that grows in a few big steps reads as noise.
  let running = 0
  const points = daily.map(function (d) {
    running += d.count
    return { date: d.date, count: running }
  })
  const line = linePath(points, GROWTH_W, GROWTH_H)
  // The area fill closes the SAME path down to the baseline. One extra command,
  // no second geometry function.
  const area = line
    ? line + ` L${GROWTH_W},${GROWTH_H} L0,${GROWTH_H} Z`
    : ''

  return h(Frame, {
    title: '记忆生长',
    caption: spanText(span),
    status: props.status,
    populated: points.length > 0,
    body: function () {
      return h('svg', {
        viewBox: `0 0 ${GROWTH_W} ${GROWTH_H}`,
        width: '100%',
        height: String(GROWTH_H),
        role: 'img',
        'aria-label': '记忆累计生长，' + spanText(span) + '，共 ' + String(running) + ' 条',
      },
        h('path', {
          d: area,
          fill: 'var(--dsw-alias-brand-primary)',
          fillOpacity: '0.18',
          stroke: 'none',
        }),
        h('path', {
          d: line,
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.5,
        }),
      )
    },
  })
}

// ── 3. Composition donut ───────────────────────────────────────────

const DONUT_R = 46
const DONUT_RI = 28
/** Distinct hues for at most this many slices; a palette, not a token. */
const SLICE_OPACITY = [1, 0.78, 0.6, 0.46, 0.36, 0.28, 0.22]

/**
 * What the library is made of, by type, with a legend.
 *
 * The legend is mandatory: seven unlabelled arcs are a colour wheel, not a
 * figure. Each entry repeats the share the geometry computed, so the picture and
 * the numbers cannot disagree.
 */
export function BreakdownDonut(props: FigureProps): Child {
  const types = props.data?.types ?? []
  const parts = types.map(function (t) { return { label: t.type, value: t.count } })
  const segs = donutSegments(parts, DONUT_R, DONUT_RI)
  const box = DONUT_R * 2 + 2

  return h(Frame, {
    title: '构成',
    caption: String(parts.length) + ' 类',
    status: props.status,
    populated: segs.some(function (s) { return s.d !== '' }),
    body: function () {
      return h('div', { className: 'dsh-memory-figure-split' },
        h('svg', {
          viewBox: `${-DONUT_R - 1} ${-DONUT_R - 1} ${box} ${box}`,
          width: String(box),
          height: String(box),
          role: 'img',
          'aria-label': '记忆构成环图，共 ' + String(parts.length) + ' 类',
        },
          ...segs.map(function (s, i) {
            return h('path', {
              key: s.label + String(i),
              d: s.d,
              fill: 'var(--dsw-alias-brand-primary)',
              fillOpacity: String(SLICE_OPACITY[i % SLICE_OPACITY.length]),
              stroke: 'var(--dsw-alias-bg-layer-2)',
              strokeWidth: 1,
            })
          }),
        ),
        // The legend. A donut nobody can decode is decoration.
        h('ul', { className: 'dsh-memory-legend' },
          ...segs.map(function (s, i) {
            return h('li', { key: 'l' + s.label + String(i), className: 'dsh-memory-legend-item' },
              h('i', {
                className: 'dsh-memory-legend-swatch',
                style: {
                  background: 'var(--dsw-alias-brand-primary)',
                  opacity: String(SLICE_OPACITY[i % SLICE_OPACITY.length]),
                },
              }),
              h('span', { className: 'dsh-memory-legend-name' }, truncateLabel(s.label, 12)),
              h('span', { className: 'dsh-memory-legend-val' },
                String(Math.round(s.share * 100)) + '%'),
            )
          }),
        ),
      )
    },
  })
}

// ── 4. Top-accessed bars ───────────────────────────────────────────

const BAR_W = 96

/**
 * The most-recalled memories, longest bar first (the core already sorts them).
 *
 * `label` is corpus text and arrives `untrusted:true`: it is passed as a text
 * child and truncated, never as markup. The bar is sized by the tested
 * `barRows`, so the widest row is exactly `BAR_W`.
 */
export function TopBars(props: FigureProps): Child {
  const top = props.data?.top ?? []
  const rows = barRows(top.map(function (t) { return { label: t.label, value: t.count } }), BAR_W)

  return h(Frame, {
    title: '活跃排行',
    caption: String(rows.length) + ' 条',
    status: props.status,
    populated: rows.length > 0,
    body: function () {
      return h('div', { className: 'dsh-memory-figure-bars' },
        ...rows.map(function (r, i) {
          return h('div', {
            key: String(i) + r.label,
            className: 'dsh-memory-figure-bar',
            title: r.label + ' · ' + String(r.value),
          },
            h('span', { className: 'dsh-memory-figure-bar-name' }, truncateLabel(r.label)),
            h('span', { className: 'dsh-memory-figure-bar-track' },
              h('i', {
                className: 'dsh-memory-figure-bar-fill',
                style: { width: String(r.width) + '%' },
              }),
            ),
            h('span', { className: 'dsh-memory-figure-bar-val' }, String(r.value)),
          )
        }),
      )
    },
  })
}
