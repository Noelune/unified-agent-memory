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
  headers?: Record<string, string | string[] | undefined>
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
 * True when a `Host` header names this machine.
 *
 * This is the DNS-rebinding fence, and it is the *only* one that works: rebinding
 * makes the attacker's page and the target look same-origin, so both `Origin` and
 * `Host` read `evil.com` and any "is Origin equal to Host" compare is satisfied.
 * What the attacker cannot do is make the browser send a Host that is *us* while
 * talking to their own name — so the Host value itself is the signal.
 *
 * Accepts `127.0.0.1`, `localhost` and `[::1]`, with or without a port, in any
 * case; anything else — including a name that merely *contains* a loopback
 * spelling (`127.0.0.1.evil.com`, `localhost.evil.com`) — is rejected. A missing
 * or empty Host is not loopback: a real local browser request always carries one,
 * so failing closed costs nothing and keeps a hand-rolled client from opting out.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const value = host.trim().toLowerCase()
  // `[::1]:3081` -> `[::1]`; `127.0.0.1:3081` -> `127.0.0.1`. Only a trailing
  // `:port` is stripped, so `[::1]` keeps the brackets that make it unambiguous.
  const name = /^(\[[^\]]*\])(?::\d+)?$/.test(value)
    ? value.slice(0, value.indexOf(']') + 1)
    : value.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
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

/**
 * Same-origin extraction for one header value, or null when it is unusable.
 *
 * Used for `Origin` and `Referer` alike: both are `scheme://host[:port]/...`, so
 * the same parse answers both. A *malformed* value yields null, which the caller
 * treats as a rejection — fail-closed, because an attacker fully controls the
 * bytes of both headers and a parse failure is their best way to slip past.
 */
function originHost(value: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value.trim())
  if (!match) return null
  try {
    return new URL(value.trim()).host.toLowerCase()
  } catch {
    return null
  }
}

