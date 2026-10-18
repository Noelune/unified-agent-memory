/**
 * The one place that actually provisions a machine: vault, instruction
 * sections, PATH shim, prefix registry.
 *
 * Every side effect goes through `SetupDeps`, so the sequence is testable
 * without Python or a filesystem, and `memory_setup` can log each step.
 *
 * The order is idempotent on purpose: a vault that already has a structure is
 * reused rather than re-initialised, and every file written here is compared
 * with what is already on disk first. `apply: true` is therefore safe to repeat
 * after a partial failure — which is the only way a user can recover without
 * hand-editing their home directory.
 *
 * @module src/setup-run
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mergeRegistry, buildShim } from './onboarding.ts'

export type SetupExec = (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>

export interface SetupPlan {
  vaultPath: string
  home: string
  corePath: string
  pythonPath: string
  deployScript: string
  agentName: string
  writeShim: boolean
  writeRegistry: boolean
}

export interface SetupStep {
  name: 'vault' | 'instructions' | 'shim' | 'registry' | 'selfcheck'
  ok: boolean
  detail?: string
}

export interface SetupDeps {
  exec: SetupExec
  writeFile: (path: string, content: string) => void
  /** Existing content, for merge/skip decisions. Absent means "nothing there". */
  readFile?: (path: string) => string | undefined
  /** Existence probe. Absent means "assume it is missing". */
  exists?: (path: string) => boolean
  /** POSIX shims must be executable; Windows has no equivalent. */
  chmod?: (path: string, mode: number) => void
  platform?: NodeJS.Platform
}

export interface SetupResult {
  ok: boolean
  steps: SetupStep[]
}

/** Why a path is or is not a vault this run can reuse. */
export type VaultState = 'missing' | 'incomplete' | 'ready'

/**
 * The single answer to "may I reuse this vault?", used by both the runner and
 * the plan/consent text. A folder named `50-Agent-Context` is not a vault: the
 * readers need `上下文索引.md` inside it, and `init` cannot fill the gap because
 * it refuses a structure that already exists.
 */
export function inspectVault(vaultPath: string, exists: (path: string) => boolean = existsSync): VaultState {
  const structure = join(vaultPath, '50-Agent-Context')
  if (!exists(structure)) return 'missing'
  return exists(join(structure, '上下文索引.md')) ? 'ready' : 'incomplete'
}

/** What a half-built vault means for the user, in one sentence. */
export function halfBuiltVaultDetail(vaultPath: string): string {
  return `${join(vaultPath, '50-Agent-Context')} 已存在但缺少 上下文索引.md，不是完整的记忆库：先移走或改名该目录，再让 setup 重建。`
}

