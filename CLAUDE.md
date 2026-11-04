# JustCode

VS Code extension: a task board that runs Claude Code on each task in its own git branch, with approvals, AI review and one-click merge. Also serves a token-protected phone page and an Android WebView shell (`android/`).

## Layout
- `src/extension.ts` entry; `runner.ts`/`session.ts`/`sdk.ts`/`claude.ts` run agents; `store.ts` board data (`.justcode/board.json`); `git.ts` branches/worktrees; `phone.ts` phone server; `tasksmd.ts` TASKS.md → board; `cli.ts` CLI (`sync`, `setup`).
- `src/test/*.test.ts` node:test suites. `media/` webview assets. `docs/` guide and follow-ups.

## Commands
- `npm run compile` typecheck + bundle (`out/`)
- `npm test` typecheck and run tests
- `npm run package` build the .vsix

## Conventions
- TypeScript, strict; keep changes small and focused. Don't edit `out/`, `out-test/` or committed `.vsix` files.
- Run `npm test` before finishing; note anything you could not verify.
- Phone server is off by default and token-protected; don't weaken that.
