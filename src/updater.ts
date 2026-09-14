/**
 * updater — lightweight update checker against the npm registry.
 *
 * Fetches the latest published version from the npm registry at startup
 * and caches the result. The host status endpoint exposes this data so
 * the browser client can show an update badge when a newer version exists.
 *
 * Graceful degradation: network failures or registry unavailability never
 * block plugin loading or throw — they just produce a null latestVersion.
 *
 * @module src/updater
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Types ───────────────────────────────────────────────────────────

export interface UpdateInfo {
  /** Version installed locally (from package.json). */
  currentVersion: string
  /** Latest version on npm registry, or null when check failed/skipped. */
  latestVersion: string | null
  /** Whether a newer version is available (null when unknown). */
  updateAvailable: boolean | null
  /** ISO timestamp of last successful check, or null. */
  checkedAt: string | null
}

// ── Package metadata ────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_PATH = join(HERE, '..', 'package.json')

/** Read the current version from package.json at import time. */
function readCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

// ── Constants ───────────────────────────────────────────────────────

const PKG_NAME = 'dsh-unified-agent-memory'
const NPM_API = `https://registry.npmjs.org/${PKG_NAME}/latest`
const CACHE_TTL_MS = 3_600_000 // 1 hour
const FETCH_TIMEOUT_MS = 5_000

// ── State ───────────────────────────────────────────────────────────

const CURRENT_VERSION = readCurrentVersion()
let cached: UpdateInfo = {
  currentVersion: CURRENT_VERSION,
  latestVersion: null,
  updateAvailable: null,
  checkedAt: null,
}

// ── Compare helpers ─────────────────────────────────────────────────

/**
 * Simple semver comparison (handles x.y.z pre-release).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.replace(/[^0-9.]/g, '').split('.').map(Number)
  const pa = clean(a)
  const pb = clean(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// ── Update checker ──────────────────────────────────────────────────

/**
 * Fire the update check (fire-and-forget — never rejects).
 *
 * Intended to be called once at plugin startup. Subsequent calls within
 * CACHE_TTL_MS are no-ops.
 */
export function checkForUpdate(): void {
  if (cached.checkedAt) {
    const age = Date.now() - new Date(cached.checkedAt).getTime()
    if (age < CACHE_TTL_MS) return // recently checked
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  fetch(NPM_API, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{ version?: string }>
    })
    .then((data) => {
      const latest = data.version ?? null
      const cmp = latest ? compareVersions(latest, CURRENT_VERSION) : 0
      cached = {
        currentVersion: CURRENT_VERSION,
        latestVersion: latest,
        updateAvailable: latest ? cmp > 0 : null,
        checkedAt: new Date().toISOString(),
      }
    })
    .catch(() => {
      // Network failure — keep previous cache (or null if first try).
      // Do not log: registry flakiness is expected and not user-actionable.
    })
    .finally(() => {
      clearTimeout(timer)
    })
}

/**
 * Returns the latest cached update info (synchronous, never throws).
 */
export function getUpdateInfo(): UpdateInfo {
  return { ...cached }
}

/**
 * Reset cached state (for testing only — underscore prefix marks internal).
 */
export function _resetForTesting(): void {
  cached = {
    currentVersion: CURRENT_VERSION,
    latestVersion: null,
    updateAvailable: null,
    checkedAt: null,
  }
}