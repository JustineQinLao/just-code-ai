# JustCode v2 plan: zero-footprint, artifact-aware, enterprise-ready

This is an implementation plan written for a smaller model. Each task has a goal, the files to touch, numbered steps,
and a "Done when" list. Work the phases in order; inside a phase the tasks are in build order. Run `npm test` after
every task. Never edit `out/`, `out-test/` or `.vsix` files.

Terminology used below:
- **project**: the user's repository JustCode manages (NOT this extension's repo).
- **root**: the project's folder (the user's checkout).
- **worktree**: a task's own copy under `<root>/.justcode/worktrees/<id>`.
- **direct task**: a task that edits the root checkout, no worktree, no merge.
- **branch task**: today's default, own worktree + branch, reviewed, merged.

---

## 0. Honest evaluation of the current workflow

What works: the board, per-task briefs/handoffs under `.justcode/`, review loop, checks, merge via `merge-tree`, the
lease for multiple windows, atomic `board.json` writes, token-protected phone server.

What is wrong, in order of damage:

1. **Repo pollution.** "Set up project" writes `CLAUDE.md`, `TASKS.md`, `docs/project.md`, `.claude/agents/*.md`,
   `.claude/skills/plan-tasks`, `.claude/skills/design-from-artifact`, and the design skill tells Claude to save
   screenshots under `docs/screenshots/design/`. `cli.ts setup` copies `.justcode/setup/**` into `.claude/**`. The
   user's rule is: JustCode may create nothing in the project except `.justcode/`. Every one of these must move.
   The SDK already has the mechanisms to do this without files: `agents` (inline agent definitions, already used by
   `carryOver`), `plugins: [{type:'local', path}]` (a folder with `.claude-plugin/plugin.json`, `skills/`, `agents/`),
   `systemPrompt.append`, `mcpServers`, and `settings`.
2. **Worktree for everything.** A one-line fix costs: dirty-check prompt, snapshot commit, `git worktree add`,
   node_modules link or install, `.env` copy, baseline worktree for checks, commit, review, merge, cleanup. The
   existing `where: 'root'` mode skips all of that but also skips commit, checks and review, so it is a dead end
   ("Finished. Check the result, then mark it done."). There is no "edit the workspace, still review it" mode.
3. **Artifacts are not first-class.** A claude.ai artifact appears in three disconnected places: `sources.json`
   (inputs, saved via a terminal hack), `Task.artifactUrl` (outputs), and `prompts.jsonl` (links typed). There is no
   registry: no list of every artifact the project has produced or consumed, no "which tasks used this", no version
   or content hash, no way to pick an existing artifact as the basis of a new task, no refresh policy beyond
   "older than a day".
4. **Plugin and tool detection is ad hoc.** Only `frontend-design` is detected (by reading
   `installed_plugins.json`), only for artifact tasks. Playwright is referenced in prompts as `npx playwright
   screenshot` but never checked or provided. `superpowers` is unknown to JustCode. There is no DESIGN.md support.
   The setup checklist (`setup.ts`) checks only claude, login, git, identity, repo.
5. **Not enterprise-ready.** No audit trail of who approved what, no cost budgets (cost is shown, never enforced),
   no policy file (protected paths, forbidden tools, forbidden modes), no secret scan before JustCode commits
   files, phone token travels over plain HTTP (already in TASKS.md backlog), `bypassAll` is a plain setting,
   transcripts live only in `~/.claude/projects` and vanish with the worktree folder name, no exportable report of
   a sprint's cost and changes, no task dependencies for Run all.
6. **Risk in the working tree.** 1,458 uncommitted lines across 14 files (sprint branches, prompt history, sources
   library, @-menu). Commit them before anything else, or the plan below conflicts with them.
7. **Maintainability.** `runner.ts` (1,138 lines), `extension.ts` (1,007) and `media/board.js` (1,102) each hold
   several concerns. Not blocking, but every phase below adds to them; Phase 6 splits them.
8. **Two task lists.** `TASKS.md` sync and the board both hold tasks; sync archives, renames and creates sprints
   by heading text. Two sources of truth for one thing. Decision: remove sync (see Decisions).
9. **Skill text lives in TypeScript template strings** (`skill.ts`). Fine for bundling, but `setup` writes those
   strings into the repo and `--update` overwrites them. With the plugin approach they never leave `.justcode/`.

Decisions taken with the owner (2026-11-13), binding for the plan:
- Direct tasks: **Finish commits** the task's files on the current branch. No setting for "leave uncommitted".
- **TASKS.md sync is removed.** The board is the only place tasks live. Delete `src/tasksmd.ts`, the `sync` CLI
  command, the `just-code-ai-sync` skill's sync steps and the `justCode.installSyncSkill` command.
- **One developer per machine.** `board.json` stays local; audit actors are `user`, `phone`, `justcode`, `policy`,
  `review`. No multi-user identity work.
- Phone server and Android app stay in scope; hardening is the last enterprise task (5.6).

Non-negotiable rules for every task in this plan:
- JustCode writes only under `<root>/.justcode/`. Never `CLAUDE.md`, `TASKS.md`, `.claude/`, `docs/`, `.mcp.json`,
  `DESIGN.md` at the root, or `.gitignore`. `.justcode/` stays out of git through `.git/info/exclude` (already done
  by `git.exclude`).
