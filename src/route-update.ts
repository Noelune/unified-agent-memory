/**
 * route-update — install the newer version through the host's plugin manager.
 *
 * This route exists because nothing else tells a reader that a release shipped:
 * DSH's own `updateAvailable()` only ever fires for bundles in the official
 * on-demand catalog (`installTarget` is undefined for third-party packages), and
 * the plugin markets still list whatever they last crawled. So the sidebar badge
 * is the only surface that can say "there is a newer version", and this route is
 * what makes that badge actionable instead of decorative.
 *
 * It does NOT run pnpm itself, and it never touches `node_modules`:
 * `pluginManager.installBundle` is the host's own package operation — the same
 * one the Plugins page and `dsh plugin` use. It restores `package.json` and
 * `pnpm-lock.yaml` when a run fails, cancels, or yields no bundle patch, and it
 * reports whether the profile must restart. Reimplementing that here would
 * duplicate a package manager's worth of failure handling badly.
 *
 * Restart: a bundle that has been running since boot cannot be swapped under
 * itself. A successful install therefore always answers `restartRequired: true`
 * — the client says so in as many words rather than implying the panel changed.
 *
 * ## Why the result has to be read, not just awaited
 *
 * `installBundle` folds every failure into its RESOLVED value:
 * `{ changed: false, application: 'failed', error: { code, diagnostic } }`. It
 * does not reject. An earlier version of this route only wrapped the call in
 * `try/catch`, so a pnpm failure that never ran pnpm at all came back as
 * "installed, restart to apply" in ~0.1 s — the badge showed 重启生效, the user
 * restarted, and the version on disk was still the old one. The exact shape is
 * documented by the host's own result schema:
 *
 *     application: 'cancelled' | 'failed' | 'applied' | 'restart-required' | 'overridden'
 *     error?: { code, diagnostic?, incompatible? }
 *
 * So every branch below inspects `application` (treating an absent one as the
 * pre-management-host shape) and, when it says the change landed, confirms the
 * version actually on disk before claiming success.
 *
 * @module src/route-update
 */

/** Path of the mutating route; the client half reads it from `store.ts`. */
export const UPDATE_PATH = '/api/dsh-unified-agent-memory/update'

/** The package this plugin ships as. Must match `package.json` `name`. */
const PKG_NAME = 'dsh-unified-agent-memory'

/**
 * The slice of the host's `pluginManager` install result this route reads.
 *
 * Typed as the documented subset rather than the whole record: the host owns
 * that schema, and pinning the full shape here would turn every host field
 * addition into a compile error in a plugin that only needs four of them.
 */
export interface InstallResultLike {
  /** Saved-and-runtime outcome; absent on hosts predating the field. */
  application?: 'cancelled' | 'failed' | 'applied' | 'restart-required' | 'overridden'
  /** Whether `package.json` / the lockfile actually changed. */
  changed?: boolean
  /** Present when `application` is `failed`; `code` is the actionable part. */
  error?: { code?: string; diagnostic?: string; incompatible?: unknown[] }
  /** The bundle's manifest version after a successful install, when declared. */
  version?: string
}

/**
 * The slice of the host's `pluginManager` service this route uses.
 *
 * Both members are optional because the service is resolved through an optional
 * inject: a host without a plugin manager (headless, CLI) must load this plugin
 * with the route simply answering `unsupported`, not fail at boot.
 */
export interface PluginManagerLike {
  installBundle?: (spec: string, options?: { saveExact?: boolean }) => Promise<unknown>
  removeBundle?: (name: string) => Promise<unknown>
}

/** What the latest known registry reading says, and what is installed now. */
export interface UpdateSource {
  currentVersion: string
  latestVersion: string | null
}

export type UpdateStatus =
  | 'installed'
  | 'up-to-date'
  | 'unsupported'
  | 'unknown-version'
  | 'failed'

export interface UpdateOutcome {
  ok: boolean
  status: UpdateStatus
  /** Version the install targeted; null when nothing was installed. */
  version: string | null
  /** Always true for a real install: the running bundle cannot replace itself. */
  restartRequired: boolean
  /** Why it did not happen, in the host's own words when there is one. */
  reason: string | null
}

/** The `error.code` the host reports when the package is already a dependency. */
const ALREADY_INSTALLED = 'already-installed'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * One sentence for a refused management result.
 *
 * The host distinguishes "the caller stopped it" from "it failed", and a failed
 * run carries `error.code` plus — for anything that is not an expected refusal —
 * the exact diagnostic (pnpm's own words). Reporting the code alone would hide
 * the reason the user needs (`ERR_PNPM_FETCH_404`, a lockfile conflict, a
 * permission error), so the diagnostic goes first and the code labels it.
 */
function refusalOf(result: unknown): { reason: string; code: string | null } | null {
  if (typeof result !== 'object' || result === null) return null
  const record = result as InstallResultLike
  const application = record.application
  if (application === 'failed') {
    const code = typeof record.error?.code === 'string' ? record.error.code : null
    const diagnostic = typeof record.error?.diagnostic === 'string' ? record.error.diagnostic.trim() : ''
    const detail = diagnostic || (code === null ? '' : code)
    return {
      code,
      reason: detail === '' ? '安装失败，宿主没有给出原因' : (code !== null && detail !== code ? `${detail} (${code})` : detail),
    }
  }
  if (application === 'cancelled') return { code: 'cancelled', reason: '安装被取消，已恢复改动前的文件' }
  return null
}

/**
 * What a management result says landed, or null when it says nothing.
 *
 * Returns the bundle's own reported version when the host declares one, so the
 * caller can prefer it over the spec's target.
 */
function installedVersionOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const version = (result as InstallResultLike).version
  return typeof version === 'string' && version !== '' ? version : null
}

