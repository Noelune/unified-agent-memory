/**
 * Shape the read-only status payload for the browser half.
 *
 * Split out as a dependency-free module so it is unit-testable without
 * booting Cordis. The route handler in src/index.ts only does the loopback
 * check, reads the live values, and serialises whatever this returns.
 *
 * @module src/status-payload
 */

import type { PluginConfig } from './types.ts'

/** Live counts read from the core, or null when the core could not be read. */
export interface StatusStats {
  memories: number
  vectors: number
  pending: number
  indexOk: boolean
}

/**
 * Version fields owned by the updater's fire-and-forget npm check.
 *
 * `latestVersion` / `updateAvailable` mirror src/updater.ts exactly: both are
 * null until the registry check resolves, and stay null when it could not be
 * reached. Narrowing them to non-null would either lie to the client or force
 * the caller to fabricate a version it never learned.
 */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean | null
}

/**
 * Build the `/status` response body.
 *
 * Always `ok: true` — this describes the host's own state, not the core's.
 * `index` and `stats` are null when the core did not answer, which the client
 * renders as "—" rather than as zeroes (absent is not empty).
 */
export function buildStatusPayload(
  cfg: PluginConfig,
  ui: UpdateInfo,
  stats: StatusStats | null,
) {
  return {
    ok: true,
    configured: Boolean(cfg.vaultPath),
    vaultPath: cfg.vaultPath || '(not set)',
    pythonPath: cfg.pythonPath,
    corePath: cfg.corePath,
    remoteEnabled: cfg.remoteEnabled,
    version: ui.currentVersion,
    latestVersion: ui.latestVersion,
    updateAvailable: ui.updateAvailable,
    index: stats ? { ok: Boolean(stats.indexOk) } : null,
    stats: stats
      ? { memories: stats.memories, vectors: stats.vectors, pending: stats.pending }
      : null,
  }
}
