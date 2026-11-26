/**
 * dsh-mac-computer-use — gives DSH a set of Mac desktop-control tools (visual-first)
 *
 * Why not dsh-computer-use / cua-driver: that stack depends on the macOS accessibility tree (AX),
 * and on this machine third-party binaries cannot get AXWindow (most obvious while the screen is locked). This plugin takes the **visual route** instead:
 *
 *   see windows  → CGWindowList (needs no permission at all)
 *   see content  → screencapture (DSH already holds the Screen Recording permission)
 *   act          → CGEvent delivered to the target process (doesn't move your real mouse, doesn't steal focus)
 *
 * This is exactly the Codex-style computer-use approach, and currently the only route proven to work on this machine.
 *
 * The underlying engine is dsh-cu (a single-file Swift CLI, source in the repo's tools/). Releases ship it prebuilt in the package's bin/, ready to use right after install;
 * you can also use install.sh to build it into ~/.dsh/bin/ yourself.
 * The local environment (where the CLI lives, permissions, user settings) lives in setup.js; the DSH settings panel has its backend in panel.js and its front end in client.js.
 */

import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { findBin, INSTALL_CMD, INSTALL_HINT, OVERLAY, readConfig } from './setup.js'
import { PANEL_ROUTE, panelHandler } from './panel.js'

export const name = 'dsh-mac-computer-use'
export const inject = ['tools']

