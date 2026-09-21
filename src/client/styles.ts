/**
 * dsh-unified-agent-memory — browser half styles (CSS-in-JS).
 *
 * Every custom property is a DSH alias token (--dsw-*) so the panel tracks
 * the host theme instead of hard-coding colours. Each mount owns its own
 * <style> tag, so the rail and the wide sidebar can render simultaneously
 * without disposing each other's stylesheet.
 *
 * @module src/client/styles
 */

export const PANEL_CSS = `
.dsh-memory-trigger {
  width: 36px; height: 36px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer; background: none; border: none;
  border-radius: 18px; flex: none;
  justify-content: center; align-items: center;
  padding: 0 6px; gap: 6px;
  font-family: inherit; font-size: 13px;
  transition: background-color .12s, color .12s;
  display: inline-flex;
}
.dsh-memory-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-trigger[data-open="true"] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
/* shell.overlay is a click-through floating layer: entries must opt back into
   pointer events or every click falls through to the app underneath. The
   wrapper is transparent and only the sheet inside it is interactive. */
.dsh-memory-layer {
  pointer-events: none;
}
.dsh-memory-sheet {
  /* Frame-wide overlay cell: anchored to the viewport corner so it can never
     grow out of the screen, and clamped to the viewport on small windows. */
  position: fixed; z-index: 1000;
  bottom: 12px; left: 12px;
  pointer-events: auto;
  width: min(380px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv2);
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.dsh-memory-head {
  display: flex; align-items: baseline; gap: 8px;
  padding-bottom: 2px;
}
.dsh-memory-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.dsh-memory-ver { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-memory-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 11px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dsh-memory-card-title {
  font-size: 11px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-kv { display: flex; justify-content: space-between; gap: 10px; }
.dsh-memory-kv .k { color: var(--dsw-alias-label-secondary); flex: none; }
.dsh-memory-kv .v {
  color: var(--dsw-alias-label-primary);
  text-align: right; word-break: break-all;
  font-variant-numeric: tabular-nums;
}
.dsh-memory-stats { display: flex; gap: 8px; }
.dsh-memory-stat {
  flex: 1; display: flex; flex-direction: column; gap: 2px;
  align-items: flex-start;
}
.dsh-memory-stat .n {
  font-size: 18px; font-weight: 600; line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.dsh-memory-stat .l { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.dsh-memory-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 8px; border-radius: 7px; font-size: 12px;
  background: var(--dsw-alias-err-bg); color: var(--dsw-alias-err);
}
.dsh-memory-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-ok);
}
.dsh-memory-dot[data-state="warn"] { background: var(--dsw-alias-warn); }
.dsh-memory-dot[data-state="err"] { background: var(--dsw-alias-err); }
.dsh-memory-note {
  font-size: 11px; color: var(--dsw-alias-label-tertiary);
  line-height: 1.4;
}
`

let styleSeq = 0

export function adoptStyles(): () => void {
  const token = String(++styleSeq)
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  style.setAttribute('data-dsh-memory', token)
  document.head.appendChild(style)
  return () => {
    const el = document.head.querySelector(`style[data-dsh-memory='${token}']`)
    if (el) el.remove()
  }
}
