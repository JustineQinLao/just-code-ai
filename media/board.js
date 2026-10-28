// JustCode board webview. Host owns all state and processes; this file only renders and forwards clicks/keys.
const vscode = acquireVsCodeApi();
const send = m => vscode.postMessage(m);
const ui = Object.assign({ view: null, archived: false, open: [], guided: false }, vscode.getState() || {});
const images = []; // pasted into the add form: { name, data (data: URL) }
const save = () => vscode.setState(ui);
const openTerms = new Set(ui.open); // cards with their terminal shown
const openReview = new Set();
const changes = {}; // task id → changed files
const terms = new Map(); // task id → { term, fit, el }
let S = null;

const COLS = [['todo', 'To do'], ['doing', 'Doing'], ['review', 'Review'], ['done', 'Done']];
const MODES = { default: 'Ask me', acceptEdits: 'Auto-edit', plan: 'Plan only' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const sprints = () => S.board.sprints.filter(s => !s.closed);
const sprintName = id => S.board.sprints.find(s => s.id === id)?.name;

/* ---------- layout (built once, so typing in the add bar survives re-renders) ---------- */

const app = document.getElementById('app');
app.innerHTML = `
  <div id="offline" class="banner" hidden>The board lost its connection to JustCode (usually after an update). Close this tab and run <b>JustCode: Open Board</b>, or reload the window.</div>
  <header><h1 id="name"></h1><span class="tabs row" id="roots"></span><span class="muted small" id="git"></span><span class="grow"></span><button id="guide">? Guide</button></header>
  <div class="row toolbar">
    <select id="view"></select>
    <button id="newSprint">+ Sprint</button>
    <button id="activate" hidden>Set active</button>
    <button id="closeSprint" hidden>Close sprint</button>
    <span class="grow"></span>
    <label class="muted small"><input type="checkbox" id="archived"> archived</label>
    <button id="plan">✦ Plan with Claude</button>
    <button id="runAll" class="primary">▶ Run all</button>
  </div>
  <div class="addbar">
    <div class="row">
      <input id="title" class="grow" placeholder="New task — what should Claude do?  (Enter to add)">
      <select id="target" title="Backlog or sprint"></select>
      <select id="agent" title="Agent from .claude/agents"></select>
      <select id="mode" title="Permissions">${opts(Object.entries(MODES))}</select>
      <button id="add" class="primary">Add</button>
    </div>
    <textarea id="desc" placeholder="Details, acceptance criteria (optional)" hidden></textarea>
    <div class="thumbs" id="thumbs"></div>
    <div class="row small muted"><a href="#" id="toggleDesc">+ details</a><span>· ⌘V / Ctrl+V pastes a screenshot</span><span class="skills" id="skills"></span></div>
  </div>
  <div class="board" id="board"></div>`;
const $ = id => document.getElementById(id);

$('toggleDesc').onclick = e => { e.preventDefault(); $('desc').hidden = !$('desc').hidden; if (!$('desc').hidden) $('desc').focus(); };
$('view').onchange = () => { ui.view = $('view').value; save(); render(); };
$('archived').onchange = () => { ui.archived = $('archived').checked; save(); render(); };
$('newSprint').onclick = () => sprintDialog();
$('activate').onclick = () => send({ type: 'activateSprint', sprintId: ui.view });
$('closeSprint').onclick = () => send({ type: 'closeSprint', sprintId: ui.view });
$('plan').onclick = () => planDialog();
$('runAll').onclick = () => {
  if (S.board.tasks.some(t => t.queued)) return send({ type: 'cancelQueue' });
  send({ type: 'runAll', ids: visible().filter(t => t.status === 'todo').map(t => t.id) });
};
const add = () => {
  // Only details filled (e.g. a skill): its first line becomes the title.
  let title = $('title').value.trim(), description = $('desc').value.trim();
  if (!title && description) [title, description] = [description.split('\n')[0], description.split('\n').slice(1).join('\n').trim()];
  if (!title) return $('title').focus();
  send({ type: 'addTask', title, description, images: images.splice(0),  sprintId: $('target').value, agent: $('agent').value, mode: $('mode').value });
  $('title').value = ''; $('desc').value = ''; renderThumbs(); $('title').focus();
};
$('add').onclick = add;
$('guide').onclick = () => guide();

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
  if (S.empty) { app.innerHTML = '<p class="muted">Open a folder to start. JustCode keeps its board in that folder (.justcode/board.json).</p>'; return; }
  const live = sprints();
  if (!ui.view || (ui.view !== 'all' && ui.view !== 'backlog' && !live.some(s => s.id === ui.view))) ui.view = live.find(s => s.active)?.id ?? 'all';
  const name = S.roots.find(r => r.path === S.root)?.name;
  $('name').textContent = name;
  $('roots').innerHTML = S.roots.length > 1 ? S.roots.map(r => `<button data-root="${esc(r.path)}" class="${r.path === S.root ? 'on' : ''}">${esc(r.name)}</button>`).join('') : '';
  $('roots').querySelectorAll('button').forEach(b => b.onclick = () => send({ type: 'root', root: b.dataset.root }));
  $('git').textContent = !S.git.repo ? 'no git yet — a local repo is created on first run' : `${S.git.branch} · ${S.git.remote ? 'remote linked' : 'local git'}`;
  $('view').innerHTML = opts([['all', 'All tasks'], ['backlog', 'Backlog'], ...live.map(s => [s.id, `Sprint: ${s.name}${s.active ? ' (active)' : ''}`])], ui.view);
  const inSprint = live.find(s => s.id === ui.view);
  $('activate').hidden = !inSprint || inSprint.active;
  $('closeSprint').hidden = !inSprint;
  $('archived').checked = ui.archived;
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

function renderBoard() {
  const board = $('board');
  const tasks = visible();
  board.innerHTML = '';
  for (const [st, label] of COLS) {
    const list = tasks.filter(t => t.status === st);
    const col = h(`<div class="col" data-status="${st}"><h2><span>${label}</span><span>${list.length}</span></h2></div>`);
    if (list.some(t => openTerms.has(t.id))) col.classList.add('wide');
    if (!list.length) col.append(h('<div class="empty">Drop here</div>'));
    for (const t of list) col.append(card(t));
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/task'); if (id) send({ type: 'move', id, status: st }); };
    board.append(col);
  }
  // Re-home terminals into their new cards (xterm instances outlive re-renders).
  for (const id of openTerms) {
    const slot = board.querySelector(`.term[data-id="${id}"]`);
    if (slot) mountTerm(id, slot);
  }
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
      t.queued && '<span class="chip">queued</span>',
      t.run === 'waiting' && '<span class="chip warn">needs approval</span>',
      t.run === 'running' && '<span class="chip">working…</span>',
      t.run === 'idle' && '<span class="chip ok">turn done</span>',
      conflict && `<span class="chip err">${conflict} conflict${conflict > 1 ? 's' : ''}</span>`,
      t.branch && t.status !== 'done' && `<span class="chip" title="${esc(t.branch)} → ${esc(t.base)}">⎇ ${esc(t.base)}</span>`,
      t.pr && `<button class="chip btn" data-act="openUrl">PR ↗</button>`,
    ].filter(Boolean).join('')}</div>
    <div class="actions"></div></div>`);
  c.querySelector('.top').ondragstart = e => e.dataTransfer.setData('text/task', t.id);
  const act = c.querySelector('.actions');
  const btn = (label, fn, cls = '', title = '') => { const b = h(`<button class="${cls}" title="${esc(title)}">${label}</button>`); b.onclick = fn; b.disabled = t.busy; act.append(b); };
  const toggleTerm = () => { openTerms.has(t.id) ? openTerms.delete(t.id) : openTerms.add(t.id); ui.open = [...openTerms]; save(); renderBoard(); };
  const run = () => { terms.get(t.id)?.term.reset(); openTerms.add(t.id); ui.open = [...openTerms]; save(); renderBoard(); send({ type: 'run', id: t.id, size: termSize(t.id) }); };

  if (t.status === 'todo' && !t.live) btn('▶ Run', run, 'primary');
  if (t.live) btn(openTerms.has(t.id) ? '▾ Hide terminal' : (t.run === 'waiting' ? '⚠ Approve…' : '▸ Terminal'), toggleTerm, t.run === 'waiting' ? 'primary' : '');
  else if (t.sessionId && t.status !== 'done') btn('↻ Resume', run, '', 'Continue this task\'s Claude session in the card');
  if (t.live) btn('■ Stop', () => send({ type: 'stop', id: t.id }), 'danger');
  if (t.sessionId && S.claudeExt && t.status !== 'done') btn('Claude Code', () => send({ type: 'claudeCode', id: t.id }), '', 'Open this session in the Claude Code extension');

  if (t.branch && (t.status === 'review' || t.status === 'doing')) {
    btn(openReview.has(t.id) ? '▾ Changes' : '▸ Changes', () => {
      openReview.has(t.id) ? openReview.delete(t.id) : (openReview.add(t.id), send({ type: 'changes', id: t.id }));
      renderBoard();
    });
    if (!conflict) btn('✓ Merge', () => send({ type: 'merge', id: t.id }), 'primary', `Approve and merge ${t.branch} into ${t.base}`);
    if (S.git.remote && !t.pr) btn('Push PR', () => send({ type: 'remotePr', id: t.id }), '', 'Push the branch and open a GitHub PR (gh)');
    btn('Discard', () => send({ type: 'discard', id: t.id }), 'danger');
  }
  if (t.status === 'todo') btn('Edit', () => taskDialog(t));
  if (t.status === 'done' && !t.archived) btn('Archive', () => send({ type: 'archive', id: t.id }));
  btn('🗑', () => send({ type: 'delete', id: t.id }), 'danger', 'Delete task');
  c.querySelectorAll('[data-act="openUrl"]').forEach(b => b.onclick = () => send({ type: 'openUrl', url: t.pr }));

  if (conflict) {
    const p = h(`<div class="panel"><div class="small">Conflicts with <b>${esc(t.base)}</b> — fix them here, never in your checkout:</div><ul class="files"></ul>
      <div class="actions"><button data-a="resolve" class="primary">Resolve with Claude</button><button data-a="resolved">Mark resolved</button></div></div>`);
    for (const f of t.conflicts) { const li = h(`<li title="Open in editor"><span class="st D">!</span>${esc(f)}</li>`); li.onclick = () => send({ type: 'openFile', id: t.id, file: f }); p.querySelector('ul').append(li); }
    p.querySelector('[data-a="resolve"]').onclick = () => { openTerms.add(t.id); send({ type: 'resolve', id: t.id }); renderBoard(); };
    p.querySelector('[data-a="resolved"]').onclick = () => send({ type: 'resolved', id: t.id });
    c.append(p);
  }
  if (openReview.has(t.id)) {
    const files = changes[t.id];
    const p = h(`<div class="panel"><div class="small muted">${files ? `${files.length} file(s) changed vs ${esc(t.base)} — click to diff` : 'Loading…'}</div><ul class="files"></ul></div>`);
    for (const f of files ?? []) { const li = h(`<li><span class="st ${esc(f.status)}">${esc(f.status)}</span>${esc(f.file)}</li>`); li.onclick = () => send({ type: 'diff', id: t.id, file: f.file }); p.querySelector('ul').append(li); }
    c.append(p);
  }
  if (openTerms.has(t.id)) {
    const slot = h(`<div class="term" data-id="${t.id}"></div>`);
    if (!t.live) {
      const end = h(`<div class="ended small muted">${t.sessionId ? 'Session not running' : 'Not started'} <button class="primary">${t.sessionId ? '↻ Resume' : '▶ Run'}</button></div>`);
      end.querySelector('button').onclick = run;
      slot.append(end);
    }
    c.append(slot);
  }
  return c;
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
    el.style.height = '100%';
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
    term.onResize(({ cols, rows }) => send({ type: 'resize', id, cols, rows }));
    new ResizeObserver(() => { if (el.isConnected) try { fit.fit(); } catch { /* hidden */ } }).observe(el);
    e = { term, fit, el };
    terms.set(id, e);
    send({ type: 'attach', id });
  } else if (e.el.parentElement !== slot) slot.prepend(e.el);
  // Always report the size: the pty may have started (at a guessed size) since the last fit.
  requestAnimationFrame(() => { try { e.fit.fit(); send({ type: 'resize', id, cols: e.term.cols, rows: e.term.rows }); } catch { /* hidden */ } });
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
    <label>Permissions<select name="mode">${opts(Object.entries(MODES), t.mode)}</select></label></div>`,
  d => send({ type: 'editTask', id: t.id, patch: { title: d.title.trim(), description: d.description.trim() || undefined, sprintId: d.sprintId || undefined, agent: d.agent || undefined, mode: d.mode } }));
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
    S = m; render();
    if (!connected) { connected = true; $('offline').hidden = true; if (!ui.guided && !S.empty) guide(); }
  }
  else if (m.type === 'data') terms.get(m.id)?.term.write(m.data);
  else if (m.type === 'replay') { const e = terms.get(m.id); if (e) { e.term.reset(); e.term.write(m.data); } }
  else if (m.type === 'changes') { changes[m.id] = m.files; renderBoard(); }
  else if (m.type === 'focus') {
    openTerms.add(m.id); ui.open = [...openTerms]; save();
    const t = S?.board.tasks.find(x => x.id === m.id);
    if (t && !visible().includes(t)) ui.view = 'all';
    render();
    document.querySelector(`.card[data-id="${m.id}"]`)?.scrollIntoView({ block: 'center' });
    terms.get(m.id)?.term.focus();
  }
});
send({ type: 'ready' });
