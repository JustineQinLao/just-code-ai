// JustCode board webview. Host owns all state and processes; this file only renders and forwards clicks/keys.
const vscode = acquireVsCodeApi();
// Each message carries the project it was made in.
const send = m => vscode.postMessage({ root: S?.root, ...m });
const ui = Object.assign({ view: null, archived: false, guided: false }, vscode.getState() || {});
const images = []; // pasted into the add form: { name, data (data: URL) }
const save = () => vscode.setState(ui);
let termId = null; // task open in the modal
let view = 'term'; // modal shows the live terminal or the session log
let logTimer = null;
const openReview = new Set();
const changes = {}; // task id → changed files
const shots = {}; // task id → reviewer screenshots (data URLs)
const terms = new Map(); // task id → { term, fit, el }
let S = null;

const COLS = [['todo', 'To do'], ['doing', 'Doing'], ['review', 'Review'], ['done', 'Done']];
const MODES = { default: 'Ask me', acceptEdits: 'Auto-edit', plan: 'Plan only' };
const WHERE = { branch: 'Own branch (PR)', root: 'Project root' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const sprints = () => S.board.sprints.filter(s => !s.closed);
const sprintName = id => S.board.sprints.find(s => s.id === id)?.name;

/* ---------- layout (built once, so typing in the add bar survives re-renders) ---------- */

const app = document.getElementById('app');
app.innerHTML = `
  <div id="offline" class="banner" hidden>The board lost its connection to JustCode (usually after an update). Close this tab and run <b>JustCode: Open Board</b>, or reload the window.</div>
  <header><h1 id="name"></h1><span class="tabs row" id="roots"></span><span class="muted small" id="git"></span><span class="grow"></span><button id="settings">⚙ Settings</button><button id="guide">? Guide</button></header>
  <div class="row toolbar">
    <select id="view"></select>
    <button id="newSprint">+ Sprint</button>
    <button id="activate" hidden>Set active</button>
    <button id="closeSprint" hidden>Close sprint</button>
    <span class="grow"></span>
    <label class="muted small"><input type="checkbox" id="archived"> archived</label>
    <button id="setupClaude" title="Create the Claude setup (agents, skills, CLAUDE.md) and TASKS.md if missing, from docs/project.md, then sync the board. Runs by itself the first time a project that isn't set up is opened.">✦ Initialize</button>
    <button id="plan">✦ Plan with Claude</button>
    <button id="runAll" class="primary">▶ Run all</button>
  </div>
  <div class="addbar">
    <div class="row">
      <input id="title" class="grow" placeholder="New task — what should Claude do?  (Enter to add)">
      <select id="target" title="Backlog or sprint"></select>
      <select id="agent" title="Agent from .claude/agents"></select>
      <select id="mode" title="Permissions">${opts(Object.entries(MODES))}</select>
      <select id="where" title="Own branch: isolated copy, reviewed and merged. Project root: runs in the project folder itself (sync, deploy, release…)">${opts(Object.entries(WHERE))}</select>
      <button id="add" class="primary">Add</button>
    </div>
    <textarea id="desc" placeholder="Details, acceptance criteria (optional)" hidden></textarea>
    <div class="thumbs" id="thumbs"></div>
    <div class="row small muted"><a href="#" id="toggleDesc">+ details</a><span>· ⌘V / Ctrl+V pastes a screenshot</span><span class="skills" id="skills"></span></div>
  </div>
  <div class="board" id="board"></div>
  <dialog id="termdlg" class="termdlg">
    <div class="row"><span class="dot" id="tdot"></span><b id="ttitle" class="grow"></b>
      <span class="seg"><button id="vterm">Terminal</button><button id="vlog">Log</button></span>
      <span id="tactions" class="actions"></span><button id="tclose" title="Close (the session keeps running)">✕</button></div>
    <div class="term" id="tslot"></div>
    <div class="log" id="tlog" hidden></div>
    <div class="msgbar row" id="msgbar"><input id="msg" class="grow" placeholder="Message Claude… (Enter to send)" autocomplete="off">
      <button id="msgsend" class="primary">Send</button><button id="msgesc" title="Interrupt Claude (sends Esc)">Esc</button></div>
  </dialog>`;
const $ = id => document.getElementById(id);

$('toggleDesc').onclick = e => { e.preventDefault(); $('desc').hidden = !$('desc').hidden; if (!$('desc').hidden) $('desc').focus(); };
$('view').onchange = () => { ui.view = $('view').value; save(); render(); };
$('archived').onchange = () => { ui.archived = $('archived').checked; save(); render(); };
$('newSprint').onclick = () => sprintDialog();
$('activate').onclick = () => send({ type: 'activateSprint', sprintId: ui.view });
$('closeSprint').onclick = () => send({ type: 'closeSprint', sprintId: ui.view });
$('plan').onclick = () => planDialog();
$('setupClaude').onclick = () => send({ type: 'setupClaude' });
$('runAll').onclick = () => {
  if (S.board.tasks.some(t => t.queued)) return send({ type: 'cancelQueue' });
  send({ type: 'runAll', ids: visible().filter(t => t.status === 'todo').map(t => t.id) });
};
const add = () => {
  // Only details filled (e.g. a skill): its first line becomes the title.
  let title = $('title').value.trim(), description = $('desc').value.trim();
  if (!title && description) [title, description] = [description.split('\n')[0], description.split('\n').slice(1).join('\n').trim()];
  if (!title) return $('title').focus();
  // A bare /skill is usually a project-wide command, so it runs in the project root unless you chose otherwise.
  const where = $('where').dataset.touched ? $('where').value : (title.startsWith('/') ? 'root' : 'branch');
  send({ type: 'addTask', title, description, where, images: images.splice(0),  sprintId: $('target').value, agent: $('agent').value, mode: $('mode').value });
  $('title').value = ''; $('desc').value = ''; renderThumbs(); $('title').focus();
};
$('add').onclick = add;
$('guide').onclick = () => guide();
$('settings').onclick = () => settingsDialog();

// Screenshots pasted anywhere in the add form are attached to the next task.
function renderThumbs() {
  $('thumbs').innerHTML = '';
  images.forEach((img, i) => {
    const t = h(`<span class="thumb"><img src="${img.data}" alt=""><button title="Remove">×</button></span>`);
    t.querySelector('button').onclick = () => { images.splice(i, 1); renderThumbs(); };
    $('thumbs').append(t);
  });
}
document.querySelector('.addbar').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    const r = new FileReader();
    r.onload = () => { images.push({ name: f.name || 'screenshot.png', data: r.result }); renderThumbs(); };
    r.readAsDataURL(f);
  }
});
$('title').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) add(); };

