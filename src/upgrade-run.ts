/**
 * upgrade-run — apply an `UpgradePlan`. The only place an upgrade writes.
 *
 * Split from `upgrade.ts` for the same reason `setup-run` is split from
 * `onboarding`: the planner is a pure read, and the sequence of side effects
 * has to be injectable so a test can watch it without a real home directory.
 *
 * Three rules, each of which is a user's data:
 *
 *  1. **Nothing is deleted.** Template files are added only when absent; the
 *     registry is merged a row at a time; instruction sections are spliced
 *     between their markers. A vault is the user's notes, not our cache.
 *  2. **Every rewrite is atomic and backed up.** Instruction sections go
 *     through `deploy.py`, which already writes a `.bak-<stamp>` next to the
 *     file and rolls back a failed verification. The shim is written once,
 *     whole, and only when its content or target differs.
 *  3. **A failed step does not stop the others.** A stale shim must not cost
 *     the instruction refresh, and vice versa. Each step reports independently,
 *     so a partial upgrade is visible as "3 of 5" rather than as silence.
 *
 * The version is recorded *last*: if any step fails, the next run still sees
 * the old version and retries the whole reconcile. Writing the version first
 * would mark a half-applied upgrade as done.
 *
 * @module src/upgrade-run
 */

import {
  chmodSync, constants as fsConstants, copyFileSync, existsSync,
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { buildShim, mergeRegistry } from './onboarding.ts'
import type { UpgradeState } from './upgrade.ts'
import { missingTemplateFiles, upgradeStatePath } from './upgrade.ts'

export type UpgradeStepName = 'shim' | 'instructions' | 'vault' | 'registry' | 'state'

export interface UpgradeStep {
  name: UpgradeStepName
  ok: boolean
  /** What was written, or why it was skipped. Shown verbatim. */
  detail: string
}

export interface UpgradeResult {
  ok: boolean
  steps: UpgradeStep[]
}

/** Everything the runner needs; all IO goes through here. */
export interface UpgradeDeps {
  home: string
  version: string
  corePath: string
  installPath: string
  vaultPath: string | null
  templateDir: string
  platform?: NodeJS.Platform
  /** `deploy.py apply` for one target; resolves to the deploy exit code. */
  deployApply: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  pythonPath: string
  /** The agent prefix to register, if a registry write is wanted. */
  agentName: string
  /** Vault template files that `mergeRegistry` should list. */
  now?: () => Date
}

/** Write one file through a temp file, so an interrupted write cannot truncate. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-upgrade`
  writeFileSync(temp, content, 'utf8')
  // rename over an existing file replaces it atomically on every platform we
  // ship to; a half-written temp left by a crash is never read as the real file.
  renameSync(temp, path)
}

/**
 * Add template files that the vault does not have.
 *
 * `COPYFILE_EXCL` is what makes this an add rather than an overwrite: if the
 * user created a file between the check and the copy, that file wins and this
 * call throws. Swallowing the throw is right — "already there" and "unreadable
 * template" both mean the vault keeps working, and neither is worth failing an
 * upgrade for.
 */
function addMissingTemplateFiles(templateDir: string, vaultPath: string): string[] {
  const added: string[] = []
  for (const rel of missingTemplateFiles(templateDir, vaultPath)) {
    const dest = join(vaultPath, rel)
    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(templateDir, rel), dest, fsConstants.COPYFILE_EXCL)
      added.push(rel)
    } catch {
      // Already there, or the template is unreadable. Not a failure.
    }
  }
  return added
}

/** Build a shim. Exported so the runner and its test agree on the bytes. */
export function shimContent(
  kind: 'cmd' | 'sh',
  corePath: string,
  pythonPath: string,
): string {
  return buildShim(kind, corePath, pythonPath)
}

/**
 * Carry out the plan, in the order that minimizes loss.
 *
 * Takes no `UpgradePlan`: every step re-derives its own decision from the disk
 * (`existing !== wanted`, `missingTemplateFiles`, `mergeRegistry` returning its
 * input unchanged). That is deliberate — the plan is a *report* to show the
 * user, and a plan taken between the read and the write could already be stale
 * if something else touched the vault. Since every step is idempotent, running
 * it against the current state is both safer and simpler than replaying a
 * snapshot.
 *
 * Shim first: it is the cheapest and the one whose failure is silent. Vault
 * files before instructions: an instruction file may reference a canonical note
 * that only this step creates. State last: see the module comment.
 */
