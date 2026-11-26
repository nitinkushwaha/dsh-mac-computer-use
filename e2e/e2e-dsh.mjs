/**
 * Real-machine end-to-end: on a Mac with nothing preinstalled, does the package alone suffice
 *   ① pack (prepack builds the universal binaries); the package carries bin/dsh-cu and bin/dsh-cursor-overlay, executable, signed, both architectures
 *   ② install into a fresh DSH (dsh plugin add), start the web app; the settings panel reports "command-line tool installed · bundled with the plugin"
 *   ③ the installed binaries run: the protocol version matches; if Rosetta is present, the Intel slice runs too
 *   ④ the plugin's own desktop_windows tool lists windows through the bundled binary
 *
 *   node e2e/e2e-dsh.mjs [--dsh latest|next|<version>]
 * HOME and DSH_HOME are temporary: there is no ~/.dsh/bin, proving install.sh is not needed. Skipped unless macOS.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DSH_SPEC = argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : 'latest'
const REGISTRY = 'https://registry.npmjs.org/'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'package.json'), 'utf8'))
const ENGINE_PROTOCOL = '2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const summary = (title, lines) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${lines.join('\n')}\n\n`)
}
if (process.platform !== 'darwin') {
  console.log(`macOS only; skipped on ${OS}`)
  summary(`Mac desktop real-machine test · ${OS}`, ['- ⏭ macOS only, skipped'])
  process.exit(0)
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcu-e2e-')))
const HOME = path.join(tmp, 'home')
fs.mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.DSH_CU_CONFIG = path.join(tmp, 'config.json')
delete process.env.DSH_CU_BIN
delete process.env.DSH_CU_OVERLAY
fs.writeFileSync(process.env.DSH_CU_CONFIG, '{"showCursor":false}\n')
const env = { ...process.env, DSH_HOME: path.join(tmp, 'dsh-home'), npm_config_registry: REGISTRY }
env.PATH = `${path.join(tmp, 'cli', 'node_modules', '.bin')}${path.delimiter}${env.PATH}`
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 64 << 20, ...opts })
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra: cond ? '' : String(extra) })
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  return !!cond
}
const failed = () => results.filter((r) => !r.ok)

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 15000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')) })
  })
}

/** The binaries inside the plugin directory DSH installed (node_modules under DSH_HOME, deduplicated by real path) */
function installedBins(dir, out = new Set(), depth = 0) {
  if (depth > 12) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.name === 'dsh-cu' && path.basename(dir) === 'bin' && fs.existsSync(path.join(dir, '..', 'setup.js'))) out.add(fs.realpathSync(p))
    else if (e.isDirectory() || e.isSymbolicLink()) { try { if (fs.statSync(p).isDirectory()) installedBins(p, out, depth + 1) } catch {} }
  }
  return out
}

let web = null
let webLog = ''
let dshVersion = DSH_SPEC

