/**
 * Tests for the DSH settings card (plugin/panel.js + setup.js) and the "show cursor" switch.
 *
 *   node tools/test-panel.mjs
 *
 * Uses a fake dsh-cu (only logs its arguments) and a temp config file; no real settings are touched, nothing is really clicked on screen, the cursor overlay is never started.
 * The only side effect: "cursor off" kills a running cursor overlay (it starts itself again on the next action).
 * The permission check really runs osascript once: it reports the permissions of whatever app runs this script; only the shape is verified.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-test-'))
const argLog = path.join(tmp, 'args.log')
const fakeBin = path.join(tmp, 'dsh-cu')
fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = version ]; then echo 2; exit 0; fi
if [ "$1" = features ]; then echo window-shot; exit 0; fi
echo "$@" >> "${argLog}"
if [ "$1" = winlist ]; then printf '1\\t2\\tFinder\\t\\t0,0 100×100\\n3\\t4\\tNotes\\tx\\t10,10 200×200\\n'; fi
`, { mode: 0o755 })
process.env.DSH_CU_BIN = fakeBin
process.env.DSH_CU_CONFIG = path.join(tmp, 'config.json')
process.env.DSH_CU_OVERLAY = path.join(tmp, 'no-overlay')

const { panelHandler, PANEL_ROUTE } = await import('../plugin/panel.js')
const { readConfig } = await import('../plugin/setup.js')
const plugin = await import('../plugin/index.js')

// plugin apply with a fake ctx, capturing the tools and the route
const tools = {}
let route = null
plugin.apply({
  tools: { register: (t) => { tools[t.name] = t } },
  get: () => null,
  inject: (deps, cb) => cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { route = r }, getOrigin: () => `http://127.0.0.1:${port}` },
  }),
})

let port = 0
const server = http.createServer(panelHandler({ origin: () => `http://127.0.0.1:${port}` }))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port

const req = (method, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const r = http.request({
    host: '127.0.0.1', port, path: PANEL_ROUTE, method,
    headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
  }, (res) => {
    let acc = ''
    res.on('data', (d) => { acc += d })
    res.on('end', () => resolve({ status: res.statusCode, body: acc ? JSON.parse(acc) : null }))
  })
  r.on('error', reject)
  if (data) r.write(data)
  r.end()
})

// the window list (winlist) is queried once before and once after each action; take the last logged line that is not winlist
const lastArgs = () => fs.readFileSync(argLog, 'utf8').trim().split('\n').filter((l) => !l.startsWith('winlist')).pop()

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`✓ ${name}`) } catch (e) { results.push(`❌ ${name}: ${e.message}`) }
}

try {
  await check('plugin registered 11 tools and the settings panel route', async () => {
    assert.equal(Object.keys(tools).length, 11)
    assert.equal(route && route.path, PANEL_ROUTE)
    assert.equal(route.kind, 'exact')
  })

  await check('read state: CLI found, windows counted, permissions well-formed, cursor on by default', async () => {
    const { status, body } = await req('GET')
    assert.equal(status, 200)
    assert.equal(body.platform, 'darwin')
    assert.deepEqual(body.bin, { source: 'env', outdated: false })
    assert.equal(body.windows, 2)
    assert.ok(['boolean', 'object'].includes(typeof body.perms.screen))
    assert.ok(['boolean', 'object'].includes(typeof body.perms.ax))
    assert.equal(typeof body.overlay.installed, 'boolean')
    assert.equal(body.showCursor, true)
    assert.match(body.installCmd, /install\.sh/)
  })

  await check('cursor on: click runs without --no-cursor', async () => {
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.match(lastArgs(), /^clickat 1 5 6$/)
  })

  await check('click reports window changes', async () => {
    const r = await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.match(r.text, /After: no window changes$/)
    const w = (pid, windowId, title, app = 'App') => ({ pid, windowId, title, app })
    const { windowChanges } = plugin
    assert.equal(windowChanges([w(1, 2, 'a')], [w(1, 2, 'a')], 1), 'After: no window changes')
    assert.equal(windowChanges([w(1, 2, 'a')], [w(1, 2, 'a'), w(1, 3, 'Storage')], 1), 'After: opened a new window "Storage"')
    assert.equal(windowChanges([w(1, 2, 'a')], [w(1, 2, 'b')], 1), 'After: title "a"→"b"')
    assert.equal(windowChanges([w(1, 2, 'a')], [], 1), 'After: window "a" disappeared (closed or minimized)')
    assert.equal(windowChanges([], [w(9, 5, '', 'Safari')], 1), 'After: Safari popped up a window (Safari)')
    assert.equal(windowChanges([w(9, 5, 'x')], [w(9, 5, 'y')], 1), 'After: no window changes') // title changes in other apps do not count
    const bar = { pid: 9, windowId: 6, title: '', app: 'Google Chrome', width: 123, height: 22 }
    assert.equal(windowChanges([], [bar], 1), 'After: no window changes') // Chrome's bottom-left URL bar flashes by and does not count
    assert.equal(windowChanges([{ ...bar, pid: 1 }], [], 1), 'After: no window changes')
    assert.equal(windowChanges([], [{ ...bar, width: 420, height: 260 }], 1), 'After: Google Chrome popped up a window (Google Chrome)') // no title but big enough: still reported
  })

  await check('cursor off: written to the config, click runs with --no-cursor', async () => {
    const r = await req('POST', { action: 'cursor', on: false })
    assert.equal(r.body.showCursor, false)
    assert.equal(readConfig().showCursor, false)
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.match(lastArgs(), /--no-cursor/)
  })

  await check('on again: --no-cursor no longer passed', async () => {
    const r = await req('POST', { action: 'cursor', on: true })
    assert.equal(r.body.showCursor, true)
    await tools.desktop_click.execute({ pid: 1, x: 5, y: 6 })
    assert.doesNotMatch(lastArgs(), /--no-cursor/)
  })

  await check('openSettings accepts only the two panes', async () => {
    assert.equal((await req('POST', { action: 'openSettings', pane: 'camera' })).status, 400)
  })

  await check('gate: cross-site Origin rejected', async () => {
    assert.equal((await req('GET', undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await req('POST', { action: 'cursor', on: false }, { origin: 'https://evil.example' })).status, 403)
    assert.equal(readConfig().showCursor, true)
  })

  await check('gate: own Origin allowed', async () => {
    assert.equal((await req('GET', undefined, { origin: `http://127.0.0.1:${port}` })).status, 200)
    assert.equal((await req('GET', undefined, { origin: `http://localhost:${port}` })).status, 200)
  })

  await check('gate: non-local Host (DNS rebinding) rejected', async () => {
    assert.equal((await req('GET', undefined, { host: 'evil.example' })).status, 403)
  })

  await check('gate: POST that is not JSON rejected', async () => {
    const code = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, path: PANEL_ROUTE, method: 'POST', headers: { 'content-type': 'text/plain' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      q.end('{"action":"cursor","on":false}')
    })
    assert.equal(code, 415)
  })

  await check('unknown action', async () => {
    assert.equal((await req('POST', { action: 'nuke' })).status, 400)
  })
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
