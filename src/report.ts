import * as fs from 'fs';
import * as path from 'path';
import type { Sprint, Task } from './store';
import * as Audit from './audit';
import * as R from './registry';
import * as g from './git';

// A sprint's report as Markdown: .justcode/reports/sprint-<name>-<date>.md. Everything comes from the board, git, the
// audit log and the artifact registry, so it can be regenerated at any time.
export interface MergeInfo { sha: string; files: number }

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const usd = (n: number) => `$${n.toFixed(2)}`;
const reviewRounds = (t: Task) => t.review ? (t.review.state === 'pass' ? t.review.attempts + 1 : t.review.attempts) : 0;

// The merge (or Finish) commit of a done task, found by the message JustCode writes, and how many files it changed.
export async function mergeOf(root: string, t: Task): Promise<MergeInfo | undefined> {
  if (t.status !== 'done') return undefined;
  const grep = t.where === 'direct' ? `^${t.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : `^Merge ${t.branch ?? ''}: `;
  if (t.where !== 'direct' && !t.branch) return undefined;
  const sha = (await g.git(root, ['log', '--all', '-n', '1', '--format=%H', '-E', `--grep=${grep}`]).catch(() => '')).trim();
  if (!sha) return undefined;
  const files = (await g.git(root, ['diff', '--name-only', `${sha}^1`, sha]).catch(() => '')).split('\n').filter(Boolean).length;
  return { sha, files };
}

export function sprintReport(root: string, sprint: Sprint, tasks: Task[], merges: Map<string, MergeInfo | undefined>, now = new Date()) {
  const mine = tasks.filter(t => t.sprintId === sprint.id && !t.archived);
  const ids = new Set(mine.map(t => t.id));
  const total = mine.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  const audit = Audit.read(root).filter(e => e.sprintId === sprint.id || (e.taskId && ids.has(e.taskId)));
  const highlights = audit.filter(e => ['policy.deny', 'budget.stop', 'secrets.block', 'review.override', 'permission.always'].includes(e.event));
  const title = (id?: string) => mine.find(t => t.id === id)?.title ?? id ?? '';
  const outputs = R.load(root).filter(e => e.kind === 'output' && (e.sprintIds.includes(sprint.id) || e.taskIds.some(id => ids.has(id))));
  const done = mine.filter(t => t.status === 'done').length;
  return [
    `# Sprint report: ${sprint.name}`,
    '',
    `Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    '## Goal',
    sprint.goal?.trim() || '_No goal set._',
    '',
    '## Summary',
    `- Tasks: ${mine.length} (${done} done, ${mine.length - done} open)`,
    `- Estimated cost: ${usd(total)}`,
    `- Files changed by merged tasks: ${[...merges.values()].reduce((n, m) => n + (m?.files ?? 0), 0)}`,
    `- Review rounds: ${mine.reduce((n, t) => n + reviewRounds(t), 0)}`,
    sprint.branch ? `- Branch: \`${sprint.branch}\` → \`${sprint.target}\`` : '- Branch: merged',
    '',
    '## Tasks',
    '| Task | Status | Kind | Merge commit | Files | Review rounds | Cost |',
    '|---|---|---|---|---|---|---|',
    ...mine.map(t => {
      const m = merges.get(t.id);
      const accepted = (t.review?.issues ?? []).filter(i => i.accepted).length;
      return `| ${cell(t.title)} | ${t.status}${accepted ? ` (${accepted} accepted issue${accepted === 1 ? '' : 's'})` : ''} | ${t.where === 'direct' ? 'direct' : 'branch'} | ${m ? `\`${m.sha.slice(0, 8)}\`` : ''} | ${m?.files ?? ''} | ${reviewRounds(t)} | ${usd(t.costUsd ?? 0)} |`;
    }),
    `| **Total** | | | | | | **${usd(total)}** |`,
    '',
    '## Audit highlights',
    highlights.length ? highlights.map(e => `- ${e.time.slice(0, 16).replace('T', ' ')} · ${e.event} · ${e.actor}${e.taskId ? ` · ${cell(title(e.taskId))}` : ''}${e.detail ? `: ${cell(e.detail).slice(0, 200)}` : ''}`).join('\n') : '_No denials, budget stops, blocked commits or overrides._',
    '',
    '## Artifacts produced',
    outputs.length ? outputs.map(e => `- [${cell(e.title ?? e.url)}](${e.url})${e.taskIds.length ? ` · ${e.taskIds.map(title).filter(Boolean).map(cell).join(', ')}` : ''}`).join('\n') : '_None._',
    '',
  ].join('\n');
}

export const reportFile = (root: string, sprint: Sprint, now = new Date()) =>
  path.join(root, '.justcode', 'reports', `sprint-${sprint.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || sprint.id}-${now.toISOString().slice(0, 10)}.md`);

export async function writeSprintReport(root: string, sprint: Sprint, tasks: Task[]) {
  const merges = new Map<string, MergeInfo | undefined>();
  for (const t of tasks.filter(x => x.sprintId === sprint.id && !x.archived)) merges.set(t.id, await mergeOf(root, t));
  const file = reportFile(root, sprint);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sprintReport(root, sprint, tasks, merges));
  return file;
}
