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
.dsh-memory-ver { font-size: 11px; color: var(--dsw-alias-label-secondary); }
/* The installed→latest pair is the one bit of the sheet a user must notice, so
   it takes label-primary rather than the secondary grey the version alone
   used. Tabbing the digits keeps "v0.8.0 → v0.9.0" from shifting as it
   changes. */
.dsh-memory-ver[data-update='true'] { color: var(--dsw-alias-label-primary); }
.dsh-memory-ver-next {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.dsh-memory-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 11px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dsh-memory-note {
  /* secondary, not tertiary: on a light-theme card the tertiary token resolves
     to a value that is 3.71:1 here — below AA. secondary clears it (5.80:1).
     See the light-theme contrast block in test/client-console. */
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  line-height: 1.4;
}

/* ── Console tabs (search + the four figures) ───────────────────────
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
  /* Pending-count badge. The host's soft amber is state-warn-secondary (the
     same value in both themes). The ink must be a FIXED deep neutral: round 2
     used bg-layer-1, which is near-black in dark (8.21:1, fine) but the light
     card colour in light — giving an approximately 1.9:1 amber pair, below AA.
     The bluish-1000 static is the palette's deepest neutral and does not flip,
     so it clears AA in both themes (9.88:1). test/client-console asserts both. */
  background: var(--dsw-alias-state-warn-secondary);
  color: var(--dsw-static-neutral-bluish-1000);
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
  /* secondary for the same reason as .dsh-memory-note: tertiary is below AA
     on the light card. */
  color: var(--dsw-alias-label-secondary);
}
.dsh-memory-rows { display: flex; flex-direction: column; }
/* Inbox rows are wrapped (row + expandable body), so the separator that the
   search list draws with .row + .row::before has to move to the wrapper —
   otherwise two adjacent submissions would have no divider at all. */
