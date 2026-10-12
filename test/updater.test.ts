/**
 * Tests for the update checker (src/updater.ts).
 *
 * Uses vitest's mock-on-module to avoid actual network calls.
 *
 * @module test/updater.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock readFileSync to return a controlled package.json
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: '1.2.3' })),
  existsSync: vi.fn(() => true),
}))

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Now import the module under test (after mocks are set up)
const { checkForUpdate, getUpdateInfo, compareVersions, _resetForTesting } = await import('../src/updater.ts')

describe('updater', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    _resetForTesting() // clear shared state before each test
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads current version from package.json at import', () => {
    const info = getUpdateInfo()
    expect(info.currentVersion).toBe('1.2.3')
  })

  it('returns null state before first check', () => {
    const info = getUpdateInfo()
    expect(info.latestVersion).toBeNull()
    expect(info.updateAvailable).toBeNull()
    expect(info.checkedAt).toBeNull()
  })

  it('updates state on successful fetch with newer version', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    })

    checkForUpdate()

    // Wait for the async fetch to complete
    await vi.waitFor(() => {
      const info = getUpdateInfo()
      expect(info.latestVersion).toBe('2.0.0')
      expect(info.updateAvailable).toBe(true)
      expect(info.checkedAt).not.toBeNull()
    })
  })

  it('marks updateAvailable false when version matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '1.2.3' }),
    })

    checkForUpdate()

    await vi.waitFor(() => {
      const info = getUpdateInfo()
      expect(info.latestVersion).toBe('1.2.3')
      expect(info.updateAvailable).toBe(false)
    })
  })

  it('marks updateAvailable false when installed version is newer', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '1.0.0' }),
    })

    checkForUpdate()

    await vi.waitFor(() => {
      const info = getUpdateInfo()
      expect(info.latestVersion).toBe('1.0.0')
      expect(info.updateAvailable).toBe(false)
    })
  })

  it('handles network failures gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'))

    checkForUpdate()

    // Wait briefly for the fetch to fail, then check state is unchanged
    await new Promise((r) => setTimeout(r, 100))
    const info = getUpdateInfo()
    // previous state may have been set by earlier tests; check it's not crashed
    expect(info.currentVersion).toBe('1.2.3')
  })

  it('handles HTTP errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    })

    checkForUpdate()

    await new Promise((r) => setTimeout(r, 100))
    const info = getUpdateInfo()
    expect(info.currentVersion).toBe('1.2.3')
  })

  // ── Registry fallback ─────────────────────────────────────────────
  // npmjs.org is often unreachable on mainland-China networks while a mirror
  // answers instantly; the badge must not depend on the canonical registry.

  it('falls back to the mirror when the canonical registry is unreachable', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      })

    checkForUpdate()

    await vi.waitFor(() => {
      expect(getUpdateInfo().latestVersion).toBe('2.0.0')
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(String(mockFetch.mock.calls[1][0])).toContain('npmmirror')
  })

  it('falls back to the mirror when the canonical registry 404s', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '3.0.0' }),
      })

    checkForUpdate()

    await vi.waitFor(() => {
      expect(getUpdateInfo().latestVersion).toBe('3.0.0')
    })
  })

  it('leaves state unknown when every registry fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'))

    checkForUpdate()

    await new Promise((r) => setTimeout(r, 100))
    const info = getUpdateInfo()
    expect(info.latestVersion).toBeNull()
    expect(info.updateAvailable).toBeNull()
    expect(info.checkedAt).toBeNull()
  })
})

// ── compareVersions ─────────────────────────────────────────────────
//
// The previous implementation stripped non-digits, so `0.6.0-rc.1` and `0.6.0`
// compared EQUAL and a pre-release user was never told the release had shipped.

describe('compareVersions', () => {
  it('orders plain releases numerically', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })

  it('sorts a pre-release below its release', () => {
    expect(compareVersions('0.6.0-rc.1', '0.6.0')).toBe(-1)
    expect(compareVersions('0.6.0', '0.6.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
  })

  it('orders pre-release identifiers per SemVer', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    // numeric identifiers rank below alphanumeric ones
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
    expect(compareVersions('1.0.0+sha', '1.0.0')).toBe(0)
  })

  it('detects a real upgrade from a pre-release to the release', () => {
    // The exact regression: this used to be 0, so no badge appeared.
    expect(compareVersions('0.6.0', '0.6.0-rc.1')).toBe(1)
  })
})