/* ---------- render ---------- */

function visible() {
  const v = ui.view;
  return S.board.tasks.filter(t => (ui.archived || !t.archived) && (v === 'all' || (v === 'backlog' ? !t.sprintId : t.sprintId === v)));
}

function render() {
  if (!S) return;
  renderRoots();
  document.querySelectorAll('.toolbar, .addbar').forEach(e => { e.hidden = !!S.empty; });
  if (S.empty) {
    $('name').textContent = 'No project';
    $('git').textContent = '';
    $('board').innerHTML = '<div class="empty">Add a project folder to start. Its board is kept in that folder (.justcode/board.json).</div>';
    return;
  }
  const live = sprints();
  if (!ui.view || (ui.view !== 'all' && ui.view !== 'backlog' && !live.some(s => s.id === ui.view))) ui.view = live.find(s => s.active)?.id ?? 'all';
  const name = S.roots.find(r => r.path === S.root)?.name;
  $('name').textContent = name;
  $('git').textContent = !S.git.repo ? 'no git yet — a local repo is created on first run' : `${S.git.branch} · ${S.git.remote ? 'remote linked' : 'local git'}`;
  $('view').innerHTML = opts([['all', 'All tasks'], ['backlog', 'Backlog'], ...live.map(s => [s.id, `Sprint: ${s.name}${s.active ? ' (active)' : ''}`])], ui.view);
  const inSprint = live.find(s => s.id === ui.view);
  $('activate').hidden = !inSprint || inSprint.active;
  $('closeSprint').hidden = !inSprint;
  $('archived').checked = ui.archived;
  $('setupClaude').disabled = S.board.tasks.some(t => t.init && t.live);
  const keep = (sel, list) => { const v = sel.value; sel.innerHTML = opts(list, v); if ([...sel.options].some(o => o.value === v)) sel.value = v; };
  keep($('target'), [['', 'Backlog'], ...live.map(s => [s.id, s.name])]);
  if (!$('target').dataset.touched && inSprint) $('target').value = inSprint.id;
  keep($('agent'), [['', 'No agent'], ...S.agents.map(a => [a.name, a.name])]);
  if (!$('mode').dataset.touched) $('mode').value = S.defaultMode;
  $('skills').innerHTML = S.skills.length ? 'skills: ' + S.skills.map(s => `<button class="chip btn" data-skill="${esc(s)}">/${esc(s)}</button>`).join('') : '';
  // Empty title: the skill becomes the task (Enter adds it). Otherwise it's added to the details.
  $('skills').querySelectorAll('[data-skill]').forEach(b => b.onclick = () => {
    if (!$('title').value.trim()) { $('title').value = `/${b.dataset.skill} `; $('title').focus(); return; }
    $('desc').hidden = false; $('desc').value += `${$('desc').value ? '\n' : ''}/${b.dataset.skill} `; $('desc').focus();
  });
  const todo = visible().filter(t => t.status === 'todo').length, queued = S.board.tasks.filter(t => t.queued).length;
  $('runAll').textContent = queued ? `■ Cancel queue (${queued})` : `▶ Run all (${todo})`;
  $('runAll').disabled = !queued && !todo;
  renderBoard();
}