/**
 * Install the newer version, or explain why not.
 *
 * Never throws: a route that can 500 on a package-manager error is a route whose
 * failure the panel cannot render. Every branch returns an outcome the client
 * can print.
 *
 * The remove-then-install fallback exists because `installBundle` refuses a spec
 * whose package is already a profile dependency **when HMR is present** — which
 * is the normal case in the desktop app. The official UI handles that refusal the
 * same way (update = remove, then install), and doing anything else here would
 * mean either overwriting files behind the host's back or reporting success on a
 * no-op. The refusal arrives as `error.code === 'already-installed'` OR as a
 * thrown message containing that word, so both are recognised.
 *
 * @param verify - Reads the version now on disk in the profile. When supplied,
 *   a run the host called successful is only reported as installed if this
 *   agrees; when it still reports the old version the answer is `failed`, which
 *   is the whole point of the check (see the module comment). Omit it in hosts
 *   and tests that have no profile to read.
 */
export async function applyUpdate(
  pm: PluginManagerLike | undefined,
  source: UpdateSource,
  verify?: () => string | null,
): Promise<UpdateOutcome> {
  const latest = source.latestVersion
  if (!latest) {
    // The registry was never reached, so there is no version to install. This is
    // NOT the same as "you are current" — the badge would not have been shown.
    return {
      ok: false, status: 'unknown-version', version: null,
      restartRequired: false, reason: '没有读到 registry 上的版本号',
    }
  }
  if (latest === source.currentVersion) {
    return {
      ok: true, status: 'up-to-date', version: latest,
      restartRequired: false, reason: null,
    }
  }
  if (!pm || typeof pm.installBundle !== 'function') {
    return {
      ok: false, status: 'unsupported', version: null,
      restartRequired: false, reason: '宿主的插件管理器不可用，请手动更新',
    }
  }

  const spec = `${PKG_NAME}@${latest}`
  let reported: string | null = null
  try {
    const result = await pm.installBundle(spec, { saveExact: true })
    const refused = refusalOf(result)
    if (refused !== null) {
      if (refused.code !== ALREADY_INSTALLED || typeof pm.removeBundle !== 'function') {
        return { ok: false, status: 'failed', version: null, restartRequired: false, reason: refused.reason }
      }
      await pm.removeBundle(PKG_NAME)
      const retried = await pm.installBundle(spec, { saveExact: true })
      const stillRefused = refusalOf(retried)
      if (stillRefused !== null) {
        return { ok: false, status: 'failed', version: null, restartRequired: false, reason: stillRefused.reason }
      }
      reported = installedVersionOf(retried)
    } else {
      reported = installedVersionOf(result)
    }
  } catch (error) {
    const reason = messageOf(error)
    if (!reason.includes(ALREADY_INSTALLED) || typeof pm.removeBundle !== 'function') {
      return { ok: false, status: 'failed', version: null, restartRequired: false, reason }
    }
    try {
      await pm.removeBundle(PKG_NAME)
      const retried = await pm.installBundle(spec, { saveExact: true })
      const stillRefused = refusalOf(retried)
      if (stillRefused !== null) {
        return { ok: false, status: 'failed', version: null, restartRequired: false, reason: stillRefused.reason }
      }
      reported = installedVersionOf(retried)
    } catch (retryError) {
      return {
        ok: false, status: 'failed', version: null,
        restartRequired: false, reason: messageOf(retryError),
      }
    }
  }

  // The host said the change landed. Confirm it against the profile, because a
  // resolved `installBundle` is a claim, not a fact: the failure that motivated
  // this check answered exactly like a success and left the profile untouched.
  if (verify !== undefined) {
    let onDisk: string | null = null
    try {
      onDisk = verify()
    } catch {
      onDisk = null
    }
    if (onDisk !== null && onDisk !== latest) {
      const stale = onDisk === source.currentVersion
        ? `仍停留在 v${onDisk}`
        : `磁盘上读到的是 v${onDisk}`
      return {
        ok: false, status: 'failed', version: null, restartRequired: false,
        reason: `宿主报告安装成功，但 profile 里的版本${stale}（目标 v${latest}）；请手动安装：dsh plugin add ${spec} --save-exact`,
      }
    }
  }

  return {
    ok: true, status: 'installed', version: reported ?? latest,
    restartRequired: true, reason: null,
  }
}
