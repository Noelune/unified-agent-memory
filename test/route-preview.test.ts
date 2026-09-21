import { describe, expect, it } from 'vitest'
import {
  PREVIEW_VIEWS, buildNoteArgs, buildPreviewArgs,
  shapeNoteResult, shapePreviewResult,
} from '../src/route-preview.ts'

describe('buildPreviewArgs', () => {
  it('names the view and caps the list', () => {
    expect(buildPreviewArgs('pending', 20)).toEqual(
      ['preview', 'pending', '--limit', '20', '--json'])
  })
})

describe('buildNoteArgs', () => {
  it('reads by name', () => {
    expect(buildNoteArgs('a.md')).toEqual(['note', 'a.md', '--json'])
  })
})

describe('PREVIEW_VIEWS', () => {
  it('covers the four governance views', () => {
    expect([...PREVIEW_VIEWS]).toEqual(['pending', 'recent', 'forgetting', 'conflicts'])
  })
})

describe('shapePreviewResult', () => {
  it('carries the unsupported status through', () => {
    const raw = JSON.stringify({ ok: true, command: 'preview',
      data: { view: 'conflicts', status: 'unsupported', count: 0, items: [] } })
    const got = shapePreviewResult(raw)
    expect(got.status).toBe('unsupported')
    expect(got.view).toBe('conflicts')
  })

  it('degrades on bad json', () => {
    const got = shapePreviewResult('{')
    expect(got.ok).toBe(false)
    expect(got.items).toEqual([])
  })
})

describe('shapeNoteResult', () => {
  it('returns the body', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'a.md', body: '- hi' } })
    expect(shapeNoteResult(raw).body).toBe('- hi')
  })

  it('keeps body null when the item is missing', () => {
    const raw = JSON.stringify({ ok: true, command: 'note',
      data: { name: 'a.md', body: null } })
    expect(shapeNoteResult(raw).body).toBeNull()
  })

  it('degrades on bad json', () => {
    expect(shapeNoteResult('nope').ok).toBe(false)
  })
})
