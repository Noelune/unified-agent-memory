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
  acceptItem,
  canApplyPreview,
  decideConflict,
  dismissItem,
  isCurrentSearch,
  loadConflicts,
  loadDoc,
  loadDoctor,
  loadNote,
  loadPreview,
  loadStats,
  newPreviewGate,
  newStatsGate,
  nextSeq,
  previewEffectKey,
  runSearch,
  runSearchSequence,
  statsEffectKey,
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

/**
 * Run the REAL `loadStats` against a hand-built response.
 *
 * The mutation block needs to feed the production function a body the `stubFetch`
 * helper cannot express (a `json()` that rejects), so it stubs the global here
 * rather than widening `stubFetch` for every other caller.
 */
async function loadStatsWith(
  res: { json: () => Promise<unknown> },
): Promise<Awaited<ReturnType<typeof loadStats>>> {
  vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, json: res.json }))
  const got = await loadStats()
  vi.unstubAllGlobals()
  return got
}

/** A fully-populated payload for the mutation checks. */
function statsDataForMutation() {
  return {
    daily: [{ date: '2026-01-01', count: 1 }],
    access: [], types: [], importance: [], top: [],
    span: { start: null, end: null },
    totals: { memories: 1, vectors: 1, accesses: 0, inbox: 0 },
  }
}

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

  it('REJECTS a 200 with ok:false rather than reporting an empty result', async () => {
    // The core half reports an unavailable vault this way. A transport-level
    // success is not a business success, and — the point this test exists for —
    // a search that could not run must not RESOLVE, because `useSearchRun` sets
    // `error` in its `.catch`. Resolving here would make that catch dead code
    // and a dead core would render as "没有匹配的记忆".
    //
    // The payload MUST carry a non-empty `results`: with `results: []` the
    // assertion holds even after the `body.ok` gate is deleted, so it proves
    // nothing. A populated payload is what makes the gate observable — drop the
    // gate and `leaked.md` surfaces instead of the rejection.
    stubFetch({ status: 200, body: { ok: false, count: 1, results: [hit('leaked.md')] } })
    await expect(runSearch('x', false)).rejects.toThrow(/core unavailable/)
  })

  it('REJECTS when the route is unreachable, so failure is distinguishable from empty', async () => {
    // The whole reason `runSearch` rejects: "the search never ran" and "the
    // search found nothing" are different facts and the panel words them
    // differently ("检查没跑起来" vs "没有匹配的记忆"). Resolving `[]` here is the
    // lie this signature exists to prevent.
    stubFetch({ throws: true })
    await expect(runSearch('x', false)).rejects.toThrow()
  })

  it('REJECTS a 200 whose body is missing the results array', async () => {
    // A truncated body is not an empty vault. Without this the `!Array.isArray`
    // half of the body gate is untested.
    stubFetch({ status: 200, body: { ok: true } })
    await expect(runSearch('x', false)).rejects.toThrow(/core unavailable/)
  })

  it('delivers a REAL empty result when the host answers ok with no hits', async () => {
    // The other half of the distinction: this one must resolve, or the panel
    // can never say "没有匹配的记忆".
    stubFetch({ status: 200, body: { ok: true, count: 0, results: [] } })
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

describe('loadNote', () => {
  it('returns the body and encodes the name into the query', async () => {
    stubFetch({ body: { ok: true, name: 'a b.md', body: '# 标题\n正文', untrusted: true } })
    await expect(loadNote('a b.md')).resolves.toEqual({ ok: true, body: '# 标题\n正文', reason: null })
    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/note?name=a%20b.md')
  })

  it('keeps a refusal reason instead of collapsing it into "no body"', async () => {
    // `not-found` and `invalid-name` are different facts with different advice.
    stubFetch({ body: { ok: false, name: 'x.md', body: null, reason: 'not-found', untrusted: true } })
    await expect(loadNote('x.md')).resolves.toEqual({ ok: false, body: null, reason: 'not-found' })
  })

  it('reports an unreadable route as unavailable', async () => {
    stubFetch({ throws: true })
    await expect(loadNote('x.md')).resolves.toEqual({ ok: false, body: null, reason: 'unavailable' })
  })
})

describe('loadDoc', () => {
  it('returns body AND path, and encodes the name into the query', async () => {
    stubFetch({ body: {
      ok: true, name: 'a b.md', path: '/vault/50-Agent-Context/a b.md',
      body: '# 标题\n正文', reason: null, untrusted: true,
    } })
    await expect(loadDoc('a b.md')).resolves.toEqual({
      ok: true, body: '# 标题\n正文', path: '/vault/50-Agent-Context/a b.md', reason: null,
    })
    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/doc?name=a%20b.md')
  })

  it('reads /doc, never /note', async () => {
    // `/note` reads the submission inbox and refuses a canonical note. Pointing
    // this at it would make every opened search hit fail with `outside-inbox`.
    stubFetch({ body: { ok: true, name: 'a.md', path: '/p', body: 'x' } })
    await loadDoc('a.md')
    expect(calls[0].url.startsWith('/api/dsh-unified-agent-memory/doc?')).toBe(true)
  })

  it('treats ok:true with a null body as a refusal, keeping the reason', async () => {
    // The core answers `ok:true, body:null, reason:'not-found'` so a miss exits
    // 0 and the reason survives. A client that gated on `ok` alone would show an
    // empty document for a note that does not exist.
    stubFetch({ body: { ok: true, name: null, path: null, body: null, reason: 'not-found' } })
    await expect(loadDoc('gone.md')).resolves.toEqual({
      ok: false, body: null, path: null, reason: 'not-found',
    })
  })

  it('keeps a transport failure distinct from a missing note', async () => {
    stubFetch({ throws: true })
    await expect(loadDoc('a.md')).resolves.toEqual({
      ok: false, body: null, path: null, reason: 'unavailable',
    })
  })

  it('reports a missing path as null rather than inventing one', async () => {
    stubFetch({ body: { ok: true, name: 'a.md', body: 'x' } })
    const got = await loadDoc('a.md')
    expect(got.ok).toBe(true)
    expect(got.path).toBeNull()
  })
})

describe('dismissItem', () => {
  const post = () =>
    calls.length > 0 ? calls[calls.length - 1] : ({} as { url: string; init?: RequestInit })

  it('is ok ONLY when the body says ok, and carries the reason', async () => {
    stubFetch({ status: 200, body: { ok: true, name: 'a.md', reason: null } })
    await expect(dismissItem('a.md')).resolves.toEqual({ ok: true, reason: null })
    expect(post().url).toBe('/api/dsh-unified-agent-memory/dismiss')
    expect(post().init?.method).toBe('POST')
    expect(JSON.stringify(post().init?.headers)).toContain('application/json')
    expect(post().init?.body).toBe('{"name":"a.md"}')
  })

  it('is not ok for a 200 that still says ok:false, and keeps the reason', async () => {
    // HTTP status is not the verdict — only body.ok is. The reason is what lets
    // the inbox say "该条目不在提交区" instead of "失败了".
    stubFetch({ status: 200, body: { ok: false, name: 'a.md', reason: 'outside-inbox' } })
    await expect(dismissItem('a.md')).resolves.toEqual({ ok: false, reason: 'outside-inbox' })
  })

  it('is not ok for a 409 refusal and carries its reason too', async () => {
    // A 409 body is still JSON; the old implementation bailed on `!r.ok` before
    // reading it, so every refusal arrived as a bare `false`.
    stubFetch({ status: 409, body: { ok: false, name: 'a.md', reason: 'not-found' } })
    await expect(dismissItem('a.md')).resolves.toEqual({ ok: false, reason: 'not-found' })
  })

  it('reports a transport failure as unavailable, never as a refusal', async () => {
    stubFetch({ throws: true })
    await expect(dismissItem('a.md')).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('acceptItem', () => {
  const post = () =>
    calls.length > 0 ? calls[calls.length - 1] : ({} as { url: string; init?: RequestInit })

  it('promotes one named submission and reports the counts', async () => {
    stubFetch({
      status: 200,
      body: { ok: true, name: 'a.md', reason: null, promoted: 3, duplicates: 1, conflicts: 0 },
    })

    await expect(acceptItem('a.md')).resolves.toEqual({
      ok: true, reason: null, promoted: 3, duplicates: 1, conflicts: 0,
    })
    expect(post().url).toBe('/api/dsh-unified-agent-memory/accept')
    expect(post().init?.body).toBe('{"name":"a.md"}')
  })

  it('carries the refusal reason, because "conflicts" is not a retry', async () => {
    // A conflicting submission is neither promoted nor retired: the next step
    // is a ruling, and the pane can only say that if the reason survives.
    stubFetch({
      status: 409,
      body: { ok: false, name: 'a.md', reason: 'conflicts', promoted: 0, duplicates: 0, conflicts: 2 },
    })

    await expect(acceptItem('a.md')).resolves.toEqual({
      ok: false, reason: 'conflicts', promoted: 0, duplicates: 0, conflicts: 2,
    })
  })

  it('never reports a negative or nan count as a number', async () => {
    stubFetch({ status: 200, body: { ok: true, promoted: -1, duplicates: 'x', conflicts: null } })

    const got = await acceptItem('a.md')

    expect(got.promoted).toBe(0)
    expect(got.duplicates).toBe(0)
    expect(got.conflicts).toBe(0)
  })

  it('reports a transport failure as unavailable', async () => {
    stubFetch({ throws: true })
    await expect(acceptItem('a.md')).resolves.toEqual({
      ok: false, reason: 'unavailable', promoted: 0, duplicates: 0, conflicts: 0,
    })
  })
})

describe('loadConflicts', () => {
  it('reads both sides of every queued conflict', async () => {
    stubFetch({
      status: 200,
      body: {
        ok: true,
        items: [{
          key: '20261019030125-1',
          new: '备份目录已迁移到 D:/backups',
          old: '- 备份目录是 C:/backups（写入 2026-10-16）',
          source: '[[Hermes会话自动归档/2026-10-18]]',
          doc: '50-Agent-Context\\常用路径与环境.md',
        }],
      },
    })

    await expect(loadConflicts()).resolves.toEqual([{
      key: '20261019030125-1',
      new: '备份目录已迁移到 D:/backups',
      old: '- 备份目录是 C:/backups（写入 2026-10-16）',
      source: '[[Hermes会话自动归档/2026-10-18]]',
      doc: '50-Agent-Context\\常用路径与环境.md',
    }])
    expect(calls[0].url).toContain('view=conflicts')
  })

  it('drops a row with no key, because nothing could rule on it', async () => {
    // The key is what a button sends. Rendering a row whose buttons would have
    // nothing to submit is worse than not showing it at all.
    stubFetch({ status: 200, body: { ok: true, items: [{ new: 'x', old: 'y' }, { key: 'k1' }] } })

    const got = await loadConflicts()

    expect(got).toHaveLength(1)
    expect(got![0].key).toBe('k1')
    expect(got![0].new).toBe('')
  })

  it('separates "could not read" from "nothing queued"', async () => {
    stubFetch({ status: 500, body: { ok: false } })
    await expect(loadConflicts()).resolves.toBeNull()

    stubFetch({ status: 200, body: { ok: true, items: [] } })
    await expect(loadConflicts()).resolves.toEqual([])
  })

  it('is null, not empty, when the transport dies', async () => {
    stubFetch({ throws: true })
    await expect(loadConflicts()).resolves.toBeNull()
  })
})

describe('decideConflict', () => {
  it('posts the key and the choice, and reports what was written', async () => {
    stubFetch({
      status: 200,
      body: { ok: true, key: 'k1', choice: '用新', reason: null, applied: true, target: '50-Agent-Context/常用路径与环境.md' },
    })

    await expect(decideConflict('k1', '用新')).resolves.toEqual({
      ok: true, reason: null, applied: true, target: '50-Agent-Context/常用路径与环境.md',
    })
    expect(calls[0].init?.body).toBe('{"key":"k1","choice":"用新"}')
  })

  it('separates "already ruled on" from "core is down"', async () => {
    // `not-found` means someone else resolved it between the read and the
    // click; retrying is pointless, reloading is right.
    stubFetch({ status: 409, body: { ok: false, reason: 'not-found' } })
    await expect(decideConflict('k1', '保留旧')).resolves.toEqual({
      ok: false, reason: 'not-found', applied: false, target: null,
    })

    stubFetch({ throws: true })
    await expect(decideConflict('k1', '保留旧')).resolves.toEqual({
      ok: false, reason: 'unavailable', applied: false, target: null,
    })
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

// ── loadStats: the console's aggregate feed ────────────────────────
//
// The route answers HTTP 200 in BOTH cases — the verdict is `body.ok`, exactly
// like `dismissItem`. The distinction the console cannot afford to lose is
// "degraded" (core unavailable, `data:null`) versus "empty" (core answered, and
// the vault genuinely has nothing): both used to collapse into a zeroed chart.

describe('loadStats', () => {
  // Every fixture below carries the FULL top-level key set, because a missing
  // key is now an error (see the omission test further down). These cases are
  // about malformed VALUES / empty data, and an incidental omitted key would
  // turn them into error-payload assertions by accident.
  const statsData = (over: Record<string, unknown> = {}) => ({
    daily: [{ date: '2026-01-01', count: 1 }],
    access: [],
    types: [],
    importance: [],
    top: [],
    span: { start: null, end: null },
    totals: { memories: 388, vectors: 388, accesses: 370, inbox: 31 },
    ...over,
  })

  it('returns the payload when the body says ok', async () => {
    // The brief's case, kept as the minimum contract. Note this file's
    // `stubFetch` takes the JSON under `body:` — the bare `{ ok: true, … }` form
    // in the brief means "the BODY has ok:true", not the transport flag.
    stubFetch({ body: { ok: true, command: 'stats', status: 'ok', data: statsData() } })
    const got = await loadStats()
    expect(got.status).toBe('ok')
    expect(got.data?.daily).toHaveLength(1)
  })

  it('degrades when the route reports ok:false — even though HTTP is 200', async () => {
    stubFetch({ status: 200, body: { ok: false, command: 'stats', status: 'error', data: null } })
    const got = await loadStats()
    expect(got.status).toBe('error')
    expect(got.data).toBeNull()
  })

  it('treats ok:true with data:null as degraded, never as an empty dataset', async () => {
    // The mutation this guards: `body.ok === true` being the only gate, so a
    // null payload survives and downstream geometry reads `daily.length` of
    // undefined. A degraded core is not "0 memories".
    stubFetch({ status: 200, body: { ok: true, command: 'stats', status: 'ok', data: null } })
    const got = await loadStats()
    expect(got.status).toBe('error')
    expect(got.data).toBeNull()
  })

  it('degrades on a non-JSON body instead of throwing', async () => {
    // A gateway/HTML error page is a 200 with a body that is not JSON. `res.json()`
    // rejects and the caller must see a payload, not an unhandled rejection.
    stubFetch({
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    } as unknown as Reply)
    await expect(loadStats()).resolves.toEqual({ status: 'error', data: null })
  })

  it('degrades when the transport fails, without an uncaught rejection', async () => {
    stubFetch({ throws: true })
    await expect(loadStats()).resolves.toEqual({ status: 'error', data: null })
  })

  it('degrades on a non-ok HTTP status even if the body claims ok', async () => {
    // Belt and braces: with a 500 the body is not ours to trust.
    stubFetch({ status: 500, body: { ok: true, command: 'stats', data: statsData() } })
    await expect(loadStats()).resolves.toEqual({ status: 'error', data: null })
  })

  it('requests the stats route without caching and asks for JSON', async () => {
    stubFetch({ body: { ok: true, command: 'stats', status: 'ok', data: statsData() } })
    await loadStats()
    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/stats')
    expect(calls[0].init?.cache).toBe('no-store')
    expect(JSON.stringify(calls[0].init?.headers)).toContain('application/json')
  })

  it('normalizes a malformed series instead of leaking undefined', async () => {
    // The console must get renderable arrays, not `undefined`: geometry that
    // reads `.length` on undefined crashes the pane. The keys are all present —
    // a PRESENT `daily: 'nope'` is a wrong value, not a missing field.
    stubFetch({
      body: {
        ok: true,
        command: 'stats',
        status: 'ok',
        data: statsData({ daily: 'nope', top: [{ id: 'a' }], totals: { memories: 5 } }),
      },
    })
    const got = await loadStats()
    expect(got.status).toBe('ok')
    for (const key of ['daily', 'access', 'types', 'importance', 'top'] as const) {
      expect(Array.isArray(got.data?.[key]), `${key} must always be an array`).toBe(true)
    }
    expect(got.data?.span).toEqual({ start: null, end: null })
    expect(got.data?.totals).toEqual({ memories: 5, vectors: 0, accesses: 0, inbox: 0 })
    expect(got.data?.top[0]).toEqual({ id: 'a', label: '', count: 0, untrusted: true })
  })

  it('drops a series entry that is not an object', async () => {
    stubFetch({
      body: {
        ok: true,
        command: 'stats',
        data: statsData({
          daily: [{ date: '2026-01-01', count: 2 }, null, 'x'],
          types: [{ type: 'fact', count: 3 }, 7],
        }),
      },
    })
    const got = await loadStats()
    expect(got.data?.daily).toEqual([{ date: '2026-01-01', count: 2 }])
    expect(got.data?.types).toEqual([{ type: 'fact', count: 3 }])
  })

  it('always reports untrusted:true on a top entry', async () => {
    // Corpus labels are written by other agents; the renderer keys off this flag
    // to treat them as text. A route that forgets it must not make the console
    // treat a label as trusted markup.
    stubFetch({
      body: {
        ok: true,
        command: 'stats',
        data: statsData({ top: [{ id: 'a', label: '<script>', count: 1, untrusted: false }] }),
      },
    })
    const got = await loadStats()
    expect(got.data?.top[0].untrusted).toBe(true)
  })

  it('degrades when the payload omits an expected top-level key', async () => {
    // The gap this closes: `shapeStats` normalized a MISSING field into an empty
    // series / 0, so renaming a core-side key (`daily` → `days`) rendered a
    // blank heatmap next to a non-zero `totals` — the console *saying* the vault
    // is empty. "Field missing" is a contract break, not an empty vault.
    //
    // These per-key cases lock the exact key set: a one-key guard would pass the
    // first and only. Each fixture is spelled out in full and then has ONE key
    // deleted, because `{ daily: undefined }` does not mean "no daily key" — the
    // key is still there, and `'daily' in data` is true.
    const base = statsData()
    const broken = [
      ['daily', 'daily'],
      ['access', 'access'],
      ['types', 'types'],
      ['importance', 'importance'],
      ['top', 'top'],
      ['span', 'span'],
      ['totals', 'totals'],
    ] as const
    for (const [key, drop] of broken) {
      const data: Record<string, unknown> = { ...base }
      delete data[drop]
      stubFetch({ body: { ok: true, command: 'stats', status: 'ok', data } })
      await expect(loadStats(), `missing ${key}`).resolves.toEqual({ status: 'error', data: null })
    }
  })

  it('still reports ok when the vault is genuinely empty (every key present)', async () => {
    // The boundary that makes the guard above safe. All-empty arrays plus zeros
    // is a REAL answer from an empty vault, so it must stay `ok` — treating it
    // as an error would make the console cry "degraded core" on a fresh install.
    stubFetch({
      body: {
        ok: true,
        command: 'stats',
        status: 'ok',
        data: {
          daily: [], access: [], types: [], importance: [], top: [],
          span: { start: null, end: null },
          totals: { memories: 0, vectors: 0, accesses: 0, inbox: 0 },
        },
      },
    })
    const got = await loadStats()
    expect(got.status).toBe('ok')
    expect(got.data?.daily).toEqual([])
    expect(got.data?.totals.memories).toBe(0)
  })
})

describe('useStats effect decision (pure, no renderer)', () => {
  // Same ceiling as `usePreview`: there is no renderer here, so the effect's
  // decisions are pure functions the hook MUST call, asserted directly.

  it('treats a load as live before the gate closes and dead after', () => {
    const gate = newStatsGate()
    expect(canApplyPreview(gate)).toBe(true)
    gate.dispose()
    expect(canApplyPreview(gate)).toBe(false)
  })

  it('refetches when the nonce bumps, and not otherwise', () => {
    expect(statsEffectKey(0)).not.toBe(statsEffectKey(1))
    expect(statsEffectKey(3)).toBe(statsEffectKey(3))
  })

  it('makes useStats CALL the guard: gate, one check, one cleanup', () => {
    // Without this the pure helpers above could be tested and never used, and a
    // late response would setState on an unmounted component.
    const start = SRC.indexOf('export function useStats(')
    expect(start, 'useStats not found').toBeGreaterThan(-1)
    const rest = SRC.slice(start + 1)
    const end = [rest.indexOf('export function useSearch('), rest.indexOf('export function usePreview(')]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0]
    const body = rest.slice(0, end)

    expect(body).toMatch(/newStatsGate\s*\(\)/)
    expect(body).toMatch(/canApplyPreview\s*\(\s*gate\s*\)/)
    expect(body).toMatch(/return\s+gate\.dispose/)
  })
})

describe('mutation: loadStats ok-gate and shape normalization', () => {
  it('goes red when the ok-gate is dropped so a degraded payload leaks through', async () => {
    // The mutant models the brief's draft: it trusts `body.data` whenever it is
    // present and never consults `body.ok`.
    const mutant = async function (res: { json: () => Promise<unknown> }) {
      const body = (await res.json()) as { ok?: boolean; data?: unknown }
      if (!body.data) return { status: 'error', data: null }
      return { status: 'ok', data: body.data }
    }
    const assert = function (got: { status: string; data: unknown }) {
      expect(got.status).toBe('error')
      expect(got.data).toBeNull()
    }
    const realRes = { json: async () => ({ ok: false, data: statsDataForMutation() }) }
    assert(await loadStatsWith(realRes))                       // real: passes
    await expect(async () => assert(await mutant(realRes))).rejects.toThrow() // mutant: caught
  })

  it('goes red when data:null is normalized into an empty dataset', async () => {
    const mutant = function (data: unknown) {
      return {
        status: 'ok',
        data: {
          daily: (data as { daily?: unknown[] } | null)?.daily ?? [],
          access: [], types: [], importance: [], top: [],
          span: { start: null, end: null },
          totals: { memories: 0, vectors: 0, accesses: 0, inbox: 0 },
        },
      }
    }
    const assert = function (got: { status: string; data: unknown }) {
      expect(got.status).toBe('error')
      expect(got.data).toBeNull()
    }
    const res = { json: async () => ({ ok: false, command: 'stats', status: 'error', data: null }) }
    assert(await loadStatsWith(res))                      // real: passes
    await expect(async () => assert(mutant(null))).rejects.toThrow() // mutant: caught
  })

  it('goes red when a timeout is treated as success', async () => {
    // `loadStats` must reject on an aborted transport, never resolve ok.
    const mutant = async function () { return { status: 'ok', data: null } }
    const assert = function (got: { status: string }) { expect(got.status).toBe('error') }
    const res = { json: async () => { throw new DOMException('aborted', 'AbortError') } }
    assert(await loadStatsWith(res))
    await expect(async () => assert(await mutant())).rejects.toThrow()
  })
})

describe('loadDoctor', () => {
  it('reads /doctor and keeps the issue list', async () => {
    stubFetch({ body: {
      ok: true,
      status: 'ok',
      issues: [{ severity: 'warn', code: 'index-bloat', message: 'index is 90 MB', hint: 'memory gc --apply' }],
      counts: { memories: 476, vectors: 377, conflicts: 0, inbox: 0, duplicates: 0, orphans: 2 },
    } })

    const got = await loadDoctor()

    expect(calls[0].url).toBe('/api/dsh-unified-agent-memory/doctor')
    expect(got.status).toBe('ok')
    expect(got.issues).toHaveLength(1)
    expect(got.issues[0].code).toBe('index-bloat')
    expect(got.counts?.orphans).toBe(2)
  })

  it('reports an empty list as a clean bill, not as unavailability', async () => {
    // The distinction the pane prints: a clean bill is a claim about the vault,
    // "unavailable" is a blind spot. Both arrive as zero issues.
    stubFetch({ body: { ok: true, status: 'ok', issues: [], counts: null } })
    const got = await loadDoctor()
    expect(got.status).toBe('ok')
    expect(got.issues).toEqual([])
  })

  it('treats a degraded route as unavailable, never as a clean bill', async () => {
    stubFetch({ body: { ok: false, status: 'unavailable', issues: [], counts: null } })
    const got = await loadDoctor()
    expect(got.status).toBe('unavailable')
    expect(got.counts).toBeNull()
  })

  it('treats a transport failure as unavailable', async () => {
    stubFetch({ throws: true })
    await expect(loadDoctor()).resolves.toEqual({ status: 'unavailable', issues: [], counts: null })
  })

  it('degrades an unknown severity to warn rather than dropping the finding', async () => {
    stubFetch({ body: {
      ok: true, status: 'ok',
      issues: [{ severity: 'fatal', code: 'x', message: 'm', hint: '' }],
      counts: null,
    } })
    const got = await loadDoctor()
    expect(got.issues[0].severity).toBe('warn')
  })

  it('drops an issue with neither a code nor a sentence', async () => {
    stubFetch({ body: {
      ok: true, status: 'ok',
      issues: [{ severity: 'warn' }, { code: 'ok-one', message: 'm', severity: 'info' }],
      counts: null,
    } })
    const got = await loadDoctor()
    expect(got.issues).toHaveLength(1)
    expect(got.issues[0].code).toBe('ok-one')
  })

  it('treats an ARRAY counts as absent, never as six zeroes', async () => {
    // `typeof [] === 'object'`, so a counts field that arrived as `[]` used to
    // be accepted and read through `Number([].memories) || 0` — a missing
    // reading presented as a measured 0. `null` renders as "—" in the pane; the
    // zeroes render as facts about the vault.
    stubFetch({ body: { ok: true, status: 'ok', issues: [], counts: [] } })
    const got = await loadDoctor()
    expect(got.status).toBe('ok')
    expect(got.counts).toBeNull()
  })
})