try {
  // ① pack: prepack builds the bundled binaries
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  const pack = run('npm', ['pack', '--pack-destination', tmp], { cwd: path.join(ROOT, 'plugin') })
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!check('pack (also builds the bundled binaries)', pack.code === 0 && tgz, pack.out.slice(-1500))) throw new Error('pack failed')
  const listing = run('tar', ['-tvzf', path.join(tmp, tgz)]).out
  for (const name of ['dsh-cu', 'dsh-cursor-overlay']) {
    const line = listing.split('\n').find((l) => l.endsWith(`package/bin/${name}`)) || ''
    check(`package carries ${name}, executable`, /^-rwxr-xr-x/.test(line), line || 'missing')
  }

  // ② install into a fresh DSH
  fs.writeFileSync(path.join(tmp, 'cli', 'package.json'), '{"private":true}')
  const inst = run('npm', ['i', `@deepseek-ai/dsh@${DSH_SPEC}`, 'pnpm@11', `--registry=${REGISTRY}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(tmp, 'cli') })
  if (!check(`install DSH ${DSH_SPEC}`, inst.code === 0, inst.out.slice(-1500))) throw new Error('DSH not installed')
  const cliDir = path.join(tmp, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  dshVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
  console.log(`  DSH ${dshVersion}`)
  const add = run(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'plugin', '--profile', 'web', 'add', path.join(tmp, tgz)], { cwd: tmp })
  if (!check('DSH installed the plugin', add.code === 0, add.out.slice(-1500))) throw new Error('plugin not installed')
  check('no ~/.dsh/bin (install.sh not needed)', !fs.existsSync(path.join(HOME, '.dsh', 'bin', 'dsh-cu')))

  const url = await new Promise((resolve) => {
    web = spawn(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (d) => { webLog = (webLog + d).slice(-50000); const m = /dsh web: (http:\/\/\S+)/.exec(webLog); if (m) resolve(m[1]) }
    web.stdout.on('data', on)
    web.stderr.on('data', on)
    web.on('exit', () => resolve(null))
    setTimeout(() => resolve(null), 180_000)
  })
  if (!check('DSH web app started', url, webLog.slice(-2000))) throw new Error('web app did not start')

  let st = null
  let last = ''
  for (let i = 0; i < 60 && !st; i++) {
    try {
      const r = await get(`${new URL(url).origin}/dsh-mac-computer-use/panel`)
      last = `HTTP ${r.status} ${r.text.slice(0, 200)}`
      if (r.status === 200) st = JSON.parse(r.text)
    } catch (e) { last = e.message }
    if (!st) await sleep(1000)
  }
  if (!check('settings panel API works', st, last)) throw new Error('settings panel has no data')
  check('settings panel reports the right plugin version', st.plugin === PKG.version, st.plugin)
  check('settings panel: CLI tool installed · bundled with the plugin', st.bin && st.bin.source === 'bundled' && !st.bin.outdated, JSON.stringify(st.bin))
  check('settings panel: cursor overlay installed', st.overlay && st.overlay.installed, JSON.stringify(st.overlay))

  // ③ the installed binaries
  const bins = [...installedBins(path.join(tmp, 'dsh-home'))]
  if (!check('bundled binaries present in the installed plugin', bins.length > 0, 'not found')) throw new Error('installed binaries not found')
  const bin = bins[0]
  check('protocol version matches', run(bin, ['version']).out === ENGINE_PROTOCOL, run(bin, ['version']).out)
  const archs = run('lipo', ['-archs', bin]).out
  check('both Apple silicon and Intel slices present', /arm64/.test(archs) && /x86_64/.test(archs), archs)
  check('signed (Apple silicon runs only signed binaries)', run('codesign', ['-v', bin]).code === 0, run('codesign', ['-v', bin]).out)
  const minos = (/minos (\S+)/.exec(run('vtool', ['-show-build', bin]).out) || [])[1]
  check('minimum macOS 11', minos === '11.0', minos)
  if (run('arch', ['-x86_64', '/usr/bin/true']).code === 0) {
    check('Intel slice runs too (Rosetta)', run('arch', ['-x86_64', bin, 'version']).out === ENGINE_PROTOCOL)
  } else {
    console.log('  (no Rosetta on this machine; Intel slice not run)')
  }

  // ④ the plugin's own tools
  const plugin = await import(pathToFileURL(path.join(path.dirname(path.dirname(bin)), 'index.js')))
  const tools = new Map()
  plugin.apply({ tools: { register: (t) => tools.set(t.name, t) }, get() {}, inject() {} }, {})
  check('desktop_* tools registered', tools.size >= 10 && tools.has('desktop_windows'), [...tools.keys()].join(','))
  const r = await tools.get('desktop_windows').execute({}, {})
  check('desktop_windows lists windows via the bundled binary', /pid=\d+ win=\d+/.test(String(r.text)) || r.text === '(no matching windows)', String(r.text).slice(0, 300))
} catch (e) {
  check('no exception', false, (e && e.stack) || e)
} finally {
  if (failed().length) console.log(`\n── DSH web app log ──\n${webLog.split('\n').slice(-30).join('\n')}`)
  if (web && web.exitCode === null) web.kill('SIGTERM')
  await sleep(1500)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  summary(`Mac desktop real-machine test · ${OS} · DSH ${dshVersion}`, results.map((x) => `- ${x.ok ? '✅' : '❌'} ${x.name}${x.ok ? '' : `: ${x.extra.split('\n')[0]}`}`))
  console.log(failed().length ? `\n❌ ${failed().length} failed` : '\n✅ all passed')
  process.exit(failed().length ? 1 : 0)
}
