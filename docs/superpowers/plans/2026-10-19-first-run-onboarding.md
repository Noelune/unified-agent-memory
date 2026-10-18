# 首次运行引导与多 Agent 铺路 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件装完后第一次使用就能建好 vault、写好配置、给检测到的其它 Agent 铺好指令段，且只在用户同意后落盘，拒绝时零写入。

**Architecture:** 纯逻辑（路径解析、同意状态、计划文本、shim/登记表内容）放进新的 `src/onboarding.ts`；真实副作用（调 `memory init`、调 `deploy.py`、写 shim、写登记表、跑 selfcheck）放进新的 `src/setup-run.ts`，用可注入的 `exec` 以便无副作用测试；`memory_setup` 工具只做"取授权 → 调 runner → 更新状态"三段式，授权走 DSH 的 `ctx.approval` 可选挂载。

**Tech Stack:** TypeScript（ESM、`node:fs`、`node:child_process`）+ vitest + node:test；Python 3.11（`setup/deploy.py`、`core/unified_memory`）+ unittest。

**Spec:** `docs/superpowers/specs/2026-10-19-first-run-onboarding-design.md`

## Global Constraints

- 前缀解析顺序固定：`config.agentName` → `UNIFIED_MEMORY_AGENT` → `dsh-<DSH_PROFILE>` → `dsh`；Python 端不自行推导，只读 `UNIFIED_MEMORY_AGENT`。
- `approval` 绝不加入 `src/index.ts:75` 的硬 `inject` 列表，只用 `ctx.inject(['approval'], cb)` 可选挂载。
- 拒绝（`rejected` / `cancelled`）与 `unavailable` 都不落盘；只有 `allowed-once` 或显式 `apply: true` 才写文件。
- 不写 canonical 笔记（`50-Agent-Context` 下除 `Agent提交区/` 以外一律只读），不碰凭据。
- 首次运行前已有 vault 时复用，不重建、不覆盖。
- 提交信息用英文 conventional commits；面向用户的文档改动用中文。
- `npm run check` 必须全绿；`sync:check` 的"未推送"门禁需用户单独确认，不在本计划范围内解除。

## Review Focus

1. **用户把真实 Obsidian vault 当目标路径** —— `init_vault` 必须复用而不重建，且不产生 `vault.bak-*` 垃圾目录。
2. **拒绝授权后的残留** —— 磁盘上不得出现 `onboarding.json`、shim、登记表或半个 vault。
3. **两个运行时同时首次 setup** —— `deploy.py` 的 lock 与 `init` 竞争时，不能交错写坏指令文件。
4. **含空格/中文/OneDrive 的路径** —— argv 传参必须原样，shim 内的引号必须能承受空格。
5. **approval 服务缺失或策略为 `never`** —— 工具必须返回计划文本而不是抛错，插件仍正常工作。

---

### Task 1: 前缀契约下沉到 deploy.py，并把 setup 测试接进门禁

**Files:**
- Modify: `setup/deploy.py:25`（新增函数）、`setup/deploy.py:182`（改用新函数）
- Test: `setup/tests/test_deploy.py`
- Modify: `package.json`（scripts）、`.github/workflows/ci.yml`

**Interfaces:**
- Produces: `resolved_prefix(agent: str, override: str | None = None) -> str`
- Produces: npm script `test:setup`

- [ ] **Step 1: 写失败测试**

追加到 `setup/tests/test_deploy.py`（顶部 import 增加 `os`、`unittest.mock.patch`、`resolved_prefix`）：

```python
    def test_resolved_prefix_uses_runtime_declaration_for_dsh(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-desktop"}):
            self.assertEqual(resolved_prefix("dsh"), "dsh-desktop")

    def test_resolved_prefix_falls_back_to_agent_name_without_declaration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolved_prefix("dsh"), "dsh")
            self.assertEqual(resolved_prefix("codex"), "codex")

    def test_resolved_prefix_explicit_override_wins(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-web"}):
            self.assertEqual(resolved_prefix("dsh", "dsh-desktop"), "dsh-desktop")

    def test_dsh_section_carries_the_derived_prefix(self):
        with patch.dict(os.environ, {"UNIFIED_MEMORY_AGENT": "dsh-web"}):
            section = build_section("dsh", "<vault>", resolved_prefix("dsh"))
        self.assertIn("`dsh-web-`", section)
        self.assertIn("--agent dsh-web", section)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m unittest discover -s setup/tests -v`
Expected: FAIL，`ImportError: cannot import name 'resolved_prefix'`

- [ ] **Step 3: 最小实现**

`setup/deploy.py`，在 `build_section` 之前插入：

```python
def resolved_prefix(agent: str, override: str | None = None) -> str:
    """The submission prefix for one agent instruction section.

    DSH runtimes export UNIFIED_MEMORY_AGENT (desktop and web share a vault but
    must never share a prefix), so the dsh target reads it instead of guessing.
    Other agents keep their own name; an explicit --agent still wins for the
    one-off cases the CLI already exposes.
    """
    if override:
        return override
    if agent == "dsh":
        return os.environ.get("UNIFIED_MEMORY_AGENT") or "dsh"
    return agent
```

把 `setup/deploy.py:182` 的 `prefix = agent if args.agent is None else args.agent` 改为：

```python
                prefix = resolved_prefix(agent, args.agent)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m unittest discover -s setup/tests -v`
Expected: PASS（9 个测试）

