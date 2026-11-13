import * as http from 'http';
import { timingSafeEqual, randomBytes, randomInt, createHash } from 'crypto';
import { PAGE } from './phonepage';

export interface PhoneDeps {
  token: string;
  state(): unknown;
  /** `via`: which credential sent it ("token …abcd" or "session …wxyz"), for the audit log. */
  act(m: Record<string, unknown>, via: string): Promise<string | void>;
  /** A pairing code was redeemed: a new phone session started. */
  paired?(via: string): void;
  /** Board messages relayed from a remote page; the host always handles them as remote. */
  board?(m: Record<string, unknown>): Promise<void>;
  events?(since: number): unknown;
  /** Changed files, review and checks of one task, for the phone detail view. */
  detail?(id: string): Promise<unknown>;
  /** Full read-only detail of one task in the current project (steps, files, review, checks, agents, cost, context); undefined for an unknown id. */
  task?(id: string): Promise<unknown | undefined>;
  /** Accept the permanent token in the URL (?t= / ?token=). Default true; the extension turns it off in favour of pairing codes. */
  allowTokenInUrl?: boolean;
  /** Paired devices (kept by the host, so they survive a restart). Default: in memory. */
  devices?: DeviceStore;
  /** How long a paired device stays signed in, in days (justCode.phoneTokenDays). Default 7. */
  tokenDays?: number;
}

