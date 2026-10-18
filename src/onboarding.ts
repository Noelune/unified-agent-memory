/**
 * First-run onboarding logic: where the vault goes, whether the user already
 * agreed, and the exact text/content of everything the setup writes.
 *
 * Deliberately free of side effects beyond its own state file — the tool stays
 * testable without a harness, and `setup-run.ts` owns the spawning.
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

/**
 * What we persist after the user agrees.
 *
 * A type alias, not an interface: the tool contract wants an implicit JSON
 * index signature and TypeScript only infers that for aliases.
 */
export type OnboardingState = {
  version: number
  consent: 'granted'
  grantedAt: string
  vaultPath: string
  scope: string[]
  targets: string[]
}

export type InstructionTarget = 'dsh' | 'codex' | 'claude'

/** Mirrors `AGENT_TARGETS` in setup/deploy.py; drift here would deploy to the wrong file. */
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
  return [
    vaultLine,
    targetsLine,
    '写 ~/.unified-memory.yaml 指向该 vault，并生成 memory 命令包装器与前缀登记表',
    '全程本地：不上传、不联网、不改凭据',
  ].join('\n')
}

/**
 * A PATH-installable wrapper so agents without this plugin can still run
 * `memory search/submit`.
 *
 * ponytail: the core path is absolute, so moving the install requires re-running
 * setup — upgrade path is reading corePath from onboarding.json instead.
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
