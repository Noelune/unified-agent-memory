/**
 * The one place that actually provisions a machine: vault, instruction
 * sections, PATH shim, prefix registry.
 *
 * Every side effect goes through `SetupDeps`, so the sequence is testable
 * without Python or a filesystem, and `memory_setup` can log each step.
 *
 * @module src/setup-run
 */

import { join } from 'node:path'
import { buildRegistry, buildShim } from './onboarding.ts'

export type SetupExec = (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>

export interface SetupPlan {
  vaultPath: string
  home: string
  corePath: string
  pythonPath: string
  deployScript: string
  agentName: string
  /** Targets that will also get the shared-section deploy, in display form. */
  networkTargets: string[]
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
}

export interface SetupResult {
  ok: boolean
  steps: SetupStep[]
}

/** Abort on the first failure: a half-configured vault must not be reported as ready. */
export async function runSetup(plan: SetupPlan, deps: SetupDeps): Promise<SetupResult> {
  const steps: SetupStep[] = []
  // `status` (and anything else that resolves the vault itself) reads
  // UNIFIED_MEMORY_VAULT or the core config file — never argv — so the vault
  // under construction is pinned here instead of being inherited from whatever
  // the machine already had configured.
  const pythonEnv = { PYTHONPATH: plan.corePath, UNIFIED_MEMORY_VAULT: plan.vaultPath }

  const vault = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'init', '--vault', plan.vaultPath], pythonEnv)
  steps.push({ name: 'vault', ok: vault.code === 0, detail: failureDetail(vault) })
  if (vault.code !== 0) return { ok: false, steps }

  const instructions = await deps.exec(
    plan.pythonPath,
    [plan.deployScript, 'apply', '--home', plan.home, '--vault', plan.vaultPath],
    { PYTHONPATH: plan.corePath, UNIFIED_MEMORY_VAULT: plan.vaultPath, UNIFIED_MEMORY_AGENT: plan.agentName },
  )
  steps.push({ name: 'instructions', ok: instructions.code === 0, detail: failureDetail(instructions) })
  if (instructions.code !== 0) return { ok: false, steps }

  if (plan.writeShim) {
    const shimPath = join(plan.home, '.unified-memory', 'bin', 'memory.cmd')
    deps.writeFile(shimPath, buildShim('cmd', plan.corePath, plan.pythonPath))
    steps.push({ name: 'shim', ok: true, detail: shimPath })
  }

  if (plan.writeRegistry) {
    const registryPath = join(plan.vaultPath, '50-Agent-Context', 'Agent提交区', '前缀登记.md')
    deps.writeFile(
      registryPath,
      buildRegistry(plan.vaultPath, [
        { prefix: `${plan.agentName}-`, runtime: '本机 DSH 运行时', note: '由 memory_setup 生成' },
        // Everything written before prefixes were derived landed under this one.
        { prefix: 'dsh-', runtime: '历史提交', note: '不改名，只认领归属' },
      ]),
    )
    steps.push({ name: 'registry', ok: true, detail: registryPath })
  }

  const check = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'status'], pythonEnv)
  steps.push({ name: 'selfcheck', ok: check.code === 0, detail: failureDetail(check) })
  return { ok: check.code === 0, steps }
}

function failureDetail(result: { code: number; stderr: string; stdout: string }): string | undefined {
  if (result.code === 0) return undefined
  const text = String(result.stderr || result.stdout || '').trim()
  return text ? `exit ${result.code}: ${text.slice(0, 400)}` : `exit ${result.code}`
}
