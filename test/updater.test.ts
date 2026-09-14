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
const { checkForUpdate, getUpdateInfo, _resetForTesting } = await import('../src/updater.ts')

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
})