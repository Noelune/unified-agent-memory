/**
 * Shared type definitions for dsh-unified-agent-memory.
 *
 * @module src/types
 */

// ── Plugin configuration ─────────────────────────────────────────────

export interface PluginConfig {
  /** Path to the Obsidian vault (required for tools to operate). */
  vaultPath: string
  /** Python interpreter executable (default "python"). */
  pythonPath: string
  /** Path to core/ directory for PYTHONPATH augmentation. */
  corePath: string
  /** Whether the remote index server is enabled. */
  remoteEnabled: boolean
}

// ── Core execution results ───────────────────────────────────────────

export type CoreExitKind = 'ok' | 'timeout' | 'crash' | 'missing'

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