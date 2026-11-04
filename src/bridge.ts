import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type DialogReply = { button?: string; value?: string } | undefined;
export interface DialogReq { title: string; text?: string; buttons?: string[]; input?: { label: string; multiline?: boolean } }

/** Request/response dialogs for remote clients. Events are queued so a polling client can fetch them. */
export class DialogHub {
  private pending = new Map<string, { res: (v: DialogReply) => void; timer: NodeJS.Timeout }>();
  private log: { n: number; msg: any }[] = [];
  private n = 0;
  constructor(private timeoutMs = 120_000) {}

  /** Any message for the remote client (dialog, toast, copy, open). */
  emit(msg: Record<string, unknown>) { this.log.push({ n: ++this.n, msg }); if (this.log.length > 100) this.log.shift(); }
  events(since: number) { return { last: this.n, events: this.log.filter(e => e.n > since).map(e => e.msg) }; }

  /** Resolves with the answer, or undefined (decline) on cancel or timeout. */
  ask(req: DialogReq): Promise<DialogReply> {
    const id = randomUUID();
    return new Promise(res => {
      const timer = setTimeout(() => { this.pending.delete(id); res(undefined); }, this.timeoutMs);
      this.pending.set(id, { res, timer });
      this.emit({ type: 'dialog', id, ...req });
    });
  }

  /** Returns false for an unknown or already answered id. */
  reply(m: { id?: unknown; cancelled?: unknown; button?: unknown; value?: unknown }): boolean {
    const p = typeof m.id === 'string' ? this.pending.get(m.id) : undefined;
    if (!p) return false;
    clearTimeout(p.timer); this.pending.delete(String(m.id));
    p.res(m.cancelled ? undefined : { button: typeof m.button === 'string' ? m.button : undefined, value: typeof m.value === 'string' ? m.value : undefined });
    return true;
  }
  get size() { return this.pending.size; }
}

/** Resolve a user-typed path inside root; anything outside (absolute, .., symlink escape) or missing is dropped. */
export function confinePath(root: string, p: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(realRoot, p));
    const rel = path.relative(realRoot, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? real : undefined;
  } catch { return undefined; }
}

export const validLink = (v: string) => /^https?:\/\/\S+$/.test(v.trim());