.dsh-memory-item + .dsh-memory-item {
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-memory-body {
  /* A submission's own text: rendered as text, never as markup, and clipped by
     noteDigest before it gets here. break-word keeps a long unbroken token
     (a path, a hash) from widening the panel. */
  margin: 0 8px 9px 17px; padding: 7px 10px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
  max-height: 168px; overflow-y: auto;
}
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
/* A health row that needs attention: the same bar the search list uses, but in
   the error colour, plus primary text instead of tertiary — the number has to
   be readable before it can be acted on. */
.dsh-memory-row[data-tone='warn'] .dsh-memory-rowmeta {
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-row[data-tone='warn'] .dsh-memory-bar {
  background: var(--dsw-alias-state-error-primary); opacity: .8;
}
.dsh-memory-row .dsh-memory-action:disabled {
  opacity: .4; cursor: default; color: var(--dsw-alias-label-tertiary);
  border-color: var(--dsw-alias-border-l1);
}
.dsh-memory-pane-scroll { overflow-y: auto; }

/* ── Summary grids (stats KPIs, health metrics) ─────────────────────
   Both panes used to render their numbers as ordinary label→value rows, which
   gives a count the same visual weight as a version string. A 2×2 grid of large
   figures answers "how much" at a glance; the label underneath says of what.
   Every token below is one the host declares — see the token block in
   test/client-console. */
.dsh-memory-kpis,
.dsh-memory-metrics {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
}
.dsh-memory-kpi,
.dsh-memory-metric {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
  padding: 9px 11px 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  transition: border-color .15s, background-color .15s;
}
.dsh-memory-kpi-value,
.dsh-memory-metric-value {
  font-size: 19px; font-weight: 600; line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-memory-kpi-label,
.dsh-memory-metric-label {
  font-size: 10.5px; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary);
}
/* A metric the reader may need to act on: the tile itself gains the error
   stroke, so the grid shows WHERE the problem is without reading the rows.
   The figure stays label-primary — error-coloured text on a light card is the
   contrast trap the failure banner already documents. */
.dsh-memory-metric[data-tone='warn'] {
  background: var(--dsw-alias-bg-layer-3);
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-memory-metric[data-tone='muted'] .dsh-memory-metric-value {
  color: var(--dsw-alias-label-tertiary);
}

/* ── Health verdict ─────────────────────────────────────────────────
   The pane opens on a sentence, not on eight equal rows: the reader wants to
   know whether anything is wrong before learning what the numbers are. Tone is
   carried by the dot and the border, never by the body text. */
.dsh-memory-health {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 13px;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  box-shadow: var(--dsw-shadow-lv3);
}
.dsh-memory-health[data-tone='warn'] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-memory-health-dot {
  flex: none; width: 8px; height: 8px; border-radius: 50%;
  margin-top: 5px;
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 4px var(--dsw-alias-interactive-bg-active);
}
.dsh-memory-health[data-tone='warn'] .dsh-memory-health-dot {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-memory-health[data-tone='muted'] .dsh-memory-health-dot {
  background: var(--dsw-alias-label-tertiary);
}
.dsh-memory-health-copy {
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.dsh-memory-health-copy b {
  font-size: 13.5px; font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-health-copy span {
  font-size: 11.5px; line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}
/* The re-measure control rides the verdict, right-aligned, quiet until hover:
   it is an escape hatch, not the pane's main action. */
.dsh-memory-health-retry {
  flex: none; margin-left: auto; align-self: center;
  padding: 3px 9px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 11px; line-height: 1.5;
  cursor: pointer; white-space: nowrap;
  transition: color .12s, background .12s, border-color .12s;
}
.dsh-memory-health-retry:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}

/* ── Health findings ────────────────────────────────────────────────
   One card per problem, because a warning that does not say what to do is
   just a louder warning. Severity is carried by the left rule and the dot;
   the body text keeps its normal label colours so it holds contrast in the
   light theme, where a red-on-white paragraph at 11.5px disappears. */
.dsh-memory-findings {
  display: flex; flex-direction: column; gap: 8px;
}
.dsh-memory-finding {
  padding: 10px 12px 11px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-left-width: 3px;
  border-radius: 9px;
}
.dsh-memory-finding[data-severity='error'] { border-left-color: var(--dsw-alias-state-error-primary); }
.dsh-memory-finding[data-severity='warn'] { border-left-color: var(--dsw-alias-state-warn-secondary); }
.dsh-memory-finding[data-severity='info'] { border-left-color: var(--dsw-alias-border-l3); }
.dsh-memory-finding-head {
  display: flex; align-items: center; gap: 7px;
}
.dsh-memory-finding-mark {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-border-l3);
}
.dsh-memory-finding[data-severity='error'] .dsh-memory-finding-mark {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-memory-finding[data-severity='warn'] .dsh-memory-finding-mark {
  background: var(--dsw-alias-state-warn-secondary);
}
.dsh-memory-finding-title {
  font-size: 12.5px; font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-finding-tag {
  margin-left: auto;
  font-size: 10px; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-finding-detail {
  margin: 5px 0 0;
  font-size: 11.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}
.dsh-memory-finding-fix {
  margin: 4px 0 0;
  font-size: 11.5px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}
/* Its own block, not an inline span: a command you cannot select cleanly is a
   command you retype, and the whole point of the card is the last line. */
.dsh-memory-finding-cmd {
  display: block; margin-top: 7px;
  padding: 5px 8px;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-all;
  user-select: all;
}
.dsh-memory-finding-note {
  margin: 0;
  font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-word;
}

/* ── Hand-off to an agent ───────────────────────────────────────────
   The card's second verb. A rule above it separates "what is wrong" from
   "who does something about it", and the confirmation lives INSIDE the card:
   it has one fact to convey and one risk, which is not worth a dialog that
   hides the problem it is about. */
.dsh-memory-finding-actions {
  margin-top: 9px; padding-top: 8px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
}
.dsh-memory-confirm { display: flex; flex-direction: column; gap: 5px; }
.dsh-memory-confirm-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.dsh-memory-confirm-target {
  margin: 0; font-size: 11.5px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}
.dsh-memory-confirm-note {
  margin: 0; font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-word;
}
.dsh-memory-act {
  padding: 3px 10px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 11px; line-height: 1.6;
  cursor: pointer; white-space: nowrap;
  transition: color .12s, background .12s, border-color .12s;
}
.dsh-memory-act:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}
/* The accent, not a filled button: the sheet sits on the host's own surface
   and a solid brand block would be the loudest thing in the panel — louder
   than the error it belongs to. */
.dsh-memory-act-primary {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-memory-act-primary:hover { background: var(--dsw-alias-interactive-bg-active); }
.dsh-memory-risk {
  font-size: 10px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-repair {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
/* The fallback brief: selectable, monospaced, and on its own row so a 380px
   sheet does not try to lay it out beside the buttons. */
.dsh-memory-brief {
  flex: 1 0 100%;
  margin: 2px 0 0; padding: 6px 8px;
  max-height: 160px; overflow: auto;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; line-height: 1.45;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-all;
  user-select: text;
}
.dsh-memory-repair-text { flex: 1 1 auto; word-break: break-word; }
.dsh-memory-repair-dot {
  flex: none; width: 5px; height: 5px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  animation: dsh-memory-pulse 1.4s ease-in-out infinite;
}
/* Waiting on a measurement is not work in progress: a still dot says
   "nothing is running here" without claiming the wait is over. */
.dsh-memory-repair[data-phase='verifying'] .dsh-memory-repair-dot {
  background: var(--dsw-alias-label-tertiary);
  animation: none;
}
.dsh-memory-repair[data-phase='failed'],
.dsh-memory-repair[data-phase='mismatch'] {
  color: var(--dsw-alias-label-primary);
}
/* A warning that the last repair ADDED problems. Neutral surface, warn-coloured
   left rule — the same rule the cards use, so it reads as a finding rather than
   as an error banner about the panel itself. */
.dsh-memory-added {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-left: 3px solid var(--dsw-alias-state-warn-secondary);
  border-radius: 8px;
}
.dsh-memory-added-text {
  flex: 1 1 auto;
  font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}

/* ── Stats disclosure ───────────────────────────────────────────────
   Composition and the access calendar are real information and the least
   actionable part of the pane, so they cost one click instead of a scroll.
   A native <details>, because a disclosure needs no client state and the
   collapsed pane must not run a mount effect to learn it is hidden. */
.dsh-memory-more {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 0 12px;
}
.dsh-memory-more-summary {
  display: flex; align-items: center; gap: 7px;
  padding: 10px 0; cursor: pointer;
  list-style: none; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-memory-more-summary::-webkit-details-marker { display: none; }
.dsh-memory-more-summary::before {
  content: '▸'; font-size: 9px; opacity: .6;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-more[open] .dsh-memory-more-summary::before { content: '▾'; }
.dsh-memory-more-body {
  display: flex; flex-direction: column; gap: 12px;
  padding: 2px 0 12px;
}

/* ── An opened search hit ───────────────────────────────────────────
   The whole note, not the digest: opening a document is a request to read it.
   Taller than an inbox preview because it is the actual document, and the path
   is printed above it so the note can be taken to an editor — the panel cannot
   hand a file to the host. */
.dsh-memory-doc {
  max-height: 260px;
  margin: 0 8px 9px 17px;
}
.dsh-memory-docpath {
  display: block; margin-bottom: 6px;
  font-size: 10px; letter-spacing: .01em;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
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
  /* NEUTRAL fill, error semantics carried by stroke + glyph + label.
     Round 2 filled this banner with the host's translucent
     interactive-bg-hover-danger and painted state-error-primary text on it:
     3.96:1 dark / 4.14:1 light, both under AA body text. A banner is the
     primary information carrier exactly when the user most needs to read it,
     so sub-AA body text is not defensible. The host ships no soft error
     surface token, and that absence is itself the signal — it does not want
     coloured body text on a coloured fill.
     So: bg-layer-3 for the fill, state-error-primary for the 1px stroke and
     the glyph, label-primary for the words. Three carriers of "error"
     (colour, stroke, icon) and a body ratio of 11.57:1 dark / 18.90:1 light
     against the fill. See the error-banner contrast block in
     test/client-console, which resolves these values from the host bundle. */
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 9px; margin-bottom: 8px;
  background: var(--dsw-alias-bg-layer-3);
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary); font-size: 11.5px;
}
.dsh-memory-failure-glyph {
  /* The colour carrier that lets the body text stay neutral. Not decorative:
     remove it and the "error" signal drops to the stroke alone. */
  flex: none; font-size: 11px; line-height: 1;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-memory-failure-text { flex: 1; }
.dsh-memory-failure .dsh-memory-action {
  opacity: 1; color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}

/* ── Four figures (Figures.tsx) ─────────────────────────────────────
   Round 1 shipped the four figures with NO rules at all: all 17 class names
   below were rendered by Figures.tsx and defined nowhere, so every shape fell
   back to its default display. The visible collapse: '-bar-fill' is an <i>
   (inline, no height, no background), so the ranking chart rendered as bare
   text with an inert width:96%; the donut legend rendered as a bulleted list.
   Every geometry, token and degradation assertion was green throughout —
   none of them asked whether the classes had rules. That contract now lives in
   test/client-figures.test.ts, in both directions.

   Tokens: only the aliases the host ACTUALLY declares (see the token block in
   test/client-console). Text greys use 'secondary' where the text is a real
   notice, 'tertiary' only for the small axis/meta hints. */
.dsh-memory-figure {
  display: flex; flex-direction: column; gap: 6px;
  margin: 0; min-width: 0;
}
.dsh-memory-figure-cap {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 10.5px; line-height: 1.3;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-figure-cap b {
  font-size: 11.5px; font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-figure-range {
  font-size: 10px; letter-spacing: .02em;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-figure-note {
  /* secondary, not tertiary: this is the degradation notice ("读取失败…")
     and it is the ONLY thing the figure shows when the core could not be read,
     so it has to clear AA on a light card as well (tertiary is 3.71:1 there). */
  font-size: 10.5px; color: var(--dsw-alias-label-secondary);
}
/* SVG weekday axis labels. fill, not color — these are SVG <text>. */
.dsh-memory-figure-tick {
  font-size: 9px; fill: var(--dsw-alias-label-tertiary);
}
/* Donut: the ring and its legend sit side by side. */
.dsh-memory-figure-split {
  display: flex; align-items: center; gap: 10px; min-width: 0;
}
.dsh-memory-legend {
  /* Without this the legend degrades to a bulleted <ul>, which reads as prose
     rather than as the colour key a donut cannot do without. */
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 3px;
  min-width: 0; flex: 1;
}
.dsh-memory-legend-item {
  display: flex; align-items: center; gap: 6px; min-width: 0;
}
.dsh-memory-legend-swatch {
  /* An <i>; the colour arrives inline (brand-primary at the slice's alpha),
     so this only has to give it a box. */
  display: block; flex: none;
  width: 8px; height: 8px; border-radius: 2px;
}
.dsh-memory-legend-name {
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  font-size: 10.5px; color: var(--dsw-alias-label-secondary);
}
.dsh-memory-legend-val {
  flex: none; font-size: 10px; letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-memory-figure-bars {
  display: flex; flex-direction: column; gap: 5px;
}
.dsh-memory-figure-bar {
  display: flex; align-items: center; gap: 8px; min-width: 0;
}
.dsh-memory-figure-bar-name {
  /* The label is already truncated to 18 code points by the component; this
     keeps a long one from pushing the track off the sheet. */
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  font-size: 10.5px; color: var(--dsw-alias-label-primary);
}
.dsh-memory-figure-bar-track {
  /* The visible 100% the fill is a fraction OF. overflow: hidden clips the
     fill to the track's radius so a rounded bar cannot square off at the end. */
  display: block; flex: none;
  width: 96px; height: 8px;
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 4px; overflow: hidden;
}
.dsh-memory-figure-bar-fill {
  /* THE C-1 FIX. <i> is inline, and an inline box ignores both width and
     height — so style="width:96%" drew nothing and the bars vanished.
     display: block makes the percentage apply; the height and background
     make it a bar rather than nothing. */
  display: block; height: 100%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-memory-figure-bar-val {
  flex: none; font-size: 10.5px; letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
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
