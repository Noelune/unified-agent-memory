/**
 * catchup-boot — missed-run recovery for the lifecycle schedules, run by dsh.
 *
 * The two OS schedules registered by `setup.py cron` — daily promotion at
 * 03:00 and weekly forgetting Monday 04:00 — fire whether or not an agent is
 * running. When they fire while dsh is offline (machine off/asleep, app
 * closed), the runs are missed and the vault silently stops receiving
 * promotions. dsh is this project's primary lifecycle owner, so the plugin
 * makes "catch up when the agent next comes online" concrete: on boot, and
 * then hourly (a desktop app stays open across schedule boundaries), it asks
 * the Python core what is overdue and lets it replay exactly what the missed
 * cron would have run.
 *
 * The run stamps live in the vault (`50-Agent-Context/调度状态.json`), written
 * by every successful lifecycle run from any entry point. A check with
 * nothing due reads one JSON file and runs nothing, a synced fleet cannot
 * double-run, and a failed catch-up leaves the job due so the next boot
 * retries it — the pass is safe to fire often and to lose.
 *
 * @module src/catchup-boot
 */

import { runCore } from './utils.ts'
import type { PluginConfig } from './types.ts'

/** What the catch-up core invocation must look like, for tests. */
export type CatchupRunner = (
  cfg: PluginConfig,
) => Promise<{ ok: boolean; output: string; error?: string }>

/** Re-check cadence. The stamps make extra checks free; this only bounds how
 * long a missed run can go unnoticed on an app that never restarts. */
const RECHECK_MS = 60 * 60 * 1000

/** Promotion can legitimately take minutes on a big vault; the tool-path
 * 25s ceiling would kill almost every real catch-up. */
const CATCHUP_TIMEOUT_MS = 10 * 60 * 1000

let started = false
let lastLine: string | null = null

function isTestProcess(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test'
}

/** One-line summary of the last pass; null before the first one. */
export function catchupSummary(): string | null {
  return lastLine
}

export function _resetCatchupForTesting(): void {
  started = false
  lastLine = null
}

/** Run `python -m unified_memory.catchup --run --json` via the real core. */
const defaultRunner: CatchupRunner = async (cfg) =>
  runCore(cfg, ['--run', '--json'], {
    module: 'unified_memory.catchup',
    timeoutMs: CATCHUP_TIMEOUT_MS,
  })

async function pass(cfg: PluginConfig, runner: CatchupRunner): Promise<void> {
  try {
    const result = await runner(cfg)
    // The JSON report ends with one line per job; keep the whole stdout tail
    // short so a future panel/log consumer sees the verdict, not the noise.
    lastLine = result.ok
      ? result.output.trim().split('\n').pop() ?? null
      : (result.error ?? 'catch-up failed').split('\n')[0]
  } catch (err) {
    lastLine = `catch-up failed: ${String(err).split('\n')[0]}`
  }
}

/**
 * Start the catch-up pass: once immediately, then hourly. Never awaited, so
 * boot stays as fast as it was; a failure here cannot cost the user their
 * tools. Skipped when the vault is not configured yet (the setup flow is the
 * user's explicit next step) and under a test runner, mirroring the guards
 * `startUpgradeReconcile` uses.
 */
export function startMemoryCatchup(cfg: PluginConfig, runner: CatchupRunner = defaultRunner): void {
  if (started) return
  started = true
  if (!cfg.vaultPath) return
  if (runner === defaultRunner && isTestProcess()) return
  const tick = (): void => {
    void pass(cfg, runner)
  }
  setImmediate(tick)
  const timer = setInterval(tick, RECHECK_MS)
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
}
