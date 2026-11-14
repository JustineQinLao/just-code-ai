// Board smoke test in a headless browser (Playwright MCP): loads media/*.js with a stubbed VS Code API and a state
// built from a board.json, opens every task tab and dialog, and prints what broke. No VS Code needed.
//   node scripts/board-smoke.js [path/to/board.json]     (default: this repo's .justcode/board.json)
//   node scripts/board-smoke.js --shots <dir> [board.json]   also saves 1280x900 PNGs of the board, task tabs, planner and dialogs into <dir>
const fs = require('fs'), os = require('os'), path = require('path');
const media = path.resolve(__dirname, '..', 'media');
const argv = process.argv.slice(2), si = argv.indexOf('--shots');
const shotsDir = si >= 0 ? path.resolve(argv[si + 1] || (console.error('--shots needs a directory'), process.exit(2))) : '';
if (si >= 0) argv.splice(si, 2);
// A task's copy of the repo has no .justcode/board.json: then a small built-in board with one task in each state.
const SAMPLE = { sprints: [{ id: 's1', name: 'Sprint 1', active: true }], tasks: [
  { id: 't1', title: 'Ready task', status: 'todo', mode: 'auto', sprintId: 's1', created: 1 },
  { id: 't2', title: 'Stuck review', status: 'review', mode: 'auto', sprintId: 's1', created: 2, worktree: '/w', branch: 'jc/x', base: 'main',
    review: { state: 'fail', attempts: 3, issues: [{ text: 'src/a.ts bug', key: 'k1', rounds: 3 }, { text: 'missing test', key: 'k2', rounds: 1 }] } },
  { id: 't3', title: 'Passed review', status: 'review', mode: 'auto', sprintId: 's1', created: 3, worktree: '/w', review: { state: 'pass', attempts: 1 } },
  { id: 't4', title: 'Quick answer', status: 'review', mode: 'auto', where: 'direct', quick: true, created: 4, reply: 'It is in src/queue.ts.' },
  { id: 't5', title: 'Merged task', status: 'done', mode: 'auto', sprintId: 's1', created: 5 },
] };
const file = argv[0] || path.resolve(__dirname, '..', '.justcode', 'board.json');
const board = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : SAMPLE;
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
const harness = path.join(dir, 'board.html'), shots = shotsDir || path.join(dir, 'shots');
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
fs.writeFileSync(harness, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${media}/board.css"></head>
<body><div id="app"></div><div id="drawer"></div><dialog id="dlg"></dialog>
<script>window.errs=[];window.posts=[];addEventListener('error',e=>errs.push(String(e.message)+' @'+e.filename+':'+e.lineno));
window.acquireVsCodeApi=()=>({postMessage:m=>posts.push(m),getState:()=>({}),setState:()=>{}});</script>
${['status', 'board', 'composer', 'drawer', 'dialogs'].map(f => `<script src="file://${media}/${f}.js"></script>`).join('')}
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
  // Setup checklist: auto-opens when setup is not ready, counts required rows, splits Required / Recommended, redraws on state, keeps scroll.
  try {
    const dlg = document.querySelector('#dlg'); dlg.open && dlg.close();
    const ck = (id, ok, optional) => ({ id, ok, optional, label: id, detail: 'd', fix: ok ? undefined : { label: 'Fix ' + id, action: id } });
    const bad = { ...S, setup: { ready: false, remote: false, at: 0, checks: [ck('a', true), ck('b', false), ck('repo', true, true), ck('r1', false, true)] } };
    window.postMessage(bad, '*'); await wait(250);
    const txt = dlg.innerText;
    if (!dlg.open || dlg.dataset.kind !== 'setup') errs.push('setup dialog did not auto-open');
    else {
      if (!txt.includes('Get set up · 2 of 3')) errs.push('setup count: ' + txt.slice(0, 60));
      if (!(txt.indexOf('RECOMMENDED') > txt.indexOf('b') && txt.indexOf('r1') > txt.indexOf('RECOMMENDED'))) errs.push('setup groups');
      if (![...dlg.querySelectorAll('button')].some(b => b.innerText === 'Fix b' && b.classList.contains('primary'))) errs.push('required fix not primary');
      if (![...dlg.querySelectorAll('button')].some(b => b.innerText === 'Fix r1' && !b.classList.contains('primary'))) errs.push('recommended fix is primary');
      window.postMessage({ ...bad, setup: { ...bad.setup, checks: bad.setup.checks.map(c => c.id === 'b' ? { ...c, ok: true } : c) } }, '*'); await wait(250);
      if (!dlg.innerText.includes('Get set up · 3 of 3')) errs.push('setup did not redraw on state');
    }
    dlg.close(); window.postMessage(S, '*'); await wait(150);
  } catch (e) { errs.push('setup dialog: ' + e.message); }
  document.querySelector('#dlg').open && document.querySelector('#dlg').close();
  // The new-task box: Details toggles, Quick and Add each post addTask with the typed title.
  try {
    const btnOf = t => [...document.querySelectorAll('#composer .box button')].find(b => b.innerText.includes(t)), title = document.querySelector('#title');
    posts.length = 0; const was = !document.querySelector('#more').hidden; btnOf('Details').click(); out.detailsOpen = was && document.querySelector('#more').hidden; btnOf('Details').click(); out.detailsOpen = out.detailsOpen && !document.querySelector('#more').hidden;
    title.value = 'smoke quick'; btnOf('Quick').click(); title.value = 'smoke add'; btnOf('Add').click();
    const adds = posts.filter(m => m.type === 'addTask'); out.addTask = adds.map(m => m.title + (m.quick ? ':quick' : '')).join(',');
    if (out.detailsOpen !== true || out.addTask !== 'smoke quick:quick,smoke add') errs.push('composer: ' + JSON.stringify([out.detailsOpen, out.addTask]));
  } catch (e) { errs.push('composer: ' + e.message); }
  out.stuckText = [...document.querySelectorAll('article.card')].find(a => a.innerText.includes(stuck.title.slice(0, 20)))?.innerText.slice(0, 300);
  out.toolbarButtons = [...document.querySelectorAll('#toolbar button')].map(b => b.innerText).join(' | ');
  try { // toolbar order and the actions moved into ⋯ must stay reachable
    const order = ['✦ Plan', '📎 Sources', '⧉ Artifacts', '🎨 Design', '▶ Run all'], got = out.toolbarButtons.split(' | ');
    const idx = order.map(o => got.findIndex(g => g.startsWith(o)));
    if (idx.some((i, k) => i < 0 || (k && i < idx[k - 1]))) errs.push('toolbar order: ' + out.toolbarButtons);
    [...document.querySelectorAll('#toolbar button')].pop().click();
    out.moreItems = [...document.querySelectorAll('#dlg .menuitem b')].map(b => b.innerText).join(' | ');
    for (const l of ['+ Sprint', 'Agent map', 'Report', 'Prompt history']) if (!out.moreItems.includes(l)) errs.push('⋯ menu lacks ' + l);
    document.querySelector('#dlg').close();
  } catch (e) { errs.push('toolbar: ' + e.message); }
  // Asks (only when the board has them): each button posts the same message as before.
  try {
    const kinds = { tool: ['Allow', 'allow'], question: ['Answer', 'allow'], plan: ['Build it', 'allow'] };
    for (const t of S.board.tasks) for (const a of t.asks || []) {
      const [label, choice] = kinds[a.kind] || kinds.tool;
      JC.openTask(t.id, 'activity'); await wait(150);
      const box = [...document.querySelectorAll('#drawer .ask')].find(b => b.innerText.includes(label));
      if (!box) { errs.push('ask box missing: ' + a.kind); continue; }
      if (a.kind === 'question') {
        // Option, then the empty Other row: the old option must not be submitted.
        box.querySelector('.opt input').click(); box.querySelector('.other-row input').click();
        posts.length = 0; [...box.querySelectorAll('button')].find(b => b.innerText.startsWith(label)).click(); await wait(50);
        if (posts.some(x => x.type === 'answer')) errs.push('question posted a stale option after Other was selected');
        const oi = box.querySelector('input.other'); oi.value = 'stale'; oi.dispatchEvent(new Event('input', { bubbles: true }));
        box.querySelector('.opt input').click(); // picking an option after typing in Other must win
      }
      posts.length = 0; [...box.querySelectorAll('button')].find(b => b.innerText.startsWith(label)).click(); await wait(50);
      const m = posts.find(x => x.type === 'answer');
      if (!m || m.id !== t.id || m.ask !== a.id || m.choice !== choice) errs.push('ask ' + a.kind + ' posted ' + JSON.stringify(posts));
      if (a.kind === 'question' && (!m?.answers || Object.values(m.answers).some(v => v === 'stale' || !v))) errs.push('question answer wrong: ' + JSON.stringify(m?.answers));
    }
  } catch (e) { errs.push('asks: ' + e.message); }
  // Settings sections in design order, phone buttons, and the pairing dialog (on and off).
  try {
    window.postMessage({ ...S, phone: { on: true, days: 7, devices: [{ id: 'ab12', created: 1, lastUsed: 0, expires: Date.now() + 1e9 }] } }, '*'); await wait(200);
    const d = document.querySelector('#dlg'); d.open && d.close(); JC.settings(); await wait(100);
    const txt = d.innerText.toLowerCase(), at = k => txt.indexOf(k.toLowerCase());
    const order = ['Permissions for new tasks', 'Policy', 'Open policy.json', 'Export audit log', 'Phone · 1 paired', 'Revoke', 'Pair a phone', 'Setup checklist', 'Save'].map(at);
    if (order.some((i, k) => i < 0 || (k && i < order[k - 1]))) errs.push('settings sections/order: ' + JSON.stringify(order));
    out.settingsOrder = order.join(',');
    posts.length = 0; [...d.querySelectorAll('button')].find(b => b.innerText.startsWith('Pair a phone')).click();
    if (!posts.some(m => m.type === 'phonePairing')) errs.push('Pair a phone posts no phonePairing');
    d.close(); JC.pairingDialog({ on: true, code: '482913', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>', url: 'http://192.168.1.20:7878', fingerprint: '3A:91:C4' }); await wait(100);
    const pt = d.innerText;
    for (const l of ['Pair a phone', 'Pairing code', '482 913', 'One use, valid 10 minutes', '3A:91:C4', 'New code', 'Unpair all devices']) if (!pt.includes(l)) errs.push('pairing lacks ' + l);
    posts.length = 0; [...d.querySelectorAll('button')].find(b => b.innerText === 'New code').click(); [...d.querySelectorAll('button')].find(b => b.innerText === 'Unpair all devices').click();
    if (posts.map(m => m.type).join() !== 'phonePairing,phoneUnpair') errs.push('pairing buttons post ' + posts.map(m => m.type));
    d.close(); out.toasts = document.querySelectorAll('.toast').length; JC.pairingDialog({ on: false }); await wait(100);
    if (d.open) errs.push('pairing dialog opened with the server off');
    if (!document.body.innerText.includes('phoneServer')) errs.push('server-off toast missing');
  } catch (e) { errs.push('pairing: ' + e.message); }
  out.banners = [...document.querySelectorAll('.banner')].map(b => b.innerText.slice(0, 80));
  out.errs = errs; out.posts = posts.map(m => m.type).slice(0, 30).join(',');
  return out;
}`;
// Opens each view in turn and saves a screenshot named <name>.png into the shots dir.
async function takeShots(json) {
  const views = [['board', 'JC.closeTask && JC.closeTask()'],
    ...['activity', 'changes', 'review', 'details'].map(t => ['task-' + t, `JC.openTask(STATE.board.tasks.find(t => t.review && t.review.state === 'fail')?.id ?? STATE.board.tasks[0].id, '${t}')`]),
    ['planner', 'JC.openPlanner()'],
    ...[['settings', 'settings'], ['sources', 'sourcesDialog'], ['artifacts', 'artifactsDialog'], ['design', 'designDialog'], ['report', 'report'], ['history', 'historyDialog'], ['agentMap', 'agentMap'], ['newSprint', 'newSprint']].map(([n, fn]) => [n, `JC.${fn}()`])];
  await tool('browser_resize', { width: 1280, height: 900 });
  for (const [name, open] of views) {
    const code = `async () => { const d = document.querySelector('#dlg'); if (d.open) d.close(); ${name.startsWith('task-') || name === 'planner' || name === 'board' ? '' : 'JC.closeTask && JC.closeTask();'} ${open}; if (${name === 'history'}) window.postMessage({ type: 'history', items: [] }, '*'); await new Promise(r => setTimeout(r, 300)); return 1; }`;
    const r = await tool('browser_evaluate', { function: code });
    if (/### Error/.test(r)) json.errs.push('shot ' + name + ': ' + r.slice(0, 200));
    await tool('browser_take_screenshot', { type: 'png', filename: path.join(shotsDir, name + '.png') });
    if (!fs.existsSync(path.join(shotsDir, name + '.png'))) json.errs.push('missing shot ' + name + '.png');
  }
}
(async () => {
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drive', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await tool('browser_navigate', { url: 'file://' + harness });
  const res = await tool('browser_evaluate', { function: EXERCISE });
  const json = JSON.parse(/### Result\n([\s\S]*?)\n###/.exec(res + '\n###')[1]);
  if (shotsDir) await takeShots(json);
  console.log(JSON.stringify(json, null, 2));
  p.kill(); process.exit(json.errs.length ? 1 : 0);
})();
setTimeout(() => { console.log('timeout'); p.kill(); process.exit(1); }, 120000);