function renderRoots() {
  $('roots').innerHTML = '';
  for (const r of S.roots) {
    const b = h(`<span class="proj ${r.path === S.root ? 'on' : ''}" title="${esc(r.path)}"><button class="pick">${esc(r.name)}${r.running ? ` <span class="chip">${r.running}▶</span>` : ''}${r.waiting ? ` <span class="chip warn">${r.waiting}⚠</span>` : ''}</button>${r.removable ? '<button class="x" title="Remove project (files are kept)">×</button>' : ''}</span>`);
    b.querySelector('.pick').onclick = () => { if (r.path !== S.root) { ui.view = null; send({ type: 'root', root: r.path }); } };
    b.querySelector('.x')?.addEventListener('click', () => send({ type: 'removeProject', root: r.path }));
    $('roots').append(b);
  }
  const add = h('<button title="Add a project folder">+ Project</button>');
  add.onclick = () => send({ type: 'addProject' });
  $('roots').append(add);
}

function renderBoard() {
  const board = $('board');
  const tasks = visible();
  board.innerHTML = '';
  for (const [st, label] of COLS) {
    const list = tasks.filter(t => t.status === st);
    const col = h(`<div class="col" data-status="${st}"><h2><span>${label}</span><span class="row">${list.length ? '<button class="clear" title="Delete every task in this column">Clear</button>' : ''}<span>${list.length}</span></span></h2></div>`);
    col.querySelector('.clear')?.addEventListener('click', () => send({ type: 'clear', column: label, ids: list.map(t => t.id) }));
    if (!list.length) col.append(h('<div class="empty">Drop here</div>'));
    for (const t of list) col.append(card(t));
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/task'); if (id) send({ type: 'move', id, status: st }); };
    board.append(col);
  }
  renderTermHeader();
}

