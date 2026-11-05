# Phone smoke check (adb)

Device: R8YL104VK6R. Real run: set `justCode.phoneServer` to true, run *JustCode: Show Phone Pairing*, note the one-time pairing link.

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

The real extension only accepts a one-time `?pair=CODE` link (valid 10 minutes, single use), shown in the modal from *JustCode: Show Phone Pairing* or the Phone Link QR, so this part is manual:

```
npm run compile
code --extensionDevelopmentPath="$PWD" /path/to/a/git/project     # Extension Development Host
# in that window: set justCode.phoneServer = true, run "JustCode: Show Phone Pairing", copy the link's pair code
adb reverse tcp:7878 tcp:7878
adb shell am start -a android.intent.action.VIEW -d "http://localhost:7878/?pair=<CODE>" com.sec.android.app.sbrowser
```
Then repeat the steps from the scripted run, screencapping each one (`adb exec-out screencap -p > docs/smoke/live-NN.png`). Differences from the fake: the task really starts a Claude run in a branch, so the permission card depends on what the agent asks for; use a task like "run npm test" to trigger a Bash card. Clean up with `adb reverse --remove tcp:7878`.
`scripts/adb-smoke.sh` can't drive this: it launches the fake backend and hardcodes token "tok" (the fake backend still allows `?token=`; the real extension does not).

## Smoke steps: project picker, tabs, moves
After the main run, on the phone page: (1) the project buttons sit under the header and the current one is highlighted; tap another and the list reloads. (2) Tap each tab (todo, doing, review, done); counts match the cards. (3) On a todo card tap *Move to doing*: it leaves To do and shows under the Doing tab. (4) Confirm no card offers *Move to done*; a done move is blocked (use Merge). The scripted run and fake backend do not cover these yet.

## Move menu and long-press drag
Each non-done card has a *Move to…* select (todo/doing/review); picking one posts `{type:'move'}` to /api/act and reloads. Long-press (~0.5s) a card and drag onto a tab to do the same; the tab is outlined while hovered. Refused moves (e.g. dropping on Done) show a red message under the status line, not an alert. Checked 2026-11-05 on the connected Android phone (Samsung Internet, phone-size viewport) against `scripts/fake-phone-backend.js` (now handles `move`):
- Long-press drag (`adb shell input touchscreen draganddrop 300 545 176 479 1500`) of a todo card onto *doing*: card moved, tab counts updated. Works.
- Same drag onto *done*: refused, red message "a task cannot be moved to Done from the phone (merge it instead)" under the status line, no alert. Works.
- A slow drag (4.5s) starts moving before the 0.5s hold, so it is treated as a scroll, not a drag (expected).
- NOT verified: the native *Move to…* picker. The popup does not appear in `screencap`/`uiautomator`, so I could not pick an option via adb; only that the select renders on the card. Tap it by hand to confirm.
Cards without a Move control are intentional: busy (running), waiting on an approval, or done. The server refuses those moves too (`phoneMoveError`), so the control and drag are hidden rather than offered and then rejected.

## Tablet run (SM-X133, 800x1340, Samsung Internet) 2026-11-05
Screenshots in `docs/smoke/tablet/`, fake backend. `OUT=docs/smoke/tablet scripts/adb-smoke.sh` now passes end to end (fallback taps updated for this screen).

| Step | Shot | Result |
|---|---|---|
| Open page, tabs + Add row render full width | 01-open | PASS |
| Add task | 02-add-task | PASS |
| Permission card (Approve/Deny) | 03-permission | PASS |
| Approve: task leaves Doing, shows under Review | 04-merge-button, 04b-review-tab | PASS |
| Merge confirm dialog | 05-confirm | PASS |
| Merge: Done (1) | 06-done | PASS |
| Tabs todo/doing/review/done, counts | 07-tab-* | PASS |
| Long-press drag todo -> doing | 08, 09 | PASS |
| Drag onto done refused, red message, no alert | 10-drag-to-done-refused | PASS (after fix) |

