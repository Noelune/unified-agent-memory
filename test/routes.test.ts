import { describe, expect, it } from 'vitest'
import {
  guard,
  guardWrite,
  isLoopback,
  isLoopbackHost,
  originHost,
  queryParam,
  readBody,
  sendJson,
} from '../src/routes.ts'

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

describe('isLoopbackHost', () => {
  // The Host header is what DNS rebinding cannot hide (see guardWrite): the
  // attacker's name rides in it even after its DNS answer flips to 127.0.0.1.
  it('accepts the loopback spellings, with or without a port and in any case', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.1:3081')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('localhost:3081')).toBe(true)
    expect(isLoopbackHost('LOCALHOST:3081')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('[::1]:3081')).toBe(true)
  })

  it('rejects a foreign name, even one wearing a loopback port', () => {
    expect(isLoopbackHost('evil.com')).toBe(false)
    expect(isLoopbackHost('evil.com:3081')).toBe(false)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1:3081.evil.com')).toBe(false)
  })

  it('rejects a missing or empty Host', () => {
    expect(isLoopbackHost(undefined)).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })

  it('rejects a non-loopback address literal', () => {
    expect(isLoopbackHost('10.0.0.9')).toBe(false)
    expect(isLoopbackHost('10.0.0.9:3081')).toBe(false)
    expect(isLoopbackHost('[::2]:3081')).toBe(false)
  })
})

