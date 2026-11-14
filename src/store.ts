import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { trackIssues } from './issues';

export type Status = 'todo' | 'doing' | 'review' | 'done';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

// sources: ids of the project sources this sprint's tasks and plans use; undefined (sprints made before) = all of them.
// branch: the sprint's own branch, cut from `target` (the branch you were on) when its first task starts. Its tasks
// merge into it; when the last one merges, it merges into `target` and both are cleared.
export interface Sprint { id: string; name: string; goal?: string; active?: boolean; closed?: boolean; sources?: string[]; branch?: string; target?: string }

export interface Task {
  id: string;
  title: string;
  description?: string;
  sprintId?: string;          // undefined = backlog
  status: Status;
  agent?: string;             // .claude/agents name, run as `claude --agent <name>`
  mode: Mode;
  where?: 'branch' | 'direct';  // branch (default): own worktree + PR; direct: runs in the project checkout, no merge
  startHead?: string;         // direct: HEAD when the task started
  directFiles?: string[];     // direct: files changed in the checkout during the task (git status minus what was dirty before)
  warning?: string;           // a note on the card (e.g. a direct task has uncommitted files while this branch task runs)
  pastSessions?: string[];    // earlier sessions of this task (replaced by a fresh one when they grew big)
  sessionId?: string;         // Claude session, fixed up front with --session-id
  base?: string;              // branch the task forks from and merges back into
  branch?: string;            // jc/<slug>-<id>
  worktree?: string;          // <project>/.justcode/worktrees/<id>
  conflicts?: string[];       // files left conflicted by "bring base in"; merge is blocked until resolved
  pr?: string;                // remote PR URL, when pushed
  review?: Review;            // AI review of the task's branch
  limited?: boolean;          // a usage limit stopped this task; it continues by itself after the reset
  quick?: boolean;            // ⚡ Quick: runs at once in the workspace; no checks, no AI review (Finish or Discard after)
  init?: boolean | 'design';  // a JustCode setup run: true = describe the project, 'design' = DESIGN.md from the code
  allow?: string[];           // tools pre-approved for this task's session
  images?: string[];          // pasted screenshots, absolute paths under .justcode/attachments/<id>/
  files?: string[];           // files or URLs attached to this task as its basis (listed in its brief)
  sources?: string[];         // ids of the project sources this task rests on; undefined = all of them
  usage?: { build?: StageUsage; review?: StageUsage };  // tokens spent, per stage
  checks?: Checks;            // the project's checks, run by JustCode after each turn
  startedAt?: number;         // first run
  doneAt?: number;            // merged or marked done
  live?: boolean;             // Claude was mid-turn; a window that closed then continues it when it opens again
  reply?: string;             // Claude's last message when its turn ended (shown when it asks something instead of changing files)
  remote?: boolean;           // continued in a terminal with Remote Control (phone / claude.ai); back on the board when it closes
  error?: string;             // the last run failed to start or ended on an error
  noWait?: boolean;           // Run all goes on without it (it waits for you to merge or fix it); cleared when it runs again
  costUsd?: number;           // estimated cost of the task's sessions and reviews so far (API pricing; plans are not billed per task)
  output?: 'artifact';        // the result is a page published as a claude.ai artifact (not a code change)
  artifactUrl?: string;       // its link, once published
  publishing?: boolean;       // JustCode is publishing the page now (interactive claude in a terminal)
  archived?: boolean;
  dependsOn?: string[];      // task ids that must be done before Run all starts this one
  created: number;
}

// AI review after each finished turn: running → pass, or fail with issues (sent back to the builder).
export interface CheckRun { name: string; cmd: string; ok: boolean; ms: number; tail?: string; preexisting?: boolean; timedOut?: boolean }
export interface Checks { state: 'pass' | 'fail' | 'none'; rounds: number; head?: string; results?: CheckRun[] }

export interface StageUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

// One review issue, tracked across rounds by key (see issues.ts). accepted: you decided it does not block the merge.
export interface Issue { text: string; key: string; rounds: number; accepted?: boolean }
// extraRounds: "1 more round" presses on this task, on top of the setting. fixNote: Claude's reply after the last fix round.
export interface Review { state: 'running' | 'pass' | 'fail' | 'error'; unreviewed?: boolean; level?: 'none' | 'light' | 'full'; why?: string; error?: string; issues?: Issue[]; attempts: number; extraRounds?: number; fixNote?: string; hold?: string; head?: string; risk?: 'minor' | 'critical'; screenshots?: string[]; tested?: string[] }