const TRACE = '/tmp/dsh-mac-computer-use.log'
function trace(line) {
  try { fs.appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`) } catch {}
}

function cuBin() {
  const bin = findBin()
  if (!bin) throw new Error(INSTALL_HINT)
  return bin.path
}

// ── System-wide cursor overlay ─────────────────────────────────────────────
// When the user wants to see the actions, something has to move on screen. The overlay is a separate NSPanel process:
// no focus stealing, click-through, always on top. Started here on demand — only when a desktop action first needs it,
// no login daemon needed, zero user effort. Turning "show cursor" off in the DSH settings panel keeps it from starting, and the CLI is not told to start it either.
// The overlay quits by itself after 60 idle seconds, so probe every time: if the FIFO opens non-blocking there is a reader = the overlay is alive.

// Under the user's private temp dir (0700): other accounts can neither squat it nor read it; dsh-cu and the overlay share the same algorithm (confstr DARWIN_USER_TEMP_DIR)
const FIFO = (() => { try { return path.join(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(), 'dsh-cursor.fifo') } catch { return path.join(os.tmpdir(), 'dsh-cursor.fifo') } })()
// If the overlay cannot be started (e.g. a broken binary), back off for 5 minutes so desktop actions don't wait in vain every time
let cursorFailedAt = 0
// The in-flight overlay start: concurrent tool calls await it together instead of starting two
let cursorStarting = null

const cursorOn = () => readConfig().showCursor !== false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fifoOpen() {
  try {
    if (!fs.statSync(FIFO).isFIFO()) return -1          // never write into a leftover regular file
    return fs.openSync(FIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  } catch { return -1 }                                  // no file / no reader (ENXIO)
}

/** Only the current account's overlay counts: one run by another account does not (otherwise every action would wait on that FIFO in vain) */
function overlayRunning() {
  return new Promise((resolve) => {
    if (typeof process.getuid !== 'function') return resolve(false)
    execFile('/usr/bin/pgrep', ['-U', String(process.getuid()), '-f', 'dsh-cursor-overlay'], (err) => resolve(!err))
  })
}

/** Wait for the overlay to be ready asynchronously: the DSH host is single-threaded and must never sleep synchronously (Atomics.wait used to freeze the whole of DSH for up to 2 seconds) */
function ensureCursor() {
  if (!cursorOn()) return Promise.resolve()
  if (!cursorStarting) cursorStarting = startCursor().finally(() => { cursorStarting = null })
  return cursorStarting
}

async function startCursor() {
  const fd = fifoOpen()
  if (fd >= 0) { fs.closeSync(fd); return }
  // process alive but FIFO not ready = just started (the first launch of a fresh binary triggers a macOS verification, a bit slower): wait for it instead of starting a second one
  const running = await overlayRunning()
  if (!running) {
    if (Date.now() - cursorFailedAt < 5 * 60_000) return
    try {
      fs.accessSync(OVERLAY, fs.constants.X_OK)
      // Pass the FIFO explicitly: older overlays still default to the shared /tmp path
      const child = spawn(OVERLAY, ['--fifo', FIFO], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (e) {
      cursorFailedAt = Date.now()
      trace(`cursor overlay failed to start: ${e && e.message} (actions unaffected, the cursor is just invisible; retrying in 5 minutes)`)
      return
    }
  }
  // Wait for the overlay to open the FIFO read end (up to 2 seconds), otherwise this round of cursor commands is lost
  for (let i = 0; i < 40; i++) {
    await sleep(50)
    const f = fifoOpen()
    if (f >= 0) {
      fs.closeSync(f)
      cursorFailedAt = 0
      if (!running) trace('cursor overlay started')
      return
    }
  }
  if (!(await overlayRunning())) {
    cursorFailedAt = Date.now()
    trace('cursor overlay failed to start: not seen within 2 seconds of launch (actions unaffected, the cursor is just invisible; retrying in 5 minutes)')
  }
}

/** Send a few commands to the overlay (move / label / click …). Skipped when the overlay is not running; never slows an action down. */
function cursorSay(...cmds) {
  if (!cursorOn()) return
  const fd = fifoOpen()
  if (fd < 0) return
  try { fs.writeSync(fd, cmds.map((c) => String(c).replace(/[\r\n]+/g, ' ') + '\n').join('')) } catch {}
  finally { try { fs.closeSync(fd) } catch {} }
}

/** Short text for the cursor name tag */
const short = (s, n = 14) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Does the text being typed look like a password: a run with no spaces and no CJK characters is not written onto the screen */
const typedLabel = (text) => {
  const t = String(text ?? '')
  return /\s|[\u3000-\u9fff\uac00-\ud7af]/.test(t) ? `typing "${short(t, 12)}"` : `typing ${t.length} characters`
}

/**
 * Protocol version agreed with the engine (ENGINE_PROTOCOL in tools/dsh-cu.swift). The engine bundled with the plugin always matches; with DSH_CU_BIN or an engine from a dev folder
 * the two sides may disagree: an old engine treats new arguments as the output path and scrolls in the old units. So verify on first use, and run nothing when it does not match.
 */
const ENGINE_PROTOCOL = '2'
let engineOk = ''                                         // engine that passed verification (path + mtime + size); re-verified automatically after a reinstall

function engineKey(bin) {
  try { const st = fs.statSync(bin); return `${bin}:${st.mtimeMs}:${st.size}` } catch { return bin }
}

async function checkEngine(bin) {
  const key = engineKey(bin)
  if (key === engineOk) return
  const got = await exec(bin, ['version'], 10000).catch(() => '')
  if (got !== ENGINE_PROTOCOL) {
    throw new Error(
      `wrong CLI engine version (the plugin needs ${ENGINE_PROTOCOL}, the engine ${got ? `is ${got.slice(0, 20)}` : 'is too old and has no version command'}); nothing was run this time.` +
      `Re-run ./install.sh at the root of the dsh-mac-computer-use repo, then retry (no repo? install fresh: ${INSTALL_CMD})`)
  }
  engineOk = key
}

/** Engine features that keep the protocol version (dsh-cu features); an empty set when an old engine lacks the command. Cached per engine file, re-queried after a reinstall */
let featureCache = { key: '', set: new Set() }
async function engineFeatures() {
  const bin = cuBin()
  const key = engineKey(bin)
  if (key !== featureCache.key) {
    const out = await exec(bin, ['features'], 10000).catch(() => '')
    featureCache = { key, set: new Set(out.split('\n').map((l) => l.trim()).filter(Boolean)) }
  }
  return featureCache.set
}

/** Run the system's own little helpers (screencapture / sips) without blocking DSH */
function execFileP(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, out) => (err ? reject(err) : resolve(String(out))))
  })
}

/**
 * On an old engine (install.sh not re-run, no shot --window) the plugin captures the window itself: screencapture -l <window id>, resized to the "point" size,
 * with the same coordinate mapping as the engine ("1 pixel = 1 point"). Returns null when capture fails or the image ratio is off (same fits rule as the engine); the caller then falls back to a screen-area capture
 */
async function shootWindow(w, file) {
  try {
    await execFileP('/usr/sbin/screencapture', ['-x', '-o', '-l', String(w.windowId), file])
    const dims = await execFileP('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
    const pw = Number((/pixelWidth:\s*(\d+)/.exec(dims) || [])[1])
    const ph = Number((/pixelHeight:\s*(\d+)/.exec(dims) || [])[1])
    const sx = pw / w.width, sy = ph / w.height
    if (!(sx >= 0.5 && Math.abs(sx - sy) < 0.05)) return null
    if (pw !== w.width || ph !== w.height) {
      await execFileP('/usr/bin/sips', ['-z', String(w.height), String(w.width), file, '--out', file])
    }
    return { x: w.x, y: w.y, width: w.width, height: w.height }
  } catch {
    return null
  }
}

async function run(args, timeoutMs = 30000) {
  const bin = cuBin()
  await checkEngine(bin)
  return exec(bin, args, timeoutMs)
}

function exec(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; reject(new Error(`dsh-cu timed out (${timeoutMs}ms)`)) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`failed to start dsh-cu: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(out.trim())
      const e = new Error(err.trim() || out.trim() || `dsh-cu exited with code ${code}`)
      e.exitCode = code                                   // callers branch on the exit code (find's 2 = not found)
      reject(e)
    })
  })
}

