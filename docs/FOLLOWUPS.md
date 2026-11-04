# Follow-ups from the adb phone check (device R8YL104VK6R)

Done: `justCode.phoneServer` (src/phone.ts, wired in src/extension.ts) serves a token-protected phone page.

1. **No native Android app.** Only the browser page exists. Add `android/` (and its build) if an app is wanted.
2. **Not yet run against the live extension.** The phone flow was checked on the device against a fake backend (see
   docs/adb-smoke.md), because VS Code and a real Claude run can't be driven from the build sandbox. Re-run with the real extension.
3. Token is sent over plain HTTP on the LAN; consider HTTPS or a pairing code with expiry.