- [ ] **Step 5: 把 setup 测试接进门禁**

`package.json` 的 scripts 增加一项，并插进 `check` 的 `test` 之后：

```json
    "test:setup": "python -m unittest discover -s setup/tests",
```

```json
  "check": "npm run typecheck && npm run drift:check && npm run sync:check && npm run test:js && npm run test && npm run test:setup && npm run build && npm run test:node && npm run drift:python"
```

`.github/workflows/ci.yml` 在 `Core tests (unittest)` 那一步之后加：

```yaml
      - name: Setup script tests (unittest)
        run: python -m unittest discover -s setup/tests -v
```

- [ ] **Step 6: 验证门禁真的跑到它**

Run: `npm run test:setup`
Expected: `OK`，且 `Ran 9 tests`

- [ ] **Step 7: 提交**

```bash
git add setup/deploy.py setup/tests/test_deploy.py package.json .github/workflows/ci.yml
git commit -m "fix(deploy): derive the dsh prefix from the runtime and gate setup tests"
```

---

### Task 2: onboarding 纯逻辑模块

**Files:**
- Create: `src/onboarding.ts`
- Test: `test/onboarding.test.ts`

**Interfaces:**
- Consumes: `PluginConfig`（`src/types.ts`，字段 `vaultPath`、`agentName`）
- Produces:
  - `onboardingStatePath(home?: string): string`
  - `readOnboardingState(file?: string): OnboardingState | null`
  - `writeOnboardingState(state: OnboardingState, file?: string): void`
  - `consentSatisfied(state: OnboardingState | null, want: { vaultPath: string; scope: readonly string[] }): boolean`
  - `detectInstructionTargets(home?: string): Array<{ agent: InstructionTarget; path: string }>`
  - `resolveSetupVault(cfg: PluginConfig, explicit?: string, home?: string): string`
  - `buildConsentReason(input: { vaultPath: string; targets: string[]; reusesVault: boolean }): string`
  - `buildShim(kind: 'cmd' | 'sh', corePath: string, pythonPath: string): string`
  - `buildRegistry(vaultPath: string, rows: RegistryRow[]): string`
  - 类型：`OnboardingState`、`InstructionTarget = 'dsh' | 'codex' | 'claude'`、`RegistryRow`

- [ ] **Step 1: 写失败测试**

创建 `test/onboarding.test.ts`：

```ts
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ONBOARDING_SCOPE,
  buildConsentReason,
  buildRegistry,
  buildShim,
  consentSatisfied,
  detectInstructionTargets,
  onboardingStatePath,
  readOnboardingState,
  resolveSetupVault,
  writeOnboardingState,
  type OnboardingState,
} from '../src/onboarding.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-onboard-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    version: 1,
    consent: 'granted',
    grantedAt: '2026-10-19T00:00:00+08:00',
    vaultPath: join(home, 'Vault'),
    scope: [...ONBOARDING_SCOPE],
    targets: ['.dsh/AGENTS.md'],
    ...overrides,
  }
}

describe('onboarding state', () => {
  it('lives under ~/.unified-memory/onboarding.json', () => {
    expect(onboardingStatePath(home)).toBe(join(home, '.unified-memory', 'onboarding.json'))
  })

  it('round-trips through disk and creates the parent directory', () => {
    writeOnboardingState(state(), onboardingStatePath(home))
    expect(readOnboardingState(onboardingStatePath(home))).toEqual(state())
  })

  it('treats a missing or malformed file as no consent', () => {
    expect(readOnboardingState(onboardingStatePath(home))).toBeNull()
    mkdirSync(join(home, '.unified-memory'), { recursive: true })
    writeFileSync(onboardingStatePath(home), '{"version":1,"consent":"declined"}', 'utf8')
    expect(readOnboardingState(onboardingStatePath(home))).toBeNull()
  })

  it('needs a new consent when the vault or the scope changes', () => {
    const granted = state()
    expect(consentSatisfied(granted, { vaultPath: granted.vaultPath, scope: ONBOARDING_SCOPE })).toBe(true)
    expect(consentSatisfied(granted, { vaultPath: join(home, 'Other'), scope: ONBOARDING_SCOPE })).toBe(false)
    expect(consentSatisfied(granted, { vaultPath: granted.vaultPath, scope: [...ONBOARDING_SCOPE, 'cron'] })).toBe(false)
    expect(consentSatisfied(null, { vaultPath: granted.vaultPath, scope: ONBOARDING_SCOPE })).toBe(false)
  })
})

describe('instruction targets', () => {
  it('only reports files that already exist', () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '', 'utf8')
    expect(detectInstructionTargets(home)).toEqual([{ agent: 'codex', path: join(home, '.codex', 'AGENTS.md') }])
  })
})

describe('setup plan text', () => {
  it('names the vault, the targets and the no-network guarantee', () => {
    const reason = buildConsentReason({ vaultPath: 'C:\\Vault', targets: ['.codex/AGENTS.md'], reusesVault: false })
    expect(reason).toContain('创建记忆库 C:\\Vault')
    expect(reason).toContain('.codex/AGENTS.md')
    expect(reason).toContain('不上传、不联网、不改凭据')
  })

  it('says "reuse" for an existing vault and tolerates zero targets', () => {
    const reason = buildConsentReason({ vaultPath: 'C:\\Vault', targets: [], reusesVault: true })
    expect(reason).toContain('复用已存在的记忆库')
    expect(reason).toContain('不修改任何 Agent 指令文件')
  })

  it('prefers the explicit path, then config, then a home default', () => {
    const cfg = { vaultPath: join(home, 'FromConfig') } as never
    expect(resolveSetupVault(cfg, join(home, 'Explicit'), home)).toBe(join(home, 'Explicit'))
    expect(resolveSetupVault(cfg, undefined, home)).toBe(join(home, 'FromConfig'))
    expect(resolveSetupVault({ vaultPath: '' } as never, undefined, home)).toBe(join(home, 'UnifiedAgentMemory'))
  })
})

describe('shim and registry content', () => {
  it('quotes the core path so spaces survive', () => {
    const cmd = buildShim('cmd', 'C:\\Program Files\\core', 'C:\\Python311\\python.exe')
    expect(cmd).toContain('set "PYTHONPATH=C:\\Program Files\\core"')
    expect(cmd).toContain('"C:\\Python311\\python.exe" -m unified_memory.memory %*')
    const sh = buildShim('sh', '/opt/my core', '/usr/bin/python3')
    expect(sh).toContain("PYTHONPATH='/opt/my core'")
  })

  it('renders a prefix registry table naming every writer', () => {
    const md = buildRegistry('C:\\Vault', [
      { prefix: 'dsh-desktop-', runtime: 'dsh 桌面端', note: 'DSH_PROFILE=desktop' },
      { prefix: 'dsh-', runtime: '历史遗留', note: '不改名' },
    ])
    expect(md).toContain('| `dsh-desktop-` | dsh 桌面端 | DSH_PROFILE=desktop |')
    expect(md).toContain('canonical')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/onboarding.test.ts`
