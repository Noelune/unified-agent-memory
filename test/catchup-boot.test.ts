import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetCatchupForTesting, catchupSummary, startMemoryCatchup } from '../src/catchup-boot.ts'
import { runCore } from '../src/utils.ts'
import type { PluginConfig } from '../src/types.ts'

vi.mock('../src/utils.ts', () => ({ runCore: vi.fn() }))

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

  it('hands the default runner exactly [--json] — --run is not a declared flag', async () => {
    // The regression: defaultRunner passed ['--run', '--json'], but
    // catchup.py's argparse declares only --vault / --check / --json. argparse
    // exits 2 on the undeclared flag, runCore's err branch carries an empty
    // output, and every boot/hourly pass logged one bare "catch-up failed"
    // line — the missed 03:00 promotion and Monday 04:00 forgetting never
    // replayed. The injected-runner tests above cannot see the argv, so this
    // one pins the real runCore call.
    // The default runner is also guarded by isTestProcess(); that guard reads
    // the env at call time, so clearing it here exercises the production path.
    const vitestEnv = process.env.VITEST
    const nodeEnv = process.env.NODE_ENV
    delete process.env.VITEST
    delete process.env.NODE_ENV
    try {
      vi.mocked(runCore).mockResolvedValue({ ok: true, output: '{"promote": false}' })
      startMemoryCatchup(cfg())
      await nextTick()
    } finally {
      if (vitestEnv === undefined) delete process.env.VITEST
      else process.env.VITEST = vitestEnv
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
    }
    expect(runCore).toHaveBeenCalledTimes(1)
    expect(runCore).toHaveBeenLastCalledWith(cfg(), ['--json'], expect.objectContaining({ module: 'unified_memory.catchup' }))
    expect(JSON.stringify(vi.mocked(runCore).mock.calls[0][1])).not.toContain('--run')
  })
})
