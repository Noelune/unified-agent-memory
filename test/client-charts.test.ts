import { describe, it, expect } from 'vitest'
import { calendarGrid, linePath, donutSegments, barRows } from '../src/client/charts.ts'

// Production callers slice the time window before calling; the geometry here
// only maps `{date,count}` onto a grid. See task-6 fix round 1 for why the
// dead `weeksBack` parameter was removed instead of implemented.
//
// `y` is the weekday, fixed as `0=Sunday .. 6=Saturday` (JavaScript `getDay()`
// numbering), so a heatmap row always means the same weekday. `x` is the index
// of the week relative to the first day in the array, so a gap in the data
// widens a column instead of silently shifting every later day left.

describe('calendarGrid', () => {
  it('places a known span on the weekday row, not the array index row', () => {
    // 2026-08-16 is a Sunday: the row must come from the date, never from `i`.
    const days = [
      { date: '2026-08-16', count: 0 }, // Sunday
      { date: '2026-08-17', count: 1 }, // Monday
      { date: '2026-08-18', count: 2 }, // Tuesday
      { date: '2026-08-19', count: 3 }, // Wednesday
      { date: '2026-08-20', count: 4 }, // Thursday
      { date: '2026-08-21', count: 5 }, // Friday
      { date: '2026-08-22', count: 6 }, // Saturday
    ]
    const cells = calendarGrid(days)
    expect(cells[0].y).toBe(0) // Sunday
    expect(cells[1].y).toBe(1) // Monday, one row below the day before
    expect(cells[1].y - cells[0].y).toBe(1)
    for (const cell of cells) {
      // 0=Sunday numbering, matching `Date#getUTCDay()`.
      expect(cell.y).toBe(new Date(`${cell.date}T00:00:00Z`).getUTCDay())
    }
    // Seven consecutive days fill the first column and reach the next one.
    expect(cells[0].x).toBe(0)
    expect(cells[6].x).toBe(0)
  })

  it('widens the columns across a gap instead of shifting the rows', () => {
    // Hand-built gapped data: Sunday, Monday, then the following Wednesday.
    const days = [
      { date: '2026-08-16', count: 0 }, // Sunday of week 0
      { date: '2026-08-17', count: 1 }, // Monday of week 0
      { date: '2026-08-26', count: 2 }, // Wednesday of week 1 (nine-day gap)
    ]
    const cells = calendarGrid(days)
    expect(cells.map((c) => c.y)).toEqual([0, 1, 3])
    expect(cells.map((c) => c.x)).toEqual([0, 0, 1])
    // The gap must not drag the third day into Wednesday of the first column.
    expect(cells[2].x).toBe(1)
    expect(cells[2].y).toBe(3)
  })

  it('advances x by one per week even when weeks are skipped', () => {
    const days = [
      { date: '2026-08-16', count: 0 }, // week 0
      { date: '2026-08-24', count: 1 }, // week 1 (Monday)
      { date: '2026-09-09', count: 2 }, // week 3 (Wednesday), week 2 skipped
    ]
    const cells = calendarGrid(days)
    expect(cells[0].x).toBe(0)
    expect(cells[1].x).toBe(1)
    expect(cells[2].x).toBe(3)
    expect(cells[2].x).toBeGreaterThan(cells[1].x)
    expect(cells.map((c) => c.y)).toEqual([0, 1, 3])
  })

  it('maps counts onto discrete intensity levels', () => {
    const days = [{ date: '2026-01-01', count: 0 }, { date: '2026-01-02', count: 100 }]
    const cells = calendarGrid(days)
    expect(cells[0].level).toBe(0)
    expect(cells[1].level).toBeGreaterThan(0)
  })

  it('returns an empty array for no data', () => {
    expect(calendarGrid([])).toEqual([])
  })

  it('does not let an unparseable first date cascade into the later cells', () => {
    // The first stamp seeds the origin. If it is NaN the origin is NaN, so
    // every `at - start` is NaN and the whole heatmap collapses. The later,
    // perfectly valid days must keep their real geometry.
    const days = [
      { date: '', count: 0 }, // unparseable
      { date: '2026-08-17', count: 1 }, // Monday
      { date: '2026-08-18', count: 2 }, // Tuesday
    ]
    const cells = calendarGrid(days)
    // The origin falls back to 2026-08-17 (the first parseable stamp), so the
    // valid days keep consecutive weekdays instead of collapsing to NaN.
    expect(cells[1]).toMatchObject({ x: 0, y: 0 }) // origin day 08-17
    expect(cells[2]).toMatchObject({ x: 0, y: 1 }) // 08-18 is the next weekday
    expect(cells[2].y - cells[1].y).toBe(1)
    // And the geometry is self-consistent with the fallback origin.
    expect(cells[2].y).toBe(new Date('2026-08-18T00:00:00Z').getUTCDay() - 1)
  })

  it('never emits NaN coordinates when the first date is unparseable', () => {
    const days = [
      { date: 'garbage', count: 0 },
      { date: '2026-08-17', count: 1 },
      { date: '2026-08-18', count: 2 },
    ]
    for (const cell of calendarGrid(days)) {
      expect(Number.isFinite(cell.x)).toBe(true)
      expect(Number.isFinite(cell.y)).toBe(true)
    }
  })
})

describe('linePath', () => {
  it('starts at the first point and is a closed polyline', () => {
    const d = linePath([{ date: '2026-01-01', count: 0 }, { date: '2026-01-02', count: 5 }], 100, 50)
    expect(d.startsWith('M')).toBe(true)
    expect(d).toContain('L')
  })

  it('returns an empty string for no points', () => {
    expect(linePath([], 100, 50)).toBe('')
  })

  it('treats a flat series as a horizontal line, never NaN', () => {
    const d = linePath([{ date: '2026-01-01', count: 7 }, { date: '2026-01-02', count: 7 }], 100, 50)
    expect(d).not.toContain('NaN')
  })

  it('pins an all-zero series to the baseline instead of dividing by zero', () => {
    // `max === 0` is the only input that reaches the `max <= 0` guard: a
    // non-zero flat series has `max > 0` and never exercises it.
    const d = linePath([{ date: '2026-01-01', count: 0 }, { date: '2026-01-02', count: 0 }], 100, 50)
    expect(d).not.toContain('NaN')
    expect(d).toBe('M0.00,50.00 L100.00,50.00')
  })
})

describe('donutSegments', () => {
  it('shares sum to 1', () => {
    const segs = donutSegments([{ label: 'a', value: 3 }, { label: 'b', value: 1 }], 50, 30)
    expect(segs.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6)
    expect(segs[0].share).toBeCloseTo(0.75, 6)
  })

  it('handles an all-zero input without dividing by zero', () => {
    const segs = donutSegments([{ label: 'a', value: 0 }], 50, 30)
    expect(segs.every((s) => Number.isFinite(s.share))).toBe(true)
  })
})

describe('barRows', () => {
  it('scales the widest bar to the full width', () => {
    const rows = barRows([{ label: 'a', value: 10 }, { label: 'b', value: 5 }], 200)
    expect(rows[0].width).toBe(200)
    expect(rows[1].width).toBe(100)
  })

  it('returns zero-width rows when everything is zero', () => {
    const rows = barRows([{ label: 'a', value: 0 }], 200)
    expect(rows[0].width).toBe(0)
  })
})
