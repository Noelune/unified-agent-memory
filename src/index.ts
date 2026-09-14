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
 *
 * webServer is NOT in this list because the status route is optional.
 * It is injected dynamically via ctx.inject(['webServer'], ...) below.
 * Without it the plugin still loads — the browser client shows a graceful
 * fallback message when the route is unreachable.
 */
export const inject: readonly string[] = ['tools']

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  const cfg = resolveConfig(config)
  const configured = Boolean(cfg.vaultPath)

  // ---- Register 4 model tools ----
  registerAll(ctx, cfg, configured)

  // ---- Fire-and-forget update check against npm registry ----
  checkForUpdate()

  // ---- Optional HTTP status route (for browser client half) ----
  // The client-ui.js polls /api/dsh-unified-agent-memory/status for
  // configuration and health data. We inject webServer dynamically
  // (not via the static inject array) so the plugin is usable even in
  // headless or mobile environments.
  ctx.inject(['webServer'], () => {
    // cordis ctx.inject() treats the callback's return value as the
    // disposer. webServer.register() returns a cleanup function, so
    // the disposal chain is automatic and leak-free.
    const ws = ctx as unknown as { webServer: { register: (opts: {
      kind: string; path: string;
      handler: (req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }) => void;
    }) => () => void } }
    return ws.webServer.register({
      kind: 'exact',
      path: '/api/dsh-unified-agent-memory/status',
      handler(_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }) {
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
  })
}

export type { PluginConfig } from './types.ts'