/**
 * Unit tests for the `/doc` shaper and argv builder.
 *
 * `/doc` wraps the core's `show --json`, and the whole reason the route exists
 * is that a search hit's file name has to become READABLE. The two ways that
 * goes wrong are silent:
 *
 *   - a miss is reported as a dead core (so the user retries a note that is
 *     actually gone, or goes looking at the wrong thing), and
 *   - the `untrusted` marker is dropped on the way out (so a consumer treats
 *     vault text as instructions).
 *
 * Both are asserted here on the shape, and again on the wire in
 * `route-doc-route.test.ts`, because a shaper can be right while the handler
 * answers from a different branch.
 *
 * @module test/route-doc.test
 */

import { describe, it, expect } from 'vitest'
import { DOC_PATH, buildDocArgs, shapeDocResult } from '../src/route-doc.ts'

describe('buildDocArgs', () => {
  it('reads a note through show, in JSON mode', () => {
    expect(buildDocArgs('我的偏好摘要.md')).toEqual(['show', '我的偏好摘要.md', '--json'])
  })

  it('passes the name as ONE argv element, so a space cannot split it', () => {
    // runCore uses execFile, never a shell — but the name still has to arrive as
    // a single argument, and a test that only ever passes a CJK filename with no
    // space would not notice a `join(' ')` regression.
    const args = buildDocArgs('note draft.md')
    expect(args).toHaveLength(3)
    expect(args[1]).toBe('note draft.md')
  })
})

describe('shapeDocResult', () => {
  const envelope = (data: Record<string, unknown>) => JSON.stringify({
    ok: true, command: 'show', data,
  })

  it('unwraps a readable note, keeping path and body', () => {
    const got = shapeDocResult(envelope({
      name: '工程执行规则.md',
      path: '/vault/50-Agent-Context/工程执行规则.md',
      body: '# 规则\n- 先跑测试\n',
      reason: null,
      untrusted: true,
    }))
    expect(got).toEqual({
      ok: true,
      name: '工程执行规则.md',
      path: '/vault/50-Agent-Context/工程执行规则.md',
      body: '# 规则\n- 先跑测试\n',
      reason: null,
      untrusted: true,
    })
  })

  it('keeps not-found distinct from a dead core', () => {
    // The core answers ok:true with body:null + reason so a miss exits 0 and its
    // reason survives the subprocess. `ok` here tracks the TRANSPORT, and
    // `reason` is what the panel turns into a sentence.
    const got = shapeDocResult(envelope({
      name: null, path: null, body: null, reason: 'not-found',
    }))
    expect(got.ok).toBe(true)
    expect(got.body).toBeNull()
    expect(got.reason).toBe('not-found')
    expect(got.untrusted).toBe(true)
  })

  it('keeps invalid-name distinct from not-found', () => {
    const got = shapeDocResult(envelope({
      name: null, path: null, body: null, reason: 'invalid-name',
    }))
    expect(got.reason).toBe('invalid-name')
  })

  it('reports a malformed envelope as unavailable, not as a missing note', () => {
    // Garbage on stdout is a broken core conversation; calling it `not-found`
    // would send the user looking for a file that may well exist.
    for (const raw of ['', 'not json', '{"ok":false}', '{"ok":true}']) {
      const got = shapeDocResult(raw)
      expect(got.ok, raw).toBe(false)
      expect(got.reason, raw).toBe('unavailable')
      expect(got.body, raw).toBeNull()
    }
  })

  it('never types a non-string body as text', () => {
    const got = shapeDocResult(envelope({ name: 'a.md', body: 42 }))
    expect(got.body).toBeNull()
  })

  it('marks every record untrusted on both paths', () => {
    // §2: the body is vault text written by other agents. A consumer that sees
    // the marker treats it as DATA. The type is literal `true`, so a future
    // edit cannot quietly pass `false`.
    expect(shapeDocResult(envelope({ name: 'a.md', body: 'x' })).untrusted).toBe(true)
    expect(shapeDocResult('broken').untrusted).toBe(true)
  })
})

describe('DOC_PATH', () => {
  it('sits under the plugin API prefix the host exposes', () => {
    expect(DOC_PATH).toBe('/api/dsh-unified-agent-memory/doc')
  })

  it('is not the inbox reader', () => {
    // `/note` reads 提交区 and refuses a canonical note. Pointing the search
    // pane at it would make every open fail with `outside-inbox`, which reads
    // like a vault problem rather than a wrong endpoint.
    expect(DOC_PATH).not.toBe('/api/dsh-unified-agent-memory/note')
  })
})
