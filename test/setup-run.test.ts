import { describe, expect, it } from 'vitest'
import { runSetup, type SetupExec, type SetupPlan } from '../src/setup-run.ts'

function plan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  return {
    vaultPath: 'C:\\Vault',
    home: 'C:\\Users\\z',
    corePath: 'C:\\plug\\core',
    pythonPath: 'C:\\Python311\\python.exe',
    deployScript: 'C:\\plug\\setup\\deploy.py',
    agentName: 'dsh-desktop',
    networkTargets: ['codex'],
    writeShim: true,
    writeRegistry: true,
    ...overrides,
  }
}

function recorder(code = 0) {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
  const exec: SetupExec = async (file, args, env) => {
    calls.push({ file, args, env })
    return { code, stdout: 'ok', stderr: '' }
  }
  return { calls, exec }
}

/** Which core action a recorded call represents, so order assertions stay readable. */
function actionOf(args: string[]): string {
  if (args.includes('init')) return 'init'
  if (args.includes('apply')) return 'apply'
  if (args.includes('status')) return 'selfcheck'
  return 'unknown'
}

describe('runSetup', () => {
  it('inits the vault, deploys instructions, then selfchecks — in that order', async () => {
    const { calls, exec } = recorder()
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => actionOf(call.args))).toEqual(['init', 'apply', 'selfcheck'])
    expect(calls[0]?.args).toEqual(['-m', 'unified_memory.memory', 'init', '--vault', 'C:\\Vault'])
    expect(calls[1]?.args).toEqual([
      'C:\\plug\\setup\\deploy.py',
      'apply',
      '--home',
      'C:\\Users\\z',
      '--vault',
      'C:\\Vault',
    ])
    expect(calls[2]?.args).toEqual(['-m', 'unified_memory.memory', 'status'])
  })

  it('passes the runtime prefix to deploy through the environment, never argv', async () => {
    const { calls, exec } = recorder()
    await runSetup(plan(), { exec, writeFile: () => {} })
    expect(calls[1]?.env.UNIFIED_MEMORY_AGENT).toBe('dsh-desktop')
    expect(calls[1]?.args).not.toContain('dsh-desktop')
  })

  it('writes the shim and registry only when asked', async () => {
    const written: Array<{ path: string; content: string }> = []
    const { exec } = recorder()
    await runSetup(plan(), { exec, writeFile: (path, content) => written.push({ path, content }) })
    expect(written.map((item) => item.path)).toEqual([
      'C:\\Users\\z\\.unified-memory\\bin\\memory.cmd',
      'C:\\Vault\\50-Agent-Context\\Agent提交区\\前缀登记.md',
    ])
    expect(written[0]?.content).toContain('unified_memory.memory')
    expect(written[1]?.content).toContain('dsh-desktop-')

    written.length = 0
    await runSetup(plan({ writeShim: false, writeRegistry: false }), {
      exec,
      writeFile: (path, content) => written.push({ path, content }),
    })
    expect(written).toEqual([])
  })

  it('stops at the failing step and reports it without throwing', async () => {
    const exec: SetupExec = async (_file, args) => {
      const action = actionOf(args)
      return action === 'apply' ? { code: 2, stdout: '', stderr: 'deploy failed' } : { code: 0, stdout: 'ok', stderr: '' }
    }
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ['vault', true],
      ['instructions', false],
    ])
    expect(result.steps[1]?.detail).toContain('deploy failed')
  })
})
