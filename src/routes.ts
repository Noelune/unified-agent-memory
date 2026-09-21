/**
 * Shared HTTP plumbing for the admin routes.
 *
 * Every route in this plugin is read-only and local, so the same three rules
 * apply everywhere and live here once: only the loopback interface may call,
 * only an allow-listed method is accepted, and nothing is ever cached — a
 * cached panel reading is a stale panel reading.
 */

export interface RouteReq {
  socket?: { remoteAddress?: string }
  method?: string
  url?: string
  on?: (ev: string, cb: (chunk?: unknown) => void) => void
}

export interface RouteRes {
  writeHead: (code: number, headers: Record<string, string>) => void
  end: (body?: string) => void
}

/** Response headers for every JSON answer this plugin produces. */
export const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * True when the caller is on this machine.
 *
 * An absent address is treated as NOT loopback: the payload carries local
 * filesystem paths, so failing closed is the only safe default when the
 * socket cannot tell us who is there.
 */
export function isLoopback(remote: string | undefined): boolean {
  return remote !== undefined && LOOPBACK.has(remote)
}

/**
 * Apply the shared baseline. Returns false when the request was already
 * answered (403 or 405); the caller must then return without writing more.
 */
export function guard(req: RouteReq, res: RouteRes, allowed: readonly string[]): boolean {
  if (!isLoopback(req.socket?.remoteAddress)) {
    res.writeHead(403, JSON_HEADERS)
    res.end('{"ok":false,"error":"forbidden: loopback-only"}')
    return false
  }
  const method = req.method ?? 'GET'
  if (!allowed.includes(method)) {
    res.writeHead(405, JSON_HEADERS)
    res.end('{"ok":false,"error":"method not allowed"}')
    return false
  }
  return true
}

/** Serialise and send. A circular payload degrades to a 500, never a hang. */
export function sendJson(res: RouteRes, code: number, body: unknown): void {
  try {
    res.writeHead(code, JSON_HEADERS)
    res.end(JSON.stringify(body))
  } catch {
    res.writeHead(500, JSON_HEADERS)
    res.end('{"ok":false,"error":"internal error"}')
  }
}

/** One decoded query parameter, or null when absent or empty. */
export function queryParam(url: string | undefined, key: string): string | null {
  if (!url) return null
  const q = url.indexOf('?')
  if (q < 0) return null
  for (const pair of url.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (decodeURIComponent(pair.slice(0, eq)) !== key) continue
    const value = decodeURIComponent(pair.slice(eq + 1))
    return value === '' ? null : value
  }
  return null
}

/** Cap on an accepted request body: these are one short filename. */
const MAX_BODY = 2048

/** Read a request body, refusing anything oversized. */
export function readBody(req: RouteReq, limit: number = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== 'function') {
      resolve('')
      return
    }
    let data = ''
    req.on('data', (chunk) => {
      data += String(chunk ?? '')
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
