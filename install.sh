#!/bin/bash
# dsh-mac-computer-use one-shot installer: builds the dsh-cu command-line engine and the cursor overlay (the cursor is drawn in code, no image assets needed).
# When it finishes, add this repo's plugin/ directory (or the repo URL) on the DSH Plugins page.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${DSH_BIN_DIR:-$HOME/.dsh/bin}"
SHARE="${DSH_SHARE_DIR:-$HOME/.dsh/share}"

echo "═══ dsh-mac-computer-use install ═══"
echo "  repo:   $HERE"
echo "  target: $BIN"
echo

# ── 0. Environment checks ─────────────────────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then
  echo "❌ macOS only (uses CGWindowList / AXUIElement / Vision)"; exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ swiftc not found. Install the Xcode Command Line Tools first:"
  echo "     xcode-select --install"
  exit 1
fi
mkdir -p "$BIN" "$SHARE"

# ── 1. Command-line tool ───────────────────────────────────────────────────────────
echo "① Building dsh-cu …"
swiftc -O -o "$BIN/dsh-cu" "$HERE/tools/dsh-cu.swift" \
  -framework AppKit -framework ApplicationServices -framework Vision
echo "   ✅ $BIN/dsh-cu"

# ── 2. Cursor overlay ─────────────────────────────────────────────────────────────
echo "② Building the cursor overlay …"
swiftc -O -o "$BIN/dsh-cursor-overlay" "$HERE/cursor/cursor-overlay.swift" \
  -framework AppKit -framework QuartzCore
echo "   ✅ $BIN/dsh-cursor-overlay"

# Prebuilt binaries left in the dev tree by packaging (npm pack): the plugin prefers those, so delete them to avoid running stale copies
if [ -d "$HERE/plugin/bin" ]; then
  rm -rf "$HERE/plugin/bin"
  echo "   (removed the stale packaged binaries from plugin/bin; the plugin will now use the copy in $BIN)"
fi

# ── 3. PATH ─────────────────────────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$BIN"; then
  echo
  echo "⚠️  $BIN is not on your PATH. Add it to your shell config:"
  echo "     echo 'export PATH=\"\$HOME/.dsh/bin:\$PATH\"' >> ~/.zshrc"
fi

cat <<EOF

═══ Done ═══

Quick self-test from the command line:
  $BIN/dsh-cu winlist          # list windows
  $BIN/dsh-cu observe <pid>    # screenshot with numbered clickable elements
  $HERE/tools/selftest.sh      # full end-to-end self-test

DSH plugin: go to the Plugins page and add either of these
  • this repo's URL (recommended — enables auto-updates)
  • or the local path $HERE/plugin

Restart DSH once the plugin is installed.
EOF