- JustCode still **reads** a project's own `CLAUDE.md`, `.claude/agents`, `.claude/skills` if the user made them. Reading is fine; creating is not.
- Phone server stays off by default and token protected.
- Keep changes small; one task = one commit.

UX and naming rules (apply to every task; a reviewer rejects a change that breaks one):
- **One name per thing.** A concept has one setting, one function, one button label, one board field. No aliases,
  wrappers, "legacy" branches or two code paths that do the same job. When renaming, migrate the data once and
  delete the old name.
- **A button does what its label says, every time.** No action that silently skips a step (the old ✓ Done skipped
  review). If a step is skipped, the label says so ("Finish without review").
- **Defaults do the right thing without a dialog.** Settings exist for the rare case; the board never asks a
  question the default answers. Every setting description says what changes when it is flipped.
- **Same vocabulary everywhere**: board, phone page, notifications, guide, setting descriptions, audit events use
  the same words (task, sprint, branch task, direct task, source, artifact, check, review, merge, finish).
- **Grouping on the board**: toolbar = project-level things (Sources, Artifacts, Policy, Setup, Report). Card =
  this task's things. ⚙ = how JustCode behaves. Nothing appears in two places.
- **Status text tells the user the next action**, not internal state ("Review found 2 issues: Claude is fixing
  them" beats "review: fail").

---

## Phase 0: stabilize

### 0.1 Commit the pending work
Files: all currently modified.
1. `npm test`. Fix failures if any.
2. Commit the 14 modified files as one commit: "Sprint branches, prompt history, sources library, @ menu".
Done when: `git status` is clean and `npm test` passes.

### 0.2 Add a "no repo files" guard test
Files: `src/test/unit.test.ts`.
1. Add a test that imports every exported path helper from `src/artifacts.ts` and asserts each returned path starts
   with `<root>/.justcode/`.
2. Add a test that greps `src/*.ts` (read the files at test time) for the literals `'.claude', 'agents'`,
   `'.claude', 'skills'`, `'CLAUDE.md'`, `'TASKS.md'`, `'docs/'` and fails if they appear inside a `fs.writeFileSync`,
   `fs.copyFileSync` or `mkdirSync` call on the same line. Allow reads. This test will fail until Phase 1 is done;
   mark it `{ skip: true }` now and unskip it in task 1.6.
Done when: the test exists and runs (skipped).

---

## Phase 1: zero footprint (everything under `.justcode/`)

Target layout after this phase:

```
.justcode/
  board.json  sources.json  progress.md  prompts.jsonl  audit.jsonl  policy.json  artifacts.json
  project.md            what the product is, for whom, stack, commands, definition of done (replaces the CLAUDE.md draft)
                        (no TASKS.md anywhere: the board is the only task list)
  design/DESIGN.md      the chosen design system (from awesome-design-md or the user's own)
  plugin/               a local Claude Code plugin JustCode loads into every session
    .claude-plugin/plugin.json
    skills/plan-tasks/SKILL.md
    skills/design-from-artifact/SKILL.md
    skills/just-code-setup/SKILL.md
    agents/reviewer.md  agents/planner.md  agents/implementer.md
  tasks/<id>/           brief.md handoff.md review.md plan.md checks.log shots/ transcript.jsonl
  sources/<id>/         saved copies of artifact sources
  worktrees/<id>/       branch tasks only
```

### 1.1 Plugin folder writer
Files: new `src/plugin.ts`, `src/skill.ts`, `src/test/unit.test.ts`.
1. In `plugin.ts` export `pluginDir(root) = <root>/.justcode/plugin` and `writePlugin(root, cli: string)`:
   - writes `.claude-plugin/plugin.json` with `{"name":"justcode","version":"<extension version>","description":"JustCode board skills and agents"}`;
   - writes every entry of `DEFAULT_SKILLS` from `skill.ts` to `skills/<name>/SKILL.md`;
   - writes the setup skill (renamed in 1.4) to `skills/just-code-setup/SKILL.md`;
   - writes any agent drafts (see 1.3) that are missing;
   - only rewrites a file when its content differs (so a user's manual edit under `.justcode/plugin/` survives
     unless `force`);
   - returns `{ written: string[], kept: string[] }`.
2. Verify the plugin format against the Claude Code docs for local plugins (`.claude-plugin/plugin.json`,
   `skills/`, `agents/`). If the SDK rejects the folder at runtime, check `initializationResult().plugins_applied`
   (see `sdk.d.ts` near `plugins?:`) and log it.
3. Test: `writePlugin` on a temp dir creates the files; a second call reports everything as kept.
Done when: tests pass; nothing is written outside `.justcode/plugin`.

### 1.2 Load the plugin in every session
Files: `src/runner.ts`, `src/session.ts`, `src/claude.ts`.
1. In `Runner.start` (where `plugins:` is set today for artifact tasks) always include `pluginDir(this.root)` when the
   folder exists. Keep adding the installed `frontend-design` path for artifact tasks.
2. Do the same for the planner session and the review session (`runReview` in `claude.ts`, the plan chat in
   `runner.ts`): find every `query(...)` / `new Session(...)` call and pass the same `plugins` list.
3. In `carryOver` (claude.ts): stop adding `root` to `addDirs` just to expose `.claude/skills`; the plugin carries
   JustCode's skills. Keep the branch that forwards a project's own `.claude/agents` (reading is allowed).
4. Call `writePlugin` once per project when the Runner is created and again when the extension version changes
   (compare `plugin.json.version`).
Done when: a task session can run `/plan-tasks` and `/design-from-artifact` without any `.claude/` folder in the
project. Verify by hand once in a scratch project: `ls -a` shows only `.justcode/` added.

### 1.3 Agents live in the plugin, not in `.claude/agents`
Files: `src/skill.ts`, `src/plugin.ts`, `src/claude.ts`, `src/cli.ts`.
1. Move the three default agent bodies (reviewer, planner, implementer, described in `syncSkill` step 3) out of the
   prose and into `skill.ts` as exported template functions with proper frontmatter (`name`, `description`, `tools`,
   `model`). The reviewer body must say: run only the tests for the diff, headless screenshots via the Playwright
   MCP (Phase 3) into `<root>/.justcode/tasks/<id>/shots/`, end with the JSON verdict when asked.
2. `writePlugin` writes them to `.justcode/plugin/agents/`.
3. `discoverAgents(root)` reads, in order: `.justcode/plugin/agents` (scope `justcode`), `.claude/agents` (project,
   read only), `~/.claude/agents` (user). Same-name shadowing as today.
4. `cli.ts`: delete the `setup` command and the `.justcode/setup/` draft-folder concept everywhere (grep for
   `'setup'`). The extension calls `writePlugin` itself (1.2 step 4); no CLI step is needed.
Done when: opening a scratch project in the board creates only `.justcode/plugin/**` and `.justcode/board.json`.

### 1.4 Project description moves into `.justcode/`; TASKS.md sync is removed
Files: `src/skill.ts`, `src/tasksmd.ts` (delete), `src/cli.ts`, `src/extension.ts`, `package.json`, `src/artifacts.ts`,
`src/setup.ts`, `src/test/unit.test.ts`, `docs/GUIDE.md`.
1. Rename the `just-code-ai-sync` skill to `just-code-setup`. Its only job: learn the project (read only), interview
   with AskUserQuestion (product, users, stack, commands, definition of done, designs), then write
   `.justcode/project.md` (under 100 lines) and, if the user names a design, `.justcode/design/DESIGN.md`. It never
   writes `CLAUDE.md`, `TASKS.md`, agents or `docs/`, and never runs a CLI command. If a root `CLAUDE.md` exists it
   reads it and does not duplicate it. Remove steps 3, 3b and 4 (agents, setup, sync) from the text.
2. Delete `src/tasksmd.ts` and its tests; delete the `sync` command from `cli.ts` (keep only `screenshot`, see 1.3).
   Remove `Task.src?: 'TASKS.md'`.
3. Remove the `justCode.installSyncSkill` command from `package.json` and `extension.ts`; the board's "Set up
   project" button starts the `just-code-setup` skill as an init task (as today).
4. `artifacts.writeBrief`: add `## Project` with `Read <root>/.justcode/project.md first.` when it exists. Plan chats
   get the same line in their first message.
5. `setup.projectSetup` returns `{ projectMd, designMd }` instead of agents/skills/claudeMd/tasksMd; the board's
   "not set up" banner keys on `projectMd`.
6. Guide: rewrite section 2 and delete the TASKS.md subsection.
Done when: grep `TASKS.md|tasksmd|installSyncSkill` in `src/`, `media/`, `package.json` returns nothing; `npm test`
passes.

### 1.5 Screenshots and design copies stay in `.justcode/`
Files: `src/skill.ts` (designSkill), `src/claude.ts` (the `# UI checks` text near `test.shots`).
1. Replace every `docs/screenshots/design/` with `<root>/.justcode/tasks/<id>/shots/` (the brief tells Claude the
   absolute path; put it in the brief as `## Screenshots go to`).
2. Grep `src/` for `docs/` and remove any remaining write target.
Done when: grep `docs/screenshots` in `src/` returns nothing.

### 1.6 Unskip the guard test
Files: `src/test/unit.test.ts`.
1. Remove `skip: true` from task 0.2's test; fix whatever it catches.
Done when: `npm test` passes with the guard on.

---

## Phase 2: direct tasks (work in the workspace)

Decision rules:
- `where` becomes `'branch' | 'direct'`. Old boards with `'root'` are migrated once in `Store.read()` to `'direct'`
  (one line, then the string `'root'` disappears from `src/` and `media/`). No alias, no second code path.
- Default per task: **backlog task → direct; sprint task → branch**. New setting `justCode.defaultWhere` with
  `auto` (that rule), `direct`, `branch`.
- Only one direct task may run at a time, and no direct task runs while a branch task is being merged (the merge
  touches the checkout). Both are guarded in `Runner`.

### 2.1 Store and settings
Files: `src/store.ts`, `package.json`, `src/extension.ts`.
1. `Task.where?: 'branch' | 'direct'`; migrate `'root'` in `Store.read()`; add
   `startHead?: string` (HEAD when the direct task began) and
   `directFiles?: string[]` (paths it touched, filled after each turn).
2. Add `justCode.defaultWhere` to `package.json` configuration and to `settings()` in `extension.ts`.
3. In `addTask` message handling (`extension.ts` near `where: m.where === 'root'`): apply the default rule when the
   form sends no explicit value.
Done when: a backlog task created from the box has `where: 'direct'`; a sprint task has none (branch).

### 2.2 Runner: start a direct task
Files: `src/runner.ts`, `src/claude.ts` (taskPrompt).
1. In `run(id)`: if `where` is direct: refuse if another direct task is live or a merge is in progress (clear
   error on the card); record `startHead = git rev-parse HEAD`; snapshot the dirty file list to
   `.justcode/tasks/<id>/dirty-before.txt`; then `start(t, bin, this.root, { startHead }, prompt)`. No worktree, no
   snapshot commit, no node_modules work.
2. `taskPrompt`: for direct tasks say "You work directly in the user's checkout on branch X. Change only what the
   task needs. Do not commit, stash, switch branches or touch files unrelated to the task."
3. `turnEnded`: for direct tasks, compute changed files as `git status --porcelain` minus `dirty-before.txt`,
   store in `directFiles`, set status `review`, then run checks (2.3) and review (2.4). Do not call `commitAll`.
Done when: a direct task runs, finishes, and its card lists the files it touched.

### 2.3 Checks for direct tasks
Files: `src/runner.ts` (`check`), `src/checks.ts`.
1. `check(id)`: allow `cwd = this.root` when the task is direct. Baseline comparison (`_base` worktree) stays as is:
   it is cut from `startHead`.
2. Guard: if the user edited files meanwhile, the check still runs; note in `checks.log` that the tree had other
   changes.
Done when: a failing test in a direct task is reported to Claude the same way as in a branch task.

### 2.4 Review for direct tasks
Files: `src/runner.ts` (`review`, `changes`), `src/git.ts`.
1. `git.ts`: add `workingDiff(repo, files?)` = `git diff HEAD -- <files>` plus `git diff --no-index /dev/null <untracked>`
   for untracked files in the list. Add `workingChanges(repo, files)` returning `Change[]` from `git status
   --porcelain` filtered to `files`.
2. `review(id)`: for direct tasks use `workingDiff(root, directFiles)` instead of `diff base...HEAD`; `head` for the
   "already reviewed" check becomes a sha256 of that diff.
3. `changes(id)` (what the card's Changes tab shows): direct → `workingChanges`.
4. Review-fix rounds message Claude in the same root session.
Done when: a direct task's review runs, its issues appear on the card, and a fix round works.

### 2.5 Finishing a direct task
Files: `src/runner.ts`, `media/board.js`, `package.json`.
1. Finish commits exactly `directFiles` on the current branch with message `<title>`. No setting: this is the one
   behavior.
2. One primary action name for both task kinds: **Merge** for branch tasks, **Finish** for direct tasks. Delete the
   old **✓ Done** button and its `move → done` shortcut for running tasks (it skipped review: misleading). Finish
   commits (step 1), appends `progress.md`, sets `done`, `doneAt`.
3. **Discard** for a direct task: `git checkout -- <directFiles>` and delete untracked ones in the list, only after a
   confirm dialog that lists the files. Never touch files outside `directFiles`.
4. `board.js`: show tag `workspace` for direct tasks; Advanced → Runs in: `Workspace (direct, reviewed)`,
   `Own branch (reviewed, merged)`; remove the old "Project folder" wording. Show the "Runs in" default from the
   setting as the pre-selected option.
Done when: a direct task can go todo → doing → review → done with a commit on the current branch, and Discard
reverts exactly its files.

### 2.6 Guards between direct and branch tasks
Files: `src/runner.ts`.
1. `merge(id)`: if a direct task is live or in review with uncommitted `directFiles`, refuse with: "Finish or
   discard the workspace task '<title>' first; merging would change the files it is editing."
2. `run(id)` for a branch task whose base is the current branch while a direct task holds uncommitted files: allow
   (the branch task works on a copy of committed state) but warn once on the card.
3. `pump()` (Run all): respect "one direct at a time".
Done when: unit tests cover both refusals (mock `store` and `sessions`).

### 2.7 Guide
Files: `docs/GUIDE.md`.
1. Rewrite section 3 "Runs in" and section 8 for direct tasks. Explain the default rule and the two finish modes.
Done when: the guide has no mention of "Project folder" mode.

---

## Phase 3: tool and plugin readiness (frontend-design + DESIGN.md, Playwright MCP, superpowers)

### 3.1 Generic installed-plugin lookup
Files: `src/claude.ts`, `src/test/unit.test.ts`.
1. Replace `frontendDesignPlugin(file)` with `installedPlugin(name, file?)` that returns the `installPath` of
   `<name>@<any marketplace>` from `installed_plugins.json` (prefer scope `user`, then any entry whose folder exists
   and has `skills/` or `agents/` or `.claude-plugin/`). Delete `frontendDesignPlugin`; update its two callers in
   `runner.ts` to `installedPlugin('frontend-design')`. One function, no wrapper.
2. Add `installedPlugins()` returning `{ name, version, installPath }[]` for the setup checklist.
3. Tests with a fixture JSON (copy the shape from the real file: `{"version":2,"plugins":{"<id>":[{scope,installPath,version}]}}`).
Done when: tests pass for found, missing, and multiple-scope cases.

### 3.2 Setup checklist: required tools
Files: `src/setup.ts`, `src/extension.ts` (fix actions), `media/board.js`, `src/test/unit.test.ts`.
1. Extend `Check.id` with `'frontendDesign' | 'superpowers' | 'playwright' | 'designMd'`.
2. `checkSetup`:
   - `frontendDesign`: `installedPlugin('frontend-design')`. Fix action `installPlugin` with arg
     `frontend-design@claude-plugins-official`.
   - `superpowers`: `installedPlugin('superpowers')`. Fix action `installPlugin` with arg
     `superpowers@claude-plugins-official`; if that fails, the terminal shows the fallback:
     `claude plugin marketplace add obra/superpowers-marketplace` then `claude plugin install superpowers@superpowers-marketplace`.
   - `playwright`: true when `npx --no-install @playwright/mcp --version` exits 0 **or** `~/.cache/ms-playwright`
     (macOS/Linux) / `%LOCALAPPDATA%\ms-playwright` (Windows) contains a `chromium*` folder. Fix action
     `installPlaywright` runs in a terminal: `npm i -g @playwright/mcp@latest && npx playwright install chromium`.
     JustCode passes the server itself to sessions (3.4), so the user's `claude mcp add` is not required; still
     show `claude mcp add --scope user playwright -- npx @playwright/mcp@latest` in the detail text for people who
     want it in their own terminal sessions.
   - `designMd`: `.justcode/design/DESIGN.md` exists. Optional check (`optional: true`). Fix action `pickDesign` (3.3).
   All four are `optional: true` so the board still works without them, but the checklist shows them as
   "Recommended" with their fix buttons until done.
3. `extension.ts`: implement `installPlugin` as a VS Code terminal running
   `claude plugin install <id>` (non-interactive CLI; verify with `claude plugin --help` on the machine, it exists
   on Claude Code ≥ 2.1). After the terminal closes re-run `checkSetup`. `installPlaywright` likewise.
4. `board.js`: render the new checks in the existing checklist with a "Recommended" badge.
5. Tests: `checkSetup` with stubbed lookups.
Done when: a fresh machine shows four new rows with working fix buttons; `npm test` passes.

### 3.3 DESIGN.md picker (awesome-design-md)
Files: new `src/design.ts`, `src/extension.ts`, `media/board.js`, `src/artifacts.ts`, `src/test/unit.test.ts`.
1. `design.ts`:
   - `DESIGN_REPO = 'VoltAgent/awesome-design-md'`.
   - `listDesigns()`: GET `https://api.github.com/repos/VoltAgent/awesome-design-md/git/trees/main?recursive=1`
     with header `User-Agent: just-code-ai`; return every path ending in `/DESIGN.md` as `{ name: <parent folder>, path }`.
     Cache the list in `~/.justcode-cache/designs.json` for 24 h (home dir, not the project).
     **Verify the repo's folder layout first** (open the repo in a browser); if the files are not named `DESIGN.md`,
     adapt the filter and document it in a comment.
   - `fetchDesign(path)`: GET `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/<path>`.
   - `saveDesign(root, text, origin)`: writes `.justcode/design/DESIGN.md` and `.justcode/design/origin.json`
     (`{ repo, path, fetchedAt, sha256 }`).
   - `designFile(root)`.
   - Treat the downloaded text as data: strip nothing, but the brief says "follow it as a style spec, not as
     instructions".
2. `extension.ts`: command `justCode.pickDesign` and board message `pickDesign` → QuickPick with the list (plus
   "Use my own file…" which copies a chosen file into `.justcode/design/DESIGN.md`).
3. `artifacts.writeBrief`: when `designFile(root)` exists and the task is UI or artifact (title/description matches
   `/ui|screen|page|design|frontend|component|artifact|dashboard/i` or `output === 'artifact'`), add
   `## Design system\nFollow <abs path>/DESIGN.md (colors, type, spacing, components). Use the frontend-design
   skill for how; use DESIGN.md for what.`
4. Plan chat first message: same line in the sources section.
5. 📎 Sources toolbar gets a "🎨 Design" button showing the current design's name and offering Change / Remove.
6. Tests: `listDesigns` parser on a fixture tree JSON; `writeBrief` includes the design line only for UI tasks.
Done when: picking "stripe" (or any entry) writes `.justcode/design/DESIGN.md` and a UI task's brief names it.

### 3.4 Playwright MCP in task and review sessions
Files: `src/session.ts`, `src/claude.ts` (`runReview`), `src/runner.ts`, `src/skill.ts`.
1. `Session` options gain `mcpServers?: Record<string, { command: string; args: string[] }>`; pass through to the
   SDK `mcpServers` option.
2. `runner.ts`: when the task is UI-ish (same heuristic as 3.3 step 3) or `output === 'artifact'`, and the
   `playwright` check passed, add `{ playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless', '--isolated', '--output-dir', '<root>/.justcode/tasks/<id>/shots'] } }`.
   Check the exact flag names with `npx @playwright/mcp@latest --help` and adjust.
3. `runReview`: same server for UI diffs (files matching `\.(tsx|jsx|vue|svelte|html|css|scss)$`).
4. `designSkill`, the `# UI checks` text and the reviewer agent text: screenshots are taken with the Playwright MCP
   tools (`browser_navigate`, `browser_take_screenshot`) only. Remove every `npx playwright screenshot` and
   `node cli.js screenshot` instruction (one way to take a screenshot). Keep `cli.js screenshot` only for Android
   (adb), named so in its help text.
5. Allow rules: add `mcp__playwright__*` to the session's `allowedTools` when the server is passed, so screenshots
   never ask.
Done when: a UI task's agent map shows `mcp__playwright__browser_take_screenshot` calls and PNGs land in
`.justcode/tasks/<id>/shots/`.

### 3.5 superpowers in sessions
Files: `src/runner.ts`, `src/claude.ts`, `package.json`.
1. Setting `justCode.superpowers` (boolean, default true): when on and `installedPlugin('superpowers')` exists, add
   its path to `plugins` for task, planner and review sessions (lean sessions do not load user plugins otherwise).
2. Planner prompt (`PLANNER_APPEND` / `plannerFirst`): "If the superpowers plugin is loaded, use its brainstorming
   and writing-plans skills before proposing tasks." Builder prompt (`TASK_APPEND`): "If superpowers is loaded,
   follow its test-driven-development and verification-before-completion skills."
3. Token note in the setting description: superpowers adds skills to every request; off saves tokens.
Done when: with the plugin installed, `/brainstorming` appears in the task's `/` menu (`slashCommands`).

### 3.6 Guide
Files: `docs/GUIDE.md`.
1. New section "Recommended tools": the four checks, what each adds, the exact install commands.

---

## Phase 4: artifact registry (see, reuse, track every artifact)

### 4.1 Registry file and API
Files: new `src/registry.ts`, `src/artifacts.ts`, `src/test/unit.test.ts`.
1. `.justcode/artifacts.json`: array of
   `{ id, url, title?, kind: 'input' | 'output', taskIds: string[], sprintIds: string[], firstSeen, lastSeen, savedAt?, sha256?, files?: number, note? }`.
   `id` = `artifactKey(url)` hashed to 8 hex.
2. `registry.ts` exports: `load(root)`, `save(root, list)`, `upsert(root, url, patch)`, `link(root, url, taskId, sprintId?)`,
   `byTask(root, taskId)`, `forBrief(root)` (one line per artifact: title, kind, url, local copy path if any,
   tasks that used it).
3. Hook points (call `upsert`/`link`):
   - `addLinkSources` (input link typed in a prompt or task) → kind input.
   - `saveArtifactSourceNow` success → `savedAt`, `sha256` of the copied files, `files` count.
   - `publishArtifact` success → kind output, `title` from the HTML `<title>`.
   - task `run` → `link` for every artifact in its sources, files, description.
   - `deleteTask` → remove the task id from `taskIds` (keep the artifact).
4. Tests: upsert/link/byTask on a temp dir.
Done when: after one publish and one source save, `artifacts.json` has two entries with correct kinds and task
links.

### 4.2 Artifacts panel on the board
Files: `media/board.js`, `media/board.css`, `src/extension.ts`.
1. Toolbar button **⧉ Artifacts** opens a dialog listing the registry: title, kind badge, tasks that used or
   produced it (click → open task), saved copy age, buttons **Open**, **Copy link**, **Refresh copy** (inputs),
   **Use as source** (adds to `sources.json` if missing and ticks it on the new-task form), **Note…**.
2. The new-task "Based on" list shows registry artifacts with their titles instead of raw URLs.
3. The task panel's Details shows "Artifacts" (inputs used, outputs produced) from `byTask`.
4. Extension message handlers: `artifacts` (list), `artifactNote`, `useArtifact`.
Done when: every artifact ever typed, saved or published is visible in one place and can be attached to a task
in one click.

### 4.3 Artifacts in briefs and plans
Files: `src/artifacts.ts` (`writeBrief`, `sourceLines`).
1. Add `## Project artifacts` with `forBrief(root)` lines, capped at 20, newest first, only entries not already
   listed under Sources. Outputs of earlier tasks are listed as "produced by task <title>" so Claude can build on
   them (e.g. a dashboard artifact a later task should update instead of recreating).
2. For an artifact task whose brief lists an existing output artifact of the same title, instruct "update that
   artifact (same link)" and set `Task.artifactUrl` so `publishArtifact` republishes in place.
Done when: a second artifact task that mentions an existing artifact's title updates it instead of creating a new
link.

### 4.4 Staleness and refresh policy
Files: `src/extension.ts` (`stale`), `package.json`.
1. Setting `justCode.artifactRefreshHours` (default 24). `stale()` uses it.
2. The registry stores `sha256`; after a refresh, if the hash changed, mark `changed: true` and show a dot on the
   Artifacts button; tasks in `todo` whose brief lists it get a note on the card "design changed since this task
   was written".
Done when: refreshing a changed artifact flags its dependent todo tasks.

### 4.5 Transcript archive per task
Files: `src/runner.ts`, `src/claude.ts` (`transcript(cwd, id)`), `src/artifacts.ts`.
1. On `turnEnded`, copy the session transcript (`transcript(cwd, sessionId)`) to `.justcode/tasks/<id>/transcript.jsonl`
   (append-only, dedupe by line count). The worktree's `~/.claude/projects/<slug>` folder name dies with the
   worktree; the copy does not.
2. Artifact tasks: `artifactUrlIn` reads from the archived copy as a fallback.
Done when: after a merge, the task's transcript is still readable from the task panel (add a "Transcript" link).

---

## Phase 5: enterprise controls

### 5.1 Policy file
Files: `src/policy.ts` (add the file loader and `violations` to the existing module; one policy module, not two), `src/session.ts`, `src/runner.ts`,
`src/extension.ts`, `media/board.js`, `src/test/unit.test.ts`.
1. `.justcode/policy.json` (created with defaults on first run, user-editable):
   ```json
   {
     "protectedPaths": [".github/workflows/**", "infra/**", "**/*.pem", "**/.env*"],
     "denyTools": ["Bash(curl *)", "Bash(wget *)", "WebFetch"],
     "forbidModes": ["bypassPermissions"],
     "requireHumanReviewFor": ["auth", "payment", "migration", "security"],
     "maxCostUsd": { "task": 5, "sprint": 50, "project": 500 },
     "allowedModels": [],
     "requireChecksPass": true,
     "secretScan": true
   }
   ```
2. `policy.ts`: `loadPolicy(root)` with validation and defaults; `violations(policy, tool, input, cwd)` → string
   or undefined (uses `matches` from `policy.ts` for tool rules and the glob helper for paths; an Edit/Write to a
   protected path is a violation).
3. `Session.permission`: before any other decision, if `violations(...)` returns a message, deny with that message
   (Claude sees it and must work around it) and write an audit event (5.2).
4. `Runner.run`: refuse to start a task whose `mode` is in `forbidModes` (also neutralize `bypassAll` when the
   policy forbids it; show why on the card). Refuse a model not in `allowedModels` when the list is non-empty.
5. `merge` / `Finish`: when `requireChecksPass` and checks state is `fail`, refuse. When the diff touches
   `requireHumanReviewFor` (reuse `SENSITIVE` matching on the review's file list), `autoMerge` is ignored and the
   card says "Needs your approval (policy)".
6. Board: ⚙ gets a **Policy** tab that shows the file, opens it in the editor, and lists today's denials.
7. Tests: violations for protected path, denied tool, allowed call; mode refusal.
Done when: an Edit to `.github/workflows/x.yml` is denied with a message, and the denial is in the audit log.

### 5.2 Audit log
Files: new `src/audit.ts`, `src/runner.ts`, `src/extension.ts`, `src/phone.ts`, `src/test/unit.test.ts`.
1. `.justcode/audit.jsonl`, one JSON per line:
   `{ time, actor: 'user' | 'phone' | 'justcode' | 'policy' | 'review', event, taskId?, sprintId?, detail? }`.
   One developer per machine: no user identity field.
   Events: `task.create`, `task.run`, `task.stop`, `task.message`, `permission.allow`, `permission.always`
   (with rules), `permission.deny`, `mode.switch`, `review.pass`, `review.fail`, `checks.fail`, `merge`, `finish`,
   `discard`, `publish`, `policy.deny`, `budget.stop`, `phone.pair`, `phone.action`.
2. `audit.ts`: `log(root, event)` (append, never throws), `read(root, { since?, taskId? })`.
3. Call sites: every `store.updateTask` that changes status, every `permission` resolution in `session.ts`, the
   phone server's write endpoints (actor `phone`, include the token's last 4 chars), `publishArtifact`, `merge`,
   `discard`.
4. Command `JustCode: Export Audit Log` → writes `.justcode/reports/audit-<date>.csv` and opens it.
5. Tests: `log` + `read` with filters.
Done when: approving a permission on the phone produces an audit line with actor `phone`.

### 5.3 Budgets
Files: `src/runner.ts`, `src/store.ts`, `media/board.js`, `package.json`.
1. Use `policy.maxCostUsd`. In `turnEnded` after updating `costUsd`: if the task exceeds `task`, or the sprint's
   tasks' sum exceeds `sprint`, or all tasks exceed `project`: stop the session, set `t.error = 'Budget reached:
   $X of $Y (task)'`, audit `budget.stop`, notify. The user can raise the budget in `policy.json` and press Run.
2. Sprint header shows `spent / budget`; project total in the toolbar's report.
3. Review and planner costs count toward the same totals (`usage.review` already exists).
Done when: setting `task: 0.01` stops a task after its first turn with a clear card message.

### 5.4 Secret scan before JustCode commits
Files: `src/git.ts`, `src/runner.ts`, new `src/secrets.ts`, `src/test/unit.test.ts`.
1. `secrets.ts`: `findSecrets(diffText)` → `{ file, line, kind }[]` using patterns for AWS keys (`AKIA[0-9A-Z]{16}`),
   private key blocks (`-----BEGIN [A-Z ]*PRIVATE KEY-----`), GitHub tokens (`gh[pousr]_[A-Za-z0-9]{36,}`), Slack
   (`xox[baprs]-`), generic `(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}` (case-insensitive), JWTs
   (`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`). Ignore lines in `.justcode/`, lockfiles and test fixtures
   named `*.fixture.*`.
2. `commitAll` and the direct-task Finish: when `policy.secretScan`, run `findSecrets` on `git diff --cached` first;
   on hits, unstage, set `t.error` listing file:line, audit, and do not commit. Claude gets a message in the next
   turn naming the lines.
3. Tests: each pattern positive and one negative.
Done when: a task that writes `AKIAABCDEFGHIJKLMNOP` into a file is blocked from committing with the file:line shown.

### 5.5 Task dependencies for Run all
Files: `src/store.ts`, `src/runner.ts` (`pump`), `media/board.js`.
1. `Task.dependsOn?: string[]`. `pump` starts a task only when all its dependencies are `done`.
2. Board: Details → "After:" multi-select of other open tasks; card shows `⟂ waits for <title>`.
3. Planner output: allow `after: [<title>]` in the `tasks` JSON block.
Done when: Run all with A ← B order never starts B before A is done.

### 5.6 Phone transport hardening (from TASKS.md backlog)
Files: `src/phone.ts`, `src/phonepage.ts`, `src/extension.ts`, `android/`.
1. Pairing code: `justCode.phoneLink` shows a 6-digit code valid 10 minutes; the phone exchanges it for the long
   token once (`POST /pair`), then uses the token. Tokens expire after `justCode.phoneTokenDays` (default 7) and
   are listed/revocable under ⚙ → Phone.
2. Optional self-signed TLS: setting `justCode.phoneTls` (default off). Generate a cert into
   `~/.justcode-cache/phone-cert/` (not the project), serve HTTPS, and show the fingerprint on the pairing screen
   for the Android app to pin.
3. Audit every write endpoint (5.2).
Done when: a token older than the expiry is rejected with 401, and pairing works end to end on the device per
`docs/adb-smoke.md`.

### 5.7 Sprint report export
Files: `src/extension.ts`, new `src/report.ts`.
1. Command `JustCode: Export Sprint Report` → `.justcode/reports/sprint-<name>-<date>.md`: goal, tasks with
   status, merge commits, files changed count, review rounds, cost per task and total, audit highlights (denials,
   budget stops), artifacts produced (links from the registry).
2. Button on the sprint header.
Done when: the file renders in the Markdown preview with all sections filled from a real sprint.

### 5.8 Extend the setup checklist (no separate Doctor)
Files: `src/extension.ts`, `src/setup.ts`.
1. Rename command `justCode.setup` title to `JustCode: Check Setup and Health`. The same checklist also validates `board.json`, `policy.json`, `artifacts.json` (schema and
   referential integrity: every `taskId` exists), lists orphan worktrees, stale sources, sessions without
   transcripts. Each problem is a checklist row with one fix button, like the existing rows. No second command,
   no output-channel report.
Done when: a corrupted `artifacts.json` shows as a failed row with a "Reset registry" fix.

---

## Phase 6: maintainability (do after the features; pure moves, no behavior change)

### 6.1 Split `extension.ts`
Move webview message handling into `src/messages.ts` (one `handle(msg, ctx)` with a switch), artifact publishing
and source saving into `src/artifact-terminal.ts`. `extension.ts` keeps activation, settings and wiring.
Done when: `extension.ts` < 400 lines and `npm test` passes.

### 6.2 Split `runner.ts`
Move merge/sprint-merge/conflict code into `src/merge.ts` and checks orchestration into `src/checkflow.ts`.
Done when: `runner.ts` < 600 lines.

### 6.3 Split `media/board.js`
Move dialogs (Sources, Artifacts, Policy, Setup) into `media/dialogs.js`, loaded by the webview HTML (update the
CSP nonce list in `extension.ts`).
Done when: no single media file is over 600 lines.

### 6.4 Runner integration test with a fake SDK
Files: `src/test/runner.test.ts`.
Provide a fake `sdk()` that yields scripted messages, a temp git repo, and assert the state machine for one branch
task (todo → doing → review → done) and one direct task. This is the test every later change needs.

---

## Order of work and what to verify by hand

1. Phase 0 (half a day). 2. Phase 1 (the footprint rule; two days). 3. Phase 2 (direct tasks; two days).
4. Phase 3 (tools; two days). 5. Phase 4 (registry; two days). 6. Phase 5 (enterprise; one week).
7. Phase 6 as time allows.

Manual verification after Phases 1 to 3, in a throwaway project:
- `git status --ignored` shows only `.justcode/` as new; no `.claude/`, `CLAUDE.md`, `TASKS.md`, `docs/`.
- A backlog task runs as a direct task, is reviewed, and finishes with one commit on the current branch.
- A sprint task runs in a worktree as before.
- The setup checklist shows the four recommended rows; each fix button works.
- A UI task takes a Playwright MCP screenshot into `.justcode/tasks/<id>/shots/`.
- An artifact task publishes, and the Artifacts panel lists it with its task.

## Things the implementer must check rather than assume

- The local plugin folder format (`.claude-plugin/plugin.json`) and whether `plugins` in the SDK also registers the
  plugin's `agents/`. If agents are not picked up, pass them through the existing `agents` option instead.
- `@playwright/mcp` flag names (`--headless`, `--isolated`, `--output-dir`): run `npx @playwright/mcp@latest --help`.
- `claude plugin install` non-interactive behavior and whether `claude-plugins-official` needs
  `claude plugin marketplace add anthropics/claude-plugins-official` first on a fresh machine.
- The folder layout of `VoltAgent/awesome-design-md` (file names, default branch) before writing `listDesigns`.
- The frontend-design plugin's current skill name, to reference it correctly in the brief.

Sources consulted for Phase 3: [awesome-design-md](https://github.com/voltagent/awesome-design-md),
[Claude Code plugin CLI reference](https://code.claude.com/docs/en/plugins/cli-reference),
[Claude Code plugin install docs](https://code.claude.com/docs/en/plugins/install),
[superpowers install (Claude Code)](https://www.mintlify.com/obra/superpowers/installation/claude-code),
[superpowers marketplace](https://github.com/obra/superpowers-marketplace),
[Playwright MCP install](https://www.mintlify.com/microsoft/playwright-mcp/installation).