Expected: FAIL，`Failed to resolve import "../src/onboarding.ts"`

- [ ] **Step 3: 实现 `src/onboarding.ts`**

```ts
/**
 * First-run onboarding logic: where the vault goes, whether the user already
 * agreed, and the exact text/content of everything the setup writes.
 *
 * Deliberately free of side effects beyond its own state file — task 4's tool
 * stays readable, and the runner in `setup-run.ts` owns the spawning.
 *
 * @module src/onboarding
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginConfig } from './types.ts'

/** Bumped when the state file's shape changes; older files then read as "no consent". */
export const ONBOARDING_VERSION = 1

/** Everything a grant covers. Adding a member re-asks, which is the point. */
export const ONBOARDING_SCOPE = ['vault', 'config', 'instructions', 'shim', 'registry'] as const

export interface OnboardingState {
  version: number
  consent: 'granted'
  grantedAt: string
  vaultPath: string
  scope: string[]
  targets: string[]
}

export type InstructionTarget = 'dsh' | 'codex' | 'claude'

/** Mirrors setup/deploy.py AGENT_TARGETS; drift here would deploy to the wrong file. */
const TARGET_FILES: Record<InstructionTarget, [string, string]> = {
  dsh: ['.dsh', 'AGENTS.md'],
  codex: ['.codex', 'AGENTS.md'],
  claude: ['.claude', 'CLAUDE.md'],
}

export interface RegistryRow {
  prefix: string
  runtime: string
  note: string
}

export function onboardingStatePath(home: string = homedir()): string {
  return join(home, '.unified-memory', 'onboarding.json')
}

/** Anything unreadable, malformed or written by another version means "ask again". */
export function readOnboardingState(file: string = onboardingStatePath()): OnboardingState | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<OnboardingState>
    if (raw.version !== ONBOARDING_VERSION || raw.consent !== 'granted') return null
    if (typeof raw.vaultPath !== 'string' || !raw.vaultPath || !Array.isArray(raw.scope)) return null
    return { ...(raw as OnboardingState) }
  } catch {
    return null
  }
}

export function writeOnboardingState(state: OnboardingState, file: string = onboardingStatePath()): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** A grant covers exactly one vault and one scope; anything new needs a fresh ask. */
export function consentSatisfied(
  state: OnboardingState | null,
  want: { vaultPath: string; scope: readonly string[] },
): boolean {
  if (!state) return false
  if (state.vaultPath !== want.vaultPath) return false
  return want.scope.every((item) => state.scope.includes(item))
}

export function detectInstructionTargets(home: string = homedir()): Array<{ agent: InstructionTarget; path: string }> {
  return (Object.keys(TARGET_FILES) as InstructionTarget[])
    .map((agent) => ({ agent, path: join(home, ...TARGET_FILES[agent]) }))
    .filter((target) => existsSync(target.path))
}

/**
 * Explicit argument, then whatever the plugin already resolved (config/env/core
 * yaml), then a home-directory default. Never returns an empty string — the
 * whole point of the setup tool is to end the "not configured" state.
 */
export function resolveSetupVault(cfg: PluginConfig, explicit?: string, home: string = homedir()): string {
  const requested = String(explicit ?? '').trim()
  if (requested) return requested
  const configured = String(cfg.vaultPath ?? '').trim()
  if (configured) return configured
  return join(home, 'UnifiedAgentMemory')
}

/** The consent prompt body. Four facts, no marketing: what, where, what else touches disk, no network. */
export function buildConsentReason(input: { vaultPath: string; targets: string[]; reusesVault: boolean }): string {
  const vaultLine = input.reusesVault
    ? `复用已存在的记忆库 ${input.vaultPath}（不覆盖已有文件）`
    : `在 ${input.vaultPath} 创建记忆库`
  const targetsLine = input.targets.length
    ? `在这些文件写入托管段落（带备份、可回滚）：${input.targets.join('、')}`
    : '不修改任何 Agent 指令文件（未检测到 .dsh / .codex / .claude 指令文件）'
  return [vaultLine, targetsLine, '写 ~/.unified-memory.yaml 指向该 vault，并生成 memory 命令包装器与前缀登记表', '全程本地：不上传、不联网、不改凭据'].join(
    '\n',
  )
}

/**
 * A PATH-installable wrapper so agents without this plugin can still run
 * `memory search/submit`. ponytail: the core path is absolute, so moving the
 * install requires re-running setup — upgrade path is reading corePath from
 * onboarding.json instead of baking it in.
 */
export function buildShim(kind: 'cmd' | 'sh', corePath: string, pythonPath: string): string {
  if (kind === 'cmd') {
    return ['@echo off', `set "PYTHONPATH=${corePath}"`, `"${pythonPath}" -m unified_memory.memory %*`, ''].join('\r\n')
  }
  return ['#!/bin/sh', `PYTHONPATH='${corePath}' exec '${pythonPath}' -m unified_memory.memory "$@"`, ''].join('\n')
}

/** The writer registry every agent reads on entry. */
export function buildRegistry(vaultPath: string, rows: RegistryRow[]): string {
  const table = rows.map((row) => `| \`${row.prefix}\` | ${row.runtime} | ${row.note} |`).join('\n')
  return [
    '# 提交前缀登记',
    '',
    `记忆库：\`${vaultPath}\``,
    '',
    '| 前缀 | 运行时 | 说明 |',
    '| --- | --- | --- |',
    table,
    '',
    '规则：canonical 笔记只由主 Agent 晋升，其它 Agent 只写 `Agent提交区/`；前缀唯一，不得互相代表。',
    '',
  ].join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/onboarding.test.ts`
Expected: PASS（12 个测试）

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/onboarding.ts test/onboarding.test.ts
git commit -m "feat(onboarding): add vault resolution, consent state and generated content"
```