function card(t) {
  const conflict = t.conflicts?.length;
  const c = h(`<div class="card ${t.run === 'waiting' ? 'waiting' : ''} ${conflict ? 'conflict' : ''}" data-id="${t.id}">
    <div class="top" draggable="true">${t.run ? `<span class="dot ${t.run}" title="${t.run}"></span>` : ''}<span class="title">${esc(t.title)}</span></div>
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
    <div class="meta">${[
      ui.view === 'all' && t.sprintId && `<span class="chip">${esc(sprintName(t.sprintId))}</span>`,
      t.agent && `<span class="chip">@${esc(t.agent)}</span>`,
      t.images?.length && `<span class="chip">🖼 ${t.images.length}</span>`,
      t.mode !== 'default' && `<span class="chip">${MODES[t.mode]}</span>`,
      t.where === 'root' && '<span class="chip" title="Runs in the project folder, no branch">project root</span>',
      t.queued && '<span class="chip">queued</span>',
      t.run === 'running' && '<span class="chip">working…</span>',
      t.run === 'idle' && !t.review && '<span class="chip ok">turn done</span>',
      t.review?.state === 'running' && '<span class="chip">AI reviewing…</span>',
      t.review?.state === 'pass' && `<span class="chip ok">✓ review passed${t.review.risk === 'critical' ? ' · critical' : ''}</span>`,
      t.review?.state === 'fail' && `<span class="chip err">✗ review: ${t.review.issues?.length ?? 0} issue(s) · try ${t.review.attempts}</span>`,
      conflict && `<span class="chip err">${conflict} conflict${conflict > 1 ? 's' : ''}</span>`,
      t.branch && t.status !== 'done' && `<span class="chip" title="${esc(t.branch)} → ${esc(t.base)}">⎇ ${esc(t.base)}</span>`,
      t.pr && `<button class="chip btn" data-act="openUrl">PR ↗</button>`,
    ].filter(Boolean).join('')}</div>
    <div class="actions"></div></div>`);
  c.querySelector('.top').ondragstart = e => e.dataTransfer.setData('text/task', t.id);
  const act = c.querySelector('.actions');
  // Main actions have words; the rest are icons with tooltips.
  const btn = (label, fn, cls = '', title = '') => { const b = h(`<button class="${cls}" title="${esc(title)}">${label}</button>`); b.onclick = fn; b.disabled = t.busy; act.append(b); };
  const icon = (glyph, title, fn, cls = '') => btn(glyph, fn, `icon ${cls}`, title);

  if (t.status === 'todo' && !t.live) btn('▶ Run', () => runTask(t), 'primary');
  if (t.branch && (t.status === 'review' || t.status === 'doing') && !conflict) btn('✓ Merge', () => send({ type: 'merge', id: t.id }), 'primary', `Approve and merge ${t.branch} into ${t.base}`);
  if (!t.branch && t.status === 'review') btn('✓ Done', () => send({ type: 'move', id: t.id, status: 'done' }), 'primary');
  if (t.live) icon('⌨', 'Terminal', () => openTerm(t.id, 'term'), 'on');
  if (t.sessionId) icon('☰', 'Session log', () => openTerm(t.id, 'log'));
  if (!t.live && t.sessionId && t.status !== 'done') icon('↻', 'Resume the Claude session', () => runTask(t));
  if (t.live) icon('■', 'Stop', () => send({ type: 'stop', id: t.id }), 'danger');
  if (t.branch && (t.status === 'review' || t.status === 'doing')) {
    icon('⇄', 'Changes', () => {
      openReview.has(t.id) ? openReview.delete(t.id) : (openReview.add(t.id), send({ type: 'changes', id: t.id }));
      renderBoard();
    }, openReview.has(t.id) ? 'on' : '');
    if (S.git.remote && !t.pr) icon('⇪', 'Push the branch and open a GitHub PR (gh)', () => send({ type: 'remotePr', id: t.id }));
  }
  if (t.sessionId && t.status !== 'done') icon('✳', 'Open in Claude Code', () => send({ type: 'claudeCode', id: t.id }));
  if (t.status === 'todo') icon('✎', 'Edit', () => taskDialog(t));
  if (t.status === 'done' && !t.archived) icon('▣', 'Archive', () => send({ type: 'archive', id: t.id }));
  if (t.branch && t.status !== 'done') icon('↺', 'Discard this branch and its work', () => send({ type: 'discard', id: t.id }), 'danger');
  icon('🗑', 'Delete task', () => send({ type: 'delete', id: t.id }), 'danger');

  // Permission request, answered right on the card.
  if (t.run === 'waiting') {
    const a = t.ask ?? {};
    const p = h(`<div class="ask"><div><b>⚠ ${a.tool ? `Claude wants to use ${esc(a.tool)}` : esc(a.message || 'Claude needs your approval')}</b></div>
      ${a.detail ? `<code class="detail">${esc(a.detail)}</code>` : ''}
      <div class="actions"><button class="primary" data-c="allow">Allow</button><button data-c="always" title="Allow and don't ask again for this in the session">Always</button><button class="danger" data-c="deny">Deny</button><button class="icon" data-c="term" title="Answer in the terminal">⌨</button></div></div>`);
    p.querySelectorAll('[data-c]').forEach(b => b.onclick = () => b.dataset.c === 'term' ? openTerm(t.id) : send({ type: 'answer', id: t.id, choice: b.dataset.c }));
    c.querySelector('.meta').after(p);
  }
  c.querySelectorAll('[data-act="openUrl"]').forEach(b => b.onclick = () => send({ type: 'openUrl', url: t.pr }));

  if (t.review?.tested?.length && t.review.state !== 'running') c.append(h(`<div class="small muted tested">Reviewer ran: ${t.review.tested.map(x => `<code>${esc(x)}</code>`).join(' · ')}</div>`));
  if (t.review?.screenshots?.length) {
    const p = h(`<div class="panel"><div class="small muted">📷 ${t.review.screenshots.length} screenshot(s) from the reviewer</div><div class="thumbs shots"></div></div>`);
    const box = p.querySelector('.shots');
    const draw = imgs => imgs.forEach((img, i) => { const e = h(`<img src="${img.data}" title="${esc(img.name)}" alt="">`); e.onclick = () => send({ type: 'openShot', file: t.review.screenshots[i] }); box.append(e); });
    const k = t.id + (t.review.head ?? ""); if (shots[k]) draw(shots[k]); else send({ type: "shots", id: t.id, head: t.review.head });
    c.append(p);
  }
  if (t.review?.state === 'fail' && t.review.issues?.length && !t.live || (t.review?.state === 'fail' && t.status === 'review')) {
    const p = h(`<div class="panel"><div class="small">Reviewer issues:</div><ol class="issues">${t.review.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ol>
      <div class="actions"><button class="primary" data-a="fix">Send to Claude to fix</button><button data-a="again">Review again</button></div></div>`);
    p.querySelector('[data-a="fix"]').onclick = () => send({ type: 'sendIssues', id: t.id });
    p.querySelector('[data-a="again"]').onclick = () => send({ type: 'review', id: t.id });
    c.append(p);
  }
  if (t.branch && t.status === 'review' && !t.review && !t.live) icon('⚖', 'Run the AI review', () => send({ type: 'review', id: t.id }));
  if (conflict) {
    const p = h(`<div class="panel"><div class="small">Conflicts with <b>${esc(t.base)}</b> — fix them here, never in your checkout:</div><ul class="files"></ul>
      <div class="actions"><button data-a="resolve" class="primary">Resolve with Claude</button><button data-a="resolved">Mark resolved</button></div></div>`);
    for (const f of t.conflicts) { const li = h(`<li title="Open in editor"><span class="st D">!</span>${esc(f)}</li>`); li.onclick = () => send({ type: 'openFile', id: t.id, file: f }); p.querySelector('ul').append(li); }
    p.querySelector('[data-a="resolve"]').onclick = () => { send({ type: 'resolve', id: t.id }); openTerm(t.id); };
    p.querySelector('[data-a="resolved"]').onclick = () => send({ type: 'resolved', id: t.id });
    c.append(p);
  }
  if (openReview.has(t.id)) {
    const files = changes[t.id];
    const p = h(`<div class="panel"><div class="small muted">${files ? `${files.length} file(s) changed vs ${esc(t.base)} — click to diff` : 'Loading…'}</div><ul class="files"></ul></div>`);
    for (const f of files ?? []) { const li = h(`<li><span class="st ${esc(f.status)}">${esc(f.status)}</span>${esc(f.file)}</li>`); li.onclick = () => send({ type: 'diff', id: t.id, file: f.file }); p.querySelector('ul').append(li); }
    c.append(p);
  }
  return c;
}

