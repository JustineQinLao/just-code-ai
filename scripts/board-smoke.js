// Board smoke test in a headless browser (Playwright MCP): loads media/*.js with a stubbed VS Code API and a state
// built from a board.json, opens every task tab and dialog, and prints what broke. No VS Code needed.
//   node scripts/board-smoke.js [path/to/board.json]     (default: this repo's .justcode/board.json)
const fs = require('fs'), os = require('os'), path = require('path');
const media = path.resolve(__dirname, '..', 'media');
const board = JSON.parse(fs.readFileSync(process.argv[2] || path.resolve(__dirname, '..', '.justcode', 'board.json'), 'utf8'));
for (const t of board.tasks) delete t.live;
const settings = { maxParallel: 1, taskModel: 'sonnet', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, superpowers: true, freshAfterTokens: 120000,
  checks: 'auto', setup: 'auto', maxCheckRounds: 2, checkTimeoutMinutes: 10, subagents: false, taskEffort: '', plannerEffort: '', plannerModel: 'opus', reviewEffort: 'medium',
  review: { auto: true, model: 'sonnet', effort: 'medium', lightModel: 'sonnet', triage: true, maxAttempts: 3, autoMerge: false, mergeIfCannotRun: true, commands: [], timeoutMinutes: 10 },
  notifications: 'actionable', defaultMode: 'auto', defaultWhere: 'auto', bypassAll: false, apiKey: false };
const state = { type: 'state', roots: [{ path: '/p', name: 'project', removable: false, running: 0, waiting: 0 }], root: '/p', board,
  setup: { checks: [{ id: 'claude', ok: true, label: 'Claude Code installed', detail: 'v2' }], ready: true, remote: true, at: 0 },
  project: { projectMd: true, designMd: false }, limit: {}, version: '0', queue: { queued: (board.queue || []).slice(0, 3) }, agents: [], skills: [], sources: [], registry: [],
  policy: { policy: { protectedPaths: [], denyTools: [], forbidModes: [], requireHumanReviewFor: [], maxCostUsd: { task: 5, sprint: 50, project: 500 }, allowedModels: [], requireChecksPass: true, secretScan: true }, errors: [], denials: [], file: '' },
  phone: { on: false, days: 7, devices: [] }, detectedChecks: [], settings, guideSeen: true, all: [] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-board-smoke-'));
const harness = path.join(dir, 'board.html'), shots = path.join(dir, 'shots');
fs.writeFileSync(harness, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${media}/board.css"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
<script>window.errs=[];window.posts=[];addEventListener('error',e=>errs.push(String(e.message)+' @'+e.filename+':'+e.lineno));
window.acquireVsCodeApi=()=>({postMessage:m=>posts.push(m),getState:()=>({}),setState:()=>{}});</script>
${['status', 'board', 'drawer', 'dialogs'].map(f => `<script src="file://${media}/${f}.js"></script>`).join('')}
<script>window.STATE=${JSON.stringify(state)};</script></body></html>`);
const { spawn } = require('child_process');
const p = spawn('npx', ['-y', '@playwright/mcp@0.0.85', '--headless', '--isolated', '--allow-unrestricted-file-access', '--output-dir', shots]);
let buf = '', id = 0; const waits = {};
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (waits[m.id]) waits[m.id](m); } catch {} } });
const call = (method, params) => new Promise(r => { const i = ++id; waits[i] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); return (r.result?.content ?? []).map(c => c.text).join('\n') || JSON.stringify(r.error); };
const EXERCISE = `async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.postMessage(window.STATE, '*'); await wait(300);
  const out = { cards: document.querySelectorAll('article.card').length };
  const S = window.STATE, stuck = S.board.tasks.find(t => t.review && t.review.state === 'fail') || S.board.tasks[0];
  const run = async (name, fn) => { try { await fn(); await wait(150); out[name] = (document.querySelector('#dlg').open ? document.querySelector('#dlg').innerText.length : document.querySelector('#drawer').innerText.length); } catch (e) { errs.push(name + ': ' + e.message); } };
  for (const tab of ['activity', 'changes', 'review', 'details', 'agents']) await run('task:' + tab, () => JC.openTask(stuck.id, tab));
  JC.closeTask && JC.closeTask();
  for (const d of ['settings', 'sourcesDialog', 'artifactsDialog', 'report', 'guide', 'designDialog', 'moreMenu', 'agentMap', 'newSprint']) await run(d, () => { document.querySelector('#dlg').open && document.querySelector('#dlg').close(); return JC[d](); });
  await run('history', () => { document.querySelector('#dlg').close(); JC.historyDialog(); window.postMessage({ type: 'history', items: [] }, '*'); });
  await run('planDialog', () => { document.querySelector('#dlg').close(); JC.planDialog([]); });
  document.querySelector('#dlg').open && document.querySelector('#dlg').close();
  out.stuckText = [...document.querySelectorAll('article.card')].find(a => a.innerText.includes(stuck.title.slice(0, 20)))?.innerText.slice(0, 300);
  out.toolbarButtons = [...document.querySelectorAll('#toolbar button')].map(b => b.innerText).join(' | ');
  out.banners = [...document.querySelectorAll('.banner')].map(b => b.innerText.slice(0, 80));
  out.errs = errs; out.posts = posts.map(m => m.type).slice(0, 30).join(',');
  return out;
}`;
(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drive', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await tool('browser_navigate', { url: 'file://' + harness });
  const res = await tool('browser_evaluate', { function: EXERCISE });
  const json = JSON.parse(/### Result\n([\s\S]*?)\n###/.exec(res + '\n###')[1]);
  console.log(JSON.stringify(json, null, 2));
  p.kill(); process.exit(json.errs.length ? 1 : 0);
})();
setTimeout(() => { console.log('timeout'); p.kill(); process.exit(1); }, 120000);
