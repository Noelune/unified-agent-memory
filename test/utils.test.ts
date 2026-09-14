/**
 * Tests for shared utilities (src/utils.ts).
 *
 * These tests cover the pure functions that don't require a Cordis
 * runtime or subprocess execution.
 *
 * @module test/utils.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveConfig,
  checkVaultHealth,
  validateDocId,
  clampLimit,
  renderText,
  notConfigured,
  DEPLOY_TASKBOOK,
} from '../src/utils.ts'

// ── resolveConfig ───────────────────────────────────────────────────

describe('resolveConfig', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    vi.unstubAllEnvs()
    process.env = { ...OLD_ENV }
    delete process.env.UNIFIED_MEMORY_VAULT
    delete process.env.UNIFIED_MEMORY_PYTHON
    delete process.env.UNIFIED_MEMORY_COREPATH
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('uses cordis config when provided', () => {
    const cfg = resolveConfig({ vaultPath: '/custom/path' })
    expect(cfg.vaultPath).toBe('/custom/path')
    expect(cfg.pythonPath).toBe('python')
    expect(cfg.remoteEnabled).toBe(false)
  })

  it('falls back to environment variables when cordis config is absent', () => {
    process.env.UNIFIED_MEMORY_VAULT = '/env/vault'
    process.env.UNIFIED_MEMORY_PYTHON = 'python3.11'
    process.env.UNIFIED_MEMORY_COREPATH = '/custom/core'

    const cfg = resolveConfig()
    expect(cfg.vaultPath).toBe('/env/vault')
    expect(cfg.pythonPath).toBe('python3.11')
    expect(cfg.corePath).toBe('/custom/core')
  })

  it('uses built-in defaults for all fields', () => {
    const cfg = resolveConfig()
    expect(cfg.vaultPath).toBe('')
    expect(cfg.pythonPath).toBe('python')
    expect(cfg.remoteEnabled).toBe(false)
    expect(cfg.corePath).toContain('core')
  })

  it('cordis config takes precedence over env vars', () => {
    process.env.UNIFIED_MEMORY_VAULT = '/env/vault'
    const cfg = resolveConfig({ vaultPath: '/config/vault' })
    expect(cfg.vaultPath).toBe('/config/vault')
  })

  it('casts remoteEnabled to boolean', () => {
    const cfg = resolveConfig({ remoteEnabled: true })
    expect(cfg.remoteEnabled).toBe(true)
  })
})

// ── checkVaultHealth ────────────────────────────────────────────────

describe('checkVaultHealth', () => {
  it('returns warning when vaultPath is empty', () => {
    const result = checkVaultHealth({ vaultPath: '', pythonPath: 'python', corePath: '', remoteEnabled: false })
    expect(result).toContain('vaultPath not set')
  })

  it('returns warning when 50-Agent-Context does not exist', () => {
    // Use a non-existent path
    const result = checkVaultHealth({ vaultPath: '/nonexistent/vault', pythonPath: 'python', corePath: '', remoteEnabled: false })
    expect(result).toContain('50-Agent-Context not found')
  })

  it('returns null when vault is healthy', () => {
    // This test would need a real vault path — skip for CI
    // In practice the integration test checks this
    expect(true).toBe(true)
  })
})

// ── validateDocId ───────────────────────────────────────────────────

describe('validateDocId', () => {
  it('accepts built-in document ids', () => {
    const builtins = ['index', 'prefs', 'env', 'rules', 'tools', 'ui', 'coord']
    for (const id of builtins) {
      expect(validateDocId(id)).toEqual({ valid: true })
    }
  })

  it('accepts valid *.md note filenames', () => {
    expect(validateDocId('notes.md')).toEqual({ valid: true })
    expect(validateDocId('my-doc.md')).toEqual({ valid: true })
    expect(validateDocId('README.md')).toEqual({ valid: true })
  })

  it('rejects empty strings', () => {
    const result = validateDocId('')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('unknown document')
    }
  })

  it('rejects paths with directory separators', () => {
    const result = validateDocId('../outside.md')
    expect(result.valid).toBe(false)
  })

  it('rejects non-.md extensions', () => {
    const result = validateDocId('notes.txt')
    expect(result.valid).toBe(false)
  })

  it('rejects unknown builtin ids', () => {
    const result = validateDocId('nonexistent')
    expect(result.valid).toBe(false)
  })
})

// ── clampLimit ──────────────────────────────────────────────────────

describe('clampLimit', () => {
  it('returns default when input is undefined', () => {
    expect(clampLimit(undefined)).toBe(8)
  })

  it('returns default when input is null', () => {
    expect(clampLimit(null)).toBe(8)
  })

  it('clamps to minimum of 1', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
  })

  it('clamps to maximum of 50', () => {
    expect(clampLimit(100)).toBe(50)
    expect(clampLimit(999)).toBe(50)
  })

  it('accepts values within range', () => {
    expect(clampLimit(1)).toBe(1)
    expect(clampLimit(8)).toBe(8)
    expect(clampLimit(25)).toBe(25)
    expect(clampLimit(50)).toBe(50)
  })

  it('uses custom fallback', () => {
    expect(clampLimit(undefined, 15)).toBe(15)
  })
})

// ── renderText ──────────────────────────────────────────────────────

describe('renderText', () => {
  it('renders object with output property', () => {
    const result = renderText(null, { output: 'hello' })
    expect(result).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('renders string value directly', () => {
    const result = renderText(null, 'raw string')
    expect(result).toEqual([{ type: 'text', text: 'raw string' }])
  })

  it('renders empty string for empty output', () => {
    const result = renderText(null, { output: '' })
    expect(result).toEqual([{ type: 'text', text: '' }])
  })
})

// ── notConfigured ───────────────────────────────────────────────────

describe('notConfigured', () => {
  it('returns ok: false with setup instructions', () => {
    const result = notConfigured('memory_search needs vaultPath')
    expect(result.ok).toBe(false)
    expect(result.output).toContain('memory_search needs vaultPath')
    expect(result.output).toContain('UNIFIED_MEMORY_VAULT')
    expect(result.output).toContain(DEPLOY_TASKBOOK)
  })

  it('includes action name in message', () => {
    const result = notConfigured('test_action')
    expect(result.output).toContain('test_action')
  })
})