/* ---------- terminal modal ---------- */

const termdlg = $('termdlg');
// Esc belongs to Claude (interrupt, cancel), so the modal only closes with ✕.
termdlg.addEventListener('cancel', e => e.preventDefault());
let boardDirty = false;
$('tclose').onclick = () => { termdlg.close(); termId = null; clearInterval(logTimer); if (boardDirty) { boardDirty = false; render(); } };
$('vterm').onclick = () => setView('term');
// A plain input under the terminal: always works, even if the terminal itself doesn't take focus.
const sendMsg = () => {
  const text = $('msg').value;
  if (!termId || !text.trim()) return;
  send({ type: 'say', id: termId, text });
  $('msg').value = '';
};
$('msgsend').onclick = () => { sendMsg(); $('msg').focus(); };
$('msg').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendMsg(); } };
$('msgesc').onclick = () => { if (termId) send({ type: 'input', id: termId, data: '\x1b' }); };
// Clicking the terminal, or the window regaining focus, puts the cursor back in it.
$('tslot').addEventListener('mousedown', () => { if (termId) setTimeout(() => terms.get(termId)?.term.focus(), 0); });
window.addEventListener('focus', () => { if (termdlg.open && view === 'term' && document.activeElement !== $('msg')) terms.get(termId)?.term.focus(); });
$('vlog').onclick = () => setView('log');

function setView(v) {
  view = v;
  $('tslot').hidden = v !== 'term';
  $('msgbar').hidden = v !== 'term';
  $('tlog').hidden = v !== 'log';
  $('vterm').classList.toggle('on', v === 'term');
  $('vlog').classList.toggle('on', v === 'log');
  clearInterval(logTimer);
  if (v === 'log') {
    send({ type: 'log', id: termId });
    logTimer = setInterval(() => { if (S?.board.tasks.find(x => x.id === termId)?.live) send({ type: 'log', id: termId }); }, 2000);
  } else if (termId) { mountTerm(termId, $('tslot')); terms.get(termId)?.term.focus(); }
}

function renderLog(steps) {
  const el = $('tlog'), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  const icon = { user: '›', say: '●', tool: '⏺', result: '⎿', error: '✗' };
  el.innerHTML = steps.length ? steps.map(s => `<div class="step ${s.kind}"><span class="ic">${icon[s.kind]}</span><span class="tx">${esc(s.text)}</span>${s.time ? `<span class="tm">${esc(new Date(s.time).toLocaleTimeString())}</span>` : ''}</div>`).join('')
    : '<div class="empty">No log yet. It appears once the session has started.</div>';
  if (atEnd) el.scrollTop = el.scrollHeight;
}

// Opens the modal and measures the terminal first, so the session starts at the size it is shown at.
function runTask(t) {
  terms.get(t.id)?.term.reset();
  openTerm(t.id, 'term');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { const e = terms.get(t.id); if (e) fitSafe(e); } catch { /* hidden */ }
    send({ type: 'run', id: t.id, size: termSize(t.id) });
  }));
}

// Opens on the terminal (☰ opens the log). An empty terminal of a session that isn't running falls back to the log.
function openTerm(id, v) {
  termId = id;
  if (!termdlg.open) termdlg.showModal();
  renderTermHeader();
  setView(v ?? 'term');
}

