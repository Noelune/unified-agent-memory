import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetCatchupForTesting, catchupSummary, startMemoryCatchup } from '../src/catchup-boot.ts'
import type { PluginConfig } from '../src/types.ts'

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    vaultPath: '/tmp/vault',
    pythonPath: 'python',
    corePath: '/tmp/core',
    remoteEnabled: false,
    agentName: 'dsh-desktop',
    agentNameSource: 'profile',
    ...overrides,
  }
}

beforeEach(() => {
  _resetCatchupForTesting()
})

afterEach(() => {
  _resetCatchupForTesting()
  vi.restoreAllMocks()
})

describe('startMemoryCatchup', () => {
  it('fires the runner once immediately and records the report line', async () => {
    const runner = vi.fn().mockResolvedValue({ ok: true, output: 'promote: ran\nforget: skipped\n{"promote": true}' })
    startMemoryCatchup(cfg(), runner)
    await nextTick()
    expect(runner).toHaveBeenCalledTimes(1)
    expect(catchupSummary()).toBe('{"promote": true}')
  })

  it('never fires without a configured vault', async () => {
    const runner = vi.fn()
    startMemoryCatchup(cfg({ vaultPath: '' }), runner)
    await nextTick()
    expect(runner).not.toHaveBeenCalled()
    expect(catchupSummary()).toBeNull()
  })

  it('starts only once per process', async () => {
    const runner = vi.fn().mockResolvedValue({ ok: true, output: '{"promote": false}' })
    startMemoryCatchup(cfg(), runner)
    startMemoryCatchup(cfg(), runner)
    await nextTick()
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('records a failure instead of throwing it away', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('python gone'))
    startMemoryCatchup(cfg(), runner)
    await nextTick()
    expect(catchupSummary()).toContain('python gone')
  })
})
