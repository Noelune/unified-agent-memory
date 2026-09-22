import { describe, it, expect } from 'vitest'
import { calendarGrid, linePath, donutSegments, barRows } from '../src/client/charts.ts'

describe('calendarGrid', () => {
  it('lays days out in columns of seven, oldest first', () => {
    const days = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`, count: i,
    }))
    const cells = calendarGrid(days, 2)
    expect(cells).toHaveLength(14)
    expect(cells[0].x).toBe(0)
    expect(cells[0].y).toBe(0)
    expect(cells[7].x).toBe(1)   // second week -> next column
    expect(cells[7].y).toBe(0)
    expect(cells[8].y).toBe(1)
  })

  it('maps counts onto discrete intensity levels', () => {
    const days = [{ date: '2026-01-01', count: 0 }, { date: '2026-01-02', count: 100 }]
    const cells = calendarGrid(days, 1)
    expect(cells[0].level).toBe(0)
    expect(cells[1].level).toBeGreaterThan(0)
  })

  it('returns an empty array for no data', () => {
    expect(calendarGrid([], 1)).toEqual([])
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
