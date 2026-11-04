# Phone smoke check (adb)

Device: R8YL104VK6R. Real run: set `justCode.phoneServer` to true, run *JustCode: Show Phone Pairing*, note the token.
Offline run (no VS Code): serve a fake backend from the built tests, as used for the first check:

```
npm test                                   # builds out-test/phone.js
node scripts/fake-phone-backend.js "$PWD/out-test/phone.js"  # canned tasks, token "tok"
adb reverse tcp:7878 tcp:7878              # real run: skip this and use the computer's LAN address instead
adb shell am start -a android.intent.action.VIEW -d "http://localhost:7878/?token=tok" com.sec.android.app.sbrowser
adb exec-out screencap -p > /tmp/01-open.png
```
Then for each step: tap (`adb shell input tap X Y`, `adb shell input text`), wait 3s, `adb exec-out screencap -p > /tmp/NN.png`
and read it: add task -> permission card visible -> Approve -> Merge button -> Merge, OK -> task shows "done".
Clean up: `adb reverse --remove tcp:7878`.
