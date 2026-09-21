/**
 * Task 7 — client store: search / preview / dismiss.
 *
 * Two layers, on purpose:
 *
 *  1. surface assertions (static): the browser half is bundled against the DSH
 *     client runtime and there is no DOM in the Node test env, so the exported
 *     names, the `no-store` cache discipline and the "react only via deps.ts"
 *     rule are pinned at source level;
 *  2. behavior assertions (dynamic): the transport, the ok-gating and the
 *     search race guard are real logic, so they run their real code with only
 *     `fetch` stubbed — a static `toContain` cannot tell whether a slower
 *     earlier search overwrites a newer one.
 *
 * Race coverage lives in the pure guard `isCurrentSearch` (the mechanism
 * `runSearchSequence`/`useSearch` both use), because React hooks cannot be
 * mounted in this environment: asserting the guard's behavior covers exactly
 * the decision the hook makes, without a renderer.
 *
 * @module test/client-store.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/client/store.ts', import.meta.url), 'utf8')
const TYPES = readFileSync(new URL('../src/client/types.ts', import.meta.url), 'utf8')

// Imported statically: touching window.location at module scope would make this
// URL invalid, and store.ts must therefore not depend on a window.
import {
  canApplyPreview,
  dismissItem,
  isCurrentSearch,
  loadPreview,
  newPreviewGate,
  nextSeq,
  previewEffectKey,
  runSearch,
  runSearchSequence,
} from '../src/client/store.ts'

type Reply = { ok?: boolean; status?: number; body?: unknown; throws?: boolean }

const calls: { url: string; init: RequestInit | undefined }[] = []

function stubFetch(...replies: (Reply | (() => Promise<Reply>))[]): void {
  calls.length = 0
  let i = 0
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const reply = replies[Math.min(i++, replies.length - 1)]
    // The awaited value is what carries the distinction: a thunk stays a
    // function after `await`, a reply object does not. Inspecting the promise
    // itself would see the wrapping function every time.
    return Promise.resolve().then(() => reply).then(async (raw) => {
      const r: Reply = typeof raw === 'function' ? await (raw as () => Promise<Reply>)() : raw
      if (r.throws) throw new TypeError('network down')
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => r.body,
      } as unknown as Response
    })
  })
}

const hit = (doc: string) => ({ doc, title: doc, snippet: 's' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client store surface', () => {
  it('exports the three new async entry points', () => {
    for (const fn of ['runSearch', 'loadPreview', 'dismissItem']) {
      expect(SRC, `missing ${fn}`).toContain(`export async function ${fn}`)
    }
  })

  it('exports the two new hooks', () => {
    for (const hook of ['useSearch', 'usePreview']) {
      expect(SRC, `missing ${hook}`).toContain(`export function ${hook}`)
    }
  })

  it('posts to the dismiss route with JSON', () => {
    expect(SRC).toContain('DISMISS_URL')
    expect(SRC).toContain("method: 'POST'")
    expect(SRC).toContain("'content-type': 'application/json'")
  })

  it('never caches a panel read', () => {
    const fetches = SRC.match(/cache:\s*'no-store'/g) ?? []
    expect(fetches.length).toBeGreaterThanOrEqual(4)
  })

  it('declares the preview view union in types', () => {
    expect(TYPES).toContain('PreviewView')
    expect(TYPES).toContain("'forgetting'")
  })

  it('does not import react directly', () => {
    expect(SRC).not.toMatch(/from\s+['"]react['"]/)
  })
})

describe('runSearch', () => {
  it('returns hits when the host answers ok', async () => {
    stubFetch({ body: { ok: true, count: 1, results: [hit('a.md')] } })
    await expect(runSearch('记忆', false)).resolves.toEqual([hit('a.md')])
    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/search?q=%E8%AE%B0%E5%BF%86')
    expect(calls[0].init?.cache).toBe('no-store')
  })

  it('requests the hybrid stream only when asked', async () => {
    stubFetch({ body: { ok: true, results: [] } })
    await runSearch('x', true)
    expect(calls[0].url).toContain('&hybrid=1')
  })

  it('treats a 200 with ok:false as no results, not as an error', async () => {
    // The core half reports an unavailable vault this way. A transport-level
    // success is not a business success.
    //
    // The payload MUST carry a non-empty `results`: with `results: []` the
    // assertion holds even after the `body.ok` gate is deleted, so it proves
    // nothing. A populated payload is what makes the gate observable — drop the
    // gate and `leaked.md` surfaces.
    stubFetch({ status: 200, body: { ok: false, count: 1, results: [hit('leaked.md')] } })
    await expect(runSearch('x', false)).resolves.toEqual([])
  })

  it('returns [] when the route is unreachable', async () => {
    stubFetch({ throws: true })
    await expect(runSearch('x', false)).resolves.toEqual([])
  })
})

describe('loadPreview', () => {
  it('normalizes the payload and carries status through verbatim', async () => {
    stubFetch({
      body: { ok: true, view: 'conflicts', status: 'unsupported', count: 0, items: [] },
    })
    const d = await loadPreview('conflicts')
    expect(d).toEqual({ view: 'conflicts', status: 'unsupported', count: 0, items: [] })
    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/preview?view=conflicts&limit=20')
    expect(calls[0].init?.cache).toBe('no-store')
  })

  it('forwards a caller-supplied limit', async () => {
    stubFetch({ body: { ok: true, view: 'pending', status: 'ok', count: 0, items: [] } })
    await loadPreview('pending', 5)
    expect(calls[0].url).toContain('&limit=5')
  })

  it('returns null for ok:false or a throw', async () => {
    stubFetch({ body: { ok: false } })
    await expect(loadPreview('pending')).resolves.toBeNull()
    stubFetch({ throws: true })
    await expect(loadPreview('pending')).resolves.toBeNull()
  })

  it('passes a caller-supplied limit through untouched', async () => {
    // The host clamps `limit` into its own range, and a garbage value falls back
    // to the host default; the client must not invent a third policy.
    stubFetch({ body: { ok: true, status: 'ok', count: 0, items: [] } })
    await loadPreview('pending', 0)
    expect(calls[0].url).toContain('&limit=0')
  })

  it('keeps unsupported distinct from an empty list', async () => {
    // Both are count 0; only `status` tells them apart, and the UI needs both.
    stubFetch({ body: { ok: true, status: 'unsupported', count: 0, items: [] } })
    await expect(loadPreview('conflicts')).resolves.toMatchObject({ status: 'unsupported' })
    stubFetch({ body: { ok: true, status: 'ok', count: 0, items: [] } })
    await expect(loadPreview('conflicts')).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('dismissItem', () => {
  const post = () =>
    calls.length > 0 ? calls[calls.length - 1] : ({} as { url: string; init?: RequestInit })

  it('is true only when the body says ok', async () => {
    stubFetch({ status: 200, body: { ok: true, name: 'a.md', reason: null } })
    await expect(dismissItem('a.md')).resolves.toBe(true)
    expect(post().url).toBe('/api/dsh-unified-agent-memory/dismiss')
    expect(post().init?.method).toBe('POST')
    expect(JSON.stringify(post().init?.headers)).toContain('application/json')
    expect(post().init?.body).toBe('{"name":"a.md"}')
  })

  it('is false for a 200 that still says ok:false', async () => {
    // HTTP status is not the verdict — only body.ok is.
    stubFetch({ status: 200, body: { ok: false, name: 'a.md', reason: 'outside-inbox' } })
    await expect(dismissItem('a.md')).resolves.toBe(false)
  })

  it('is false for a 409 refusal and for a throw', async () => {
    stubFetch({ status: 409, body: { ok: false, name: 'a.md', reason: 'not-found' } })
    await expect(dismissItem('a.md')).resolves.toBe(false)
    stubFetch({ throws: true })
    await expect(dismissItem('a.md')).resolves.toBe(false)
  })
})

describe('search race guard', () => {
  it('keeps only the newest sequence token current', () => {
    const seq = { current: 0 }
    const first = nextSeq(seq)
    expect(isCurrentSearch(seq, first)).toBe(true)
    const second = nextSeq(seq)
    expect(isCurrentSearch(seq, first)).toBe(false) // the slow older request
    expect(isCurrentSearch(seq, second)).toBe(true)
  })

  it('drops a slow earlier response and keeps the newer one', async () => {
    // The slow reply must itself be a well-formed `ok:true` hit, so the test
    // proves the OLDER result was discarded — not merely that it was empty.
    let releaseSlow: (r: Reply) => void = () => {}
    const slow = new Promise<Reply>((resolve) => { releaseSlow = resolve })
    stubFetch(() => slow, { body: { ok: true, results: [hit('new.md')] } })

    // Mirrors two `run()` calls in a row: the panel fires both without awaiting
    // the first, the newer response lands, and the older one settles LAST.
    // The fast one is awaited on its own — awaiting `all()` here would deadlock
    // the scenario the test exists to exercise.
    const ran = runSearchSequence([
      ['old', false],
      ['new', false],
    ])
    await ran.one(1)
    expect(ran.settled[1]).toEqual([hit('new.md')])
    expect(ran.newest()).toEqual([hit('new.md')])

    // The stale response arrives afterwards and must be discarded.
    releaseSlow({ body: { ok: true, results: [hit('old.md')] } })
    await ran.all()
    expect(ran.newest()).toEqual([hit('new.md')])
    expect(ran.settled[0]).toBeUndefined()
  })
})

describe('useSearch delegates its guard to the shared path', () => {
  // Why this test exists: `useSearch` used to carry its OWN copy of the
  // `isCurrentSearch` branch, so mutating the guard inside the hook left every
  // test green — the suite only ever exercised the copy in `runSearchSequence`.
  // Production was therefore untested while appearing covered.
  //
  // The hook cannot be mounted here (no renderer, by design), so instead of
  // re-testing the guard we pin the one property that makes the mountable
  // guard reachable: the hook's `run` must route through the same shared
  // helper the tests drive. Re-inlining the guard into the hook breaks this.
  const hookBody = (): string => {
    const start = SRC.indexOf('export function useSearch(')
    expect(start, 'useSearch not found').toBeGreaterThan(-1)
    return SRC.slice(start, SRC.indexOf('export function usePreview('))
  }

  it('routes the hook run through the shared race helper, not a private copy', () => {
    const body = hookBody()
    // The single-source-of-truth call the hook must make.
    expect(body).toMatch(/runSearchSequence\s*\(/)
    // The private re-inlined guard must be gone: the hook may not test the
    // sequence itself, it may only read the helper's verdict.
    expect(body).not.toMatch(/isCurrentSearch\s*\(/)
    expect(body).not.toMatch(/nextSeq\s*\(/)
  })
})

describe('usePreview effect decision (pure, no renderer)', () => {
  // `useEffect` cannot run here: there is no renderer in this repo (no
  // @testing-library/react, no jsdom, no react-dom) and the brief forbids adding
  // a dependency. So the two decisions the effect makes are extracted into pure
  // functions the hook MUST call, and asserted directly. Limit: this pins the
  // decision logic and the dependency set, not React's own scheduling — see the
  // report for the exact ceiling.

  it('treats a load as live before unmount and dead after', () => {
    const gate = newPreviewGate()
    expect(gate.alive).toBe(true)
    expect(canApplyPreview(gate)).toBe(true)

    gate.dispose() // what the effect's cleanup does on unmount / re-run
    expect(gate.alive).toBe(false)
    // The late response must not reach setState on a dead component.
    expect(canApplyPreview(gate)).toBe(false)
  })

  it('refetches when the view changes', () => {
    expect(previewEffectKey('pending', 0)).not.toBe(previewEffectKey('conflicts', 0))
  })

  it('refetches when reload bumps the nonce', () => {
    expect(previewEffectKey('pending', 0)).not.toBe(previewEffectKey('pending', 1))
  })

  it('does not refetch when neither the view nor the nonce moved', () => {
    expect(previewEffectKey('recent', 3)).toBe(previewEffectKey('recent', 3))
  })

  it('pins the effect dependency array to exactly [view, nonce]', () => {
    // The decision above only matters if the effect is actually keyed on both.
    const start = SRC.indexOf('export function usePreview(')
    const body = SRC.slice(start, SRC.indexOf('export async function dismissItem('))
    expect(body).toMatch(/\[\s*view\s*,\s*nonce\s*\]/)
  })
})