let headerKey = '';
function renderTermHeader() {
  const t = termId && S?.board.tasks.find(x => x.id === termId);
  if (!t || !termdlg.open) return;
  const key = [t.id, t.title, t.run, t.live, t.sessionId].join('|');
  if (key === headerKey) return; // unchanged: leave the DOM alone
  headerKey = key;
  $('ttitle').textContent = t.title;
  $('tdot').className = `dot ${t.run ?? ''}`;
  $('tactions').innerHTML = '';
  const b = (label, title, fn, cls = '') => { const e = h(`<button class="${cls}" title="${esc(title)}">${label}</button>`); e.onclick = fn; $('tactions').append(e); };
  if (t.sessionId) b('✳ Open in Claude Code', 'Continue this session in Claude Code (the run here stops first)', () => { termdlg.close(); termId = null; clearInterval(logTimer); send({ type: 'claudeCode', id: t.id }); if (boardDirty) { boardDirty = false; render(); } });
  if (t.live) b('■ Stop', 'Stop the session', () => send({ type: 'stop', id: t.id }), 'danger');
  else b(t.sessionId ? '↻ Resume' : '▶ Run', t.sessionId ? 'Resume the Claude session' : 'Start the task', () => runTask(t), 'primary');
}

/* ---------- terminals ---------- */

function themeFromVscode() {
  const v = n => getComputedStyle(document.body).getPropertyValue(n).trim() || undefined;
  return { background: v('--vscode-terminal-background') ?? v('--vscode-editor-background'), foreground: v('--vscode-terminal-foreground') ?? v('--vscode-foreground'), cursor: v('--vscode-terminalCursor-foreground') };
}

function mountTerm(id, slot) {
  let e = terms.get(id);
  if (!e) {
    const el = document.createElement('div');
    el.className = 'term-host'; // pinned to the slot's inner box (CSS), so fit() measures the real visible area
    slot.prepend(el);
    const term = new Terminal({ fontSize: 12, fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family') || 'Menlo, monospace', cursorBlink: true, theme: themeFromVscode(), scrollback: 5000 });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Claude Code reads images from the clipboard on Ctrl+V; a ⌘V of an image has no text for xterm to paste.
    el.addEventListener('paste', e => {
      if ([...(e.clipboardData?.items ?? [])].some(i => i.type.startsWith('image/')) && !e.clipboardData.getData('text')) {
        e.preventDefault(); e.stopPropagation(); send({ type: 'input', id, data: '\x16' });
      }
    }, true);
    term.onData(data => send({ type: 'input', id, data }));
    term.onResize(() => sendSize(id));
    // Debounced: a burst of layout changes (modal opening, a scrollbar appearing) becomes one resize, not a redraw storm.
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (el.isConnected && el.clientWidth) try { fitSafe(e); } catch { /* hidden */ } }, 120); }).observe(el);
    e = { term, fit, el };
    terms.set(id, e);
    // The editor font can finish loading after the first fit; rows measured with the fallback font overflow by a line.
    document.fonts?.ready.then(() => refit(id));
    send({ type: 'attach', id });
  } else if (e.el.parentElement !== slot) slot.prepend(e.el);
  // Report the size once laid out: the pty may have started (at a guessed size) since the last fit.
  requestAnimationFrame(() => { try { fitSafe(e); } catch { /* hidden */ } sendSize(id, true); });
}

// Fits the terminal to its box, one row short of what fits: a rounding error in the measured cell height can
// otherwise leave the bottom line (Claude's input row) clipped.
function fitSafe(e) {
  const d = e.fit.proposeDimensions?.();
  if (!d) return e.fit.fit();
  const cols = Math.max(20, d.cols), rows = Math.max(5, d.rows - 1);
  if (e.term.cols !== cols || e.term.rows !== rows) e.term.resize(cols, rows);
}

// Fits the terminal to its box again and keeps the newest line in view.
function refit(id) {
  const e = terms.get(id);
  if (!e || !e.el.isConnected || !e.el.clientHeight) return;
  try { fitSafe(e); } catch { /* hidden */ }
  e.term.scrollToBottom?.();
  sendSize(id);
}

// Sends the terminal's size to its pty, only when it changed (each resize makes Claude redraw the whole screen).
const sentSize = {};
function sendSize(id, force) {
  const e = terms.get(id);
  if (!e || !e.term.cols || !e.term.rows) return;
  const key = `${e.term.cols}x${e.term.rows}`;
  if (!force && sentSize[id] === key) return;
  sentSize[id] = key;
  send({ type: 'resize', id, cols: e.term.cols, rows: e.term.rows });
}

// Size of the terminal a run will be shown in, so Claude's first frame already fits.
function termSize(id) {
  const e = terms.get(id);
  return e ? { cols: e.term.cols, rows: e.term.rows } : undefined;
}

