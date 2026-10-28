// JustCode board (webview). State comes from the extension host as one 'state' message; this file only renders it
// and sends the user's actions back. Inputs (new task, message box) live outside the re-rendered regions, so a
// state update never eats what you are typing.
(() => {
  const vscode = acquireVsCodeApi();
  const post = (type, extra = {}) => vscode.postMessage({ type, root: S?.root, ...extra });
  const saved = vscode.getState() || {};
  let S;                                   // last state from the host
  let view = saved.view ?? 'all';          // all | backlog | sprint id
  let showArchived = false;
  let open = saved.open;                   // task id shown in the drawer
  let tab = 'activity';
  let steps = {};                          // task id → activity steps
  let changes = {};                        // task id → changed files
  let shots = {};                          // task id → screenshots
  let showSetup = false;
  let more = false;                        // new-task details open
  let images = [];                         // pasted screenshots for the new task
  let dragId;
  const remember = () => vscode.setState({ view, open });

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
  const btn = (label, onclick, cls = '', title) => h('button', { class: cls, onclick: e => { e.stopPropagation(); onclick(e); }, title }, label);
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
  const dur = ms => ms ? ago(Date.now() - ms) : '';
  const tok = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tokens` : `${n} tokens`;
  const MODES = [['auto', 'Auto', 'Claude approves what is safe, asks when unsure'], ['acceptEdits', 'Auto-edit', 'Edits approved, commands ask'],
    ['default', 'Ask me', 'Every edit and command asks'], ['plan', 'Plan only', 'Read-only'], ['bypassPermissions', 'Allow everything ⚠', 'No approvals at all']];
  const modeName = m => (MODES.find(x => x[0] === m) || [m, m])[1];

  /* ---------- lanes and what each card says ---------- */
  function lane(t) {
    if (t.status === 'done') return 'done';
    if (t.status === 'todo' && !t.run) return 'todo';
    if (t.asks?.length || t.error || t.conflicts?.length) return 'needs';
    const max = S.settings.review.maxAttempts;
    if (t.status === 'review' && t.review?.state === 'fail' && t.review.attempts >= max) return 'needs';
    if (t.status === 'review' && !t.review && !t.reviewing && t.reply && t.where !== 'root' && !t.run) return 'needs';
    if (t.run && t.run !== 'idle' || t.remote || t.limited || t.status === 'doing') return 'work';
    return 'review';
  }

  // { text, tone, action: [label, fn] } — the one thing a card tells you, and the one button for it.
  function next(t) {
    const max = S.settings.review.maxAttempts, r = t.review;
    if (t.status === 'done') return t.review?.unreviewed ? { text: 'Merged without a finished review (the reviewer could not run)', tone: 'warn' } : { text: t.where === 'root' ? 'Done' : 'Merged', tone: 'ok' };
    if (t.asks?.length) return { text: t.asks[0].kind === 'question' ? 'Claude has a question for you' : 'Claude needs your approval', tone: 'warn' };
    if (t.run === 'starting') return { text: 'Starting Claude…', tone: 'run' };
    if (t.run === 'running') return { text: `Working${lastTool(t)}`, tone: 'run', action: ['Open', () => openTask(t.id)] };
    if (t.remote) return { text: 'In Remote Control: continue in the Claude app or claude.ai/code. Close its terminal to bring it back.', tone: 'run' };
    if (t.limited) return { text: 'Paused by the usage limit. Continues by itself after the reset.', tone: 'muted' };
    if (t.error) return { text: `Stopped: ${t.error}`, tone: 'err', action: ['↻ Resume', () => post('say', { id: t.id, text: 'Continue the task.' })] };
    if (t.status === 'todo') return t.queued ? { text: `Queued #${S.queue.queued.indexOf(t.id) + 1}`, tone: 'muted' } : { text: 'Ready', tone: 'muted', action: ['▶ Run', () => post('run', { id: t.id })] };
    if (t.conflicts?.length) return { text: `Conflicts with ${t.base} in ${t.conflicts.length} file(s)`, tone: 'err', action: ['Resolve with Claude', () => post('resolve', { id: t.id })] };
    if (t.reviewing) return { text: `AI reviewer is testing it · ${dur(t.reviewing)}`, tone: 'run' };
    if (t.status === 'doing') return r?.state === 'fail' ? { text: `Fixing review issues (round ${r.attempts} of ${max})`, tone: 'run' } : { text: 'Paused', tone: 'muted', action: ['↻ Resume', () => post('say', { id: t.id, text: 'Continue the task.' })] };
    if (t.where === 'root') return { text: 'Finished. Check the result, then mark it done.', tone: 'ok', action: ['✓ Done', () => post('move', { id: t.id, status: 'done' })] };
    if (r?.state === 'pass') return { text: r.risk === 'critical' ? 'Review passed, flagged critical: look before merging' : 'Review passed. Ready to merge.', tone: r.risk === 'critical' ? 'warn' : 'ok', action: ['✓ Merge', () => post('merge', { id: t.id })] };
    if (r?.state === 'fail' && r.attempts >= max) return { text: `Review still finds ${r.issues?.length ?? 0} issue(s) after ${r.attempts} rounds`, tone: 'err', action: ['Send to Claude', () => post('sendIssues', { id: t.id })] };
    if (r?.state === 'error') return { text: `Review could not run: ${r.error ?? ''}`, tone: 'err', action: ['↻ Retry review', () => post('review', { id: t.id })] };
    if (!r && t.reply && !t.run) return { text: `Claude replied without changing files: "${t.reply.slice(0, 140)}"`, tone: 'warn', action: ['Reply', () => openTask(t.id, 'activity')] };
    if (!S.settings.review.auto) return { text: 'Finished. Look at the changes, then merge.', tone: 'ok', action: ['✓ Merge', () => post('merge', { id: t.id })] };
    return { text: 'Waiting for the AI reviewer', tone: 'muted' };
  }
  const lastTool = t => { const n = t.agents?.find(a => a.id === 'main'); return n?.last ? ` · ${n.last}` : '…'; };

  /* ---------- shell (rendered once) ---------- */
  const app = $('#app');
  app.append(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◆'), 'JustCode'),
      h('div', { id: 'projects', class: 'projects' }),
      h('div', { class: 'spacer' }),
      h('div', { id: 'meter', class: 'meter' }),
      btn('Agent map', () => agentMap(), 'ghost', 'Every Claude session and subagent at work'),
      btn('⚙', () => settings(), 'ghost icon', 'Settings'),
      btn('?', () => guide(), 'ghost icon', 'Guide')),
    h('div', { id: 'banners' }),
    h('section', { class: 'add' },
      h('div', { class: 'addrow' },
        h('input', { id: 'title', class: 'grow', placeholder: 'What should Claude do?  Enter adds it · ⌘/Ctrl+Enter adds and runs it', onkeydown: e => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTask(e.metaKey || e.ctrlKey); }
        }, onpaste: pasteImages }),
        btn('More ▾', e => { more = !more; e.target.textContent = more ? 'Less ▴' : 'More ▾'; $('#more').hidden = !more; }, 'ghost'),
        btn('Add', () => addTask(false)),
        btn('Add & run', () => addTask(true), 'primary')),
      h('div', { id: 'more', class: 'more', hidden: true },
        h('textarea', { id: 'desc', placeholder: 'Details, acceptance criteria, links. Paste screenshots here.', onpaste: pasteImages }),
        h('div', { id: 'imgs', class: 'imgs' }),
        h('div', { class: 'row' },
          h('label', {}, 'Agent ', h('select', { id: 'agent' })),
          h('label', {}, 'Permissions ', h('select', { id: 'mode' }, MODES.map(([v, l, d]) => h('option', { value: v, title: d }, l)))),
          h('label', { title: 'Own branch: an isolated copy you review and merge. Project folder: runs in the project itself (deploys, syncs, releases).' }, 'Runs in ',
            h('select', { id: 'where' }, h('option', { value: 'branch' }, 'Own branch (reviewed, merged)'), h('option', { value: 'root' }, 'Project folder'))),
          h('label', {}, 'Goes to ', h('select', { id: 'sprintSel' }))),
        h('div', { id: 'skills', class: 'chips' }))),
    h('div', { id: 'toolbar', class: 'toolbar' }),
    h('main', { id: 'lanes', class: 'lanes' }));

  function pasteImages(e) {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    if (!more) $('#more').hidden = !(more = true);
    for (const f of files) {
      const rd = new FileReader();
      rd.onload = () => { images.push({ name: f.name || 'pasted.png', data: rd.result }); drawImages(); };
      rd.readAsDataURL(f);
    }
  }
  function drawImages() {
    $('#imgs').replaceChildren(...images.map((im, i) => h('span', { class: 'thumb' }, h('img', { src: im.data }), btn('×', () => { images.splice(i, 1); drawImages(); }, 'x'))));
  }

  function addTask(start) {
    const title = $('#title').value.trim();
    if (!title) return $('#title').focus();
    const sprint = $('#sprintSel').value;
    post('addTask', { title, description: $('#desc').value, agent: $('#agent').value, mode: $('#mode').value, where: $('#where').value,
      sprintId: sprint || undefined, images, start });
    $('#title').value = ''; $('#desc').value = ''; images = []; drawImages();
  }

  /* ---------- render ---------- */
  function render() {
    if (!S) return;
    if (S.empty) {
      $('#projects').replaceChildren(btn('+ Add a project folder', () => post('addProject'), 'primary'));
      $('#lanes').replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Open a folder to start'), h('p', {}, 'JustCode works on any folder: an existing project or an empty one. Use File → Open Folder, or add one here.'),
        btn('+ Add a project folder', () => post('addProject'), 'primary')));
      return;
    }
    renderProjects(); renderMeter(); renderBanners(); renderAddOptions(); renderToolbar(); renderLanes(); renderDrawer();
  }

  function renderProjects() {
    $('#projects').replaceChildren(...S.roots.map(p => h('span', { class: `proj${p.path === S.root ? ' on' : ''}`, title: p.path, onclick: () => { open = undefined; post('root', { root: p.path }); } },
      p.name, p.running ? h('b', { class: 'badge run' }, `▶${p.running}`) : '', p.waiting ? h('b', { class: 'badge warn' }, `●${p.waiting}`) : '',
      p.removable ? btn('×', () => post('removeProject', { root: p.path }), 'x', 'Remove from JustCode (files are kept)') : '')),
      btn('+', () => post('addProject'), 'ghost icon', 'Add a project folder'));
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
    if (l.held) out.push(h('div', { class: 'banner warn' }, h('b', {}, 'Usage limit reached. '),
      `Tasks pause and continue by themselves${l.reached?.resetsAt ? ` at ${new Date(l.reached.resetsAt).toLocaleTimeString()}` : ' after the reset'}.`, btn('Try now', () => post('resumeNow'))));
    const st = S.setup;
    if (st && (!st.ready || showSetup)) {
      const done = st.checks.filter(c => c.ok).length;
      out.push(h('div', { class: 'setup' },
        h('div', { class: 'row' }, h('h3', {}, st.ready ? '✓ All set' : `Get set up · ${done} of ${st.checks.length}`), h('div', { class: 'spacer' }),
          btn('Check again', () => post('fix', { action: 'recheck' }), 'ghost'), st.ready ? btn('Hide', () => { showSetup = false; render(); }, 'ghost') : ''),
        h('ul', {}, st.checks.map(c => h('li', { class: c.ok ? 'ok' : c.optional ? 'opt' : 'bad' },
          h('span', { class: 'dot' }, c.ok ? '✓' : c.optional ? '○' : '✗'), h('b', {}, c.label), h('span', { class: 'muted' }, c.detail),
          !c.ok && c.fix ? btn(c.fix.label, () => post('fix', { action: c.fix.action }), c.optional ? '' : 'primary') : ''))),
        h('p', { class: 'muted small' }, st.remote ? '📱 Remote Control is available: any task can continue on your phone.' : 'Remote Control (continue on your phone) needs a Claude account login.')));
    } else if (!st) out.push(h('div', { class: 'banner' }, 'Checking your setup…'));
    if (st?.ready && !S.guideSeen) out.push(h('div', { class: 'banner info' }, h('b', {}, 'New here? '), 'Add a task above and press ⌘/Ctrl+Enter. Claude works on its own branch; you answer on the card and merge when it passes review.',
      btn('2-minute guide', () => guide(), 'ghost'), btn('Got it', () => { S.guideSeen = true; post('guideSeen'); render(); }, 'ghost')));
    $('#banners').replaceChildren(...out);
  }

  function renderAddOptions() {
    const ag = $('#agent'), cur = ag.value;
    ag.replaceChildren(h('option', { value: '' }, 'Default'), ...S.agents.map(a => h('option', { value: a.name, title: a.description }, `${a.name}${a.scope === 'user' ? ' (yours)' : ''}`)));
    ag.value = S.agents.some(a => a.name === cur) ? cur : '';
    if (!$('#mode').dataset.set) { $('#mode').value = S.settings.defaultMode; $('#mode').dataset.set = '1'; }
    const sp = $('#sprintSel'), sc = sp.value, active = S.board.sprints.find(s => s.active && !s.closed);
    sp.replaceChildren(h('option', { value: '' }, 'Backlog'), ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id }, s.name)));
    sp.value = sc && S.board.sprints.some(s => s.id === sc) ? sc : (view !== 'all' && view !== 'backlog' ? view : active?.id ?? '');
    $('#skills').replaceChildren(...(S.skills.length ? [h('span', { class: 'muted small' }, 'Skills:')] : []), ...S.skills.map(n => h('span', { class: 'chip', title: 'Add to the task', onclick: () => {
      const t = $('#title'); if (!t.value.trim()) t.value = `/${n}`; else { $('#desc').value += `${$('#desc').value ? '\n' : ''}/${n}`; if (!more) $('#more').hidden = !(more = true); }
      if (t.value.trim() === `/${n}`) $('#where').value = 'root';
    } }, `/${n}`)));
  }

  const visible = () => S.board.tasks.filter(t => (showArchived ? t.archived : !t.archived) &&
    (view === 'all' || (view === 'backlog' ? !t.sprintId : t.sprintId === view)));

  function renderToolbar() {
    const tasks = visible();
    const todo = tasks.filter(t => t.status === 'todo' && !t.queued);
    const ready = tasks.filter(t => t.review?.state === 'pass' && t.review.risk !== 'critical' && t.status !== 'done');
    const q = S.queue;
    const sprint = S.board.sprints.find(s => s.id === view);
    $('#toolbar').replaceChildren(
      h('select', { onchange: e => { view = e.target.value; remember(); render(); } },
        h('option', { value: 'all' }, 'All tasks'), h('option', { value: 'backlog' }, 'Backlog'),
        ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id }, `${s.name}${s.active ? ' ★' : ''}`))),
      btn('+ Sprint', () => newSprint(), 'ghost'),
      sprint && !sprint.active ? btn('Set active', () => post('activateSprint', { sprintId: sprint.id }), 'ghost') : '',
      sprint ? btn('Close sprint', () => post('closeSprint', { sprintId: sprint.id }), 'ghost') : '',
      btn('✦ Plan with Claude', () => planDialog(), 'ghost', 'Describe a goal; Claude reads the code and proposes tasks'),
      h('div', { class: 'spacer' }),
      q.queued.length || q.blocker ? h('span', { class: 'queue' }, q.queued.length ? `${q.queued.length} queued` : '', q.blocker ? ` · next waits: “${q.blocker.title.slice(0, 40)}” ${q.blocker.why}` : '',
        q.queued.length ? btn('Stop queue', () => post('cancelQueue'), 'ghost') : '') : '',
      ready.length ? btn(`✓ Merge ready (${ready.length})`, () => post('mergeReady', { ids: ready.map(t => t.id) })) : '',
      btn(`▶ Run all${todo.length ? ` (${todo.length})` : ''}`, () => post('runAll', { ids: todo.map(t => t.id) }), 'primary', 'Runs every To do task in board order'),
      h('label', { class: 'muted small' }, h('input', { type: 'checkbox', checked: showArchived, onchange: e => { showArchived = e.target.checked; render(); } }), ' Archived'));
  }

  const LANES = [['todo', 'To do'], ['work', 'Working'], ['needs', 'Needs you'], ['review', 'Review'], ['done', 'Done']];
  function renderLanes() {
    const tasks = visible();
    $('#lanes').replaceChildren(...LANES.map(([id, name]) => {
      const list = tasks.filter(t => lane(t) === id);
      if (id === 'done') list.reverse();
      return h('section', { class: `lane ${id}`, ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('over'); },
        ondragleave: e => e.currentTarget.classList.remove('over'),
        ondrop: e => { e.currentTarget.classList.remove('over'); if (dragId && id === 'done') post('move', { id: dragId, status: 'done' }); else if (dragId && id === 'todo') post('reorder', { id: dragId }); } },
        h('h2', {}, name, h('span', { class: 'count' }, list.length)),
        list.length ? list.map((t, i) => card(t, id === 'todo' ? i + 1 : 0)) : h('p', { class: 'muted small hint' }, hint(id)));
    }));
  }
  const hint = id => ({ todo: 'Add a task above.', work: 'Running tasks show here.', needs: 'Approvals and questions land here.', review: 'Finished work waits here for review and merge.', done: 'Merged tasks.' })[id];

  function card(t, n) {
    const nx = next(t);
    const el = h('article', { class: `card tone-${nx.tone}${open === t.id ? ' sel' : ''}`, draggable: t.status === 'todo' ? 'true' : undefined, 'data-id': t.id,
      onclick: () => openTask(t.id), ondragstart: () => { dragId = t.id; }, ondragend: () => { dragId = undefined; },
      ondragover: e => { if (dragId && dragId !== t.id && t.status === 'todo') e.preventDefault(); },
      ondrop: e => { if (dragId && dragId !== t.id && t.status === 'todo') { e.stopPropagation(); post('reorder', { id: dragId, before: t.id }); } } },
      h('div', { class: 'ctop' }, n ? h('span', { class: 'num' }, n) : '', h('span', { class: 'ttl' }, t.title)),
      h('div', { class: 'meta' },
        t.agent ? h('span', { class: 'tag' }, t.agent) : '',
        h('span', { class: `tag mode-${t.mode}` }, modeName(t.mode)),
        t.where === 'root' ? h('span', { class: 'tag' }, 'project folder') : '',
        t.images?.length ? h('span', { class: 'tag' }, `🖼 ${t.images.length}`) : '',
        t.agents?.length > 1 ? h('span', { class: 'tag' }, `${t.agents.length - 1} subagent${t.agents.length > 2 ? 's' : ''}`) : '',
        t.costUsd ? h('span', { class: 'tag', title: 'Estimated at API prices; a Claude plan is not billed per task' }, `~$${t.costUsd.toFixed(2)}`) : ''),
      h('div', { class: `next ${nx.tone}` }, nx.text),
      ...(t.asks || []).map(a => askBox(t, a)),
      nx.action ? h('div', { class: 'acts' }, btn(nx.action[0], nx.action[1], 'primary')) : '');
    return el;
  }

  /* ---------- approvals and questions ---------- */
  function askBox(t, a) {
    if (a.kind === 'question') return questionBox(t, a);
    let reason;
    const box = h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      h('div', { class: 'askhead' }, h('b', {}, a.tool), a.reason ? h('span', { class: 'muted small' }, ` · ${a.reason}`) : ''),
      a.detail ? h('pre', { class: 'askdetail' }, a.detail) : '',
      h('div', { class: 'acts' },
        btn('Allow', () => post('answer', { id: t.id, ask: a.id, choice: 'allow' }), 'primary'),
        a.always ? btn(a.always, () => post('answer', { id: t.id, ask: a.id, choice: 'always' }), '', 'Remembered for every task in this project (⚙ Settings lists them)') : '',
        btn('Deny…', () => { reason.hidden = !reason.hidden; reason.querySelector('input').focus(); }, 'danger')),
      reason = h('div', { class: 'row', hidden: true },
        h('input', { class: 'grow', placeholder: 'Tell Claude why, or what to do instead (optional)', onkeydown: e => { if (e.key === 'Enter') send(); } }),
        btn('Deny', () => send(), 'danger')));
    function send() { post('answer', { id: t.id, ask: a.id, choice: 'deny', message: reason.querySelector('input').value }); }
    return box;
  }

  function questionBox(t, a) {
    const picked = a.questions.map(() => new Set());
    const other = a.questions.map(() => '');
    const box = h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      a.questions.map((q, i) => h('div', { class: 'q' },
        h('div', {}, q.header ? h('span', { class: 'tag' }, q.header) : '', ' ', h('b', {}, q.question)),
        h('div', { class: 'opts' }, q.options.map(o => h('label', { class: 'opt', title: o.description || '' },
          h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${a.id}-${i}`, onchange: e => {
            if (!q.multiSelect) picked[i].clear();
            e.target.checked ? picked[i].add(o.label) : picked[i].delete(o.label);
          } }), ' ', o.label, o.description ? h('span', { class: 'muted small' }, ` — ${o.description}`) : ''))),
        h('input', { class: 'other', placeholder: 'Or type your own answer', oninput: e => { other[i] = e.target.value; } }))),
      h('div', { class: 'acts' },
        btn('Answer', () => {
          const answers = {};
          a.questions.forEach((q, i) => { answers[q.question] = other[i].trim() || [...picked[i]].join(', '); });
          if (Object.values(answers).some(v => !v)) return;
          post('answer', { id: t.id, ask: a.id, choice: 'allow', answers });
        }, 'primary'),
        btn('Skip', () => post('answer', { id: t.id, ask: a.id, choice: 'deny', message: 'The user skipped the question. Use your best judgement.' }), 'ghost')));
    return box;
  }

  /* ---------- task drawer ---------- */
  function openTask(id, t2) {
    open = id; if (t2) tab = t2;
    remember();
    post('watch', { id });
    if (tab === 'changes') post('changes', { id });
    render();
  }
  function closeTask() { open = undefined; remember(); post('watch', { id: undefined }); render(); }

  const drawer = $('#drawer');
  const msg = h('textarea', { id: 'msg', rows: 2, placeholder: 'Message Claude…  Enter sends · Shift+Enter new line', onkeydown: e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
  } });
  function sendMsg() { const text = msg.value.trim(); if (!text || !open) return; post('say', { id: open, text }); msg.value = ''; }
  const body = h('div', { class: 'dbody' });
  const head = h('div', { class: 'dhead' });
  drawer.append(head, body, h('div', { class: 'dfoot' }, msg, h('div', { class: 'col' }, btn('Send', sendMsg, 'primary'), btn('Stop step', () => post('interrupt', { id: open }), 'ghost', 'Interrupt what Claude is doing now (Esc)'))));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open && document.activeElement === msg) post('interrupt', { id: open }); else if (e.key === 'Escape' && open && !$('#dlg').open) closeTask(); });

  function renderDrawer() {
    const t = open && S.board.tasks.find(x => x.id === open);
    drawer.classList.toggle('on', !!t);
    document.body.classList.toggle('drawer-open', !!t);
    if (!t) return;
    const nx = next(t);
    const live = t.run && t.run !== 'idle';
    const menu = [
      t.status === 'todo' && ['▶ Run', () => post('run', { id: t.id })],
      live && ['■ Stop', () => post('stop', { id: t.id })],
      t.sessionId && !t.remote && ['📱 Continue on phone', () => post('remote', { id: t.id })],
      t.sessionId && !t.remote && ['⌨ Open in terminal', () => post('claudeCode', { id: t.id })],
      t.worktree && ['Changes', () => { tab = 'changes'; post('changes', { id: t.id }); render(); }],
      t.worktree && t.status !== 'done' && ['✓ Merge', () => post('merge', { id: t.id })],
      t.worktree && !t.reviewing && t.status === 'review' && ['Review again', () => post('review', { id: t.id })],
      t.reviewing && ['Cancel review', () => post('cancelReview', { id: t.id })],
      t.conflicts?.length && ['Mark resolved', () => post('resolved', { id: t.id })],
      t.worktree && ['Open its folder', () => post('openFolder', { id: t.id })],
      t.worktree && !t.pr && ['Push PR', () => post('remotePr', { id: t.id })],
      t.pr && ['Open PR', () => post('openUrl', { url: t.pr })],
      t.worktree && ['Discard work', () => post('discard', { id: t.id }), 'danger'],
      [t.archived ? 'Unarchive' : 'Archive', () => post('archive', { id: t.id })],
      ['Delete', () => post('delete', { id: t.id }), 'danger'],
    ].filter(Boolean);
    head.replaceChildren(
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, t.title), btn('×', closeTask, 'ghost icon', 'Close (Esc)')),
      h('div', { class: `next ${nx.tone}` }, nx.text, nx.action ? btn(nx.action[0], nx.action[1], 'primary') : ''),
      h('div', { class: 'row small' },
        h('label', {}, 'Permissions ', h('select', { onchange: e => post('setMode', { id: t.id, mode: e.target.value }) }, MODES.map(([v, l, d]) => h('option', { value: v, title: d, selected: (t.mode) === v }, l)))),
        t.modeNote ? h('span', { class: 'warn' }, t.modeNote) : '',
        t.branch ? h('span', { class: 'muted' }, `⎇ ${t.branch}`) : '',
        t.output ? h('span', { class: 'muted' }, `${tok(t.context + t.output)}`) : ''),
      h('div', { class: 'acts wrap' }, menu.map(([l, f, c]) => btn(l, f, c || 'ghost'))),
      ...(t.asks || []).map(a => askBox(t, a)),
      h('nav', { class: 'tabs' }, [['activity', 'Activity'], ['agents', `Agents${t.agents?.length > 1 ? ` (${t.agents.length})` : ''}`], ['changes', 'Changes'], ['review', 'Review'], ['details', 'Details']]
        .map(([k, l]) => h('a', { class: tab === k ? 'on' : '', onclick: () => { tab = k; if (k === 'changes') post('changes', { id: t.id }); if (k === 'review' && t.review?.screenshots?.length) post('shots', { id: t.id }); render(); } }, l))));
    body.replaceChildren(...drawerBody(t));
    msg.placeholder = t.status === 'todo' ? 'Run the task first, or edit it under Details' : t.remote ? 'This task is in Remote Control' : 'Message Claude…  Enter sends · Shift+Enter new line';
  }

  function drawerBody(t) {
    if (tab === 'agents') return [agentTree([{ name: t.title, tasks: [t] }], true)];
    if (tab === 'changes') {
      const files = changes[t.id];
      if (!t.worktree) return [h('p', { class: 'muted' }, t.where === 'root' ? 'This task runs in the project folder: its changes are in your working tree.' : 'No changes yet.')];
      if (!files) return [h('p', { class: 'muted' }, 'Loading…')];
      if (!files.length) return [h('p', { class: 'muted' }, 'No changes on this branch yet.')];
      return [h('ul', { class: 'files' }, files.map(f => h('li', { onclick: () => post('diff', { id: t.id, file: f.file }), title: 'Open side-by-side diff' }, h('span', { class: `st st-${f.status}` }, f.status), f.file)))];
    }
    if (tab === 'review') {
      const r = t.review;
      if (!r) return [h('p', { class: 'muted' }, t.reviewing ? 'The AI reviewer is testing this change…' : S.settings.review.auto ? 'Reviewed automatically when Claude finishes.' : 'AI review is off (⚙ Settings).'), t.worktree && !t.reviewing ? btn('Review now', () => post('review', { id: t.id })) : ''];
      return [
        h('p', {}, h('b', {}, { pass: '✓ Passed', fail: '✗ Issues found', error: 'Review could not run', running: 'Reviewing…' }[r.state]), r.risk === 'critical' ? h('span', { class: 'warn' }, ' · flagged critical') : '', h('span', { class: 'muted' }, ` · round ${r.attempts || 1}`)),
        r.error ? h('pre', { class: 'err' }, r.error) : '',
        r.issues?.length ? h('ol', { class: 'issues' }, r.issues.map(i => h('li', {}, i))) : '',
        r.tested?.length ? h('p', { class: 'muted small' }, 'Tested: ', r.tested.join(' · ')) : '',
        r.state === 'fail' ? btn('Send these to Claude', () => post('sendIssues', { id: t.id }), 'primary') : '',
        h('div', { class: 'shots' }, (shots[t.id] || []).map(s => h('img', { src: s.data, title: s.name }))),
      ];
    }
    if (tab === 'details') {
      const editable = t.status === 'todo';
      let title, desc;
      return [
        h('label', { class: 'blk' }, 'Title', title = h('input', { value: t.title, disabled: !editable })),
        h('label', { class: 'blk' }, 'Details', desc = h('textarea', { rows: 8, disabled: !editable }, t.description || '')),
        editable ? btn('Save', () => post('editTask', { id: t.id, patch: { title: title.value, description: desc.value } }), 'primary') : h('p', { class: 'muted small' }, 'Started tasks keep their text; message Claude instead.'),
        t.images?.length ? h('p', { class: 'muted small' }, `${t.images.length} screenshot(s) attached.`) : '',
        h('p', { class: 'muted small' }, `Created ${new Date(t.created).toLocaleString()}${t.sessionId ? ` · session ${t.sessionId.slice(0, 8)}` : ''}${t.costUsd ? ` · ~$${t.costUsd.toFixed(2)} at API prices` : ''}`),
      ];
    }
    const list = steps[t.id] || [];
    if (!list.length) return [h('p', { class: 'muted' }, t.status === 'todo' ? 'Not started yet. Press ▶ Run.' : 'No activity yet.')];
    const el = h('div', { class: 'log' }, list.map(s => h('div', { class: `step ${s.kind}` },
      h('span', { class: 'k' }, { user: 'you', say: 'claude', tool: s.agent ? `↳ ${s.agent}` : 'tool', result: '', error: 'error', info: 'note' }[s.kind]),
      s.kind === 'say' || s.kind === 'user' ? h('div', { class: 'txt' }, s.text) : h('code', {}, s.text))));
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    return [el];
  }

  /* ---------- agent map ---------- */
  function agentTree(groups, single) {
    const row = (n, depth, extra = '') => h('div', { class: `node d${Math.min(depth, 4)} s-${n.status}` },
      h('span', { class: 'sdot' }), h('div', { class: 'ninfo' }, h('b', {}, n.name), n.description && n.description !== n.name ? h('span', { class: 'muted' }, ` · ${n.description.slice(0, 90)}`) : '',
        h('div', { class: 'muted small' }, [n.ms || n.started ? (n.status === 'running' ? ago(n.started) : ago(Date.now() - (n.ms || 0))) : '', n.tokens ? tok(n.tokens) : '', n.tools ? `${n.tools} tool uses` : '', n.last && n.status === 'running' ? `now: ${n.last}` : '', extra].filter(Boolean).join(' · ')),
        n.summary ? h('div', { class: 'small' }, n.summary) : ''));
    const out = [];
    for (const g of groups) {
      if (!single) out.push(h('h4', {}, g.name));
      for (const t of g.tasks) {
        const nodes = t.agents || [];
        const kids = p => nodes.filter(n => n.parent === p);
        const walk = (p, d) => kids(p).flatMap(n => [row(n, d), ...walk(n.id, d + 1)]);
        const main = nodes.find(n => n.id === 'main');
        const status = t.asks?.length ? 'waiting' : t.run === 'running' || t.run === 'starting' ? 'running' : main ? 'completed' : 'idle';
        out.push(h('div', { class: 'tree', onclick: single ? undefined : () => { $('#dlg').close(); if (g.root !== S.root) post('root', { root: g.root }); openTask(t.id, 'agents'); } },
          row({ ...(main || {}), name: single ? 'Task session' : t.title, description: single ? '' : t.status, status, started: main?.started }, 0, t.asks?.length ? 'needs you' : ''),
          walk('main', 1),
          t.reviewing ? row({ name: 'AI reviewer', description: 'tests and reviews the diff', status: 'running', started: t.reviewing }, 1) : ''));
      }
    }
    if (!out.length) out.push(h('p', { class: 'muted' }, 'No agents at work right now.'));
    return h('div', { class: 'agentmap' }, out);
  }

  function agentMap() {
    const groups = (S.all || []).filter(g => g.tasks.length);
    const n = groups.reduce((a, g) => a + g.tasks.reduce((b, t) => b + Math.max(1, t.agents?.length || 0) + (t.reviewing ? 1 : 0), 0), 0);
    dialog('Agent map', h('p', { class: 'muted' }, `${n} agent${n === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'} · click a task for details`), agentTree(groups, false));
  }

  /* ---------- dialogs ---------- */
  function dialog(title, ...content) {
    const d = $('#dlg');
    d.replaceChildren(h('div', { class: 'dlghead' }, h('h3', {}, title), btn('×', () => d.close(), 'ghost icon')), h('div', { class: 'dlgbody' }, content));
    if (!d.open) d.showModal();
    return d;
  }

  function newSprint() {
    let name, goal;
    dialog('New sprint', name = h('input', { placeholder: 'Sprint name', value: `Sprint ${S.board.sprints.length + 1}` }), goal = h('input', { placeholder: 'Goal (optional)' }),
      h('div', { class: 'acts' }, btn('Create', () => { if (name.value.trim()) { post('addSprint', { name: name.value.trim(), goal: goal.value }); $('#dlg').close(); } }, 'primary')));
    name.select();
  }

  function planDialog() {
    let goal, sprint, mode;
    dialog('Plan with Claude',
      h('p', { class: 'muted' }, 'Describe a goal. Claude reads the code (read-only) and proposes small tasks; you pick which to add.'),
      goal = h('textarea', { rows: 5, placeholder: 'e.g. Add password reset by email, with tests' }),
      h('div', { class: 'row' },
        h('label', {}, 'Add to ', sprint = h('select', {}, h('option', { value: '' }, 'Backlog'), ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id }, s.name)), h('option', { value: '__new' }, 'New sprint…'))),
        h('label', {}, 'Permissions ', mode = h('select', {}, MODES.map(([v, l]) => h('option', { value: v, selected: v === S.settings.defaultMode }, l))))),
      h('div', { class: 'acts' }, btn('Plan', () => {
        if (!goal.value.trim()) return goal.focus();
        const ns = sprint.value === '__new' ? `Sprint ${S.board.sprints.length + 1}` : undefined;
        post('plan', { goal: goal.value.trim(), sprintId: ns ? undefined : sprint.value, newSprint: ns, mode: mode.value });
        $('#dlg').close();
      }, 'primary')));
    goal.focus();
  }

  function settings() {
    const s = S.settings;
    const f = {};
    const field = (key, label, input, help) => h('label', { class: 'blk' }, h('span', {}, label), f[key] = input, help ? h('span', { class: 'muted small' }, help) : '');
    const sel = (v, opts) => h('select', {}, opts.map(([k, l]) => h('option', { value: k, selected: String(v) === String(k) }, l)));
    const models = v => h('input', { value: v, placeholder: 'opus, sonnet, haiku or a model id', list: 'models' });
    let rules;
    dialog('Settings',
      h('datalist', { id: 'models' }, ['opus', 'sonnet', 'haiku'].map(m => h('option', { value: m }))),
      h('div', { class: 'grid' },
        field('defaultMode', 'Permissions for new tasks', sel(s.defaultMode, MODES.map(([k, l]) => [k, l])), 'Auto lets Claude approve what is safe; the card asks only when unsure.'),
        field('maxParallel', 'Tasks at once (Run all)', sel(s.maxParallel, [1, 2, 3, 4, 5, 6].map(n => [n, n === 1 ? '1 · one after another' : String(n)]))),
        field('taskModel', 'Task model', models(s.taskModel)),
        field('reviewModel', 'Reviewer model', models(s.review.model)),
        field('plannerModel', 'Planner model', models(s.plannerModel)),
        field('maxReviews', 'Review rounds before it waits for you', sel(s.review.maxAttempts, [1, 2, 3, 4, 5].map(n => [n, String(n)]))),
        field('autoReview', 'AI review', sel(s.review.auto, [[true, 'On: review every finished task'], [false, 'Off']])),
        field('autoMerge', 'When the review passes', sel(s.review.autoMerge, [[false, 'Wait for me to merge'], [true, 'Merge automatically (not critical ones)']])),
        field('mergeIfReviewCannotRun', 'When the review cannot run (twice)', sel(s.review.mergeIfCannotRun, [[true, 'Merge anyway (with automatic merging)'], [false, 'Wait for me']])),
        field('idleMinutes', 'Close idle Claude processes after (minutes)', h('input', { type: 'number', min: 1, value: s.idleMinutes }))),
      h('label', { class: 'blk' }, h('span', {}, `Always allowed in ${S.roots.find(r => r.path === S.root)?.name ?? 'this project'}`),
        rules = h('textarea', { rows: 4, placeholder: 'One rule per line, e.g. Bash(npm run:*)' }, (S.board.rules || []).join('\n')),
        h('span', { class: 'muted small' }, 'Added when you press "Always allow…" on a card. Every task in this project gets them.')),
      f.allowedTools = h('textarea', { rows: 3, placeholder: 'One rule per line, for every project' }, (s.allowedTools || []).join('\n')),
      h('span', { class: 'muted small' }, 'Always allowed in every project.'),
      h('div', { class: 'row' }, btn(s.apiKey ? 'Change or remove API key' : 'Use an API key instead of my Claude login', () => post('apiKey'), 'ghost'), btn('Setup checklist', () => { showSetup = true; $('#dlg').close(); render(); }, 'ghost')),
      h('div', { class: 'acts' }, btn('Save', () => {
        const lines = el => el.value.split('\n').map(x => x.trim()).filter(Boolean);
        post('settings', { values: {
          defaultMode: f.defaultMode.value, maxParallel: +f.maxParallel.value, taskModel: f.taskModel.value.trim(), reviewModel: f.reviewModel.value.trim(),
          plannerModel: f.plannerModel.value.trim(), maxReviews: +f.maxReviews.value, autoReview: f.autoReview.value === 'true', autoMerge: f.autoMerge.value === 'true', mergeIfReviewCannotRun: f.mergeIfReviewCannotRun.value === 'true',
          idleMinutes: Math.max(1, +f.idleMinutes.value || 10), allowedTools: lines(f.allowedTools),
        } });
        post('rules', { rules: lines(rules) });
        $('#mode').dataset.set = '';
        $('#dlg').close();
      }, 'primary')));
  }

  function guide() {
    const sec = (n, title, ...p) => h('section', { class: 'gsec' }, h('h4', {}, h('span', { class: 'gn' }, n), title), ...p.map(x => typeof x === 'string' ? h('p', {}, x) : x));
    dialog('JustCode in 2 minutes',
      sec(1, 'Set up once', 'The checklist at the top checks Claude Code, your sign-in and git, and fixes what is missing. Any folder works: an existing project, or an empty one (JustCode asks before creating a git repository).'),
      sec(2, 'Add a task', 'Type what you want and press ⌘/Ctrl+Enter to add and run it. "More" adds details, screenshots (paste them), an agent from .claude/agents, and permissions.'),
      sec(3, 'Claude works on its own branch', 'Every task gets its own copy of the project and its own branch, so your files and other tasks are never touched. Click a card to watch its activity, message Claude, or see its agents.'),
      sec(4, 'Approvals without babysitting', h('p', {}, h('b', {}, 'Auto'), ' (the default) lets Claude approve what is safe and ask only when unsure. A question or approval turns the card yellow under ', h('b', {}, 'Needs you'), ' with buttons: Allow, Always allow (remembered for the whole project), or Deny with a reason.'),
        'Other modes: Auto-edit (edits approved, commands ask), Ask me (everything asks), Plan only, Allow everything (no approvals; only for trusted work).'),
      sec(5, 'Review and merge', 'When Claude finishes, its work is committed and an AI reviewer runs the tests and checks the diff. Issues go back to Claude automatically. When the review passes, press ✓ Merge (or turn on automatic merging in ⚙). Conflicts stay on the task\'s branch until you or Claude resolve them.'),
      sec(6, 'Run a whole list', '▶ Run all runs every To do task in board order (drag cards to reorder), one at a time by default so each builds on the last merged one. Turn on automatic merging and a sprint runs unattended.'),
      sec(7, 'Continue on your phone', '📱 Continue on phone (in a task) moves its session to Claude Code Remote Control: open the Claude app or claude.ai/code to watch, answer and steer it. Close its terminal to bring the task back to the board. Needs a Claude account login.'),
      sec(8, 'Agent map', 'Agent map (top right) shows every Claude session, subagent and reviewer at work across your projects, with time and tokens.'),
      sec(9, 'Good to know', h('ul', {},
        h('li', {}, 'Closing the board never stops work. Closing VS Code pauses it; tasks that were mid-step continue when VS Code opens again.'),
        h('li', {}, 'Usage meter (top right) shows your 5-hour and weekly Claude limits. At the limit, tasks pause and continue after the reset.'),
        h('li', {}, '.env files are copied into each task\'s copy for tests, never committed. Keys, credentials and node_modules are kept out of git.'),
        h('li', {}, 'Everything is in .justcode/ in your project (board, task copies). Details: README.'))),
      h('div', { class: 'acts' }, btn('Got it', () => { post('guideSeen'); S.guideSeen = true; $('#dlg').close(); render(); }, 'primary')));
  }

  /* ---------- messages from the extension ---------- */
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') { S = m; if (open && !S.board?.tasks.some(t => t.id === open)) open = undefined; render(); }
    else if (m.type === 'steps') { steps[m.id] = m.steps; if (m.id === open && tab === 'activity') renderDrawer(); }
    else if (m.type === 'changes') { changes[m.id] = m.files; if (m.id === open) renderDrawer(); }
    else if (m.type === 'shots') { shots[m.id] = m.images; if (m.id === open) renderDrawer(); }
    else if (m.type === 'focus') openTask(m.id);
    else if (m.type === 'showSetup') { showSetup = true; render(); }
  });
  // Live timers (working for 2m 10s) tick without a state change.
  setInterval(() => { if (S && !S.empty && S.board.tasks.some(t => t.run === 'running' || t.reviewing)) { renderLanes(); if (open && tab === 'agents') renderDrawer(); } }, 5000);
  post('ready');
  if (open) post('watch', { id: open });
})();