// ── Tool shell (imports nothing from @deepseek-ai/*, shape hand-rolled to match dsh-tools output) ───────

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    execute: options.execute,
  }
}

const textOutput = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: { text: { type: 'string' } }, required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

/** render is synchronous; execute stashes attachment references here and render fetches them back by token */
const shotRefs = new Map()

/** OCR-find text → screen coordinates (dsh-cu find outputs "index\tx,y\tconfidence\ttext") */
async function findText(text, pid) {
  const a = ['find', text]
  if (pid) a.push('--pid', String(pid))
  let out
  try {
    out = await run(a, 60000)
  } catch (e) {
    // only exit code 2 means "not found"; a missing binary, a timeout, a missing permission or a failed screenshot is reported as-is — never dressed up as "not found"
    if (e.exitCode === 2) {
      throw new Error(`did not find "${text}" on screen${pid ? ` (window pid=${pid})` : ''}. Take a desktop_screenshot first to see what is on screen right now`)
    }
    throw new Error(`OCR text search failed: ${e.message}`)
  }
  const line = out.split('\n')[0]
  const [idx, xy, conf, ...rest] = line.split('\t')
  const [x, y] = (xy || '').split(',').map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`could not parse the OCR result: ${line}`)
  return { x, y, conf: conf || '?', text: rest.join('\t') || text }
}

// "x,y w×h": x and y go negative when a secondary display sits to the left of / above the main one
const RECT_RE = /(-?\d+),(-?\d+) (\d+)×(\d+)/

/** Second line of dsh-cu shot output, "rect\tx,y w×h": the screen area (in points) the screenshot covers */
function parseRect(raw) {
  const m = RECT_RE.exec(raw.split('\n').find((l) => l.startsWith('rect\t')) || '')
  return m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null
}

