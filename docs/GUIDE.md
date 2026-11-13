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

### Recommended tools

Below the required checks, four rows marked **Recommended** are optional. The board works without them, and each
row keeps its button until it is done.

| Row | What it adds | Install (the button runs it in a terminal) |
|---|---|---|
| frontend-design plugin | A design skill for UI and artifact tasks: a deliberate palette, type and layout | `claude plugin install frontend-design@claude-plugins-official` |
| superpowers plugin | Brainstorming and planning skills for the planner; test-first and verify-before-done skills for tasks. Turn it off in ⚙ (*superpowers plugin in sessions*) to save the tokens its skills add to every request | `claude plugin marketplace add obra/superpowers-marketplace` then `claude plugin install superpowers@superpowers-marketplace` |
| Playwright | Headless screenshots for UI tasks and reviews. JustCode starts the Playwright MCP server in those sessions by itself; screenshots land in `.justcode/tasks/<id>/shots/` | `claude plugin install playwright@claude-plugins-official`. To use it in your own Claude Code sessions as well: `claude mcp add --scope user playwright -- npx @playwright/mcp@latest` |
| DESIGN.md | A design system that UI tasks follow (colors, type, spacing, components) | **Pick a design**: choose one from awesome-design-md or use your own file. It is saved to `.justcode/design/DESIGN.md` |

If an install fails in the terminal, type the same steps inside Claude Code (`/plugin marketplace add …`,
`/plugin install …`).

**Projects.** The folders open in VS Code become projects automatically. **+** adds any other folder; it is
remembered across windows. **×** removes a project from the board, and its files are kept. The phone page only lists these known projects: add a folder in VS Code (**JustCode: Add Project**) for it to appear on the phone.

## 2. Describe the project for Claude

A label next to the project name says whether the project has a description:

| Label | Meaning | Click it to… |
|---|---|---|
| **✓ Set up** | `.justcode/project.md` exists. Hover to see whether `.justcode/design/DESIGN.md` does too. | — |
| **● Not set up** | There is no project description yet. A banner above the board says so. | start the setup |
| **◌ Setting up…** | The setup task is running. | open it and answer its questions |

Setup is optional: tasks work without it. With it, every task brief and plan chat starts with a `## Project` line
pointing at `.justcode/project.md`, so Claude learns the product, stack and commands first. Start it with **Set up
project** on the banner, the label, the ✦ Plan dialog or **⋯**. **Not now** hides the banner for that project; the
label stays.

The setup runs as a task in the project folder (the `just-code-setup` skill):

1. **Claude reads the project:** README, `CLAUDE.md`, package and build files, and enough code to know the stack, the
   commands and what is already built.
2. **It asks you 2-4 questions on the card:** what the product does and for whom, the stack and commands, what "done"
   means, and whether you have designs. Each question has a recommended answer; you can also type your own.
3. **It shows the files it will write** and waits for **Write them** or **Change something**. Nothing is written
   before you approve.
4. **It writes only inside `.justcode/`:**
   - `.justcode/project.md` (under 100 lines): the product, users, stack, exact commands, layout, conventions and the
     definition of done.
   - `.justcode/design/DESIGN.md`, only if you named a design.

