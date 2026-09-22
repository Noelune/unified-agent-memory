/**
 * dsh-unified-agent-memory — host half (cordis plugin for DeepSeek Harness).
 *
 * Architecture (three layers):
 *
 *   src/index.ts   — thin entry: resolve config, register tools, wire routes
 *   src/status-payload.ts — pure builder for the /status response body
 *   src/tools.ts   — 5 tool definitions (memory_search / show / submit / status
 *                    / preview)
 *   src/utils.ts   — config resolution, Python core runner, output rendering
 *   src/client/    — browser half (TypeScript + React for DSH client runtime)
 *
 * The 5 model tools are backed by the dependency-free Python core
 * (unified_memory package, see core/):
 *   memory_search  — search canonical notes (local SQLite FTS5 index)
 *   memory_show    — print one canonical document
 *   memory_submit  — write facts into the submission inbox (only write path)
 *   memory_status  — configuration and index health
 *   memory_preview — read-only governance views (pending/conflicts/…; the
 *                    conflicts view reports itself unsupported until the
 *                    conflict detector writes type='conflict')
 *
 * An optional HTTP status endpoint is registered for the browser client half
 * via the webServer service (injected dynamically — the route only exists
 * when webServer is available).
 *
 * Configuration (plugin settings or env vars):
 *   vaultPath     (UNIFIED_MEMORY_VAULT)   required — your Obsidian vault path
 *   pythonPath    (UNIFIED_MEMORY_PYTHON)  default "python"
 *   corePath      (UNIFIED_MEMORY_COREPATH) optional — core/ dir for PYTHONPATH
 *   remoteEnabled                         default false (local index only)
 *
 * Security: canonical notes are READ-ONLY; the only write path is the inbox
 * via memory_submit. Core output is redacted before printing. Credentials
 * must never be stored in vault notes (only label/location references).
 *
 * Without vaultPath the tools load with a clear "not configured" message
 * (graceful degradation), guiding the user through first-time setup.
 *
 * @module src/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, runCore } from './utils.ts'
import { registerAll } from './tools.ts'
import { checkForUpdate, getUpdateInfo } from './updater.ts'
import { buildStatusPayload } from './status-payload.ts'
import { guard, guardWrite, queryParam, readBody, sendJson } from './routes.ts'
import type { RouteReq, RouteRes } from './routes.ts'
import { SEARCH_PATH, handleSearch } from './route-search.ts'
import {
  NOTE_PATH, PREVIEW_PATH, PREVIEW_VIEWS, clampPreviewLimit, handleNote, handlePreview,
} from './route-preview.ts'
import { DISMISS_PATH, handleDismiss, parseDismissBody } from './route-dismiss.ts'
import type { PluginConfig } from './types.ts'
import type { StatusStats } from './status-payload.ts'
export const name = 'dsh-unified-agent-memory'

/**
 * Required Cordis services.
 *
 * - tools: needed for ctx.tools.register()
 * - webServer: needed for the status route read by the browser client half
 *
 * webServer has to be declared here rather than pulled in with a nested
 * `ctx.inject(['webServer'], ...)`. Cordis guards service access on a plugin's
 * own context, and the nested callback closes over that outer context, so
 * reading `ctx.webServer` inside it throws
 * `cannot get property "webServer" without inject`. That failed this entry at
 * boot: the tools never registered, the route never mounted, and the browser
 * panel silently polled a 404. Declaring it is also what the other
 * route-registering plugins in this profile do.
 */
export const inject: readonly string[] = ['tools', 'webServer']

/**
 * Shape of the webServer route registration used for the status endpoint.
 *
 * Request and response types come from `./routes.ts` — that guard is the single
 * source of truth for the HTTP surface. This local interface only pins the
 * registration shape (kind/path/handler) the host expects.
 */
interface StatusRoute {
  kind: string
  path: string
  handler: (req: RouteReq, res: RouteRes) => void | Promise<void>
}

// ── Read-only stats ─────────────────────────────────────────────────

/**
 * Read live counts from the core for the `/status` route.
 *
 * Degrades to null — never throws — because a broken or unconfigured core must
 * not turn a status read into a 500. The route's try/catch is for serialisation
 * failures, so nothing here is allowed to trip it.
 *
 * `data.memories` is null when the core itself degrades; that is a null result
 * too, not a zeroed one.
 */
