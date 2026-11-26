/**
 * Local environment: where the command-line engine dsh-cu lives, whether the cursor overlay is installed, whether DSH has the system permissions, user settings.
 * Shared by the tools (index.js) and the DSH settings panel (panel.js).
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Binaries bundled in the package (universal builds made at release time, run on Apple silicon and Intel), see tools/build-bin.mjs */
const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin')

/** Bundled binary: make sure it is executable (some install methods drop the exec bit), returns the path; null when missing */
function bundled(name) {
  if (process.platform !== 'darwin') return null
  const p = path.join(BUNDLED_DIR, name)
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return p
  } catch {}
  try {
    fs.chmodSync(p, 0o755)
    fs.accessSync(p, fs.constants.X_OK)
    return p
  } catch {
    return null
  }
}

// locate dsh-cu: env var first, then the plugin's bundled copy, then the install.sh location, finally the dev folder (for local debugging)
const CANDIDATES = [
  ['env', process.env.DSH_CU_BIN],
  ['bundled', bundled('dsh-cu')],
  ['installed', path.join(os.homedir(), '.dsh/bin/dsh-cu')],
  ['dev', path.join(os.homedir(), 'Projects/dsh-cua-patched/tools/dsh-cu')],
].filter(([, p]) => p)

export const INSTALL_CMD = 'git clone https://github.com/nitinkushwaha/dsh-mac-computer-use.git && cd dsh-mac-computer-use && ./install.sh'

/** Engine update: clone (or update) a source copy in the home directory and reinstall. A previous clone elsewhere does not matter; it always installs to ~/.dsh/bin */
export const UPDATE_CMD = 'cd ~ && { [ -d dsh-mac-computer-use ] || git clone https://github.com/nitinkushwaha/dsh-mac-computer-use.git; } && cd dsh-mac-computer-use && git pull --ff-only && ./install.sh'

/** Engine features that keep the protocol version (dsh-cu features). Missing ones do not block use; the settings panel only shows an "engine update available" hint */
export const ENGINE_FEATURES = ['window-shot']

/** Error shown when the binary cannot be found: must carry public install steps, not just paths that only make sense on this machine. */
export const INSTALL_HINT = [
  'Command-line engine dsh-cu not found. The plugin package ships one; first update the plugin to the latest version in DSH, or reinstall it.',
  'If that still fails, build it from source (one-time):',
  '1. Install the Xcode Command Line Tools (provides swiftc): xcode-select --install',
  '2. Fetch the source and build:',
  `     ${INSTALL_CMD}`,
  '   It builds dsh-cu and the cursor overlay with swiftc and installs them into ~/.dsh/bin/',
  '3. Come back here and retry (to check whether it is installed: ls ~/.dsh/bin/dsh-cu)',
  'If the binary lives somewhere else, point DSH_CU_BIN=/path/to/dsh-cu at it.',
].join('\n')

/** @returns {{ path: string, source: 'env'|'bundled'|'installed'|'dev' } | null} */
export function findBin() {
  for (const [source, p] of CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return { path: p, source } } catch {}
  }
  return null
}

export const OVERLAY = process.env.DSH_CU_OVERLAY || bundled('dsh-cursor-overlay') || path.join(os.homedir(), '.dsh/bin/dsh-cursor-overlay')

// only the current account's overlay counts: one run by another account is neither counted nor killed
// there is no getuid on Windows / Linux: calling it at module top level would make the whole plugin import fail (DSH would show it as "not started")
const UID = typeof process.getuid === 'function' ? String(process.getuid()) : ''
const MINE = ['-U', UID, '-f', 'dsh-cursor-overlay']

export function overlayState() {
  let installed = false, running = false
  try { fs.accessSync(OVERLAY, fs.constants.X_OK); installed = true } catch {}
  try { execFileSync('/usr/bin/pgrep', MINE, { stdio: 'ignore' }); running = true } catch {}
  return { installed, running }
}

export function stopOverlay() {
  try { execFileSync('/usr/bin/pkill', MINE, { stdio: 'ignore' }) } catch { /* not running anyway */ }
}

// ── System permissions ─────────────────────────────────────────────────────
// osascript is spawned by DSH, so the system attributes permissions to the "responsible app"; what is checked here is DSH itself.
// CGPreflightScreenCaptureAccess is not in JXA's default bridge; bind it manually.

const PERM_JXA = [
  'ObjC.import("ApplicationServices")',
  'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []])',
  'JSON.stringify({ screen: $.CGPreflightScreenCaptureAccess(), ax: $.AXIsProcessTrusted() })',
].join(';')

let permCache = { at: 0, value: null }

/** @returns {Promise<{ screen: boolean|null, ax: boolean|null }>} null = cannot be determined */
export function permissions(maxAgeMs = 5000) {
  if (permCache.value && Date.now() - permCache.at < maxAgeMs) return Promise.resolve(permCache.value)
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PERM_JXA], { timeout: 5000 }, (err, out) => {
      let value = { screen: null, ax: null }
      if (!err) {
        try { const p = JSON.parse(String(out).trim()); value = { screen: !!p.screen, ax: !!p.ax } } catch {}
      }
      permCache = { at: Date.now(), value }
      resolve(value)
    })
  })
}

export const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
}

// ── User settings ──────────────────────────────────────────────────────────
// stored at ~/.dsh/dsh-mac-computer-use.json. Read fresh every time (the file is tiny), so changes from the settings panel take effect immediately without restarting DSH.

export const CONFIG_FILE = process.env.DSH_CU_CONFIG || path.join(os.homedir(), '.dsh/dsh-mac-computer-use.json')
const DEFAULTS = { showCursor: true }

export function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch { return { ...DEFAULTS } }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
  return next
}