/** The first value when a header arrives duplicated; Node may hand over an array. */
function headerValue(req: RouteReq, name: string): string | undefined {
  const raw = req.headers?.[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * `guard` plus a cross-site check, for the ONE mutating route.
 *
 * Why the extra check exists: our routes are registered `kind: 'exact'` and the
 * host's `match()` consults the exact table *before* its `/api` prefix, so an
 * exact route never reaches the host's own Host-fence + cookie auth. A hostile
 * page therefore reaches this handler with `remoteAddress` still `127.0.0.1`,
 * which `guard` alone waves through — the loopback check was never a CSRF
 * defence. Read routes deliberately keep `guard` only: an agent running curl
 * against the local memory store is a supported use, and nothing there writes.
 *
 * Two distinct attacks, two distinct fences, and the order matters:
 *
 *   - **DNS rebinding** is stopped by `isLoopbackHost` alone, and ONLY by it.
 *     After the attacker's DNS answer flips to 127.0.0.1 the page and the target
 *     look same-origin, so the browser sends `Origin: http://evil.com` *and*
 *     `Host: evil.com` — `origin === host` is satisfied and waves it through.
 *     (An earlier revision compared those two and claimed rebinding solved; it
 *     was not, and a probe showed `Origin=evil.com, Host=evil.com` allowed.)
 *     Rebinding cannot fake a loopback `Host`, so that check is the fence.
 *   - **CSRF** needs the Origin/Sec-Fetch-Site/Referer layer below, because its
 *     `Host` is genuinely `127.0.0.1:3081` and the rebinding fence passes it.
 *
 * Decision order (fail-closed throughout):
 *
 *   1. `Host` must name this machine — `127.0.0.1` / `localhost` / `[::1]`, any
 *      port, any case. Anything else, including an absent Host, is a 403.
 *   2. `Origin` present -> must be same-origin with the request's own Host.
 *      Cross-site or unparseable is a 403.
 *   3. No `Origin` -> `Sec-Fetch-Site`. `same-origin` / `none` pass; everything
 *      else (`cross-site`, `same-site`) is a 403.
 *   4. Neither present -> allowed. This is the deliberate carve-out: no browser
 *      has sent either header, so the caller is a local CLI (curl, another
 *      agent) and refusing would break the documented read/write tooling. It is
 *      still gated on rule 1, so it is "a local CLI talking to a local Host",
 *      never a blanket pass. `ponytail:` the ceiling is exactly that — a minimal
 *      hand-rolled HTTP client that sends a loopback Host and neither header is
 *      indistinguishable from curl and gets through. Closing it needs a shared
 *      secret between plugin and browser client, which the CLI path cannot
 *      supply.
 *   5. `Referer` is consulted only when `Origin` is absent: present and
 *      off-host is a 403 (a supplement, never the sole basis for admission).
 */
export function guardWrite(req: RouteReq, res: RouteRes, allowed: readonly string[] = ['POST']): boolean {
  if (!guard(req, res, allowed)) return false

  const deny = () => {
    res.writeHead(403, JSON_HEADERS)
    res.end('{"ok":false,"error":"forbidden: cross-site write"}')
    return false
  }

  const host = headerValue(req, 'host')
  // The rebinding fence, and it comes first: nothing below can distinguish a
  // rebound request, because a rebound request looks same-origin by design.
  if (!isLoopbackHost(host)) return deny()
  const local = host!.toLowerCase()

  const origin = headerValue(req, 'origin')
  if (origin !== undefined) {
    const from = originHost(origin)
    return from !== null && from === local ? true : deny()
  }

  const site = headerValue(req, 'sec-fetch-site')?.toLowerCase()
  if (site !== undefined) return site === 'same-origin' || site === 'none' ? true : deny()

  const referer = headerValue(req, 'referer')
  if (referer !== undefined) {
    const from = originHost(referer)
    if (from === null || from !== local) return deny()
  }

  // No Origin, no Sec-Fetch-Site (and no usable Referer): local non-browser
  // client, already proven to be addressing a loopback Host. Fail-open here, by
  // explicit product decision — see the ceiling note.
  return true
}

/**
 * Serialise and send. A payload that cannot serialise (circular reference,
 * BigInt, a throwing `toJSON`) degrades to a 500, never a hang.
 *
 * Serialisation MUST happen before the first `writeHead`: once a status line is
 * on the wire the headers are committed, so a late `writeHead(500)` in the
 * catch block would throw `ERR_HTTP_HEADERS_SENT` and leave the client with no
 * response at all — and a status already sent as 2xx cannot be taken back.
 */
export function sendJson(res: RouteRes, code: number, body: unknown): void {
  let text: string
  try {
    text = JSON.stringify(body)
  } catch {
    res.writeHead(500, JSON_HEADERS)
    res.end('{"ok":false,"error":"internal error"}')
    return
  }
  res.writeHead(code, JSON_HEADERS)
  res.end(text)
}

/** One decoded query parameter, or null when absent, empty or undecodable. */
export function queryParam(url: string | undefined, key: string): string | null {
  if (!url) return null
  const q = url.indexOf('?')
  if (q < 0) return null
  for (const pair of url.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    try {
      if (decodeURIComponent(pair.slice(0, eq)) !== key) continue
      const value = decodeURIComponent(pair.slice(eq + 1))
      return value === '' ? null : value
    } catch {
      // A malformed escape (`?a=%`, `?a=%zz`) is caller-supplied garbage, not a
      // server fault: treat it as absent instead of throwing into the handler.
      continue
    }
  }
  return null
}

/** Cap on an accepted request body: these are one short filename. */
const MAX_BODY = 2048

/**
 * Read a request body, refusing anything oversized.
 *
 * The cap is counted in **bytes**, not UTF-16 code units: a CJK body is up to
 * three bytes per character, so a `.length` check would let 2–3× the intended
 * payload through. Chunks arrive as Buffer under Node's HTTP server, but the
 * `RouteReq.on` contract also admits a pre-decoded string, so each chunk is
 * normalised before measuring.
 */
export function readBody(req: RouteReq, limit: number = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof req.on !== 'function') {
      resolve('')
      return
    }
    let data = ''
    let bytes = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      const text = String(chunk ?? '')
      data += text
      bytes += Buffer.byteLength(text)
      if (bytes > limit) {
        settled = true
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(data)
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
