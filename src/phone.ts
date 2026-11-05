import * as http from 'http';
import { timingSafeEqual } from 'crypto';

export interface PhoneDeps {
  token: string;
  state(): unknown;
  act(m: Record<string, unknown>): Promise<string | void>;
  /** Board messages relayed from a remote page; the host always handles them as remote. */
  board?(m: Record<string, unknown>): Promise<void>;
  events?(since: number): unknown;
}

// Actions a phone may send. Anything else is refused, so a leaked token cannot open files, change settings, etc.
// Board messages a remote page may relay: answers to dialogs, and merge (which the host checks and confirms). Nothing else.
export const BOARD_ACTIONS = ['dialogReply', 'merge'] as const;

export const PHONE_ACTIONS = ['addTask', 'run', 'stop', 'answer', 'merge', 'selectProject', 'move'] as const;
/** Why a phone may not move a task to `status` (an error string), or undefined if allowed. Pure so it can be tested. */
export function phoneMoveError(t: { status: string; worktree?: string; busy?: boolean; asks?: unknown[] }, status: unknown): string | undefined {
  if (typeof status !== 'string' || !['todo', 'doing', 'review'].includes(status)) return 'a task cannot be moved to Done from the phone (merge it instead)';
  if (t.busy || (t.asks?.length ?? 0) > 0) return 'this task is running or waiting for an answer; stop it first';
  if (t.status === 'done') return 'a done task cannot be moved from the phone';
  if (status === 'todo' && t.worktree) return 'this task has work on its branch; discard it on the desktop to start over';
  return undefined;
}
/** A project path the phone may select: a string that is one of the known roots. */
export const phoneProjectOk = (path: unknown, roots: string[]) => typeof path === 'string' && roots.includes(path);
export const PHONE_COLUMNS = ['todo', 'doing', 'review', 'done'] as const;

