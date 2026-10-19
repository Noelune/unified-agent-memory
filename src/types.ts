/**
 * Shared type definitions for dsh-unified-agent-memory.
 *
 * @module src/types
 */

// ── Plugin configuration ─────────────────────────────────────────────

/** When automatic recall runs before a turn. */
export type RecallMode = 'auto' | 'always' | 'off'

export interface PluginConfig {
  /** Path to the Obsidian vault (required for tools to operate). */
  vaultPath: string
  /** Python interpreter executable (default "python"). */
  pythonPath: string
  /** Path to core/ directory for PYTHONPATH augmentation. */
  corePath: string
  /** Whether the remote index server is enabled. */
  remoteEnabled: boolean
  /**
   * Submission prefix this runtime writes under (`<agentName>-<stamp>-<nn>.md`).
   *
   * Configurable because several DSH runtimes (desktop, web, tui…) can share
   * one vault: with a hardcoded prefix every one of them looked like the same
   * agent. Never empty — resolveConfig always yields a usable name.
   */
  agentName: string
  /**
   * Which input decided `agentName`.
   *
   * Deliberately surfaced in the status payload: a silent `fallback` means the
   * runtime could not tell desktop and web apart, and the user should see that
   * instead of guessing why two machines write under one prefix.
   */
  agentNameSource: 'config' | 'env' | 'profile' | 'fallback'
  /**
   * Automatic pre-turn recall.
   *
   * `auto` searches only when the user's message looks memory-sensitive,
   * `always` searches every turn, `off` disables the hook entirely (the five
   * tools keep working).
   */
  recall: RecallMode
  /** Maximum recall entries per turn. */
  recallLimit: number
  /** Character cap on the injected recall block. */
  recallMaxChars: number
  /** Messages shorter than this are never searched. */
  recallMinQueryChars: number
  /** Wall-clock cap for the recall search, in milliseconds. */
  recallTimeoutMs: number
  /** Inject the discipline rules once per session. */
  recallInstructions: boolean
}

// ── Core execution results ───────────────────────────────────────────

/**
 * How one core invocation ended.
 *
 * `aborted` is separate from `timeout` on purpose: a cancelled turn says nothing
 * about the vault, so callers must not render it as "the core is broken".
 */
export type CoreExitKind = 'ok' | 'timeout' | 'aborted' | 'crash' | 'missing'

/**
 * Result of one Python-core invocation.
 *
 * Declared as a type alias rather than an interface on purpose: every field is
 * JSON-serialisable, and the harness tool contract expects the handler result
 * to satisfy `Record<string, JsonValue>`. TypeScript only infers that implicit
 * index signature for object type aliases, not for interfaces, so an interface
 * here fails assignment at every `tools.register()` call site.
 */
export type CoreResult = {
  ok: boolean
  output: string
  error?: string
  kind?: CoreExitKind
}

// ── Tool output schema ───────────────────────────────────────────────

export type ToolOutput = {
  ok: boolean
  output?: string
  error?: string
}

// ── Document validation ──────────────────────────────────────────────

export type DocValidation =
  | { valid: true }
  | { valid: false; error: string }