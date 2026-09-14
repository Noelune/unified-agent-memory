/**
 * dsh-unified-agent-memory — browser half styles (CSS-in-JS).
 *
 * Defined as a simple string — imported and injected by the panel component.
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
.dsh-memory-panel {
  position: fixed; z-index: 1000; width: 320px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: var(--dsw-shadow-lv2);
  padding: 12px; display: flex; flex-direction: column;
  gap: 8px; font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-panel h3 { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-memory-row { display: flex; justify-content: space-between; gap: 8px; }
.dsh-memory-row .k { color: var(--dsw-alias-label-secondary); }
.dsh-memory-note {
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; word-break: break-all;
}`

/**
 * Inject styles into document head, scoped by attribute.
 * Returns a cleanup function for unmount.
 */
export function adoptStyles(): () => void {
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  style.setAttribute('data-dsh-memory', '')
  document.head.appendChild(style)
  return () => {
    const el = document.head.querySelector('style[data-dsh-memory]')
    if (el) document.head.removeChild(el)
  }
}