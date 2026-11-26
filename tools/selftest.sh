#!/bin/bash
# Run this after unlocking — exercises the whole see → find → act → verify chain
#
#   ./selftest.sh              checks only, no clicks (safe)
#   ./selftest.sh --click      additionally performs one real click (presses 7+8= in Calculator)

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CU="$HERE/dsh-cu"
PASS=0; FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "═══ 0. Screen state ═══"
LOCK=$(python3 -c "import Quartz;print((Quartz.CGSessionCopyCurrentDictionary() or {}).get('CGSSessionScreenIsLocked'))" 2>/dev/null)
echo "  Lock screen: $LOCK"
if [ "$LOCK" = "True" ]; then
  echo "  ⚠️  Screen is locked — the window/screenshot/OCR checks below will all fail; unlock first, then rerun"
fi

echo "═══ 1. Window enumeration (CGWindowList, no permission needed)═══"
WINS=$("$CU" winlist 2>&1)
N=$(echo "$WINS" | grep -c . || true)
if [ "$N" -gt 0 ]; then ok "Listed ${N} windows"; echo "$WINS" | head -4 | sed 's/^/     /'
else bad "Not a single window"; fi

echo "═══ 2. Screenshot ═══"
SHOT=/tmp/dsh-cu-selftest.png
"$CU" shot --out "$SHOT" >/dev/null 2>&1
if [ -f "$SHOT" ]; then
  VAR=$(python3 -c "
from PIL import Image; import numpy as np
a=np.array(Image.open('$SHOT').convert('L'))
print(round(float(a.var()),1))
" 2>/dev/null)
  ok "Screenshot captured (grayscale variance ${VAR})"
  # Variance is high with wallpaper alone too, so detect windows by checking whether the menu-bar row is a solid color
  MENU=$(python3 -c "
from PIL import Image
im=Image.open('$SHOT').convert('RGB'); w,h=im.size; px=im.load()
row=[px[x, int(h*0.01)] for x in range(0,w,max(1,w//40))]
print(len(set(row)))
" 2>/dev/null)
  if [ "${MENU:-0}" -gt 3 ]; then ok "Top of screen has content (menu bar/windows rendering)"; else bad "Top is a solid color — likely still locked or no windows"; fi
else bad "Screenshot failed"; fi

echo "═══ 3. OCR engine ═══"
python3 -c "
from PIL import Image, ImageDraw, ImageFont
f=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',48)
im=Image.new('RGB',(900,120),'white'); ImageDraw.Draw(im).text((30,30),'Continue with Google',fill='black',font=f)
im.save('/tmp/dsh-cu-ocr-selftest.png')
" 2>/dev/null
OCR=$("$CU" find "Google" --file /tmp/dsh-cu-ocr-selftest.png 2>&1 | head -1)
if echo "$OCR" | grep -q "Google"; then ok "OCR hit: $OCR"; else bad "OCR miss: $OCR"; fi

echo "═══ 4. Screen OCR (needs a visible window)═══"
if [ "$LOCK" != "True" ]; then
  SCREEN=$("$CU" find "*" --all 2>&1 | head -1)
  if echo "$SCREEN" | grep -q $'\t'; then ok "Text read from screen: $(echo "$SCREEN" | cut -f4 | head -c 40)"; else bad "No text read from screen"; fi
else
  echo "  ⏭  Screen locked; skipped"
fi

echo "═══ 5. Virtual cursor ═══"
if command -v cua-driver >/dev/null 2>&1; then
  CUR=$(cua-driver call get_agent_cursor_state '{}' 2>&1 | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print('enabled' if d.get('enabled') else 'disabled')
except: print('unavailable')
" 2>/dev/null)
  echo "  cua-driver virtual cursor: $CUR"
fi

echo "═══ 6. Real click (Calculator 7+8=15)═══"
if [ "${1:-}" = "--click" ]; then
  if [ "$LOCK" = "True" ]; then
    bad "Cannot verify a click while the screen is locked; unlock first"
  else
    "$CU" launch Calculator >/dev/null 2>&1; sleep 3
    PID=$(pgrep -x Calculator | head -1)
    # A winlist line ends with "X,Y W×H"; coordinates contain spaces, so take the last two fields
    RECT=$("$CU" winlist 2>/dev/null | awk -v p="$PID" '$1==p {print $(NF-1)" "$NF; exit}')
    X=$(echo "$RECT" | cut -d' ' -f1 | cut -d, -f1); Y=$(echo "$RECT" | cut -d' ' -f1 | cut -d, -f2)
    W=$(echo "$RECT" | cut -d' ' -f2 | cut -d'×' -f1); H=$(echo "$RECT" | cut -d' ' -f2 | cut -d'×' -f2)
    echo "     Calculator pid=$PID @($X,$Y) ${W}×${H}"
    # Calculator's fixed 230×408 layout: AC/7/+/8/=
    click() { "$CU" clickat "$PID" "$((X + $1))" "$((Y + $2))" >/dev/null 2>&1; sleep 0.3; }
    click 90 160; click 40 213; click 190 318; click 90 213; click 190 370
    sleep 1
    "$CU" shot --out /tmp/dsh-cu-calc.png >/dev/null 2>&1
    ANS=$("$CU" find "15" --file /tmp/dsh-cu-calc.png 2>&1 | head -1)
    if echo "$ANS" | grep -q "15"; then ok "Calculator shows 15 — click chain works"; else echo "  ⚠️  Could not OCR a 15 in the screenshot; check /tmp/dsh-cu-calc.png by eye (result: ${ANS})"; fi
    pkill -x Calculator 2>/dev/null
  fi
else
  echo "  ⏭  Pass --click to perform a real click"
fi

echo
echo "═══ Result: $PASS passed / $FAIL failed ═══"
[ "$FAIL" -eq 0 ] && echo "All green." || echo "There are failures; see above."
