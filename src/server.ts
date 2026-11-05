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
<script src="/shim.js"></script><script src="/board.js"></script></body></html>`;

export function startMobileServer(port: number, o: MobileOpts): Promise<http.Server> {
  const clients = new Set<http.ServerResponse>();
  const remove = o.addSink(m => { const d = `data: ${JSON.stringify(m)}\n\n`; for (const c of clients) c.write(d); });
  let since = 0;
  const poll = setInterval(() => {
    if (!clients.size) return;
    const r = o.hubEvents(since); since = r.last;
    for (const m of r.events) for (const c of clients) c.write(`data: ${JSON.stringify(m)}\n\n`);
  }, 500);
  const files: Record<string, [string, string]> = {
    '/board.css': ['board.css', 'text/css'], '/board.js': ['board.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
  };
  const server = http.createServer((req, res) => {
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
      if (!clients.size) since = o.hubEvents(0).last;
      clients.add(res);
      req.on('close', () => clients.delete(res));
      o.onConnect();
      return;
    }
    if (req.method === 'POST' && url === '/msg') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.statusCode = 415; res.end(); return; }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
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
  server.on('close', () => { clearInterval(poll); remove(); for (const c of clients) c.end(); clients.clear(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}
