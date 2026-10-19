/**
 * route-doc — read ONE canonical note by name, for the console's search pane.
 *
 * `/note` cannot serve this: it reads the submission inbox (`preview.read_inbox_item`)
 * and refuses everything else, which is exactly right for the inbox pane and
 * useless for a search hit. A search hit names a canonical note under
 * `50-Agent-Context/`, so the read has to go through the core's `show` command.
 *
 * Why this route exists at all, rather than the client printing the hit's file
 * name and stopping: a search result the user cannot open is a list of things
 * they cannot check. The whole point of searching is to READ the note.
 *
 * Read-only by construction — `show` prints a canonical note and writes nothing.
 * It is registered with `guard` (GET/HEAD), never `guardWrite`.
 *
 * @module src/route-doc
 */

import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** One canonical note's body, by file name. */
export const DOC_PATH = '/api/dsh-unified-agent-memory/doc'

export interface DocPayload {
  ok: boolean
  /** The file name the core actually resolved, or '' when nothing was read. */
  name: string
  /**
   * Absolute path of the note, or null when nothing was read.
   *
   * Shipped to the client on purpose: the panel can render the body but it
   * cannot put the file into the user's editor. Showing where the note lives is
   * what lets them take that last step themselves.
   */
  path: string | null
  body: string | null
  /**
   * The core's own label: `invalid-name` (refused before resolving),
   * `not-found` (no such note), `unavailable` (the core did not run). Kept
   * distinct because they call for different next actions — and because
   * collapsing them into `body: null` makes a refused name look like a dead
   * core.
   */
  reason: string | null
  /**
   * Always `true`: the body is vault text written by other agents. The client
   * renders it as text and never as markup (docs/JSON-CONTRACT.md §2).
   */
  untrusted: true
}

export function buildDocArgs(name: string): string[] {
  return ['show', name, '--json']
}

/**
 * Unwrap a `show --json` envelope.
 *
 * `ok` tracks the TRANSPORT, not the read: the core answers `ok:true` with
 * `body:null` + `reason` for a note it could not resolve, so that a miss still
 * exits 0 and its reason survives the subprocess. A `parsed.ok !== true` here
 * therefore means the envelope itself was malformed, which is a different
 * failure and is reported as `ok:false`.
 */
export function shapeDocResult(raw: string): DocPayload {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      data?: {
        name?: string | null
        path?: string | null
        body?: string | null
        reason?: string | null
      }
    }
    if (parsed.ok !== true || !parsed.data) {
      return { ok: false, name: '', path: null, body: null, reason: 'unavailable', untrusted: true }
    }
    const body = parsed.data.body
    return {
      ok: true,
      name: typeof parsed.data.name === 'string' ? parsed.data.name : '',
      path: typeof parsed.data.path === 'string' ? parsed.data.path : null,
      body: typeof body === 'string' ? body : null,
      reason: typeof parsed.data.reason === 'string' ? parsed.data.reason : null,
      untrusted: true,
    }
  } catch {
    return { ok: false, name: '', path: null, body: null, reason: 'unavailable', untrusted: true }
  }
}

export async function handleDoc(cfg: PluginConfig, name: string): Promise<DocPayload> {
  try {
    const r = await runCore(cfg, buildDocArgs(name))
    if (!r.ok) return { ok: false, name, path: null, body: null, reason: 'unavailable', untrusted: true }
    return shapeDocResult(r.output)
  } catch {
    return { ok: false, name, path: null, body: null, reason: 'unavailable', untrusted: true }
  }
}
