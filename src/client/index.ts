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
import { MemoryOverlay, MemoryTrigger } from './Panel.tsx'

export const name = 'dsh-unified-agent-memory'

/**
 * Required client services.
 *
 * `slots` owns every UI extension point. It is injected rather than read off
 * the global realm so the module also loads cleanly in hosts without a
 * sidebar (headless / mobile shells) — see the guard in {@link apply}.
 */
export const inject: readonly string[] = ['slots']

/**
 * Small inline action beside Settings. Per the DSH plugin contract this seat
 * is only for a compact entry point, which is exactly what the trigger is.
 */
const TRIGGER_SLOT = 'sidebar.footer.action'

/**
 * Frame-wide floating layer, above every column and outside their scroll
 * containers. A `list` slot with `replaceRisk: none`, so a fresh id is added
 * beside the shipped entries. This — not the inline action seat — is where a
 * 380px floating sheet belongs.
 */
const OVERLAY_SLOT = 'shell.overlay'

/** Registrant id within the footer slot; keeps the seat stable across reloads. */
const SEAT_ID = 'dsh-unified-agent-memory'

/** Distinct cell key in the overlay; a fresh id never replaces a shipped entry. */
const OVERLAY_ID = 'dsh-unified-agent-memory-sheet'

/** Minimal shape of the client `slots` service used here. */
interface SlotsService {
  /** Defer registration until the slot exists, disposing it with the plugin. */
  inject(name: string, callback: () => void | (() => void)): unknown
  /** Occupy a seat with a component; returns the disposer. */
  register(
    entry: { name: string; id: string; order?: number },
    component: unknown,
  ): () => void
}

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots?: SlotsService }).slots
  // No slot registry in this host (e.g. a headless or non-sidebar shell):
  // the plugin still loads, it just contributes no client UI.
  if (!slots) return

  slots.inject(TRIGGER_SLOT, () => slots.register(
    { name: TRIGGER_SLOT, id: SEAT_ID },
    MemoryTrigger,
  ))

  slots.inject(OVERLAY_SLOT, () => slots.register(
    { name: OVERLAY_SLOT, id: OVERLAY_ID },
    MemoryOverlay,
  ))
}
