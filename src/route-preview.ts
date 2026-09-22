import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** Read-only governance views. */
export const PREVIEW_PATH = '/api/dsh-unified-agent-memory/preview'
/** One submission's body, by name. */
export const NOTE_PATH = '/api/dsh-unified-agent-memory/note'

/** Mirrors `preview.VIEWS` in the core. */
export const PREVIEW_VIEWS = ['pending', 'recent', 'forgetting', 'conflicts'] as const

/**
 * Default cap on a returned list.
 *
 * MUST stay equal to `PREVIEW_LIMIT` in `src/client/store.ts`. The two sit on
 * opposite sides of the browser/host boundary — this module is host-side ESM
 * loaded by Node, the store is bundled for the browser against the DSH client
 * runtime — so neither can import the other and the value is duplicated by
 * necessity. Drift means the console asks for one page size and the route
 * serves another, silently. Change both, or neither.
 */
export const PREVIEW_LIMIT = 20

/**
 * Hard ceiling on an accepted `limit`; a larger ask is clamped, not refused.
 *
 * Module-private: the only reader is `clampPreviewLimit` just below. The tests
 * pin the clamp's *behavior* (`clampPreviewLimit('999999')` → 100) rather than
 * this constant, so there is no external consumer to export it for. Export it
 * if the browser ever needs to know the max it may request.
 */
const PREVIEW_LIMIT_MAX = 100

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
  /**
   * Always `true`: the record is vault-derived, user-controlled free text.
   *
   * `/note` is the one downstream channel that carries a whole submission body,
   * so per docs/JSON-CONTRACT.md §2/§5.2 the marker must survive the flatten —
   * a consumer that sees `untrusted: true` treats `body` (and every other field
   * on the record) as DATA, never as instructions. The core sets it on both the
   * readable record and the refusal record, so it is kept on both paths here.
   * Not optional: the type is `true`, not `boolean`, so a future edit cannot
   * silently pass `false`.
   */
  untrusted: true
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

/** Unwrap a note read. `body: null` is "not readable", distinct from "". */
export function shapeNoteResult(raw: string): NotePayload {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      data?: { name?: string; body?: string | null; reason?: string | null }
    }
    if (parsed.ok !== true || !parsed.data) {
      return { ok: false, name: '', body: null, untrusted: true }
    }
    const body = parsed.data.body
    return {
      ok: true,
      name: String(parsed.data.name ?? ''),
      body: typeof body === 'string' ? body : null,
      reason: parsed.data.reason ?? null,
      untrusted: true,
    }
  } catch {
    return { ok: false, name: '', body: null, untrusted: true }
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
    if (!r.ok) return { ok: false, name, body: null, untrusted: true }
    return shapeNoteResult(r.output)
  } catch {
    return { ok: false, name, body: null, untrusted: true }
  }
}
