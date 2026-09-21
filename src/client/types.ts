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
