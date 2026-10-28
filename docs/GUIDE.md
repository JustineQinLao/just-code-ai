# JustCode guide

This guide covers using JustCode from your first run to running a whole list of tasks unattended. Each section
stands on its own.

## 1. First run: the setup checklist

Open the board with **JustCode: Open Board**, or click **JustCode** in the status bar. A checklist at the top shows
what tasks need:

| Check | If it fails, the button… |
|---|---|
| Claude Code installed | **Install Claude Code**: runs the official installer in a terminal |
| Signed in | **Sign in**: runs `claude auth login` |
| git installed | **Get git**: opens git-scm.com |
| git name and email | **Set name and email**: asks for both and saves them to your global git config |
| Project is a git repository | **Create it now** (optional): JustCode also asks on the first run |

After a fix, close its terminal or press **Check again**. You can reopen the checklist at any time with
**JustCode: Check Setup**, or from ⚙ → *Setup checklist*.

**Projects.** The folders open in VS Code become projects automatically. **+** adds any other folder; it is
remembered across windows. **×** removes a project from the board, and its files are kept.

## 2. Adding tasks

Type what you want in the box at the top:

- **Enter** adds the task to **To do**.
- **⌘/Ctrl+Enter** adds it and starts it.
- **More ▾** opens the extra fields:
  - **Details**: acceptance criteria, links. Paste screenshots here; Claude reads them first.
  - **Agent**: an agent from `.claude/agents` (yours or the project's). *Default* is plain Claude.
  - **Permissions**: see section 4.
  - **Runs in**:
    - *Own branch* (default): the task works in an isolated copy. You review and merge the result.
    - *Project folder*: the task runs in the project itself. Use it for deploys, syncs and releases; finish it with
      **✓ Done**.
  - **Goes to**: the backlog, or a sprint.
- **Skill chips** (`/deploy`, `/test`…) come from `.claude/skills` and `.claude/commands`. Click one to add it to the
  task.

**Plan with Claude.** Describe a goal. Claude reads the code without changing anything and proposes small tasks in
build order. You pick which to add.

## 3. While a task runs

Click a card to open its panel on the right:

- **Activity**: what Claude says and every tool it uses, live.
- **Agents**: the task's session and the subagents it starts, with time and tokens.
- **Changes**: the files changed on the branch. Click one to open a side-by-side diff.
- **Review**: the AI reviewer's verdict, its issues, the commands it ran, and any screenshots.
- **Details**: edit the title and text, until the task has started.

Use the message box at the bottom to talk to Claude: **Enter** sends, and **Esc** or **Stop step** interrupts the
current step.

Buttons in the panel:

| Button | What it does |
|---|---|
| ■ Stop | Ends the run. The work stays on the branch; **Resume** continues it. |
| 📱 Continue on phone | Moves the task to Remote Control (section 7). |
| ⌨ Open in terminal | Continues the same session in a terminal, in Claude Code's own interface. |
| Open its folder | Opens the task's copy of the project in a new window. |
| Discard work | Deletes the branch. The task goes back to To do. |

## 4. Approvals

Each task has a permission mode. You can change it in the task panel at any time, even while it runs.

| Mode | What Claude may do without asking |
|---|---|
| **Auto** (default) | Whatever Claude's safety classifier judges safe. It asks only when unsure. |
| **Auto-edit** | Edit files. Commands outside your rules ask. |
| **Ask me** | Nothing outside your rules. |
| **Plan only** | Read only, and it changes nothing. |
| **Allow everything ⚠** | Anything: no approvals at all. You confirm each time you choose it. |

When Claude asks, the card moves to **Needs you** and the status bar shows a bell. The card offers three answers:

- **Allow**: this one time.
- **Always allow …**: shown when Claude Code suggests a rule, such as `Bash(npm test:*)`. The rule is saved for
  **every task in this project**, including tasks already running. For file writes, the choice is *Allow all edits in
  this task*.
- **Deny…**: optionally tell Claude why, or what to do instead.

Questions from Claude (for example, "Which database?") show their options on the card. Pick one, or type your own
answer.

You can see and edit the project's saved rules in ⚙ Settings → *Always allowed in this project*. Rules for every
project go in the box below it.

> If Auto is not available for your account or model, Claude falls back to asking. The task panel says so.

## 5. Review and merge

When Claude finishes a turn:

1. Its changes are committed on the task branch, and the card moves to **Review**.
2. The AI reviewer checks the work. It is read-only and uses your project's `reviewer` agent if there is one. It:
   - runs your tests, type check and build;
   - for UI changes, takes screenshots with an Android device (`adb`) or Playwright, and looks at them.
3. If it finds issues, they go back to Claude, which fixes them, and the new commit is reviewed again (up to 3 rounds,
   set in ⚙). If issues remain after that, the card waits under **Needs you**.
4. If the review passes, press **✓ Merge**, or turn on *Merge automatically* in ⚙. A change the reviewer flags as
   critical is never merged automatically.

Merging brings the latest base into the task branch first, inside the task's folder. If that conflicts, the card
lists the files; press **Resolve with Claude**, or fix them yourself and press **Mark resolved**. Your own checkout is
never left with conflict markers.

With a GitHub remote and `gh` installed, **Push PR** opens a pull request instead.

If Claude only replies (asks something in text instead of changing files), the card shows its reply under
**Needs you**. Answer it in the task panel.

## 6. Run a whole list

1. Order the **To do** cards by dragging them. The number on each card is its run order.
2. Press **▶ Run all**.

By default, JustCode runs one task at a time and starts the next only after the previous one is merged, so each task
builds on the last. The toolbar says what the queue is waiting for. To run a sprint unattended, turn on *Merge
automatically*. To run several tasks side by side, raise *Tasks at once* in ⚙; each runs in its own copy.

Sprints are optional. **+ Sprint** creates one, the view menu switches to it, **Set active** makes new tasks go there,
and **Close sprint** sends unfinished tasks back to the backlog.

## 7. Continue on your phone (Remote Control)

**📱 Continue on phone** (in the task panel) closes the board's session for the task and resumes it in a terminal
with Claude Code Remote Control. To use it:

- Open the **Claude app** (iOS or Android) or **claude.ai/code**: the session is listed as *JustCode: <task>*.
- Press **space** in the terminal to show a QR code.
- Watch, answer and steer the task from there.
- Close the terminal to bring the task back to the board. Its changes are committed and reviewed like any finished
  turn.

Requirements: a Claude account login (Pro, Max, Team or Enterprise), not an API key. On Team and Enterprise plans, an
admin must turn Remote Control on.

## 8. Agent map

**Agent map** (top right) shows everything at work, grouped by project and then by task:

- each task's own session;
- every subagent it started;
- the AI reviewer, when it runs.

Each entry shows its status, elapsed time, tokens and current tool. Click a task to open it.

## 9. Usage limits

The header shows how much of your **5-hour** and **weekly** Claude limits you have used. These numbers come from
Claude's own servers. When a limit is reached:

- running tasks pause, and queued ones wait;
- after the reset, they continue exactly where they stopped;
- **Try now** skips the wait.

## 10. Sources and artifacts

**📎 Sources** (toolbar) holds the material tasks are based on: specs, designs, API docs, data files, folders and
links. Each source has a one-line note that Claude reads first. When you add a task:

- every source is listed in its brief by default (untick one under *More ▾ → Based on* to leave it out);
- **📎 Attach files…** adds files that only this task needs.

Every task keeps short notes. Open them under **Details → Artifacts**:

| Artifact | Written by | Read by |
|---|---|---|
| Brief | JustCode: the task, its sources, where to write the handoff | the builder |
| Plan | Claude, in *Plan only* mode. Approve it on the card with **Build it**, or **Revise…** | the builder, the reviewer |
| Handoff | Claude at the end of each turn: what changed, the commands it ran and their results | the reviewer, fix rounds |
| Review notes | JustCode: the reviewer's last verdict | fix rounds |
| Project history | JustCode on each merge | later tasks |

## 11. Tokens

Every card shows the tokens it used. **Details** splits them into build and review, and into tokens written, new
input and cached. Cached tokens are context re-sent at each step: they are cheap, but they add up.

- **Your personal setup:** off by default. Tasks load only the project's Claude setup, which saves about 7k tokens per
  step. Turn it on in ⚙ if tasks need your plugins or MCP servers.
- **Review size:** reviews fit the change. Docs-only changes get no review; small, non-sensitive changes use the
  lighter model.
- **Fresh session for fixes:** a fix round in a long session restarts from the artifacts instead of the whole history.

## 12. Reloads, crashes, cleanup

- Closing or hiding the board never stops work. Processes run in VS Code's extension host.
- A Claude process idle for 10 minutes closes to free memory. A later message resumes it with its full history.
- Closing VS Code ends every process. Tasks that were mid-step continue when VS Code opens again.
- At startup, JustCode removes task folders that no longer belong to a task. A folder with uncommitted work is kept,
  and JustCode tells you about it.
- Merging, discarding or deleting a task removes its folder and branch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Claude Code is not installed or not found" | Run **JustCode: Check Setup** → *Install Claude Code*. If Claude is installed somewhere unusual, set `justCode.claudePath`. |
| A task stops with "authentication" errors | Run **JustCode: Check Setup** → *Sign in*. |
| "git needs your name and email" | Run **JustCode: Check Setup** → *Set name and email*. |
| A task keeps asking for the same command | Press **Always allow …**, or add a rule in ⚙, e.g. `Bash(docker compose:*)`. A compound command like `cd x && make` needs a rule for each part. |
| The reviewer says it couldn't run a command | Add the command's prefix to `justCode.reviewCommands`, e.g. `make check`. |
| Tests in the task's copy miss a config file | Add the file to `justCode.worktreeCopy`. Only committed files are in the copy otherwise. |
| Something looks stuck | Open **Output → JustCode** for a log of what happened. Then use **Stop** and **Resume** on the task. |
