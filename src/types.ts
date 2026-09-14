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

export interface CoreResult {
  ok: boolean
  output: string
  error?: string
  kind?: CoreExitKind
}

// ── Tool output schema ───────────────────────────────────────────────

export interface ToolOutput {
  ok: boolean
  output?: string
  error?: string
}

// ── Document validation ──────────────────────────────────────────────

export type DocValidation =
  | { valid: true }
  | { valid: false; error: string }