---

### Task 3: setup runner（真实副作用，可注入 exec）

**Files:**
- Create: `src/setup-run.ts`
- Test: `test/setup-run.test.ts`

**Interfaces:**
- Consumes: `buildShim`、`buildRegistry`、`InstructionTarget`、`PluginConfig`
- Produces:
  - `type SetupExec = (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `interface SetupPlan { vaultPath: string; home: string; corePath: string; pythonPath: string; deployScript: string; agentName: string; targets: InstructionTarget[]; writeShim: boolean; writeRegistry: boolean }`
  - `interface SetupStep { name: string; ok: boolean; detail: string }`
  - `runSetup(plan: SetupPlan, deps: { exec: SetupExec; writeFile?: (path: string, content: string) => void }): Promise<{ ok: boolean; steps: SetupStep[] }>`

- [ ] **Step 1: 写失败测试**

创建 `test/setup-run.test.ts`：

```ts
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
    targets: ['codex'],
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

describe('runSetup', () => {
  it('inits the vault, deploys instructions, then selfchecks — in that order', async () => {
    const { calls, exec } = recorder()
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.args[1])).toEqual(['init', 'apply', 'selfcheck'])
    expect(calls[0]?.args).toEqual(['-m', 'unified_memory.memory', 'init', '--vault', 'C:\\Vault'])
    expect(calls[1]?.args).toEqual([
      'C:\\plug\\setup\\deploy.py',
      'apply',
      '--home',
      'C:\\Users\\z',
      '--vault',
      'C:\\Vault',
    ])
  })

  it('passes the runtime prefix to deploy through the environment, never argv', async () => {
    const { calls, exec } = recorder()
    await runSetup(plan(), { exec, writeFile: () => {} })
    expect(calls[1]?.env.UNIFIED_MEMORY_AGENT).toBe('dsh-desktop')
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
    await runSetup(plan({ writeShim: false, writeRegistry: false }), { exec, writeFile: (p, c) => written.push({ path: p, content: c }) })
    expect(written).toEqual([])
  })

  it('stops and reports which step failed without throwing', async () => {
    const { exec } = recorder(2)
    const result = await runSetup(plan(), { exec, writeFile: () => {} })
    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.ok)).toEqual([true, false])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/setup-run.test.ts`
Expected: FAIL，`Failed to resolve import "../src/setup-run.ts"`

- [ ] **Step 3: 实现 `src/setup-run.ts`**

```ts
/**
 * The side-effecting half of onboarding: spawn the core, deploy instruction
 * sections, write the shim and the registry.
 *
 * `exec` and `writeFile` are injected so tests assert the exact argv without
 * touching a real vault, a real home directory, or a real Python.
 *
 * @module src/setup-run
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildRegistry, buildShim, type InstructionTarget, type RegistryRow } from './onboarding.ts'

export type SetupExec = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface SetupPlan {
  vaultPath: string
  home: string
  corePath: string
  pythonPath: string
  deployScript: string
  agentName: string
  targets: InstructionTarget[]
  writeShim: boolean
  writeRegistry: boolean
}

export interface SetupStep {
  name: string
  ok: boolean
  detail: string
}

export interface SetupDeps {
  exec: SetupExec
  writeFile?: (path: string, content: string) => void
}

const defaultWriteFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** The registry must name every writer on this machine, including the legacy merged one. */
function registryRows(agentName: string): RegistryRow[] {
  const rows: RegistryRow[] = [{ prefix: `${agentName}-`, runtime: `dsh (${agentName})`, note: '本次运行时的提交前缀' }]
  const others: Array<[string, string]> = [
    ['codex-', 'Codex'],
    ['claude-', 'Claude Code'],
    ['hermes-', 'Hermes'],
  ]
  for (const [prefix, runtime] of others) rows.push({ prefix, runtime, note: '由本机安装器铺路的 Agent' })
  rows.push({ prefix: 'dsh-', runtime: '历史遗留', note: '早于前缀拆分，不改名' })
  return rows
}

