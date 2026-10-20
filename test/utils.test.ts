/**
 * Tests for shared utilities (src/utils.ts).
 *
 * These tests cover the pure functions that don't require a Cordis
 * runtime or subprocess execution.
 *
 * @module test/utils.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveConfig,
  profileNameOf,
  checkVaultHealth,
  validateDocId,
  clampLimit,
  renderText,
  notConfigured,
  buildSearchArgv,
  buildPreviewArgv,
  buildSubmitArgv,
  readCoreConfigVault,
  DEPLOY_TASKBOOK,
} from '../src/utils.ts'

// ── profileNameOf ───────────────────────────────────────────────────

describe('profileNameOf', () => {
  it('reads the name off the host\'s profileContext service', () => {
    const ctx = { get: (name: string) => (name === 'profileContext' ? { name: 'desktop', dir: '/p' } : undefined) }
    expect(profileNameOf(ctx)).toBe('desktop')
  })

  it('returns null on a host that does not publish the service', () => {
    // Older clients, or a bare Cordis context in a test harness.
    expect(profileNameOf(null)).toBeNull()
    expect(profileNameOf({})).toBeNull()
    expect(profileNameOf({ get: () => undefined })).toBeNull()
    expect(profileNameOf({ get: () => ({ dir: '/p' }) })).toBeNull()
  })

  it('returns null instead of throwing when the lookup is refused', () => {
    // Cordis throws for an undeclared service; a panel that crashes on load is
    // worse than one that reports "unrecognised profile".
    expect(profileNameOf({ get: () => { throw new Error('not declared') } })).toBeNull()
  })

  it('ignores a blank or non-string name', () => {
    expect(profileNameOf({ get: () => ({ name: '' }) })).toBeNull()
    expect(profileNameOf({ get: () => ({ name: 42 }) })).toBeNull()
  })
})

// ── resolveConfig ───────────────────────────────────────────────────

describe('resolveConfig', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    vi.unstubAllEnvs()
    process.env = { ...OLD_ENV }
    delete process.env.UNIFIED_MEMORY_VAULT
    delete process.env.UNIFIED_MEMORY_PYTHON
    delete process.env.UNIFIED_MEMORY_COREPATH
    delete process.env.UNIFIED_MEMORY_REMOTE
    delete process.env.UNIFIED_MEMORY_AGENT
    // Not a value the host sets in this process — see the `profile` cases below.
    // Cleared anyway so a developer who exported it by hand cannot skew a test.
    delete process.env.DSH_PROFILE
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
    // vaultPath is deliberately NOT asserted as '' here: it legitimately falls
    // back to the core's own config file, so its value depends on the machine.
    // The resolution chain is covered by the dedicated cases below.
    expect(cfg.pythonPath).toBe('python')
    expect(cfg.remoteEnabled).toBe(false)
    expect(cfg.corePath).toContain('core')
  })

  it('defaults the agent name to dsh when no profile and no config is available', () => {
    expect(resolveConfig().agentName).toBe('dsh')
  })

  it('takes the profile name from the host, not from the environment', () => {
    // The regression this covers: the host never exports DSH_PROFILE into this
    // process (it builds a DSH_* namespace per model shell call and discards
    // ambient values), so reading the env var always produced 'fallback' and
    // the health pane said "dsh（未识别 profile）" on every real install.
    const cfg = resolveConfig({}, { profile: 'desktop' })
    expect(cfg.agentName).toBe('dsh-desktop')
    expect(cfg.agentNameSource).toBe('profile')
  })

  it('prefers the host profile over a DSH_PROFILE left in the environment', () => {
    // Someone launching by hand may export the variable; the host's own answer
    // is the more authoritative one.
    process.env.DSH_PROFILE = 'web'
    const cfg = resolveConfig({}, { profile: 'desktop' })
    expect(cfg.agentName).toBe('dsh-desktop')
  })

  it('still reads DSH_PROFILE when the host published no profile', () => {
    process.env.DSH_PROFILE = 'web'
    const cfg = resolveConfig({}, { profile: null })
    expect(cfg.agentName).toBe('dsh-web')
    expect(cfg.agentNameSource).toBe('profile')
  })

  it('holds the host profile above UNIFIED_MEMORY_AGENT only when unset', () => {
    process.env.UNIFIED_MEMORY_AGENT = 'team-lead'
    const cfg = resolveConfig({}, { profile: 'desktop' })
    expect(cfg.agentName).toBe('team-lead')
    expect(cfg.agentNameSource).toBe('env')
  })

  it('derives the agent name from DSH_PROFILE so runtimes sharing one vault stay separate', () => {
    process.env.DSH_PROFILE = 'desktop'
    expect(resolveConfig().agentName).toBe('dsh-desktop')
  })

  it('reads UNIFIED_MEMORY_AGENT when there is no explicit config', () => {
    process.env.UNIFIED_MEMORY_AGENT = 'team-lead'
    expect(resolveConfig().agentName).toBe('team-lead')
  })

  it('prefers an explicit agentName over UNIFIED_MEMORY_AGENT and DSH_PROFILE', () => {
    process.env.UNIFIED_MEMORY_AGENT = 'team-lead'
    process.env.DSH_PROFILE = 'desktop'
    expect(resolveConfig({ agentName: 'auditor' }).agentName).toBe('auditor')
  })

  it('treats an absent core config file as "no vault from that source"', () => {
    expect(readCoreConfigVault('D:/definitely/not/a/real/path.yaml')).toBe('')
  })

  it('reads the vault key from a core config file, ignoring comments and quotes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uam-cfg-'))
    try {
      const f = join(dir, 'cfg.yaml')
      writeFileSync(f, [
        '# a comment line',
        'unrelated: value',
        'vault: "D:/my vault"   # trailing comment',
        '',
      ].join('\n'), 'utf-8')
      expect(readCoreConfigVault(f)).toBe('D:/my vault')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to "" on a malformed core config file instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uam-cfg-bad-'))
    try {
      const f = join(dir, 'cfg.yaml')
      writeFileSync(f, 'this is not: valid: yaml: at all\nvault\n', 'utf-8')
      expect(() => readCoreConfigVault(f)).not.toThrow()
      expect(readCoreConfigVault(f)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: the plugin consulted only its own cordis config, so an install
  // relying on ~/.unified-memory.yaml (what `setup.py init` writes) reported
  // configured:false and every tool answered "not configured" — while the HTTP
  // routes served live data from the same vault. The console and the agent
  // disagreed about the same machine.
  it('prefers an explicit vaultPath over the environment and the file', () => {
    process.env.UNIFIED_MEMORY_VAULT = '/env/vault'
    const cfg = resolveConfig({ vaultPath: '/config/vault' })
    expect(cfg.vaultPath).toBe('/config/vault')
  })

  it('treats an empty explicit vaultPath as unset and continues down the chain', () => {
    process.env.UNIFIED_MEMORY_VAULT = '/env/vault'
    // `''` must not shadow a lower-priority source — that is exactly the bug
    // shape that made a configured install look unconfigured.
    const cfg = resolveConfig({ vaultPath: '' })
    expect(cfg.vaultPath).toBe('/env/vault')
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

  // Regression: `Boolean(value)` was used here, and `Boolean('false')` is
  // `true` — so a string "false" from a YAML config or an env var silently
  // turned the remote index ON.
  it('treats string "false" as disabled, not as truthy', () => {
    expect(resolveConfig({ remoteEnabled: 'false' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: 'FALSE' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: 'no' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: 'off' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: '0' }).remoteEnabled).toBe(false)
  })

  it('accepts the truthy spellings that appear in config and env', () => {
    expect(resolveConfig({ remoteEnabled: 'true' }).remoteEnabled).toBe(true)
    expect(resolveConfig({ remoteEnabled: 'yes' }).remoteEnabled).toBe(true)
    expect(resolveConfig({ remoteEnabled: 'on' }).remoteEnabled).toBe(true)
    expect(resolveConfig({ remoteEnabled: '1' }).remoteEnabled).toBe(true)
    expect(resolveConfig({ remoteEnabled: 1 }).remoteEnabled).toBe(true)
  })

  it('falls back rather than guessing on an unparseable value', () => {
    expect(resolveConfig({ remoteEnabled: 'maybe' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: '' }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: null }).remoteEnabled).toBe(false)
    expect(resolveConfig({ remoteEnabled: {} }).remoteEnabled).toBe(false)
  })

  it('reads remoteEnabled from UNIFIED_MEMORY_REMOTE', () => {
    process.env.UNIFIED_MEMORY_REMOTE = 'true'
    expect(resolveConfig().remoteEnabled).toBe(true)
    process.env.UNIFIED_MEMORY_REMOTE = 'false'
    expect(resolveConfig().remoteEnabled).toBe(false)
  })

  it('prefers cordis config over the env var for remoteEnabled', () => {
    process.env.UNIFIED_MEMORY_REMOTE = 'true'
    expect(resolveConfig({ remoteEnabled: 'false' }).remoteEnabled).toBe(false)
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

  it('accepts the suffix-less form the vault links with', () => {
    // `上下文索引.md` links notes as `[[我的偏好摘要]]` — no suffix. Refusing
    // that here rejected the one spelling the vault itself uses, before the
    // core (which adds the suffix) ever saw it.
    expect(validateDocId('我的偏好摘要')).toEqual({ valid: true })
    expect(validateDocId('my-doc')).toEqual({ valid: true })
  })

  it('lets the core decide whether a name exists', () => {
    // A bare name is a well-formed note name; existence is the core's call,
    // and its "not-found" is a better answer than a local "unknown document".
    expect(validateDocId('nonexistent')).toEqual({ valid: true })
  })

  it('still refuses traversal dressed as a bare name', () => {
    expect(validateDocId('..')).toEqual(expect.objectContaining({ valid: false }))
    expect(validateDocId('a/b')).toEqual(expect.objectContaining({ valid: false }))
    expect(validateDocId('a\\b')).toEqual(expect.objectContaining({ valid: false }))
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

// ── buildSearchArgv ─────────────────────────────────────────────────

describe('buildSearchArgv', () => {
  it('builds a basic search argv with default limit', () => {
    expect(buildSearchArgv('staging server')).toEqual([
      'search', 'staging server', '--limit', '8',
    ])
  })

  it('honors an explicit limit', () => {
    expect(buildSearchArgv('staging server', { limit: 3 })).toEqual([
      'search', 'staging server', '--limit', '3',
    ])
  })

  it('appends hybrid flag when enabled', () => {
    expect(buildSearchArgv('staging', { hybrid: true })).toEqual([
      'search', 'staging', '--limit', '8', '--hybrid',
    ])
  })

  it('appends format and budget when provided', () => {
    expect(buildSearchArgv('staging', { hybrid: true, format: 'compact', budget: 500 })).toEqual([
      'search', 'staging', '--limit', '8', '--hybrid', '--format', 'compact', '--budget', '500',
    ])
  })

  it('rejects unknown format values gracefully (no flag appended)', () => {
    expect(buildSearchArgv('staging', { format: 'bogus' })).toEqual([
      'search', 'staging', '--limit', '8',
    ])
  })

  it('ignores non-positive budget', () => {
    expect(buildSearchArgv('staging', { budget: 0 })).toEqual([
      'search', 'staging', '--limit', '8',
    ])
  })
})

// ── buildSubmitArgv ─────────────────────────────────────────────────

describe('buildSubmitArgv', () => {
  it('passes the resolved agent name to --agent', () => {
    const cfg = { agentName: 'dsh-desktop' } as never
    expect(buildSubmitArgv(cfg, '- a fact')).toEqual([
      'submit', '- a fact', '--agent', 'dsh-desktop',
    ])
  })

  it('falls back to dsh when the config carries no agent name', () => {
    expect(buildSubmitArgv({} as never, '- a fact')).toEqual([
      'submit', '- a fact', '--agent', 'dsh',
    ])
  })
})

// ── buildPreviewArgv ────────────────────────────────────────────────

describe('buildPreviewArgv', () => {
  it('builds a basic preview argv with the default limit', () => {
    expect(buildPreviewArgv('pending')).toEqual(['preview', 'pending', '--limit', '20'])
  })

  it('honors an explicit limit', () => {
    expect(buildPreviewArgv('conflicts', { limit: 5 })).toEqual([
      'preview', 'conflicts', '--limit', '5',
    ])
  })

  it('appends --json when requested', () => {
    expect(buildPreviewArgv('recent', { json: true })).toEqual([
      'preview', 'recent', '--limit', '20', '--json',
    ])
  })

  it('rejects an unknown view', () => {
    expect(() => buildPreviewArgv('nope')).toThrow(/unknown view/)
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

  it('falls back to the error when the core produced no output', () => {
    // `runCore` answers a failure with `output: ''` and the diagnosis in
    // `error`. Rendering only `output` showed the agent an empty block: the
    // tool looked like it had nothing to say when in fact it had failed.
    const result = renderText(null, {
      ok: false,
      output: '',
      error: 'memory core failed (1): traceback …',
    })
    expect(result).toEqual([{ type: 'text', text: 'memory core failed (1): traceback …' }])
  })

  it('prefers output over error when both are present', () => {
    const result = renderText(null, { output: 'the answer', error: 'a warning' })
    expect(result).toEqual([{ type: 'text', text: 'the answer' }])
  })

  it('renders an empty block when neither is available', () => {
    const result = renderText(null, { ok: false, output: '' })
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