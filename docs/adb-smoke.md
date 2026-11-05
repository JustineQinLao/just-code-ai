# Phone smoke check (adb)

Device: R8YL104VK6R. Real run: set `justCode.phoneServer` to true, run *JustCode: Show Phone Pairing*, note the token.

## Scripted run

```
npm test                          # builds out-test/phone.js
scripts/adb-smoke.sh [--record]   # env: ADB_SERIAL, TOKEN (tok), OUT (docs/smoke), WAIT (3)
```
It starts the fake backend (canned tasks, token "tok"), runs `adb reverse`, opens the page, then: add task -> permission card -> Approve -> Merge button -> Merge, OK -> task shows "done".
Each step waits 3s and saves `docs/smoke/NN-*.png`; `--record` also pulls `docs/smoke/smoke.mp4` (`screenrecord`, 180s max). The backend and the reverse are cleaned up on exit. Read the screenshots to judge the run.
Taps use `uiautomator` text lookup, falling back to coordinates for an 800x1340 screen (the page text isn't in the UI tree on the Samsung browser); adjust them in the script for other screens or if the page layout changes.

## Manual steps

```
node scripts/fake-phone-backend.js "$PWD/out-test/phone.js"
adb reverse tcp:7878 tcp:7878              # real run: skip this and use the computer's LAN address instead
adb shell am start -a android.intent.action.VIEW -d "http://localhost:7878/?token=tok" com.sec.android.app.sbrowser
adb exec-out screencap -p > /tmp/01-open.png
```
Then tap (`adb shell input tap X Y`, `adb shell input text`), wait 3s, screencap each step. Clean up: `adb reverse --remove tcp:7878`.
