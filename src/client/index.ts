/**
 * dsh-unified-agent-memory — browser half entry.
 *
 * A DSH client module is a Cordis plugin: the ModuleLoader factory must return
 * `{ name, inject, apply }`, and the client runtime registers it with
 * `registry.plugin()`. Anything that only runs for its side effects at module
 * evaluation time exports no `apply`, so the loader rejects it with
 * `invalid plugin, expect function or object with an "apply" method`.
 *
 * UI is contributed through the `slots` service — this module takes the
 * additive `sidebar.footer.action` seat beside Settings and renders the memory
 * status trigger there. Per the client contract, no `window` globals or
 * hard-coded product DOM are touched; the component owns its own styles.
 *
 * Read-only: no memory content is displayed.
 *
 * @module src/client/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryButton } from './Panel.tsx'

export const name = 'dsh-unified-agent-memory'

/**
 * Required client services.
 *
 * `slots` owns every UI extension point. It is injected rather than read off
 * the global realm so the module also loads cleanly in hosts without a
 * sidebar (headless / mobile shells) — see the guard in {@link apply}.
 */
export const inject: readonly string[] = ['slots']

/** Additive action seat beside Settings in the sidebar foot. */
const SLOT = 'sidebar.footer.action'

/** Registrant id within the slot; keeps the seat stable across reloads. */
const SEAT_ID = 'dsh-unified-agent-memory'

/** Minimal shape of the client `slots` service used here. */
interface SlotsService {
  /** Defer registration until the slot exists, disposing it with the plugin. */
  inject(name: string, callback: () => void | (() => void)): unknown
  /** Occupy a seat with a component; returns the disposer. */
  register(entry: { name: string; id: string }, component: unknown): () => void
}

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots?: SlotsService }).slots
  // No slot registry in this host (e.g. a headless or non-sidebar shell):
  // the plugin still loads, it just contributes no client UI.
  if (!slots) return

  slots.inject(SLOT, () => slots.register(
    { name: SLOT, id: SEAT_ID },
    MemoryButton,
  ))
}
