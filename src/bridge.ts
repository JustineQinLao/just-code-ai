import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type DialogReply = { button?: string; value?: string } | undefined;
export interface DialogReq { title: string; text?: string; buttons?: string[]; input?: { label: string; multiline?: boolean } }

/** Request/response dialogs for remote clients. Events are queued so a polling client can fetch them. */
export class DialogHub {
  private pending = new Map<string, { res: (v: DialogReply) => void; timer: NodeJS.Timeout }>();
  private log: { n: number; msg: any; dialog?: string }[] = [];
  private n = 0;
  constructor(private timeoutMs = 120_000) {}

  /** Any message for the remote client (dialog, toast, copy, open). */
  emit(msg: Record<string, unknown>) { this.log.push({ n: ++this.n, msg, dialog: msg.type === 'dialog' ? String(msg.id) : undefined }); if (this.log.length > 100) this.log.shift(); }
  private drop(id: string) { this.log = this.log.filter(e => e.dialog !== id); }
  events(since: number) { return { last: this.n, events: this.log.filter(e => e.n > since).map(e => e.msg) }; }

  /** Resolves with the answer, or undefined (decline) on cancel or timeout. */
  ask(req: DialogReq): Promise<DialogReply> {
    const id = randomUUID();
    return new Promise(res => {
      const timer = setTimeout(() => { this.pending.delete(id); this.drop(id); res(undefined); }, this.timeoutMs);
      this.pending.set(id, { res, timer });
      this.emit({ type: 'dialog', id, ...req });
    });
  }

  /** Returns false for an unknown or already answered id. */
  reply(m: { id?: unknown; cancelled?: unknown; button?: unknown; value?: unknown }): boolean {
    const p = typeof m.id === 'string' ? this.pending.get(m.id) : undefined;
    if (!p) return false;
    clearTimeout(p.timer); this.pending.delete(String(m.id)); this.drop(String(m.id));
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

/** Remote confirm: true only when the client answers with the offered button. */
export const remoteConfirm = (hub: DialogHub, text: string, action: string) =>
  hub.ask({ title: 'Please confirm', text, buttons: [action] }).then(r => r?.button === action);

/** Remote text input, validated like the native box: an invalid value counts as no answer. */
export async function remoteInput(hub: DialogHub, o: { title?: string; prompt?: string; multiline?: boolean; validateInput?: (v: string) => string | undefined | null }) {
  const v = (await hub.ask({ title: o.title ?? '', text: o.prompt, buttons: ['OK'], input: { label: o.title ?? '', multiline: o.multiline } }))?.value;
  return v !== undefined && o.validateInput?.(v) ? undefined : v;
}

/** Remote file picking: typed paths, confined to the project. */
export async function remotePaths(hub: DialogHub, root: string, label: string): Promise<string[]> {
  const v = (await hub.ask({ title: label, text: 'One file or folder path per line (inside the project).', buttons: ['OK'], input: { label: 'Paths', multiline: true } }))?.value;
  return (v ?? '').split('\n').map(x => x.trim()).filter(Boolean).flatMap(x => confinePath(root, x) ?? []);
}

/** A remote caller can never approve its own bypass: the answer would come from the same token. */
/** Gate for a task asking for bypass: a phone never approves it; on the desktop, bypass-all (already confirmed) skips the per-task confirm. */
export const bypassGate = (remote: boolean, bypassAll: boolean, confirm: () => Promise<boolean>) => remote ? Promise.resolve(false) : bypassAll ? Promise.resolve(true) : confirm();
/** Only the desktop can switch bypass-all on, and only after its confirms. */
export const canEnableBypassAll = async (remote: boolean, confirm: () => Promise<boolean>) => !remote && await confirm();
export const confirmBypassFor = (remote: boolean, confirm: () => Promise<boolean>) => remote ? Promise.resolve(false) : confirm();

/** Board messages from a phone: dialog replies, and merge of a reviewed task after a confirm. The task is re-checked after the confirm,
 *  and a second merge for a task that already has a confirm open is ignored. */
export function makePhoneBoard<T extends { id: string; title: string; base?: string }>(d: {
  hub: DialogHub; task(id: string): T | undefined; canMerge(t: T): boolean; merge(id: string): Promise<unknown>;
}) {
  const busy = new Set<string>();
  const refuse = () => new Error('only tasks that passed review (and are not flagged critical) can be merged from the phone');
  return async (m: any): Promise<void> => {
    if (m.type === 'dialogReply') { d.hub.reply(m); return; }
    if (m.type !== 'merge') return;
    const id = String(m.id ?? '');
    const t = d.task(id);
    if (!t || !d.canMerge(t)) throw refuse();
    if (busy.has(id)) return;
    busy.add(id);
    try {
      if (!await remoteConfirm(d.hub, `Merge "${t.title}"${t.base ? ` into ${t.base}` : ''}?`, 'Merge')) return;
      const now = d.task(id);
      if (!now || !d.canMerge(now)) throw refuse();
      await d.merge(id);
    } finally { busy.delete(id); }
  };
}