/** Tells the model how to convert image coordinates into click coordinates. Images come out in "points"; k = the factor maxWidth shrank the image by */
function mapping(rect, k = 1) {
  if (k === 1 && rect.x === 0 && rect.y === 0) return 'Image coordinates are screen coordinates and can be passed straight to desktop_click.'
  const f = (o, v) => (k === 1 ? `${o} + ${v}` : `${o} + ${v}×${Number(k.toFixed(3))}`)
  return `Image (u, v) maps to screen coordinates (${f(rect.x, 'u')}, ${f(rect.y, 'v')}); convert before passing to desktop_click.`
}

/** Screenshot temp files go here: a fresh 0700 subdirectory under the user's own temp dir (unreadable by other accounts), deleted whole afterwards */
const privateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-'))
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

/** Positive-integer parameters (the hand-rolled defineTool does no input validation, so gatekeep here); returns undefined when not given */
function positiveInt(value, name) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  return n
}

function parseWindows(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const [pid, wid, app, title, bounds] = line.split('\t')
    const m = RECT_RE.exec(bounds || '')
    return {
      pid: Number(pid), windowId: Number(wid), app, title,
      x: m ? Number(m[1]) : 0, y: m ? Number(m[2]) : 0,
      width: m ? Number(m[3]) : 0, height: m ? Number(m[4]) : 0,
    }
  })
}

const q = (t) => `"${String(t || '').slice(0, 40)}"`

/**
 * Two window lists, before and after an action → one line saying what the action did to the windows (new window, gone, title changed, another app popped up a window).
 * Looks at windows only, not their contents; use desktop_observe for contents.
 */
export function windowChanges(before, after, pid) {
  const old = new Map(before.map((w) => [w.windowId, w]))
  const now = new Map(after.map((w) => [w.windowId, w]))
  const name = (w) => (w.title ? q(w.title) : `(${w.app})`)
  // tiny untitled strips (Chrome's bottom-left URL bar, tooltip bubbles) flash by in an instant and do not count as window changes
  const blip = (w) => !w.title && w.height > 0 && w.height < 60
  const out = []
  for (const w of after) {
    const o = old.get(w.windowId)
    if (!o && blip(w)) continue
    if (!o) out.push(w.pid === pid ? `opened a new window ${name(w)}` : `${w.app} popped up a window ${name(w)}`)
    else if (o.title !== w.title && w.pid === pid) out.push(`title ${q(o.title)}→${q(w.title)}`)
  }
  for (const w of before) if (w.pid === pid && !now.has(w.windowId) && !blip(w)) out.push(`window ${name(w)} disappeared (closed or minimized)`)
  if (!out.length) return 'After: no window changes'
  return `After: ${out.slice(0, 5).join('; ')}${out.length > 5 ? ` (+${out.length} in total)` : ''}`
}

