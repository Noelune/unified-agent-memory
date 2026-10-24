/**
 * upgrade-boot — run the reconcile pass at plugin startup.
 *
 * An upgrade that requires the user to remember a command is not a solution to
 * "users forget to do the other three steps": it is the same bug with better
 * documentation. So the pass runs itself, once per version, and it has to do so
 * without becoming a new failure mode.
 *
 * The constraints, and what each one costs:
 *
 *  - **Never blocks load.** It is scheduled, not awaited. A slow `deploy.py`
 *    would otherwise delay the tools and the panel for every user on every
 *    boot, which is a much worse bug than a stale instruction section.
 *  - **Never prompts.** The host's approval service may not exist, and asking
 *    on boot trains users to click "allow" without reading. This pass only
 *    touches artifacts the plugin already owns and already writes during setup
 *    — the same files, the same writer, a new version of the content. The
 *    consent for those was given at setup, for this install, and it does not
 *    evaporate because the content changed.
 *  - **Never writes on a clean install.** A first run with no vault and no
 *    recorded version would otherwise create `~/.unified-memory/bin/memory`
 *    pointing at nothing. When the plan is clean, nothing happens.
 *  - **Never throws into the host.** Any failure is logged at debug level and
 *    dropped: a broken upgrade must not cost the user their tools.
 *
 * What it does NOT do is decide. `planUpgrade` decides; this only wires the
 * probe to the runner and keeps the result readable for the status route.
 *
 * @module src/upgrade-boot
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { PluginConfig } from './types.ts'
import type { UpgradeInfo } from './status-payload.ts'
import { planUpgrade, planNeedsAttention, readUpgradeState, summarizePlan, upgradeStatePath } from './upgrade.ts'
import type { UpgradePlan } from './upgrade.ts'
import { runUpgrade } from './upgrade-run.ts'
import type { UpgradeResult } from './upgrade-run.ts'
import { runCleanup } from './upgrade-cleanup.ts'
import type { CleanupResult } from './upgrade-cleanup.ts'
import { detectInstructionTargets } from './onboarding.ts'

/** Where this build's files are. `lib/` sits beside `core/` in the package. */
const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_ROOT = join(HERE, '..')

/** The last outcome, for the status route and the panel. */
export interface UpgradeReport {
  plan: UpgradePlan
  /** Null while the reconcile has not finished (or was skipped). */
  result: UpgradeResult | null
  /** Hygiene sweep outcome; null before the sweep has run. */
  cleanup: CleanupResult | null
}

let report: UpgradeReport | null = null

/** What the status route reads. Null until the first pass has planned. */
export function getUpgradeReport(): UpgradeReport | null {
  return report === null
    ? null
    : {
        plan: report.plan,
        result: report.result === null ? null : { ...report.result, steps: [...report.result.steps] },
        cleanup: report.cleanup,
      }
}

/** Testing seam: forget the report so a test can observe a fresh pass. */
export function _resetUpgradeForTesting(): void {
  report = null
}

/**
 * The hygiene sweep, kept off the upgrade's critical path.
 *
 * It runs even when the plan is clean — backups and crash temps accumulate
 * *during* a version's life, not only across versions — but its outcome never
 * gates the version record: a locked backup on OneDrive must not re-run the
 * instruction deploy on every boot. Failure information stays in the report.
 */
function sweepCleanup(cfg: PluginConfig, home: string): CleanupResult {
  try {
    return runCleanup({
      home,
      vaultPath: cfg.vaultPath && cfg.vaultPath !== '(not set)' ? cfg.vaultPath : null,
      instructionFiles: detectInstructionTargets(home).map((t) => t.path),
    })
  } catch {
    return { removed: [], failed: [], freedBytes: 0 }
  }
}

/** Build the probe from a config, or null when the pieces are not on disk. */
function probeFor(cfg: PluginConfig, home: string): Parameters<typeof planUpgrade>[0] | null {
  const templateDir = join(INSTALL_ROOT, 'vault-template')
  // A package installed without its template (a partial publish) can still
  // serve tools and the panel; it just cannot add template files. Reporting
  // "no template" as a plan failure would be a lie about the vault.
  const vaultPath = cfg.vaultPath && cfg.vaultPath !== '(not set)' ? cfg.vaultPath : null
  return {
    home,
    corePath: cfg.corePath,
    installPath: INSTALL_ROOT,
    vaultPath,
    templateDir,
    instructionFiles: detectInstructionTargets(home).map((t) => t.path),
    version: String(currentVersion()),
    previous: readUpgradeState(upgradeStatePath(home)),
  }
}

/** Read the running version once; a missing package.json is not fatal. */
let versionCache: string | null = null
function currentVersion(): string {
  if (versionCache !== null) return versionCache
  try {
    const pkg = JSON.parse(readFileSync(join(INSTALL_ROOT, 'package.json'), 'utf8')) as { version?: string }
    versionCache = String(pkg.version ?? '0.0.0')
  } catch {
    versionCache = '0.0.0'
  }
  return versionCache
}

/** `deploy.py`, run with the configured interpreter. */
function deployRunner(cfg: PluginConfig) {
  const script = join(cfg.corePath, '..', 'setup', 'deploy.py')
  return async function apply(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        cfg.pythonPath,
        [script, ...argv],
        {
          env: { ...process.env, PYTHONPATH: cfg.corePath, UNIFIED_MEMORY_AGENT: cfg.agentName },
          timeout: 60_000,
        },
        (error, stdout, stderr) => {
          // A non-zero exit is a *result* here, not an exception: the caller
          // turns it into a failed step and keeps the other steps alive.
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            resolve({ code: 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? String(error)) })
            return
          }
          resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    })
  }
}

