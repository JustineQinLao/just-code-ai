import * as http from 'http';
import { timingSafeEqual, randomBytes } from 'crypto';
import { PAGE } from './phonepage';

export interface PhoneDeps {
  token: string;
  state(): unknown;
  act(m: Record<string, unknown>): Promise<string | void>;
  /** Board messages relayed from a remote page; the host always handles them as remote. */
  board?(m: Record<string, unknown>): Promise<void>;
  events?(since: number): unknown;
  /** Changed files, review and checks of one task, for the phone detail view. */
  detail?(id: string): Promise<unknown>;
  /** Full read-only detail of one task in the current project (steps, files, review, checks, agents, cost, context); undefined for an unknown id. */
  task?(id: string): Promise<unknown | undefined>;
  /** Accept the permanent token in the URL (?t= / ?token=). Default true; the extension turns it off in favour of pairing codes. */
  allowTokenInUrl?: boolean;
}

const SESSION_TTL_MS = 12 * 3600_000;

// Actions a phone may send. Anything else is refused, so a leaked token cannot open files, change settings, etc.
// Board messages a remote page may relay: answers to dialogs, and merge (which the host checks and confirms). Nothing else.
export const BOARD_ACTIONS = ['dialogReply', 'merge'] as const;

export const PHONE_COLUMNS = ['todo', 'doing', 'review', 'done'] as const;
export const PHONE_ACTIONS = ['addTask', 'run', 'stop', 'answer', 'merge', 'project', 'move'] as const;
/** Why a phone may not move a task to `status` (an error string), or undefined if allowed. Pure so it can be tested. */
export function phoneMoveError(t: { status: string; worktree?: string; where?: string; review?: { state?: string; risk?: string }; busy?: boolean; asks?: unknown[] }, status: unknown): string | undefined {
  if (typeof status !== 'string' || !(PHONE_COLUMNS as readonly string[]).includes(status)) return 'unknown status';
  if (status === 'done') return canPhoneMerge(t) ? undefined : 'only tasks that passed review (and are not flagged critical) can be moved to Done (merged) from the phone';
  if (t.busy || (t.asks?.length ?? 0) > 0) return 'this task is running or waiting for an answer; stop it first';
  if (t.status === 'done') return 'a done task cannot be moved from the phone';
  if (status === 'todo' && t.worktree) return 'this task has work on its branch; discard it on the desktop to start over';
  return undefined;
}
/** Projects as the phone sees them: only root and a display name. */
export const phoneProjects = (roots: string[]) => roots.map(root => ({ root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }));
/** A project path the phone may select: a string that is one of the known roots. */
export const phoneProjectOk = (path: unknown, roots: string[]) => typeof path === 'string' && roots.includes(path);

// One rule for showing the Merge button and for accepting a phone merge; never looser than the board's bulk merge.
export interface PhoneDetail { files: { file: string; status: string; added: number; removed: number }[]; review?: { state: string; why?: string; issues: string[] }; checks: { name: string; ok: boolean; tail?: string }[]; error?: string }
/** Payload for the detail view. A task without a worktree has no files and no error. `diff` is only called when there is a worktree. */
export async function phoneDetail(t: { worktree?: string; review?: { state: string; why?: string; issues?: string[] }; checks?: { results?: { name: string; ok: boolean; tail?: string }[] } },
  diff: (dir: string) => Promise<PhoneDetail['files']>): Promise<PhoneDetail> {
  const out: PhoneDetail = { files: [], checks: (t.checks?.results ?? []).map(c => ({ name: c.name, ok: c.ok, tail: c.tail })) };
  if (t.review) out.review = { state: t.review.state, why: t.review.why, issues: t.review.issues ?? [] };
  if (t.worktree) { try { out.files = await diff(t.worktree); } catch (e: any) { out.error = String(e.message ?? e); } }
  return out;
}

export const PHONE_STEP_CAP = 200, PHONE_STEP_TEXT = 600;
/** Last `cap` steps with long text cut, so one task cannot make a huge response. */
export function phoneSteps<T extends { text: string }>(steps: T[], cap = PHONE_STEP_CAP, max = PHONE_STEP_TEXT): T[] {
  return steps.slice(-cap).map(s => s.text.length > max ? { ...s, text: s.text.slice(0, max) + '…' } : s);
}

export const canPhoneMerge = (t: { worktree?: string; where?: string; status: string; review?: { state?: string; risk?: string } }) =>
  !!t.worktree && t.where !== 'direct' && t.status === 'review' && t.review?.state === 'pass' && t.review?.risk !== 'critical';