/** Abort on the first failure: a half-configured vault must not be reported as ready. */
export async function runSetup(plan: SetupPlan, deps: SetupDeps): Promise<SetupResult> {
  const steps: SetupStep[] = []
  // `status` (and anything else that resolves the vault itself) reads
  // UNIFIED_MEMORY_VAULT or the core config file — never argv — so the vault
  // under construction is pinned here instead of being inherited from whatever
  // the machine already had configured.
  const pythonEnv = { PYTHONPATH: plan.corePath, UNIFIED_MEMORY_VAULT: plan.vaultPath }
  const platform = deps.platform ?? process.platform

  // `init` refuses to run over an existing vault ("already initialized … use
  // --force"), and --force copies the template over the user's files. A vault
  // that already has the structure is the reuse case the consent text promises,
  // so probe first and skip init entirely.
  const vaultState = inspectVault(plan.vaultPath, (path) => deps.exists?.(path) ?? existsSync(path))
  if (vaultState === 'incomplete') {
    // A folder named 50-Agent-Context is not a vault: without the index the
    // readers have nothing to show, and init cannot fill the gap (it refuses an
    // existing structure). Stop and say so instead of reporting success.
    steps.push({ name: 'vault', ok: false, detail: halfBuiltVaultDetail(plan.vaultPath) })
    return { ok: false, steps }
  }

  if (vaultState === 'ready') {
    // Skipping init must not skip the config write: `vault:` is what every
    // reader and the PATH shim resolve, and nothing else on this path writes it.
    const use = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'use', '--vault', plan.vaultPath], pythonEnv)
    steps.push({ name: 'vault', ok: use.code === 0, detail: failureDetail(use) ?? `复用已存在的记忆库 ${plan.vaultPath}` })
    if (use.code !== 0) return { ok: false, steps }
  } else {
    const vault = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'init', '--vault', plan.vaultPath], pythonEnv)
    steps.push({ name: 'vault', ok: vault.code === 0, detail: failureDetail(vault) })
    if (vault.code !== 0) return { ok: false, steps }
  }

  // Both branches persist `vault:`, so every runtime on the machine now
  // resolves this vault. Say so if a later step fails.
  const repointNote = `；注意：本机默认记忆库(vault:)已指向 ${plan.vaultPath}`

  const instructions = await deps.exec(
    plan.pythonPath,
    [plan.deployScript, 'apply', '--home', plan.home, '--vault', plan.vaultPath],
    { PYTHONPATH: plan.corePath, UNIFIED_MEMORY_VAULT: plan.vaultPath, UNIFIED_MEMORY_AGENT: plan.agentName },
  )
  if (instructions.code !== 0) {
    steps.push({ name: 'instructions', ok: false, detail: `${failureDetail(instructions) ?? `exit ${instructions.code}`}${repointNote}` })
    return { ok: false, steps }
  }
  steps.push({ name: 'instructions', ok: true })

  if (plan.writeShim) {
    const kind = platform === 'win32' ? 'cmd' : 'sh'
    const shimPath = join(plan.home, '.unified-memory', 'bin', kind === 'cmd' ? 'memory.cmd' : 'memory')
    const content = buildShim(kind, plan.corePath, plan.pythonPath)
    if (deps.readFile?.(shimPath) === content) {
      steps.push({ name: 'shim', ok: true, detail: `${shimPath}（内容一致，未改动）` })
    } else {
      deps.writeFile(shimPath, content)
      if (kind === 'sh') deps.chmod?.(shimPath, 0o755)
      steps.push({ name: 'shim', ok: true, detail: shimPath })
    }
  }

  if (plan.writeRegistry) {
    const registryPath = join(plan.vaultPath, '50-Agent-Context', 'Agent提交区', '前缀登记.md')
    const content = mergeRegistry(deps.readFile?.(registryPath), plan.vaultPath, [
      { prefix: `${plan.agentName}-`, runtime: '本机 DSH 运行时', note: '由 memory_setup 生成' },
      // Everything written before prefixes were derived landed under this one.
      { prefix: 'dsh-', runtime: '历史提交', note: '不改名，只认领归属' },
    ])
    if (deps.readFile?.(registryPath) === content) {
      steps.push({ name: 'registry', ok: true, detail: `${registryPath}（内容一致，未改动）` })
    } else {
      deps.writeFile(registryPath, content)
      steps.push({ name: 'registry', ok: true, detail: registryPath })
    }
  }

  const check = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'status'], pythonEnv)
  // `status` prints the structure problem and still exits 0, so the exit code
  // alone would call a broken vault healthy.
  const structureMissing = /vault structure:\s*MISSING/i.test(check.stdout)
  const checkOk = check.code === 0 && !structureMissing
  const problem = structureMissing ? 'vault structure MISSING' : failureDetail(check)
  steps.push({
    name: 'selfcheck',
    ok: checkOk,
    detail: checkOk ? undefined : `${problem ?? `exit ${check.code}`}${repointNote}`,
  })
  return { ok: checkOk, steps }
}

function failureDetail(result: { code: number; stderr: string; stdout: string }): string | undefined {
  if (result.code === 0) return undefined
  const text = String(result.stderr || result.stdout || '').trim()
  return text ? `exit ${result.code}: ${text.slice(0, 400)}` : `exit ${result.code}`
}
