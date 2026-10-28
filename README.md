# JustCode

A task board for VS Code that runs Claude Code on each task. Every task gets its own branch and its own copy of the
project. Claude asks for approval right on the card, and an AI reviewer tests the work before you merge it.

- **Works on any folder:** an existing project or an empty one. Nothing to configure first.
- **Few interruptions:** the default *Auto* mode lets Claude approve what is safe. Anything else waits on the card,
  with **Allow / Always allow / Deny** buttons. "Always" is remembered for the whole project.
- **Hands-off lists:** **Run all** works through a list in order. Each task is built, reviewed, fixed and (optionally)
  merged before the next one starts.
- **Agent map:** every Claude session, subagent and reviewer at work, with elapsed time and tokens.
- **Continue on your phone:** move any task to Claude Code Remote Control and steer it from the Claude app or
  claude.ai/code.

## Install

You need VS Code 1.90+, [git](https://git-scm.com), and [Claude Code](https://code.claude.com) signed in with your
Claude account. The board's setup checklist can install and sign in Claude Code for you.

From a release (on a Mac, use `just-code-mac.vsix` instead):

```sh
curl -LO https://github.com/JustineQinLao/just-code-ai/releases/latest/download/just-code-linux-x64.vsix
code --install-extension just-code-linux-x64.vsix
```

From source:

```sh
npm install
npm run package          # type-checks, bundles to out/, writes just-code-1.0.0.vsix
code --install-extension just-code-1.0.0.vsix
```

You can also open this folder in VS Code and press F5 (run `npm run compile` first).

## Quick start

1. Run **JustCode: Open Board**, or click **JustCode** in the status bar.
2. Work through the **setup checklist** at the top until every line has a ✓. Each line that fails has a button that
   fixes it.
3. Type a task, for example *"Add a dark mode toggle to the settings page"*, and press **⌘/Ctrl+Enter** to add it and
   run it.
4. Watch the card:
   - **Working**: Claude is building in the task's own branch.
   - **Needs you**: Claude asked a question or wants approval. Answer it on the card.
   - **Review**: the AI reviewer ran the tests and checked the diff. Issues go back to Claude by themselves.
   - Press **✓ Merge** when it passes.

The full walkthrough is in [docs/GUIDE.md](docs/GUIDE.md), or press **?** on the board.

## How it works

| | |
|---|---|
| **Sessions** | Each task runs through the Claude Agent SDK, using the `claude` CLI you installed and its login. Approvals and questions arrive as structured data and are answered by the buttons on the card. No terminal is scraped. |
| **Isolation** | Each task works in `.justcode/worktrees/<id>` on branch `jc/<title>-<id>`. Your checkout is never switched, and parallel tasks never share files. |
| **Permissions** | *Auto* (default, Claude's classifier), *Auto-edit*, *Ask me*, *Plan only*, *Allow everything ⚠*. You can change the mode per task, even while it runs. "Always allow" rules are stored in `.justcode/board.json` and given to every task in the project. Rules for every project go under ⚙ Settings. |
| **Review** | After each finished turn, a read-only reviewer runs your tests and build, then returns a verdict. It uses your project's `reviewer` agent if there is one, and can take Android/Playwright screenshots of UI changes. If it fails, the issues go back to Claude, up to 3 rounds. If it passes, you merge, or JustCode merges automatically when that is turned on. |
| **Merge** | The latest base is merged into the task branch first, inside the task's folder, so conflicts never touch your checkout. **Resolve with Claude** fixes them. The branch is then merged with `--no-ff`, and the task folder and branch are removed. |
| **Remote** | **📱 Continue on phone** closes the board's session and resumes it as `claude --resume <id> --remote-control` in a terminal. The task then shows in the Claude app and on claude.ai/code. Close the terminal to bring it back to the board, where it is committed and reviewed. This needs a Claude account login, not an API key. |
| **Limits** | The header shows your 5-hour and weekly plan usage, read from Claude's own rate-limit events. At the limit, tasks pause and continue after the reset. |
| **Lifecycle** | Closing the board never stops work. An idle Claude process closes after 10 minutes and resumes with its full history when needed. Closing VS Code ends every process; tasks that were mid-step continue when the window opens again. Task folders without a task are cleaned up at startup. |

## Safety

- JustCode asks before it creates a git repository, and before it commits uncommitted files ("Commit and run" or "Run
  without them").
- These are kept out of git through `.git/info/exclude` (your `.gitignore` is not changed):
  - `.env*`, keys and certificates (`*.pem`, `*.key`, `id_rsa*`, …)
  - `credentials*.json`, `.npmrc`, `*.tfstate`
  - `node_modules/`, `.venv/`
  - the files listed in `justCode.worktreeCopy`
- `.env` and `.env.local` are copied into each task's folder so tests can run. They are never committed.
- Settings files are passed to Claude as file paths, never on the command line.
- An `ANTHROPIC_API_KEY` in your environment is not passed to Claude. Tasks use your Claude login unless you set a key
  with **JustCode: Use an Anthropic API Key**; the key is kept in VS Code's secret storage.
- *Allow everything* asks you to confirm each time you choose it.

## Settings

The everyday settings are on the board (⚙). All of them are also in VS Code Settings under *JustCode*.

| Setting | Default | |
|---|---|---|
| `justCode.defaultMode` | `auto` | Permissions for new tasks |
| `justCode.maxParallel` | 1 | Tasks **Run all** keeps in progress at once |
| `justCode.taskModel` / `reviewModel` / `plannerModel` | `sonnet` / `opus` / `opus` | Models |
| `justCode.autoReview` | true | AI review after each finished task |
| `justCode.autoMerge` | false | Merge automatically when the review passes (never when it is flagged critical) |
| `justCode.maxReviews` | 3 | Review rounds before it waits for you |
| `justCode.reviewTimeoutMinutes` | 20 | A review running longer than this is stopped |
| `justCode.reviewCommands` | [] | Extra commands the reviewer may run |
| `justCode.allowedTools` | [] | Rules allowed in every project, e.g. `Bash(npm run:*)` |
| `justCode.worktreeCopy` | `.env`, `.env.local` | Gitignored files copied into each task's folder |
| `justCode.idleMinutes` | 10 | Idle Claude processes close after this long |
| `justCode.claudePath` | auto | Path to `claude`, if it is not found automatically |

## TASKS.md sync (optional)

**JustCode: Install the TASKS.md Sync Skill** adds `/just-code-ai-sync` to `~/.claude/skills`. **✦ Initialize**
runs the skill as a task and adds it first if needed. The skill:

- drafts agents, skills, `CLAUDE.md` and `TASKS.md` where the project has none;
- syncs `TASKS.md` into the board: `- [ ]` todo, `- [~]` doing, `- [x]` done, with indented lines as details.

Items removed from `TASKS.md` are archived. Tasks made on the board are never touched.

You can also run the sync from a terminal: `node <extension>/out/cli.js sync [--dry-run]`.

## Development

```sh
npm install
npm run compile    # tsc --noEmit, then esbuild bundles out/extension.js and out/cli.js (SDK included)
npm test           # node:test unit tests (policy, verdicts, limits, store, git, session)
npm run package    # VSIX
```

| File | Role |
|---|---|
| `src/session.ts` | One task's Claude session through the Agent SDK: messages, approvals, agent map |
| `src/runner.ts` | Per project: worktrees, queue, turn ends, review, merge, cleanup |
| `src/extension.ts` | VS Code wiring: board webview, setup fixes, Remote Control hand-off, status bar |
| `src/policy.ts` | Permission rules ("Always allow") |
| `media/board.js`, `media/board.css` | The board UI |

## Release

Push a version tag. GitHub Actions builds the VSIX and attaches it to the release.

```sh
git tag v1.0.0 && git push origin v1.0.0
```

## Limits

- Windows: the code avoids POSIX-only tools, but it has not been tested there yet.
- Remote Control needs a Pro, Max, Team or Enterprise login. On Team and Enterprise, an admin must turn it on.
- Using a Claude plan login through the Agent SDK is meant for your own use. Anthropic's terms do not allow offering
  claude.ai login inside products you distribute to others without their approval. For that, use an API key.
