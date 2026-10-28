# JustCode

A small VS Code board for running Claude Code on tasks. Each task gets its own Claude session, its own git
branch and worktree, and a live terminal inside its card. When Claude finishes, the branch is your PR:
review the diff, then approve the merge yourself.

## Install

```sh
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension just-code-0.1.0.vsix
```

Or open this folder in VS Code and press F5. Needs the `claude` CLI (set `justCode.claudePath` if it isn't found).

## Use

Run **JustCode: Open Board** (or click **JustCode** in the status bar). The board belongs to the open folder and is
kept at `.justcode/board.json`. Workspace folders show up as projects automatically; **+ Project** adds any other folder
(remembered across windows, **×** removes it, files are kept). Click a project to switch; each shows its running (▶) and waiting (⚠) tasks.
Every action runs in the root of the project it was made in.

1. **Add a task**: type it and press Enter. Pick Backlog or a sprint, an agent from `.claude/agents`, and permissions:
   - *Ask me*: Claude asks before edits and commands; you approve in the card's terminal.
   - *Auto-edit*: file edits are approved automatically; commands still ask.
   - *Plan only*: read-only.

   **Runs in**: *Own branch (PR)* (default) works in an isolated copy that you review and merge. *Project root* runs in the project
   folder itself, for project-wide commands like sync, deploy or release; finish it with **✓ Done**. A task that is just a `/skill` defaults to Project root.

   Skills from `.claude/skills` and `.claude/commands` show under the box; click one to add `/skill` to the details.
2. **Sprints** (optional): **+ Sprint**, then pick it in the view menu. **Set active** makes new tasks go there.
   **Close sprint** sends unfinished tasks back to the backlog.
3. **Initialize** (automatic): the first time you open a project that isn't set up (no `.claude/agents`, or nothing for the board),
   JustCode runs `/just-code-ai-sync` in the project root with no prompts. Claude reads `docs/project.md` (else README, else the code) and creates
   a planner (Opus), implementer (Sonnet) and reviewer agent, fitting skills, `CLAUDE.md` and `TASKS.md`, then syncs the tasks into the backlog (no sprints).
   Existing files are never overwritten. **✦ Initialize** runs it again on demand.
4. **Plan with Claude**: describe a goal. Claude reads the code read-only and proposes tasks. You pick which to
   add, to the backlog, an existing sprint or a new one. A planner-like agent (planner, architect, lead) is preselected.
4. **Run**: **▶ Run** on a card, or **▶ Run all** for every To do task in the current view. Run all keeps
   `justCode.maxParallel` tasks going (default 1) and starts the next when one finishes.
   - The card's terminal is the real Claude session. Type in it, approve prompts in it.
   - A card that needs approval turns yellow with **⚠ Approve…**. The status bar shows it too, even when the board is closed.
   - **Claude Code** continues the session in the Claude Code extension; the card's run stops first so two processes never share one session.
5. **Review**: when Claude's turn ends, JustCode commits the changes on the task branch and moves the card to Review.
   **▸ Changes** lists the files; click one for a side-by-side diff. Keep talking to Claude in the terminal to change things; each turn is committed again.
6. **AI review** (automatic, after LexCode's builder → reviewer loop): when a branch task's turn ends, a read-only reviewer
   (your project's `reviewer` agent if it has one, on `justCode.reviewModel`, default Opus) checks the diff and returns a verdict.
   - Issues: the card goes back to **Doing**, the issues are sent to the task's session, Claude fixes them, and the new commit is
     reviewed again, up to `justCode.maxReviews` (3). Then the issues stay on the card: **Send to Claude to fix** or **Review again**.
   - The reviewer tests, not only reads: it runs the project's tests and build, and for UI changes with an Android device connected
     (`adb devices`) opens the app on it and captures screenshots (`cli.js screenshot`, no shell redirect), then looks at them.
     Screenshots show on the card. A review that ran no tests, or skipped a screenshot it could take, is sent back once.
     It may run git read commands, common test/build runners, `docker compose exec/run`, `./gradlew`, `adb`, `npx playwright` and `curl`,
     plus `justCode.reviewCommands`; it can never edit files.
   - Pass: **✓ review passed**. With `justCode.autoMerge` it merges and moves to **Done** by itself (not when the reviewer marks it critical).
   - Any time Claude works on a Review task again (you type, or it fixes), the card moves back to **Doing**.
7. **Merge** (your approval): **✓ Merge** first merges the latest base into the task branch, inside the task's worktree.
   - No conflicts: the branch is merged into base (`--no-ff`), the worktree and branch are removed, and the task is Done.
   - Conflicts: they stay in the task's worktree, never in your checkout. The card lists the files. Use **Resolve with Claude**, or click a file to fix it in the editor, then **Mark resolved** and **✓ Merge** again.
   - **Discard** deletes the branch and its work; the task goes back to To do.
   - With a git remote, **Push PR** pushes the branch and opens a GitHub PR with `gh`.

## Sync TASKS.md

JustCode installs a Claude skill, `/just-code-ai-sync`, in `~/.claude/skills/`, so it shows as a skill chip in every project.
Run it as a task (it runs in the project root). It previews, asks you, then applies the project's `TASKS.md` to the board:

- Tasks go to the backlog; sprints are never created, you plan them. A `## Sprint X` heading only places tasks in a sprint you already made.
- `- [ ]` todo, `- [~]` doing, `- [x]` (or ~~struck~~, ✅) done. Indented lines become the task's details.
- Items removed from TASKS.md are archived. Only tasks that came from TASKS.md are changed; tasks made on the board never are,
  and a task with an unmerged branch is not marked done.

The open board updates by itself. The same sync from a terminal: `node <extension>/out/cli.js sync [--dry-run]`.

## Terminal modal

Opens on the live Claude session. Under it, a message box (Enter to send, **Esc** to interrupt) types into the session even if the
terminal itself doesn't have keyboard focus. **✳ Open in Claude Code** continues the session there; **Log** shows the saved transcript.

## Git

- No git repo? The first run creates a local one (`git init`, no remote) and commits the current files.
  If there is no `.gitignore`, `node_modules/`, `.env`, `.env.*` and `.DS_Store` are excluded first, so secrets are not committed.
- `.justcode/` is excluded through `.git/info/exclude`; your `.gitignore` is not changed.
- Before a branch task starts, uncommitted files in the project folder are committed on your current branch
  ("chore: snapshot project files for JustCode tasks"), so the task sees the project as it is. `.env`, `node_modules/`,
  `*.vsix` and `.claude/settings.local.json` stay out unless your `.gitignore` covers them; files over 10 MB are never committed.
  A task whose worktree is behind is brought up to date, and its resumed session is told.
- Each task works in `.justcode/worktrees/<id>` on branch `jc/<title>-<id>`, cut from the branch you had checked out.
  Your own checkout is never switched. Parallel tasks never touch each other's files.
- Project agents, skills and settings that are not committed yet are passed to Claude on the command line,
  so a worktree still has them and the auto-commit never picks them up.

## Processes

- Claude runs in the extension host, not in the board. Closing or hiding the board never stops a run; reopening it replays the output.
- **■ Stop** ends a run. Closing the VS Code window ends all of its runs.
- Sessions are saved by Claude Code. After a reload, **↻ Resume** continues where the task left off; uncommitted work stays in the worktree.
- JustCode learns what a session is doing from Claude Code hooks (Stop, Notification, UserPromptSubmit, PostToolUse) added
  with `--settings` for its runs only. Your project's own hooks keep running.

## Settings

| Setting | Default | |
|---|---|---|
| `justCode.claudePath` | auto | Path to `claude` |
| `justCode.maxParallel` | 1 | Tasks Run all keeps going at once |
| `justCode.defaultMode` | `default` | Permissions for new tasks |
| `justCode.plannerModel` | `opus` | Model for Plan with Claude |
| `justCode.taskModel` | `sonnet` | Model for task runs and conflict resolving |

## Limits

- **Claude Code** button: the Claude Code extension looks for sessions of the folder it runs in. A task's session belongs
  to its worktree, so the extension may not find it. Then use **▸ Terminal** or **↻ Resume** on the card.
- macOS and Linux. Windows is untested (the status hooks use `printf`).

## Release

Push a version tag; GitHub Actions builds both packages and attaches them to the release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Install from the latest release (Linux, e.g. Devin):

```sh
curl -LO https://github.com/JustineQinLao/just-code-ai/releases/latest/download/just-code-linux-x64.vsix
code --install-extension just-code-linux-x64.vsix
```

On a Mac, use `just-code-mac.vsix` instead.
