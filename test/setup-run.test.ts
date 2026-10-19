import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSetup, type SetupExec, type SetupPlan } from '../src/setup-run.ts'

// Absolute on every platform. The runner derives paths with `join()`, so the
// expectations have to be derived the same way: literal `C:\Vault\50-Agent-Context`
// strings match on Windows and mismatch everywhere else, where `join` yields
// `C:\Vault/50-Agent-Context`. That made this suite a Windows-only one.
const VAULT = join(tmpdir(), 'uam-run-vault')
const HOME = join(tmpdir(), 'uam-run-home')
const CORE = join(tmpdir(), 'uam-run-plug', 'core')
const PYTHON = join(tmpdir(), 'uam-run-python', 'python.exe')
const DEPLOY = join(tmpdir(), 'uam-run-plug', 'setup', 'deploy.py')

function plan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  return {
    vaultPath: VAULT,
    home: HOME,
    corePath: CORE,
    pythonPath: PYTHON,
    deployScript: DEPLOY,
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
  if (args.includes('use')) return 'use'
  if (args.includes('apply')) return 'apply'
  if (args.includes('status')) return 'selfcheck'
  return 'unknown'
}

/**
 * The probes `inspectVault` makes, joined the way it joins them.
 *
 * `withIndex` distinguishes "ready" from "half-built" without the caller
 * spelling out both paths — which is what made the old literals platform-bound.
 */
function structureProbes(vault: string, withIndex: boolean) {
  return (path: string) =>
    path === join(vault, '50-Agent-Context') ||
    (withIndex && path === join(vault, '50-Agent-Context', '上下文索引.md'))
}

describe('runSetup', () => {
  it('inits the vault, deploys instructions, then selfchecks — in that order', async () => {
    const { calls, exec } = recorder()
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => actionOf(call.args))).toEqual(['init', 'apply', 'selfcheck'])
    expect(calls[0]?.args).toEqual(['-m', 'unified_memory.memory', 'init', '--vault', VAULT])
    expect(calls[1]?.args).toEqual([
      DEPLOY,
      'apply',
      '--home',
      HOME,
      '--vault',
      VAULT,
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
    expect(calls[0]?.env.UNIFIED_MEMORY_VAULT).toBe(VAULT)
    expect(calls[2]?.env.UNIFIED_MEMORY_VAULT).toBe(VAULT)
  })

  it('treats a vault as missing when no probe is given', async () => {
    // `SetupDeps.exists` means "absent, assume nothing is there", like readFile.
    // Probing the real disk instead makes the decision depend on the machine:
    // on a box that happens to have this exact vault, setup would pick `use`
    // over `init`, and the init cases would silently stop covering init.
    const { calls, exec } = recorder()
    const here = mkdtempSync(join(tmpdir(), 'uam-run-'))
    try {
      mkdirSync(join(here, '50-Agent-Context'))
      writeFileSync(join(here, '50-Agent-Context', '上下文索引.md'), '# 索引\n')
      await runSetup(plan({ vaultPath: here }), { exec, writeFile: () => {} })
      expect(calls.map((call) => actionOf(call.args))[0]).toBe('init')
    } finally {
      rmSync(here, { recursive: true, force: true })
    }
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
    const exists = structureProbes(VAULT, true)
    const result = await runSetup(plan(), { exec, writeFile: () => {}, exists })
    expect(result.ok).toBe(true)
    // `use` is what persists `vault:` on this path. init is the only other
    // writer, and it is skipped here, so without this call every reader — and
    // the shim, which runs without UNIFIED_MEMORY_VAULT — keeps the old vault.
    expect(calls.map((call) => actionOf(call.args))).toEqual(['use', 'apply', 'selfcheck'])
    expect(calls[0]?.args).toEqual(['-m', 'unified_memory.memory', 'use', '--vault', VAULT])
    expect(calls[0]?.env.UNIFIED_MEMORY_VAULT).toBe(VAULT)
    expect(result.steps[0]).toMatchObject({ name: 'vault', ok: true })
    expect(result.steps[0]?.detail).toContain('复用')
  })

  it('treats a directory without the index as half-built and stops', async () => {
    // Reusing a folder that merely happens to be named 50-Agent-Context would
    // report success while search/show have nothing to read, and init cannot
    // repair it (it refuses an existing structure).
    const { calls, exec } = recorder()
    const exists = structureProbes(VAULT, false)
    const result = await runSetup(plan(), { exec, writeFile: () => {}, exists })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ name: 'vault', ok: false })
    expect(result.steps[0]?.detail).toContain('上下文索引.md')
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
      exists: structureProbes(VAULT, true),
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
    expect(written[0]?.path).toBe(join(HOME, '.unified-memory', 'bin', 'memory'))
    expect(written[0]?.content.startsWith('#!/bin/sh')).toBe(true)
    expect(chmods).toEqual([{ path: join(HOME, '.unified-memory', 'bin', 'memory'), mode: 0o755 }])
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
    // `platform` is pinned instead of inherited: the shim's filename is
    // `memory.cmd` on Windows and `memory` elsewhere, so reading it off
    // process.platform made this assertion a Windows-only one.
    await runSetup(plan(), {
      exec,
      writeFile: (path, content) => written.push({ path, content }),
      platform: 'win32',
    })
    expect(written.map((item) => item.path)).toEqual([
      join(HOME, '.unified-memory', 'bin', 'memory.cmd'),
      join(VAULT, '50-Agent-Context', 'Agent提交区', '前缀登记.md'),
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

  it('says the vault was repointed when only the selfcheck fails', async () => {
    // `vault` already wrote config, so the machine now points here no matter how
    // the rest of the run ends. Reporting only "structure MISSING" would hide
    // that from the user.
    const exec: SetupExec = async (_file, args) =>
      args.includes('status')
        ? { code: 0, stdout: 'vault structure: MISSING', stderr: '' }
        : { code: 0, stdout: 'ok', stderr: '' }
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(false)
    expect(result.steps.at(-1)?.detail).toContain(`已指向 ${VAULT}`)
  })

  it('does not claim a repoint when the vault step itself fails', async () => {
    // Nothing wrote `vault:` yet, so the note would be a lie.
    const exists = (path: string) => path.startsWith(join(VAULT, '50-Agent-Context'))
    const exec: SetupExec = async (_file, args) =>
      actionOf(args) === 'use'
        ? { code: 1, stdout: '', stderr: 'use failed' }
        : { code: 0, stdout: 'ok', stderr: '' }
    const result = await runSetup(plan(), { exec, writeFile: () => {}, exists })
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.detail).toContain('use failed')
    expect(result.steps[0]?.detail).not.toContain('已指向')
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
    expect(result.steps[1]?.detail).toContain(`已指向 ${VAULT}`)
  })
})