/* ---------- dialogs ---------- */

const dlg = $('dlg');
function dialog(html, onSubmit) {
  dlg.innerHTML = `<form method="dialog">${html}<div class="row end"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">OK</button></div></form>`;
  const form = dlg.querySelector('form');
  form.onsubmit = e => {
    if (e.submitter?.value !== 'ok') return;
    const data = Object.fromEntries(new FormData(form));
    if (onSubmit(data) === false) e.preventDefault();
  };
  dlg.showModal();
  dlg.querySelector('input,textarea')?.focus();
}

function sprintDialog() {
  dialog(`<h3>New sprint</h3><label>Name<input name="name" required placeholder="Sprint ${S.board.sprints.length + 1}"></label>
    <label>Goal (optional)<textarea name="goal"></textarea></label>`, d => send({ type: 'addSprint', name: d.name.trim(), goal: d.goal.trim() }));
}

function taskDialog(t) {
  dialog(`<h3>Edit task</h3><label>Title<input name="title" required value="${esc(t.title)}"></label>
    <label>Details<textarea name="description">${esc(t.description)}</textarea></label>
    <div class="row"><label>Sprint<select name="sprintId">${opts([['', 'Backlog'], ...sprints().map(s => [s.id, s.name])], t.sprintId ?? '')}</select></label>
    <label>Agent<select name="agent">${opts([['', 'No agent'], ...S.agents.map(a => [a.name, a.name])], t.agent ?? '')}</select></label>
    <label>Permissions<select name="mode">${opts(Object.entries(MODES), t.mode)}</select></label>
    <label>Runs in<select name="where">${opts(Object.entries(WHERE), t.where ?? 'branch')}</select></label></div>`,
  d => send({ type: 'editTask', id: t.id, patch: { title: d.title.trim(), description: d.description.trim() || undefined, sprintId: d.sprintId || undefined, agent: d.agent || undefined, mode: d.mode, where: d.where === 'root' ? 'root' : undefined } }));
}

const MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['', 'Claude default']];
function settingsDialog() {
  const v = S.settings;
  const model = (name, cur) => `<select name="${name}">${opts([...MODELS, ...(MODELS.some(([m]) => m === cur) ? [] : [[cur, cur]])], cur)}</select>`;
  dialog(`<h3>Settings</h3>
    <label>Planner model (Plan with Claude)${model('plannerModel', v.plannerModel)}</label>
    <label>Task model (running tasks, resolving conflicts)${model('taskModel', v.taskModel)}</label>
    <label>Run all: tasks at once<input name="maxParallel" type="number" min="1" max="6" value="${v.maxParallel}"></label>
    <label>Default permissions for new tasks<select name="defaultMode">${opts(Object.entries(MODES), v.defaultMode)}</select></label>
    <label>AI review model${model('reviewModel', v.reviewModel)}</label>
    <label><span><input type="checkbox" name="autoReview" ${v.autoReview ? 'checked' : ''}> AI review after each finished turn (issues go back to Claude to fix)</span></label>
    <label>Review attempts before stopping<input name="maxReviews" type="number" min="1" max="10" value="${v.maxReviews}"></label>
    <label><span><input type="checkbox" name="autoMerge" ${v.autoMerge ? 'checked' : ''}> Merge automatically when the review passes</span></label>
    <div class="small muted">Applies to new runs. An agent with its own <code>model:</code> may use that instead.</div>`,
  d => send({ type: 'settings', values: { plannerModel: d.plannerModel, taskModel: d.taskModel, maxParallel: Math.min(6, Math.max(1, +d.maxParallel || 1)), defaultMode: d.defaultMode,
    reviewModel: d.reviewModel, autoReview: !!d.autoReview, maxReviews: Math.max(1, +d.maxReviews || 3), autoMerge: !!d.autoMerge } }));
}

function planDialog() {
  const planner = S.agents.find(a => /plan|architect|orchestrat|lead/i.test(a.name))?.name ?? '';
  const inSprint = sprints().find(s => s.id === ui.view);
  dialog(`<h3>Plan with Claude</h3>
    <label>Goal<textarea name="goal" required placeholder="e.g. Add login with email + password, sessions, and a logout button"></textarea></label>
    <div class="row">
      <label>Planner agent<select name="agent">${opts([['', 'Claude (default)'], ...S.agents.map(a => [a.name, a.name])], planner)}</select></label>
      <label>Put tasks in<select name="sprintId">${opts([['', 'Backlog'], ['__new', 'New sprint…'], ...sprints().map(s => [s.id, s.name])], inSprint?.id ?? '')}</select></label>
    </div>
    <label>New sprint name (if "New sprint")<input name="newSprint" placeholder="Sprint ${S.board.sprints.length + 1}"></label>
    <div class="row">
      <label>Task agent<select name="taskAgent">${opts([['', 'No agent'], ...S.agents.map(a => [a.name, a.name])], '')}</select></label>
      <label>Permissions<select name="mode">${opts(Object.entries(MODES), S.defaultMode)}</select></label>
    </div>
    <div class="small muted">Claude reads the code read-only, then you pick which tasks to add.</div>`,
  d => {
    const isNew = d.sprintId === '__new';
    send({ type: 'plan', goal: d.goal.trim(), agent: d.agent, sprintId: isNew ? '' : d.sprintId, newSprint: isNew ? (d.newSprint.trim() || `Sprint ${S.board.sprints.length + 1}`) : '', taskAgent: d.taskAgent, mode: d.mode });
  });
}

