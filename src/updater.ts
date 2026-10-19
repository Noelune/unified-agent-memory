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

/**
 * Registries to ask, in order.
 *
 * The canonical registry is tried first, but it is not always reachable — on
 * mainland-China networks `registry.npmjs.org` frequently times out while a
 * mirror answers instantly. The update badge is cosmetic, so it must never be
 * the thing that hangs a session: each attempt shares one short budget and a
 * failure just moves on. `npmmirror` is a full read-through mirror, so the
 * `dist-tags.latest` it reports is the same version.
 */
const REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
] as const

const CACHE_TTL_MS = 3_600_000 // 1 hour
const FETCH_TIMEOUT_MS = 5_000

/**
 * Ask each registry in turn for the latest published version.
 *
 * Returns null when every registry failed or was unreachable — never throws.
 * The shared `signal` bounds the whole sequence, not each request, so a slow
 * first registry cannot extend the total budget.
 */
async function fetchLatestVersion(signal: AbortSignal): Promise<string | null> {
  for (const base of REGISTRIES) {
    if (signal.aborted) return null
    try {
      const res = await fetch(`${base}/${PKG_NAME}/latest`, { signal })
      if (!res.ok) continue
      const data = (await res.json()) as { version?: string }
      if (data.version) return String(data.version)
    } catch {
      // Unreachable, aborted, or malformed — try the next registry.
    }
  }
  return null
}

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
 * Compare two semantic versions by SemVer precedence.
 *
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 *
 * This replaced a comparator that stripped every non-digit with
 * `v.replace(/[^0-9.]/g, '')`, which made `0.6.0-rc.1` and `0.6.0` compare
 * EQUAL — so a user running a pre-release was never told the final release had
 * shipped. The rules implemented here are the SemVer ones that actually matter
 * for npm versions:
 *
 *   - numeric major.minor.patch compared in order;
 *   - a pre-release sorts BELOW its release (`1.0.0-rc.1 < 1.0.0`);
 *   - pre-release identifiers are dot-separated, compared left to right;
 *     numeric identifiers compare numerically and always rank below
 *     alphanumeric ones; a shorter set of identifiers ranks lower when all
 *     preceding ones are equal (`1.0.0-alpha < 1.0.0-alpha.1`);
 *   - build metadata (`+sha`) is ignored, as the spec requires.
 *
 * Implemented inline rather than by adding the `semver` package: this plugin is
 * deliberately dependency-free at runtime, and the subset above is the whole
 * contract the update badge needs.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string) => {
    // Build metadata (`+sha`) is ignored, as SemVer requires — so take only the
    // part before the first '+'.
    const core = String(raw).trim().split('+')[0]
    const [nums, prerelease] = [
      core.split('-')[0],
      core.includes('-') ? core.slice(core.indexOf('-') + 1) : null,
    ]
    const parts = nums.split('.').map((n) => {
      const v = Number.parseInt(n, 10)
      return Number.isFinite(v) ? v : 0
    })
    return { parts, prerelease }
  }

  const pa = parse(a)
  const pb = parse(b)

  const width = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < width; i++) {
    const na = pa.parts[i] ?? 0
    const nb = pb.parts[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }

  // Equal cores: a pre-release precedes the release it belongs to.
  if (pa.prerelease === null && pb.prerelease === null) return 0
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1

  const ia = pa.prerelease.split('.')
  const ib = pb.prerelease.split('.')
  const len = Math.max(ia.length, ib.length)
  for (let i = 0; i < len; i++) {
    const xa = ia[i]
    const xb = ib[i]
    if (xa === undefined) return -1 // shorter identifier list ranks lower
    if (xb === undefined) return 1
    const na = /^\d+$/.test(xa)
    const nb = /^\d+$/.test(xb)
    if (na && nb) {
      const va = Number.parseInt(xa, 10)
      const vb = Number.parseInt(xb, 10)
      if (va !== vb) return va > vb ? 1 : -1
    } else if (na) {
      return -1 // numeric identifiers rank below alphanumeric ones
    } else if (nb) {
      return 1
    } else if (xa !== xb) {
      return xa > xb ? 1 : -1
    }
  }
  return 0
}

// ── Update checker ──────────────────────────────────────────────────

/**
 * Fire the update check (fire-and-forget — never rejects).
 *
 * Intended to be called once at plugin startup, and again on every re-check
 * tick by `startUpdateWatch`. The TTL guard below makes a duplicate call
 * cheap instead of a second request.
 */
export function checkForUpdate(): void {
  if (cached.checkedAt) {
    const age = Date.now() - new Date(cached.checkedAt).getTime()
    if (age < CACHE_TTL_MS) return // recently checked
  }
  runCheck()
}

/**
 * One registry check, with no TTL guard.
 *
 * Split out because the two callers have different notions of "already
 * checked": a startup call wants the guard, the hourly tick *is* the schedule
 * and must not be swallowed by it.
 */
function runCheck(): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  fetchLatestVersion(controller.signal)
    .then((latest) => {
      // No registry answered: keep whatever we already knew (which is null on
      // the first try) rather than overwriting a good reading with "unknown".
      if (latest === null) return
      cached = {
        currentVersion: CURRENT_VERSION,
        latestVersion: latest,
        updateAvailable: compareVersions(latest, CURRENT_VERSION) > 0,
        checkedAt: new Date().toISOString(),
      }
    })
    .catch(() => {
      // Defensive: fetchLatestVersion already swallows its own failures. Do not
      // log — registry flakiness is expected and not user-actionable.
    })
    .finally(() => {
      clearTimeout(timer)
    })
}

/** The slice of a Cordis context this watch needs. */
export interface WatchContext {
  on?: (event: string, handler: () => void) => unknown
}

/**
 * Keep the update state fresh for the life of the plugin.
 *
 * `checkForUpdate()` used to be called exactly once, during `apply()`. The
 * cache had a one-hour TTL, but nothing ever asked again — so a desktop app
 * left open for a week (which is what this plugin lives in) never learned
 * that a release had shipped. The badge was correct and permanently stale.
 *
 * The interval is the schedule; `unref()` keeps a cosmetic poll from being
 * the reason the host process cannot exit. On dispose the timer is cleared,
 * so an unloaded plugin stops asking the registry.
 */
export function startUpdateWatch(ctx?: WatchContext): void {
  checkForUpdate()
  const timer = setInterval(runCheck, CACHE_TTL_MS)
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => clearInterval(timer))
  }
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