// One rule for showing the Merge button and for accepting a phone merge; never looser than the board's bulk merge.
export const canPhoneMerge = (t: { worktree?: string; where?: string; status: string; review?: { state?: string; risk?: string } }) =>
  !!t.worktree && t.where !== 'root' && t.status === 'review' && t.review?.state === 'pass' && t.review?.risk !== 'critical';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startPhoneServer(port: number, d: PhoneDeps): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/sw.js') return send(200, SW, 'application/javascript');
    const hdr = String(req.headers['x-token'] ?? '');
    const q = url.searchParams.get('t') ?? url.searchParams.get('token') ?? '';
    const ck = /(?:^|;\s*)jc_token=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const ok = [hdr, q, (() => { try { return decodeURIComponent(ck); } catch { return ''; } })()].some(t => t && same(t, d.token));
    if (!ok) return send(401, '{"error":"bad token"}');
    // A valid link sets an HttpOnly cookie so later requests from the page need no token in the URL.
    if (q && same(q, d.token)) res.setHeader('set-cookie', `jc_token=${encodeURIComponent(d.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    if (url.pathname === '/') return send(200, PAGE, 'text/html');
    if (url.pathname === '/api/state' && req.method === 'GET') return send(200, JSON.stringify(d.state()));
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustCode</title><style>
body{font:15px system-ui;margin:0;background:#111;color:#eee}header{padding:12px;background:#222;font-weight:600}
.c{margin:10px;padding:10px;background:#1c1c1c;border-radius:8px}.s{opacity:.7;font-size:12px}
button{font:inherit;padding:8px 12px;margin:4px 4px 0 0;border:0;border-radius:6px;background:#3b82f6;color:#fff}
button.n{background:#444}input{box-sizing:border-box;font:inherit;padding:8px;width:calc(100% - 20px);margin:10px}
.a{border:1px solid #f59e0b;padding:8px;margin-top:8px;border-radius:6px;word-break:break-all}
</style></head><body><header>JustCode</header>
<input id="t" placeholder="Token (from VS Code: JustCode: Show Phone Pairing)"><input id="n" placeholder="New task title">
<dialog id="dg" style="background:#222;color:#eee;border:1px solid #555;border-radius:8px;max-width:90vw"></dialog><button id="add" style="margin-left:10px">Add + run</button><div id="st" class="s" style="margin:0 12px"></div><div id="nt" class="s" style="margin:4px 12px"></div><div id="pj" class="s" style="margin:8px 12px"></div><div id="tabs" class="tabs" style="margin:0 10px"></div><div id="l"></div>
<script>
const $=id=>document.getElementById(id);$('t').value=localStorage.tok||new URLSearchParams(location.search).get('token')||'';
const H=()=>({'x-token':$('t').value,'content-type':'application/json'});
async function act(m){const r=await fetch('/api/act',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
async function board(m){const r=await fetch('/api/board',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
let evN=0,shown=new Set();
function showDialog(m){if(shown.has(m.id))return;shown.add(m.id);const d=$('dg');let done=false;
const fin=x=>{if(done)return;done=true;board(Object.assign({type:'dialogReply',id:m.id},x));d.close()};
d.textContent='';d.append(el('b',{},m.title),el('p',{},m.text||''));
for(const b of m.buttons||['OK'])d.append(el('button',{onclick:()=>fin({button:b})},b));
d.append(el('button',{className:'n',onclick:()=>fin({cancelled:true})},'Cancel'));
d.onclose=()=>fin({cancelled:true});if(!d.open)d.showModal()}
async function poll(){try{const r=await fetch('/api/events?since='+evN,{headers:H()});if(r.ok){const j=await r.json();if(j.last<evN){evN=0;return poll()}evN=j.last;for(const e of j.events)if(e.type==='dialog')showDialog(e);else if(e.type==='toast')alert(e.text)}}catch(e){}}
function el(t,p,...k){const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e}
let col='todo',fails=0,timer,seen=new Set(),first=true,busy=false;
function sched(){clearTimeout(timer);timer=setTimeout(load,Math.min(3000*2**fails,30000))}
function focusTask(id){const e=$('task-'+id);if(e){e.scrollIntoView();e.style.outline='2px solid #f59e0b'}}
async function notify(t,a){if(!window.Notification||Notification.permission!=='granted')return;
const o={body:a.tool+': '+a.detail,tag:'ask-'+a.id,data:'/?task='+t.id};
try{const reg=navigator.serviceWorker&&await navigator.serviceWorker.ready;if(reg)return reg.showNotification(t.title+' needs approval',o);new Notification(t.title+' needs approval',o).onclick=()=>{focus();focusTask(t.id)}}catch(e){}}
async function load(){if(busy)return;busy=true;clearTimeout(timer);localStorage.tok=$('t').value;
try{const r=await fetch('/api/state',{headers:H()});const l=$('l');
if(!r.ok){fails=0;$('st').textContent='';l.textContent='';l.append(el('div',{className:'c'},'Not paired: '+r.status));return}
const data=await r.json();fails=0;$('st').textContent='';l.textContent='';
const pj=$('pj');pj.textContent='Project: ';for(const r of data.roots||[])pj.append(el('button',{className:r===data.root?'':'n',onclick:()=>act({type:'selectProject',path:r})},r.split(/[\\/]/).pop()));
const tb=$('tabs');tb.textContent='';for(const k of ['todo','doing','review','done'])tb.append(el('button',{className:k===col?'':'n',onclick:()=>{col=k;load()}},k+' ('+data.tasks.filter(t=>t.status===k).length+')'+(data.tasks.some(t=>t.status===k&&t.asks.length)?' !':'')));
for(const t of data.tasks.filter(t=>t.status===col||t.asks.length)){const c=el('div',{className:'c',id:'task-'+t.id},el('b',{},t.title),el('div',{className:'s'},t.status+(t.review?' · review '+t.review:'')));
if(t.status==='todo')c.append(el('button',{onclick:()=>act({type:'run',id:t.id})},'Run'));
if(t.busy)c.append(el('button',{className:'n',onclick:()=>act({type:'stop',id:t.id})},'Stop'));
for(const a of t.asks){const d=el('div',{className:'a'},a.tool+': '+a.detail,el('br'));
if(a.kind==='permission'){d.append(el('button',{onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'allow'})},'Approve'),el('button',{className:'n',onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'deny'})},'Deny'))}else d.append(el('i',{},'Answer this one in VS Code'));c.append(d)}
if(!t.busy&&!t.asks.length)for(const k of ['todo','doing','review'])if(k!==t.status&&t.status!=='done')c.append(el('button',{className:'n',onclick:()=>act({type:'move',id:t.id,status:k})},'Move to '+k));
if(t.canMerge)c.append(el('button',{onclick:()=>board({type:'merge',id:t.id})},'Merge'));l.append(c)}
for(const t of data.tasks)for(const a of t.asks)if(a.kind==='permission'&&!seen.has(a.id)){seen.add(a.id);if(!first)notify(t,a)}
first=false;const w=new URLSearchParams(location.search).get('task');if(w)focusTask(w);notifState()}
catch(e){fails++;$('st').textContent='Offline, retrying in '+Math.min(3000*2**fails,30000)/1000+'s'}
finally{busy=false;sched()}}
const reload=()=>{fails=0;load()};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)reload()});addEventListener('online',reload);addEventListener('focus',reload);
if(navigator.connection)navigator.connection.addEventListener('change',reload);
if(navigator.serviceWorker){navigator.serviceWorker.register('/sw.js').catch(()=>{});navigator.serviceWorker.addEventListener('message',e=>{const w=new URL(e.data.open,location.href).searchParams.get('task');if(w)focusTask(w)})}
function notifState(){const n=$('nt');n.textContent='';
if(!window.Notification||!navigator.serviceWorker||!window.isSecureContext){n.textContent='Approval notifications unavailable here (needs https or localhost); this page still updates while open.';return}
if(Notification.permission==='default')n.append(el('button',{className:'n',onclick:()=>Notification.requestPermission().then(notifState)},'Enable approval notifications'));
else if(Notification.permission==='denied')n.textContent='Notifications are blocked in browser settings.'}
$('add').onclick=()=>{if($('n').value){act({type:'addTask',title:$('n').value,start:true});$('n').value=''}};
load();if(typeof setInterval==='function')setInterval(poll,2000);
</script></body></html>`;

/** The link the Android app pairs with (also what the QR encodes). */
export const phoneLinkUrl = (host: string, port: number, token: string) => `http://${host}:${port}/?token=${encodeURIComponent(token)}`;

/** QR code for the link as inline SVG. */
export function qrSvg(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const qr = require('qrcode-generator')(0, 'M');
  qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