describe('originHost', () => {
  it('reads the host of a well-formed origin, lower-cased and port included', () => {
    expect(originHost('http://127.0.0.1:3081')).toBe('127.0.0.1:3081')
    expect(originHost('https://EVIL.example.com/page')).toBe('evil.example.com')
    expect(originHost('http://[::1]:3081')).toBe('[::1]:3081')
  })

  it('returns null for a malformed value rather than a guess', () => {
    expect(originHost('not a url')).toBeNull()
    expect(originHost('')).toBeNull()
  })

  it('does not fold a backslash into the authority (F-1)', () => {
    // WHATWG URL treats `\` as `/` under http(s), so `...:3081\.evil.com` parses
    // to host `127.0.0.1:3081` — the loopback authority — even though the raw
    // value names another host. The prefilter that used to guard this let the
    // backslash through, so a same-origin compare was satisfied and the write
    // was admitted. The parse must never present that value as the loopback host.
    expect(originHost('http://127.0.0.1:3081\\.evil.com')).not.toBe('127.0.0.1:3081')
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

describe('guardWrite', () => {
  /** A loopback POST carrying exactly the headers under test. */
  function writeReq(headers: Record<string, string>, method = 'POST') {
    return { socket: { remoteAddress: '127.0.0.1' }, method, headers }
  }

  it('allows a same-origin localhost write', () => {
    const res = fakeRes()
    const ok = guardWrite(
      writeReq({ origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081' }),
      res,
    )
    expect(ok).toBe(true)
  })

  it('allows the localhost and [::1] spellings when they match the Host', () => {
    expect(
      guardWrite(
        writeReq({ origin: 'http://localhost:3081', host: 'localhost:3081' }),
        fakeRes(),
      ),
    ).toBe(true)
    expect(
      guardWrite(writeReq({ origin: 'http://[::1]:3081', host: '[::1]:3081' }), fakeRes()),
    ).toBe(true)
  })

  it('403s when the Origin names a different local spelling than the Host', () => {
    // `127.0.0.1` and `localhost` are different origins even though both are
    // loopback: an exact compare is what makes the rebinding case below work.
    const res = fakeRes()
    expect(
      guardWrite(
        writeReq({ origin: 'http://localhost:3081', host: '127.0.0.1:3081' }),
        res,
      ),
    ).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('403s a cross-site Origin and reports handled', () => {
    const res = fakeRes()
    const ok = guardWrite(writeReq({ origin: 'https://evil.example.com' }), res)
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
    expect(res.calls.headers?.['cache-control']).toBe('no-store')
  })

  it('403s when Origin is local but the Host is a rebinding name', () => {
    // DNS rebinding: the browser is told the page IS on 127.0.0.1, so it sends
    // `Origin: http://127.0.0.1:3081`, but the attacker's own DNS name rides in
    // the Host header. Comparing the two catches it.
    const res = fakeRes()
    const ok = guardWrite(
      writeReq({ origin: 'http://127.0.0.1:3081', host: 'evil.example.com' }),
      res,
    )
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('403s a rebinding request whose Origin and Host agree on the attacker name', () => {
    // The case the first pass missed. Rebinding's whole point is that the page
    // and the target LOOK same-origin, so Origin == Host == evil.com — a
    // same-origin compare is satisfied and lets the write through. Only
    // "Host must be loopback" catches it; Origin never can.
    const res = fakeRes()
    const ok = guardWrite(writeReq({ origin: 'http://evil.com', host: 'evil.com' }), res)
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
    expect(res.calls.headers?.['cache-control']).toBe('no-store')
    expect(JSON.parse(res.calls.body!)).toEqual({ ok: false, error: 'forbidden: cross-site write' })
  })

  it('403s the same agreeing-Origin rebinding request when Sec-Fetch-Site is absent', () => {
    const res = fakeRes()
    const ok = guardWrite(
      writeReq({ origin: 'http://evil.com', host: 'evil.com:3081' }),
      res,
    )
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('403s a bare rebinding request that only carries a foreign Host', () => {
    // No Origin, no Sec-Fetch-Site, no Referer: the carve-out for headerless
    // local clients must not become a blanket pass for any Host.
    const res = fakeRes()
    const ok = guardWrite(writeReq({ host: 'evil.com' }), res)
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('403s a headerless request that does not carry a local Host at all', () => {
    // A request with NO Host header is not a local browser request either.
    expect(guardWrite(writeReq({}), fakeRes())).toBe(false)
  })

  it('allows the local loopback Host spellings with a matching Origin', () => {
    expect(
      guardWrite(writeReq({ host: '127.0.0.1:3081', origin: 'http://127.0.0.1:3081' }), fakeRes()),
    ).toBe(true)
    expect(
      guardWrite(writeReq({ host: 'localhost:3081', origin: 'http://localhost:3081' }), fakeRes()),
    ).toBe(true)
    expect(
      guardWrite(writeReq({ host: '[::1]:3081', origin: 'http://[::1]:3081' }), fakeRes()),
    ).toBe(true)
  })

  it('allows a local loopback Host with Sec-Fetch-Site and no Origin', () => {
    expect(
      guardWrite(writeReq({ host: '127.0.0.1:3081', 'sec-fetch-site': 'same-origin' }), fakeRes()),
    ).toBe(true)
    expect(
      guardWrite(writeReq({ host: 'localhost:3081', 'sec-fetch-site': 'none' }), fakeRes()),
    ).toBe(true)
  })

  it('403s a foreign Host even when Sec-Fetch-Site claims same-origin', () => {
    // Sec-Fetch-Site is attacker-controllable in a hand-rolled client, so the
    // Host fence must not be bypassable by claiming a benign fetch context.
    const res = fakeRes()
    const ok = guardWrite(
      writeReq({ host: 'evil.com', 'sec-fetch-site': 'same-origin' }),
      res,
    )
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('allows Origin that matches the Host it was sent to', () => {
    const res = fakeRes()
    const ok = guardWrite(
      writeReq({ origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081' }),
      res,
    )
    expect(ok).toBe(true)
  })

  it('403s a cross-site Sec-Fetch-Site when Origin is absent', () => {
    const res = fakeRes()
    const ok = guardWrite(writeReq({ 'sec-fetch-site': 'cross-site' }), res)
    expect(ok).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it.each(['same-origin', 'none', 'SAME-ORIGIN'])(
    'allows Sec-Fetch-Site: %s when Origin is absent',
    (site) => {
      expect(
        guardWrite(writeReq({ host: '127.0.0.1:3081', 'sec-fetch-site': site }), fakeRes()),
      ).toBe(true)
    },
  )

  it('allows a headerless caller — the local CLI shape', () => {
    // Every real HTTP client sends Host (curl sends `127.0.0.1:3081`); the shape
    // under test is "no Origin, no Sec-Fetch-Site, no Referer" against a loopback
    // Host. A request with no Host at all is a different case, tested above.
    expect(guardWrite(writeReq({ host: '127.0.0.1:3081' }), fakeRes())).toBe(true)
  })

  it('403s a same-site (not same-origin) fetch', () => {
    // `same-site` means a different origin on the same registrable domain: a
    // sibling subdomain can still be attacker-controlled, so it is not enough.
    const res = fakeRes()
    expect(
      guardWrite(writeReq({ host: '127.0.0.1:3081', 'sec-fetch-site': 'same-site' }), res),
    ).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('fails closed on an unparseable Origin', () => {
    const res = fakeRes()
    expect(guardWrite(writeReq({ origin: 'not a url' }), res)).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('rejects a cross-site Referer when Origin is absent but Referer points off-host', () => {
    // Referer is a supplementary signal only: absent is fine, but a Referer that
    // is present and demonstrably cross-site is a rejection, not a pass.
    const res = fakeRes()
    expect(guardWrite(writeReq({ referer: 'https://evil.example.com/page' }), res)).toBe(false)
    expect(res.calls.code).toBe(403)
  })

  it('still applies the loopback and method checks it inherits from guard', () => {
    const remote = fakeRes()
    expect(
      guardWrite(
        { socket: { remoteAddress: '203.0.113.7' }, method: 'POST', headers: {} },
        remote,
      ),
    ).toBe(false)
    expect(remote.calls.code).toBe(403)

    const method = fakeRes()
    expect(guardWrite(writeReq({}, 'GET'), method)).toBe(false)
    expect(method.calls.code).toBe(405)
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
