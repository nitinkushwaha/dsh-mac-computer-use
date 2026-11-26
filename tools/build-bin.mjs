#!/usr/bin/env node
/**
 * Before packing (npm pack's prepack step), build the dsh-cu engine and the cursor overlay into
 * universal binaries (Apple silicon + Intel, macOS 11+) and drop them into plugin/bin/:
 * the plugin works right after install, with no repo clone or Xcode build required.
 *
 * Not macOS, or no swiftc: skip (the plugin falls back to ~/.dsh/bin when the bundled binary is missing).
 * But on a CI Mac the binaries must build; a failed build fails the pack, so we never ship a broken package.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'plugin', 'bin')
const MIN_MACOS = '11.0'
const ARCHS = ['arm64', 'x86_64']
const TARGETS = [
  { name: 'dsh-cu', src: 'tools/dsh-cu.swift', frameworks: ['AppKit', 'ApplicationServices', 'Vision'] },
  { name: 'dsh-cursor-overlay', src: 'cursor/cursor-overlay.swift', frameworks: ['AppKit', 'QuartzCore'] },
]

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
const has = (cmd) => { try { run('/usr/bin/which', [cmd]); return true } catch { return false } }

// Clear out the old binaries first: if sources changed without a rebuild, better to ship none than a mismatched set
fs.rmSync(OUT, { recursive: true, force: true })

if (process.platform !== 'darwin' || !has('swiftc')) {
  if (process.platform === 'darwin' && process.env.CI) {
    console.error('❌ swiftc not found on the CI Mac; cannot build the bundled binaries')
    process.exit(1)
  }
  console.log('Skipping: bundled binaries must be built on a Mac with swiftc installed')
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cu-build-'))
try {
  fs.mkdirSync(OUT, { recursive: true })
  for (const t of TARGETS) {
    const slices = ARCHS.map((arch) => {
      const out = path.join(tmp, `${t.name}-${arch}`)
      run('swiftc', ['-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, '-o', out, path.join(ROOT, t.src), ...t.frameworks.flatMap((f) => ['-framework', f])])
      return out
    })
    const file = path.join(OUT, t.name)
    run('lipo', ['-create', '-output', file, ...slices])
    // Apple silicon only runs signed binaries: re-sign locally after the merge
    run('codesign', ['--force', '--sign', '-', file])
    fs.chmodSync(file, 0o755)
    console.log(`✓ ${path.relative(ROOT, file)} (${run('lipo', ['-archs', file]).trim()})`)
  }
  const proto = run(path.join(OUT, 'dsh-cu'), ['version']).trim()
  console.log(`✓ engine protocol ${proto}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
