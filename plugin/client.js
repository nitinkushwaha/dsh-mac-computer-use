/**
 * Web client for dsh-mac-computer-use: the settings page for our card on DSH's "Plugins" page.
 *
 *   Status: whether it works, how many windows are visible
 *   Checklist: command-line tool, Screen Recording permission, Accessibility permission, cursor overlay — each missing item gets its own button
 *   Switch: show the action cursor on screen
 *
 * All data goes through the route the plugin mounts on DSH's webServer (plugin/panel.js), refreshed every 2.5 seconds.
 * Built on the official client plugin mechanism: window.__ModuleLoader__.load({ id, factory }), where factory runs apply(ctx)
 * → registered into the two keyed slots plugins.bundle.config (package detail page) and plugins.row.config (row detail page).
 * If react or the DSH components are unavailable, exit quietly / fall back to the plainest stand-in; never crash the host page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mac-computer-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const opt = (id) => { try { return require(id) } catch (_) { return null } }
    const React = opt('react')
    if (!React) {
      exports.apply = () => {}
      exports.inject = ['slots', 'locale']
      return module.exports
    }
    const UI = opt('@deepseek-ai/dsh-client-ui-primitives') || {}
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PKG = 'dsh-mac-computer-use'
    const ROW = 'mac-computer-use'
    const NS = 'dsh-mac-computer-use'
    const ROUTE = '/dsh-mac-computer-use/panel'
    const REPO = 'https://github.com/nitinkushwaha/dsh-mac-computer-use'

    // placeholders use %x: avoids colliding with DSH's own {name} interpolation
    const zh = {
      checking: 'Checking…',
      ready: 'Ready',
      needsPerm: 'Missing system permissions',
      notInstalled: 'Not installed yet',
      unsupported: 'macOS only',
      windows: 'Can see %n window(s)',
      windowsUnknown: 'The command-line tool did not run, so no windows are visible',
      summaryOn: 'Ready · can see %n window(s)',
      summaryPerm: 'Missing system permissions — open for steps',
      summaryOff: 'Command-line tool not found — open for what to do',
      binTitle: 'Command-line tool dsh-cu',
      binOk: 'Installed',
      binMissing: 'The program bundled with the plugin is missing. Update the plugin to the latest version in DSH, or reinstall it. If that does not help, build it yourself by running this in Terminal (needs Xcode Command Line Tools first: xcode-select --install):',
      srcBundled: 'bundled with the plugin',
      srcInstalled: '~/.dsh/bin',
      srcDev: 'dev folder',
      srcEnv: 'DSH_CU_BIN',
      copyInstall: 'Copy install command',
      copied: 'Install command copied. Paste it in Terminal; this page updates by itself once it is done',
      binOld: 'Update available',
      binOutdated: 'The newer engine captures windows more accurately: numbering elements and finding text also see the window itself when another window covers it. Run this in Terminal to update (the current one still works):',
      copyUpdate: 'Copy update command',
      updateCopied: 'Update command copied. Paste it in Terminal; this page updates by itself once it is done',
      screenTitle: 'Screen Recording permission',
      screenHint: 'Needed for screenshots and finding buttons by their text.',
      axTitle: 'Accessibility permission',
      axHint: 'Needed for clicking, typing, keys, scrolling, dragging and clicking by number; without it these fail with an error (macOS drops them).',
      permOk: 'On',
      permMissing: 'Off',
      permUnknown: 'Unknown',
      openSettings: 'Open System Settings',
      settingsOpened: 'Opened System Settings: turn on DeepSeek Harness in the list. Screen Recording changes need a DSH restart.',
      overlayTitle: 'Cursor overlay',
      overlayRunning: 'Showing',
      overlayIdle: 'Installed, appears while working',
      overlayMissing: 'Not installed: no visible cursor, actions still work (installed together with the command-line tool)',
      showCursor: 'Show the action cursor on screen',
      showCursorHint: 'Off only hides the cursor; clicks and typing still happen.',
      plugin: 'Plugin v%v',
      guide: 'Guide',
      failed: 'That did not work: %e',
      unreachable: 'Could not read the plugin status; restart DSH and try again',
    }
    const en = {
      checking: 'Checking…',
      ready: 'Ready',
      needsPerm: 'Missing system permissions',
      notInstalled: 'Not installed yet',
      unsupported: 'macOS only',
      windows: 'Can see %n window(s)',
      windowsUnknown: 'The command-line tool did not run, so no windows are visible',
      summaryOn: 'Ready · can see %n window(s)',
      summaryPerm: 'Missing system permissions — open for steps',
      summaryOff: 'Command-line tool not found — open for what to do',
      binTitle: 'Command-line tool dsh-cu',
      binOk: 'Installed',
      binMissing: 'The program bundled with the plugin is missing. Update the plugin to the latest version in DSH, or reinstall it. If that does not help, build it yourself by running this in Terminal (needs Xcode Command Line Tools first: xcode-select --install):',
      srcBundled: 'bundled with the plugin',
      srcInstalled: '~/.dsh/bin',
      srcDev: 'dev folder',
      srcEnv: 'DSH_CU_BIN',
      copyInstall: 'Copy install command',
      copied: 'Install command copied. Paste it in Terminal; this page updates by itself once it is done',
      binOld: 'Update available',
      binOutdated: 'The newer engine captures windows more accurately: numbering elements and finding text also see the window itself when another window covers it. Run this in Terminal to update (the current one still works):',
      copyUpdate: 'Copy update command',
      updateCopied: 'Update command copied. Paste it in Terminal; this page updates by itself once it is done',
      screenTitle: 'Screen Recording permission',
      screenHint: 'Needed for screenshots and finding buttons by their text.',
      axTitle: 'Accessibility permission',
      axHint: 'Needed for clicking, typing, keys, scrolling, dragging and clicking by number; without it these fail with an error (macOS drops them).',
      permOk: 'On',
      permMissing: 'Off',
      permUnknown: 'Unknown',
      openSettings: 'Open System Settings',
      settingsOpened: 'Opened System Settings: turn on DeepSeek Harness in the list. Screen Recording changes need a DSH restart.',
      overlayTitle: 'Cursor overlay',
      overlayRunning: 'Showing',
      overlayIdle: 'Installed, appears while working',
      overlayMissing: 'Not installed: no visible cursor, actions still work (installed together with the command-line tool)',
      showCursor: 'Show the action cursor on screen',
      showCursorHint: 'Off only hides the cursor; clicks and typing still happen.',
      plugin: 'Plugin v%v',
      guide: 'Guide',
      failed: 'That did not work: %e',
      unreachable: 'Could not read the plugin status; restart DSH and try again',
    }

    const fmt = (s, vars) => String(s).replace(/%([a-z])/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))

    const CSS = `
.dcu{display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dcu-card{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;overflow:hidden}
.dcu-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px}
.dcu-row+.dcu-row{border-top:1px solid var(--dsw-alias-border-l)}
.dcu-main{flex:1;min-width:0;display:grid;gap:2px}
.dcu-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcu-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dcu-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dcu-dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-label-tertiary)}
.dcu-dot[data-s=on]{background:var(--dsw-alias-state-success-primary,#34c759);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 22%,transparent)}
.dcu-dot[data-s=warn]{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dcu-dot[data-s=off]{background:var(--dsw-alias-state-error-primary,#ff453a)}
.dcu-dot[data-s=idle]{background:var(--dsw-alias-label-tertiary)}
.dcu-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:4px 8px;margin-top:4px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);user-select:all;word-break:break-all}
.dcu-note{font-size:12px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ff9f0a) 12%,transparent);color:var(--dsw-alias-label-primary)}
.dcu-note[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 12%,transparent)}
.dcu-note[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff453a) 12%,transparent)}
.dcu-foot{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcu-foot a{color:var(--dsw-alias-link);text-decoration:none}
.dcu-foot a:hover{text-decoration:underline}
.dcu-tag{font-size:11px;font-weight:500;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l);color:var(--dsw-alias-label-secondary)}
.dcu-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dcu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcu-btn:disabled{opacity:.45;cursor:default}
.dcu-switch{flex:none;margin-top:2px}`
    function ensureCss() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-mac-computer-use"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = 'dsh-mac-computer-use'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── DSH components, plain stand-ins when unavailable ────────────────────
    function Toggle({ checked, disabled, label, onChange }) {
      if (UI.Switch) return h('span', { className: 'dcu-switch' }, h(UI.Switch, { checked, disabled, label, onChange }))
      return h('input', { className: 'dcu-switch', type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: (e) => onChange(e.target.checked) })
    }
    function Btn({ onClick, disabled, children, primary }) {
      if (UI.Button) return h(UI.Button, { variant: primary ? 'primary' : 'outline', size: 'sm', disabled, onClick }, children)
      return h('button', { type: 'button', className: 'dcu-btn', disabled, onClick }, children)
    }

    // ── Data ──────────────────────────────────────────────────────────────
    async function fetchState(action) {
      const res = await fetch(ROUTE, action
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), credentials: 'same-origin' }
        : { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** Refresh every 2.5 seconds; skip while the page is hidden. */
    function useDesktopState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          if (alive.current) { setState(s); setError('') }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        }
      }, [])
      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
        }, 2500)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])
      const act = useCallback(async (action) => {
        const s = await fetchState(action)
        if (alive.current) setState(s)
        return s
      }, [])
      return { state, error, act }
    }

    function phaseOf(s) {
      if (!s) return 'checking'
      if (s.platform && s.platform !== 'darwin') return 'unsupported'
      if (!s.bin) return 'off'
      const p = s.perms || {}
      if (p.screen === false || p.ax === false || s.windows == null) return 'warn'
      return 'on'
    }

    // ── Summary (the one-liner on the row card) ───────────────────────────
    function Summary({ t }) {
      const { state } = useDesktopState()
      const p = phaseOf(state)
      if (p === 'checking') return t('checking')
      if (p === 'unsupported') return t('unsupported')
      if (p === 'off') return t('summaryOff')
      if (p === 'warn') return t('summaryPerm')
      return fmt(t('summaryOn'), { n: state.windows })
    }

    // ── Settings page ─────────────────────────────────────────────────────
    function Page({ t }) {
      const { state, error, act } = useDesktopState()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const p = phaseOf(state)

      const run = async (action, ok) => {
        setBusy(true)
        try {
          const s = await act(action)
          if (s.actionError) setNote({ tone: 'err', text: fmt(t('failed'), { e: s.actionError }) })
          else setNote(ok ? { tone: 'ok', text: ok } : null)
        } catch (e) {
          setNote({ tone: 'err', text: fmt(t('failed'), { e: String((e && e.message) || e) }) })
        } finally {
          setBusy(false)
        }
      }

      const statusTitle = { checking: t('checking'), on: t('ready'), warn: t('needsPerm'), off: t('notInstalled'), unsupported: t('unsupported') }[p]
      const status = h('div', { className: 'dcu-card' },
        h('div', { className: 'dcu-row' },
          h('span', { className: 'dcu-dot', 'data-s': p === 'unsupported' ? 'off' : p === 'checking' ? 'idle' : p }),
          h('div', { className: 'dcu-main' },
            h('div', { className: 'dcu-title' }, statusTitle),
            state && state.bin
              ? h('div', { className: 'dcu-sub' }, state.windows == null ? t('windowsUnknown') : fmt(t('windows'), { n: state.windows }))
              : null)))

      // one checklist row: status dot + title + note + button on the right
      const item = (key, dot, title, sub, extra, button) => h('div', { key, className: 'dcu-row' },
        h('span', { className: 'dcu-dot', 'data-s': dot }),
        h('div', { className: 'dcu-main' },
          h('div', { className: 'dcu-title' }, title, sub ? h('span', { className: 'dcu-tag' }, sub) : null),
          extra),
        button)

      const permItem = (key, value, title, hint) => item(key,
        value === true ? 'on' : value === false ? 'off' : 'idle',
        title,
        value === true ? t('permOk') : value === false ? t('permMissing') : t('permUnknown'),
        h('p', { className: 'dcu-hint' }, hint),
        value === false ? h(Btn, { disabled: busy, onClick: () => run({ action: 'openSettings', pane: key }, t('settingsOpened')) }, t('openSettings')) : null)

      const checklist = state && state.platform === 'darwin' ? h('div', { className: 'dcu-card' },
        state.bin && state.bin.outdated
          ? item('bin', 'warn', t('binTitle'), t('binOld'),
            h('div', null, h('p', { className: 'dcu-hint' }, t('binOutdated')), h('div', { className: 'dcu-cmd' }, state.updateCmd)),
            h(Btn, { disabled: busy, onClick: () => run({ action: 'copyUpdate' }, t('updateCopied')) }, t('copyUpdate')))
          : state.bin
          ? item('bin', 'on', t('binTitle'), t('binOk') + ' · ' + t({ bundled: 'srcBundled', installed: 'srcInstalled', dev: 'srcDev', env: 'srcEnv' }[state.bin.source] || 'srcInstalled'))
          : item('bin', 'off', t('binTitle'), null,
            h('div', null, h('p', { className: 'dcu-hint' }, t('binMissing')), h('div', { className: 'dcu-cmd' }, state.installCmd)),
            h(Btn, { primary: true, disabled: busy, onClick: () => run({ action: 'copyInstall' }, t('copied')) }, t('copyInstall'))),
        permItem('screen', state.perms && state.perms.screen, t('screenTitle'), t('screenHint')),
        permItem('ax', state.perms && state.perms.ax, t('axTitle'), t('axHint')),
        item('overlay',
          state.overlay && state.overlay.running ? 'on' : state.overlay && state.overlay.installed ? 'idle' : 'warn',
          t('overlayTitle'), null,
          h('p', { className: 'dcu-hint' }, state.overlay && state.overlay.running ? t('overlayRunning') : state.overlay && state.overlay.installed ? t('overlayIdle') : t('overlayMissing')),
          null)) : null

      const switches = state && state.platform === 'darwin' ? h('div', { className: 'dcu-card' },
        h('div', { className: 'dcu-row' },
          h('div', { className: 'dcu-main' },
            h('div', { className: 'dcu-title' }, t('showCursor')),
            h('p', { className: 'dcu-hint' }, t('showCursorHint'))),
          h(Toggle, { label: t('showCursor'), checked: state.showCursor !== false, disabled: busy, onChange: (on) => run({ action: 'cursor', on }) }))) : null

      const notes = [
        error && !state ? { tone: 'err', text: t('unreachable') } : null,
        note,
      ].filter(Boolean)

      return h('div', { className: 'dcu' },
        status,
        checklist,
        switches,
        ...notes.map((n, i) => h('div', { key: `n${i}`, className: 'dcu-note', 'data-tone': n.tone }, n.text)),
        h('div', { className: 'dcu-foot' },
          state && state.plugin ? h('span', null, fmt(t('plugin'), { v: state.plugin })) : null,
          h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('guide'))))
    }

    function makeCard(boundT) {
      return function DesktopControlCard(props) {
        ensureCss()
        const t = typeof props.t === 'function' ? props.t : boundT
        return props.view === 'summary' ? h(Summary, { t }) : h(Page, { t })
      }
    }

    function apply(ctx) {
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (k) => zh[k] || k
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mac-computer-use: dictionaries')
      }
      const Card = makeCard(t)
      const mount = (name, key) => {
        const reg = () => ctx.slots.register({ name, key, locale: NS }, Card)
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(name, reg) : reg()), `dsh-mac-computer-use: ${name}`)
      }
      mount('plugins.bundle.config', PKG)
      mount('plugins.row.config', `${PKG}#${ROW}`)
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
