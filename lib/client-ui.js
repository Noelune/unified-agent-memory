/**
 * dsh-unified-agent-memory — browser half (optional).
 *
 * Sidebar-footer relay-style glyph that opens a small memory status panel
 * (vault path, index health, pending inbox count) via the host tool route.
 * Read-only: no memory content is displayed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-unified-agent-memory',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    var CSS = [
      '.dsh-memory-trigger{width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:18px;flex:none;justify-content:center;align-items:center;padding:0 6px;gap:6px;font-family:inherit;font-size:13px;transition:background-color .12s,color .12s;display:inline-flex}',
      '.dsh-memory-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-trigger[data-open="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-panel{position:fixed;z-index:1000;width:320px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv2);padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsh-memory-panel h3{margin:0;font-size:14px;font-weight:600}',
      '.dsh-memory-row{display:flex;justify-content:space-between;gap:8px}',
      '.dsh-memory-row .k{color:var(--dsw-alias-label-secondary)}',
      '.dsh-memory-note{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all}'
    ].join('\n')

    function MemoryGlyph(props) {
      return react.createElement('svg', {
        width: props.size || 16, height: props.size || 16, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true'
      }, react.createElement('path', { d: 'M3 2.5h10v3H3z' }),
        react.createElement('path', { d: 'M3 8.5h10v3H3z' }),
        react.createElement('path', { d: 'M5.5 1.5v2M10.5 1.5v2M5.5 7.5v2M10.5 7.5v2' }))
    }

    function MemoryPanel(props) {
      var pair = react.useState('')
      var text = pair[0]
      var setText = pair[1]
      react.useEffect(function () {
        var cancelled = false
        var timer = null
        var tick = function () {
          window.fetch('/api/dsh-unified-agent-memory/status', { cache: 'no-store' })
            .then(function (r) { return r.json() })
            .then(function (b) { if (!cancelled) setText(JSON.stringify(b, null, 2)) })
            .catch(function () { /* host route unavailable; show hint */ })
          timer = window.setTimeout(tick, 10000)
        }
        tick()
        return function () { cancelled = true; if (timer) window.clearTimeout(timer) }
      }, [])
      return react.createElement('div', { className: 'dsh-memory-panel' },
        react.createElement('h3', null, 'Unified Memory'),
        react.createElement('div', { className: 'dsh-memory-note' },
          text || 'status route unavailable — the plugin loads tools; run memory_status from chat'),
        react.createElement('div', { className: 'dsh-memory-row' },
          react.createElement('span', { className: 'k' }, 'Write path'),
          react.createElement('span', null, 'Agent提交区 via memory_submit')))
    }

    function MemoryButton(props) {
      var wide = props.wide === true
      var pair = react.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var ref = react.useRef(null)
      react.useEffect(function () {
        if (!open) return undefined
        var onDown = function (e) {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return function () { document.removeEventListener('mousedown', onDown) }
      }, [open])
      return react.createElement(react.Fragment, null,
        react.createElement('button', {
          ref: ref, className: 'dsh-memory-trigger', 'data-wide': wide ? 'row' : 'rail',
          'data-open': open ? 'true' : 'false', title: 'Unified Memory status',
          onClick: function () { setOpen(!open) }
        }, react.createElement(MemoryGlyph, { size: wide ? 14 : 16 })),
        open ? react.createElement(MemoryPanel, null) : null)
    }

    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    var seat = window.__DSH_SIDEBAR_SEATS__ && window.__DSH_SIDEBAR_SEATS__.footer
    if (seat && seat.action) {
      seat.action.mount({ id: 'dsh-unified-agent-memory', render: function (props) { return react.createElement(MemoryButton, props) } })
    }
    module.exports = MemoryButton
  }
})
