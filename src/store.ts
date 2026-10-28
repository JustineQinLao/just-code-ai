import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export type Status = 'todo' | 'doing' | 'review' | 'done';
export type Mode = 'default' | 'acceptEdits' | 'plan';

export interface Sprint { id: string; name: string; goal?: string; active?: boolean; closed?: boolean }

export interface Task {
  id: string;
  title: string;
  description?: string;
  sprintId?: string;          // undefined = backlog
  status: Status;
  agent?: string;             // .claude/agents name, run as `claude --agent <name>`
  mode: Mode;
  where?: 'branch' | 'root';  // branch (default): own worktree + PR; root: runs in the project folder, no merge
  sessionId?: string;         // Claude session, fixed up front with --session-id
  base?: string;              // branch the task forks from and merges back into
  branch?: string;            // jc/<slug>-<id>
  worktree?: string;          // <project>/.justcode/worktrees/<id>
  conflicts?: string[];       // files left conflicted by "bring base in"; merge is blocked until resolved
  pr?: string;                // remote PR URL, when pushed
  src?: 'TASKS.md';           // created by TASKS.md sync; only these are updated or archived by it
  review?: Review;            // AI review of the task's branch
  init?: boolean;             // the project's initialization run
  allow?: string[];           // tools pre-approved for this task's session (--allowedTools)
  images?: string[];          // pasted screenshots, absolute paths under .justcode/attachments/<id>/
  archived?: boolean;
  created: number;
}

// AI review after each finished turn: running → pass, or fail with issues (sent back to the builder).
export interface Review { state: 'running' | 'pass' | 'fail'; issues?: string[]; attempts: number; head?: string; risk?: 'minor' | 'critical' }

export interface Board { sprints: Sprint[]; tasks: Task[] }

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
    try {
      const b = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { sprints: b.sprints ?? [], tasks: b.tasks ?? [] };
    } catch { return { sprints: [], tasks: [] }; }
  }

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

  deleteTask(id: string) {
    this.fresh();
    this.board.tasks = this.board.tasks.filter(t => t.id !== id);
    this.save();
  }

  addSprint(name: string, goal?: string) {
    this.fresh();
    const s: Sprint = { id: randomUUID().slice(0, 8), name, goal, active: !this.board.sprints.some(x => x.active) };
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

  // Closing a sprint sends its unfinished tasks back to the backlog.
  closeSprint(id: string) {
    this.fresh();
    for (const t of this.board.tasks) if (t.sprintId === id && t.status !== 'done') delete t.sprintId;
    const s = this.sprint(id);
    if (s) { s.closed = true; s.active = false; }
    this.save();
  }
}
