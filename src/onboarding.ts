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

/** The registry table on its own, for files we append to but do not own. */
function registryTable(rows: RegistryRow[]): string[] {
  return [
    '| 前缀 | 运行时 | 说明 |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| \`${row.prefix}\` | ${row.runtime} | ${row.note} |`),
  ]
}

/** The writer registry every agent reads on entry. */
export function buildRegistry(vaultPath: string, rows: RegistryRow[]): string {
  return [
    '# 提交前缀登记',
    '',
    `记忆库：\`${vaultPath}\``,
    '',
    ...registryTable(rows),
    '',
    '规则：canonical 笔记只由主 Agent 晋升，其它 Agent 只写 `Agent提交区/`；前缀唯一，不得互相代表。',
    '',
  ].join('\n')
}

/** One registry table row, padded to the table's `columns` so a wider table stays aligned. */
function registryRow(row: RegistryRow, columns = 3): string {
  const cells = [` \`${row.prefix}\` `, ` ${row.runtime} `, ` ${row.note} `]
  while (cells.length < columns) cells.push('  ')
  return `|${cells.join('|')}|`
}

/** The prefix of a table row, or undefined when the line is not one. */
function rowPrefix(line: string): string | undefined {
  return /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1]
}

/** A line's own ending, so a patched line keeps the file's habit. */
function eolOf(line: string): string {
  return line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
}

/** Cells between the outer pipes of a table line, with `\|` kept in one piece. */
function cellsOf(line: string): string[] {
  // GFM lets a row omit its outer pipes. Slicing off both ends unconditionally
  // reads the last cell as a separator and drops what the user typed there.
  const trimmed = line.replace(/\s+$/, '').replace(/(?<!\\)\|$/, '')
  const cells = trimmed.split(/(?<!\\)\|/)
  return trimmed.startsWith('|') ? cells.slice(1) : cells
}

/**
 * Rewrite one row, keeping the cells beyond the three we own.
 *
 * A registry with a fourth column ("状态") is common; writing three cells into
 * it collapses the row and loses whatever the user put there.
 */
function patchRow(line: string, row: RegistryRow, columns: number): string {
  const cells = cellsOf(line)
  // A kept cell may come from a row without an outer pipe, so it does not carry
  // the padding the others do; give it the same shape or the row reads wrong.
  const kept = cells.slice(3).map((cell) => (cell.trim() ? ` ${cell.trim()} ` : cell))
  const written = [` \`${row.prefix}\` `, ` ${row.runtime} `, ` ${row.note} `, ...kept]
  while (written.length < columns) written.push('  ')
  return `|${written.join('|')}|`
}

/**
 * Upsert rows into an existing registry.
 *
 * Two DSH nodes share one vault (`dsh-desktop-`, `dsh-web-`), and other runtimes
 * (codex, claude, …) add their own rows. The registry is a shared file people
 * also edit by hand: prose, extra columns and line endings must survive, so the
 * table is patched in place instead of regenerated, and only the lines we touch
 * are rewritten. Our own prefix is rewritten where it already stands, which
 * keeps the operation idempotent.
 */
export function mergeRegistry(existing: string | undefined, vaultPath: string, rows: RegistryRow[]): string {
  if (!existing) return buildRegistry(vaultPath, rows)
  // Keep every line's own ending: joining the file back together with one EOL
  // turns a one-row fix into a full-file diff in a vault that two machines write.
  const lines = existing.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const header = lines.findIndex((line) => /^\|\s*前缀\s*\|/.test(line))
  if (header < 0) {
    // A registry we cannot parse is not ours to regenerate: replacing the file
    // would delete whatever the user wrote. Keep every line and append a table
    // of our own — the next run finds that header and patches it from then on.
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const head = existing.endsWith('\n') ? existing : `${existing}${eol}`
    const gap = /\r?\n\s*\r?\n$/.test(head) ? '' : eol
    return `${head}${gap}${registryTable(rows).map((line) => `${line}${eol}`).join('')}`
  }
  const eol = eolOf(lines[header] as string) || '\n'
  const columns = Math.max(3, cellsOf(lines[header] as string).length)
  let end = header + 1
  while (end < lines.length && (lines[end] as string).trim().startsWith('|')) end += 1
  // A hand-written table may skip `| --- |`. Counting a separator that is not
  // there makes the first data row read-only, so our own row is appended next
  // to a stale copy instead of being rewritten where it stands.
  const separator = /^\|[\s:|-]+\|?\s*$/.test(lines[header + 1] ?? '')
  const firstRow = header + (separator ? 2 : 1)

  const pending = new Map(rows.map((row) => [row.prefix, row]))
  const seen = new Set<string>()
  // A hand-edited registry can hold our prefix twice. Every occurrence is
  // rewritten to the same content (a stale duplicate would mislead the next
  // agent), but nothing the user wrote is deleted.
  const body = lines.slice(firstRow, end).flatMap((line) => {
    const prefix = rowPrefix(line)
    const row = prefix === undefined ? undefined : pending.get(prefix)
    if (!row || prefix === undefined) return [line]
    seen.add(prefix)
    return [`${patchRow(line, row, columns)}${eolOf(line) || eol}`]
  })
  const head = lines.slice(0, firstRow)
  const missing = [...pending].filter(([prefix]) => !seen.has(prefix))
  if (missing.length) {
    // A table that ends the file often has no final newline; appending then
    // glues our row onto the last one, and that damaged line stays in a file
    // two machines share. The last line of the table may be the header or the
    // separator: a registry that only has those is what a first run finds.
    const preceding = body.length ? body : head
    const last = preceding[preceding.length - 1]
    if (last !== undefined && !eolOf(last)) preceding[preceding.length - 1] = `${last}${eol}`
    for (const [, row] of missing) body.push(`${registryRow(row, columns)}${eol}`)
  }

  return [...head, ...body, ...lines.slice(end)].join('')
}