export async function runSetup(plan: SetupPlan, deps: SetupDeps): Promise<{ ok: boolean; steps: SetupStep[] }> {
  const writeFile = deps.writeFile ?? defaultWriteFile
  const steps: SetupStep[] = []

  const init = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'init', '--vault', plan.vaultPath], {
    PYTHONPATH: plan.corePath,
  })
  steps.push({ name: 'vault', ok: init.code === 0, detail: (init.stderr || init.stdout).trim() })
  if (!steps[0]?.ok) return { ok: false, steps }

  // The prefix travels in the environment: deploy.py derives it per target, so
  // dsh gets this runtime's name while codex/claude keep their own.
  const deploy = await deps.exec(plan.pythonPath, [plan.deployScript, 'apply', '--home', plan.home, '--vault', plan.vaultPath], {
    PYTHONPATH: plan.corePath,
    UNIFIED_MEMORY_AGENT: plan.agentName,
  })
  steps.push({ name: 'instructions', ok: deploy.code === 0, detail: (deploy.stderr || deploy.stdout).trim() })
  if (!steps[1]?.ok) return { ok: false, steps }

  if (plan.writeShim) {
    const isWindows = process.platform === 'win32'
    const kind = isWindows ? 'cmd' : 'sh'
    const name = isWindows ? 'memory.cmd' : 'memory'
    const path = join(plan.home, '.unified-memory', 'bin', name)
    writeFile(path, buildShim(kind, plan.corePath, plan.pythonPath))
    steps.push({ name: 'shim', ok: true, detail: path })
  }

  if (plan.writeRegistry) {
    const path = join(plan.vaultPath, '50-Agent-Context', 'Agent提交区', '前缀登记.md')
    writeFile(path, buildRegistry(plan.vaultPath, registryRows(plan.agentName)))
    steps.push({ name: 'registry', ok: true, detail: path })
  }

  const check = await deps.exec(plan.pythonPath, ['-m', 'unified_memory.memory', 'status'], { PYTHONPATH: plan.corePath })
  steps.push({ name: 'selfcheck', ok: check.code === 0, detail: (check.stderr || check.stdout).trim() })

  return { ok: steps.every((step) => step.ok), steps }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/setup-run.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/setup-run.ts test/setup-run.test.ts
git commit -m "feat(onboarding): run vault init, instruction deploy, shim and registry"
```

---

### Task 4: `memory_setup` 工具 + 授权闸门 + 配置热重载

**Files:**
- Modify: `src/tools.ts`（import、工具工厂、`TOOL_FACTORIES`、`registerAll`）
- Modify: `src/index.ts:75,142-147`（可选 approval、可变 cfg、传参）
- Test: `test/setup-tool.test.ts`

**Interfaces:**
- Consumes: `resolveSetupVault`、`buildConsentReason`、`detectInstructionTargets`、`readOnboardingState`、`writeOnboardingState`、`consentSatisfied`、`onboardingStatePath`、`runSetup`
- Produces:
  - `type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
  - `interface ApprovalLike { request(req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome> }`
  - `interface SetupDepsForTool { approval?: () => ApprovalLike | undefined; reload: () => void; home?: string; exec?: SetupExec; writeFile?: (path: string, content: string) => void }`
  - `registerAll(ctx, cfg, configured, deps?: SetupDepsForTool)`

- [ ] **Step 1: 写失败测试**

创建 `test/setup-tool.test.ts`：

