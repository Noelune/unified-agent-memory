/**
 * dsh-unified-agent-memory — host half (cordis plugin for DeepSeek Harness).
 *
 * Architecture (three layers):
 *
 *   src/index.ts   — thin entry: resolve config, register tools, wire routes
 *   src/tools.ts   — 4 tool definitions (memory_search / show / submit / status)
 *   src/utils.ts   — config resolution, Python core runner, output rendering
 *   src/client/    — browser half (TypeScript + React for DSH client runtime)
 *
 * The 4 model tools are backed by the dependency-free Python core
 * (unified_memory package, see core/):
 *   memory_search  — search canonical notes (local SQLite FTS5 index)
 *   memory_show    — print one canonical document
 *   memory_submit  — write facts into the submission inbox (only write path)
 *   memory_status  — configuration and index health
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
import { resolveConfig } from './utils.ts'
import { registerAll } from './tools.ts'
import { checkForUpdate, getUpdateInfo } from './updater.ts'
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

/** Shape of the webServer route registration used for the status endpoint. */
interface StatusRoute {
  kind: string
  path: string
  handler: (
    req: { socket?: { remoteAddress?: string }; method?: string },
    res: {
      writeHead: (code: number, headers: Record<string, string>) => void
      end: (body: string) => void
    },
  ) => void
}

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  const cfg = resolveConfig(config)
  const configured = Boolean(cfg.vaultPath)

  // ---- Register 4 model tools ----
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
      // Loopback-only: the payload carries local filesystem paths and this
      // harness may sit behind a reverse proxy.
      const remote = String(req.socket?.remoteAddress ?? '')
      if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end('{"ok":false,"error":"forbidden: loopback-only"}')
        return
      }
      if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end('{"ok":false,"error":"method not allowed"}')
        return
      }
      try {
        const ui = getUpdateInfo()
        const body = JSON.stringify({
          ok: true,
          configured: Boolean(cfg.vaultPath),
          vaultPath: cfg.vaultPath || '(not set)',
          pythonPath: cfg.pythonPath,
          corePath: cfg.corePath,
          remoteEnabled: cfg.remoteEnabled,
          version: ui.currentVersion,
          latestVersion: ui.latestVersion,
          updateAvailable: ui.updateAvailable,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        // Serialization failure — respond with 500 so the client
        // doesn't hang. This guard exists because JSON.stringify
        // can throw on circular references (unlikely here but
        // a defensive principle).
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"ok":false,"error":"internal error"}')
      }
    },
  })
}

export type { PluginConfig } from './types.ts'