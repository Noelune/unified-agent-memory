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
.dsh-memory-note {
  font-size: 11px; color: var(--dsw-alias-label-tertiary);
  line-height: 1.4;
}

/* ── Four-tab console ───────────────────────────────────────────────
   Shapes are the ones locked in docs/superpowers/specs/t8-preview-v3.html.
   Every colour is a --dsw-alias-* token so dark/light follow the host theme.
   The tokens below are the ones the HOST ACTUALLY DECLARES — a var() pointing
   at an undeclared property is invalid at computed-value time and renders
   colourless, with every static "no hardcoded colour" check still green.
   The console test file diffs this sheet against the host theme to keep that
   true. Semantics: brand-primary for the accent, state-*-primary for the
   signal colours, and the one translucent danger surface the host ships for
   the error banner fill. */
.dsh-memory-console {
  display: flex; flex-direction: column;
  padding: 0;
}
.dsh-memory-tabs {
  display: flex; gap: 1px; padding: 8px 8px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-memory-tab {
  position: relative; display: flex; align-items: center; gap: 6px;
  padding: 9px 12px 10px; font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
  background: none; border: none; cursor: pointer;
  border-radius: 8px 8px 0 0;
  font-family: inherit;
  transition: color .16s, transform .16s, background-color .16s;
}
.dsh-memory-tab:hover {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-memory-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary); font-weight: 600;
  transform: translateY(-1px);
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-memory-tab[data-active='true']::after {
  content: ''; position: absolute; left: 7px; right: 7px; bottom: -1px;
  height: 2px; border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 10px var(--dsw-alias-brand-primary);
}
.dsh-memory-tab-dot {
  width: 5px; height: 5px; border-radius: 50%; opacity: .5;
  background: currentColor; display: block;
}
.dsh-memory-tab[data-active='true'] .dsh-memory-tab-dot { opacity: .85; }
.dsh-memory-pill {
  /* Pending-count badge. The host's soft amber is state-warn-secondary; the
     deep bg-layer-1 ink on it measures 8.2:1 (dark theme). The primary amber
     would work too, but the brief asks soft surfaces to come from the
     secondary ramp. */
  background: var(--dsw-alias-state-warn-secondary);
  color: var(--dsw-alias-bg-layer-1);
  border-radius: 999px; font-size: 9.5px; font-weight: 700;
  padding: 1.5px 6px; letter-spacing: .02em; line-height: 1.35;
}
.dsh-memory-pane {
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
}
.dsh-memory-search {
  display: flex; align-items: center; gap: 9px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px;
  transition: border-color .16s, box-shadow .16s;
}
.dsh-memory-search:focus-within {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px var(--dsw-alias-interactive-bg-active);
}
.dsh-memory-search-glyph {
  color: var(--dsw-alias-label-tertiary); font-size: 11px; flex: none;
}
.dsh-memory-search-input {
  flex: 1; min-width: 0; background: none; border: none; outline: none;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.dsh-memory-search-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-toggle {
  display: flex; align-items: center; gap: 5px; font-size: 10px;
  font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
  background: none; border: none; cursor: pointer;
  border-left: 1px solid var(--dsw-alias-border-l1);
  padding-left: 9px; margin-left: 2px; height: 15px;
  font-family: inherit;
}
.dsh-memory-toggle[data-on='true'] { color: var(--dsw-alias-brand-primary); }
.dsh-memory-card {
  /* The card fill sits only 1.16:1 above the dark page, so fill alone cannot
     draw the boundary — a 1px l2 stroke plus an lv2 shadow does (measured
     1.51:1 of edge contrast; see the contrast block in test/client-console). */
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px; padding: 11px 12px;
  box-shadow: var(--dsw-shadow-lv2);
}
.dsh-memory-card-lead {
  background: var(--dsw-alias-bg-layer-3);
  border-color: var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-shadow-lv3);
}
.dsh-memory-cardhead {
  display: flex; align-items: center; gap: 7px;
  font-size: 10px; font-weight: 700; letter-spacing: .09em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
  margin-bottom: 8px; line-height: 1;
}
.dsh-memory-cardhead b {
  color: var(--dsw-alias-label-secondary); font-weight: 700;
  letter-spacing: .06em; font-size: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 5px; padding: 1.5px 5px;
}
.dsh-memory-cardcount {
  margin-left: auto; font-size: 10px; font-weight: 600;
  letter-spacing: .02em; text-transform: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-rows { display: flex; flex-direction: column; }
.dsh-memory-row {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 8px 8px 6px; border-radius: 8px; position: relative;
  transition: background-color .13s, transform .13s;
}
.dsh-memory-row + .dsh-memory-row::before {
  content: ''; position: absolute; top: 0; left: 12px; right: 8px; height: 1px;
  background: var(--dsw-alias-border-l1);
}
.dsh-memory-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  transform: translateX(1.5px);
}
.dsh-memory-bar {
  width: 2.5px; height: 15px; border-radius: 2px; flex: none;
  background: var(--dsw-alias-label-tertiary); opacity: .45;
}
.dsh-memory-bar-doc { background: var(--dsw-alias-brand-primary); opacity: .75; }
.dsh-memory-bar-ok { background: var(--dsw-alias-state-success-primary); opacity: .7; }
.dsh-memory-bar-warn { background: var(--dsw-alias-state-warn-primary); opacity: .7; }
.dsh-memory-rowname {
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary); font-size: 13px;
}
.dsh-memory-rowname mark {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-brand-primary);
  border-radius: 3px; padding: 0 2px; font-weight: 600;
}
.dsh-memory-rowmeta {
  flex: none; font-size: 10.5px; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-action {
  flex: none; font-size: 10.5px; opacity: .65;
  color: var(--dsw-alias-label-tertiary);
  background: none; cursor: pointer; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
  padding: 3px 8px;
  transition: opacity .14s, color .14s, border-color .14s;
}
.dsh-memory-row:hover .dsh-memory-action {
  opacity: 1; color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-memory-stats { display: flex; gap: 8px; }
.dsh-memory-stat {
  flex: 1; display: flex; flex-direction: column; gap: 1px;
  padding: 9px 10px 8px; border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-memory-stat b {
  font-size: 21px; line-height: 1.05; letter-spacing: -.02em; font-weight: 600;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary);
}
.dsh-memory-stat span {
  font-size: 9px; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 22px 14px; color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-empty-glyph { font-size: 21px; opacity: .3; line-height: 1; }
.dsh-memory-empty-title {
  font-size: 12.5px; color: var(--dsw-alias-label-secondary);
}
.dsh-memory-empty-hint {
  font-size: 11px; font-style: normal; opacity: .82;
  text-align: center; line-height: 1.45;
}
.dsh-memory-skeleton { display: flex; flex-direction: column; gap: 7px; }
.dsh-memory-skeleton-row {
  height: 13px; border-radius: 6px; display: block;
  background: var(--dsw-alias-bg-layer-3);
  animation: dsh-memory-pulse 1.4s ease-in-out infinite;
}
.dsh-memory-skeleton-row:nth-child(2) { width: 82%; animation-delay: .18s; }
.dsh-memory-skeleton-row:nth-child(3) { width: 64%; animation-delay: .36s; }
@keyframes dsh-memory-pulse { 0%,100% { opacity: .45 } 50% { opacity: .9 } }
.dsh-memory-failure {
  /* The host declares no *-bg alias; the one semantic error SURFACE it ships is
     the translucent interactive-bg-hover-danger, which composes over whatever
     layer the banner lands on (and flips value with the theme). The stroke and
     the text share state-error-primary. Measured: error text on that filled
     surface is 3.96:1 dark / 4.14:1 light — under AA 4.5:1 for body text, which
     is why the 1px error stroke carries the banner's boundary and the message is
     never colour-only. See the report's err-bg section for the full comparison. */
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 9px; margin-bottom: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); font-size: 11.5px;
}
.dsh-memory-failure-text { flex: 1; }
.dsh-memory-failure .dsh-memory-action {
  opacity: 1; color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
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