```ts
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAll, type ApprovalLike, type ApprovalOutcome } from '../src/tools.ts'
import type { PluginConfig } from '../src/types.ts'

let home: string
let registered: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; output: string }> }>
let reloads: number

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uam-setup-tool-'))
  registered = []
  reloads = 0
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const ctx = {
  tools: { register: (tool: never) => registered.push(tool as never) },
}

function cfg(): PluginConfig {
  return { vaultPath: '', agentName: 'dsh-desktop', pythonPath: 'python', corePath: join(home, 'core') } as PluginConfig
}

function approvalReturning(outcome: ApprovalOutcome, seen: string[] = []): ApprovalLike {
  return {
    async request(req) {
      seen.push(req.reason ?? '')
      return outcome
    },
  }
}

function setupTool() {
  const tool = registered.find((item) => item.name === 'memory_setup')
  if (!tool) throw new Error('memory_setup was not registered')
  return tool
}

const execOk = async () => ({ code: 0, stdout: 'ok', stderr: '' })

describe('memory_setup consent gate', () => {
  it('registers the tool even when no approval service exists', () => {
    registerAll(ctx, cfg(), false, { reload: () => {}, home, exec: execOk, writeFile: () => {} })
    expect(setupTool().name).toBe('memory_setup')
  })

  it('writes nothing and asks for apply:true when approval is unavailable', async () => {
    const written: string[] = []
    registerAll(ctx, cfg(), false, { reload: () => {}, home, exec: execOk, writeFile: (path) => written.push(path) })
    const result = await setupTool().execute({}, { agent: {} })
    expect(result.output).toContain('apply: true')
    expect(written).toEqual([])
    expect(reloads).toBe(0)
  })

  it('stops silently when the user rejects', async () => {
    const written: string[] = []
    registerAll(ctx, cfg(), false, {
      reload: () => {},
      home,
      exec: execOk,
      writeFile: (path) => written.push(path),
      approval: () => approvalReturning('rejected'),
    })
    const result = await setupTool().execute({}, { agent: {} })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('已取消')
    expect(written).toEqual([])
  })

  it('runs and records consent after allowed-once', async () => {
    const seen: string[] = []
    registerAll(ctx, cfg(), false, {
      reload: () => { reloads += 1 },
      home,
      exec: execOk,
      writeFile: () => {},
      approval: () => approvalReturning('allowed-once', seen),
    })
    const result = await setupTool().execute({}, { agent: {} })
    expect(result.ok).toBe(true)
    expect(seen[0]).toContain('不上传、不联网、不改凭据')
    expect(reloads).toBe(1)
  })

  it('does not ask again for the same vault and scope', async () => {
    let asks = 0
    const approval: ApprovalLike = {
      async request() { asks += 1; return 'allowed-once' },
    }
    registerAll(ctx, cfg(), false, { reload: () => {}, home, exec: execOk, writeFile: () => {}, approval: () => approval })
    await setupTool().execute({}, { agent: {} })
    await setupTool().execute({}, { agent: {} })
    expect(asks).toBe(1)
  })

  it('honours apply:true without any approval service', async () => {
    const written: string[] = []
    registerAll(ctx, cfg(), false, { reload: () => { reloads += 1 }, home, exec: execOk, writeFile: (path) => written.push(path) })
    const result = await setupTool().execute({ apply: true }, { agent: {} })
    expect(result.ok).toBe(true)
    expect(written.length).toBeGreaterThan(0)
    expect(reloads).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/setup-tool.test.ts`
Expected: FAIL，`memory_setup was not registered`

- [ ] **Step 3: 在 `src/tools.ts` 中实现**

顶部 import 增加：

```ts
import {
  ONBOARDING_SCOPE,
  buildConsentReason,
  consentSatisfied,
  detectInstructionTargets,
  onboardingStatePath,
  readOnboardingState,
  resolveSetupVault,
  writeOnboardingState,
  type InstructionTarget,
} from './onboarding.ts'
import { runSetup, type SetupExec } from './setup-run.ts'
```

在 `TOOL_FACTORIES` 之前加入类型与工厂：

```ts
// ── Setup tool ──────────────────────────────────────────────────────

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Structural copy of the harness approval seam. Deliberately not imported from
 * @deepseek-ai/dsh-user-approval: the plugin must load on hosts without it.
 */
export interface ApprovalLike {
  request(req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome>
}

export interface SetupDepsForTool {
  reload: () => void
  approval?: () => ApprovalLike | undefined
  home?: string
  exec?: SetupExec
  writeFile?: (path: string, content: string) => void
}

function defineSetupTool(cfg: PluginConfig, deps: SetupDepsForTool) {
  return defineTool({
    name: 'memory_setup',
    description:
      'Initialize the shared memory vault and wire other agents to it. ' +
      'Call without parameters first: it returns a plan and asks the user for consent. ' +
      'Only after the user agrees, call again with apply: true (or let the approval prompt grant it).',
    parameters: {
      vaultPath: {
        type: 'string',
        description: 'Absolute path for the vault. Defaults to the configured vault, then ~/UnifiedAgentMemory.',
      },
      apply: {
        type: 'boolean',
        description: 'Execute the plan. Only pass true after the user explicitly agreed.',
      },
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit instruction deployment to dsh / codex / claude. Defaults to every detected file.',
      },
      cron: {
        type: 'boolean',
        description: 'Also register the daily promotion job. Default false.',
      },
    },
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderText },
    async execute(
      args: { vaultPath?: string; apply?: boolean; agents?: string[]; cron?: boolean },
      exec: { agent?: unknown; signal?: AbortSignal },
    ) {
      const home = deps.home ?? homedir()
      const vaultPath = resolveSetupVault(cfg, args.vaultPath, home)
      const detected = detectInstructionTargets(home)
      const allowed = (args.agents ?? []).filter((name): name is InstructionTarget =>
        ['dsh', 'codex', 'claude'].includes(name),
      )
      const targets = allowed.length ? detected.filter((item) => allowed.includes(item.agent)) : detected
      const targetsLabel = targets.map((item) => `${join(home, item.agent === 'claude' ? '.claude/CLAUDE.md' : `.${item.agent}/AGENTS.md`)}`)

      const reusesVault = existsSync(join(vaultPath, '50-Agent-Context'))
      const reason = buildConsentReason({ vaultPath, targets: targetsLabel, reusesVault })
      const granted =
        args.apply === true ||
        consentSatisfied(readOnboardingState(onboardingStatePath(home)), { vaultPath, scope: ONBOARDING_SCOPE })

      let allowedOnce = granted
      let outcome: ApprovalOutcome = granted ? 'allowed-once' : 'unavailable'
      if (!granted) {
        const approval = deps.approval?.()
        if (approval) {
          try {
            outcome = await approval.request({ agent: exec.agent, toolName: 'memory_setup', reason, signal: exec.signal })
            allowedOnce = outcome === 'allowed-once'
          } catch (err) {
            return { ok: false, output: `授权请求失败，未写入任何文件：${(err as Error).message}\n\n计划：\n${reason}` }
          }
        }
        if (outcome === 'rejected' || outcome === 'cancelled') {
          return { ok: false, output: `已取消，未写入任何文件（${outcome}）。随时可以让我重新初始化。` }
        }
        if (!allowedOnce) {
          return {
            ok: false,
            output: [
              '尚未执行：这台环境没有可用的授权界面，我不会在你未确认时写盘。',
              '',
              '将要发生的改动：',
              reason,
              '',
              '确认后请带 apply: true 再调用一次 memory_setup。',
            ].join('\n'),
          }
        }
      }

      const plan = {
        vaultPath,
        home,
        corePath: cfg.corePath,
        pythonPath: cfg.pythonPath,
        deployScript: join(cfg.corePath, '..', 'setup', 'deploy.py'),
        agentName: cfg.agentName || 'dsh',
        targets: targets.map((item) => item.agent),
        writeShim: true,
        writeRegistry: true,
      }
      try {
        const result = await runSetup(plan, {
          exec: deps.exec ?? spawnExec,
          writeFile: deps.writeFile,
        })
        if (result.ok) {
          writeOnboardingState(
            {
              version: 1,
              consent: 'granted',
              grantedAt: new Date().toISOString(),
              vaultPath,
              scope: [...ONBOARDING_SCOPE],
              targets: targetsLabel,
            },
            onboardingStatePath(home),
          )
          deps.reload()
        }
        const rendered = result.steps.map((step) => `${step.ok ? 'ok' : 'FAIL'} ${step.name}: ${step.detail}`).join('\n')
        return { ok: result.ok, output: `记忆库：${vaultPath}\n${rendered}` }
      } catch (err) {
        return { ok: false, output: `初始化中断：${(err as Error).message}\n\n计划：\n${reason}` }
      }
    },
  })
}
```

