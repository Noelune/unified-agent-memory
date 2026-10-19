/**
 * dsh-unified-agent-memory — host half (cordis plugin for DeepSeek Harness).
 *
 * Architecture (three layers):
 *
 *   src/index.ts   — thin entry: resolve config, register tools, wire routes
 *   src/status-payload.ts — pure builder for the /status response body
 *   src/tools.ts   — 5 tool definitions (memory_search / show / submit / status
 *                    / preview) plus memory_setup
 *   src/recall.ts  — automatic pre-turn recall + discipline rules (the merged
 *                    dsh-memory-discipline layer)
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
 * Beyond the tools, the plugin listens to `agent/pre-step` and injects recall
 * for memory-sensitive turns (src/recall.ts). That used to be a second package
 * (`dsh-memory-discipline`) which spawned its own Python with its own hardcoded
 * core path; merged here it shares `pythonPath`/`corePath` with the tools, so
 * one install covers both the "ask the agent to look it up" and the "the agent
 * already knows" halves. It is registered best-effort and never gates loading.
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
 *   recall        (UNIFIED_MEMORY_RECALL)  auto | always | off, default "auto"
 *   recallLimit / recallMaxChars / recallMinQueryChars / recallTimeoutMs
 *   recallInstructions                    default true (once per session)
 *
 * Security: canonical notes are READ-ONLY; the only write path is the inbox
 * via memory_submit. Core output is redacted before printing. Credentials
 * must never be stored in vault notes (only label/location references).
 * Recall output is wrapped in <memory-data> and marked as data, never
 * instructions.
 *
 * Without vaultPath the tools load with a clear "not configured" message
 * (graceful degradation), guiding the user through first-time setup, and the
 * recall hook stays dormant instead of spawning a doomed search every turn.
 *
 * @module src/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, runCore } from './utils.ts'
import { registerAll } from './tools.ts'
import type { ApprovalLike } from './tools.ts'
import { installRecall } from './recall.ts'
import { checkForUpdate, getUpdateInfo } from './updater.ts'
import { buildStatusPayload } from './status-payload.ts'
import { ONBOARDING_SCOPE, consentSatisfied, readOnboardingState } from './onboarding.ts'
import { guard, guardWrite, queryParam, readBody, sendJson } from './routes.ts'
import type { RouteReq, RouteRes } from './routes.ts'
import { SEARCH_PATH, clampSearchLimit, handleSearch } from './route-search.ts'
import {
  NOTE_PATH, PREVIEW_PATH, PREVIEW_VIEWS, clampPreviewLimit, handleNote, handlePreview,
} from './route-preview.ts'
import { DISMISS_PATH, handleDismiss, parseDismissBody } from './route-dismiss.ts'
import { STATS_PATH, buildStatsArgs, shapeStatsResult } from './route-stats.ts'
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

  // ---- Optional approval service (memory_setup asks through it) ----
  // `ctx.inject(deps, cb)` is Cordis' plugin() under the hood: the callback gets
  // a child context that may read the injected service. Closing over the OUTER
  // ctx and reading the service from it is exactly what made the webServer
  // access throw before (see `inject` above). A mutable ref rather than a direct
  // capture because the service can appear after this plugin starts, and the
  // tool only reads it at call time.
  let approvalRef: ApprovalLike | undefined
  const self = ctx as unknown as {
    inject?: (deps: string[], apply: (child: { approval?: ApprovalLike }) => void) => unknown
  }
  if (typeof self.inject === 'function') {
    self.inject(['approval'], (child) => {
      approvalRef = child.approval
    })
  }

  // ---- Register the model tools (memory_setup included) ----
  registerAll(ctx, cfg, {
    approval: () => approvalRef,
    // setup writes a vault and a config; the live tools must stop reporting
    // "not configured" without requiring a restart.
    reload: () => Object.assign(cfg, resolveConfig(config)),
  })

  // ---- Automatic pre-turn recall (the merged discipline layer) ----
  // Registered after the tools so a failure here cannot cost the user the
  // tools. `name` is the producer id that goes into the injected message's
  // source.kind — session format v4 rejects the retired bare 'plugin' kind and
  // fails the whole turn, so this literal has to be the package name exactly.
  installRecall(ctx as never, cfg, name)

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
          // Whether first-run setup is done for the vault in use right now —
          // a grant for a different vault does not count (consent is per-vault).
          const granted = consentSatisfied(readOnboardingState(), {
            vaultPath: cfg.vaultPath,
            scope: ONBOARDING_SCOPE,
          })
          sendJson(res, 200, buildStatusPayload(cfg, ui, stats, { granted }))
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
        // `limit` is clamped here for the same reason `/preview` clamps its
        // own: the value is caller-supplied and would otherwise reach
        // argparse, where garbage exits non-zero and reads as a dead core.
        const limit = clampSearchLimit(queryParam(req.url, 'limit'))
        sendJson(res, 200, await handleSearch(cfg, query, hybrid, limit))
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

  // ---- HTTP stats route: the read-only aggregate feed ----
  // Registered last so the existing endpoints keep their positions. Read-only
  // like /preview and /search: `guard`, never `guardWrite`. A core that is
  // unconfigured, missing or crashed is NOT a server fault here — this is a
  // dashboard feed, so it degrades to 200 + `{ok:false}` exactly as /preview
  // does, and the panel renders "no figures" instead of an error banner.
  ws.webServer.register({
    kind: 'exact',
    path: STATS_PATH,
    handler(req, res) {
      if (!guard(req, res, ['GET', 'HEAD'])) return
      return (async () => {
        const r = await runCore(cfg, buildStatsArgs())
        const payload = r.ok
          ? shapeStatsResult(r.output)
          : { ok: false, status: 'error' as const, data: null }
        sendJson(res, 200, {
          ok: payload.ok,
          command: 'stats',
          status: payload.status,
          data: payload.data,
        })
      })()
    },
  })
}

export type { PluginConfig } from './types.ts'