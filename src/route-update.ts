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
 * @module src/route-update
 */

/** Path of the mutating route; the client half reads it from `store.ts`. */
export const UPDATE_PATH = '/api/dsh-unified-agent-memory/update'

/** The package this plugin ships as. Must match `package.json` `name`. */
const PKG_NAME = 'dsh-unified-agent-memory'

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

/** The message the host throws when the package is already a dependency. */
const ALREADY_INSTALLED = 'already-installed'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
 * no-op.
 */
export async function applyUpdate(
  pm: PluginManagerLike | undefined,
  source: UpdateSource,
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
  try {
    await pm.installBundle(spec, { saveExact: true })
  } catch (error) {
    const reason = messageOf(error)
    if (!reason.includes(ALREADY_INSTALLED) || typeof pm.removeBundle !== 'function') {
      return { ok: false, status: 'failed', version: null, restartRequired: false, reason }
    }
    try {
      await pm.removeBundle(PKG_NAME)
      await pm.installBundle(spec, { saveExact: true })
    } catch (retryError) {
      return {
        ok: false, status: 'failed', version: null,
        restartRequired: false, reason: messageOf(retryError),
      }
    }
  }

  return {
    ok: true, status: 'installed', version: latest,
    restartRequired: true, reason: null,
  }
}