Failures found:
- Script taps missed on the tablet (Approve, Merge used phone coordinates): FIXED in `scripts/adb-smoke.sh` (coordinates, plus a Review-tab step since an approved task leaves the Doing tab). Re-run passes.
- Long-press on a card/blank area started browser text selection and a Copy/Share toolbar (first attempt of step 10 showed it): FIXED with `user-select:none` on `.c,.tabs` in `src/phonepage.ts`; re-run screenshot 10 shows the refusal message with no selection.
- Layout: no overflow or small tap targets seen (buttons 44px+); no change needed. Viewport is ~600 CSS px wide, so the phone breakpoint does not apply.

UNVERIFIED: native *Move to…* picker (not visible to adb); project picker (the fake backend returns no projects); real-extension run (needs a manual pairing code); landscape orientation.

## Tablet action checklist (SM-X133, 800x1340)
Driven by hand with adb taps against the fake backend (`PORT=7899`) on 2026-11-05; screenshots in `docs/smoke/tablet/`. The `Please confirm` dialog the fake backend raises at startup was dismissed (OK) before each shot except where noted. `scripts/adb-smoke.sh` reads the screen size from `adb shell wm size` and scales its fallback taps; `PORT` overrides 7878 when another backend holds it. If a second device/emulator is attached, set `ANDROID_SERIAL`.
Shots: `01-open` (open), `02-add-task` (title typed), `03-permission` (after Add + run: permission card with Approve/Deny, question card, notification button), `04-merge-button`/`04b-review-tab` (after Approve), `05-confirm`/`05b-merge-cancel`/`06-done`, `07-tab-*` (each tab), `11`..`16` below. `08`-`10` (drag) are from the earlier run.

| Action | Result observed (shot) | Status |
|---|---|---|
| Run | Todo task *Run*: left To do, Doing count +1 (12, 13) | PASS |
| Stop | Smoke task *Stop*: left Doing, To do 1 -> 2, shows Run again (11) | PASS |
| Approve | *Approve* on Running task: ask gone, task in Review with *Move to…* + *Merge*, Review 2 (04, 04b) | PASS |
| Deny | *Deny*: ask gone, task back in To do with *Run*, not busy, Doing 2 -> 1 (15) | PASS |
| Answer | Question card shows "Answer this one in VS Code", no buttons; phone cannot answer questions (03) | PASS |
| Move select | Native popup is not in the screenshot, but tap select + `input keyevent 20` (down) + `66` (enter) picked *doing*: backend state `doing` (14) | PASS (by keyboard) |
| Long-press drag | Earlier run: drag onto Doing moved the card, onto Done refused with red message and no alert (08-10) | PASS (earlier run, not repeated) |
| Project picker | Header select lists alpha/beta/gamma (the fake backend does return them; the older "no projects" note was stale). Same keyboard method picked *beta*: header shows beta, `/api/state` current `/fake/beta` (13). The fake shares one task list across projects, so the list does not change | PASS |
| Tabs | Each tab shows its count and cards (07-*). Cards with a pending ask (Running task, question) also show on the To do tab; the Doing tab lists only doing cards | PASS |
| Add task | Typed "Smoke task", *Add + run*: Doing 2 -> 3, new card with Stop (02, 03). Empty title not tried | PASS |
| Dialog reply | Startup dialog *OK* closed it (01). Merge dialog *Cancel*: nothing moved, backend got no button (05b) | PASS |
| Merge | *Merge* then *Merge* in dialog: Review task is in Done, Done (1) (05, 06) | PASS |
| Notification button | *Enable approval notifications* opens the browser prompt "Allow notifications from this website?" Block / Allow (16). I tapped Block; the grant path (button hides, notification on a new ask) is UNVERIFIED | PARTIAL |

Observed: the question card reads "undefined: Which database should I use?" because the fake ask has no `tool`; the page should probably omit the prefix.
UNVERIFIED: empty-title add, notification grant and delivery, drag in this run, real extension, landscape.