// A paired phone: its token is a random id the phone keeps (cookie or x-token header); only its hash is stored.
export interface Device { id: string; hash: string; created: number; expires: number; lastUsed?: number }
export interface DeviceStore { list(): Device[]; save(list: Device[]): void }
export const memoryDevices = (): DeviceStore => { let l: Device[] = []; return { list: () => l, save: x => { l = x; } }; };
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
/** A new device token, valid `days`, added to the store. */
export function pairDevice(store: DeviceStore, days: number, now = Date.now()) {
  const token = randomBytes(24).toString('base64url');
  const d: Device = { id: randomBytes(4).toString('hex'), hash: hashOf(token), created: now, expires: now + days * 86400_000 };
  store.save([...store.list().filter(x => x.expires > now), d]);
  return { token, device: d };
}
/** The device this token belongs to, if it has not expired or been revoked. Marks it used (saved at most once a minute). */
export function deviceFor(store: DeviceStore, token: string, now = Date.now()) {
  if (!token) return undefined;
  const h = hashOf(token), list = store.list(), d = list.find(x => x.hash === h);
  if (!d || d.expires <= now) return undefined;
  if (!d.lastUsed || now - d.lastUsed > 60_000) store.save(list.map(x => x === d ? { ...x, lastUsed: now } : x));
  return d;
}

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
export async function phoneDetail(t: { worktree?: string; review?: { state: string; why?: string; issues?: { text: string; accepted?: boolean }[] }; checks?: { results?: { name: string; ok: boolean; tail?: string }[] } },
  diff: (dir: string) => Promise<PhoneDetail['files']>): Promise<PhoneDetail> {
  const out: PhoneDetail = { files: [], checks: (t.checks?.results ?? []).map(c => ({ name: c.name, ok: c.ok, tail: c.tail })) };
  if (t.review) out.review = { state: t.review.state, why: t.review.why, issues: (t.review.issues ?? []).filter(i => !i.accepted).map(i => i.text) };
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

// Pairing codes: 6 digits you can type, single-use and valid 10 minutes, so the link/QR never carries a long-lived
// token. Ten wrong codes cancel every open code, so guessing one is out of reach.
const PAIR_TTL_MS = 10 * 60_000, MAX_PAIR_FAILS = 10;
const pairCodes = new Map<string, number>();
let pairFails = 0;
export function issuePairingCode(ttlMs = PAIR_TTL_MS, now = Date.now()): string {
  for (const [c, exp] of pairCodes) if (exp <= now) pairCodes.delete(c);
  let code: string;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (pairCodes.has(code));
  pairCodes.set(code, now + ttlMs);
  return code;
}
/** Consumes the code: true only the first time, and only before it expires. */
export function redeemPairingCode(code: string, now = Date.now()): boolean {
  const exp = pairCodes.get(code); pairCodes.delete(code);
  const ok = !!code && exp !== undefined && exp > now;
  if (ok) pairFails = 0;
  else if (code && ++pairFails >= MAX_PAIR_FAILS) { pairCodes.clear(); pairFails = 0; }
  return ok;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startPhoneServer(port: number, d: PhoneDeps): Promise<http.Server> {
  // A cookie or x-token is a paired device's own token (revocable, expires after tokenDays), never the permanent token.
  const devices = d.devices ?? memoryDevices(), days = d.tokenDays ?? 7;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/sw.js') return send(200, SW, 'application/javascript');
    const hdr = String(req.headers['x-token'] ?? '');
    const q = d.allowTokenInUrl === false ? '' : url.searchParams.get('t') ?? url.searchParams.get('token') ?? '';
    const ckRaw = /(?:^|;\s*)jc_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const ck = (() => { try { return decodeURIComponent(ckRaw); } catch { return ''; } })();
    const startSession = () => {
      const { token, device } = pairDevice(devices, days);
      res.setHeader('set-cookie', `jc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${days * 86400}`);
      return { token, device };
    };
    // POST /pair {"code":"123456"}: a typed code becomes a device token (also set as the cookie). No other auth needed.
    if (url.pathname === '/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        let code = '';
        try { code = String(JSON.parse(body)?.code ?? '').trim(); } catch { /* bad body */ }
        if (!redeemPairingCode(code)) return send(401, '{"error":"wrong or expired code"}');
        const { token, device } = startSession();
        d.paired?.(`device …${device.id}`);
        send(200, JSON.stringify({ token, expires: device.expires }));
      });
      return;
    }
    const pair = url.searchParams.get('pair') ?? '';
    const paired = !!pair && redeemPairingCode(pair);
    const viaToken = [hdr, q].some(t => t && same(t, d.token));
    const device = !viaToken ? deviceFor(devices, hdr || ck) : undefined;
    if (!(paired || viaToken || device)) return url.pathname === '/' && req.method === 'GET' ? send(401, PAIR_PAGE, 'text/html') : send(401, '{"error":"bad token"}');
    let via = viaToken ? `token …${d.token.slice(-4)}` : device ? `device …${device.id}` : 'pairing code';
    // Redeeming a pairing code (or a token link) pairs a device: an HttpOnly cookie, so later requests need nothing in the URL.
    if (paired || (q && viaToken)) {
      const s = startSession();
      via = `device …${s.device.id}`;
      if (paired) d.paired?.(via);
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
          const err = await d.act(m, via);
          send(err ? 400 : 200, JSON.stringify(err ? { error: err } : { ok: true }));
        } catch (e: any) { send(500, JSON.stringify({ error: String(e?.message ?? e) })); }
      });
      return;
    }
    send(404, '{"error":"not found"}');
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '0.0.0.0', () => resolve(srv)); });
}

// Shown to a phone that is not paired (or whose pairing expired): type the 6-digit code from JustCode: Show Phone Pairing.
const PAIR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with JustCode</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
form{max-width:320px;width:100%;text-align:center}input{font-size:28px;letter-spacing:8px;text-align:center;width:100%;padding:10px;box-sizing:border-box;border-radius:8px;border:1px solid #555;background:#222;color:#eee}
button{margin-top:12px;width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#5b5bf0;color:#fff}p{color:#aaa}.e{color:#f77}</style></head>
<body><form id="f"><h2>Pair with JustCode</h2><p>On the computer run <b>JustCode: Show Phone Pairing</b> and type the 6-digit code.</p>
<input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><button>Pair</button><p id="m"></p></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const r=await fetch('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value})});
if(r.ok)location.replace('/');else{const m=document.getElementById('m');m.className='e';m.textContent='Wrong or expired code. Get a new one on the computer.'}}</script></body></html>`;

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