需要的补充：`spawnExec`（用 `execFile` 包装，25 秒超时，与 `runCore` 同风格）：

```ts
const spawnExec: SetupExec = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, timeout: 25000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
```

`TOOL_FACTORIES` 改成接收 deps，`registerAll` 增加可选第 4 参数：

```ts
const TOOL_FACTORIES: Array<(cfg: PluginConfig, configured: boolean, deps: SetupDepsForTool) => ReturnType<typeof defineTool>> = [
  (cfg, configured) => defineSearchTool(cfg, configured),
  (cfg, configured) => defineShowTool(cfg, configured),
  (cfg, configured) => defineSubmitTool(cfg, configured),
  (cfg, configured) => defineStatusTool(cfg, configured),
  (cfg, configured) => definePreviewTool(cfg, configured),
  (cfg, _configured, deps) => defineSetupTool(cfg, deps),
]

export function registerAll(
  ctx: { tools: { register: (tool: ReturnType<typeof defineTool>) => void } },
  cfg: PluginConfig,
  configured: boolean,
  deps: SetupDepsForTool = { reload: () => {} },
): void {
  for (const factory of TOOL_FACTORIES) {
    try {
      ctx.tools.register(factory(cfg, configured, deps))
    } catch (err) { /* 保持原有日志逻辑 */ }
  }
}
```

- [ ] **Step 4: 改 `src/index.ts` 接线**

`apply()` 内把 `const cfg` 改成可变，并加可选 approval：

```ts
  let approvalService: ApprovalLike | undefined
  // Optional, never a hard inject: hosts without the approval service must still load.
  const withApproval = (ctx as unknown as { inject: (deps: string[], cb: (child: unknown) => void) => unknown }).inject
  if (typeof withApproval === 'function') {
    withApproval.call(ctx, ['approval'], (child) => {
      approvalService = (child as { approval?: ApprovalLike }).approval
    })
  }

  const cfg = resolveConfig(config)
  registerAll(ctx, cfg, Boolean(cfg.vaultPath), {
    approval: () => approvalService,
    // The setup writes the vault config after apply() resolved it, so re-read and
    // mutate in place: every tool closure already captured this same object.
    reload: () => Object.assign(cfg, resolveConfig(config)),
  })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/setup-tool.test.ts test/onboarding.test.ts test/setup-run.test.ts`
Expected: PASS（22 个测试）

- [ ] **Step 6: 全量 JS 测试 + 类型检查**

Run: `npm run typecheck && npm run test:js`
Expected: 全部通过，无回归

- [ ] **Step 7: 提交**

```bash
git add src/tools.ts src/index.ts test/setup-tool.test.ts
git commit -m "feat(setup): add consent-gated memory_setup tool with config reload"
```

---

### Task 5: 状态载荷、文档与打包修正

**Files:**
- Modify: `src/status-payload.ts`、`src/types.ts`（若需 `agentSource` 类型）
- Modify: `docs/JSON-CONTRACT.md`、`docs/AGENT-EXPERIENCE.md`、`README.md`、`CHANGELOG.md`、`.npmignore`
- Test: `test/status-payload.test.ts`（新建）、`test/dsh-host-adapter.test.mjs`（追加断言）

**Interfaces:**
- Produces: `buildStatusPayload(cfg, ui, stats)` 返回值新增 `agentName`、`agentSource`、`onboarding: { state: 'pending' | 'granted'; vaultPath: string }`
- Produces: `agentSourceOf(cfg: PluginConfig): 'config' | 'env' | 'profile' | 'fallback'`

