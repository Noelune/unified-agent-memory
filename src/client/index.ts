/**
 * dsh-unified-agent-memory — browser half entry.
 *
 * Client-side module loaded by the DSH client runtime. Mounts a sidebar-footer
 * glyph that opens a small status panel (vault path, index health, pending
 * inbox count) by polling the host tool route.
 *
 * Read-only: no memory content is displayed.
 *
 * The module is compiled via esbuild with the ModuleLoader wrapper,
 * following the standard DSH client plugin pattern.
 *
 * @module src/client/index
 */

import { MemoryButton } from './Panel.tsx'

/** Client services needed: sidebar footer slot. */
export const inject: readonly string[] = []

// Sidebar seat injection — uses the global sidebar registry.
// Since the AMD ModuleLoader wrapper is added at build time, this
// client module runs in the browser context where the DSH runtime
// provides the necessary registration points.

// We mount directly into the sidebar footer seat during module evaluation.
const seats = (window as unknown as Record<string, unknown>).__DSH_SIDEBAR_SEATS__ as
  | { footer?: { action?: { mount: (opts: { id: string; render: (props: Record<string, unknown>) => unknown }) => void } } }
  | undefined

if (seats?.footer?.action) {
  seats.footer.action.mount({
    id: 'dsh-unified-agent-memory',
    render: (props: Record<string, unknown>) => MemoryButton(props as { wide?: boolean }),
  })
}