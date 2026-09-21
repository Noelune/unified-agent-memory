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
