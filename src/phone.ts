import * as http from 'http';
import { timingSafeEqual } from 'crypto';

export interface PhoneDeps {
  token: string;
  state(): unknown;
  act(m: Record<string, unknown>): Promise<string | void>;
}

// Actions a phone may send. Anything else is refused, so a leaked token cannot open files, change settings, etc.
export const PHONE_ACTIONS = ['addTask', 'run', 'stop', 'answer', 'merge'] as const;

// One rule for showing the Merge button and for accepting a phone merge; never looser than the board's bulk merge.
export const canPhoneMerge = (t: { worktree?: string; where?: string; status: string; review?: { state?: string; risk?: string } }) =>
  !!t.worktree && t.where !== 'root' && t.status === 'review' && t.review?.state === 'pass' && t.review?.risk !== 'critical';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startPhoneServer(port: number, d: PhoneDeps): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/') return send(200, PAGE, 'text/html');
    if (url.pathname === '/sw.js') return send(200, SW, 'application/javascript');
    const tok = String(req.headers['x-token'] ?? url.searchParams.get('token') ?? '');
    if (!same(tok, d.token)) return send(401, '{"error":"bad token"}');
    if (url.pathname === '/api/state' && req.method === 'GET') return send(200, JSON.stringify(d.state()));
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
<button id="add" style="margin-left:10px">Add + run</button><div id="st" class="s" style="margin:0 12px"></div><div id="nt" class="s" style="margin:4px 12px"></div><div id="l"></div>
<script>
const $=id=>document.getElementById(id);$('t').value=localStorage.tok||new URLSearchParams(location.search).get('token')||'';
const H=()=>({'x-token':$('t').value,'content-type':'application/json'});
async function act(m){const r=await fetch('/api/act',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
function el(t,p,...k){const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e}
let fails=0,timer,seen=new Set(),first=true,busy=false;
function sched(){clearTimeout(timer);timer=setTimeout(load,Math.min(3000*2**fails,30000))}
function focusTask(id){const e=$('task-'+id);if(e){e.scrollIntoView();e.style.outline='2px solid #f59e0b'}}
async function notify(t,a){if(!window.Notification||Notification.permission!=='granted')return;
const o={body:a.tool+': '+a.detail,tag:'ask-'+a.id,data:'/?task='+t.id};
try{const reg=navigator.serviceWorker&&await navigator.serviceWorker.ready;if(reg)return reg.showNotification(t.title+' needs approval',o);new Notification(t.title+' needs approval',o).onclick=()=>{focus();focusTask(t.id)}}catch(e){}}
async function load(){if(busy)return;busy=true;clearTimeout(timer);localStorage.tok=$('t').value;
try{const r=await fetch('/api/state',{headers:H()});const l=$('l');
if(!r.ok){fails=0;$('st').textContent='';l.textContent='';l.append(el('div',{className:'c'},'Not paired: '+r.status));return}
const data=await r.json();fails=0;$('st').textContent='';l.textContent='';
for(const t of data.tasks){const c=el('div',{className:'c',id:'task-'+t.id},el('b',{},t.title),el('div',{className:'s'},t.status+(t.review?' · review '+t.review:'')));
if(t.status==='todo')c.append(el('button',{onclick:()=>act({type:'run',id:t.id})},'Run'));
if(t.busy)c.append(el('button',{className:'n',onclick:()=>act({type:'stop',id:t.id})},'Stop'));
for(const a of t.asks){const d=el('div',{className:'a'},a.tool+': '+a.detail,el('br'));
if(a.kind==='permission'){d.append(el('button',{onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'allow'})},'Approve'),el('button',{className:'n',onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'deny'})},'Deny'))}else d.append(el('i',{},'Answer this one in VS Code'));c.append(d)}
if(t.canMerge)c.append(el('button',{onclick:()=>confirm('Merge '+t.title+'?')&&act({type:'merge',id:t.id})},'Merge'));l.append(c);
for(const a of t.asks)if(a.kind==='permission'&&!seen.has(a.id)){seen.add(a.id);if(!first)notify(t,a)}}
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
load();
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
