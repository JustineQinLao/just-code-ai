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
  let showSetup = false;
  const HEALTH = new Set(['board', 'policy', 'registry', 'worktrees', 'sources', 'transcripts']);   // checklist rows about the project's .justcode files
  let more = false;                        // new-task details open
  let images = [];                         // pasted screenshots for the new task
  let files = [];                          // files attached to the new task
  let srcOff = new Set();                  // project sources unticked for the new task
  let dragId;
  let initLater = saved.initLater || {};   // project root → the user chose "Not now" on the setup banner
  let artSeen = saved.artSeen || 0;             // newest artifact change you have seen in the Artifacts dialog
  const remember = () => vscode.setState({ view, open, initLater, artSeen });

  // Is this project described for JustCode? Set up = .justcode/project.md exists.
  // `running` is the setup task while it works.
  function initState() {
    const pr = S.project || {};
    const missing = [!pr.projectMd && 'a project description'].filter(Boolean);
    const running = S.board.tasks.find(t => t.init && !t.archived && t.status !== 'done');
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
  const dur = ms => ms ? ago(Date.now() - ms) : '';
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
  const next = t => window.JCStatus.nextStep(t, { settings: S.settings, queue: S.queue, policy: S.policy?.policy, tasks: S.board.tasks, post, open: JC.openTask, dur, lastTool });
  const lastTool = t => { const n = t.agents?.find(a => a.id === 'main'); return n?.last ? ` · ${n.last}` : '…'; };

  /* ---------- shell (rendered once) ---------- */
  const app = $('#app');
  app.append(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◆'), 'JustCode'),
      h('div', { id: 'projects', class: 'projects' }),
      h('div', { class: 'spacer' }),
      h('div', { id: 'meter', class: 'meter' }),
      btn('⚙', () => JC.settings(), 'ghost icon', 'Settings'),
      btn('?', () => JC.guide(), 'ghost icon', 'Guide')),
    h('div', { id: 'banners' }),
    h('section', { class: 'add' },
      h('div', { class: 'addrow' },
        complete(h('input', { id: 'title', class: 'grow', placeholder: 'What should Claude do?  / skills · @ files · Enter adds · ⌘/Ctrl+Enter adds and runs', oninput: e => {
          // A lone /command runs in the project folder; anything more is a normal task again.
          if (acRooted && !/^\/\S+\s*$/.test(e.target.value)) { $('#where').value = ''; acRooted = false; }
        }, onkeydown: e => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTask(e.metaKey || e.ctrlKey); }
        }, onpaste: pasteImages })),
        btn('Details ▾', () => toggleMore(), 'ghost', 'Details, a "Done when" checklist, files, sprint'),
        btn('Add', () => addTask(false), 'primary', 'Adds to To do. ⌘/Ctrl+Enter adds and runs it.')),
      h('div', { id: 'more', class: 'more', hidden: true },
        complete(h('textarea', { id: 'desc', rows: 2, placeholder: 'Goal and details. / skills · @ files · paste screenshots', onpaste: pasteImages })),
        h('textarea', { id: 'done', rows: 2, placeholder: 'Done when (one check per line), e.g.\nthe toggle persists after a reload\nnpm test passes' }),
        h('div', { id: 'imgs', class: 'imgs' }),
        h('div', { class: 'row' }, btn('📎 Attach files…', () => post('pickFiles'), 'ghost', 'Files or folders this task is based on (specs, designs, data)'), h('span', { id: 'files', class: 'chips' }),
          h('label', {}, 'Goes to ', h('select', { id: 'sprintSel' }))),
        h('div', { id: 'srcpick', class: 'chips' }),
        h('div', { id: 'skills', class: 'chips' }),
        h('details', { class: 'adv' }, h('summary', {}, 'Advanced'),
          h('div', { class: 'row' },
            h('label', {}, 'Agent ', h('select', { id: 'agent' })),
            h('label', {}, 'Permissions ', h('select', { id: 'mode' }, MODES.map(([v, l, d]) => h('option', { value: v, title: d }, l)))),
            h('label', { title: 'Code change: Claude edits the project. Artifact page: Claude designs one web page (with the frontend-design skill) and JustCode publishes it to claude.ai and puts the link on the card. Tasks that say "artifact" pick this by themselves.' }, 'Result ',
              h('select', { id: 'output' }, h('option', { value: '' }, 'Code change'), h('option', { value: 'artifact' }, 'Artifact page (link)'))),
            h('label', { title: 'Own branch: an isolated copy you review and merge. Workspace: runs in your checkout, reviewed, then Finish commits its files.' }, 'Runs in ',
              h('select', { id: 'where' }, h('option', { value: '' }, 'Automatic (backlog: workspace, sprint: own branch)'), h('option', { value: 'branch' }, 'Own branch (reviewed, merged)'), h('option', { value: 'direct' }, 'Workspace (direct, reviewed)'))))))),
    h('div', { id: 'toolbar', class: 'toolbar' }),
    h('div', { id: 'progress' }),
    h('main', { id: 'lanes', class: 'lanes' }));

  function toggleMore(on = !more) { more = on; $('#more').hidden = !more; }

  // Pasted screenshots: read as data URLs into `list`, shown as removable thumbnails in `box`. Text pastes as usual.
  /* ---------- / and @ menu on text boxes ---------- */
  let acData = { files: [], commands: [] }, acLoaded = false;
  let acField, acItems = [], acSel = 0, acDismissed = -1, acRooted = false;
  const acMenu = h('div', { class: 'ac', role: 'listbox', hidden: true });
  const acToken = el => {
    const m = el.value.slice(0, el.selectionStart).match(/(?:^|\s)([/@])([^\s]*)$/);
    return m && { kind: m[1], query: m[2].toLowerCase(), start: el.selectionStart - m[2].length - 1 };
  };
  // Commands match by substring only, so "/users" or "/Users/me" in a sentence closes the menu and Enter still submits.
  function acScore(q, name, fuzzy) {
    if (!q) return 1;
    const s = name.toLowerCase(), base = s.replace(/\/$/, '').split(/[/:]/).pop();
    if (base.startsWith(q)) return 5;
    if (base.includes(q)) return 4;
    if (s.includes(q)) return 3;
    if (!fuzzy) return 0;
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  }
  function acMatches(t) {
    if (t.kind === '/') {
      const all = acLoaded ? acData.commands : S?.skills || [];
      return all.map(c => ({ c, score: acScore(t.query, c.name) })).filter(x => x.score).sort((a, b) => b.score - a.score)
        .map(({ c }) => ({ label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` })).slice(0, 40);
    }
    const depth = p => p.replace(/\/$/, '').split('/').length;
    return acData.files.filter(f => f.toLowerCase() !== t.query).map(f => ({ f, score: acScore(t.query, f, true) })).filter(x => x.score)
      .sort((a, b) => b.score - a.score || depth(a.f) - depth(b.f) || a.f.localeCompare(b.f)).slice(0, 40)
      .map(({ f }) => ({ label: f, dir: f.endsWith('/') && !f.includes(' '), insert: f.endsWith('/') && !f.includes(' ') ? `@${f}` : f.includes(' ') ? `@"${f}" ` : `@${f} ` }));
  }
  function acHide() { acMenu.hidden = true; acField = undefined; acItems = []; }
  function acDraw() {
    const t = acField && acToken(acField);
    if (!t) return acHide();
    acItems = acMatches(t);
    acSel = Math.min(acSel, Math.max(acItems.length - 1, 0));
    const waiting = !acLoaded && t.kind === '@';
    if (!acItems.length && !waiting) { acMenu.hidden = true; return; }
    const rows = acItems.map((it, i) => h('div', { class: `acitem${i === acSel ? ' on' : ''}`, role: 'option', 'aria-selected': i === acSel ? 'true' : 'false', title: it.hint || it.label,
      onmousedown: e => { e.preventDefault(); acPick(i); } }, h('b', {}, it.label), it.hint ? h('span', { class: 'muted small' }, it.hint) : ''));
    acMenu.replaceChildren(...rows,
      waiting ? h('div', { class: 'acnote muted small' }, 'Loading files…') : '',
      t.kind === '/' && !S?.settings?.personalSetup ? h('div', { class: 'acnote muted small' }, 'Your personal skills and plugins are off for tasks. Turn on "Your personal Claude setup in tasks" in ⚙ to list them.') : '');
    (acField.closest('dialog') || document.body).append(acMenu); // a modal dialog covers anything outside it
    acMenu.hidden = false;
    const r = acField.getBoundingClientRect(), width = Math.min(Math.max(r.width, 340), innerWidth - 16), above = r.bottom + 270 > innerHeight && r.top > innerHeight - r.bottom;
    acMenu.style.cssText = `left:${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px;width:${width}px;${above ? `bottom:${innerHeight - r.top + 4}px` : `top:${r.bottom + 4}px`}`;
    acMenu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function acUpdate(el) {
    const t = acToken(el);
    if (!t || t.start === acDismissed) { if (!t) acDismissed = -1; if (acField === el) acHide(); return; }
    if (acField !== el) { acField = el; acSel = 0; post('completions'); }
    acDraw();
  }
  function acPick(i) {
    const el = acField, t = el && acToken(el), it = acItems[i];
    if (!t || !it) return acHide();
    const end = el.selectionStart;
    el.setRangeText(it.insert, t.start, end, 'end');
    if (el.id === 'title' && el.value.trim() === it.label) { $('#where').value = 'direct'; acRooted = true; }
    acSel = 0;
    it.dir ? acDraw() : acHide();
  }
  function complete(el) {
    el.addEventListener('input', () => { acSel = 0; acUpdate(el); });
    el.addEventListener('click', () => acUpdate(el));
    el.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) acUpdate(el); });
    el.addEventListener('blur', () => { if (acField === el) acHide(); });
    el.addEventListener('keydown', e => { // capture: runs before the box's own Enter handler
      if (acField !== el || acMenu.hidden || e.isComposing) return;
      if (e.key === 'ArrowDown' && acItems.length) { acSel = (acSel + 1) % acItems.length; acDraw(); }
      else if (e.key === 'ArrowUp' && acItems.length) { acSel = (acSel - 1 + acItems.length) % acItems.length; acDraw(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && acItems.length) acPick(acSel);
      else if (e.key === 'Escape') { acDismissed = acToken(el)?.start ?? -1; acHide(); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    return el;
  }

  function imagePaste(list, box) {
    const draw = () => box.replaceChildren(...list.map((im, i) => h('span', { class: 'thumb' }, h('img', { src: im.data }), btn('×', () => { list.splice(i, 1); draw(); }, 'x', 'Remove'))));
    return {
      draw,
      onpaste: e => {
        const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
        if (!files.length) return false;
        e.preventDefault();
        for (const f of files) {
          const rd = new FileReader();
          rd.onload = () => { list.push({ name: f.name || 'pasted.png', data: rd.result }); draw(); };
          rd.readAsDataURL(f);
        }
        return true;
      },
    };
  }
  function pasteImages(e) {
    if (imagePaste(images, $('#imgs')).onpaste(e)) toggleMore(true);
  }
  function drawImages() { imagePaste(images, $('#imgs')).draw(); }

  const base = f => f.split(/[\\/]/).filter(Boolean).pop() || f;
  function drawFiles() {
    $('#files').replaceChildren(...files.map((f, i) => h('span', { class: 'chip', title: f }, base(f), btn('×', () => { files.splice(i, 1); drawFiles(); }, 'x', 'Remove'))));
  }
  function addTask(start) {
    const title = $('#title').value.trim();
    if (!title) return $('#title').focus();
    const sprint = $('#sprintSel').value;
    const done = $('#done').value.split('\n').map(x => x.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
    const description = [$('#desc').value.trim(), done.length ? `Done when:\n${done.map(d => `- ${d}`).join('\n')}` : ''].filter(Boolean).join('\n');
    // "make an artifact…", "artifact of the API": the result is a published page, not a code change.
    const output = $('#output').value || (/\bartifacts?\b/i.test(`${title}\n${description}`) ? 'artifact' : '');
    post('addTask', { title, description, output, agent: $('#agent').value, mode: $('#mode').value, where: $('#where').value,
      sprintId: sprint || undefined, images, files, sources: sprintSrcs(sprint).map(s => s.id).filter(id => !srcOff.has(id)), start });
    $('#title').value = ''; $('#desc').value = ''; $('#done').value = ''; $('#output').value = ''; images = []; files = []; srcOff = new Set(); drawImages(); drawFiles(); renderAddOptions();
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
    renderProjects(); renderMeter(); renderBanners(); renderAddOptions(); renderToolbar(); renderProgress(); renderLanes(); JC.renderDrawer();
  }

  function renderProjects() {
    $('#projects').replaceChildren(...S.roots.map(p => h('span', { class: `proj${p.path === S.root ? ' on' : ''}`, title: p.path, onclick: () => { open = undefined; post('root', { root: p.path }); } },
      p.name, p.running ? h('b', { class: 'badge run' }, `▶${p.running}`) : '', p.waiting ? h('b', { class: 'badge warn' }, `●${p.waiting}`) : '',
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
      `Tasks pause and continue by themselves${l.reached?.resetsAt ? ` at ${new Date(l.reached.resetsAt).toLocaleTimeString()}` : ' after the reset'}.`, btn('Try now', () => post('resumeNow'))));
    const st = S.setup;
    if (st && (!st.ready || showSetup)) {
      const req = st.checks.filter(c => !c.optional || c.id === 'repo'), done = req.filter(c => c.ok).length;
      out.push(h('div', { class: 'setup' },
        h('div', { class: 'row' }, h('h3', {}, st.ready ? '✓ All set' : `Get set up · ${done} of ${req.length}`), h('div', { class: 'spacer' }),
          btn('Check again', () => post('fix', { action: 'recheck' }), 'ghost'), st.ready ? btn('Hide', () => { showSetup = false; render(); }, 'ghost') : ''),
        h('ul', {}, st.checks.map(c => h('li', { class: c.ok ? 'ok' : c.optional ? 'opt' : 'bad' },
          h('span', { class: 'dot' }, c.ok ? '✓' : c.optional ? '○' : '✗'), h('b', {}, c.label), h('span', { class: 'muted' }, c.detail),
          !c.ok && c.fix ? btn(c.fix.label, () => post('fix', { action: c.fix.action }), c.optional ? '' : 'primary') : ''))),
        h('p', { class: 'muted small' }, st.remote ? '📱 Remote Control is available: any task can continue on your phone.' : 'Remote Control (continue on your phone) needs a Claude account login.')));
    } else if (!st) out.push(h('div', { class: 'banner' }, 'Checking your setup…'));
    else if (!REMOTE) {
      const sick = st.checks.filter(c => !c.ok && HEALTH.has(c.id));
      if (sick.length) out.push(h('div', { class: 'banner warn' }, h('div', { class: 'grow' }, h('b', {}, `${sick.length === 1 ? sick[0].label : `${sick.length} project file problems`}: `), sick[0].detail),
        btn(sick.length === 1 ? sick[0].fix.label : 'Show', () => sick.length === 1 ? post('fix', { action: sick[0].fix.action }) : (showSetup = true, render()), 'ghost')));
    }
    const init = initState();
    if (st?.ready && init.running && init.running.asks?.length) out.push(h('div', { class: 'banner warn' }, h('div', { class: 'grow' }, h('b', {}, 'Project setup needs you. '), 'Claude is asking a question about this project.'),
      btn('Answer', () => JC.openTask(init.running.id), 'primary')));
    else if (st?.ready && !init.done && !init.running && !initLater[S.root]) out.push(h('div', { class: 'banner info' }, h('div', { class: 'grow' }, h('b', {}, 'This project is not set up for Claude yet. '),
      `It is missing ${andList(init.missing)}. Claude reads the code, asks you a few questions, shows the files it will write, and writes them after you approve. Tasks then follow your conventions and come with a "Done when" checklist.`),
      btn('Set up project', () => post('initialize'), 'primary'), btn('Not now', () => { initLater[S.root] = true; remember(); render(); }, 'ghost', 'Hide for this project. The "Not set up" label at the top still sets it up.')));
    if (st?.ready && !S.guideSeen) out.push(h('div', { class: 'banner info' }, h('b', {}, 'New here? '), 'Add a task above and press ⌘/Ctrl+Enter. Claude works on its own branch; you answer on the card and merge when it passes review.',
      btn('2-minute guide', () => JC.guide(), 'ghost'), btn('Got it', () => { S.guideSeen = true; post('guideSeen'); render(); }, 'ghost')));
    $('#banners').replaceChildren(...out);
  }

  function renderAddOptions() {
    const ag = $('#agent'), cur = ag.value;
    ag.replaceChildren(h('option', { value: '' }, 'Default'), ...S.agents.map(a => h('option', { value: a.name, title: a.description }, `${a.name}${a.scope === 'user' ? ' (yours)' : ''}`)));
    ag.value = S.agents.some(a => a.name === cur) ? cur : '';
    if (!$('#where').dataset.set) { $('#where').value = ['direct', 'branch'].includes(S.settings.defaultWhere) ? S.settings.defaultWhere : ''; $('#where').dataset.set = '1'; }
    if (!$('#mode').dataset.set) { $('#mode').value = S.settings.defaultMode; $('#mode').dataset.set = '1'; }
    const sp = $('#sprintSel'), sc = sp.value, active = S.board.sprints.find(s => s.active && !s.closed);
    sp.replaceChildren(h('option', { value: '' }, 'Backlog'), ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id }, s.name)));
    sp.value = sc && S.board.sprints.some(s => s.id === sc) ? sc : (view !== 'all' && view !== 'backlog' ? view : active?.id ?? '');
    sp.onchange = () => { srcOff = new Set(); renderAddOptions(); };
    const srcs = sprintSrcs(sp.value);
    $('#srcpick').replaceChildren(...(srcs.length ? [h('span', { class: 'muted small' }, 'Based on:')] : []), ...srcs.map(s => h('label', { class: 'chip', title: s.note || s.ref },
      h('input', { type: 'checkbox', checked: !srcOff.has(s.id), onchange: e => { e.target.checked ? srcOff.delete(s.id) : srcOff.add(s.id); } }), ' ', srcLabel(s))));
    $('#skills').replaceChildren(...(S.skills.length ? [h('span', { class: 'muted small', title: 'Skills this task can use. Your personal skills appear when "Your personal Claude setup in tasks" is on (⚙).' }, 'Skills:')] : []),
      ...S.skills.map(({ name: n, description: d }) => h('span', { class: 'chip', title: `${d || 'No description'}\n\nClick to use it in this task.`, onclick: () => {
        const t = $('#title'); if (!t.value.trim()) t.value = `/${n}`; else $('#desc').value += `${$('#desc').value ? '\n' : ''}/${n}`;
        if (t.value.trim() === `/${n}`) $('#where').value = 'direct';
      } }, `/${n}`)));
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
    $('#toolbar').replaceChildren(
      h('select', { onchange: e => { view = e.target.value; remember(); render(); } },
        h('option', { value: 'all', selected: view === 'all' }, 'All tasks'), h('option', { value: 'backlog', selected: view === 'backlog' }, 'Backlog'),
        ...S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id, selected: view === s.id }, `${s.name}${s.active ? ' ★' : ''}`))),
      btn('+ Sprint', () => JC.newSprint(), 'ghost'),
      sprint && !sprint.active ? btn('Set active', () => post('activateSprint', { sprintId: sprint.id }), 'ghost') : '',
      sprint ? btn('Close sprint', () => post('closeSprint', { sprintId: sprint.id }), 'ghost') : '',
      sprint?.branch ? h('span', { class: 'muted small', title: `Tasks in ${sprint.name} merge into ${sprint.branch}. When the last one merges, it merges into ${sprint.target}.` }, `⎇ ${sprint.branch} → ${sprint.target}`) : '',
      sprint?.branch && tasks.length && tasks.every(t => t.status === 'done') ? btn(`Merge sprint into ${sprint.target}`, () => post('mergeSprint', { sprintId: sprint.id }), 'ghost') : '',
      view === 'backlog' && !showArchived && tasks.some(t => !t.worktree && t.status !== 'doing' && t.status !== 'review') ? btn('Clear backlog…', () => post('clearBacklog'), 'ghost', 'Archive every idle backlog task (asks first; undo with Show archived tasks)') : '',
      sprint ? btn('Delete sprint…', () => post('deleteSprint', { sprintId: sprint.id }), 'ghost', 'Remove this sprint (asks first). Its tasks move to the Backlog') : '',
      btn('✦ Plan', () => S.planner ? JC.openPlanner() : JC.planDialog(editable.map(t => t.id), sprint), 'ghost', 'Plan new tasks or rework the To do list with Claude'),
      sprint && editable.length ? btn(`✦ Edit sprint (${editable.length})`, () => S.planner ? JC.openPlanner() : JC.planDialog(editable.map(t => t.id), sprint, true), 'ghost', `Edit every not-started task in ${sprint.name} with one prompt`) : '',
      btn('🎨 Design', () => JC.designDialog(), 'ghost', 'The style spec UI and artifact tasks follow (.justcode/design/DESIGN.md)'),
      btn(`⧉ Artifacts${(S.registry || []).some(e => (e.changedAt || 0) > artSeen) ? ' •' : ''}`, () => JC.artifactsDialog(), 'ghost', 'Every claude.ai artifact this project used or published'),
      (n => btn(`📎 Sources${n ? ` (${n})` : ''}`, () => JC.sourcesDialog(), 'ghost', sprint ? `Specs, designs, docs and links ${sprint.name} is built on` : 'Specs, designs, docs and links tasks are based on'))(sprint ? sprintSrcs(sprint.id).length : (S.sources || []).length),
      h('div', { class: 'spacer' }),
      q.queued.length || q.blocker ? h('span', { class: 'queue' }, q.queued.length ? `${q.queued.length} queued` : '', q.blocker ? [' · next waits: ', h('a', { href: '#', title: 'Open this task', onclick: e => { e.preventDefault(); JC.openTask(q.blocker.id); } }, `“${q.blocker.title.slice(0, 40)}”`), ` ${q.blocker.why}`] : '',
        (n => q.queued.length && n.length ? [' · ', h('a', { href: '#', title: 'Run all goes on without these; open the first', onclick: e => { e.preventDefault(); JC.openTask(n[0].id); } }, `${n.length} need${n.length === 1 ? 's' : ''} you`)] : '')(tasks.filter(t => lane(t) === 'needs')),
        q.queued.length ? btn('Stop queue', () => post('cancelQueue'), 'ghost') : '') : '',
      showArchived ? btn('Showing archived ×', () => { showArchived = false; render(); }, 'ghost') : '',
      ready.length ? btn(`✓ Merge ready (${ready.length})`, () => post('mergeReady', { ids: ready.map(t => t.id) })) : '',
      btn(`▶ Run all${todo.length ? ` (${todo.length})` : ''}`, () => post('runAll', { ids: todo.map(t => t.id) }), 'primary', `Runs every To do task in board order, ${S.settings.maxParallel} at a time`),
      btn('🕘', () => JC.historyDialog(), 'ghost icon', 'Prompt history: every prompt you sent, and each session'),
      btn('⋯', () => JC.moreMenu(), 'ghost icon', 'Agent map, report, history, archived tasks'));
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
    $('#progress').replaceChildren(h('div', { class: 'sprintbar', title: parts.map(([, l, c]) => `${c} ${l}`).join(' · ') },
      h('div', { class: 'row' }, h('b', {}, sp.name), sp.goal ? h('span', { class: 'muted grow' }, sp.goal) : h('span', { class: 'grow' }),
        h('span', { class: 'small' }, `${done} of ${tasks.length} done · ${pct}%`),
        !REMOTE ? btn('Report', () => post('sprintReport', { sprintId: sp.id }), 'ghost small', 'Export this sprint\'s report (tasks, merges, cost, audit highlights, artifacts) to .justcode/reports') : '',
        (b => b ? h('span', { class: `small${b.max && b.spent >= b.max ? ' err' : ''}`, title: 'Estimated cost of this sprint\'s tasks and reviews, against maxCostUsd.sprint in .justcode/policy.json' }, ` · $${b.spent.toFixed(2)}${b.max ? ` / $${b.max}` : ''}`) : '')(sprintBudget(sp.id))),
      h('div', { class: 'bar', role: 'progressbar', 'aria-label': `${sp.name} progress`, 'aria-valuemin': '0', 'aria-valuemax': String(tasks.length), 'aria-valuenow': String(done) },
        parts.filter(([, , c]) => c).map(([id, , c]) => h('i', { class: `seg ${id}`, style: `flex:${c}` }))),
      h('div', { class: 'legend small muted' }, parts.filter(([, , c]) => c).map(([id, l, c]) => h('span', {}, h('i', { class: `dot ${id}` }), ` ${c} ${l}`)),
        S.queue.queued.length ? h('span', {}, ` · ▶ ${S.queue.queued.length} queued`) : '')));
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
    get more() { return more; }, set more(v) { more = v; },
    get images() { return images; }, set images(v) { images = v; },
    get files() { return files; }, set files(v) { files = v; },
    get srcOff() { return srcOff; }, set srcOff(v) { srcOff = v; },
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
    dur,
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
    toggleMore,
    get acData() { return acData; }, set acData(v) { acData = v; },
    get acLoaded() { return acLoaded; }, set acLoaded(v) { acLoaded = v; },
    get acField() { return acField; }, set acField(v) { acField = v; },
    get acItems() { return acItems; }, set acItems(v) { acItems = v; },
    get acSel() { return acSel; }, set acSel(v) { acSel = v; },
    get acDismissed() { return acDismissed; }, set acDismissed(v) { acDismissed = v; },
    get acRooted() { return acRooted; }, set acRooted(v) { acRooted = v; },
    acMenu,
    acToken,
    acScore,
    acMatches,
    acHide,
    acDraw,
    acUpdate,
    acPick,
    complete,
    imagePaste,
    pasteImages,
    drawImages,
    base,
    drawFiles,
    addTask,
    render,
    renderProjects,
    setupPill,
    renderMeter,
    renderBanners,
    renderAddOptions,
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
      if ($('#dlg').open && $('#dlg').dataset.kind === 'sources') JC.sourcesDialog();
      if ($('#dlg').open && $('#dlg').dataset.kind === 'artifacts') JC.artifactsDialog();
    }
    else if (m.type === 'completions') { acData = m; acLoaded = true; if (acField) acDraw(); }
    else if (m.type === 'history') { history = m.items; if ($('#dlg').open && !JC.sessionView) JC.drawHistory(); }
    else if (m.type === 'sessionLog') { if (JC.sessionView?.id === m.sessionId) { JC.sessionView.steps = m.steps; JC.drawHistory(); } }
    else if (m.type === 'steps') { steps[m.id] = m.steps; if (m.id === open && tab === 'activity') JC.renderDrawer(); }
    else if (m.type === 'savedAgents') { agentsSaved[m.id] = m.nodes; if (m.id === open && tab === 'agents' && !agentView) JC.renderDrawer(); }
    else if (m.type === 'agentLog') { if (agentView?.task === m.id) { agentView.log = m; if (m.id === open && tab === 'agents') JC.renderDrawer(); } }
    else if (m.type === 'changes') { changes[m.id] = m.files; if (m.id === open) JC.renderDrawer(); }
    else if (m.type === 'shots') { shots[m.id] = m.images; if (m.id === open) JC.renderDrawer(); }
    else if (m.type === 'focus') JC.openTask(m.id);
    else if (m.type === 'usedSource') { srcOff.delete(m.sourceId); renderAddOptions(); }
    else if (m.type === 'picked') { files.push(...m.files.filter(f => !files.includes(f))); toggleMore(true); drawFiles(); }
    else if (m.type === 'dialog') JC.bridged(m);
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
