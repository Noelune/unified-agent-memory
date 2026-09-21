/**
 * dsh-unified-agent-memory — shared utilities.
 *
 * Configuration resolution, Python core subprocess runner, output rendering,
 * and degraded-mode messaging. Zero external dependencies (Node stdlib only).
 *
 * @module src/utils
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginConfig, CoreResult } from './types.ts'

// ── Paths and constants ──────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))

/** Max bytes the core subprocess can buffer (1 MB). */
export const MAX_OUTPUT = 1024 * 1024

/** Per-invocation timeout for the core subprocess (ms). */
export const TIMEOUT_MS = 25000

/** Defined built-in document short-ids for memory_show. */
const BUILTIN_DOCS = /^(index|prefs|env|rules|tools|ui|coord)$/

/** Pattern for valid *.md note filenames (no path separators). */
const NOTE_FILE = /^[^/\\]+\.md$/i

// ── Configuration ───────────────────────────────────────────────────

/**
 * Resolve plugin configuration from cordis config, then env vars.
 *
 * Resolution order: cordis config key → environment variable → built-in
 * default. Every field has a valid fallback, so this never throws — the
 * caller checks `vaultPath` truthiness to decide whether tools can operate.
 */
export function resolveConfig(config: Record<string, unknown> = {}): PluginConfig {
  const env = process.env
  return {
    vaultPath: String(config.vaultPath ?? env.UNIFIED_MEMORY_VAULT ?? ''),
    pythonPath: String(
      config.pythonPath ?? env.UNIFIED_MEMORY_PYTHON ?? 'python',
    ),
    corePath: String(
      config.corePath ??
        env.UNIFIED_MEMORY_COREPATH ??
        join(HERE, '..', 'core'),
    ),
    remoteEnabled: Boolean(config.remoteEnabled ?? false),
  }
}

/**
 * Quick sanity check for the vault path.
 *
 * Returns null when everything looks fine, or a human-readable warning
 * string when the path is empty or the 50-Agent-Context directory is missing.
 */
export function checkVaultHealth(cfg: PluginConfig): string | null {
  if (!cfg.vaultPath) {
    return 'vaultPath not set — tools will answer with a setup guide'
  }
  const ctxDir = join(cfg.vaultPath, '50-Agent-Context')
  if (!existsSync(ctxDir)) {
    return `50-Agent-Context not found under "${cfg.vaultPath}" — check your vault path`
  }
  return null
}

// ── Document validation ──────────────────────────────────────────────

/**
 * Validate a memory_show document identifier.
 *
 * Accepts built-in short ids (index, prefs, env, rules, tools, ui, coord)
 * or a simple "*.md" filename (no path separators allowed).
 */
export function validateDocId(doc: string): { valid: true } | { valid: false; error: string } {
  if (BUILTIN_DOCS.test(doc) || NOTE_FILE.test(doc)) {
    return { valid: true }
  }
  return {
    valid: false,
    error:
      `unknown document "${doc}" — choose from index, prefs, env, rules, ` +
      'tools, ui, coord, or a *.md note under 50-Agent-Context',
  }
}

// ── Search limit helper ──────────────────────────────────────────────

/**
 * Clamp a search limit into the valid range [1, 50].
 */
export function clampLimit(raw: unknown, fallback = 8): number {
  return Math.min(Math.max(1, Number(raw ?? fallback)), 50)
}

// ── Search argv builder ──────────────────────────────────────────────

export interface SearchOptions {
  limit?: number
  hybrid?: boolean
  format?: string
  budget?: number
}

/** Valid hybrid `--format` values (mirrors core search.py FORMATS). */
const HYBRID_FORMATS = new Set(['full', 'compact', 'narrative'])

/**
 * Build the argv for `memory search` from structured options.
 *
 * Pure and side-effect free so the CLI contract is unit-testable without
 * spawning the Python core. `--remote` is appended separately by the caller
 * (it needs no validation here).
 */
