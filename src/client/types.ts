/**
 * dsh-unified-agent-memory — shared client types.
 *
 * @module src/client/types
 */

/**
 * Shape of the status route payload (`src/index.ts`).
 *
 * `latestVersion` / `updateAvailable` are null while the npm check is still in
 * flight or when it could not reach the registry, so both are modelled as
 * nullable rather than defaulted to false — "unknown" is not "no update".
 *
 * `index` / `stats` are null when the host could not read the core. They stay
 * nullable all the way to the view: absent counts render as "—", never as 0.
 */
export interface StatusPayload {
  ok?: boolean
  configured?: boolean
  vaultPath?: string
  pythonPath?: string
  corePath?: string
  remoteEnabled?: boolean
  version?: string
  latestVersion?: string | null
  updateAvailable?: boolean | null
  index?: { ok: boolean } | null
  stats?: { memories: number; vectors: number; pending: number } | null
}

/**
 * One search hit, as the panel renders it.
 *
 * `title` is usually the note stem and `snippet` the matched line, but both come
 * from a corpus written by other agents: the panel must render them as text.
 */
export interface SearchHit {
  doc: string
  title: string
  snippet: string
}

/** One row of a governance view. */
export interface PreviewItem {
  name: string
  path: string
  mtime: number
}

/** A governance view's payload. `status` distinguishes unsupported from empty. */
export interface PreviewData {
  view: string
  status: string
  count: number
  items: PreviewItem[]
}

/** The four views the core exposes. */
export type PreviewView = 'pending' | 'recent' | 'forgetting' | 'conflicts'

/** One day (or bucket) of a `daily` / `access` series. */
export interface DayCount { date: string; count: number }

/** A `types` bucket: the memory kind and how many of it. */
export interface TypeCount { type: string; count: number }

/** An `importance` bucket on the 0–1 scale. */
export interface ImportanceCount { value: number; count: number }

/**
 * One `top` entry: a corpus label, rendered as text.
 *
 * `untrusted` is always true — the labels are written by other agents, and the
 * renderer keys off this flag to avoid treating a label as trusted markup. It is
 * pinned to the literal `true` rather than `boolean` so a caller cannot pass a
 * falsy value through without a type error.
 */
export interface TopEntry { id: string; label: string; count: number; untrusted: true }

/**
 * The `/stats` aggregate payload, normalized.
 *
 * Every series is ALWAYS an array and every total is always a number: the route
 * documents this shape, but a missing or malformed field must not hand the
 * geometry helpers an `undefined` to call `.length` on. `data:null` (below) is
 * how "the core could not be read" travels — never an all-zero dataset.
 */
export interface StatsData {
  daily: DayCount[]
  access: DayCount[]
  types: TypeCount[]
  importance: ImportanceCount[]
  top: TopEntry[]
  span: { start: string | null; end: string | null }
  totals: { memories: number; vectors: number; accesses: number; inbox: number }
}

/**
 * The console's view of a stats read.
 *
 * `error` means the route reported a degraded core (`ok:false`) or the transport
 * failed; `data` is null in that case. It does NOT mean "0 memories" — an empty
 * vault yields `status:'ok'` with empty arrays, so the UI can say the right thing.
 */
export interface StatsPayload { status: 'ok' | 'loading' | 'error'; data: StatsData | null }
