# JustCode guide

This guide covers JustCode from the first run to running a whole sprint unattended. Each section stands on its own.

| I want to… | Go to |
|---|---|
| Get JustCode working | [1. First run](#1-first-run-the-setup-checklist) |
| Teach Claude about my project | [2. Set up the project for Claude](#2-set-up-the-project-for-claude) |
| Add one task | [3. Adding tasks](#3-adding-tasks) |
| Turn a goal into tasks | [4. Plan with Claude](#4-plan-with-claude) |
| Group tasks and track progress | [5. Sprints](#5-sprints) |
| Run everything in order | [9. Run a whole list](#9-run-a-whole-list) |

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

## 2. Set up the project for Claude

A label next to the project name says whether the project is set up for Claude:

| Label | Meaning | Click it to… |
|---|---|---|
| **✓ Set up** | The project has `CLAUDE.md`, an agent in `.claude/agents` and `TASKS.md`. Hover to see each. | — |
| **● Not set up** | One or more of them is missing. A banner above the board says which. | start the setup |
| **◌ Setting up…** | The setup task is running. | open it and answer its questions |

Setup is optional: tasks work without it. With it, tasks follow your conventions and come with a checklist the
reviewer can verify. Start it with **Set up project** on the banner, the label, the ✦ Plan dialog or **⋯**. **Not now**
hides the banner for that project; the label stays.

The setup runs as a task in the project folder:

1. **Claude reads the project:** README, `CLAUDE.md`, package and build files, and enough code to know the stack, the
   commands and what is already built.
2. **It asks you 2-4 questions on the card:** the goal of the next stretch of work, what "done" means (tests, type
   check, screenshots), conventions it cannot see in the code, and which agents you want. Each question has a
   recommended answer; you can also type your own. A yellow banner says when it is waiting for you.
3. **It shows the files it will write** and waits for **Write them** or **Change something**. Nothing is written
   before you approve.
4. **It writes:**
   - `CLAUDE.md` (under 100 lines): stack, exact commands, layout, conventions and the definition of done.
   - `.claude/agents/reviewer.md`: a read-only reviewer that checks each task's *Done when* list and runs your tests.
     A planner or implementer agent only if you asked for one.
   - `.claude/skills/…` only for multi-step workflows the project clearly has, such as a release.
   - `TASKS.md`: the work in build order, grouped into sprints (see below).
5. **It syncs `TASKS.md` into the board** and ends with a short summary of what it wrote, added and created.

Existing files are never overwritten. Files for `.claude/` are drafted under `.justcode/setup/` and installed by
JustCode, because Claude Code asks before every write into `.claude/`.

### TASKS.md

```markdown
## Sprint 1: Users can sign in
- [ ] Add email login form
  Goal: a user signs in with email and password
  Files: src/auth/login.tsx, src/api/session.ts
  Done when:
  - a wrong password shows an error message
  - npm test passes

## Backlog
- [ ] Password reset by email
```

| In TASKS.md | On the board |
|---|---|
| `## Sprint N: goal` | That sprint, created with its goal if the board has no open sprint of that name |
| `## Backlog`, or no heading | The backlog |
| `- [ ]` / `- [~]` / `- [x]` | To do / in progress / done |
| Indented lines | The task's details. Sub-bullets keep their dashes. |
| An item you delete | The task is archived |

Tasks made on the board are never touched by a sync. A task with an unmerged branch is never marked done from
`TASKS.md`: merge it on the board. To sync again after editing `TASKS.md`, run `/just-code-ai-sync sync` in Claude
Code (after **JustCode: Install the TASKS.md Sync Skill**), or `node <extension>/out/cli.js sync` in a terminal.
Add `--dry-run` to preview.

## 3. Adding tasks

Type what you want in the box at the top:

- **Enter** or **Add** adds the task to **To do**.
- **⌘/Ctrl+Enter** adds it and starts it.
- **Details ▾** opens the extra fields:
  - **Goal and details**: links and context. Paste screenshots here; Claude reads them first.
  - **Done when**: one check per line, such as "the toggle persists after a reload" or "npm test passes". Claude must
    meet each one and say how it verified it, and the AI reviewer treats an unmet item as blocking.
  - **📎 Attach files** and **Goes to**: files for this task only, and the backlog or a sprint.
  - **Based on**: the project's sources (section 13). Untick one to leave it out.
  - **Skill chips** (`/deploy`, `/test`…): skills this task can use, from the project's `.claude/skills` and
    `.claude/commands`. Your personal skills appear when *Your personal Claude setup in tasks* is on (⚙). Hover for
    the description; click to add it.
  - **Advanced**:
    - **Agent**: an agent from `.claude/agents`. *Default* is plain Claude.
    - **Permissions**: see section 7.
    - **Runs in**: *Own branch* (default, reviewed and merged) or *Project folder* (for deploys, syncs and
      releases; finish it with **✓ Done**).

A good task is one change that can be built, reviewed and merged on its own, with a *Done when* a reviewer can check.

## 4. Plan with Claude

**✦ Plan** (toolbar) turns a goal into tasks, or reworks the To do list. It is the only planning entry; while a
planning chat is open, ✦ Plan reopens it.

1. **Describe what you want**, such as "Add password reset by email, with tests". Tick *Also rework the To do tasks*
   to reword, split, merge or reorder the existing ones too. Quick instructions (chips) appear when you do.
2. **Claude reads the code**, read-only. It never changes files in a planning chat.
3. **When the goal is unclear, it asks you 2-4 questions** in the panel first. Answer, or press **Skip** to let it
   decide.
4. **It proposes tasks**, each with a goal, likely files and a *Done when* checklist, grouped into sprints with a goal
   each when there are more than about five.
5. **Refine by chatting**: "split the second one", "add a task for X", "move logging to Sprint 2".
6. **Apply.** Each proposal is tagged NEW, EDIT, keep or REMOVE, with its sprint and a checkbox. Untick what you
   don't want, then press **Apply the ticked tasks**. Sprints Claude named are created if needed. Keep chatting to
   change more.

**Progress.** The panel's bar shows where the plan stands: *Starting*, *Reading the code*, *Writing the proposal*,
*Waiting for your answer*, then *Plan ready*. Below it: the time this turn has taken, files read, tool uses and what
Claude is doing now.

The planner uses the *Planner model* and *Planner thinking* settings (⚙). The chat closes itself after 30 idle
minutes.

## 5. Sprints

Sprints are optional groups of tasks with a goal. They come from three places:

- **+ Sprint** in the toolbar: a name and an optional goal.
- **✦ Plan**: Claude names sprints in its proposal, and applying creates them.
- **TASKS.md**: each `## Sprint N: goal` heading (section 2).

**The view menu** (left of the toolbar) shows *All tasks*, the *Backlog* or one sprint. ★ marks the active sprint.

| Button | What it does |
|---|---|
| **Set active** | New tasks and fresh plans go to this sprint. |
| **✦ Edit sprint (N)** | Edits every not-started task in the sprint with one prompt (below). |
| **Close sprint** | Unfinished tasks go back to the backlog. |

**Progress bar.** Under the toolbar, the sprint on screen (or the active sprint in *All tasks*) shows its goal, *N of M
done* with a percentage, and a bar split by state: done, in review, working, needs you and to do. The legend counts
each, plus how many tasks are queued by **Run all**. Hover the bar for the same counts.

**Edit a whole sprint with one prompt.** Show the sprint, press **✦ Edit sprint**, and type one instruction for all its
not-started tasks, such as "add Done when to each and split anything too big". Ready-made instructions are offered as
chips. Claude applies it to every task, keeps them in the sprint, and shows each change for you to approve. Started
tasks are left as they are; the dialog says how many.

**Run a sprint.** Show it and press **▶ Run all** (section 9). With *Merge automatically* on, it runs unattended.

## 6. While a task runs

Click a card to open its panel on the right. With the keyboard, Tab to a card and press Enter.

- **Activity**: what Claude says and every tool it uses, live.
- **Agents**: the task's session and the subagents it starts, with time and tokens.
- **Changes**: the files changed on the branch. Click one to open a side-by-side diff.
- **Review**: the AI reviewer's verdict, its issues, the commands it ran, and any screenshots.
- **Details**: edit the title and text until the task has started; the checks; and, folded under *Files Claude wrote,
  logs and tokens*, the brief, plan, handoff, review notes, setup log and token split.

Use the message box at the bottom to talk to Claude: **Enter** sends, and **Esc** or **Stop step** interrupts the
current step.

| Button | What it does |
|---|---|
| ■ Stop | Ends the run. The work stays on the branch; **Resume** continues it. |
| 📱 Continue on phone | Moves the task to Remote Control (section 10). |
| ⌨ Open in terminal | Continues the same session in a terminal, in Claude Code's own interface. |
| Open its folder | Opens the task's copy of the project in a new window. |
| Discard work | Deletes the branch. The task goes back to To do. |

## 7. Approvals

Each task has a permission mode, under **Details ▾ → Advanced** when you add it and in the task panel later. You can
change it at any time, even while the task runs. The names are Claude Code's own.

| Mode | What runs without asking |
|---|---|
| **Auto** (default) | Everything, with Claude Code's classifier checking each action first. Risky ones ask. |
| **Edit automatically** | Reads, file edits and simple file commands (`mkdir`, `mv`, `cp`…) in the task's folder. Other commands ask. |
| **Manual** | Reads only. Every edit and command asks, unless one of your rules allows it. |
| **Plan** | Reads only. Claude writes a plan for you to approve with **Build it** or **Revise…**. |
| **Bypass permissions ⚠** | Everything, with no approvals. You confirm each time you choose it. |

When Claude asks, the card moves to **Needs you**. It offers:

- **Allow**: this one time.
- **Always allow …**: shown when Claude Code suggests a rule, such as `Bash(npm test:*)`. The rule is saved for **every
  task in this project**, including running ones. It is hidden when the rule would allow more than this request.
- **Deny…**: optionally tell Claude why, or what to do instead.

Questions from Claude show their options on the card, with a preview when Claude adds one. Pick one, or type your own
answer; **Skip** lets Claude decide.

The project's saved rules are in ⚙ Settings → *Always allowed in this project*. Rules for every project go in the box
below it.

> If Auto is not available for your account or model, Claude Code falls back to Manual. The task panel says so.
> Writes to protected paths such as `.git`, `.vscode` and `.claude` always ask, except in Bypass permissions.

## 8. Review and merge

When Claude finishes a turn:

1. Its changes are committed on the task branch, and the card moves to **Review**.
2. JustCode runs the project's checks (section 15). A failure goes back to Claude first.
3. The AI reviewer checks the work. It is read-only, uses your project's `reviewer` agent if there is one, checks every
   *Done when* item, runs the tests that cover the change, and, for UI changes, takes screenshots with an Android
   device (`adb`) or Playwright and looks at them. Docs-only changes need no AI review.
4. If it finds issues, they go back to Claude, and the new commit is reviewed again (up to 3 rounds, set in ⚙). If
   issues remain after that, the card waits under **Needs you**.
5. If the review passes, press **✓ Merge**, or turn on *Merge automatically* in ⚙. A change the reviewer flags as
   critical is never merged automatically. A task is never merged while its checks are still running.

Merging brings the latest base into the task branch first, inside the task's folder. If that conflicts, the card lists
the files; press **Resolve with Claude**, or fix them yourself and press **Mark resolved**. Your own checkout is never
left with conflict markers. With a GitHub remote and `gh` installed, **Push PR** opens a pull request instead.

If Claude only replies (asks something in text instead of changing files), the card shows its reply under **Needs
you**. Answer it in the task panel.

## 9. Run a whole list

1. Order the **To do** cards by dragging them. The number on each card is its run order.
2. Press **▶ Run all**. It runs the To do tasks in the current view: all tasks, the backlog or one sprint.

By default, JustCode runs one task at a time and starts the next only after the previous one is merged, so each task
builds on the last. The toolbar says what the queue is waiting for, and **Stop queue** ends it. The sprint progress bar
counts queued tasks. To run a sprint unattended, turn on *Merge automatically*. To run several tasks side by side,
raise *Tasks running at once* in ⚙; each runs in its own copy.

## 10. Continue on your phone (Remote Control)

**📱 Continue on phone** (in the task panel) closes the board's session for the task and resumes it in a terminal
with Claude Code Remote Control. To use it:

- Open the **Claude app** (iOS or Android) or **claude.ai/code**: the session is listed as *JustCode: <task>*.
- Press **space** in the terminal to show a QR code.
- Watch, answer and steer the task from there.
- Close the terminal to bring the task back to the board. Its changes are committed and reviewed like any finished
  turn.

Requirements: a Claude account login (Pro, Max, Team or Enterprise), not an API key. On Team and Enterprise plans, an
admin must turn Remote Control on.

## 11. Phone and Android app access (local server)

JustCode can serve the board to your phone over your own network. This is separate from *Continue on phone* above.

- **Turn it on:** it is off by default. Enable the phone server in settings (`justCode.phoneServer`). While it is on,
  the status bar and board show a short hint with the address to open or pair.
- **Same network:** the phone and the computer must be on the same Wi-Fi or LAN.
- **Keep the computer awake:** the server runs inside VS Code on your computer. If it sleeps or VS Code closes, the
  phone loses the board and tasks stop.
- **Open it on the phone:** run *JustCode: Show Phone Pairing* in VS Code. It shows an address (`http://<computer-ip>:7878/`)
  and the token. Open the address in the phone's browser and paste the token. The page lists the open project's tasks and
  lets you add and run a task, approve or deny a permission, stop a task and merge a task that passed review. Nothing else
  (no settings, files or bypass mode) is allowed from the phone. A native Android app is not built yet (docs/FOLLOWUPS.md).
- **Port:** `justCode.phoneServerPort` (default 7878).
- **Security:** the token is the only thing protecting the server. Keep it private and regenerate it if shared. Anyone
  on your network with the token can act as you. In *Bypass permissions* mode (or with `justCode.bypassAll`), tasks
  run with no approvals, so a phone with the token can start commands and change files unchecked. Leave the server
  off on untrusted networks.

| | Phone server + Android app | Continue on phone (Remote Control) |
|---|---|---|
| Goes through | your network, directly to your computer | Anthropic's Remote Control, from anywhere |
| Needs | same network, computer awake | a Claude account login, no API key |
| Shows | the JustCode board | one task's Claude session |

## 12. Notifications

JustCode shows a VS Code notification only when you can act on it, and only when the board is not already showing that
project:

- a task needs you (a question or an approval);
- a task is ready to merge, or was merged automatically;
- a review or check failed for good, a merge conflicted, or something stopped on an error.

Each notification has **Open task** (or **Show log** for errors) and **Don't show again**. The same message is not
repeated within a minute. Everything else, such as queued tasks, cleanups and approved rules, goes to **Output →
JustCode**.

⚙ Settings → *Notifications*, or `justCode.notifications`: **When a task needs me, is ready or failed** (default),
**Only errors**, or **Off**. *Don't show again* switches to *Only errors* (or *Off* on an error), with **Undo**.

## 13. More (⋯), agent map and report

**⋯** next to **▶ Run all** holds what you need now and then:

| Item | What it shows |
|---|---|
| **Agent map** | Every Claude session, subagent and reviewer at work across your projects, with status, time, tokens and current tool. Click a task to open it. |
| **Report** | The tasks in the current view: tokens (build and review), check and review rounds, first-try passes and minutes. **Copy as Markdown** pastes it into a PR or a note. |
| **Project history** | One entry per merged task. Later tasks read it instead of digging through git. |
| **Show archived tasks** | Archived tasks, in place of the lanes. |
| **Set up project with Claude** | Section 2. |

## 14. Sources and artifacts

**📎 Sources** (toolbar) holds the material tasks are based on: specs, designs, API docs, data files, folders and
links. Each source has a one-line note that Claude reads first. When you add a task:

- every source is listed in its brief by default (untick one under *Details ▾ → Based on* to leave it out);
- **📎 Attach files…** adds files that only this task needs.

Every task keeps short notes. Open them in the task panel under **Details → Files Claude wrote, logs and tokens**:

| Artifact | Written by | Read by |
|---|---|---|
| Brief | JustCode: the task, its sources, where to write the handoff | the builder |
| Plan | Claude, in *Plan* mode. Approve it on the card with **Build it**, or **Revise…** | the builder, the reviewer |
| Handoff | Claude at the end of each turn: what changed, how it verified each *Done when* item | the reviewer, fix rounds |
| Review notes | JustCode: the reviewer's last verdict | fix rounds |
| Setup log | JustCode: preparing the task's folder | you |
| Project history | JustCode on each merge | later tasks |

## 15. Checks and ready folders

**Ready folders.** Before Claude starts, JustCode prepares the task's folder: `node_modules` is linked from your project
folder when the lockfile is the same (otherwise installed), and your project's `.venv` is used. Each task gets its own
`PORT`, so parallel tasks do not collide. A problem shows in the task's *Setup log*.

**Checks.** When Claude finishes a turn, JustCode runs the project's tests and type check itself. It costs no tokens.

- The card says *Running checks…* while they run. Nothing reviews or merges the task meanwhile.
- If one fails, the end of its log goes back to Claude, which fixes it and finishes again. After 3 rounds (⚙) the card
  waits under **Needs you** with **Send to Claude**.
- A check that also fails on the base branch is not the task's fault: it is marked *fails on the base branch too:
  ignored*.
- The AI reviewer starts only when the checks pass, and does not re-run them.
- See the results under **Details → Checks**, or open the full log.

⚙ Settings → *Checks after each turn*: **Auto** (detected from your project), **Off**, or **My commands**.

## 16. Tokens and usage limits

Each card shows the **new** tokens it used: what Claude wrote plus input not already cached. Hover it for the split.
Cached tokens are the conversation re-sent at every step; they cost about a tenth of new ones. The task panel's
**Details** splits build and review.

- **Thinking:** tasks use *low*, the reviewer *medium*, the planner *low* (⚙ Settings). Raise it for a hard task.
- **Subagents:** off inside tasks. Each one re-sends its own large prompt at every step. Turn them on in ⚙ if you want
  them; they then run on Haiku.
- **Your personal setup:** off by default. Tasks load only the project's Claude setup, which saves about 7k tokens per
  step. Turn it on in ⚙ if tasks need your plugins, personal skills or MCP servers.
- **Review size:** docs-only changes get no review; small, non-sensitive changes use the lighter model.
- **Fresh session for fixes:** a fix round in a long session restarts from the artifacts instead of the whole history.

**Usage limits.** The header shows how much of your **5-hour** and **weekly** Claude limits you have used, from
Claude's own servers. At a limit, running tasks pause and queued ones wait; after the reset they continue exactly
where they stopped. **Try now** skips the wait.

## 17. Reloads, crashes, cleanup

- Closing or hiding the board never stops work. Processes run in VS Code's extension host.
- A Claude process idle for 10 minutes closes to free memory. A later message resumes it with its full history.
- Closing VS Code ends every process. Tasks that were mid-step continue when VS Code opens again.
- At startup, JustCode removes task folders that no longer belong to a task. A folder with uncommitted work is kept,
  and JustCode tells you about it.
- Merging, discarding or deleting a task removes its folder and branch. **Resume** on a task whose folder was left
  half-removed clears it and starts again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Claude Code is not installed or not found" | Run **JustCode: Check Setup** → *Install Claude Code*. If Claude is installed somewhere unusual, set `justCode.claudePath`. |
| A task stops with "authentication" errors | Run **JustCode: Check Setup** → *Sign in*. |
| "git needs your name and email" | Run **JustCode: Check Setup** → *Set name and email*. |
| The label says **● Not set up** after setup | Setup counts `CLAUDE.md`, an agent in `.claude/agents` and `TASKS.md`. Hover the label to see which is missing, then run setup again: existing files are kept. |
| Setup seems stuck | It is probably waiting for your answer: open it from the **◌ Setting up…** label or the yellow banner. |
| The planning chat stopped moving | Its progress bar says *Waiting for your answer* when Claude asked something. Otherwise press **Stop step** and send your message again. |
| A task keeps asking for the same command | Press **Always allow …**, or add a rule in ⚙, e.g. `Bash(docker compose:*)`. A compound command like `cd x && make` needs a rule for each part. |
| "…/.justcode/worktrees/<id>' already exists" | Press **Resume**: the leftover folder is cleared. (Fixed in this version: a merge no longer happens while checks run.) |
| The reviewer says it couldn't run a command | Add the command's prefix to `justCode.reviewCommands`, e.g. `make check`. |
| Tests in the task's copy miss a config file | Add the file to `justCode.worktreeCopy`. Only committed files are in the copy otherwise. |
| Too many or too few notifications | ⚙ Settings → *Notifications* (section 12). |
| Something looks stuck | Open **Output → JustCode** for a log of what happened. Then use **Stop** and **Resume** on the task. |
