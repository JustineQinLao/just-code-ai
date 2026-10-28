// ~/.claude/skills/just-code-ai-sync/SKILL.md: lets Claude set a project up for JustCode and sync its TASKS.md into
// the board. Written only when the user asks (Initialize on the board, or JustCode: Install the TASKS.md Sync Skill).
export function syncSkill(cli: string) {
  const node = `node "${cli}"`;
  return `---
name: just-code-ai-sync
description: Set up a project for the JustCode board and sync its TASKS.md into the board. Drafts Claude agents, skills, CLAUDE.md and TASKS.md where missing, then syncs TASKS.md into the board backlog. Use when the user says "sync tasks", "initialize JustCode", "/just-code-ai-sync", or after editing TASKS.md.
---

# Set up and sync the JustCode board

The board is this project's \`.justcode/board.json\`. Work from the project root. Never overwrite a file that already
exists. Run each \`node\` command below exactly as written, as its own command (no \`cd\`, \`&&\` or variables).

## 1. Claude setup, only if \`.claude/agents\` has no .md files

Learn the project first: docs/project.md if it exists, else README, CLAUDE.md, package files and enough code to know the
stack, commands and conventions. Then write these drafts with the Write tool, tailored to this project. They go under
\`.justcode/setup/\` (Claude Code asks before every write into \`.claude/\`); the CLI installs them:
- \`.justcode/setup/agents/planner.md\`: splits a goal into small tasks that can each be built, reviewed and merged on their own. Frontmatter \`model: opus\`.
- \`.justcode/setup/agents/implementer.md\`: builds one task following the project's conventions and runs its tests or build. Frontmatter \`model: sonnet\`.
- \`.justcode/setup/agents/reviewer.md\`: reviews a diff for bugs, missed edge cases and convention breaks, runs the project's tests and build,
  and for UI changes takes screenshots (\`${node} screenshot <file>.png\` with an Android device, else \`npx playwright screenshot <url> <file>.png\`)
  and reads them. When asked for a JSON verdict it ends with it. Frontmatter \`model: opus\`, \`tools: Read, Grep, Glob, Bash\`.
- \`.justcode/setup/skills/<name>/SKILL.md\` for recurring workflows the project clearly has (tests, release, deploy). Only ones that apply.

Agent files start with frontmatter: name, description, model, optionally tools. Install them (existing files are kept):
\`${node} setup\`

Also write \`CLAUDE.md\` at the project root if it is missing: stack, how to run, test and build, conventions.

## 2. TASKS.md, only if the project has none

Write \`TASKS.md\` at the project root with one \`## Backlog\` heading: what is already built as \`- [x]\`, everything else as
\`- [ ]\` in build order. Each item is one task a developer could build, review and merge on its own; details go on indented
lines under it. No sprint headings: the user plans sprints on the board.

## 3. Sync

Preview first: \`${node} sync --dry-run\`. Then apply: \`${node} sync\`

The open board updates by itself. Finish with a short summary: what you created, and what the sync added, moved and
archived. Only tasks that came from TASKS.md are changed; tasks made on the board are never touched.
`;
}
