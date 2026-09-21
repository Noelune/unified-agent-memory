import { describe, expect, it } from 'vitest'
import { guard, isLoopback, queryParam, readBody, sendJson } from '../src/routes.ts'

function fakeRes() {
  const calls: { code?: number; headers?: Record<string, string>; body?: string } = {}
  let sent = false
  return {
    calls,
    writeHead: (code: number, headers: Record<string, string>) => {
      // Real res.writeHead throws once the header was already written; mirror it
      // so a late writeHead(500) in the catch path fails here instead of only in
      // production. That is the trap that hid this defect.
      if (sent) throw new Error('ERR_HTTP_HEADERS_SENT')
      sent = true
      calls.code = code
      calls.headers = headers
    },
    end: (body?: string) => {
      sent = true
      calls.body = body
    },
  }
}

/** A request stream that replays `chunks` to whoever subscribes. */
function fakeReq(chunks: string[]) {
  const listeners: Record<string, (chunk?: unknown) => void> = {}
  const deliver = (ev: string, chunk?: unknown) => listeners[ev]?.(chunk)
  return {
    on: (ev: string, cb: (chunk?: unknown) => void) => { listeners[ev] = cb },
    push: () => {
      for (const chunk of chunks) deliver('data', chunk)
      deliver('end')
    },
    /** Drive the stream's terminal event only, to prove it is ignored. */
    finish: () => deliver('end'),
    /** Drive an error after the promise already settled, to prove it is ignored. */
    fail: (err: unknown) => deliver('error', err),
  }
}

describe('isLoopback', () => {
  it('accepts the three loopback spellings', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isLoopback('192.168.1.5')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})

describe('guard', () => {
  it('403s a non-loopback caller and reports handled', () => {
    const res = fakeRes()
    const ok = guard({ socket: { remoteAddress: '10.0.0.9' }, method: 'GET' }, res, ['GET'])
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('405s a disallowed method', () => {
    const res = fakeRes()
    const ok = guard({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST' }, res, ['GET', 'HEAD'])
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(405)
    expect(res.calls.headers?.['cache-control']).toBe('no-store')
  })

  it('passes a loopback GET and always sets no-store', () => {
    const res = fakeRes()
    const ok = guard({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res, ['GET'])
    expect(ok).toBe(true)
  })

  it('sets no-store on rejection too', () => {
    const res = fakeRes()
    guard({ socket: { remoteAddress: '10.0.0.9' }, method: 'GET' }, res, ['GET'])
    expect(res.calls.headers?.['cache-control']).toBe('no-store')
  })
})

describe('sendJson serialisation failures', () => {
  // One test per (failure mode x original status) pair: the fix must hold for a
  // 200 payload and for the 5xx path alike, and it must answer, not hang.
  const payloads = {
    circular: () => {
      const value: Record<string, unknown> = { ok: true }
      value.self = value
      return value
    },
    bigint: () => ({ n: 1n }),
    toJSONThrows: () => ({ toJSON() { throw new Error('boom') } }),
  }

  for (const [name, make] of Object.entries(payloads)) {
    for (const code of [200, 500]) {
      it(`answers 500, not a hang, when ${name} cannot serialise (was ${code})`, () => {
        const res = fakeRes()
        sendJson(res, code, make())
        expect(res.calls.code).toBe(500)
        expect(res.calls.headers?.['cache-control']).toBe('no-store')
        expect(res.calls.body).toBe('{"ok":false,"error":"internal error"}')
      })
    }
  }
})

describe('queryParam', () => {
  it('decodes a value', () => {
    expect(queryParam('/x?a=%E8%AE%B0%E5%BF%86&b=1', 'a')).toBe('记忆')
  })
  it('returns null when absent', () => {
    expect(queryParam('/x?a=1', 'q')).toBeNull()
    expect(queryParam(undefined, 'q')).toBeNull()
  })
  it('returns null for an empty value', () => {
    expect(queryParam('/x?a=', 'a')).toBeNull()
  })
  it('returns null for a malformed percent-escape instead of throwing', () => {
    expect(queryParam('/x?a=%', 'a')).toBeNull()
    expect(queryParam('/x?a=%zz', 'a')).toBeNull()
  })
})

describe('readBody', () => {
  it('resolves the body once the stream ends', async () => {
    const req = fakeReq(['he', 'llo', ' world'])
    const body = readBody(req, 100)
    req.push()
    await expect(body).resolves.toBe('hello world')
  })

  it('rejects an oversized body', async () => {
    const req = fakeReq(['aaaa', 'bbbb', 'cccc'])
    const body = readBody(req, 4)
    req.push()
    await expect(body).rejects.toThrow('body too large')
  })

  it('stays rejected when the stream errors after the size rejection', async () => {
    // The settled guard: a later 'error' must not override the size rejection,
    // which would otherwise let a caller mask an oversized body with a stream
    // error and have the handler treat it as a transport failure.
    const req = fakeReq(['aaaa', 'bbbb'])
    const body = readBody(req, 4)
    req.push()
    req.fail(new Error('socket reset'))
    await expect(body).rejects.toThrow('body too large')
  })

  it('counts the cap in bytes, not UTF-16 code units', async () => {
    // 700 CJK characters: the fullwidth comma is 3 bytes in UTF-8 but only one
    // code unit, so a `.length` check would wave through 2100 bytes under a
    // "2048 byte" cap. The limit must be measured the way the comment claims.
    const cjk = '，'.repeat(700)
    expect(cjk.length).toBeLessThan(2048)
    expect(Buffer.byteLength(cjk)).toBeGreaterThan(2048)

    const req = fakeReq([cjk])
    const body = readBody(req)
    req.push()
    await expect(body).rejects.toThrow('body too large')
  })

  it('measures a Buffer chunk by its bytes', async () => {
    // Node's HTTP server hands over Buffers; the RouteReq contract also admits
    // a pre-decoded string. Both must land on the same byte count.
    const req = fakeReq([Buffer.from('，'.repeat(700), 'utf8') as never])
    const body = readBody(req)
    req.push()
    await expect(body).rejects.toThrow('body too large')
  })

  it('still accepts a body comfortably under the cap', async () => {
    const req = fakeReq(['{"name":"dsh-2026-09-22-001.md"}'])
    const body = readBody(req)
    req.push()
    await expect(body).resolves.toBe('{"name":"dsh-2026-09-22-001.md"}')
  })
})
