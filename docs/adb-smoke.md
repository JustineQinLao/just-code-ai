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

## Live extension run (real backend)

The token lives in VS Code's secret storage and is only shown in the modal from *JustCode: Show Phone Pairing* (or the Phone Link QR), so this part is manual:

```
npm run compile
code --extensionDevelopmentPath="$PWD" /path/to/a/git/project     # Extension Development Host
# in that window: set justCode.phoneServer = true, run "JustCode: Show Phone Pairing", copy the token
adb reverse tcp:7878 tcp:7878
adb shell am start -a android.intent.action.VIEW -d "http://localhost:7878/?token=<TOKEN>" com.sec.android.app.sbrowser
```
Then repeat the steps from the scripted run, screencapping each one (`adb exec-out screencap -p > docs/smoke/live-NN.png`). Differences from the fake: the task really starts a Claude run in a branch, so the permission card depends on what the agent asks for; use a task like "run npm test" to trigger a Bash card. Clean up with `adb reverse --remove tcp:7878`.
`scripts/adb-smoke.sh` can't drive this: it launches the fake backend and hardcodes token "tok".

## Smoke steps: project picker, tabs, moves
After the main run, on the phone page: (1) the project buttons sit under the header and the current one is highlighted; tap another and the list reloads. (2) Tap each tab (todo, doing, review, done); counts match the cards. (3) On a todo card tap *Move to doing*: it leaves To do and shows under the Doing tab. (4) Confirm no card offers *Move to done*; a done move is blocked (use Merge). The scripted run and fake backend do not cover these yet.

## Move menu and long-press drag
Each non-done card has a *Move to…* select (todo/doing/review); picking one posts `{type:'move'}` to /api/act and reloads. Long-press (~0.5s) a card and drag onto a tab to do the same; the tab is outlined while hovered. Refused moves (e.g. dropping on Done) show a red message under the status line, not an alert. Checked 2026-11-05 on the connected Android phone (Samsung Internet, phone-size viewport) against `scripts/fake-phone-backend.js` (now handles `move`):
- Long-press drag (`adb shell input touchscreen draganddrop 300 545 176 479 1500`) of a todo card onto *doing*: card moved, tab counts updated. Works.
- Same drag onto *done*: refused, red message "a task cannot be moved to Done from the phone (merge it instead)" under the status line, no alert. Works.
- A slow drag (4.5s) starts moving before the 0.5s hold, so it is treated as a scroll, not a drag (expected).
- NOT verified: the native *Move to…* picker. The popup does not appear in `screencap`/`uiautomator`, so I could not pick an option via adb; only that the select renders on the card. Tap it by hand to confirm.
Cards without a Move control are intentional: busy (running), waiting on an approval, or done. The server refuses those moves too (`phoneMoveError`), so the control and drag are hidden rather than offered and then rejected.