/**
 * Plan, and act only if the plan is not clean.
 *
 * Returns the plan so a caller (a test, or the tool) can inspect it without
 * waiting for the write. `await`-ing this from `apply()` would be wrong; see
 * the module comment.
 */
export async function reconcile(cfg: PluginConfig, home: string = homedir()): Promise<UpgradeReport | null> {
  let probe
  try {
    probe = probeFor(cfg, home)
  } catch {
    return null
  }
  if (probe === null) return null

  const plan = planUpgrade(probe)
  report = { plan, result: null, cleanup: null }
  if (plan.clean) {
    // Nothing to reconcile — the sweep still runs: backups and crash temps
    // accumulate during a version's life, not only across versions.
    report.cleanup = sweepCleanup(cfg, home)
    return report
  }

  // A first run on a machine that has never been set up has nothing to
  // reconcile: no vault, no recorded version, no shim, and writing any of them
  // now would pre-empt `memory_setup`'s consent flow. Let setup own that.
  if (plan.fromVersion === null && probe.vaultPath === null && !existsSync(join(home, '.unified-memory'))) {
    report = { plan, result: { ok: true, steps: [{ name: 'state', ok: true, detail: '尚未安装，交由 memory_setup 处理' }] }, cleanup: null }
    return report
  }

  try {
    const result = await runUpgrade({
      home,
      version: plan.toVersion,
      corePath: cfg.corePath,
      installPath: INSTALL_ROOT,
      vaultPath: probe.vaultPath,
      templateDir: probe.templateDir,
      pythonPath: cfg.pythonPath,
      agentName: cfg.agentName,
      deployApply: deployRunner(cfg),
    })
    // Re-plan, so the report describes what is on disk *now* rather than what
    // was there before the pass. Without this the panel keeps showing "shim
    // missing" for a shim this very pass created, alongside `done: true` — the
    // two halves of the same payload contradicting each other.
    //
    // `fromVersion` is carried over from the original plan, because the re-plan
    // reads the record this pass just wrote: it would answer `0.8.1 → 0.8.1`
    // and the transition the user actually went through would be erased from
    // the only place that ever showed it.
    const fresh = replan(cfg, home)
    report = { plan: fresh === null ? plan : { ...fresh, fromVersion: plan.fromVersion }, result, cleanup: null }
  } catch {
    // The runner reports per-step failures itself; this catch is for a throw
    // it did not anticipate, which must not reach the host.
  }
  report.cleanup = sweepCleanup(cfg, home)
  return report
}

/**
 * Plan again after a pass, or null if the disk has become unreadable.
 *
 * `fromVersion` is carried over from the record the pass just wrote, so a
 * successful upgrade reports `0.8.0 → 0.8.1` and not `0.8.1 → 0.8.1`.
 */
function replan(cfg: PluginConfig, home: string): UpgradePlan | null {
  try {
    const fresh = probeFor(cfg, home)
    return fresh === null ? null : planUpgrade(fresh)
  } catch {
    return null
  }
}

/**
 * Whether this process is a test runner.
 *
 * The reason to care: `apply()` is called by unit tests that boot the host
 * half, and its default home is the *real* home directory. Before this guard
 * existed, `npm run check` silently wrote `~/.unified-memory/bin/memory` and
 * `~/.unified-memory/upgrade.json` on the developer's machine — pointing the
 * shim at the source checkout instead of the installed package. A test that
 * writes outside its temp directory is a bug in the test, but a test cannot
 * prevent it on its own: the write is scheduled from inside the module under
 * test. So the module refuses by default.
 */
function isTestProcess(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test'
}

/**
 * Schedule the pass and forget about it.
 *
 * `setImmediate` rather than a timer: the work should start as soon as the
 * current tick ends, and it must not sit behind the plugin's own startup work.
 * The promise is never awaited, so the rejection path is closed explicitly.
 *
 * An explicit `home` means the caller has taken responsibility for where this
 * writes — that is what the tests and any future manual tool pass. Without one,
 * the real home directory is the target in production and the wrong target
 * under a test runner, so the pass is skipped there (see `isTestProcess`).
 */
export function startUpgradeReconcile(cfg: PluginConfig, home?: string): void {
  if (home === undefined && isTestProcess()) return
  const target = home ?? homedir()
  setImmediate(() => {
    void reconcile(cfg, target).catch(() => undefined)
  })
}

/** One-line summary for the panel; null when nothing has been planned yet. */
export function upgradeSummary(): string | null {
  if (report === null) return null
  return summarizePlan(report.plan)
}

/** Whether the report is worth putting in front of the user. */
export function upgradeNeedsAttention(): boolean {
  return report !== null && planNeedsAttention(report.plan)
}

/**
 * The status route's view of the report: only the fields the panel draws.
 *
 * `done` is false in two different situations the client cannot distinguish —
 * the pass is still running, and the pass was skipped because this machine has
 * never been set up. Both render as "checking", which is honest for the first
 * and harmless for the second (setup is what the user would do next anyway).
 * Saying "failed" in either case would be a lie.
 *
 * Three problems max, because the pane is 380px wide and the fourth line is
 * already below the fold. The full list stays in the plan.
 */
export function upgradeInfo(): UpgradeInfo | null {
  const current = report
  if (current === null) return null
  const broken = current.plan.artifacts.filter((a) => a.state !== 'ok')
  return {
    fromVersion: current.plan.fromVersion,
    toVersion: current.plan.toVersion,
    needsAttention: planNeedsAttention(current.plan),
    problems: broken.slice(0, 3).map((a) => `${a.label}：${a.detail}`),
    done: current.result !== null,
  }
}
