/**
 * Backend for the settings card on DSH's plugin page: one HTTP route mounted on DSH's own webServer.
 *
 *   GET  /dsh-mac-computer-use/panel           → status (command-line tool, cursor overlay, the two system permissions, visible window count, cursor switch)
 *   POST /dsh-mac-computer-use/panel {action}  → cursor / copyInstall / copyUpdate / openSettings, returns the new status
 *
 * The page (client.js) runs in DSH's web client and can only use HTTP. The webServer does no auth of its own,
 * and from a browser any web page can reach 127.0.0.1, so gate it here: loopback connections only, Host must be a local name,
 * cross-site Origin always rejected, POST must be JSON (cross-site requests cannot send that; they get blocked by the preflight first).
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

/** Cross-site requests are always rejected: no Origin header (same-origin GET, curl) passes; if present, it must be DSH itself. */
function allowed(req, origin) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false
  if (!LOOPBACK_HOST.test(req.headers.host || '')) return false
  const from = req.headers.origin
  if (!from) return true
  if (from === 'null') return false
  let own
  try { own = origin() } catch { own = '' }
  if (from === own) return true
  try {
    const a = new URL(from), b = new URL(own)
    return LOOPBACK_HOST.test(a.host) && a.port === b.port && a.protocol === b.protocol
  } catch {
    return false
  }
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
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!allowed(req, origin)) {
      trace(`settings panel route rejected a request: ${req.socket.remoteAddress} host=${req.headers.host} origin=${req.headers.origin}`)
      return send(403, { error: 'forbidden' })
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