export async function runUpgrade(deps: UpgradeDeps): Promise<UpgradeResult> {
  const steps: UpgradeStep[] = []
  const changed: string[] = []

  // ---- 1. CLI shim ----
  const kind = (deps.platform ?? process.platform) === 'win32' ? 'cmd' : 'sh'
  const shimPath = join(deps.home, '.unified-memory', 'bin', kind === 'cmd' ? 'memory.cmd' : 'memory')
  const wanted = shimContent(kind, deps.corePath, deps.pythonPath)
  try {
    const existing = existsSync(shimPath) ? readFileSync(shimPath, 'utf8') : null
    if (existing === wanted) {
      steps.push({ name: 'shim', ok: true, detail: '内容一致，未改动' })
    } else {
      writeAtomic(shimPath, wanted)
      if (kind === 'sh') chmodSync(shimPath, 0o755)
      changed.push('shim')
      steps.push({ name: 'shim', ok: true, detail: existing === null ? '已创建' : '已改指当前核心' })
    }
  } catch (error) {
    steps.push({ name: 'shim', ok: false, detail: `写入失败：${errorText(error)}` })
  }

  // ---- 2. Vault template files (add only) ----
  if (deps.vaultPath === null) {
    steps.push({ name: 'vault', ok: true, detail: '未配置 vault，跳过' })
  } else {
    try {
      const added = addMissingTemplateFiles(deps.templateDir, deps.vaultPath)
      if (added.length > 0) changed.push('vault')
      steps.push({
        name: 'vault',
        ok: true,
        detail: added.length === 0 ? '模版文件齐全，未改动' : `补建 ${added.length} 个：${added.slice(0, 3).join('、')}`,
      })
    } catch (error) {
      steps.push({ name: 'vault', ok: false, detail: `补建失败：${errorText(error)}` })
    }
  }

  // ---- 3. Managed instruction sections ----
  // Delegated to deploy.py rather than reimplemented: it owns the marker
  // semantics, the fence/HTML-block masking, the backup naming and the
  // post-write verification. A second implementation here would drift from it.
  try {
    const { code, stdout, stderr } = await deps.deployApply([
      'apply',
      '--home', deps.home,
      '--vault', deps.vaultPath ?? '<your-vault>',
      '--agent', deps.agentName,
    ])
    if (code === 0) {
      changed.push('instructions')
      steps.push({ name: 'instructions', ok: true, detail: summarizeDeploy(stdout) })
    } else {
      steps.push({
        name: 'instructions',
        ok: false,
        detail: (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n')[0],
      })
    }
  } catch (error) {
    steps.push({ name: 'instructions', ok: false, detail: `执行失败：${errorText(error)}` })
  }

  // ---- 4. Prefix registry (merge, never overwrite) ----
  if (deps.vaultPath === null) {
    steps.push({ name: 'registry', ok: true, detail: '未配置 vault，跳过' })
  } else {
    const registryPath = join(deps.vaultPath, '50-Agent-Context', 'Agent提交区', '前缀登记.md')
    try {
      const existed = existsSync(registryPath)
      const existing = existed ? readFileSync(registryPath, 'utf8') : undefined
      const merged = mergeRegistry(existing, deps.vaultPath, [
        { prefix: `${deps.agentName}-`, runtime: '本机 DSH 运行时', note: '由升级流程核对' },
      ])
      if (merged === existing) {
        steps.push({ name: 'registry', ok: true, detail: '内容一致，未改动' })
      } else {
        writeAtomic(registryPath, merged)
        changed.push('registry')
        // `existed` is captured before the write on purpose: asking the disk
        // after `writeAtomic` always answers true, which would report every
        // first creation as a merge.
        steps.push({ name: 'registry', ok: true, detail: existed ? '已合并本端前缀' : '已创建' })
      }
    } catch (error) {
      steps.push({ name: 'registry', ok: false, detail: `写入失败：${errorText(error)}` })
    }
  }

  // ---- 5. Record the version (last, on purpose) ----
  const failed = steps.some((s) => !s.ok)
  if (failed) {
    const missing = steps.filter((s) => !s.ok).map((s) => s.name)
    steps.push({
      name: 'state',
      ok: true,
      detail: `有步骤失败（${missing.join('、')}），版本记录未更新；下次启动会重试。`,
    })
    return { ok: false, steps }
  }
  try {
    const state: UpgradeState = {
      version: deps.version,
      corePath: deps.corePath,
      installPath: deps.installPath,
      appliedAt: (deps.now?.() ?? new Date()).toISOString(),
      changed,
    }
    writeAtomic(upgradeStatePath(deps.home), `${JSON.stringify(state, null, 2)}\n`)
    steps.push({ name: 'state', ok: true, detail: `记录版本 ${deps.version}` })
  } catch (error) {
    steps.push({ name: 'state', ok: false, detail: `写入失败：${errorText(error)}` })
  }

  return { ok: steps.every((s) => s.ok), steps }
}

/**
 * First useful line of deploy output.
 *
 * `deploy.py apply` prints one JSON object per target. Turning that into the
 * count is more useful on a card than the raw blob, and it keeps the panel
 * from rendering a JSON wall at 380px wide.
 */
function summarizeDeploy(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
  if (lines.length === 0) return '已按当前版本重写托管段'
  const written = lines.filter((l) => l.includes('"written": "True"')).length
  return written === 0
    ? `${lines.length} 个指令文件的托管段已是最新`
    : `${written} 个指令文件的托管段已更新（改前有备份）`
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
