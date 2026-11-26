/**
 * Backend for the settings card on DSH's plugin page: one HTTP route mounted on DSH's own webServer.
 *
 *   GET  /dsh-mac-computer-use/panel           → status (command-line tool, cursor overlay, the two system permissions, visible window count, cursor switch)
 *   POST /dsh-mac-computer-use/panel {action}  → cursor / copyInstall / copyUpdate / openSettings, returns the new status
 *
 * The page (client.js) runs in DSH's web client and can only use HTTP. Depending on the deployment the webServer
 * may have no auth of its own, and from a browser any web page can reach 127.0.0.1, so gate it here. Two shapes:
 *   local     — browser on this machine: loopback peer, local Host, cross-site Origin always rejected;
 *   front door — DSH's own (authenticated) web client reached as https://name through a proxy or a private-network
 *     peer: the Host name must be pinned in `panelHosts` (plugin config, ~/.dsh/dsh-mac-computer-use.json) so a
 *     rebound name cannot pose as it; cross-site Origin still rejected; POST must be JSON (cross-site requests
 *     cannot send that; they get blocked by the preflight first).
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import {
  findBin, overlayState, stopOverlay, permissions, readConfig, writeConfig, INSTALL_CMD, UPDATE_CMD, ENGINE_FEATURES, SETTINGS_PANES,
} from './setup.js'

export const PANEL_ROUTE = '/dsh-mac-computer-use/panel'

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '' }
})()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** Loopback plus private-link addresses (RFC1918, loopback net, IPv6 unique-local): DSH's web client may sit
 *  behind a proxy or on another machine of a private network; the public internet may not. */
function privateAddr(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '')
  if (LOOPBACK.has(a)) return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (v4) {
    const n1 = +v4[1], n2 = +v4[2]
    return n1 === 10 || n1 === 127 || (n1 === 192 && n2 === 168) || (n1 === 172 && n2 >= 16 && n2 <= 31)
  }
  return /^(?:f[cd])[0-9a-f]{2}:/i.test(a)
}

/** Host header without a trailing :port (IPv6 literals keep theirs). */
function bareHost(host) {
  const h = String(host || '')
  return h.endsWith(']') ? h : h.replace(/:\d+$/, '')
}

/** How many windows are visible: proves the command-line tool really runs. Returns null when it cannot. */
function countWindows(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['winlist'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : String(out).split('\n').filter(Boolean).length)
    })
  })
}

/** Engine feature flags (dsh-cu features, one per line). Old engines lack the command; returns an empty set */
function engineFeatures(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['features'], { timeout: 5000 }, (err, out) => {
      resolve(new Set(err ? [] : String(out).split('\n').map((l) => l.trim()).filter(Boolean)))
    })
  })
}

export async function panelState() {
  const base = { plugin: PKG_VERSION, platform: process.platform, showCursor: readConfig().showCursor !== false, installCmd: INSTALL_CMD, updateCmd: UPDATE_CMD }
  if (process.platform !== 'darwin') return base
  const bin = findBin()
  const [perms, windows, features] = await Promise.all([
    permissions(), bin ? countWindows(bin.path) : null, bin ? engineFeatures(bin.path) : new Set(),
  ])
  const outdated = ENGINE_FEATURES.some((f) => !features.has(f))
  return { ...base, bin: bin && { source: bin.source, outdated }, overlay: overlayState(), perms, windows }
}

/** Cross-site requests are always rejected; see the file header for the two accepted shapes. */
function gateOf(req, origin) {
  const addr = String(req.socket.remoteAddress || '')
  const host = String(req.headers.host || '')
  const local = LOOPBACK.has(addr) && LOOPBACK_HOST.test(host)
  const from = req.headers.origin
  if (local) {
    if (!from) return 'local'
    if (from === 'null') return ''
    let own
    try { own = origin() } catch { own = '' }
    if (from === own) return 'local'
    try {
      const a = new URL(from), b = new URL(own)
      if (LOOPBACK_HOST.test(a.host) && a.port === b.port && a.protocol === b.protocol) return 'local'
    } catch { /* fall through */ }
    return ''
  }
  // Front door: DSH's own authenticated web client through a proxy / private peer. The Host name must be pinned
  // (panelHosts) so a rebound name cannot pose as it; cross-site Origin is still rejected — same-origin GET sends
  // none, a same-site POST carries the page's own origin.
  if (!privateAddr(addr) || !host) return ''
  const pinned = readConfig().panelHosts
  if (!Array.isArray(pinned) || !pinned.map(bareHost).includes(bareHost(host))) return ''
  if (!from) return 'front'
  if (from === 'null') return ''
  try { return bareHost(new URL(from).host) === bareHost(host) ? 'front' : '' } catch { return '' }
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('not JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * @param deps.origin - the origin of DSH's own web client (webServer.getOrigin)
 * @param deps.trace - logging
 */
export function panelHandler({ origin, trace = () => {} }) {
  let served = false
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const gate = gateOf(req, origin)
    if (!gate) {
      trace(`settings panel route rejected a request: ${req.socket.remoteAddress} host=${req.headers.host} origin=${req.headers.origin}`)
      return send(403, { error: 'forbidden' })
    }
    if (!served) {
      served = true
      trace(`settings panel route serving via ${gate} (${req.method} from ${req.socket.remoteAddress} host=${req.headers.host})`)
    }
    if (req.method === 'GET') return send(200, await panelState())
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'expect application/json' })

    let body
    try { body = await readJson(req) } catch (e) { return send(400, { error: e.message }) }
    const extra = {}
    try {
      switch (body.action) {
        case 'cursor':
          writeConfig({ showCursor: !!body.on })
          if (!body.on) stopOverlay()
          trace(`settings panel: desktop cursor ${body.on ? 'on' : 'off'}`)
          break
        case 'copyInstall':
          execFileSync('/usr/bin/pbcopy', [], { input: INSTALL_CMD })
          extra.copied = true
          break
        case 'copyUpdate':
          execFileSync('/usr/bin/pbcopy', [], { input: UPDATE_CMD })
          extra.copied = true
          break
        case 'openSettings': {
          const url = SETTINGS_PANES[body.pane]
          if (!url) return send(400, { error: `unknown pane: ${body.pane}` })
          execFileSync('/usr/bin/open', [url], { stdio: 'ignore' })
          extra.opened = body.pane
          break
        }
        default:
          return send(400, { error: `unknown action: ${body.action}` })
      }
    } catch (e) {
      return send(200, { ...(await panelState()), actionError: String((e && e.message) || e) })
    }
    return send(200, { ...(await panelState()), ...extra })
  }
}