// rules: what you approved with "Always" on a card, kept for every task of this project.
// queue: Run all's remaining tasks, so a reload continues it.
// plannerCostUsd: planning chats' estimated cost, which counts toward the project budget.
export interface Board { sprints: Sprint[]; tasks: Task[]; rules?: string[]; queue?: string[]; plannerCostUsd?: number }

// One board per project folder, kept in the project at .justcode/board.json.
export class Store {
  readonly file: string;
  private board: Board;
  private ev = new EventEmitter();

  constructor(readonly root: string) {
    this.file = path.join(root, '.justcode', 'board.json');
    this.board = this.read();
    try { this.written = fs.readFileSync(this.file, 'utf8'); } catch { /* no board yet */ }
  }

  private read(): Board {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return { sprints: [], tasks: [] }; } // no board yet
    try {
      const b = JSON.parse(text);
      const tasks = (b.tasks ?? []) as any[];
      for (const t of tasks) if (t && (t.where as string) === 'root') t.where = 'direct'; // renamed once
      for (const t of tasks) if ((t?.review?.issues as unknown[] | undefined)?.some(i => typeof i === 'string')) // plain strings before issue tracking
        t.review.issues = trackIssues(undefined, (t.review.issues as unknown[]).map(String));
      return { sprints: b.sprints ?? [], tasks, rules: Array.isArray(b.rules) ? b.rules : [], queue: Array.isArray(b.queue) ? b.queue : [] };
    } catch {
      // Hand-edited or merge-conflicted: keep a copy before the next save replaces it, so nothing is lost.
      const copy = `${this.file}.corrupt-${Date.now()}`;
      if (this.lastCorrupt !== text) { try { fs.copyFileSync(this.file, copy); this.lastCorrupt = text; } catch { /* read-only */ } }
      return { sprints: [], tasks: [] };
    }
  }
  private lastCorrupt = '';

  // tmp + rename: a crash mid-write never leaves a half-written board.
  private written = '';

  // Reloads if someone else (the sync CLI, another window) wrote the file since our last write, so a save
  // never puts back a stale board over their changes.
  private fresh() {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    if (text === this.written) return;
    this.written = text;
    this.board = this.read();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.written = JSON.stringify(this.board, null, 2);
    fs.writeFileSync(tmp, this.written);
    fs.renameSync(tmp, this.file);
    this.ev.emit('change');
  }

  // Picks up writes from outside (the sync CLI, another window), so the board shows them and never overwrites them.
  watch() {
    fs.watchFile(this.file, { interval: 1000 }, () => {
      const before = this.written;
      this.fresh();
      if (this.written !== before) this.ev.emit('change');
    });
  }
  dispose() { fs.unwatchFile(this.file); this.ev.removeAllListeners(); }

  onChange(fn: () => void) { this.ev.on('change', fn); return { dispose: () => { this.ev.off('change', fn); } }; }

  get data(): Board { return this.board; }
  task(id: string) { return this.board.tasks.find(t => t.id === id); }
  sprint(id: string) { return this.board.sprints.find(s => s.id === id); }

  addTask(t: Omit<Task, 'id' | 'created' | 'status'> & { status?: Status }) {
    this.fresh();
    const task: Task = { status: 'todo', ...t, id: randomUUID().slice(0, 8), created: Date.now() };
    this.board.tasks.push(task);
    this.save();
    return task;
  }

  updateTask(id: string, patch: Partial<Task>) {
    this.fresh();
    const t = this.task(id);
    if (!t) return;
    Object.assign(t, patch);
    for (const k of Object.keys(patch) as (keyof Task)[]) if (patch[k] === undefined) delete t[k];
    this.save();
    return t;
  }

  // Board order is run order: moves `id` before `beforeId` (or to the end).
  reorder(id: string, beforeId?: string) {
    this.fresh();
    const from = this.board.tasks.findIndex(t => t.id === id);
    if (from < 0 || id === beforeId) return;
    const [t] = this.board.tasks.splice(from, 1);
    const to = beforeId ? this.board.tasks.findIndex(x => x.id === beforeId) : -1;
    this.board.tasks.splice(to < 0 ? this.board.tasks.length : to, 0, t);
    this.save();
  }

  deleteTask(id: string) {
    this.fresh();
    this.board.tasks = this.board.tasks.filter(t => t.id !== id);
    this.board.queue = (this.board.queue ?? []).filter(q => q !== id);
    this.save();
  }

  get rules() { return this.board.rules ?? []; }
  addRules(rules: string[]) {
    this.fresh();
    const cur = this.board.rules ?? [];
    const add = [...new Set(rules)].filter(r => r && !cur.includes(r));
    if (!add.length) return;
    this.board.rules = [...cur, ...add];
    this.save();
  }
  setRules(rules: string[]) {
    this.fresh();
    this.board.rules = [...new Set(rules.map(r => r.trim()).filter(Boolean))];
    this.save();
  }

  get queue() { return this.board.queue ?? []; }
  addPlannerCost(usd: number) {
    if (!(usd > 0)) return;
    this.fresh();
    this.board.plannerCostUsd = (this.board.plannerCostUsd ?? 0) + usd;
    this.save();
  }

  setQueue(ids: string[]) {
    this.fresh();
    if (JSON.stringify(ids) === JSON.stringify(this.board.queue ?? [])) return;
    this.board.queue = ids;
    this.save();
  }

  addSprint(name: string, goal?: string) {
    this.fresh();
    const s: Sprint = { id: randomUUID().slice(0, 8), name, goal, active: !this.board.sprints.some(x => x.active), sources: [] };
    this.board.sprints.push(s);
    this.save();
    return s;
  }

  updateSprint(id: string, patch: Partial<Sprint>) {
    this.fresh();
    const s = this.sprint(id);
    if (!s) return;
    if (patch.active) this.board.sprints.forEach(x => { x.active = false; });
    Object.assign(s, patch);
    this.save();
  }

  // Deleting a sprint removes only the sprint: all its tasks, done ones too, move to the backlog.
  deleteSprint(id: string) {
    this.fresh();
    for (const t of this.board.tasks) if (t.sprintId === id) delete t.sprintId;
    this.board.sprints = this.board.sprints.filter(s => s.id !== id);
    this.save();
  }

  // Closing a sprint sends its unfinished tasks back to the backlog.
  closeSprint(id: string) {
    this.fresh();
    for (const t of this.board.tasks) if (t.sprintId === id && t.status !== 'done') delete t.sprintId;
    const s = this.sprint(id);
    if (s) { s.closed = true; s.active = false; }
    this.save();
  }
}

