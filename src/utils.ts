/**
 * dsh-unified-agent-memory — shared utilities.
 *
 * Configuration resolution, Python core subprocess runner, output rendering,
 * and degraded-mode messaging. Zero external dependencies (Node stdlib only).
 *
 * @module src/utils
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginConfig, CoreResult, RecallMode } from './types.ts'

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

/**
 * Coerce a config/env value to a boolean.
 *
 * `Boolean(value)` is wrong here: cordis config and environment variables are
 * commonly strings, and `Boolean('false')` is `true` — so `remoteEnabled:
 * 'false'` would silently enable the remote index. Accept the spellings that
 * actually appear in config files and env vars, and treat anything else as
 * "unset" rather than guessing.
 */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === '') return fallback
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
    return fallback
  }
  return fallback
}

/**
 * Coerce a config/env value to an integer within bounds.
 *
 * `Number('')` is `0` and `Number(null)` is `0`, so an absent or blank value is
 * rejected before coercion — otherwise "not set" would silently become the
 * minimum instead of the documented default.
 */
function toInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(min, Math.trunc(n)), max)
}

/** One of the three recall modes, or the fallback for anything unrecognised. */
function toRecallMode(value: unknown, fallback: RecallMode): RecallMode {
  if (typeof value !== 'string') return fallback
  const v = value.trim().toLowerCase()
  return v === 'auto' || v === 'always' || v === 'off' ? v : fallback
}

// ── Configuration ───────────────────────────────────────────────────

/**
 * Path of the core's own config file, mirroring `CONFIG_PATH` in
 * `core/unified_memory/common.py` (`Path.home() / ".unified-memory.yaml"`).
 *
 * The plugin needs this because the core resolves the vault from THREE places,
 * in this order: `UNIFIED_MEMORY_VAULT`, then the `vault:` key in this file,
 * then a built-in default. The plugin used to consult only its own cordis
 * config, so an install that relied on the file — which is exactly what
 * `setup.py init` writes — reported `configured: false` and made every tool
 * answer "not configured" while the HTTP routes happily served live data from
 * the same vault. The console and the agent disagreed about the same machine.
 */
export const CORE_CONFIG_PATH = join(homedir(), '.unified-memory.yaml')

/**
 * Read the `vault:` key from the core's config file, or '' when absent.
 *
 * Deliberately a tiny `key: value` parse rather than a YAML library: this is
 * the same subset `parse_config()` in common.py accepts, the plugin has no YAML
 * dependency, and a malformed file must degrade to "no vault here" instead of
 * throwing during plugin load.
 */
