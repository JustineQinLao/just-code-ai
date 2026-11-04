# Follow-ups from the adb phone check (device R8YL104VK6R)

1. **Phone server not implemented.** `justCode.phoneServer` (named in README and GUIDE section 11) is not in `package.json` or `src`. The task's `justCode.mobile` setting does not exist either. Implement it or remove the docs.
2. **No `android/` app.** GUIDE section 11 says to build it with `./gradlew assembleDebug`; the folder is not in the repo and no JustCode app is installed on the phone.
3. **E2E not run.** Once 1 and 2 exist, run `scripts/adb-smoke.sh` (needs `PKG=<app id>` or `aapt`) and read each screenshot: pair, create task, run, approve permission, merge.
4. No test/build covers the phone flow; add one with the server.