// Where a new task runs: an explicit choice wins; otherwise justCode.defaultWhere (auto: backlog direct, sprint branch).
// A remote client (phone) always gets its own branch.
// What a task produces. 'code' or 'artifact' when the form says so; automatic ('' or missing): an artifact page when the
// text asks for a mockup, wireframe, prototype or artifact, otherwise a code change.
export const ARTIFACT_WORDS = /\b(mock-?ups?|wire-?frames?|prototypes?|artifacts?|landing page|design concepts?|style guide)\b/i;
export function resolveOutput(output: unknown, text: string): 'artifact' | undefined {
  if (output === 'artifact') return 'artifact';
  if (output === 'code') return undefined;
  return ARTIFACT_WORDS.test(text) ? 'artifact' : undefined;
}

// A whole prompt typed into the title box (common with ⚡ Quick) makes a wall of text on the card. Keep the first
// sentence or line (at most 80 characters) as the title and move the full text into the description, so nothing is lost.
export function splitTitle(title: string, description?: string): { title: string; description?: string } {
  const t = title.trim(), d = description?.trim() || undefined;
  if (t.length <= 100 && !t.includes('\n')) return { title: t, description: d };
  const first = t.split('\n')[0].trim();
  const sentence = first.match(/^.{10,80}?[.!?](?=\s|$)/)?.[0];
  let short = sentence ?? first;
  if (short.length > 80) short = short.slice(0, 80).replace(/\s+\S*$/, '') + '…';
  return { title: short, description: [t, d].filter(Boolean).join('\n\n') };
}

export function resolveWhere(o: { where?: string; artifact?: boolean; setting?: string; sprintId?: string; remote?: boolean }): 'direct' | 'branch' {
  if (o.remote) return 'branch';
  if (o.where === 'direct' || o.artifact) return 'direct';
  if (o.where === 'branch') return 'branch';
  if (o.setting === 'direct' || o.setting === 'branch') return o.setting;
  return o.sprintId ? 'branch' : 'direct';
}
