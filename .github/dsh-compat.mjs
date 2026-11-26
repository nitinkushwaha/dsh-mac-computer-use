#!/usr/bin/env node
// DSH compatibility check: installs this plugin into a fresh temporary DSH, starts the web app once,
// opens it with headless Chrome, and checks three things: DSH accepts the install (version range),
// the backend starts, and the frontend loads without errors.
//
//   node .github/dsh-compat.mjs <plugin.tgz> [--dsh latest|next|<version>] [--cli-dir <dir>] [--keep]
//
// Touches only temp dirs: both DSH_HOME and HOME point inside the mkdtemp output, so the real ~/.dsh is never read or written.
// --cli-dir: install the DSH CLI into this directory and reuse it on later runs (CI caches it on Windows:
//   DSH is 1.4 GB / 90k+ files; a fresh install takes 10+ minutes). Every run asks npm which version the tag
//   resolves to now and reinstalls on mismatch, so new DSH releases are still tested. The plugin itself is installed fresh every run.
// This template lives in dsh-plugins/_ci/ and is synced into five repos via _ci/sync.sh; edit the template, not the per-repo copy.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args.splice(i, 2)[1] }
const keep = args.includes('--keep') && args.splice(args.indexOf('--keep'), 1)
const dshSpec = flag('--dsh', 'latest')
const cliOpt = flag('--cli-dir', '')
const tgz = path.resolve(args[0] || '')
if (!args[0] || !fs.existsSync(tgz)) { console.error('Usage: node dsh-compat.mjs <plugin.tgz> [--dsh latest|next|<version>]'); process.exit(2) }

const REGISTRY = 'https://registry.npmjs.org/'
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-')))
const env = { ...process.env, DSH_HOME: path.join(tmp, 'dsh-home'), HOME: path.join(tmp, 'home'), npm_config_registry: REGISTRY }
for (const d of [env.DSH_HOME, env.HOME]) fs.mkdirSync(d, { recursive: true })

