import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// Opt-in LAN server (justCode.mobile.enabled): serves the board page and bridges it to the host over SSE + fetch.
// There is no token: anyone on the network can drive the board, so it is off unless the user turns it on.
export interface MobileOpts {
  media: string;                              // directory holding board.css / board.js
  addSink(sink: (m: any) => void): () => void; // receives everything post() emits
  onMessage(m: any): Promise<void>;           // feeds handle()
  onConnect(): void;                          // ask the host to re-send state
  hubEvents(since: number): { last: number; events: any[] };
}

export const SHIM = `(function(){var q=[],st;var es=new EventSource('/events');
es.onmessage=function(e){try{window.dispatchEvent(new MessageEvent('message',{data:JSON.parse(e.data)}))}catch(_){}};
window.acquireVsCodeApi=function(){return{postMessage:function(m){fetch('/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m)}).catch(function(){})},getState:function(){return st},setState:function(s){st=s}}};})();`;

export const page = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/board.css"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
<script src="/shim.js"></script><script src="/status.js"></script><script src="/board.js"></script><script src="/drawer.js"></script><script src="/dialogs.js"></script></body></html>`;

export interface MobileServer { port: number; stop(): Promise<void> }

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|localhost)$/i;
const hostOf = (h: string) => h.replace(/:\d+$/, '');
// DNS-rebinding guard: the Host must be an IP literal or localhost, and any Origin must be that same host.
export function hostAllowed(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !IP_LITERAL.test(hostOf(host))) return false;
  if (origin) { try { if (new URL(origin).host !== host) return false; } catch { return false; } }
  return true;
}

export function startMobileServer(port: number, o: MobileOpts, bindHost = '0.0.0.0'): Promise<MobileServer> {
  const clients = new Map<http.ServerResponse, { since: number }>();
  const send = (c: http.ServerResponse, m: any) => { if (!c.destroyed) c.write(`data: ${JSON.stringify(m)}\n\n`); };
  const remove = o.addSink(m => { for (const c of clients.keys()) send(c, m); });
  let tick = 0;
  const poll = setInterval(() => {
    if (!clients.size) return;
    if (++tick % 30 === 0) for (const c of clients.keys()) if (!c.destroyed) c.write(': ping\n\n'); // keepalive (every ~15s)
    for (const [c, st] of clients) {
      const r = o.hubEvents(st.since); st.since = r.last;
      for (const m of r.events) send(c, m);
    }
  }, 500);
  const files: Record<string, [string, string]> = {
    '/board.css': ['board.css', 'text/css'], '/board.js': ['board.js', 'text/javascript'], '/status.js': ['status.js', 'text/javascript'], '/drawer.js': ['drawer.js', 'text/javascript'], '/dialogs.js': ['dialogs.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
  };
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, req.headers.origin)) { res.statusCode = 403; res.end(); return; }
    const url = (req.url ?? '/').split('?')[0];
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && url === '/') { res.setHeader('content-type', 'text/html'); res.end(page()); return; }
    if (req.method === 'GET' && url === '/shim.js') { res.setHeader('content-type', 'text/javascript'); res.end(SHIM); return; }
    if (req.method === 'GET' && files[url]) {
      fs.readFile(path.join(o.media, files[url][0]), (e, b) => { if (e) { res.statusCode = 404; res.end(); return; } res.setHeader('content-type', files[url][1]); res.end(b); });
      return;
    }
    if (req.method === 'GET' && url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      res.on('error', () => clients.delete(res));
      // Hub events (toast/copy/open) are not scoped per client: they reach every connected client, so one client is the supported case.
      const snap = o.hubEvents(0);
      clients.set(res, { since: snap.last });
      for (const m of snap.events) if (m && m.type === 'dialog') send(res, m); // pending dialogs this client missed
      req.on('close', () => clients.delete(res));
      o.onConnect();
      return;
    }
    if (req.method === 'POST' && url === '/msg') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.statusCode = 415; res.end(); return; }
      let body = '', big = false;
      req.on('data', c => { if (big) return; body += c; if (body.length > 1_000_000) { big = true; res.statusCode = 413; res.end(); req.destroy(); } });
      req.on('end', () => {
        if (big) return;
        let m: any;
        try { m = JSON.parse(body); } catch { res.statusCode = 400; res.end(); return; }
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') { res.statusCode = 400; res.end(); return; }
        o.onMessage(m).catch(() => {});
        res.statusCode = 204; res.end();
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= new Promise<void>(resolve => {
    clearInterval(poll); remove();
    for (const c of clients.keys()) c.end();
    clients.clear();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return new Promise((resolve, reject) => {
    server.once('error', e => { clearInterval(poll); remove(); reject(e); });
    server.listen(port, bindHost, () => resolve({ port: (server.address() as any).port, stop }));
  });
}
