# JustCode

VS Code extension: a task board that runs Claude Code on each task in its own git branch, with approvals, AI review and one-click merge. Also serves a token-protected phone page and an Android WebView shell (`android/`).

## Layout
- `src/extension.ts` activation and commands; `host.ts` shared host state (`st`), settings, panel; `messages.ts` board messages; `setupflow.ts`, `boardstate.ts`, `phonehost.ts`, `artifact-terminal.ts` the rest of the host.
- `runner.ts` one project's tasks (its methods live in `queue.ts`, `checkflow.ts`, `reviewflow.ts`, `merge.ts`, `planner.ts`, `sessions.ts`, `guards.ts`); `session.ts`/`sdk.ts`/`claude.ts` run agents; `store.ts` board data (`.justcode/board.json`); `git.ts` branches/worktrees; `policy.ts`, `audit.ts`, `registry.ts`, `secrets.ts`, `report.ts`; `phone.ts` phone server; `cli.ts` CLI (`screenshot`).
- `media/`: `board.js` (board, shares `window.JC`), `drawer.js` (task panel, planner), `dialogs.js`, `status.js` (card text, also used by tests). `node scripts/board-smoke.js` checks them in a headless browser.
- `src/test/*.test.ts` node:test suites. `media/` webview assets. `docs/` (guide, plans, follow-ups) is local only and not in git; README images live in `.github/readme/`.

## Commands
- `npm run compile` typecheck + bundle (`out/`)
- `npm test` typecheck and run tests
- `npm run package` build the .vsix

## Conventions
- TypeScript, strict; keep changes small and focused. Don't edit `out/`, `out-test/` or committed `.vsix` files.
- Run `npm test` before finishing; note anything you could not verify.
- Phone server is off by default and token-protected; don't weaken that.
