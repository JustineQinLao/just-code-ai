#!/usr/bin/env bash
# Scripted phone smoke run (see docs/adb-smoke.md). Screenshots each step to docs/smoke/.
# Usage: scripts/adb-smoke.sh [--record]     env: ADB_SERIAL, TOKEN (tok), OUT (docs/smoke)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=7878; TOKEN=${TOKEN:-tok}; OUT=${OUT:-docs/smoke}; WAIT=${WAIT:-3}
RECORD=0; [ "${1:-}" = "--record" ] && RECORD=1
A=(adb); [ -n "${ADB_SERIAL:-}" ] && A=(adb -s "$ADB_SERIAL")
mkdir -p "$OUT"
BACKEND_PID=""; REC_PID=""

cleanup() {
  [ -n "$REC_PID" ] && { "${A[@]}" shell pkill -2 screenrecord 2>/dev/null || true; wait "$REC_PID" 2>/dev/null || true
    sleep 1; "${A[@]}" pull /sdcard/jc-smoke.mp4 "$OUT/smoke.mp4" >/dev/null 2>&1 && echo "recorded $OUT/smoke.mp4"
    "${A[@]}" shell rm -f /sdcard/jc-smoke.mp4 || true; }
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  "${A[@]}" shell rm -f /sdcard/jc-ui.xml || true
  "${A[@]}" reverse --remove "tcp:$PORT" 2>/dev/null || true
}
trap cleanup EXIT

shot() { sleep "$WAIT"; "${A[@]}" exec-out screencap -p > "$OUT/$1.png"; echo "shot $OUT/$1.png"; }

# tap the centre of the first UI element whose text/content-desc contains $1
tap_text() {
  "${A[@]}" shell uiautomator dump /sdcard/jc-ui.xml >/dev/null
  local xy
  xy=$("${A[@]}" exec-out cat /sdcard/jc-ui.xml | node -e '
    const x=require("fs").readFileSync(0,"utf8"),want=process.argv[1].toLowerCase();
    for(const m of x.matchAll(/<node [^>]*>/g)){const t=m[0];
      const s=((t.match(/ text="([^"]*)"/)||[])[1]||"")+"|"+((t.match(/content-desc="([^"]*)"/)||[])[1]||"");
      const b=t.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if(b&&s.toLowerCase().includes(want)){console.log(((+b[1]+ +b[3])>>1)+" "+((+b[2]+ +b[4])>>1));break}}' "$1")
  # web content is often not in the UI tree: fall back to the given X Y (800x1340 screen)
  [ -n "$xy" ] || xy="${2:-} ${3:-}"
  [ "$xy" != " " ] || { echo "no element with text '$1'" >&2; exit 1; }
  "${A[@]}" shell input tap $xy
}

if [ ! -f out-test/phone.js ]; then echo "run npm test first (builds out-test/phone.js)" >&2; exit 1; fi
node scripts/fake-phone-backend.js "$PWD/out-test/phone.js" >/tmp/jc-smoke-backend.log 2>&1 &
BACKEND_PID=$!
for _ in $(seq 50); do grep -q "^up" /tmp/jc-smoke-backend.log && break; sleep 0.2; done
grep -q "^up" /tmp/jc-smoke-backend.log || { echo "backend did not start" >&2; exit 1; }

"${A[@]}" reverse "tcp:$PORT" "tcp:$PORT"
if [ $RECORD = 1 ]; then "${A[@]}" shell screenrecord --time-limit 180 /sdcard/jc-smoke.mp4 & REC_PID=$!; fi
"${A[@]}" shell am start -a android.intent.action.VIEW -d "http://localhost:$PORT/?token=$TOKEN" com.sec.android.app.sbrowser >/dev/null
shot 01-open

tap_text "New task title" 400 321
"${A[@]}" shell input text "Smoke%stask"
shot 02-add-task
tap_text "Add + run" 72 388
shot 03-permission
tap_text "Approve" 91 738
shot 04-merge-button
tap_text "Merge" 70 641
shot 05-confirm
tap_text "Merge" 311 782
shot 06-done
echo "done: screenshots in $OUT"