// Pairing codes: single-use and short-lived, so the link/QR never carries the long-lived token.
const PAIR_TTL_MS = 10 * 60_000;
const pairCodes = new Map<string, number>();
export function issuePairingCode(ttlMs = PAIR_TTL_MS, now = Date.now()): string {
  for (const [c, exp] of pairCodes) if (exp <= now) pairCodes.delete(c);
  const code = randomBytes(18).toString('base64url');
  pairCodes.set(code, now + ttlMs);
  return code;
}
/** Consumes the code: true only the first time, and only before it expires. */
export function redeemPairingCode(code: string, now = Date.now()): boolean {
  const exp = pairCodes.get(code); pairCodes.delete(code);
  return !!code && exp !== undefined && exp > now;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startPhoneServer(port: number, d: PhoneDeps): Promise<http.Server> {
  // Per-server, in memory: a cookie is a random revocable session id, never the permanent token. A restart or token change drops them all.
  const sessions = new Map<string, number>();
  const sessionOk = (id: string, now = Date.now()) => { const e = sessions.get(id); if (e !== undefined && e <= now) sessions.delete(id); return !!id && (sessions.get(id) ?? 0) > now; };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/sw.js') return send(200, SW, 'application/javascript');
    const hdr = String(req.headers['x-token'] ?? '');
    const q = d.allowTokenInUrl === false ? '' : url.searchParams.get('t') ?? url.searchParams.get('token') ?? '';
    const ckRaw = /(?:^|;\s*)jc_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const ck = (() => { try { return decodeURIComponent(ckRaw); } catch { return ''; } })();
    const pair = url.searchParams.get('pair') ?? '';
    const paired = !!pair && redeemPairingCode(pair);
    const viaToken = [hdr, q].some(t => t && same(t, d.token));
    if (!(paired || viaToken || sessionOk(ck))) return send(401, '{"error":"bad token"}');
    // Redeeming a pairing code (or a token link) starts a session: an HttpOnly cookie, so later requests need nothing in the URL.
    if (paired || (q && viaToken)) {
      const id = randomBytes(24).toString('base64url');
      sessions.set(id, Date.now() + SESSION_TTL_MS);
      res.setHeader('set-cookie', `jc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    }
    if (url.pathname === '/') return send(200, PAGE, 'text/html');
    if (url.pathname === '/api/state' && req.method === 'GET') return send(200, JSON.stringify(d.state()));
    if (url.pathname === '/api/detail' && req.method === 'GET' && d.detail) {
      d.detail(url.searchParams.get('id') ?? '').then(j => send(200, JSON.stringify(j)), () => send(500, '{"error":"detail failed"}'));
      return;
    }
    if (url.pathname === '/api/task' && req.method === 'GET' && d.task) {
      const id = url.searchParams.get('id') ?? '';
      if (!id) return send(404, '{"error":"no such task"}');
      d.task(id).then(j => j === undefined ? send(404, '{"error":"no such task"}') : send(200, JSON.stringify(j)), () => send(500, '{"error":"task failed"}'));
      return;
    }
    if (url.pathname === '/api/events' && req.method === 'GET' && d.events) return send(200, JSON.stringify(d.events(Number(url.searchParams.get('since')) || 0)));
    if (url.pathname === '/api/board' && req.method === 'POST' && d.board) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 100_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const m = JSON.parse(body);
          if (!(BOARD_ACTIONS as readonly string[]).includes(m.type)) return send(400, '{"error":"action not allowed"}');
          const { remote: _ignored, ...clean } = m; // the server, not the client, decides this is remote
          await d.board!(clean);
          send(200, '{"ok":true}');
        } catch (e: any) { send(500, JSON.stringify({ error: String(e?.message ?? e) })); }
      });
      return;
    }
    if (url.pathname === '/api/act' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 100_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const m = JSON.parse(body);
          if (!(PHONE_ACTIONS as readonly string[]).includes(m.type)) return send(400, '{"error":"action not allowed"}');
          const err = await d.act(m);
          send(err ? 400 : 200, JSON.stringify(err ? { error: err } : { ok: true }));
        } catch (e: any) { send(500, JSON.stringify({ error: String(e?.message ?? e) })); }
      });
      return;
    }
    send(404, '{"error":"not found"}');
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '0.0.0.0', () => resolve(srv)); });
}

// Minimal service worker: only lets the page show notifications (Android browsers refuse `new Notification`) and focus/open the task on tap.
const SW = `self.addEventListener('notificationclick',e=>{e.notification.close();const u=e.notification.data||'/';
e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c){c.postMessage({open:u});return c.focus()}}return clients.openWindow(u)}))});`;

/** The link the Android app pairs with (also what the QR encodes). */
export const phoneLinkUrl = (host: string, port: number, code: string) => `http://${host}:${port}/?pair=${encodeURIComponent(code)}`;

/** QR code for the link as inline SVG. */
export function qrSvg(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const qr = require('qrcode-generator')(0, 'M');
  qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