export function buildSearchArgv(query: string, opts: SearchOptions = {}): string[] {
  const argv = ['search', query, '--limit', String(clampLimit(opts.limit))]
  if (opts.hybrid) argv.push('--hybrid')
  if (opts.format && HYBRID_FORMATS.has(opts.format)) {
    argv.push('--format', opts.format)
  }
  if (typeof opts.budget === 'number' && opts.budget > 0) {
    argv.push('--budget', String(opts.budget))
  }
  return argv
}

// ── Core execution ───────────────────────────────────────────────────

/**
 * Path to the agent-driven deploy task book (relative to the plugin root).
 * Defined here rather than inlined so it can be tested.
 */
export const DEPLOY_TASKBOOK = join(HERE, '..', 'docs', 'AGENT-DEPLOY.md')

/**
 * Run one core CLI invocation via subprocess.
 *
 * Never uses a shell — argv is passed directly to the Python executable.
 * PYTHONPATH is augmented with corePath so the unified_memory package is
 * importable even when not pip-installed.
 */
export function runCore(cfg: PluginConfig, args: string[]): Promise<CoreResult> {
  return new Promise((resolvePromise) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (cfg.vaultPath) env.UNIFIED_MEMORY_VAULT = cfg.vaultPath
    if (cfg.corePath) {
      const sep = process.platform === 'win32' ? ';' : ':'
      env.PYTHONPATH = [cfg.corePath, env.PYTHONPATH].filter(Boolean).join(sep)
    }

    const child = execFile(
      cfg.pythonPath,
      ['-m', 'unified_memory.memory', ...args],
      { env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const stderrTail = String(stderr ?? '')
            .trim()
            .split('\n')
            .slice(-3)
            .join('\n')

          let kind: CoreResult['kind'] = 'crash'
          let hint =
            'The Python core ships with this plugin package (corePath ' +
            'defaults to <plugin>/core, auto-added to PYTHONPATH). If it is ' +
            'missing, install it from the repo: pip install -e ./core'

          if (err.code === 'ENOENT') {
            kind = 'missing'
            hint =
              `Python interpreter not found: "${cfg.pythonPath}". ` +
              'Set pythonPath (or UNIFIED_MEMORY_PYTHON env) to your Python 3 executable.'
          } else if (err.killed && err.signal === 'SIGTERM') {
            kind = 'timeout'
            hint =
              `Core subprocess timed out after ${TIMEOUT_MS}ms. ` +
              'Try a more specific query, or check whether the vault index needs rebuilding.'
          }

          resolvePromise({
            ok: false,
            output: '',
            kind,
            error:
              `memory core failed (${err.code ?? 'error'}): ${stderrTail || err.message}\n${hint}`,
          })
          return
        }
        resolvePromise({ ok: true, output: String(stdout ?? '') })
      },
    )

    // Unref so the child doesn't keep the process alive if the parent exits
    // before the subprocess finishes (edge case during harness shutdown).
    child.unref()
  })
}

// ── Output rendering ─────────────────────────────────────────────────

/**
 * Render a tool result as DSH text content block.
 */
export function renderText(
  _args: unknown,
  value: { output?: string } | string,
): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: String(typeof value === 'object' ? value.output ?? value : value) }]
}

// ── Degraded mode ───────────────────────────────────────────────────

/**
 * Build a standard "not configured" response for any tool.
 */
export function notConfigured(action: string): { ok: false; output: string } {
  return {
    ok: false,
    output: [
      `dsh-unified-agent-memory not configured: set vaultPath (${action}).`,
      'Env: UNIFIED_MEMORY_VAULT=<path-to-your-obsidian-vault>',
      '',
      'The Python core ships inside this plugin package (core/ is auto-added',
      'to PYTHONPATH via corePath), so no pip install is needed for the tools.',
      '',
      '[deploy] This looks like a fresh install — complete it now:',
      `1. Read the deploy task book: ${DEPLOY_TASKBOOK}`,
      "2. Wire the shared memory rules into each detected agent's global instruction file.",
      '3. Set vaultPath (or UNIFIED_MEMORY_VAULT) and run memory_status to confirm.',
    ].join('\n'),
  }
}