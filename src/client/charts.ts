/**
 * Pure geometry for the console figures — no DOM, no React, no fetch.
 *
 * Keeping the maths here (rather than inside the components) is what lets the
 * Node test runner assert real numbers: a React component cannot be loaded by
 * the runner, but these functions can.
 */

export interface DayCount { date: string; count: number }
export interface Cell { x: number; y: number; level: number; date: string; count: number }
export interface Seg { d: string; label: string; value: number; share: number }
export interface Row { label: string; value: number; width: number; share: number }

const LEVELS = 4

/** Bucket a count into 0..LEVELS using the series maximum as the ceiling. */
function levelOf(count: number, max: number): number {
  if (count <= 0) return 0
  if (max <= 0) return 0
  return Math.max(1, Math.min(LEVELS, Math.ceil((count / max) * LEVELS)))
}

const DAY_MS = 86_400_000

/** Midnight UTC of a `YYYY-MM-DD` day, in ms. NaN for an unparseable date. */
function dayMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime()
}

/**
 * GitHub-style calendar: one column per week, seven rows per week.
 * Oldest day first, so the grid reads left-to-right like a calendar.
 *
 * `y` is the weekday with JavaScript's `getDay()` numbering — `0` is Sunday and
 * `6` is Saturday — so a row always means the same weekday. `x` is the week
 * index relative to the first day in `days`, so a gap in the data widens a
 * column instead of shifting every later day one row left.
 *
 * The time window is the caller's business: slice `days` before calling.
 */
export function calendarGrid(days: DayCount[]): Cell[] {
  if (days.length === 0) return []
  const max = days.reduce((m, d) => Math.max(m, d.count), 0)
  // Both ends of the offset must be finite. The origin cannot blindly trust
  // `days[0].date`: one bad first stamp makes every `at - start` NaN and
  // collapses the whole grid, valid later days included. Fall back to the
  // first parseable stamp (or, if there is none, treat the origin as 0).
  //
  // ponytail: when the fallback fires, the origin day lands on `y = 0` even if
  // it is not really a Sunday — the true weekday of the origin is unknowable
  // once the stamp is gone. The grid therefore keeps every day's *relative*
  // position correct but may sit a few rows above where a calendar would put
  // it. Closing this needs a caller-supplied origin (or a validated date), not
  // more guessing here; `Cell.date` is passed through intact so a caller can
  // still re-align.
  let last = dayMs(days[0].date)
  let start = last
  if (!Number.isFinite(start)) {
    const first = days.find((d) => Number.isFinite(dayMs(d.date)))
    start = first ? dayMs(first.date) : 0
  }
  if (!Number.isFinite(last)) last = start
  return days.map((d) => {
    const ms = dayMs(d.date)
    // `ms - start` is a whole number of days for any real date; keep the last
    // valid stamp for an unparseable one so the geometry stays finite.
    const at = Number.isFinite(ms) ? ms : last
    last = at
    const offset = Math.round((at - start) / DAY_MS)
    return {
      x: Math.floor(offset / 7),
      y: ((offset % 7) + 7) % 7,
      level: levelOf(d.count, max),
      date: d.date,
      count: d.count,
    }
  })
}

/** Cumulative growth as an SVG path (straight segments; area fill is the caller's job). */
export function linePath(points: DayCount[], w: number, h: number): string {
  if (points.length === 0) return ''
  const max = points.reduce((m, p) => Math.max(m, p.count), 0)
  const stepX = points.length > 1 ? w / (points.length - 1) : 0
  const yFor = (v: number) => (max <= 0 ? h : h - (v / max) * h)
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${yFor(p.count).toFixed(2)}`)
    .join(' ')
}

/** Donut segments as SVG arc paths. A zero total yields all-zero shares. */
export function donutSegments(parts: { label: string; value: number }[], r: number, ri: number): Seg[] {
  const total = parts.reduce((s, p) => s + p.value, 0)
  let angle = -Math.PI / 2
  return parts.map((p) => {
    const share = total > 0 ? p.value / total : 0
    const sweep = share * Math.PI * 2
    const from = angle
    const to = angle + sweep
    angle = to
    const large = sweep > Math.PI ? 1 : 0
    const x1 = r * Math.cos(from), y1 = r * Math.sin(from)
    const x2 = r * Math.cos(to), y2 = r * Math.sin(to)
    const x3 = ri * Math.cos(to), y3 = ri * Math.sin(to)
    const x4 = ri * Math.cos(from), y4 = ri * Math.sin(from)
    const d = share <= 0
      ? ''
      : `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}` +
        ` L${x3.toFixed(2)},${y3.toFixed(2)} A${ri},${ri} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)} Z`
    return { d, label: p.label, value: p.value, share }
  })
}

/** Horizontal bars, widest scaled to `w`. All-zero input gives zero widths. */
export function barRows(items: { label: string; value: number }[], w: number): Row[] {
  const max = items.reduce((m, i) => Math.max(m, i.value), 0)
  const total = items.reduce((s, i) => s + i.value, 0)
  return items.map((i) => ({
    label: i.label,
    value: i.value,
    width: max > 0 ? (i.value / max) * w : 0,
    share: total > 0 ? i.value / total : 0,
  }))
}
