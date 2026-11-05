import { test } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import { startMobileServer, hostAllowed, MobileServer } from '../server';

function setup() {
  const sinks = new Set<(m: any) => void>(); const got: any[] = []; let events: any[] = [], last = 0;
  const opts = { media: __dirname + '/../../media', addSink: (s: any) => { sinks.add(s); return () => { sinks.delete(s); }; },
    onMessage: async (m: any) => { got.push(m); }, onConnect: () => { for (const s of sinks) s({ type: 'state', n: 1 }); },
    hubEvents: (n: number) => ({ last, events: events.filter((_, i) => i + 1 > n) }) };
  return { sinks, got, opts, addEvent: (e: any) => { events.push(e); last++; } };
}
const req = (port: number, method: string, path: string, headers: any = {}, body?: string) => new Promise<{ status: number; body: string }>((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode!, body: b })); });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const J = { 'content-type': 'application/json' };

test('routes, errors and host guard', async () => {
  const h = setup(); const s = await startMobileServer(0, h.opts, '127.0.0.1');
  try {
    assert.match((await req(s.port, 'GET', '/')).body, /shim\.js/);
    assert.match((await req(s.port, 'GET', '/shim.js')).body, /acquireVsCodeApi/);
    assert.equal((await req(s.port, 'GET', '/board.js')).status, 200);
    assert.equal((await req(s.port, 'GET', '/nope')).status, 404);
    assert.equal((await req(s.port, 'POST', '/msg', { 'content-type': 'text/plain' }, '{}')).status, 415);
    assert.equal((await req(s.port, 'POST', '/msg', J, 'nope')).status, 400);
    assert.equal((await req(s.port, 'POST', '/msg', J, '{"x":1}')).status, 400);
    assert.equal((await req(s.port, 'POST', '/msg', J, '{"type":"a"}')).status, 204);
    assert.deepEqual(h.got, [{ type: 'a' }]);
    assert.equal((await req(s.port, 'POST', '/msg', J, '{"type":"' + 'a'.repeat(1_100_000) + '"}').catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await req(s.port, 'GET', '/', { host: 'evil.example.com' })).status, 403);
    assert.equal((await req(s.port, 'GET', '/', { origin: 'http://evil.com' })).status, 403);
  } finally { await s.stop(); }
});

test('hostAllowed', () => {
  assert.ok(hostAllowed('192.168.1.5:7979', undefined)); assert.ok(hostAllowed('localhost:1', 'http://localhost:1'));
  assert.ok(!hostAllowed('foo.com', undefined)); assert.ok(!hostAllowed('1.2.3.4:1', 'http://5.6.7.8:1')); assert.ok(!hostAllowed(undefined, undefined));
});

test('SSE delivers state and missed dialogs; stop ends open streams and frees the sink', async () => {
  const h = setup(); h.addEvent({ type: 'dialog', id: 'd1' }); h.addEvent({ type: 'toast', text: 'old' });
  const s: MobileServer = await startMobileServer(0, h.opts, '127.0.0.1');
  let data = ''; let ended = false;
  await new Promise<void>(ok => http.get({ host: '127.0.0.1', port: s.port, path: '/events' }, r => { r.on('data', c => { data += c; if (data.includes('"state"')) ok(); }); r.on('end', () => { ended = true; }); r.on('close', () => { ended = true; }); }));
  assert.match(data, /"dialog"/); assert.doesNotMatch(data, /old/);
  assert.equal(h.sinks.size, 1);
  await s.stop();
  assert.equal(h.sinks.size, 0);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(ended);
  await assert.rejects(req(s.port, 'GET', '/'));
});
