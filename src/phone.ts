import * as http from 'http';
import { timingSafeEqual } from 'crypto';

export interface PhoneDeps {
  token: string;
  state(): unknown;
  act(m: Record<string, unknown>): Promise<string | void>;
}

// Actions a phone may send. Anything else is refused, so a leaked token cannot open files, change settings, etc.
export const PHONE_ACTIONS = ['addTask', 'run', 'stop', 'answer', 'merge'] as const;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startPhoneServer(port: number, d: PhoneDeps): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (url.pathname === '/') return send(200, PAGE, 'text/html');
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustCode</title><style>
body{font:15px system-ui;margin:0;background:#111;color:#eee}header{padding:12px;background:#222;font-weight:600}
.c{margin:10px;padding:10px;background:#1c1c1c;border-radius:8px}.s{opacity:.7;font-size:12px}
button{font:inherit;padding:8px 12px;margin:4px 4px 0 0;border:0;border-radius:6px;background:#3b82f6;color:#fff}
button.n{background:#444}input{box-sizing:border-box;font:inherit;padding:8px;width:calc(100% - 20px);margin:10px}
.a{border:1px solid #f59e0b;padding:8px;margin-top:8px;border-radius:6px;word-break:break-all}
</style></head><body><header>JustCode</header>
<input id="t" placeholder="Token (from VS Code: JustCode: Show Phone Pairing)"><input id="n" placeholder="New task title">
<button id="add" style="margin-left:10px">Add + run</button><div id="l"></div>
<script>
const $=id=>document.getElementById(id);$('t').value=localStorage.tok||new URLSearchParams(location.search).get('token')||'';
const H=()=>({'x-token':$('t').value,'content-type':'application/json'});
async function act(m){const r=await fetch('/api/act',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
function el(t,p,...k){const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e}
async function load(){localStorage.tok=$('t').value;const r=await fetch('/api/state',{headers:H()});const l=$('l');l.textContent='';
if(!r.ok){l.append(el('div',{className:'c'},'Not paired: '+r.status));return}
for(const t of (await r.json()).tasks){const c=el('div',{className:'c',id:'task-'+t.id},el('b',{},t.title),el('div',{className:'s'},t.status+(t.review?' · review '+t.review:'')));
if(t.status==='todo')c.append(el('button',{onclick:()=>act({type:'run',id:t.id})},'Run'));
if(t.busy)c.append(el('button',{className:'n',onclick:()=>act({type:'stop',id:t.id})},'Stop'));
for(const a of t.asks){const d=el('div',{className:'a'},a.tool+': '+a.detail,el('br'));
if(a.kind==='permission'){d.append(el('button',{onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'allow'})},'Approve'),el('button',{className:'n',onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'deny'})},'Deny'))}else d.append(el('i',{},'Answer this one in VS Code'));c.append(d)}
if(t.canMerge)c.append(el('button',{onclick:()=>confirm('Merge '+t.title+'?')&&act({type:'merge',id:t.id})},'Merge'));l.append(c)}}
$('add').onclick=()=>{if($('n').value){act({type:'addTask',title:$('n').value,start:true});$('n').value=''}};
load();setInterval(load,3000);
</script></body></html>`;
