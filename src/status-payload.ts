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
 * The reconcile pass's view of the install, as the client needs it.
 *
 * Only what the panel can draw: whether anything needs attention, the version
 * transition, and the broken artifacts by label. The full plan (with details
 * for every artifact, including the healthy ones) stays on the host half —
 * shipping it would triple the payload for text the pane truncates anyway.
 */
export interface UpgradeInfo {
  fromVersion: string | null
  toVersion: string
  needsAttention: boolean
  /** Artifacts that are not `ok`, already turned into sentences. */
  problems: string[]
  /** Null while the pass is still running, or when it never ran. */
  done: boolean
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
  onboarding: { granted: boolean } = { granted: false },
  upgrade: UpgradeInfo | null = null,
) {
  return {
    ok: true,
    configured: Boolean(cfg.vaultPath),
    vaultPath: cfg.vaultPath || '(not set)',
    pythonPath: cfg.pythonPath,
    corePath: cfg.corePath,
    remoteEnabled: cfg.remoteEnabled,
    // The submission prefix and its provenance: two runtimes sharing a vault
    // must be visibly different, and a `fallback` source is a warning sign.
    agentName: cfg.agentName,
    agentSource: cfg.agentNameSource,
    // Automatic recall is the one setting whose failure mode is "nothing
    // happens": with no injected block and no warning, "off" and "nothing
    // matched" look identical from the outside. Publishing the mode and the
    // timeout is what lets a user tell those two apart without reading logs.
    recall: {
      mode: cfg.recall,
      limit: cfg.recallLimit,
      maxChars: cfg.recallMaxChars,
      minQueryChars: cfg.recallMinQueryChars,
      timeoutMs: cfg.recallTimeoutMs,
      instructions: cfg.recallInstructions,
    },
    onboarding,
    version: ui.currentVersion,
    latestVersion: ui.latestVersion,
    updateAvailable: ui.updateAvailable,
    // What the last reconcile pass found. Null before the first pass has
    // planned anything, which is the normal state for a few hundred ms after
    // boot — the client must render "checking", not "failed".
    upgrade: upgrade,
    index: stats ? { ok: Boolean(stats.indexOk) } : null,
    stats: stats
      ? { memories: stats.memories, vectors: stats.vectors, pending: stats.pending }
      : null,
  }
}
