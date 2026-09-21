import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** Read-only governance views. */
export const PREVIEW_PATH = '/api/dsh-unified-agent-memory/preview'
/** One submission's body, by name. */
export const NOTE_PATH = '/api/dsh-unified-agent-memory/note'

/** Mirrors `preview.VIEWS` in the core. */
export const PREVIEW_VIEWS = ['pending', 'recent', 'forgetting', 'conflicts'] as const

/** Default cap on a returned list. */
export const PREVIEW_LIMIT = 20

/** Hard ceiling on an accepted `limit`; a larger ask is clamped, not refused. */
export const PREVIEW_LIMIT_MAX = 100

/**
 * Clamp a caller-supplied `limit` into `[1, PREVIEW_LIMIT_MAX]`.
 *
 * Garbage (absent, non-numeric, NaN, zero, negative) falls back to the default
 * rather than reaching the core: `--limit abc` would exit non-zero and turn a
 * renderable view into a silent `{ok:false}`.
 */
export function clampPreviewLimit(raw: string | null): number {
  const n = Number(raw)
  if (raw === null || raw === '' || !Number.isFinite(n) || n < 1) return PREVIEW_LIMIT
  return Math.min(Math.floor(n), PREVIEW_LIMIT_MAX)
}

export interface PreviewPayload {
  ok: boolean
  view: string
  status: string
  count: number
  items: unknown[]
}

export interface NotePayload {
  ok: boolean
  name: string
  body: string | null
  /**
   * The core's own failure label (`invalid-name` / `not-found`), passed through
   * verbatim. Task 1 made the core distinguish "this name was refused" from
   * "this item is gone"; dropping the field here would collapse both back into
   * `body: null` and make a refused name look like a missing file — or like a
   * dead core. Absent on a successful read.
   */
  reason?: string | null
}

export function buildPreviewArgs(view: string, limit: number): string[] {
  return ['preview', view, '--limit', String(limit), '--json']
}

export function buildNoteArgs(name: string): string[] {
  return ['note', name, '--json']
}

/**
 * Unwrap a preview envelope.
 *
 * `status` travels verbatim because the core distinguishes "this view is not
 * implemented yet" (`unsupported`) from "implemented, nothing matched" (`ok`
 * with zero items). Collapsing those two would make a governance view that
 * cannot answer look identical to a governance view reporting no conflicts.
 */
export function shapePreviewResult(raw: string): PreviewPayload {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      data?: { view?: string; status?: string; count?: number; items?: unknown[] }
    }
    if (parsed.ok !== true || !parsed.data) {
      return { ok: false, view: '', status: 'error', count: 0, items: [] }
    }
    const items = Array.isArray(parsed.data.items) ? parsed.data.items : []
    return {
      ok: true,
      view: String(parsed.data.view ?? ''),
      status: String(parsed.data.status ?? 'ok'),
      count: Number.isFinite(Number(parsed.data.count)) ? Number(parsed.data.count) : items.length,
      items,
    }
  } catch {
    return { ok: false, view: '', status: 'error', count: 0, items: [] }
  }
}

/** True when `view` is one of the governance views the core implements. */
export function isPreviewView(view: string): boolean {
  return (PREVIEW_VIEWS as readonly string[]).includes(view)
}

/** Unwrap a note read. `body: null` is "not readable", distinct from "". */
export function shapeNoteResult(raw: string): NotePayload {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      data?: { name?: string; body?: string | null; reason?: string | null }
    }
    if (parsed.ok !== true || !parsed.data) {
      return { ok: false, name: '', body: null }
    }
    const body = parsed.data.body
    return {
      ok: true,
      name: String(parsed.data.name ?? ''),
      body: typeof body === 'string' ? body : null,
      reason: parsed.data.reason ?? null,
    }
  } catch {
    return { ok: false, name: '', body: null }
  }
}

export async function handlePreview(
  cfg: PluginConfig, view: string, limit: number,
): Promise<PreviewPayload> {
  try {
    const r = await runCore(cfg, buildPreviewArgs(view, limit))
    if (!r.ok) return { ok: false, view, status: 'error', count: 0, items: [] }
    return shapePreviewResult(r.output)
  } catch {
    return { ok: false, view, status: 'error', count: 0, items: [] }
  }
}

export async function handleNote(cfg: PluginConfig, name: string): Promise<NotePayload> {
  try {
    const r = await runCore(cfg, buildNoteArgs(name))
    if (!r.ok) return { ok: false, name, body: null }
    return shapeNoteResult(r.output)
  } catch {
    return { ok: false, name, body: null }
  }
}
