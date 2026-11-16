import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Task } from './store';

// 🧹 What piles up in .justcode/ and can go: per-task archives (transcripts, screenshots, logs) of finished work,
// folders of tasks that no longer exist, attachments, leftover task copies and old review scratch space.
// Kept always: board.json, policy, audit log, project.md, design, progress.md, sources, every unfinished task's files,
// and each finished task's brief, handoff, plan and review (small, and what later tasks and reports read).

export type Kind = 'logs' | 'gone' | 'attachments' | 'worktrees' | 'archived' | 'scratch';
export interface Item { kind: Kind; label: string; detail: string; bytes: number; count: number; paths: string[]; ids?: string[] }

const DAY = 86_400_000;
const jc = (root: string, ...p: string[]) => path.join(root, '.justcode', ...p);
const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };

export function size(p: string): number {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const f of list(p)) n += size(path.join(p, f));
  return n;
}
export const human = (b: number) => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;

// The bulky, re-creatable part of a finished task's folder; brief, handoff, plan and review stay.
const BULKY = (f: string) => /^(\.?transcript.*\.jsonl?|.*\.log|.*\.png|.*\.jpe?g|.*\.webm|.*\.zip|artifact\.html)$/i.test(f) || f === 'shots';

const finished = (t: Task) => t.archived || t.status === 'done';
const finishedAt = (t: Task) => t.doneAt ?? t.startedAt ?? t.created ?? 0;

// What can be cleaned. `olderThanDays` limits finished tasks to those finished at least that long ago (0 = all).
export function scan(root: string, tasks: Task[], olderThanDays = 0): Item[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  // Archived ones are counted under 'archived' (removed whole), not twice.
  const old = (t: Task) => !t.archived && finished(t) && Date.now() - finishedAt(t) >= olderThanDays * DAY;
  const items: Item[] = [];
  const add = (kind: Kind, label: string, detail: string, paths: string[], ids?: string[]) => {
    const bytes = paths.reduce((n, p) => n + size(p), 0);
    if (paths.length) items.push({ kind, label, detail, bytes, count: ids?.length ?? paths.length, paths, ids });
  };

  const logs: string[] = [], logIds = new Set<string>(), gone: string[] = [];
  for (const id of list(jc(root, 'tasks'))) {
    const d = jc(root, 'tasks', id), t = byId.get(id);
    if (!t) { gone.push(d); continue; }
    if (!old(t)) continue;
    for (const f of list(d)) if (BULKY(f)) { logs.push(path.join(d, f)); logIds.add(id); }
  }
  const att: string[] = [];
  for (const id of list(jc(root, 'attachments'))) {
    const t = byId.get(id);
    if (!t) gone.push(jc(root, 'attachments', id)); else if (old(t)) att.push(jc(root, 'attachments', id));
  }
  add('logs', 'Finished tasks: transcripts, screenshots and logs', 'Their briefs, handoffs, plans and reviews stay. Activity of these tasks then comes from Claude Code\'s own session history (kept about 30 days).', logs, [...logIds]);
  add('attachments', 'Finished tasks: attached images and files', 'What you pasted or attached to tasks that are done or archived.', att);
  add('gone', 'Files of deleted tasks', 'Task folders and attachments whose task is no longer on the board.', gone);

  const used = new Set(tasks.filter(t => t.worktree && !finished(t)).map(t => path.basename(t.worktree!)));
  add('worktrees', 'Leftover task copies', 'Folders under .justcode/worktrees no unfinished task uses (their Docker stacks are stopped too). Uncommitted work in them is lost.',
    list(jc(root, 'worktrees')).filter(d => !used.has(d) && d !== '_base').map(d => jc(root, 'worktrees', d)));

  const archived = tasks.filter(t => t.archived);
  if (archived.length) {
    const paths = archived.flatMap(t => [jc(root, 'tasks', t.id), jc(root, 'attachments', t.id)]).filter(p => fs.existsSync(p));
    items.push({ kind: 'archived', label: 'Archived tasks and chats', detail: 'Removes them from the board and the chat history for good, with their folders and attachments.',
      bytes: paths.reduce((n, p) => n + size(p), 0), count: archived.length, paths, ids: archived.map(t => t.id) });
  }

  const scratch = [jc(root, 'reviews'), ...list(path.join(os.tmpdir(), 'justcode-reviews')).filter(id => byId.has(id) ? finished(byId.get(id)!) : true).map(id => path.join(os.tmpdir(), 'justcode-reviews', id))].filter(p => fs.existsSync(p));
  add('scratch', 'Review scratch space', 'Screenshots and copies the AI reviewer made for finished reviews.', scratch);
  return items;
}

// Deletes the files of the chosen kinds (not 'worktrees' or 'archived': those go through the runner, which also
// removes git worktrees, branches, Docker stacks and board entries). Returns the bytes freed.
export function removeFiles(items: Item[]) {
  let freed = 0;
  for (const it of items) {
    if (it.kind === 'worktrees' || it.kind === 'archived') continue;
    for (const p of it.paths) { const n = size(p); try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); freed += n; } catch { /* in use: next time */ } }
  }
  return freed;
}
