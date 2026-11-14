// JustCode board (webview). State comes from the extension host as one 'state' message; this file only renders it
// and sends the user's actions back. Inputs (new task, message box) live outside the re-rendered regions, so a
// state update never eats what you are typing.
(() => {
  // Inside VS Code the host shows native dialogs. A remote client (phone) supplies window.JC_BRIDGE with
  // postMessage/getState/setState; the host then asks for dialogs over the bridge and this file shows them in #dlg.
  const REMOTE = typeof acquireVsCodeApi !== 'function';
  const vscode = REMOTE ? (window.JC_BRIDGE || { postMessage() {}, getState() {}, setState() {} }) : acquireVsCodeApi();
  const post = (type, extra = {}) => vscode.postMessage({ type, root: S?.root, ...(REMOTE ? { remote: true } : {}), ...extra });
  const saved = vscode.getState() || {};
  let S;                                   // last state from the host
  let view = saved.view ?? 'all';          // all | backlog | sprint id
  let showArchived = false;
  let open = saved.open;                   // task id shown in the drawer
  let tab = 'activity';
  let steps = {};                          // task id → activity steps
  let changes = {};                        // task id → changed files
  let shots = {};                          // task id → screenshots
  let agentView, agentsSaved = {};         // agent shown in the Agents tab; finished agents from transcripts
  let showSetup = false, setupAsked = false;
  const HEALTH = new Set(['board', 'policy', 'registry', 'worktrees', 'sources', 'transcripts']);   // checklist rows about the project's .justcode files
  let dragId;
  let initLater = saved.initLater || {};   // project root → the user chose "Not now" on the setup banner
  let artSeen = saved.artSeen || 0;             // newest artifact change you have seen in the Artifacts dialog
  const remember = () => vscode.setState({ view, open, initLater, artSeen });

  // Is this project described for JustCode? Set up = .justcode/project.md exists.
  // `running` is the setup task while it works.
  function initState() {
    const pr = S.project || {};
    const missing = [!pr.projectMd && 'a project description'].filter(Boolean);
    const running = S.board.tasks.find(t => t.init === true && !t.archived && t.status !== 'done');
    return { done: !missing.length, missing, running };
  }

  /* ---------- tiny DOM helper ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const $ = s => document.querySelector(s);
  const andList = xs => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join('');
  // Icon buttons (⚙, ?, ⋯, ×) get their tooltip as an accessible name for screen readers.
  const btn = (label, onclick, cls = '', title) => h('button', { class: cls, onclick: e => { e.stopPropagation(); onclick(e); }, title, 'aria-label': title && String(label).length <= 2 ? title : undefined }, label);
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
  const tok = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tokens` : `${n} tokens`;
  const tokShort = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : `${Math.round(n / 1000)}k tok`;
  // Tokens processed per stage. Cache reads are re-sent context: cheap, but they count most toward plan limits.
  // "New" = what Claude wrote plus input not already cached. Cached = context re-sent each step (about a tenth of the cost).
  const fresh = u => u ? u.input + u.output + u.cacheWrite : 0;
  const sum = u => u ? fresh(u) + u.cacheRead : 0;
  const usageTotal = t => fresh(t.usage?.build) + fresh(t.usage?.review);
  const cachedTotal = t => (t.usage?.build?.cacheRead || 0) + (t.usage?.review?.cacheRead || 0);
  const usageTitle = t => ['build', 'review'].filter(k => t.usage?.[k]).map(k => { const u = t.usage[k]; return `${k}: ${tokShort(fresh(u))} new (written ${u.output}, new input ${u.input + u.cacheWrite}) + ${tokShort(u.cacheRead)} cached re-reads`; }).join('\n');
  // A sprint uses the project sources it lists; one made before sprints had sources uses all of them.
  const sprintOf = id => S.board.sprints.find(s => s.id === id);
  const sprintSrcs = id => { const sp = sprintOf(id); return sp?.sources ? (S.sources || []).filter(s => sp.sources.includes(s.id)) : (S.sources || []); };
  const savedAgo = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };
  const artKey = u => String(u).trim().replace(/[?#].*$/, '').replace(/\/$/, '');
  // The artifact links a task rests on: its ticked sources (or its sprint's) and links in its text.
  const taskArtUrls = t => [...(t.sources ? (S.sources || []).filter(s => t.sources.includes(s.id)) : sprintSrcs(t.sprintId)).filter(s => s.kind === 'url').map(s => artKey(s.ref)),
    ...(`${t.title} ${t.description || ''}`.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g) || [])];
  const regEntry = u => (S.registry || []).find(e => e.url === artKey(u));
  const srcLabel = s => s.kind === 'url' ? (regEntry(s.ref)?.title || s.ref.replace(/^https?:\/\//, '').slice(0, 40)) : (s.ref.split(/[\\/]/).filter(Boolean).pop() || s.ref) + (s.kind === 'folder' ? '/' : '');
  // Claude Code's own names for its permission modes (code.claude.com/docs/en/permission-modes).
  const MODES = [['auto', 'Auto', 'A classifier approves safe actions; risky ones ask'], ['acceptEdits', 'Edit automatically', 'File edits and simple file commands approved; other commands ask'],
    ['default', 'Manual', 'Only reads run; every edit and command asks'], ['plan', 'Plan', 'Read-only'], ['bypassPermissions', 'Bypass permissions ⚠', 'No approvals at all']];
  const modeName = m => (MODES.find(x => x[0] === m) || [m, m])[1];
  // claude-opus-5-5 → Opus 5.5; anything else as it is.
  const modelName = id => { const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id || ''); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id; };

  /* ---------- lanes and what each card says ---------- */
  // Column and next step live in status.js (shared with the tests).
  const lane = t => window.JCStatus.lane(t, S.settings);
  const next = t => window.JCStatus.nextStep(t, { settings: S.settings, queue: S.queue, policy: S.policy?.policy, tasks: S.board.tasks, post, open: JC.openTask, lastTool });
  const lastTool = t => { const n = t.agents?.find(a => a.id === 'main'); return n?.last ? ` · ${n.last}` : '…'; };

  /* ---------- shell (rendered once) ---------- */
  const app = $('#app');
  app.append(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◆'), 'JustCode'),
      h('div', { id: 'projects', class: 'projects' }),
      h('div', { class: 'spacer' }),
      h('div', { id: 'meter', class: 'meter' }),
      btn('?', () => JC.guide(), 'ghost icon', 'How JustCode works'),
      btn('⚙', () => JC.settings(), 'ghost icon', 'Settings, policy, phone, setup checklist')),
    h('div', { id: 'banners' }),
    h('div', { id: 'composer' }),
    h('div', { id: 'toolbar', class: 'toolbar' }),
    h('div', { id: 'progress' }),
    h('main', { id: 'lanes', class: 'lanes' }));

  /* ---------- render ---------- */
  function render() {
    if (!S) return;
    if (S.empty) {
      $('#projects').replaceChildren(btn('+ Add a project folder', () => post('addProject'), 'primary'));
      $('#lanes').replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Open a folder to start'), h('p', {}, 'JustCode works on any folder: an existing project or an empty one. Use File → Open Folder, or add one here.'),
        btn('+ Add a project folder', () => post('addProject'), 'primary')));
      return;
    }
    renderProjects(); renderMeter(); renderBanners(); JC.renderAddOptions(); renderToolbar(); renderProgress(); renderLanes(); JC.renderDrawer();
  }

  function renderProjects() {
    $('#projects').replaceChildren(...S.roots.map(p => h('span', { class: `proj${p.path === S.root ? ' on' : ''}${p.waiting ? ' dot' : ''}`, title: p.path, onclick: () => { open = undefined; post('root', { root: p.path }); } },
      p.name, p.running ? h('b', { class: 'badge run' }, `▶${p.running}`) : '',
      p.removable ? btn('×', () => post('removeProject', { root: p.path }), 'x', 'Remove from JustCode (files are kept)') : '')),
      btn('+', () => post('addProject'), 'ghost icon', 'Add a project folder'),
      setupPill());
  }

  // Next to the project name: whether it is set up for Claude, and what it has.
  function setupPill() {
    const st = initState(), pr = S.project || {};
    const has = [['project.md', pr.projectMd], ['DESIGN.md', pr.designMd]].map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join('\n');
    if (st.running) return h('span', { class: 'pill run', title: 'Claude is setting up this project. Open the task to answer its questions.', onclick: () => JC.openTask(st.running.id) }, '◌ Setting up…');
    if (st.done) return h('span', { class: 'pill ok', title: `Set up for Claude\n${has}` }, '✓ Set up');
    return h('span', { class: 'pill warn', title: `Not set up for Claude\n${has}\n\nClick to set it up.`, onclick: () => post('initialize') }, '● Not set up');
  }

  function renderMeter() {
    const l = S.limit || {};
    const bar = (name, w) => w ? h('span', { class: `win${w.pct >= 85 ? ' hot' : ''}`, title: w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString()}` : '' },
      name, h('i', {}, h('u', { style: `width:${Math.min(100, w.pct)}%` })), `${Math.round(w.pct)}%`) : '';
    $('#meter').replaceChildren(bar('5h', l.five), bar('week', l.week));
  }

  function renderBanners() {
    const out = [];
    const l = S.limit || {};
    if (S.settings?.bypassAll) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'Bypass all is ON. '), 'Every task runs with no approvals and can run any command. Turn off justCode.bypassAll to go back.'));
    if (l.held) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'Usage limit reached. '),
      `Tasks pause and continue by themselves${l.reached?.resetsAt ? ` at ${new Date(l.reached.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' after the reset'}.`, btn('Try now', () => post('resumeNow'))));
    const st = S.setup;
    if (st && !st.ready && !setupAsked) { setupAsked = true; showSetup = true; }
    if (st && showSetup) { showSetup = false; JC.setupDialog(); }
    if (!st) out.push(h('div', { class: 'banner info' }, 'Checking your setup…'));
    if (st?.ready && !REMOTE) {
      const sick = st.checks.filter(c => !c.ok && HEALTH.has(c.id));
      if (sick.length) out.push(h('div', { class: `banner ${sick.some(c => c.id === 'registry') ? 'err' : 'warn'}` }, h('div', { class: 'grow' }, h('b', {}, `${sick.length === 1 ? sick[0].label : `${sick.length} project file problems`}: `), sick[0].detail),
        btn(sick.length === 1 ? sick[0].fix.label : 'Show', () => sick.length === 1 ? post('fix', { action: sick[0].fix.action }) : JC.setupDialog(), 'ghost')));
    }
    const over = S.board.tasks.find(t => !t.archived && /^Budget reached/.test(t.error || ''));
    if (over) out.push(h('div', { class: 'banner warn' }, h('div', { class: 'grow' }, h('b', {}, 'Budget reached: '), `“${over.title}” spent ${over.error.replace(/^Budget reached: /, '').replace(/ Raise.*$/, '')} Raise it in policy.json, then Resume.`), btn('Open policy.json', () => post('openPolicy'))));
    const init = initState();
    if (st?.ready && init.running && init.running.asks?.length) out.push(h('div', { class: 'banner warn' }, h('div', { class: 'grow' }, h('b', {}, 'Project setup needs you. '), 'Claude is asking a question about this project.'),
      btn('Answer', () => JC.openTask(init.running.id), 'primary')));
    else if (st?.ready && !init.done && !init.running && !initLater[S.root]) out.push(h('div', { class: 'banner info' }, h('div', { class: 'grow' }, h('b', {}, 'This project is not set up for Claude yet. '),
      'Claude reads the code, asks a few questions, and writes .justcode/project.md and DESIGN.md.'),
      btn('Set up project', () => post('initialize'), 'primary'), btn('Later', () => { initLater[S.root] = true; remember(); render(); }, 'ghost', 'Hide for this project. The "Not set up" label at the top still sets it up.')));
    if (st?.ready && !S.guideSeen) out.push(h('div', { class: 'banner info' }, h('b', {}, 'New here? '), 'Add a task above and press ⌘/Ctrl+Enter. Claude works on its own branch; you answer on the card and merge when it passes review.',
      btn('2-minute guide', () => JC.guide(), 'ghost'), btn('Got it', () => { S.guideSeen = true; post('guideSeen'); render(); }, 'ghost')));
    $('#banners').replaceChildren(...out);
  }

  const visible = () => S.board.tasks.filter(t => (showArchived ? t.archived : !t.archived) &&
    (view === 'all' || (view === 'backlog' ? !t.sprintId : t.sprintId === view)));

  function renderToolbar() {
    const tasks = visible();
    const todo = tasks.filter(t => t.status === 'todo' && !t.queued);
    const ready = tasks.filter(t => t.review?.state === 'pass' && t.review.risk !== 'critical' && t.status !== 'done' && !t.error && t.worktree);
    const q = S.queue;
    const sprint = S.board.sprints.find(s => s.id === view);
    const editable = tasks.filter(t => t.status === 'todo' && !t.worktree && !t.queued);
    const extra = [
      ['+ Sprint', 'Start a new sprint', () => JC.newSprint()],
      sprint && editable.length && ['✦ Edit sprint (' + editable.length + ')', `Edit every not-started task in ${sprint.name} with one prompt`, () => S.planner ? JC.openPlanner() : JC.planDialog(editable.map(t => t.id), sprint, true)],
      sprint && !sprint.active && ['Set active', `Make ${sprint.name} the active sprint`, () => post('activateSprint', { sprintId: sprint.id })],
      sprint && ['Close sprint', `Close ${sprint.name}`, () => post('closeSprint', { sprintId: sprint.id })],
      sprint?.branch && tasks.length && tasks.every(t => t.status === 'done') && [`Merge sprint into ${sprint.target}`, `${sprint.branch} → ${sprint.target}`, () => post('mergeSprint', { sprintId: sprint.id })],
      sprint && ['Delete sprint…', 'Asks first. Its tasks move to the Backlog', () => post('deleteSprint', { sprintId: sprint.id })],
      ready.length && [`✓ Merge ready (${ready.length})`, 'Merge every task whose review passed', () => post('mergeReady', { ids: ready.map(t => t.id) })],
      view === 'backlog' && !showArchived && tasks.some(t => !t.worktree && t.status !== 'doing' && t.status !== 'review') && ['Clear backlog…', 'Archive every idle backlog task (asks first)', () => post('clearBacklog')],
    ].filter(Boolean);
    $('#toolbar').replaceChildren(
      h('select', { onchange: e => { view = e.target.value; remember(); render(); } },
        h('option', { value: 'all', selected: view === 'all' }, 'All tasks'), h('option', { value: 'backlog', selected: view === 'backlog' }, 'Backlog'),
        ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id, selected: view === s.id }, `${s.name}${s.active ? ' ★' : ''}`))),
      btn('✦ Plan', () => S.planner ? JC.openPlanner() : JC.planDialog(editable.map(t => t.id), sprint), 'ghost', 'Plan new tasks or rework the To do list with Claude'),
      (n => btn(`📎 Sources${n ? ` ${n}` : ''}`, () => JC.sourcesDialog(), 'ghost', sprint ? `Specs, designs, docs and links ${sprint.name} is built on` : 'Specs, designs, docs and links tasks are based on'))(sprint ? sprintSrcs(sprint.id).length : (S.sources || []).length),
      btn(`⧉ Artifacts${(S.registry || []).some(e => (e.changedAt || 0) > artSeen) ? ' •' : ''}`, () => JC.artifactsDialog(), 'ghost', 'Every claude.ai artifact this project used or published'),
      btn('🎨 Design', () => JC.designDialog(), 'ghost', 'The style spec UI and artifact tasks follow (.justcode/design/DESIGN.md)'),
      h('div', { class: 'spacer' }),
      q.queued.length || q.blocker ? h('span', { class: 'queue' }, q.queued.length ? `${q.queued.length} queued` : '', q.blocker ? [' · next waits: ', h('a', { href: '#', title: 'Open this task', onclick: e => { e.preventDefault(); JC.openTask(q.blocker.id); } }, `“${q.blocker.title.slice(0, 40)}”`), ` ${q.blocker.why}`] : '',
        (n => q.queued.length && n.length ? [' · ', h('a', { href: '#', title: 'Run all goes on without these; open the first', onclick: e => { e.preventDefault(); JC.openTask(n[0].id); } }, `${n.length} need${n.length === 1 ? 's' : ''} you`)] : '')(tasks.filter(t => lane(t) === 'needs')),
        q.queued.length ? btn('Stop queue', () => post('cancelQueue'), 'ghost') : '') : '',
      showArchived ? btn('Showing archived ×', () => { showArchived = false; render(); }, 'ghost') : '',
      btn('▶ Run all', () => post('runAll', { ids: todo.map(t => t.id) }), 'primary', `Runs every To do task in board order, ${S.settings.maxParallel} at a time`),
      btn(ready.length ? '⋯ •' : '⋯', () => JC.moreMenu(extra), 'ghost icon', ready.length ? `${ready.length} task${ready.length === 1 ? '' : 's'} ready to merge: open this menu` : 'Sprints, merge, agent map, report, history, archived tasks'));
  }

  const costOf = l => l.reduce((n, t) => n + (t.costUsd || 0), 0);
  const sprintBudget = id => { const spent = costOf(S.board.tasks.filter(t => t.sprintId === id)); return spent || S.policy ? { spent, max: S.policy?.policy.maxCostUsd.sprint || 0 } : undefined; };
  function renderProgress() {
    const sp = S.board.sprints.find(s => s.id === view) ?? (view === 'all' ? S.board.sprints.find(s => s.active && !s.closed) : undefined);
    if (!sp) return $('#progress').replaceChildren();
    const tasks = S.board.tasks.filter(t => t.sprintId === sp.id && !t.archived);
    if (!tasks.length) return $('#progress').replaceChildren(h('div', { class: 'sprintbar' }, h('b', {}, sp.name), sp.goal ? h('span', { class: 'muted' }, ` · ${sp.goal}`) : '',
      h('span', { class: 'muted small' }, ' · no tasks yet: add one, or use ✦ Plan')));
    const n = id => tasks.filter(t => lane(t) === id).length;
    const parts = [['done', 'done', n('done')], ['review', 'in review', n('review')], ['work', 'working', n('work')], ['needs', 'need you', n('needs')], ['todo', 'to do', n('todo')]];
    const done = n('done'), pct = Math.round(done / tasks.length * 100);
    $('#progress').replaceChildren(h('div', { class: 'sprintbar', title: parts.map(([, l, c]) => `${c} ${l}`).join(' · ') + (sp.branch ? ` — ⎇ ${sp.branch} → ${sp.target}` : '') },
      h('b', {}, sp.name),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': `${sp.name} progress`, 'aria-valuemin': '0', 'aria-valuemax': String(tasks.length), 'aria-valuenow': String(done) },
        parts.filter(([, , c]) => c).map(([id, , c]) => h('i', { class: `seg ${id}`, style: `flex:${c}` }))),
      h('span', { class: 'muted small' }, `${done} of ${tasks.length} done`),
      (b => b ? h('span', { class: `small cost${b.max && b.spent >= b.max ? ' err' : ''}`, title: 'Estimated cost of this sprint\'s tasks and reviews, against maxCostUsd.sprint in .justcode/policy.json' }, `$${b.spent.toFixed(2)}${b.max ? ` / $${b.max}` : ''}`) : '')(sprintBudget(sp.id)),
      h('div', { class: 'spacer' }),
      !REMOTE ? btn('Report', () => post('sprintReport', { sprintId: sp.id }), 'ghost small', 'Export this sprint\'s report (tasks, merges, cost, audit highlights, artifacts) to .justcode/reports') : ''));
  }

  const LANES = window.JCStatus.LANES;
  function renderLanes() {
    const tasks = visible();
    if (!S.board.tasks.some(t => !t.archived)) {
      $('#lanes').replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'No tasks yet'), h('p', {}, 'Type what you want above. ⚡ Quick runs it now; Add puts it in To do. Or ✦ Plan a bigger goal with Claude.'),
        btn('✦ Plan with Claude', () => (S.planner ? JC.openPlanner() : JC.planDialog([], undefined, false)), 'primary')));
      return;
    }
    $('#lanes').replaceChildren(...LANES.map(([id, name]) => {
      const list = tasks.filter(t => lane(t) === id);
      if (id === 'done') list.reverse();
      return h('section', { class: `lane ${id}`, ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('over'); },
        ondragleave: e => e.currentTarget.classList.remove('over'),
        ondrop: e => { e.currentTarget.classList.remove('over'); if (dragId && id === 'done') post('move', { id: dragId, status: 'done' }); else if (dragId && id === 'todo') post('reorder', { id: dragId }); } },
        h('h2', {}, h('span', { class: 'ldot' }), name, h('span', { class: 'count' }, list.length)),
        list.length ? list.map((t, i) => card(t, id === 'todo' ? i + 1 : 0)) : h('p', { class: 'muted small hint' }, hint(id)),
        id === 'todo' ? h('button', { class: 'addtask', onclick: () => $('#title')?.focus() }, '+ Add task') : '');
    }));
  }
  const hint = id => ({ todo: 'Add a task above.', work: 'Running tasks show here.', needs: 'Approvals and questions land here.', review: 'Finished work waits here for review and merge.', done: 'Merged tasks.' })[id];

  function card(t, n) {
    const nx = next(t);
    const el = h('article', { class: `card tone-${nx.tone}${open === t.id ? ' sel' : ''}`, draggable: t.status === 'todo' ? 'true' : undefined, 'data-id': t.id,
      tabindex: '0', role: 'button', 'aria-label': `${t.title}: ${nx.text}`,
      onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); JC.openTask(t.id); } },
      onclick: () => JC.openTask(t.id), ondragstart: () => { dragId = t.id; }, ondragend: () => { dragId = undefined; },
      ondragover: e => { if (dragId && dragId !== t.id && t.status === 'todo') e.preventDefault(); },
      ondrop: e => { if (dragId && dragId !== t.id && t.status === 'todo') { e.stopPropagation(); post('reorder', { id: dragId, before: t.id }); } } },
      h('div', { class: 'ctop' }, n ? h('span', { class: 'num' }, n) : '', h('span', { class: 'ttl' }, t.title)),
      h('div', { class: 'meta' },
        t.agent ? h('span', { class: 'tag' }, t.agent) : '',
        h('span', { class: `tag mode-${S.settings?.bypassAll ? 'bypassPermissions' : t.mode}` }, modeName(S.settings?.bypassAll ? 'bypassPermissions' : t.mode)),
        t.output === 'artifact' ? h('span', { class: 'tag', title: 'Result: a page published as a claude.ai artifact' }, '⧉ artifact') : t.where === 'direct' ? h('span', { class: 'tag' }, 'workspace') : '',
        t.images?.length ? h('span', { class: 'tag' }, `🖼 ${t.images.length}`) : '',
        t.status === 'todo' && (urls => (S.registry || []).some(e => (e.changedAt || 0) > (t.created || 0) && (e.taskIds.includes(t.id) || urls.includes(e.url))))(taskArtUrls(t)) ? h('span', { class: 'tag warn', title: 'A source artifact this task uses has new content: check the task still fits' }, 'design changed since this task was written') : '',
        t.agents?.length > 1 ? h('span', { class: 'tag' }, `${t.agents.length - 1} subagent${t.agents.length > 2 ? 's' : ''}`) : '',
        usageTotal(t) ? h('span', { class: 'tag muted', title: usageTitle(t) }, tokShort(usageTotal(t))) : ''),
      h('div', { class: `next ${nx.tone}`, title: nx.tone === 'err' ? nx.text : undefined }, nx.text),
      nx.tone === 'run' ? h('div', { class: 'pulsebar' }) : '',
      ...(t.asks || []).map(a => JC.askBox(t, a)),
      nx.actions.length ? h('div', { class: 'acts' }, nx.actions.map(([l, fn, style], i) => btn(l, fn, i === 0 ? 'primary' : style || 'ghost'))) : '');
    return el;
  }

  // What drawer.js and dialogs.js use from here; `let` values through getters and setters, so they stay live.
  window.JC = {
    REMOTE,
    vscode,
    post,
    saved,
    get S() { return S; }, set S(v) { S = v; },
    get view() { return view; }, set view(v) { view = v; },
    get showArchived() { return showArchived; }, set showArchived(v) { showArchived = v; },
    get open() { return open; }, set open(v) { open = v; },
    get tab() { return tab; }, set tab(v) { tab = v; },
    get steps() { return steps; }, set steps(v) { steps = v; },
    get changes() { return changes; }, set changes(v) { changes = v; },
    get shots() { return shots; }, set shots(v) { shots = v; },
    get agentView() { return agentView; }, set agentView(v) { agentView = v; },
    get agentsSaved() { return agentsSaved; }, set agentsSaved(v) { agentsSaved = v; },
    get showSetup() { return showSetup; }, set showSetup(v) { showSetup = v; },
    HEALTH,
    get dragId() { return dragId; }, set dragId(v) { dragId = v; },
    get initLater() { return initLater; }, set initLater(v) { initLater = v; },
    get artSeen() { return artSeen; }, set artSeen(v) { artSeen = v; },
    remember,
    initState,
    h,
    $,
    andList,
    btn,
    ago,
    tok,
    tokShort,
    fresh,
    sum,
    usageTotal,
    cachedTotal,
    usageTitle,
    sprintOf,
    sprintSrcs,
    savedAgo,
    artKey,
    taskArtUrls,
    regEntry,
    srcLabel,
    MODES,
    modeName,
    modelName,
    lane,
    next,
    lastTool,
    app,
    render,
    renderProjects,
    setupPill,
    renderMeter,
    renderBanners,
    visible,
    renderToolbar,
    costOf,
    sprintBudget,
    renderProgress,
    LANES,
    renderLanes,
    hint,
    card,
  };

  /* ---------- messages from the extension ---------- */
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      S = m;
      if (view !== 'all' && view !== 'backlog' && !S.board?.sprints.some(s => s.id === view)) { view = 'all'; remember(); } // its sprint was deleted if (open && open !== '__planner' && !S.board?.tasks.some(t => t.id === open)) open = undefined;
      render();
      if ($('#dlg').open && $('#dlg').dataset.kind === 'setup') JC.setupDialog();
      if ($('#dlg').open && $('#dlg').dataset.kind === 'sources') JC.sourcesDialog();
      if ($('#dlg').open && $('#dlg').dataset.kind === 'artifacts') JC.artifactsDialog();
    }
    else if (m.type === 'completions') JC.completions(m);
    else if (m.type === 'history') JC.setHistory(m.items);
    else if (m.type === 'sessionLog') { if (JC.sessionView?.id === m.sessionId) { JC.sessionView.steps = m.steps; JC.drawHistory(); } }
    else if (m.type === 'steps') { steps[m.id] = m.steps; if (m.id === open && tab === 'activity') JC.renderDrawer(); }
    else if (m.type === 'savedAgents') { agentsSaved[m.id] = m.nodes; if (m.id === open && tab === 'agents' && !agentView) JC.renderDrawer(); }
    else if (m.type === 'agentLog') { if (agentView?.task === m.id) { agentView.log = m; if (m.id === open && tab === 'agents') JC.renderDrawer(); } }
    else if (m.type === 'changes') { changes[m.id] = m.files; if (m.id === open) JC.renderDrawer(); }
    else if (m.type === 'shots') { shots[m.id] = m.images; if (m.id === open) JC.renderDrawer(); }
    else if (m.type === 'focus') JC.openTask(m.id);
    else if (m.type === 'usedSource') { JC.srcOff.delete(m.sourceId); JC.renderAddOptions(); }
    else if (m.type === 'picked') JC.addPicked(m.files);
    else if (m.type === 'dialog') JC.bridged(m);
    else if (m.type === 'pairing') JC.pairingDialog(m);
    else if (m.type === 'toast') JC.toast(m.text);
    else if (m.type === 'open') window.open(m.url, '_blank', 'noopener');
    else if (m.type === 'copy') { (navigator.clipboard?.writeText(m.text) ?? Promise.reject()).then(() => JC.toast('Copied.'), () => JC.toast('Could not copy.')); }
    else if (m.type === 'showSetup') { showSetup = true; render(); }
  });
  // Live timers (working for 2m 10s) tick without a state change.
  setInterval(() => {
    if (!S || S.empty) return;
    if (S.board.tasks.some(t => t.run === 'running' || t.reviewing)) { renderLanes(); if (open && tab === 'agents') JC.renderDrawer(); }
    if (agentView && agentView.task === open && tab === 'agents' && S.board.tasks.find(t => t.id === open)?.run === 'running') JC.openAgent(S.board.tasks.find(t => t.id === open), agentView.node);
    const pp = open === '__planner' && S.planner?.run && S.planner.run !== 'idle' && document.querySelector('#drawer .planprog');
    if (pp) pp.replaceWith(JC.planProgress(S.planner, true));
  }, 5000);
  post('ready');
  if (open && open !== '__planner') post('watch', { id: open });
})();