It never touches `CLAUDE.md`, `.claude/`, `docs/` or your own task files. Existing files are not overwritten without asking.

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
  - **Sprint branch**: the first task of a sprint cuts a branch `jc/sprint-<name>-<id>` from the branch you are on.
    Every task in the sprint starts from it and merges into it. When the last task merges, the sprint branch merges
    into the branch you started from and is deleted. On conflicts nothing changes: merge it by hand, then use
    **Merge sprint**. Backlog tasks still merge straight into your branch.
  - **/ and @ menus**: in the task title, Details, ✦ Plan, ✦ Edit sprint and the message box, type `/` for everything
    a session can run (built-in commands, bundled skills, plugins, your project's skills) and `@` for project files and
    folders. ↑↓ choose, Enter or Tab insert, Esc closes. Personal skills and plugins list when *Your personal Claude
    setup in tasks* is on (⚙).
  - **Advanced**:
    - **Agent**: an agent from `.claude/agents`. *Default* is plain Claude.
    - **Permissions**: see section 7.
    - **Runs in**: *Direct* or *Own branch*. A **direct** task works in your checkout and is the default for tasks
      outside a sprint (deploys, syncs, small edits). A **branch** task gets its own branch and folder, and is the
      default inside a sprint. Only one direct task runs at a time.

A good task is one change that can be built, reviewed and merged on its own, with a *Done when* a reviewer can check.

### Artifact pages: a task whose result is a link

A task can produce a web page instead of a code change, such as a dashboard of the project's test results, a walkthrough
of a design, or a comparison of options. Say *artifact* in the task ("Make an artifact that compares the three
pricing layouts"), or choose **Advanced → Result → Artifact page (link)**. The card then shows **⧉ artifact**.

1. **Claude designs the page** in the project folder, with the
   [frontend-design](https://github.com/anthropics/claude-plugins-official) skill when it is installed
   (`/plugin install frontend-design@claude-plugins-official` in Claude Code). It writes one self-contained HTML file
   that follows the artifact rules: inline CSS and JavaScript, libraries only from the allowed CDNs, a dark mode, and
   phone width.
2. **JustCode publishes it.** A **⧉** terminal opens and an interactive Claude Code session publishes the file to
   claude.ai. The Agent SDK that runs the board's sessions cannot publish artifacts, so this step needs the terminal.
   The card says *Publishing the page to claude.ai…*.
3. **The link lands on the card**: **⧉ Open artifact**, and in *Details* the link with **Copy link**. A notification
   offers the same. The terminal closes by itself.
4. **To change the page**, message Claude in the task panel. When it finishes, the same link updates.

The artifact is private to you until you share it from its page on claude.ai. Publishing needs Claude Code signed in
with a Claude account (Pro, Max, Ultra, Team or Enterprise), not an API key; with an API key, the card offers to open
the page file instead. If no link comes back within five minutes, the ⧉ terminal stays open so you can see why, and
**Publish** on the card tries again.

## 4. Plan with Claude

**✦ Plan** (toolbar) turns a goal into tasks, or reworks the To do list. It is the only planning entry; while a
planning chat is open, ✦ Plan reopens it.

1. **Describe what you want**, such as "Add password reset by email, with tests". Paste screenshots or designs into
   the box; Claude looks at them first. You can paste them into the chat box later too, and into a task's message box. Tick *Also rework the To do tasks*
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

**Planning in a sprint:** with a sprint shown (or one marked active ★), ✦ Plan puts the new tasks in that sprint. It
makes other sprints only when you ask for them.


**Reworking a sprint** (✦ Edit sprint, or ticking *Also rework* while a sprint is shown) also checks the tasks already
started or done in it. A done task that must change shows as **BACK TO TO DO**: applied, it returns to To do with the
new text and is built again on top of its merged work. A working or in-review task shows as **CHANGE SENT**: its new
text is saved and sent to its Claude as a message. Tasks that are fine are left alone.

## 5. Sprints

Sprints are optional groups of tasks with a goal. They come from three places:

- **+ Sprint** in the toolbar: a name and an optional goal.
- **✦ Plan**: Claude names sprints in its proposal, and applying creates them.

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

**Direct tasks** have no branch: their changed files stay uncommitted in your checkout. They get the same checks and
AI review, then **Finish** commits just those files, or **Discard** reverts them. While a direct task holds
uncommitted files, a branch task's **Merge** is refused (Finish or Discard it first), a branch task started meanwhile
shows a one-time warning on its card, and Run all starts only one direct task at a time.

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
  lets you switch project, move cards between columns, add and run a task, approve or deny a permission, stop a task and merge a task that passed review. Nothing else
  (no settings, files or bypass mode) is allowed from the phone. A native Android app is not built yet (docs/FOLLOWUPS.md).
- **Selecting a project:** the top of the phone page shows one button per project open in VS Code; tap one to switch the
  board to it (only projects JustCode already knows; adding folders stays on the desktop).
- **Columns and moving cards:** tabs show To do, Doing, Review and Done with counts (a `!` marks a tab with a task waiting for your approval; such tasks also show on every tab). Moves only change the card's column, the same as dragging it on the desktop board; they do not start a run or a review. Each card has *Move to* buttons for the
  other columns. Blocked moves: nothing can be moved to **Done** from the phone (that merges the branch; use the Merge
  button on a task that passed review, or the desktop), a task that is running or waiting for an answer cannot be moved (stop it first), a done task cannot be moved out of Done, and a task with work on its branch cannot go back to **To do**
  (discard it on the desktop first).
- **Tablet view:** at 900px wide or more (a tablet or landscape), the four columns show side by side with a detail pane on the right instead of tabs. Tap a card to see it in the pane; drag-to-move (drop on a column heading), the project switcher and approval notifications work as on the phone. Below 900px the tabs layout is unchanged.
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
| **Prompt history** (also **🕘** in the toolbar) | Every prompt you sent: new tasks, messages to a task and planning requests, newest first, with search. **Conversation** opens that session's full transcript, **Use again** puts the prompt back in the add box. It is kept in `.justcode/prompts.jsonl` after a task is merged or deleted. A task's Details tab has **🕘 Prompts and sessions** for that task only. |
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

### When Run all seems stuck

With *Tasks at once* at 1, each task waits until the one before it is merged. The bar under the toolbar names the task
it waits for (click it to open it) and why. When only you can move that task on (it passed review but is flagged
critical, or it ran out of review rounds), clicking **Run all** asks whether to start the queue without it. It keeps
its branch and still waits for you on its card.

### claude.ai artifact links

A claude.ai artifact link opens only when signed in to claude.ai, so a task's Claude would see just its title. JustCode
saves a local copy instead, every time it is needed, not once:

- A link in a plan request or a task's text is added to 📎 Sources by itself.
- Before a planning chat starts and before a task runs, every artifact source with no copy, or a copy older than a
  day, is saved through a ⧉ terminal running `claude` (signed in with a Claude account). The card says *Saving
  claude.ai sources locally…* meanwhile. A failed refresh keeps the old copy.
- Plans and task briefs then point Claude at the copy in `.justcode/sources/`. **Refresh copy** under 📎 Sources
  picks up a newer version right away.

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
| The label says **● Not set up** after setup | Setup looks for `.justcode/project.md`. Run setup again, or write that file yourself. |
| Setup seems stuck | It is probably waiting for your answer: open it from the **◌ Setting up…** label or the yellow banner. |
| The planning chat stopped moving | Its progress bar says *Waiting for your answer* when Claude asked something. Otherwise press **Stop step** and send your message again. |
| A task keeps asking for the same command | Press **Always allow …**, or add a rule in ⚙, e.g. `Bash(docker compose:*)`. A compound command like `cd x && make` needs a rule for each part. |
| "…/.justcode/worktrees/<id>' already exists" | Press **Resume**. If the task was already merged, the card moves to Done. Otherwise the leftover folder is cleared and the task continues. |
| "Another window is running JustCode for this project" | Only one window runs a project's tasks, so two windows can't merge and test the same task at once. Use that window, or close it and try again. |
| The reviewer says it couldn't run a command | Add the command's prefix to `justCode.reviewCommands`, e.g. `make check`. |
| Tests in the task's copy miss a config file | Add the file to `justCode.worktreeCopy`. Only committed files are in the copy otherwise. |
| An artifact task shows no link | Check the ⧉ terminal: artifacts need a Claude account login, and your organization must allow them. Press **Publish** on the card to try again. |
| Too many or too few notifications | ⚙ Settings → *Notifications* (section 12). |
| Something looks stuck | Open **Output → JustCode** for a log of what happened. Then use **Stop** and **Resume** on the task. |
