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
  useSearchRun,
} from '../src/client/store.ts'

import type { SearchHit } from '../src/client/types.ts'

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

describe('useSearch concurrency across separate run() calls (production path)', () => {
  // Why this test exists: the hook's guard used to be dead on the production
  // path. `run()` allocated a FRESH `seq = {current:0}` on every call and asked
  // about a SINGLE-element array, so `mine = 1` always equalled `seq.current = 1`
  // and the "is it still current?" check was vacuously true. Two overlapping
  // `run()` calls therefore could not see each other, and a slow older response
  // overwrote the newer result. Replacing the hook's `apply` with a no-op left
  // the whole suite green — the production guard was untested.
  //
  // This test drives the REAL production path (`useSearchRun`, the same closure
  // `useSearch.run` executes) with real `runSearch` and only `fetch` stubbed. It
  // asserts the cross-call property the guard exists for: state must end on the
  // NEWEST result even though the OLDEST request settles LAST.
  it('drops a slow earlier run() response and keeps the newer results', async () => {
    let releaseSlow: (r: Reply) => void = () => {}
    const slow = new Promise<Reply>((resolve) => { releaseSlow = resolve })
    // First request (old) hangs; second (new) answers immediately.
    stubFetch(() => slow, { body: { ok: true, results: [hit('new.md')] } })

    // The two state holders stand in for React's `useState` cells.
    let results: SearchHit[] = []
    let busy = false
    const run = useSearchRun(
      (next) => { results = next },
      (next) => { busy = next },
      () => {},
    )

    run('old', false) // slow: settles last, must be discarded
    run('new', false) // fast: settles first, must win
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // The stale response arrives afterwards carrying real hits…
    releaseSlow({ body: { ok: true, results: [hit('old.md')] } })
    await new Promise((r) => setTimeout(r, 20))

    // …and must NOT have overwritten the newer result.
    expect(results).toEqual([hit('new.md')])
    expect(busy).toBe(false)
  })

  it('keeps busy true until the newest run settles, not the stale one', async () => {
    let releaseSlow: (r: Reply) => void = () => {}
    const slow = new Promise<Reply>((resolve) => { releaseSlow = resolve })
    stubFetch(() => slow, { body: { ok: true, results: [hit('new.md')] } })

    const busyLog: boolean[] = []
    const run = useSearchRun(() => {}, (next) => { busyLog.push(next) }, () => {})

    run('old', false)
    run('new', false)
    await new Promise((r) => setTimeout(r, 20))
    // The newer run has settled, so the spinner is off even though the stale
    // request is still in flight. A dead guard would flip busy on the stale
    // settle (or leave it stuck).
    expect(busyLog[busyLog.length - 1]).toBe(false)

    releaseSlow({ body: { ok: true, results: [hit('old.md')] } })
    await new Promise((r) => setTimeout(r, 20))
    // A stale settle must not restart the spinner.
    expect(busyLog[busyLog.length - 1]).toBe(false)
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
  // guard reachable: the hook's `run` must route through `useSearchRun` — the
  // shared body the concurrency tests above drive — and must hand it a
  // PERSISTENT seq cell rather than a fresh per-call literal. Re-inlining the
  // guard, or re-introducing a per-call `{current:0}`, breaks this.
  const hookBody = (): string => {
    const start = SRC.indexOf('export function useSearch(')
    expect(start, 'useSearch not found').toBeGreaterThan(-1)
    return SRC.slice(start, SRC.indexOf('function useSearchRun(') === -1
      ? SRC.indexOf('export function usePreview(')
      : SRC.length)
  }

  it('routes the hook run through the shared body, not a private guard copy', () => {
    const body = hookBody()
    // The single-source-of-truth call the hook must make.
    expect(body).toMatch(/useSearchRun\s*\(/)
    // The private re-inlined guard must be gone: the hook may not test the
    // sequence itself.
    expect(body).not.toMatch(/isCurrentSearch\s*\(/)
    expect(body).not.toMatch(/nextSeq\s*\(/)
  })

  it('holds the sequence token in a useRef cell, not a per-call allocation', () => {
    const body = hookBody()
    // The seq must outlive a single `run()` call, or the guard is dead again.
    expect(body).toMatch(/useRef<\s*SearchSeq\s*>\s*\(\s*\{\s*current:\s*0\s*\}\s*\)/)
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

  it('makes the hook actually CALL the guard: gate, three checks, one cleanup', () => {
    // The gap this closes: the pure functions above were tested on their own,
    // but nothing forced `usePreview` to call them. Deleting the gate from the
    // hook — restoring the exact "setState after unmount" accident this task
    // exists to prevent — left the whole suite green.
    //
    // The effect cannot be executed here (no renderer, no jsdom, by
    // constraint), so this pins the call sites at source level. It answers
    // "does the hook consult the guard?" — NOT "does React's scheduling deliver
    // the response at the wrong time?". See the report for that ceiling.
    const start = SRC.indexOf('export function usePreview(')
    const body = SRC.slice(start, SRC.indexOf('export async function dismissItem('))

    // One gate per effect run.
    expect(body).toMatch(/newPreviewGate\s*\(\)/)
    // Every settling branch — then, catch, finally — must consult it. Three
    // separate checks, or a late response leaks through the ungated branch.
    const checks = body.match(/canApplyPreview\s*\(\s*gate\s*\)/g) ?? []
    expect(checks.length).toBe(3)
    // The cleanup must dispose the gate, or it stays alive past unmount.
    expect(body).toMatch(/return\s+gate\.dispose/)
  })
})
