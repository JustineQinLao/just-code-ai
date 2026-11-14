import * as fs from 'fs';
import * as path from 'path';

// Who did what, when: .justcode/audit.jsonl, one JSON object per line, append-only. One developer per machine, so
// the actor says which side acted (you on the board, the phone, JustCode itself, the policy, the reviewer), not who.
export type Actor = 'user' | 'phone' | 'justcode' | 'policy' | 'review';
export type AuditEvent =
  | 'task.create' | 'task.run' | 'task.stop' | 'task.message'
  | 'permission.allow' | 'permission.always' | 'permission.deny' | 'mode.switch'
  | 'review.pass' | 'review.fail' | 'review.accept' | 'review.override' | 'checks.fail'
  | 'merge' | 'finish' | 'discard' | 'publish'
  | 'policy.deny' | 'policy.change' | 'budget.stop' | 'secrets.block' | 'phone.pair' | 'phone.action';
export interface AuditEntry { time: string; actor: Actor; event: AuditEvent; taskId?: string; sprintId?: string; detail?: string }

export const auditFile = (root: string) => path.join(root, '.justcode', 'audit.jsonl');

// Never throws: a full disk or a read-only folder must not stop a task.
export function log(root: string, e: Omit<AuditEntry, 'time'> & { time?: string }) {
  try {
    const entry: AuditEntry = { time: e.time ?? new Date().toISOString(), actor: e.actor, event: e.event,
      ...(e.taskId ? { taskId: e.taskId } : {}), ...(e.sprintId ? { sprintId: e.sprintId } : {}), ...(e.detail ? { detail: e.detail.slice(0, 1000) } : {}) };
    fs.mkdirSync(path.dirname(auditFile(root)), { recursive: true });
    fs.appendFileSync(auditFile(root), JSON.stringify(entry) + '\n');
  } catch { /* the audit log is best effort */ }
}

export function read(root: string, f: { since?: number; taskId?: string; event?: AuditEvent } = {}): AuditEntry[] {
  let text = '';
  try { text = fs.readFileSync(auditFile(root), 'utf8'); } catch { return []; }
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: AuditEntry;
    try { e = JSON.parse(line); } catch { continue; }
    if (f.taskId && e.taskId !== f.taskId) continue;
    if (f.event && e.event !== f.event) continue;
    if (f.since && Date.parse(e.time) < f.since) continue;
    out.push(e);
  }
  return out;
}

const cell = (v: unknown) => { const s = v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(entries: AuditEntry[], title: (id: string) => string | undefined = () => undefined) {
  return ['time,actor,event,task,task id,sprint id,detail',
    ...entries.map(e => [e.time, e.actor, e.event, e.taskId ? title(e.taskId) : '', e.taskId, e.sprintId, e.detail].map(cell).join(','))].join('\n') + '\n';
}