$('target').onchange = () => { $('target').dataset.touched = '1'; };
$('mode').onchange = () => { $('mode').dataset.touched = '1'; };
$('where').onchange = () => { $('where').dataset.touched = '1'; };

/* ---------- host messages ---------- */

function guide() {
  dlg.innerHTML = `<h3>How JustCode works</h3>
    <ol class="guide">
      <li><b>Add a task.</b> Type what Claude should do and press Enter. Optional: a sprint, an agent from <code>.claude/agents</code>, permissions, details, a pasted screenshot (⌘V). Click a skill chip to make a task like <code>/sync-project</code>.</li>
      <li><b>Sprints (optional).</b> <b>+ Sprint</b> creates one. Pick it in the view menu; new tasks go there. <b>Close sprint</b> sends unfinished tasks back to the backlog.</li>
      <li><b>Plan with Claude.</b> Describe a goal. Claude reads the code (read-only) and proposes tasks. You pick which to add.</li>
      <li><b>Run.</b> <b>▶ Run</b> on a card, or <b>▶ Run all</b> for every To do task in view. The card opens a terminal with the live Claude session. Type there and approve prompts there. A yellow card means Claude is waiting for you.</li>
      <li><b>Review.</b> When Claude finishes, its changes are committed on the task's own branch and the card moves to Review. <b>▸ Changes</b> shows the diff. Keep chatting in the terminal to change things.</li>
      <li><b>Merge.</b> <b>✓ Merge</b> asks you first, then merges into your branch. Conflicts stay on the card, never in your files: <b>Resolve with Claude</b> or fix them in the editor, then <b>Mark resolved</b> and merge again. <b>Discard</b> throws the work away.</li>
    </ol>
    <p class="small muted">Each task runs in <code>.justcode/worktrees/</code> on its own branch, so your checkout is never touched. No git yet? A local repo is created on the first run. Closing the board never stops a run; closing the window does, and <b>↻ Resume</b> continues it.</p>
    <form method="dialog" class="row end"><button class="primary">Got it</button></form>`;
  dlg.showModal();
  ui.guided = true; save();
}

// No state shortly after loading = nothing on the other end of postMessage.
let connected = false;
setTimeout(() => { if (!connected) $('offline').hidden = false; }, 4000);

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'state') {
    S = m;
    // With the modal open only its header updates; redrawing the board under it on every tool call made it flicker.
    if (termdlg.open && !S.empty) { boardDirty = true; renderTermHeader(); } else render();
    if (!connected) { connected = true; $('offline').hidden = true; if (!ui.guided && !S.empty) guide(); }
  }
  else if (m.type === 'data') terms.get(m.id)?.term.write(m.data);
  // Snapshot of the current screen, drawn while hidden so opening a terminal never shows it being rebuilt.
  else if (m.type === 'replay') {
    const e = terms.get(m.id);
    // opacity, not visibility: a hidden element can't hold keyboard focus.
    if (e) { e.el.style.opacity = '0'; e.term.reset(); e.term.write(m.data, () => { e.el.style.opacity = ''; refit(m.id); if (m.id === termId && view === 'term' && document.activeElement !== $('msg')) e.term.focus(); }); }
    const t = S?.board.tasks.find(x => x.id === m.id);
    if (!m.data && m.id === termId && view === 'term' && t && !t.live && t.sessionId) setView('log');
  }
  else if (m.type === 'log') { if (m.id === termId && view === 'log') renderLog(m.steps); }
  else if (m.type === "shots") { shots[m.id + (m.head ?? "")] = m.images; if (!termdlg.open) renderBoard(); }
  else if (m.type === 'changes') { changes[m.id] = m.files; renderBoard(); }
  else if (m.type === 'focus') {
    const t = S?.board.tasks.find(x => x.id === m.id);
    if (t && !visible().includes(t)) { ui.view = 'all'; render(); }
    openTerm(m.id);
  }
});
send({ type: 'ready' });
