import { describe, expect, it } from 'vitest'
import { guard, isLoopback, queryParam, sendJson } from '../src/routes.ts'

function fakeRes() {
  const calls: { code?: number; headers?: Record<string, string>; body?: string } = {}
  return {
    calls,
    writeHead: (code: number, headers: Record<string, string>) => {
      calls.code = code
      calls.headers = headers
    },
    end: (body?: string) => { calls.body = body },
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

describe('sendJson', () => {
  it('writes serialised JSON with no-store', () => {
    const res = fakeRes()
    sendJson(res, 200, { ok: true })
    expect(res.calls.code).toBe(200)
    expect(res.calls.headers?.['cache-control']).toBe('no-store')
    expect(res.calls.body).toBe('{"ok":true}')
  })
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
})