export function readCoreConfigVault(path: string = CORE_CONFIG_PATH): string {
  try {
    const text = readFileSync(path, 'utf-8')
    for (const raw of text.split('\n')) {
      const line = raw.split('#', 1)[0].trim()
      if (!line || !line.includes(':')) continue
      const idx = line.indexOf(':')
      if (line.slice(0, idx).trim() !== 'vault') continue
      return line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
  } catch {
    // Missing or unreadable file is not an error: it just means this source
    // has nothing to contribute, and the next one in the chain decides.
  }
  return ''
}

/**
 * Resolve plugin configuration from cordis config, then env vars.
 *
 * Resolution order for the vault mirrors the core's own precedence so the two
 * cannot disagree: cordis config → `UNIFIED_MEMORY_VAULT` → the core config
 * file's `vault:` key → '' (unconfigured).
 *
 * Every field has a valid fallback, so this never throws.
 */
export function resolveConfig(config: Record<string, unknown> = {}): PluginConfig {
  const env = process.env
  const vaultPath = String(
    config.vaultPath || env.UNIFIED_MEMORY_VAULT || readCoreConfigVault() || '',
  )
  // The agent name is the submission file prefix, i.e. the attribution of every
  // fact this runtime writes. Several DSH runtimes can share one vault (desktop,
  // web, tui, headless…), so the fallback follows DSH_PROFILE — which the host
  // always sets — instead of collapsing them all into "dsh".
  const agentNameSource: PluginConfig['agentNameSource'] = config.agentName
    ? 'config'
    : env.UNIFIED_MEMORY_AGENT
      ? 'env'
      : env.DSH_PROFILE
        ? 'profile'
        : 'fallback'
  const agentName = String(
    config.agentName ||
      env.UNIFIED_MEMORY_AGENT ||
      (env.DSH_PROFILE ? `dsh-${env.DSH_PROFILE}` : 'dsh'),
  )
  return {
    vaultPath,
    agentName,
    agentNameSource,
    pythonPath: String(
      config.pythonPath ?? env.UNIFIED_MEMORY_PYTHON ?? 'python',
    ),
    corePath: String(
      config.corePath ??
        env.UNIFIED_MEMORY_COREPATH ??
        join(HERE, '..', 'core'),
    ),
    remoteEnabled: toBool(config.remoteEnabled ?? env.UNIFIED_MEMORY_REMOTE, false),
    // Automatic recall (the merged discipline layer). Defaults mirror the
    // standalone plugin so an existing user's behaviour does not change when
    // they drop the second package: sensitive-topic gate, 5 entries, 1600
    // chars, 6-character floor, 8s cap, instructions once per session.
    recall: toRecallMode(config.recall ?? env.UNIFIED_MEMORY_RECALL, 'auto'),
    recallLimit: toInt(config.recallLimit, 5, 1, 20),
    recallMaxChars: toInt(config.recallMaxChars, 1600, 200, 20_000),
    recallMinQueryChars: toInt(config.recallMinQueryChars, 6, 0, 200),
    recallTimeoutMs: toInt(config.recallTimeoutMs, 8000, 1000, 60_000),
    recallInstructions: toBool(config.recallInstructions, true),
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

// ── Submit argv builder ─────────────────────────────────────────────

/**
 * Build the argv for `memory submit`.
 *
 * Pure and side-effect free, mirroring buildSearchArgv/buildPreviewArgv. The
 * `--agent` value is the submission file's prefix, so it decides who the facts
 * are attributed to: it must come from config rather than be hardcoded.
 */
export function buildSubmitArgv(cfg: PluginConfig, fact: string): string[] {
  return ['submit', fact, '--agent', cfg.agentName || 'dsh']
}

// ── Preview argv builder ─────────────────────────────────────────────

/** Valid memory_preview views (mirrors core preview.py VIEWS). */
const PREVIEW_VIEWS = new Set(['pending', 'conflicts', 'forgetting', 'recent'])

/**
 * Build the argv for `memory preview` from a view name.
 *
 * Pure and side-effect free, mirroring buildSearchArgv, so the CLI contract is
 * unit-testable without spawning the Python core.
 */
export function buildPreviewArgv(view: string, opts: { limit?: number; json?: boolean } = {}): string[] {
  if (!PREVIEW_VIEWS.has(view)) {
    throw new Error(
      `unknown view "${view}" — choose from ${[...PREVIEW_VIEWS].join(', ')}`,
    )
  }
  const argv = ['preview', view, '--limit', String(opts.limit ?? 20)]
  if (opts.json) argv.push('--json')
  return argv
}

// ── Core execution ───────────────────────────────────────────────────

/**
 * Path to the agent-driven deploy task book (relative to the plugin root).
 * Defined here rather than inlined so it can be tested.
 */
export const DEPLOY_TASKBOOK = join(HERE, '..', 'docs', 'AGENT-DEPLOY.md')

/** Per-invocation overrides for `runCore`. */
export interface RunCoreOptions {
  /** Wall-clock cap. Defaults to `TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * Abort signal from the turn. Without it a cancelled turn leaves the core
   * running until its own timeout expires.
   */
  signal?: AbortSignal
}

/**
 * Run one core CLI invocation via subprocess.
 *
 * Never uses a shell — argv is passed directly to the Python executable.
 * PYTHONPATH is augmented with corePath so the unified_memory package is
 * importable even when not pip-installed.
 *
 * `opts.timeoutMs` exists because the two callers have incompatible budgets: a
 * tool call may reasonably take 25s (it is the user's explicit request), while
 * automatic recall runs before every turn and must not. A single module constant
 * forced the recall path to inherit the tool path's ceiling.
 */
export function runCore(
  cfg: PluginConfig,
  args: string[],
  opts: RunCoreOptions = {},
): Promise<CoreResult> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
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
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true, signal: opts.signal },
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
          } else if (opts.signal?.aborted) {
            // The turn was cancelled before the core answered. Distinct from a
            // timeout: nothing is wrong with the vault or the query.
            kind = 'aborted'
            hint = 'The turn was cancelled while the core was still running; nothing to fix.'
          } else if (err.killed && (err.signal === 'SIGTERM' || err.code === 'ABORT_ERR')) {
            kind = 'timeout'
            hint =
              `Core subprocess timed out after ${timeoutMs}ms. ` +
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
      '1. Call the memory_setup tool. Without apply it only returns the plan (vault path,',
      '   instruction files it would touch, files it would write) — show that to the user;',
      '   with apply=true it provisions everything in one step and needs no restart.',
      `2. Prefer doing it by hand? The deploy task book is ${DEPLOY_TASKBOOK}`,
      '3. Either way, set vaultPath (or UNIFIED_MEMORY_VAULT), then run memory_status.',
    ].join('\n'),
  }
}