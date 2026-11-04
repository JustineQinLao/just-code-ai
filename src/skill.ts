// ~/.claude/skills/just-code-ai-sync/SKILL.md: lets Claude set a project up for JustCode and sync its TASKS.md into
// the board. Written only when the user asks (Set up project in the board's Plan dialog, or JustCode: Install the
// TASKS.md Sync Skill). It changes files and the board, so Claude never starts it on its own
// (disable-model-invocation, as the Claude Code docs advise for skills with side effects).
// The exact command prefix the skill tells Claude to run. The setup task's allow rules are built from the same string,
// so each command matches its rule and runs without asking.
export const cliCommand = (cli: string) => `node "${cli}"`;

export function syncSkill(cli: string) {
  const node = cliCommand(cli);
  return `---
name: just-code-ai-sync
description: Set up this project for the JustCode board (interview, then CLAUDE.md, reviewer agent, TASKS.md) and sync TASKS.md into the board. Use for "/just-code-ai-sync", "set up JustCode", "sync tasks", or after editing TASKS.md.
disable-model-invocation: true
argument-hint: "[sync]"
---

# Set up and sync the JustCode board

Work from the project root. Never overwrite a file that exists. Run each \`node\` command exactly as written, as its
own command (no \`cd\`, \`&&\` or variables). If the argument is \`sync\`, or CLAUDE.md, an agent in \`.claude/agents\`
and TASKS.md all exist already, skip to step 4.

## 1. Learn the project (read only, be brief)

Read docs/project.md, README, CLAUDE.md, the package or build files, and only enough code to know the stack, the
test/build/lint commands, the layout and what is already built. Use Grep/Glob, not broad reads.

## 2. Interview, then propose

Ask with AskUserQuestion, in ONE call, only what the code does not answer (2-4 questions, multiple choice, your best
guess first and marked "(Recommended)"). Typical topics:
- the goal of the next stretch of work, in the user's words
- what must be true before a task counts as done (tests pass, type check, screenshots of UI, manual check)
- conventions or no-go areas Claude cannot see in the code
- whether a planner or implementer agent is wanted besides the reviewer

Then ask once more with AskUserQuestion: "Write these files?" with options "Write them (Recommended)" and
"Change something". Put the list of files and a one-line summary of each in the first option's preview. If the user
wants changes, apply them and ask again. Write nothing before the user approves.

## 3. Write the approved files

**CLAUDE.md** (root, under 100 lines): only facts needed in every session. Stack; the exact commands to install, run,
test, type check and lint; the folder layout in a few lines; conventions and no-go areas from the interview; the
definition of done. No generic advice ("write clean code"), nothing Claude can read from the code itself.

**Agents** are drafted under \`.justcode/setup/agents/\` (Claude Code asks before every write into \`.claude/\`; the
CLI installs them). Frontmatter per the Claude Code docs: \`name\`, \`description\` (what it does and when to use it,
one or two sentences), \`tools\` as a least-privilege allowlist, \`model\`. Body: a short role, numbered steps, and the
exact output format.
- \`reviewer.md\` (always): reviews a task's diff against its "Done when" list, runs the project's tests and build,
  reports only blocking issues (bugs, missed requirements, broken conventions), no style notes. For UI changes it takes
  screenshots (\`${node} screenshot <file>.png\` with an Android device, else
  \`npx playwright screenshot <url> <file>.png\`) and reads them. When asked for a JSON verdict it ends with it.
  \`tools: Read, Grep, Glob, Bash\`, \`model: sonnet\`.
- \`planner.md\` or \`implementer.md\` only if the user asked for them.
- \`.justcode/setup/skills/<name>/SKILL.md\` only for a multi-step workflow the project clearly has (release, deploy,
  migrations). Give it \`disable-model-invocation: true\` when it has side effects.

Install the drafts (existing files are kept): \`${node} setup\`

**TASKS.md** (root), in build order. Group work into sprints of 3-6 tasks, each with a one-line goal. Put what is
already built under \`## Done\` as \`- [x]\` (titles only). Every open task has these indented lines:

\`\`\`markdown
## Sprint 1: Users can sign in
- [ ] Add email login form
  Goal: a user signs in with email and password
  Files: src/auth/login.tsx, src/api/session.ts
  Done when:
  - a wrong password shows an error message
  - npm test passes

## Backlog
- [ ] Password reset by email
  Goal: ...
\`\`\`

Rules for a task: one change that can be built, reviewed and merged on its own; an imperative title under 60
characters; "Done when" has 1-4 checks a reviewer can verify (a behavior, a test, a command), never "works well".

## 4. Sync

Preview: \`${node} sync --dry-run\`. Then apply: \`${node} sync\`

\`## Sprint N: goal\` headings create that sprint on the board if it does not exist. \`- [ ]\` is todo, \`- [~]\`
doing, \`- [x]\` done. Items removed from TASKS.md are archived. Tasks made on the board are never touched.

Finish with at most 8 lines: the files you wrote, and what the sync added, moved, archived and which sprints it made.
`;
}

// The skill's instructions without frontmatter. The setup task gets them in its first message: tasks load only the
// project's Claude setup, so a skill in ~/.claude/skills is not visible to them.
export const syncSkillBody = (cli: string) => syncSkill(cli).replace(/^---[\s\S]*?---\s*/, '');
