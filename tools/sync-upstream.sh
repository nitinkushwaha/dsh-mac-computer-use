#!/usr/bin/env bash
# Sync this English fork with its upstream (OrderG-X/dsh-mac-computer-use).
#
# Usage:
#   ./tools/sync-upstream.sh           # fetch, merge upstream/main, report Chinese lines to re-translate
#   ./tools/sync-upstream.sh --check   # fetch and report only — no merge
#
# Exit codes: 0 = up to date (or merged) with nothing left to translate
#             1 = there are lines still containing Chinese — translate, commit, push
#             2 = preflight failed or merge conflict — resolve by hand (or `git merge --abort`)
set -euo pipefail

cd "$(dirname "$0")/.."

UPSTREAM_REPO='OrderG-X/dsh-mac-computer-use'
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

# -- preflight ----------------------------------------------------------------
[ -d .git ] || { echo "error: run from inside the repository" >&2; exit 2; }

current_branch="$(git branch --show-current)"
[ "$current_branch" = "main" ] || { echo "error: switch to main first (currently on '$current_branch')" >&2; exit 2; }

[ -z "$(git status --porcelain)" ] || { echo "error: working tree not clean — commit or stash first" >&2; exit 2; }

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
  echo "added upstream remote → ${UPSTREAM_REPO}"
fi

echo "== fetching upstream =="
git fetch upstream --prune --tags

# -- divergence ---------------------------------------------------------------
behind="$(git rev-list --count main..upstream/main)"
ahead="$(git rev-list --count upstream/main..main)"
echo "divergence: main is ${ahead} ahead, ${behind} behind upstream/main"

if [ "$behind" -gt 0 ]; then
  echo "== new upstream commits =="
  git log --oneline --no-decorate "main..upstream/main"
  if $CHECK_ONLY; then
    echo "(--check: not merging)"
  else
    echo "== merging upstream/main =="
    merge_ok=true
    if ! git merge --no-edit upstream/main; then
      merge_ok=false
    fi
    if ! $merge_ok; then
      echo
      echo "merge conflicts in:"
      git diff --name-only --diff-filter=U | sed 's/^/  /'
      echo "resolve them (re-translate where needed), then: git add -A && git commit"
      echo "or back out with: git merge --abort"
      exit 2
    fi
    echo "merged cleanly"
  fi
else
  echo "up to date with upstream/main — nothing to merge"
fi

# -- scan for Chinese needing re-translation ----------------------------------
# CJK ranges: punctuation \u3000-\u303f · ideographs \u4e00-\u9fff · full-width forms \uff00-\uffef
echo "== scanning tracked files for Chinese text =="
scan_rc=0
node -e '
const { execSync } = require("child_process");
const fs = require("fs");
const files = execSync("git ls-files -z", { maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
let hits = 0;
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue; // binary (gif/png/…)
  text.split("\n").forEach((line, i) => {
    if (cjk.test(line)) { hits++; console.log("  " + f + ":" + (i + 1) + ": " + line.trim().slice(0, 120)); }
  });
}
console.log(hits
  ? "\n" + hits + " line(s) still contain Chinese — re-translate them, then commit and push."
  : "clean — no Chinese in any tracked text file");
process.exit(hits ? 1 : 0);
' || scan_rc=$?

if [ "$scan_rc" -eq 0 ]; then
  if [ "$behind" -gt 0 ] && ! $CHECK_ONLY; then
    echo
    echo "next: git push origin main   (then 'gh workflow run ci.yml' if the push does not trigger CI)"
  fi
  exit 0
else
  exit 1
fi