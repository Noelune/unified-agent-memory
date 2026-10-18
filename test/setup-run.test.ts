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

  it('pins every core call to the vault being provisioned', async () => {
    // `status` resolves the vault from the environment or the core config file,
    // not from argv. Without this the selfcheck inspects whatever vault the
    // machine happened to have configured — it passed on a dev box and would
    // fail (or worse, silently pass) on a fresh install.
    const { calls, exec } = recorder()
    await runSetup(plan(), { exec, writeFile: () => {} })
    expect(calls[0]?.env.UNIFIED_MEMORY_VAULT).toBe('C:\\Vault')
    expect(calls[2]?.env.UNIFIED_MEMORY_VAULT).toBe('C:\\Vault')
  })

  it('passes the runtime prefix to deploy through the environment, never argv', async () => {
    const { calls, exec } = recorder()
    await runSetup(plan(), { exec, writeFile: () => {} })
    expect(calls[1]?.env.UNIFIED_MEMORY_AGENT).toBe('dsh-desktop')
    expect(calls[1]?.args).not.toContain('dsh-desktop')
  })

  it('reuses a vault that is already initialised instead of running init', async () => {
    // `init` refuses an existing vault ("already initialized … use --force") and
    // --force copies the template over the user's notes. Pointing setup at an
    // existing Obsidian vault is the advertised reuse case, and the 0.8.0
    // upgrade case, so it must skip init entirely.
    const { calls, exec } = recorder()
    const exists = (path: string) => path === 'C:\\Vault\\50-Agent-Context'
    const result = await runSetup(plan(), { exec, writeFile: () => {}, exists })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => actionOf(call.args))).toEqual(['apply', 'selfcheck'])
    expect(result.steps[0]).toMatchObject({ name: 'vault', ok: true })
    expect(result.steps[0]?.detail).toContain('复用')
  })

  it('merges the registry so other agents keep their rows', async () => {
    const existing = [
      '# 提交前缀登记',
      '',
      '| 前缀 | 运行时 | 说明 |',
      '| --- | --- | --- |',
      '| `dsh-web-` | web | 浏览器端 |',
      '| `codex-` | codex | 手动登记 |',
      '',
    ].join('\n')
    const written: Array<{ path: string; content: string }> = []
    const { exec } = recorder()
    await runSetup(plan(), {
      exec,
      writeFile: (path, content) => written.push({ path, content }),
      readFile: (path) => (path.includes('前缀登记') ? existing : undefined),
      exists: (path) => path === 'C:\\Vault\\50-Agent-Context',
    })
    const registry = written.find((item) => item.path.includes('前缀登记'))
    expect(registry?.content).toContain('`dsh-web-`')
    expect(registry?.content).toContain('`codex-`')
    expect(registry?.content).toContain('`dsh-desktop-`')
  })

  it('leaves a shim or registry that already matches alone', async () => {
    const written: string[] = []
    const { exec } = recorder()
    // First run: record what would be written.
    const captured: Record<string, string> = {}
    await runSetup(plan(), {
      exec,
      writeFile: (path, content) => {
        captured[path] = content
      },
    })
    // Second run: everything matches, so nothing is rewritten.
    await runSetup(plan(), {
      exec,
      writeFile: (path) => written.push(path),
      readFile: (path) => captured[path],
    })
    expect(written).toEqual([])
  })

  it('writes a POSIX shim and makes it executable off Windows', async () => {
    const written: Array<{ path: string; content: string }> = []
    const chmods: Array<{ path: string; mode: number }> = []
    const { exec } = recorder()
    await runSetup(plan(), {
      exec,
      writeFile: (path, content) => written.push({ path, content }),
      chmod: (path, mode) => chmods.push({ path, mode }),
      platform: 'linux',
    })
    expect(written[0]?.path).toBe('C:\\Users\\z\\.unified-memory\\bin\\memory')
    expect(written[0]?.content.startsWith('#!/bin/sh')).toBe(true)
    expect(chmods).toEqual([{ path: 'C:\\Users\\z\\.unified-memory\\bin\\memory', mode: 0o755 }])
  })

  it('fails the selfcheck when the core reports a missing vault structure', async () => {
    // `memory status` prints the problem and still exits 0, so the exit code
    // alone would call a broken vault healthy.
    const { exec } = recorder()
    const statusExec: SetupExec = async (file, args, env) => {
      const result = await exec(file, args, env)
      return args.includes('status')
        ? { ...result, stdout: 'vault structure: MISSING (50-Agent-Context not found)' }
        : result
    }
    const result = await runSetup(plan(), { exec: statusExec, writeFile: () => {} })
    expect(result.ok).toBe(false)
    expect(result.steps.at(-1)).toMatchObject({ name: 'selfcheck', ok: false })
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
    // Init already repointed the machine's default vault; the failure has to say so.
    expect(result.steps[1]?.detail).toContain('已指向 C:\\Vault')
  })
})