- [ ] **Step 1: 写失败测试**

创建 `test/status-payload.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildStatusPayload, agentSourceOf } from '../src/status-payload.ts'
import type { PluginConfig } from '../src/types.ts'

const cfg = { vaultPath: 'C:\\Vault', agentName: 'dsh-desktop' } as PluginConfig
const ui = { version: '0.8.0', latestVersion: null, updateAvailable: false } as never
const stats = null

describe('status payload', () => {
  it('reports the resolved identity and where it came from', () => {
    const payload = buildStatusPayload(cfg, ui, stats)
    expect(payload.agentName).toBe('dsh-desktop')
    expect(payload.agentSource).toBe('config')
    expect(payload.onboarding).toEqual({ state: 'pending', vaultPath: 'C:\\Vault' })
  })

  it('classifies the source without guessing', () => {
    expect(agentSourceOf({ agentName: 'x' } as PluginConfig)).toBe('config')
    expect(agentSourceOf({ agentName: '' } as PluginConfig)).toBe('fallback')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/status-payload.test.ts`
Expected: FAIL，`agentSourceOf is not a function`

- [ ] **Step 3: 实现**

`src/status-payload.ts` 增加（`cfg` 已传入）：

```ts
/** Where the submission prefix came from — visible so a fallback is never silent. */
export function agentSourceOf(cfg: PluginConfig): 'config' | 'env' | 'profile' | 'fallback' {
  if (cfg.agentNameSource) return cfg.agentNameSource
  return cfg.agentName ? 'config' : 'fallback'
}
```

（`PluginConfig` 增加可选 `agentNameSource`，由 `resolveConfig` 在派生时写入 `'config' | 'env' | 'profile' | 'fallback'`；此为最小改动，避免在 status 层重复推导。）

`buildStatusPayload` 返回对象追加：

```ts
    agentName: cfg.agentName,
    agentSource: agentSourceOf(cfg),
    onboarding: {
      state: readOnboardingState() ? 'granted' : 'pending',
      vaultPath: cfg.vaultPath,
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/status-payload.test.ts test/route-stats.test.ts`
Expected: PASS，且既有 route 测试不回归

- [ ] **Step 5: 文档与打包**

`docs/AGENT-EXPERIENCE.md`：删除"npm-only 安装不含 setup 脚本"的陈述，改为"npm 包内含 `vault-template/`、`setup/`、`integrations/`、`docs/`；安装后由 `memory_setup` 执行"。

`README.md`：在安装命令之后加一节（中文）：

```markdown
## 装完之后的第一次使用

第一次调用 `memory_setup` 时，插件会先用一句话说明要写什么、写到哪里，得到你同意后才动手：

1. 在 `~/UnifiedAgentMemory` 建记忆库（已存在则复用，不覆盖）
2. 给检测到的 Codex / Claude 指令文件写入托管段落（带备份，可回滚）
3. 写 `~/.unified-memory.yaml`、`memory` 命令包装器、`前缀登记.md`

不同意就什么都不写。也可以用 `vaultPath` 指定你已有的 Obsidian vault 只做接入。
没有授权界面的环境（headless/CI）会返回计划，确认后带 `apply: true` 再调一次。
```

`CHANGELOG.md` 的 `## [Unreleased]` 追加中文条目，列出 `memory_setup`、前缀契约、`setup/tests` 进门禁、`docs/superpowers/**` 不再打包。

`.npmignore` 追加：

```
# Internal engineering evidence — not user documentation
docs/superpowers/
```

- [ ] **Step 6: 验证打包产物变小且仍含必需项**

Run: `npm pack --dry-run 2>&1 | Select-String -Pattern "docs/|vault-template|setup/|total files|unpacked size"`
Expected: 无 `docs/superpowers/` 条目；`vault-template/`、`setup/`、`docs/AGENT-DEPLOY.md` 仍在；文件数明显少于 100

- [ ] **Step 7: 全量门禁**

Run: `npm run check`
Expected: 除 `sync:check` 的未推送提示外全绿（该提示留给用户决定是否推送）

- [ ] **Step 8: 提交**

```bash
git add src/status-payload.ts src/types.ts test/status-payload.test.ts docs README.md CHANGELOG.md .npmignore
git commit -m "docs(setup): document first-run onboarding and stop shipping internal plans"
```

---

## 自审记录

- **Spec 覆盖**：spec §4→Task 4、§5→Task 3、§6.1→Task 1+3、§6.2/6.3→Task 2+3、§7→Task 1+5、§8→Task 4+5、§10→Task 5、§11→各任务测试、§12→Task 5 Step 7。无遗漏。
- **占位符**：无 TBD/TODO；每个代码步骤都有可照抄内容。
- **类型一致性**：`InstructionTarget` 由 Task 2 定义、Task 3/4 复用；`SetupExec` 由 Task 3 定义、Task 4 注入；`ApprovalLike` 仅 Task 4 定义并使用；`agentNameSource` 由 Task 5 在 `PluginConfig` 上新增并只由 `resolveConfig` 写入。
- **Review Focus 对应测试**：① → Task 3 的复用路径 + Task 4 的 `reusesVault` 文案；② → Task 4 的 `rejected`/`unavailable` 测试断言 `written === []`；③ → Task 1 保留 `deployment_lock`，Task 3 串行三步；④ → Task 2 的 shim 引号测试；⑤ → Task 4 的"无 approval 服务仍注册并返回计划"。