async function readStats(cfg: PluginConfig): Promise<StatusStats | null> {
  try {
    const r = await runCore(cfg, ['status', '--json'])
    if (!r.ok) return null

    const data = (JSON.parse(r.output) as { data?: Record<string, unknown> }).data
    const memories = data?.memories as { count?: unknown; vectors?: unknown } | null | undefined
    if (!memories) return null

    const count = Number(memories.count)
    const vectors = Number(memories.vectors)
    // A non-numeric count means the core changed shape under us; degrade to
    // null rather than shipping NaN (which JSON-serialises to null anyway and
    // would surface as a confusing "NaN" in the panel).
    if (!Number.isFinite(count) || !Number.isFinite(vectors)) return null

    const index = data?.index as { fts5?: unknown } | null | undefined
    // `inboxPending` degrades exactly like count/vectors: an absent field is a
    // legitimate 0 (a fresh vault has no submissions), but a present yet
    // non-finite one is a corrupt reading and must null the whole object rather
    // than be flattened to 0 — "0 pending" and "unreadable" are different facts.
    const pendingRaw = data?.inboxPending ?? 0
    const pending = Number(pendingRaw)
    if (!Number.isFinite(pending)) return null

    return {
      memories: count,
      vectors,
      pending,
      indexOk: Boolean(index?.fts5),
    }
  } catch {
    // Unparseable core output, a spawn failure, a timeout — all mean "no
    // counts", which is a legitimate answer for a status endpoint.
    return null
  }
}

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  const cfg = resolveConfig(config)
  const configured = Boolean(cfg.vaultPath)

  // ---- Register 5 model tools ----
  registerAll(ctx, cfg, configured)

  // ---- Fire-and-forget update check against npm registry ----
  checkForUpdate()

  // ---- HTTP status route consumed by the browser client half ----
  // client-ui.js polls it for configuration and health data. register() returns
  // a disposer; cordis drops it when this plugin's fiber is disposed.
  const ws = ctx as unknown as { webServer: { register: (route: StatusRoute) => () => void } }
  ws.webServer.register({
    kind: 'exact',
    path: '/api/dsh-unified-agent-memory/status',
    handler(req, res) {
      // Shared baseline: loopback-only, GET/HEAD, no-store on every answer.
      // A rejected request is already answered, so return without writing more.
      if (!guard(req, res, ['GET', 'HEAD'])) return
      // The stats read is async, so the 200 path resolves a tick later; return
      // the promise so callers can observe completion.
      return (async () => {
        try {
          const ui = getUpdateInfo()
          // Read-only core call; null on any failure. Never throws.
          const stats = await readStats(cfg)
          sendJson(res, 200, buildStatusPayload(cfg, ui, stats))
        } catch {
          // Serialization failure — respond with 500 so the client
          // doesn't hang. This guard exists because JSON.stringify
          // can throw on circular references (unlikely here but
          // a defensive principle).
          sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      })()
    },
  })

  // ---- HTTP search route consumed by the browser client half ----
  // Read-only retrieval over the canonical notes; the panel renders the
  // results. Registered after /status so the status endpoint stays untouched.
  ws.webServer.register({
    kind: 'exact',
    path: SEARCH_PATH,
    handler(req, res) {
      if (!guard(req, res, ['GET', 'HEAD'])) return
      return (async () => {
        const query = queryParam(req.url, 'q')
        if (!query) {
          sendJson(res, 400, { ok: false, error: 'missing query' })
          return
        }
        const hybrid = queryParam(req.url, 'hybrid') === '1'
        sendJson(res, 200, await handleSearch(cfg, query, hybrid))
      })()
    },
  })

  // ---- HTTP preview route: read-only governance views ----
  // `view` is validated here against PREVIEW_VIEWS before it reaches the core:
  // an unknown view would make argparse exit 2 with empty stdout, which the
  // caller sees as a bare `{ok:false}` — indistinguishable from a dead core, so
  // a typo would send an operator looking at the wrong thing. 400 says "your
  // request was wrong"; `limit` is likewise clamped here, since a non-numeric or
  // non-positive value would also trip argparse.
  ws.webServer.register({
    kind: 'exact',
    path: PREVIEW_PATH,
    handler(req, res) {
      if (!guard(req, res, ['GET', 'HEAD'])) return
      return (async () => {
        const view = queryParam(req.url, 'view') ?? 'pending'
        if (!(PREVIEW_VIEWS as readonly string[]).includes(view)) {
          sendJson(res, 400, { ok: false, error: 'unknown view' })
          return
        }
        const limit = clampPreviewLimit(queryParam(req.url, 'limit'))
        sendJson(res, 200, await handlePreview(cfg, view, limit))
      })()
    },
  })

  // ---- HTTP note route: one submission's body, by name ----
  ws.webServer.register({
    kind: 'exact',
    path: NOTE_PATH,
    handler(req, res) {
      if (!guard(req, res, ['GET', 'HEAD'])) return
      return (async () => {
        const name = queryParam(req.url, 'name')
        // An absent name is a malformed request, not a missing item — the core
        // would answer `invalid-name` for "", which reads like a vault fact.
        if (!name) {
          sendJson(res, 400, { ok: false, error: 'missing name' })
          return
        }
        sendJson(res, 200, await handleNote(cfg, name))
      })()
    },
  })

  // ---- HTTP dismiss route: the plugin's ONLY write path ----
  // POST-only, and narrow by construction: the core's `dismiss` moves one inbox
  // entry into `已处理/` — it never deletes and never rewrites a note, and the
  // canonical store stays read-only. The name is whitelisted here before the
  // core is spawned (the core repeats the check; doing it here turns a hostile
  // name into a 400 instead of a wasted process), and the route deliberately
  // does NOT use the read routes' ['GET','HEAD'] guard.
  //
  // Status: 200 when the entry moved, 409 when the core refused it (not-found,
  // outside-inbox, …) — the request was well-formed, it just could not be
  // carried out. 400 is reserved for a body this layer itself rejects, and a
  // failed core call degrades to `{ok:false}` inside handleDismiss rather than
  // becoming a 500; only a serialisation failure in sendJson can 500.
  //
  // `guardWrite`, not `guard`: this is the only route that writes, and an exact
  // route never reaches the host's `/api` prefix auth, so loopback alone would
  // let a hostile page drive it (CSRF / DNS rebinding). Cross-site → 403 before
  // the core is ever spawned.
  ws.webServer.register({
    kind: 'exact',
    path: DISMISS_PATH,
    handler(req, res) {
      if (!guardWrite(req, res)) return
      return (async () => {
        let raw: string
        try {
          raw = await readBody(req)
        } catch {
          // Over the 2048-byte cap for a single filename: caller's fault.
          sendJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        const name = parseDismissBody(raw)
        if (!name) {
          // Absent, empty, non-string or unsafe name — all malformed input,
          // never a vault fact. Refusing here also keeps a traversal name from
          // reaching the core.
          sendJson(res, 400, { ok: false, error: 'invalid name' })
          return
        }
        const result = await handleDismiss(cfg, name)
        sendJson(res, result.ok ? 200 : 409, result)
      })()
    },
  })
}

export type { PluginConfig } from './types.ts'