export function apply(ctx, config) {
  trace('apply called')

  const snapWindows = () => run(['winlist'], 5000).then(parseWindows, () => null)
  /** Run one action and report window changes with it: the model does not need another screenshot to confirm "the click landed / a dialog popped up" */
  async function report(pid, act) {
    const before = await snapWindows()
    const text = await act()
    if (!before) return text
    await sleep(400) // give the UI a moment to react
    const after = await snapWindows()
    return after ? `${text}\n${windowChanges(before, after, Number(pid))}` : text
  }

  const tools = [
    defineTool({
      name: 'desktop_windows',
      description:
        'Lists all visible windows on the current screen, with pid, window id, app name, title and **screen coordinates** (top-left x,y plus width and height). ' +
        'Get your target and its coordinates here before any desktop action. Needs no accessibility permission and always works.',
      parameters: {
        filter: { type: 'string', description: 'Optional: filter by app name or title (case-insensitive)' },
      },
      output: textOutput,
      presentCall: present('Desktop windows'),
      async execute(args) {
        const wins = parseWindows(await run(['winlist']))
        const f = (args.filter || '').toLowerCase()
        const list = f ? wins.filter((w) => w.app.toLowerCase().includes(f) || w.title.toLowerCase().includes(f)) : wins
        if (!list.length) return { text: '(no matching windows)' }
        return {
          text: list.map((w) =>
            `pid=${w.pid} win=${w.windowId} ${w.app}${w.title ? ` «${w.title.slice(0, 40)}»` : ''} @(${w.x},${w.y}) ${w.width}×${w.height}`
          ).join('\n'),
        }
      },
    }),

    defineTool({
      name: 'desktop_screenshot',
      description:
        'Screenshots the screen or a single window and returns the image directly. With a pid, captures only that app\'s frontmost window (on any display, even covered by other windows — the window itself is still captured), ' +
        'otherwise captures the main display. Images come out in "points" (1 pixel = 1 point): on a full-screen image the coordinates are screen coordinates; the conversion for a window image is stated in the returned text. ' +
        '**Screenshot first, locate the button, then desktop_click by coordinate** — that is the recommended workflow.',
      parameters: {
        pid: { type: 'integer', description: 'Optional: capture only this process\'s window' },
        maxWidth: { type: 'integer', description: 'Optional: shrink to this many pixels wide (no shrinking by default; once shrunk, convert coordinates by the factor stated in the returned text)' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, token: { type: 'string' } },
          required: ['text', 'token'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          const ref = shotRefs.get(value.token)
          if (ref) { shotRefs.delete(value.token); blocks.push({ type: 'image', attachment: ref }) }
          return blocks
        },
      },
      presentCall: present('Desktop screenshot'),
      async execute(args) {
        const maxWidth = positiveInt(args.maxWidth, 'maxWidth')
        const dir = privateDir()
        const file = path.join(dir, 'shot.png')
        let keep = false
        try {
          const a = ['shot']
          let target = 'main display'
          let rect = null
          if (args.pid) {
            const wins = parseWindows(await run(['winlist'])).filter((w) => w.pid === Number(args.pid))
            if (!wins.length) throw new Error(`pid ${args.pid} has no visible window (the app has no window open, the window is minimized, or it lives in another desktop space)`)
            const w = wins[0]
            target = `${w.app} «${w.title}»`
            if ((await engineFeatures()).has('window-shot')) {
              // the engine captures the window itself by window id (works even when covered); if it can't, it falls back to a screen-area capture on its own
              a.push('--window', String(w.windowId))
            } else {
              // old engine: the plugin captures by window id itself; if that fails, let the engine crop using the origin and scale of the display the window sits on (correct for Retina / secondary displays / negative coordinates)
              rect = await shootWindow(w, file)
              if (!rect) a.push('--rect', `${w.x},${w.y},${w.width},${w.height}`)
            }
          }
          if (!rect) {
            a.push('--out', file)                       // last on purpose: even an old engine (takes the last argument as the output path) then only writes into the private directory
            rect = parseRect(await run(a, 60000))
            if (!rect) throw new Error('dsh-cu shot returned no capture rect: the CLI engine is too old, re-run install.sh')
          }
          let buf = fs.readFileSync(file)
          let k = 1
          if (maxWidth && maxWidth < rect.width && buf.length > 200_000) {
            execFileSync('/usr/bin/sips', ['--resampleWidth', String(maxWidth), file, '--out', file], { stdio: 'ignore' })
            buf = fs.readFileSync(file)
            k = rect.width / maxWidth
          }
          const note = `Screenshot (${target} @(${rect.x},${rect.y}) ${rect.width}×${rect.height}, ${Math.round(buf.length / 1024)}KB)\n${mapping(rect, k)}`
          const attachments = ctx.get('attachments')
          if (attachments) {
            try {
              const [ref] = await attachments.saveImages([{ data: buf, mediaType: 'image/png', name: `desktop-${Date.now()}.png` }])
              const token = crypto.randomUUID()
              shotRefs.set(token, ref)
              if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
              return { text: note, token }
            } catch { /* fall back to saving the file */ }
          }
          keep = true
          return { text: `${note}\n(attachment store unavailable, saved to ${file})`, token: '' }
        } finally {
          if (!keep) removeDir(dir)
        }
      },
    }),

    defineTool({
      name: 'desktop_click',
      description:
        'Click. **Prefer text** (OCR the text on screen, then click it — the most reliable way, immune to layout shifts); ' +
        'fall back to x/y coordinates (from desktop_screenshot or desktop_windows) when the text cannot be found. ' +
        'By default **delivered directly to the target process** (doesn\'t move your real mouse, doesn\'t steal focus); add global=true to go through system events for apps that don\'t respond. ' +
        'The result appends one line about window changes (new window / gone / title changed / no change); typing, keys and dragging report the same way.',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid (from desktop_windows)' },
        index: { type: 'integer', description: 'the number given by desktop_observe — **most recommended**, steadier than coordinates' },
        text: { type: 'string', description: 'the text to click (located via OCR, e.g. "Log In", "Continue")' },
        x: { type: 'integer', description: 'screen coordinate X (top-left origin); required when text is not given' },
        y: { type: 'integer', description: 'screen coordinate Y (top-left origin); required when text is not given' },
        global: { type: 'boolean', description: 'true = go through system events and move the real mouse (default false)' },
      },
      output: textOutput,
      presentCall: present('Desktop click'),
      async execute(args) {
        if (args.index) {
          await ensureCursor()
          const a = ['click-index', String(args.pid), String(args.index)]
          if (!cursorOn()) a.push('--no-cursor')
          return { text: await report(args.pid, () => run(a)) }
        }
        let x = args.x, y = args.y, how = 'coordinates'
        if (args.text) {
          const hit = await findText(args.text, args.pid)
          x = hit.x; y = hit.y; how = `text "${hit.text}"`
        }
        if (x === undefined || y === undefined) throw new Error('give either text, or both x and y')
        await ensureCursor()
        cursorSay(args.text ? `label click ${short(args.text)}` : 'label click')
        const a = ['clickat', String(args.pid), String(Math.round(x)), String(Math.round(y))]
        if (args.global) a.push('--global')
        if (!cursorOn()) a.push('--no-cursor')
        // trust the engine's real result: a dead process or a missing accessibility permission makes the engine error out — don't blanket-claim the click landed
        return { text: await report(args.pid, async () => { const out = await run(a); return args.text ? `${out} (${how})` : out }) }
      },
    }),

    defineTool({
      name: 'desktop_observe',
      description:
        '**The preferred first step for desktop work**: captures the target window and marks every clickable element (buttons/input fields/links/checkboxes…) on the image with blue numbers, ' +
        'and returns the numbered list (number / type / label / coordinates). ' +
        'Then click element N directly with `desktop_click(pid, index=N)` — far more reliable than guessing coordinates. ' +
        '(How: enumerates elements via the macOS accessibility tree; unavailable on the lock screen — in that case use desktop_screenshot + desktop_find_text instead.)',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid (from desktop_windows)' },
        limit: { type: 'integer', description: 'maximum number of elements to mark, default 60' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, token: { type: 'string' } },
          required: ['text', 'token'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          const ref = shotRefs.get(value.token)
          if (ref) { shotRefs.delete(value.token); blocks.push({ type: 'image', attachment: ref }) }
          return blocks
        },
      },
      presentCall: present('Desktop observe'),
      async execute(args) {
        const limit = positiveInt(args.limit, 'limit')
        const dir = privateDir()
        const out = path.join(dir, `observe-${args.pid}.png`)
        let keep = false
        try {
          const a = ['observe', String(args.pid)]
          if (limit) a.push('--limit', String(limit))
          if (!cursorOn()) a.push('--no-cursor')
          a.push('--out', out)                          // placed last, same reason as desktop_screenshot
          await ensureCursor()
          cursorSay('label inspecting window')
          let raw
          try {
            raw = await run(a, 60000)
          } catch (e) {
            throw new Error(`${e.message}\n(if the app has no window, or the screen is locked, use desktop_screenshot + desktop_find_text instead)`)
          }
          const lines = raw.split('\n')
          const file = lines[0]
          const win = (lines.find((l) => l.startsWith('window\t')) || '').split('\t')[1] || ''
          const items = lines.filter((l) => /^\d+\t/.test(l))
          const text = `Window ${win}, ${items.length} clickable elements:\n` +
            items.map((l) => { const [i, role, label, xy] = l.split('\t'); return `  [${i}] ${role.replace('AX', '')} «${label}» @${xy}` }).join('\n')

          const buf = fs.readFileSync(file)
          const attachments = ctx.get('attachments')
          if (attachments) {
            try {
              const [ref] = await attachments.saveImages([{ data: buf, mediaType: 'image/png', name: `observe-${args.pid}.png` }])
              const token = crypto.randomUUID()
              shotRefs.set(token, ref)
              if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
              return { text, token }
            } catch {}
          }
          keep = true
          return { text: `${text}\n(attachment store unavailable, annotated image at ${file})`, token: '' }
        } finally {
          if (!keep) removeDir(dir)
        }
      },
    }),

    defineTool({
      name: 'desktop_find_text',
      description:
        'OCR-finds text on screen and returns its screen coordinates (feed them straight to desktop_click). ' +
        'Use it when no element can be found in the UI and you would otherwise be guessing coordinates. A pid restricts the search to that window.',
      parameters: {
        text: { type: 'string', required: true, description: 'the text to find (supports Chinese and English)' },
        pid: { type: 'integer', description: 'Optional: search only in this process\'s windows' },
      },
      output: textOutput,
      presentCall: present('Desktop find text'),
      async execute(args) {
        const hit = await findText(args.text, args.pid)
        return { text: `Found "${hit.text}" @ (${Math.round(hit.x)}, ${Math.round(hit.y)})  confidence ${hit.conf}` }
      },
    }),

    defineTool({
      name: 'desktop_type',
      description: 'Types text into the target process (supports Chinese). Usually desktop_click the input field first.',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid' },
        text: { type: 'string', required: true, description: 'the text to type' },
      },
      output: textOutput,
      presentCall: present('Desktop type'),
      async execute(args) {
        cursorSay(`label ${typedLabel(args.text)}`)
        return { text: await report(args.pid, () => run(['type', String(args.pid), args.text])) }
      },
    }),

    defineTool({
      name: 'desktop_apps',
      description: 'Lists running apps (pid + name + bundleId, * = currently frontmost). Get a pid here before operating on an app.',
      parameters: {},
      output: textOutput,
      presentCall: present('Desktop apps'),
      async execute() {
        const out = await run(['apps'])
        const list = out.split('\n').filter(Boolean)
        return { text: list.length ? list.join('\n') : '(no running apps)' }
      },
    }),

    defineTool({
      name: 'desktop_launch',
      description: 'Launches an app **in the background** (doesn\'t steal focus, doesn\'t interrupt the user). The target can be an app name (e.g. "TextEdit", "Calculator") or a bundleId (e.g. "com.apple.TextEdit").',
      parameters: {
        target: { type: 'string', required: true, description: 'app name or bundleId' },
      },
      output: textOutput,
      presentCall: present('Desktop launch'),
      async execute(args) {
        return { text: await run(['launch', args.target], 30000) }
      },
    }),

    defineTool({
      name: 'desktop_scroll',
      description: 'Scrolls at (x, y) in the target window; the unit is "lines" (usually 3~10). Positive dy scrolls down, negative scrolls up; positive dx scrolls right, negative scrolls left (default 0).',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid' },
        x: { type: 'integer', required: true, description: 'screen coordinate X where the wheel acts' },
        y: { type: 'integer', required: true, description: 'screen coordinate Y where the wheel acts' },
        dy: { type: 'integer', required: true, description: 'lines to scroll vertically (positive=down, negative=up)' },
        dx: { type: 'integer', description: 'lines to scroll horizontally (positive=right, negative=left), default 0' },
      },
      output: textOutput,
      presentCall: present('Desktop scroll'),
      async execute(args) {
        await ensureCursor()
        cursorSay(`label ${args.dy < 0 ? 'scrolling up' : 'scrolling down'}`)
        // scroll-lines: the unit is lines, positive=down. An old engine that doesn't know this name errors out instead of scrolling the wrong way in pixels
        const a = ['scroll-lines', String(args.pid), String(args.x), String(args.y), String(args.dy)]
        if (args.dx) a.push(String(args.dx))
        if (!cursorOn()) a.push('--no-cursor')
        return { text: await run(a) }
      },
    }),

    defineTool({
      name: 'desktop_drag',
      description: 'Drags from (x1,y1) to (x2,y2). For dragging files, moving sliders or selecting text.',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid' },
        x1: { type: 'integer', required: true, description: 'start X' },
        y1: { type: 'integer', required: true, description: 'start Y' },
        x2: { type: 'integer', required: true, description: 'end X' },
        y2: { type: 'integer', required: true, description: 'end Y' },
      },
      output: textOutput,
      presentCall: present('Desktop drag'),
      async execute(args) {
        await ensureCursor()
        cursorSay('label drag')
        const a = ['drag', String(args.pid), String(args.x1), String(args.y1), String(args.x2), String(args.y2)]
        if (!cursorOn()) a.push('--no-cursor')
        return { text: await report(args.pid, () => run(a)) }
      },
    }),

    defineTool({
      name: 'desktop_key',
      description:
        'Sends key presses to the target process. keycode uses macOS virtual key codes (Return 36, Tab 48, Esc 53, Space 49, ' +
        'arrow keys 123-126, Delete 51). Modifier flags: cmd / shift / alt / ctrl, e.g. cmd+shift is ["cmd","shift"]. ' +
        'When the target is in the background, system shortcuts involving cmd (select all / copy / paste) mostly have no effect.',
      parameters: {
        pid: { type: 'integer', required: true, description: 'target process pid' },
        keycode: { type: 'integer', required: true, description: 'macOS virtual key code, e.g. Return 36' },
        flags: { type: 'array', items: { type: 'string' }, description: 'modifiers: cmd / shift / alt / ctrl' },
      },
      output: textOutput,
      presentCall: present('Desktop key'),
      async execute(args) {
        const a = ['key', String(args.pid), String(args.keycode), ...(args.flags || [])]
        return { text: await report(args.pid, () => run(a)) }
      },
    }),
  ]

  // on non-macOS the model does not get these tools (they cannot work); the settings panel still mounts, and the card says "macOS only"
  if (process.platform !== 'darwin') {
    trace(`not macOS (${process.platform}); desktop tools not registered`)
  } else {
    for (const tool of tools) {
      try { ctx.tools.register(tool) } catch (e) { trace(`failed to register ${tool.name}: ${e && e.message}`); throw e }
    }
    trace(`registered ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`)
  }

  // data route for the DSH settings panel. If it fails to mount, only the panel goes without data — never let it break tool registration
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        if (!sub || typeof sub.effect !== 'function' || !sub.webServer) return
        sub.effect(() => sub.webServer.register({
          kind: 'exact', path: PANEL_ROUTE,
          handler: panelHandler({ origin: () => sub.webServer.getOrigin(), trace }),
        }), 'dsh-mac-computer-use: settings panel route')
        trace(`settings panel route mounted at ${PANEL_ROUTE}`)
      })
    }
  } catch (e) { trace(`settings panel route not mounted (ignored): ${e && e.message}`) }
}

trace('module loaded')