const problems = []
const notes = []
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
const WIN = process.platform === 'win32'
let server = null
let chrome = null

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { env, encoding: 'utf8', maxBuffer: 64 << 20, ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }
}
// On Windows kill() ends only the process itself; DSH and Chrome child processes must be torn down tree-style or the temp dir cannot be deleted
function stop(p, signal) {
  if (!p || p.exitCode !== null) return
  try { WIN ? spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { timeout: 30_000 }) : p.kill(signal) } catch {}
}
function finish() {
  stop(server, 'SIGTERM')
  stop(chrome, 'SIGKILL')
  const ok = problems.length === 0
  const lines = [
    `## ${OS} · DSH ${dshVersion || dshSpec} · ${pkgName || path.basename(tgz)}`,
    ok ? '✅ Compatible: installs, backend starts, frontend loads without errors' : '❌ Incompatible',
    ...problems.map((p) => `- ❌ ${p}`),
    ...notes.map((n) => `- ℹ️ ${n}`),
  ]
  console.log('\n' + lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n\n')
  if (keep) console.log('Temp dir kept at', tmp)
  else try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch (e) { console.log('Failed to fully remove temp dir:', e.message) }
  process.exit(ok ? 0 : 1)
}
let dshVersion = ''
let pkgName = ''

// 1. Install the given DSH CLI version, plus the pnpm it needs for plugin installs (not preinstalled on GitHub runners)
const npm = WIN ? 'npm.cmd' : 'npm'
const npmFlags = [`--registry=${REGISTRY}`, '--no-audit', '--no-fund', '--loglevel=error']
const installCli = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}')
  return run(npm, ['i', `@deepseek-ai/dsh@${dshSpec}`, 'pnpm@11', ...npmFlags], { cwd: dir, shell: WIN })
}
let cliRoot = path.join(tmp, 'cli')
let inst
if (cliOpt) {
  // Which version the tag resolves to now (asked fresh every run, so a new DSH release mismatches and triggers a reinstall); the installed dir records which DSH version and which node ABI it was built for
  cliRoot = path.resolve(cliOpt)
  const stampFile = path.join(cliRoot, 'dsh-compat.json')
  const view = run(npm, ['view', `@deepseek-ai/dsh@${dshSpec}`, 'version', '--json', ...npmFlags], { cwd: tmp, shell: WIN })
  let want = ''
  try { want = [].concat(JSON.parse(view.stdout.trim())).pop() || '' } catch {}
  let stamp = null
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')) } catch {}
  const node = process.versions.modules
  if (want && stamp?.dsh === want && stamp.node === node && fs.existsSync(path.join(cliRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    inst = { code: 0, out: '' }
    console.log(`Using the cached DSH CLI (${want}): ${cliRoot}`)
  } else {
    // Install alongside first, move into place only on success: a half-done install never leaves a directory that looks complete and gets cached
    const fresh = `${cliRoot}.new`
    inst = installCli(fresh)
    if (inst.code === 0) {
      const v = JSON.parse(fs.readFileSync(path.join(fresh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
      fs.writeFileSync(path.join(fresh, 'dsh-compat.json'), JSON.stringify({ dsh: v, node }))
      fs.rmSync(cliRoot, { recursive: true, force: true })
      fs.renameSync(fresh, cliRoot)
    }
  }
} else {
  inst = installCli(cliRoot)
}
const PATH_KEY = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH' // Called Path on Windows
env[PATH_KEY] = `${path.join(cliRoot, 'node_modules', '.bin')}${path.delimiter}${env[PATH_KEY]}`
if (inst.code !== 0) { problems.push(`Cannot install @deepseek-ai/dsh@${dshSpec} (npm exit code ${inst.code})\n\n${inst.out.slice(-2000)}`); finish() }
const cliDir = path.join(cliRoot, 'node_modules', '@deepseek-ai', 'dsh')
dshVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
const dsh = (argv, opts) => run(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), ...argv], opts)
console.log(`DSH ${dshVersion} (${dshSpec})`)

// Start the web app: proc is the process, url resolves when it prints its address (null if it never starts), log() returns the output so far
function startWeb() {
  let text = ''
  let proc = null
  const url = new Promise((resolve) => {
    proc = spawn(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (d) => { text += d; const m = /dsh web: (http:\/\/\S+)/.exec(text); if (m) resolve(m[1]) }
    proc.stdout.on('data', on)
    proc.stderr.on('data', on)
    proc.on('exit', () => resolve(null))
    setTimeout(() => resolve(null), 180_000)
  })
  return { proc, url, log: () => text }
}
const startupErrors = (text) => text.split(/\n(?=\S)/).filter((b) => /did not activate|incompatible|Error/i.test(b)).map((b) => b.trim())
// Each non-activated entry is its own paragraph, e.g. "image-offload (@deepseek-ai/dsh-compaction-image-offload): Error: …"; recognized by the leading "name (package):" prefix
const entryOf = (b) => (/^(\S+ \([^()\s]+\)):/.exec(b) || [])[1] || null

// 1b. Boot once without the plugin and record the errors DSH already emits on its own: afterwards, only entries added by the plugin count against it
// If it won't start, retry once; a second failure fails the check (with no baseline we cannot tell which DSH built-in the plugin crowded out, so it cannot pass as compatible)
let baseline = null
for (let attempt = 1; attempt <= 2 && !baseline; attempt++) {
  const bare = startWeb()
  if (await bare.url) {
    await new Promise((r) => setTimeout(r, 3000))
    baseline = new Set(startupErrors(bare.log()).map(entryOf).filter(Boolean))
  } else if (attempt === 2) {
    problems.push(`Web failed to start twice even without the plugin; startup errors cannot be compared against a run with the plugin\n\n${bare.log().slice(-2000)}`)
  }
  const exited = new Promise((r) => (bare.proc.exitCode !== null ? r() : bare.proc.once('exit', r)))
  stop(bare.proc, 'SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))])
}

// 2. Install the tgz into the web profile with DSH's own plugin installer (rejected here on version incompatibility)
const add = dsh(['plugin', '--profile', 'web', 'add', tgz], { cwd: tmp })
const profile = path.join(env.DSH_HOME, 'profiles', 'web')
if (add.code !== 0) {
  const rejected = (add.out.match(/installation rejected:[^\n]*/) || [])[0]
  const why = rejected || add.out.split('\n').filter((l) => /dsh:|ERR/.test(l)).join('\n')
  problems.push(`DSH ${dshVersion} ${rejected ? 'rejected the install' : 'install failed'}: ${why.slice(0, 1500)}`)
  finish()
}
const pj = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
pkgName = Object.keys(pj.dependencies || {}).find((n) => String(pj.dependencies[n]).includes(path.basename(tgz))) || ''
if (!pkgName) { problems.push('Install finished but the package is not in the profile'); finish() }
const clientWanted = (() => {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', pkgName, 'package.json'), 'utf8')).dsh?.client) } catch { return false }
})()
console.log(`Installed ${pkgName}`)

// 2b. Every DSH built-in plugin referenced by the config (e.g. a preset copied from the standard one) must still exist in this version: one missing and the whole group referencing it fails to start, often without a word in the log
{
  const pkgDir = path.join(profile, 'node_modules', pkgName)
  let text = ''
  const patch = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dsh?.bundle?.patch
  for (const f of [].concat(patch || [])) { // one path or a list of paths
    try { text += fs.readFileSync(path.join(pkgDir, f), 'utf8') + '\n' } catch (e) { problems.push(`Cannot read ${f} listed in dsh.bundle.patch: ${e.message}`) }
  }
  text = text.replace(/(^|\s)#.*$/gm, '$1') // plugin names inside YAML comments do not count
  // The "enabled only if the package resolves" spot: the line right after name is disabled: !!js whose .resolve( names that package — on older DSH without it, the entry disables itself, which does not count as missing.
  // Decided per reference: unguarded references to the same package elsewhere are still checked
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const guardedAt = (m) => new RegExp(`^['"]?[ \\t]*\\r?\\n[ \\t]*disabled:[ \\t]*!!js[^\\n]*\\.resolve\\(\\s*['"]${esc(m[1])}(?:/package\\.json)?['"]`).test(text.slice(m.index + m[0].length))
  const refs = [...new Set([...text.matchAll(/^\s*(?:-\s+)?name:\s*['"]?(@deepseek-ai\/[\w.-]+(?:\/[\w./-]+)?)/gm)].filter((m) => !guardedAt(m)).map((m) => m[1]))]
  const roots = [path.join(cliRoot, 'node_modules'), path.join(cliDir, 'node_modules'), path.join(profile, 'node_modules')]
  // The subpath is in exports: an exact key, or a wildcard like "./x/*"
  const exported = (ex, sub) => Object.keys(ex).some((k) => k === sub || (k.includes('*') && new RegExp(`^${k.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`).test(sub)))
  const gone = refs.filter((ref) => {
    const [scope, base, ...sub] = ref.split('/')
    const dir = roots.map((r) => path.join(r, scope, base)).find((d) => fs.existsSync(path.join(d, 'package.json')))
    if (!dir) return true
    if (!sub.length) return false
    const ex = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).exports
    return Boolean(ex && typeof ex === 'object') && !exported(ex, `./${sub.join('/')}`) // no exports field = cannot judge, let it pass
  })
  if (gone.length) problems.push(`DSH plugins referenced by the config no longer exist in ${dshVersion}: ${gone.join(', ')} (the group referencing them fails to start as a whole)`)
}

// 3. Start the web app and wait for it to print its address; any "did not activate" entry in the startup log that mentions us is a failure.
//    Entries that do not mention us but are new versus the no-plugin baseline also fail: the plugin most likely crowded out a DSH built-in (e.g. registering the same name first, bridge #4)
const web = startWeb()
server = web.proc
const url = await web.url
const log = web.log()
if (!url) { problems.push(`Web failed to start\n\n${log.slice(-3000)}`); finish() }
await new Promise((r) => setTimeout(r, 3000))
const mentions = (s) => s.includes(pkgName) || s.includes(pkgName.replace(/^@[^/]+\//, ''))
const failed = startupErrors(web.log())
// Entries that were fine without the plugin but error with it installed: most likely crowded out by the plugin (e.g. it registered the thing first)
const extra = baseline ? failed.filter((b) => !mentions(b) && entryOf(b) && !baseline.has(entryOf(b))) : []
for (const b of failed) {
  if (mentions(b)) problems.push(`Startup log: ${b.slice(0, 1500)}`)
  else if (extra.includes(b)) problems.push(`A DSH built-in did not start with the plugin installed (absent without it): ${b.slice(0, 1500)}`)
  else notes.push(`Startup log: ${b.slice(0, 1500)}`)
}

// 4. Open once with headless Chrome: our frontend module must get loaded (HTTP 200) and there must be no uncaught exceptions
const chromeBin = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap((d) => [path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
].find((p) => fs.existsSync(p))
if (!chromeBin) { notes.push('Chrome not found; skipping frontend checks'); finish() }
chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox',
  `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
const wsUrl = await new Promise((resolve) => {
  let b = ''
  chrome.stderr.on('data', (d) => { b += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(b); if (m) resolve(m[1]) })
  setTimeout(() => resolve(null), 30_000)
})
if (!wsUrl) { notes.push('Chrome failed to start; skipping frontend checks'); finish() }
const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m)
})
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
for (const d of ['Runtime', 'Log', 'Network', 'Page']) await send(`${d}.enable`)
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 15_000))

const responses = events.filter((e) => e.method === 'Network.responseReceived').map((e) => e.params.response)
const clientPath = `${pkgName}/client.js`
const clientRes = responses.filter((r) => r.url.includes(clientPath))
if (clientWanted && !clientRes.length) problems.push(`Frontend module ${clientPath} was not loaded`)
for (const r of clientRes) if (r.status !== 200) problems.push(`Frontend module failed to load: HTTP ${r.status}`)
for (const e of events) {
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails
    const text = `${d.exception?.description || d.text} @ ${d.url || ''}`
    problems.push(`Uncaught frontend exception: ${text.slice(0, 1500)}`)
  }
  if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
    const text = e.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    ;(mentions(text) ? problems : notes).push(`Frontend console.error: ${text.slice(0, 800)}`)
  }
}
const title = await send('Runtime.evaluate', { expression: 'document.title' })
if (!/DeepSeek/i.test(title.result?.result?.value || '')) problems.push(`Page did not open (title: ${title.result?.result?.value})`)
ws.close()
finish()
