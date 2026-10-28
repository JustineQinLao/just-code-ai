import * as fs from 'fs';
import * as path from 'path';
import { Status, Store } from './store';

// TASKS.md → board. Headings set the context (## Sprint 2, ## Backlog; other headings keep the current one),
// list items become tasks, indented lines join the item's description.
// - [ ] todo   - [~] or - [/] doing   - [x], ~~struck~~ or ✅ done   plain "- item" counts as todo.

export interface MdTask { title: string; description?: string; sprint?: string; status: Status; line: number }

const SKIP = new Set(['node_modules', '.git', '.justcode', 'out', 'dist', 'build', '.next', 'vendor', '.venv', 'target']);

// Shallowest TASKS.md in the project (root first, then breadth-first).
export function findTasksFile(root: string): string | undefined {
  let level = [root];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    for (const dir of level) {
      const hit = ['TASKS.md', 'tasks.md'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
      if (hit) return hit;
    }
    level = level.flatMap(dir => {
      try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !SKIP.has(d.name)).map(d => path.join(dir, d.name)); } catch { return []; }
    });
  }
}

export function parseTasks(md: string): MdTask[] {
  const out: MdTask[] = [];
  let sprint: string | undefined;
  let cur: MdTask | undefined;
  md.split(/\r?\n/).forEach((line, i) => {
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      cur = undefined;
      const h = head[1].trim();
      const s = /^sprint\b[:\s-]*(.*)$/i.exec(h);
      if (s) sprint = `Sprint ${s[1].trim()}`.trim().replace(/^Sprint\s+Sprint\b/i, 'Sprint');
      else if (/^backlog\b/i.test(h)) sprint = undefined;
      return;
    }
    const item = /^([-*+]|\d+[.)])\s+(?:\[([ xX~/])\]\s+)?(.*)$/.exec(line);
    if (item) {
      let text = item[3].trim();
      let status: Status = 'todo';
      if (item[2] && /[xX]/.test(item[2])) status = 'done';
      else if (item[2] === '~' || item[2] === '/') status = 'doing';
      if (/^~~.*~~$/.test(text) || /✅/.test(text)) status = 'done';
      text = text.replace(/^~~(.*)~~$/, '$1').replace(/✅/g, '').trim();
      if (!text) return;
      cur = { title: text, sprint, status, line: i + 1 };
      out.push(cur);
      return;
    }
    const more = /^\s{2,}\S/.test(line) ? line.trim().replace(/^([-*+]|\d+[.)])\s+(?:\[[ xX~/]\]\s+)?/, '') : '';
    if (more && cur) cur.description = cur.description ? `${cur.description}\n${more}` : more;
    else if (line.trim()) cur = undefined; // blank lines keep the item open for a following indented line
  });
  return out;
}

const key = (s: string) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export interface SyncResult { file: string; added: string[]; moved: string[]; archived: string[]; skipped: string[]; sprints: string[] }

// Applies TASKS.md to the board. Only tasks that came from TASKS.md are updated or archived; tasks made on the
// board are never touched. A task with a branch in progress is not moved to done from markdown (merge it on the board).
export function syncTasks(store: Store, file: string, dryRun: boolean): SyncResult {
  const items = parseTasks(fs.readFileSync(file, 'utf8'));
  const res: SyncResult = { file, added: [], moved: [], archived: [], skipped: [], sprints: [] };
  const fromMd = store.data.tasks.filter(t => t.src === 'TASKS.md');
  const sprintId = (name?: string) => {
    if (!name) return undefined;
    const s = store.data.sprints.find(x => key(x.name) === key(name) && !x.closed);
    if (s) return s.id;
    if (dryRun && res.sprints.includes(name)) return undefined;
    res.sprints.push(name);
    return dryRun ? undefined : store.addSprint(name).id;
  };
  const seen = new Set<string>();
  for (const it of items) {
    const k = key(it.title);
    if (seen.has(k)) continue;
    seen.add(k);
    const t = store.data.tasks.find(x => key(x.title) === k && !x.archived);
    if (!t) {
      res.added.push(it.title);
      if (!dryRun) store.addTask({ title: it.title, description: it.description, sprintId: sprintId(it.sprint), mode: 'default', status: it.status, src: 'TASKS.md' });
      else sprintId(it.sprint);
      continue;
    }
    if (t.src !== 'TASKS.md' || t.status === it.status) continue;
    const order = ['todo', 'doing', 'review', 'done'];
    if (order.indexOf(it.status) < order.indexOf(t.status)) continue; // the board is further along; markdown never moves work back
    if (it.status === 'done' && t.branch) { res.skipped.push(`${t.title} (has an unmerged branch: merge it on the board)`); continue; }
    res.moved.push(`${t.title}: ${t.status} → ${it.status}`);
    if (!dryRun) store.updateTask(t.id, { status: it.status });
  }
  for (const t of fromMd) {
    if (t.archived || seen.has(key(t.title))) continue;
    if (t.branch && t.status !== 'done') { res.skipped.push(`${t.title} (removed from TASKS.md but has a branch)`); continue; }
    res.archived.push(t.title);
    if (!dryRun) store.updateTask(t.id, { archived: true });
  }
  return res;
}

export function formatResult(r: SyncResult, dryRun: boolean) {
  const sec = (label: string, xs: string[]) => xs.length ? `${label} (${xs.length}):\n${xs.map(x => `  - ${x}`).join('\n')}` : '';
  const body = [sec('New sprints', r.sprints), sec('Add', r.added), sec('Move', r.moved), sec('Archive', r.archived), sec('Skipped', r.skipped)].filter(Boolean).join('\n');
  return `${dryRun ? 'Dry run, nothing written. ' : ''}${path.basename(r.file)} → JustCode board\n${body || 'Already in sync.'}`;
}
