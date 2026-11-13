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
  let more = false;                        // new-task details open
  let images = [];                         // pasted screenshots for the new task
  let files = [];                          // files attached to the new task
  let srcOff = new Set();                  // project sources unticked for the new task
  let dragId;
  let initLater = saved.initLater || {};   // project root → the user chose "Not now" on the setup banner
  const remember = () => vscode.setState({ view, open, initLater });

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
  const srcLabel = s => s.kind === 'url' ? s.ref.replace(/^https?:\/\//, '').slice(0, 40) : (s.ref.split(/[\\/]/).filter(Boolean).pop() || s.ref) + (s.kind === 'folder' ? '/' : '');
  // Claude Code's own names for its permission modes (code.claude.com/docs/en/permission-modes).
  const MODES = [['auto', 'Auto', 'A classifier approves safe actions; risky ones ask'], ['acceptEdits', 'Edit automatically', 'File edits and simple file commands approved; other commands ask'],
    ['default', 'Manual', 'Only reads run; every edit and command asks'], ['plan', 'Plan', 'Read-only'], ['bypassPermissions', 'Bypass permissions ⚠', 'No approvals at all']];
  const modeName = m => (MODES.find(x => x[0] === m) || [m, m])[1];
  // claude-opus-5-5 → Opus 5.5; anything else as it is.
  const modelName = id => { const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id || ''); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id; };

  /* ---------- lanes and what each card says ---------- */
  function lane(t) {
    if (t.status === 'done') return 'done';
    if (t.status === 'todo' && !t.run) return 'todo';
    if (t.asks?.length || t.error || t.conflicts?.length) return 'needs';
    const max = S.settings.review.maxAttempts;
    if (t.status === 'review' && t.review?.state === 'fail' && t.review.attempts >= max) return 'needs';
    if (t.status === 'review' && t.checks?.state === 'fail' && !t.phase) return 'needs';
    if (t.phase) return 'work';
    if (t.status === 'review' && !t.review && !t.reviewing && t.reply && t.where !== 'root' && !t.run) return 'needs';
    if (t.run && t.run !== 'idle' || t.remote || t.limited || t.status === 'doing') return 'work';
    return 'review';
  }

  // { text, tone, action: [label, fn] } — the one thing a card tells you, and the one button for it.
  function next(t) {
    const max = S.settings.review.maxAttempts, r = t.review;
    if (t.status === 'done') return t.review?.unreviewed ? { text: 'Merged without a finished review (the reviewer could not run)', tone: 'warn' } : { text: t.where === 'root' ? 'Done' : 'Merged', tone: 'ok' };
    if (t.asks?.length) return { text: t.asks[0].kind === 'question' ? 'Claude has a question for you' : t.asks[0].kind === 'plan' ? 'Plan ready for your OK' : 'Claude needs your approval', tone: 'warn' };
    if (t.phase) return { text: t.phase, tone: 'run' };
    if (t.run === 'starting') return { text: 'Starting Claude…', tone: 'run' };
    if (t.run === 'running') return { text: `Working${lastTool(t)}`, tone: 'run', action: ['Open', () => openTask(t.id)] };
    if (t.remote) return { text: 'In Remote Control: continue in the Claude app or claude.ai/code. Close its terminal to bring it back.', tone: 'run' };
    if (t.limited) return { text: 'Paused by the usage limit. Continues by itself after the reset.', tone: 'muted' };
    if (t.error) return { text: `Stopped: ${t.error}`, tone: 'err', action: ['↻ Resume', () => post('say', { id: t.id, text: 'Continue the task.' })] };
    if (t.status === 'todo') return t.queued ? { text: `Queued #${S.queue.queued.indexOf(t.id) + 1}${S.queue.blocker ? ` · waits for “${S.queue.blocker.title.slice(0, 40)}”, which ${S.queue.blocker.why}` : ''}`, tone: 'muted', action: ['▶ Run now', () => post('runNow', { id: t.id })] } : { text: 'Ready', tone: 'muted', action: ['▶ Run', () => post('run', { id: t.id })] };
    if (t.conflicts?.length) return { text: `Conflicts with ${t.base} in ${t.conflicts.length} file(s)`, tone: 'err', action: ['Resolve with Claude', () => post('resolve', { id: t.id })] };
    if (t.status === 'review' && t.checks?.state === 'fail') return { text: `Checks still fail: ${t.checks.results.filter(r => !r.ok && !r.preexisting).map(r => r.name).join(', ')}`, tone: 'err', action: ['Send to Claude', () => post('sendChecks', { id: t.id })] };
    if (t.reviewing) return { text: `AI reviewer is testing it · ${dur(t.reviewing)}`, tone: 'run' };
    if (t.status === 'doing') return r?.state === 'fail' ? { text: `Fixing review issues (round ${r.attempts} of ${max})`, tone: 'run' } : { text: 'Paused', tone: 'muted', action: ['↻ Resume', () => post('say', { id: t.id, text: 'Continue the task.' })] };
    if (t.output === 'artifact') {
      if (t.publishing) return { text: 'Publishing the page to claude.ai…', tone: 'run' };
      if (t.artifactUrl) return { text: 'Artifact published. Message Claude to change it; the same link updates.', tone: 'ok', action: ['⧉ Open artifact', () => post('openUrl', { url: t.artifactUrl })], extra: ['✓ Done', () => post('move', { id: t.id, status: 'done' })] };
      if (t.status !== 'todo') return { text: 'Finished without a published page.', tone: 'warn', action: ['Publish', () => post('publishArtifact', { id: t.id })], extra: ['Reply', () => openTask(t.id, 'activity')] };
    }
    if (t.where === 'root') return { text: 'Finished. Check the result, then mark it done.', tone: 'ok', action: ['✓ Done', () => post('move', { id: t.id, status: 'done' })] };
    if (r?.state === 'pass') return { text: r.risk === 'critical' ? 'Review passed, flagged critical: look before merging' : 'Review passed. Ready to merge.', tone: r.risk === 'critical' ? 'warn' : 'ok', action: ['✓ Merge', () => post('merge', { id: t.id })] };
    if (r?.state === 'fail' && r.attempts >= max) return { text: `Review still finds ${r.issues?.length ?? 0} issue(s) after ${r.attempts} rounds`, tone: 'err', action: ['Send to Claude', () => post('sendIssues', { id: t.id })] };
    if (r?.state === 'error') return { text: `Review could not run: ${r.error ?? ''}`, tone: 'err', action: ['↻ Retry review', () => post('review', { id: t.id })], extra: t.worktree ? ['✓ Merge anyway', () => post('merge', { id: t.id })] : undefined };
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
      btn('⚙', () => settings(), 'ghost icon', 'Settings'),
      btn('?', () => guide(), 'ghost icon', 'Guide')),
    h('div', { id: 'banners' }),
    h('section', { class: 'add' },
      h('div', { class: 'addrow' },
        complete(h('input', { id: 'title', class: 'grow', placeholder: 'What should Claude do?  / skills · @ files · Enter adds · ⌘/Ctrl+Enter adds and runs', oninput: e => {
          // A lone /command runs in the project folder; anything more is a normal task again.
          if (acRooted && !/^\/\S+\s*$/.test(e.target.value)) { $('#where').value = 'branch'; acRooted = false; }
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
            h('label', { title: 'Own branch: an isolated copy you review and merge. Project folder: runs in the project itself (deploys, syncs, releases).' }, 'Runs in ',
              h('select', { id: 'where' }, h('option', { value: 'branch' }, 'Own branch (reviewed, merged)'), h('option', { value: 'root' }, 'Project folder'))))))),
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
    if (el.id === 'title' && el.value.trim() === it.label) { $('#where').value = 'root'; acRooted = true; }
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
    renderProjects(); renderMeter(); renderBanners(); renderAddOptions(); renderToolbar(); renderProgress(); renderLanes(); renderDrawer();
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
    if (st.running) return h('span', { class: 'pill run', title: 'Claude is setting up this project. Open the task to answer its questions.', onclick: () => openTask(st.running.id) }, '◌ Setting up…');
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
      const done = st.checks.filter(c => c.ok).length;
      out.push(h('div', { class: 'setup' },
        h('div', { class: 'row' }, h('h3', {}, st.ready ? '✓ All set' : `Get set up · ${done} of ${st.checks.length}`), h('div', { class: 'spacer' }),
          btn('Check again', () => post('fix', { action: 'recheck' }), 'ghost'), st.ready ? btn('Hide', () => { showSetup = false; render(); }, 'ghost') : ''),
        h('ul', {}, st.checks.map(c => h('li', { class: c.ok ? 'ok' : c.optional ? 'opt' : 'bad' },
          h('span', { class: 'dot' }, c.ok ? '✓' : c.optional ? '○' : '✗'), h('b', {}, c.label), h('span', { class: 'muted' }, c.detail),
          !c.ok && c.fix ? btn(c.fix.label, () => post('fix', { action: c.fix.action }), c.optional ? '' : 'primary') : ''))),
        h('p', { class: 'muted small' }, st.remote ? '📱 Remote Control is available: any task can continue on your phone.' : 'Remote Control (continue on your phone) needs a Claude account login.')));
    } else if (!st) out.push(h('div', { class: 'banner' }, 'Checking your setup…'));
    const init = initState();
    if (st?.ready && init.running && init.running.asks?.length) out.push(h('div', { class: 'banner warn' }, h('div', { class: 'grow' }, h('b', {}, 'Project setup needs you. '), 'Claude is asking a question about this project.'),
      btn('Answer', () => openTask(init.running.id), 'primary')));
    else if (st?.ready && !init.done && !init.running && !initLater[S.root]) out.push(h('div', { class: 'banner info' }, h('div', { class: 'grow' }, h('b', {}, 'This project is not set up for Claude yet. '),
      `It is missing ${andList(init.missing)}. Claude reads the code, asks you a few questions, shows the files it will write, and writes them after you approve. Tasks then follow your conventions and come with a "Done when" checklist.`),
      btn('Set up project', () => post('initialize'), 'primary'), btn('Not now', () => { initLater[S.root] = true; remember(); render(); }, 'ghost', 'Hide for this project. The "Not set up" label at the top still sets it up.')));
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
    sp.onchange = () => { srcOff = new Set(); renderAddOptions(); };
    const srcs = sprintSrcs(sp.value);
    $('#srcpick').replaceChildren(...(srcs.length ? [h('span', { class: 'muted small' }, 'Based on:')] : []), ...srcs.map(s => h('label', { class: 'chip', title: s.note || s.ref },
      h('input', { type: 'checkbox', checked: !srcOff.has(s.id), onchange: e => { e.target.checked ? srcOff.delete(s.id) : srcOff.add(s.id); } }), ' ', srcLabel(s))));
    $('#skills').replaceChildren(...(S.skills.length ? [h('span', { class: 'muted small', title: 'Skills this task can use. Your personal skills appear when "Your personal Claude setup in tasks" is on (⚙).' }, 'Skills:')] : []),
      ...S.skills.map(({ name: n, description: d }) => h('span', { class: 'chip', title: `${d || 'No description'}\n\nClick to use it in this task.`, onclick: () => {
        const t = $('#title'); if (!t.value.trim()) t.value = `/${n}`; else $('#desc').value += `${$('#desc').value ? '\n' : ''}/${n}`;
        if (t.value.trim() === `/${n}`) $('#where').value = 'root';
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
      btn('+ Sprint', () => newSprint(), 'ghost'),
      sprint && !sprint.active ? btn('Set active', () => post('activateSprint', { sprintId: sprint.id }), 'ghost') : '',
      sprint ? btn('Close sprint', () => post('closeSprint', { sprintId: sprint.id }), 'ghost') : '',
      sprint?.branch ? h('span', { class: 'muted small', title: `Tasks in ${sprint.name} merge into ${sprint.branch}. When the last one merges, it merges into ${sprint.target}.` }, `⎇ ${sprint.branch} → ${sprint.target}`) : '',
      sprint?.branch && tasks.length && tasks.every(t => t.status === 'done') ? btn(`Merge sprint into ${sprint.target}`, () => post('mergeSprint', { sprintId: sprint.id }), 'ghost') : '',
      view === 'backlog' && !showArchived && tasks.some(t => !t.worktree && t.status !== 'doing' && t.status !== 'review') ? btn('Clear backlog…', () => post('clearBacklog'), 'ghost', 'Archive every idle backlog task (asks first; undo with Show archived tasks)') : '',
      sprint ? btn('Delete sprint…', () => post('deleteSprint', { sprintId: sprint.id }), 'ghost', 'Remove this sprint (asks first). Its tasks move to the Backlog') : '',
      btn('✦ Plan', () => S.planner ? openPlanner() : planDialog(editable.map(t => t.id), sprint), 'ghost', 'Plan new tasks or rework the To do list with Claude'),
      sprint && editable.length ? btn(`✦ Edit sprint (${editable.length})`, () => S.planner ? openPlanner() : planDialog(editable.map(t => t.id), sprint, true), 'ghost', `Edit every not-started task in ${sprint.name} with one prompt`) : '',
      (n => btn(`📎 Sources${n ? ` (${n})` : ''}`, () => sourcesDialog(), 'ghost', sprint ? `Specs, designs, docs and links ${sprint.name} is built on` : 'Specs, designs, docs and links tasks are based on'))(sprint ? sprintSrcs(sprint.id).length : (S.sources || []).length),
      h('div', { class: 'spacer' }),
      q.queued.length || q.blocker ? h('span', { class: 'queue' }, q.queued.length ? `${q.queued.length} queued` : '', q.blocker ? [' · next waits: ', h('a', { href: '#', title: 'Open this task', onclick: e => { e.preventDefault(); openTask(q.blocker.id); } }, `“${q.blocker.title.slice(0, 40)}”`), ` ${q.blocker.why}`] : '',
        q.queued.length ? btn('Stop queue', () => post('cancelQueue'), 'ghost') : '') : '',
      showArchived ? btn('Showing archived ×', () => { showArchived = false; render(); }, 'ghost') : '',
      ready.length ? btn(`✓ Merge ready (${ready.length})`, () => post('mergeReady', { ids: ready.map(t => t.id) })) : '',
      btn(`▶ Run all${todo.length ? ` (${todo.length})` : ''}`, () => post('runAll', { ids: todo.map(t => t.id) }), 'primary', `Runs every To do task in board order, ${S.settings.maxParallel} at a time`),
      btn('🕘', () => historyDialog(), 'ghost icon', 'Prompt history: every prompt you sent, and each session'),
      btn('⋯', () => moreMenu(), 'ghost icon', 'Agent map, report, history, archived tasks'));
  }

  /* ---------- prompt history ---------- */
  // Every prompt you sent (new task, message to a task, planning request), newest first, with each session's
  // conversation one click away. Kept after a task is merged or deleted.
  let history, historyFor, historyQuery = '', sessionView;
  function historyDialog(taskId) {
    historyFor = taskId; sessionView = undefined; history = undefined;
    post('history');
    drawHistory();
  }
  function drawHistory() {
    if (sessionView) {
      const { title, steps: list } = sessionView;
      dialog(`Session · ${title}`, btn('← Back to history', () => { sessionView = undefined; drawHistory(); }, 'ghost'),
        list ? (list.length ? logEl(list) : h('p', { class: 'muted' }, 'This session\'s transcript is no longer on this computer.')) : h('p', { class: 'muted' }, 'Loading…'));
      return;
    }
    const kinds = { task: 'New task', message: 'Message', plan: 'Plan' };
    const q = historyQuery.toLowerCase();
    const items = (history || []).filter(p => (!historyFor || p.taskId === historyFor) && (!q || `${p.title || ''}\n${p.text}`.toLowerCase().includes(q)));
    let search;
    const d = dialog(historyFor ? `History · ${(S.board.tasks.find(t => t.id === historyFor) || {}).title || 'task'}` : 'Prompt history',
      h('div', { class: 'row' }, search = h('input', { class: 'grow', placeholder: 'Search your prompts', value: historyQuery, 'aria-label': 'Search your prompts',
        oninput: e => { historyQuery = e.target.value; drawHistory(); } }),
        historyFor ? btn('All tasks', () => { historyFor = undefined; drawHistory(); }, 'ghost') : ''),
      !history ? h('p', { class: 'muted' }, 'Loading…') : !items.length ? h('p', { class: 'muted' }, q ? 'No prompt matches.' : 'No prompts yet.') :
        h('div', { class: 'hist' }, items.slice(0, 300).map(p => h('div', { class: 'hitem' },
          h('div', { class: 'row small' }, h('span', { class: `tag k-${p.kind}` }, kinds[p.kind] || p.kind),
            p.kind !== 'task' && p.title ? h('b', {}, p.title) : '',
            h('span', { class: 'muted' }, new Date(p.time).toLocaleString()),
            p.taskId && !p.exists ? h('span', { class: 'muted' }, '· task deleted') : p.status === 'done' ? h('span', { class: 'muted' }, '· done') : ''),
          h('div', { class: 'htext', title: 'Click to show all', onclick: e => e.currentTarget.classList.toggle('full') }, p.text),
          h('div', { class: 'acts' },
            p.exists ? btn('Open task', () => { $('#dlg').close(); openTask(p.taskId); }, 'ghost') : '',
            ...p.sessions.map((sid, i) => btn(p.sessions.length > 1 ? `Conversation ${i + 1}` : 'Conversation', () => {
              sessionView = { id: sid, title: p.title || kinds[p.kind] }; post('sessionLog', { sessionId: sid }); drawHistory();
            }, 'ghost', `Session ${sid.slice(0, 8)}`)),
            btn('Copy', () => post('copy', { text: p.text }), 'ghost'),
            btn('Use again', () => { $('#dlg').close(); const [first, ...rest] = p.text.split('\n\n'); $('#title').value = first; $('#desc').value = rest.join('\n\n'); if (rest.length) toggleMore(true); $('#title').focus(); }, 'ghost', 'Put it in the add box to send again'))))));
    if (document.activeElement !== search && d.open) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  // Sprint progress: the sprint on screen (or the active one in All tasks), as a bar split by lane, plus its goal.
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
        h('span', { class: 'small' }, `${done} of ${tasks.length} done · ${pct}%`)),
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
      onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openTask(t.id); } },
      onclick: () => openTask(t.id), ondragstart: () => { dragId = t.id; }, ondragend: () => { dragId = undefined; },
      ondragover: e => { if (dragId && dragId !== t.id && t.status === 'todo') e.preventDefault(); },
      ondrop: e => { if (dragId && dragId !== t.id && t.status === 'todo') { e.stopPropagation(); post('reorder', { id: dragId, before: t.id }); } } },
      h('div', { class: 'ctop' }, n ? h('span', { class: 'num' }, n) : '', h('span', { class: 'ttl' }, t.title)),
      h('div', { class: 'meta' },
        t.agent ? h('span', { class: 'tag' }, t.agent) : '',
        h('span', { class: `tag mode-${S.settings?.bypassAll ? 'bypassPermissions' : t.mode}` }, modeName(S.settings?.bypassAll ? 'bypassPermissions' : t.mode)),
        t.output === 'artifact' ? h('span', { class: 'tag', title: 'Result: a page published as a claude.ai artifact' }, '⧉ artifact') : t.where === 'root' ? h('span', { class: 'tag' }, 'project folder') : '',
        t.images?.length ? h('span', { class: 'tag' }, `🖼 ${t.images.length}`) : '',
        t.agents?.length > 1 ? h('span', { class: 'tag' }, `${t.agents.length - 1} subagent${t.agents.length > 2 ? 's' : ''}`) : '',
        usageTotal(t) ? h('span', { class: 'tag muted', title: usageTitle(t) }, tokShort(usageTotal(t))) : ''),
      h('div', { class: `next ${nx.tone}`, title: nx.tone === 'err' ? nx.text : undefined }, nx.text),
      ...(t.asks || []).map(a => askBox(t, a)),
      nx.action ? h('div', { class: 'acts' }, btn(nx.action[0], nx.action[1], 'primary'), nx.extra ? btn(nx.extra[0], nx.extra[1], 'ghost') : '') : '');
    return el;
  }

  /* ---------- approvals and questions ---------- */
  function askBox(t, a) {
    if (a.kind === 'question') return questionBox(t, a);
    if (a.kind === 'plan') return planBox(t, a);
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

  // Plan mode: Claude's plan, to build as is or send back with changes.
  function planBox(t, a) {
    let note;
    const build = S.settings.defaultMode === 'plan' ? 'auto' : S.settings.defaultMode;
    return h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      h('div', { class: 'askhead' }, h('b', {}, 'Plan ready'), h('span', { class: 'muted small' }, ' · saved as the task\'s plan.md')),
      h('pre', { class: 'askdetail plan' }, a.plan || '(empty plan)'),
      h('div', { class: 'acts' },
        btn(`Build it (${modeName(build)})`, () => { post('answer', { id: t.id, ask: a.id, choice: 'allow' }); post('setMode', { id: t.id, mode: build }); }, 'primary'),
        btn('Revise…', () => { note.hidden = !note.hidden; note.querySelector('input').focus(); })),
      note = h('div', { class: 'row', hidden: true },
        h('input', { class: 'grow', placeholder: 'What should change in the plan?', onkeydown: e => { if (e.key === 'Enter') send(); } }), btn('Send', () => send())));
    function send() { post('answer', { id: t.id, ask: a.id, choice: 'deny', message: `Revise the plan: ${note.querySelector('input').value || 'keep planning'}` }); }
  }

  function questionBox(t, a) {
    const reply = x => t.id === '__planner' ? post('plannerAnswer', x) : post('answer', { id: t.id, ...x });
    const picked = a.questions.map(() => new Set());
    const other = a.questions.map(() => '');
    const box = h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      a.questions.map((q, i) => h('div', { class: 'q' },
        h('div', {}, q.header ? h('span', { class: 'tag' }, q.header) : '', ' ', h('b', {}, q.question)),
        h('div', { class: 'opts' }, q.options.map(o => h('label', { class: 'opt' },
          h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${a.id}-${i}`, onchange: e => {
            if (!q.multiSelect) picked[i].clear();
            e.target.checked ? picked[i].add(o.label) : picked[i].delete(o.label);
          } }),
          h('span', { class: 'otext' }, h('span', { class: 'olabel' }, o.label), o.description ? h('span', { class: 'odesc' }, o.description) : '',
            o.preview ? h('pre', { class: 'opreview' }, o.preview) : '')))),
        h('input', { class: 'other', placeholder: 'Or type your own answer', oninput: e => { other[i] = e.target.value; } }))),
      h('div', { class: 'acts' },
        btn('Answer', () => {
          const answers = {};
          a.questions.forEach((q, i) => { answers[q.question] = other[i].trim() || [...picked[i]].join(', '); });
          if (Object.values(answers).some(v => !v)) return;
          reply({ ask: a.id, choice: 'allow', answers });
        }, 'primary'),
        btn('Skip', () => reply({ ask: a.id, choice: 'deny', message: 'The user skipped the question. Use your best judgement.' }), 'ghost')));
    return box;
  }

  /* ---------- task drawer ---------- */
  function openTask(id, t2) {
    open = id; if (t2) tab = t2;
    agentView = undefined; delete agentsSaved[id];
    remember();
    post('watch', { id });
    if (tab === 'changes') post('changes', { id });
    render();
  }
  function closeTask() { open = undefined; remember(); post('watch', { id: undefined }); render(); }

  const drawer = $('#drawer');
  const msgImages = [], msgThumbs = h('div', { class: 'imgs' }), msgPaste = imagePaste(msgImages, msgThumbs);
  const msg = complete(h('textarea', { id: 'msg', rows: 2, placeholder: 'Message Claude…  / skills · @ files · Enter sends · Shift+Enter new line · paste screenshots', onpaste: msgPaste.onpaste, onkeydown: e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
  } }));
  function sendMsg() {
    const text = msg.value.trim() || (msgImages.length ? 'See the screenshot(s).' : '');
    if (!text || !open) return;
    const images = msgImages.splice(0);
    post(open === '__planner' ? 'plannerSay' : 'say', open === '__planner' ? { text, images } : { id: open, text, images });
    msg.value = ''; msgPaste.draw();
  }
  const body = h('div', { class: 'dbody' });
  const head = h('div', { class: 'dhead' });
  drawer.append(head, body, h('div', { class: 'dfoot' }, h('div', { class: 'col grow' }, msgThumbs, msg), h('div', { class: 'col' }, btn('Send', sendMsg, 'primary'), btn('Stop step', () => post(open === '__planner' ? 'stopPlanner' : 'interrupt', open === '__planner' ? {} : { id: open }), 'ghost', 'Interrupt what Claude is doing now (Esc)'))));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open && document.activeElement === msg && open !== '__planner') post('interrupt', { id: open }); else if (e.key === 'Escape' && open && !$('#dlg').open) closeTask(); });

  function renderDrawer() {
    if (open === '__planner') return renderPlanner();
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
        h('label', {}, 'Permissions ', h('select', { onchange: e => post('setMode', { id: t.id, mode: e.target.value }), disabled: !!S.settings?.bypassAll, title: S.settings?.bypassAll ? 'Bypass all is on: every task runs with Bypass permissions' : undefined },
          MODES.map(([v, l, d]) => h('option', { value: v, title: d, selected: (S.settings?.bypassAll ? 'bypassPermissions' : t.mode) === v }, l)))),
        t.modeNote ? h('span', { class: 'warn' }, t.modeNote) : '',
        t.branch ? h('span', { class: 'muted' }, `⎇ ${t.branch}`) : '',
        t.modelUsed ? h('span', { class: 'muted', title: t.modelUsed }, modelName(t.modelUsed)) : '',
        t.output ? h('span', { class: 'muted' }, `${tok(t.context + t.output)}`) : ''),
      h('div', { class: 'acts wrap' }, menu.map(([l, f, c]) => btn(l, f, c || 'ghost'))),
      ...(t.asks || []).map(a => askBox(t, a)),
      h('nav', { class: 'tabs' }, [['activity', 'Activity'], ['agents', `Agents${t.agents?.length > 1 ? ` (${t.agents.length})` : ''}`], ['changes', 'Changes'], ['review', 'Review'], ['details', 'Details']]
        .map(([k, l]) => h('a', { class: tab === k ? 'on' : '', onclick: () => { tab = k; if (k === 'changes') post('changes', { id: t.id }); if (k === 'review' && t.review?.screenshots?.length) post('shots', { id: t.id }); render(); } }, l))));
    body.replaceChildren(...drawerBody(t));
    msg.placeholder = t.status === 'todo' ? 'Run the task first, or edit it under Details' : t.remote ? 'This task is in Remote Control' : 'Message Claude…  Enter sends · Shift+Enter new line';
  }

  function drawerBody(t) {
    if (tab === 'agents') {
      if (agentView?.task === t.id) return agentDetail(t);
      const live = (t.agents || []).filter(n => n.id !== 'main');
      if (!agentsSaved[t.id]) post('savedAgents', { id: t.id });
      const extra = (agentsSaved[t.id] || []).filter(a => !live.some(n => n.toolUseId && n.toolUseId === a.toolUseId))
        .map(a => ({ id: `saved-${a.id}`, parent: 'main', name: a.name, description: a.description, status: a.finished ? 'completed' : 'stopped', key: a.id, sessionId: a.sessionId }));
      return [agentTree([{ name: t.title, tasks: [{ ...t, agents: [...(t.agents || []), ...extra] }] }], true),
        h('p', { class: 'muted small' }, 'Click an agent for its whole conversation.')];
    }
    if (tab === 'changes') {
      const files = changes[t.id];
      const merged = t.status === 'done' && !t.worktree && t.branch && t.where !== 'root';
      if (!t.worktree && !merged) return [h('p', { class: 'muted' }, t.where === 'root' ? 'This task runs in the project folder: its changes are in your working tree.' : 'No changes yet.')];
      if (!files) return [h('p', { class: 'muted' }, 'Loading…')];
      if (!files.length) return [h('p', { class: 'muted' }, merged ? 'Could not find this task\'s merge in git history.' : 'No changes on this branch yet.')];
      return [merged ? h('p', { class: 'muted small' }, 'What the merge changed. Click a file for its diff; Open shows it from the project folder.') : '',
        h('ul', { class: 'files' }, files.map(f => h('li', { onclick: () => post('diff', { id: t.id, file: f.file }), title: 'Open side-by-side diff (PDFs and other documents open in their app)' },
          h('span', { class: `st st-${f.status}` }, f.status), h('span', { class: 'grow' }, f.file),
          f.status !== 'D' ? btn('Open', e => { e.stopPropagation(); post('openFile', { id: t.id, file: f.file }); }, 'ghost small', 'Open the file') : '')))];
    }
    if (tab === 'review') {
      const r = t.review;
      if (!r) return [h('p', { class: 'muted' }, t.reviewing ? 'The AI reviewer is testing this change…' : S.settings.review.auto ? 'Reviewed automatically when Claude finishes.' : 'AI review is off (⚙ Settings).'), t.worktree && !t.reviewing ? btn('Review now', () => post('review', { id: t.id })) : ''];
      return [
        h('p', {}, h('b', {}, { pass: '✓ Passed', fail: '✗ Issues found', error: 'Review could not run', running: 'Reviewing…' }[r.state]), r.risk === 'critical' ? h('span', { class: 'warn' }, ' · flagged critical') : '', h('span', { class: 'muted' }, ` · round ${r.attempts || 1}`)),
        r.level ? h('p', { class: 'muted small' }, r.level === 'none' ? `No AI review needed: ${r.why}.` : `${r.level === 'light' ? 'Light review (lighter model)' : 'Full review'}${r.why ? `: ${r.why}` : ''}.`) : '',
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
        editable ? h('div', { class: 'row' }, btn('Save', () => post('editTask', { id: t.id, patch: { title: title.value, description: desc.value } }), 'primary'),
          h('span', { class: 'muted small' }, 'To rework it with Claude, use ✦ Plan.')) : h('p', { class: 'muted small' }, 'Started tasks keep their text; message Claude instead.'),
        t.images?.length ? h('p', { class: 'muted small' }, `${t.images.length} screenshot(s) attached.`) : '',
        t.checks?.results?.length ? h('div', {}, h('h4', {}, `Checks · ${t.checks.state === 'pass' ? 'pass' : 'fail'}${t.checks.rounds ? ` · fix round ${t.checks.rounds}` : ''}`),
          h('ul', { class: 'checks' }, t.checks.results.map(r => h('li', { class: r.ok ? 'ok' : r.preexisting ? 'pre' : 'bad' },
            h('span', { class: 'dot' }, r.ok ? '✓' : r.preexisting ? '○' : '✗'), h('code', {}, r.cmd), h('span', { class: 'muted small' }, ` ${Math.round(r.ms / 1000)}s${r.preexisting ? ' · fails on the base branch too: ignored' : ''}${r.timedOut ? ' · timed out' : ''}`)))),
          btn('Open log', () => post('openArtifact', { id: t.id, which: 'checks' }), 'ghost')) : '',
        t.output === 'artifact' ? h('div', { class: 'row small' }, h('b', {}, 'Artifact '), t.artifactUrl
          ? [h('a', { onclick: () => post('openUrl', { url: t.artifactUrl }), title: 'Open in your browser' }, t.artifactUrl), btn('Copy link', () => post('copy', { text: t.artifactUrl }), 'ghost')]
          : h('span', { class: 'muted' }, t.publishing ? 'publishing…' : 'not published yet'),
          t.status !== 'todo' ? btn(t.artifactUrl ? 'Publish again' : 'Publish', () => post('publishArtifact', { id: t.id }), 'ghost') : '') : '',
        t.files?.length ? h('p', { class: 'small' }, 'Attached: ', t.files.map(base).join(', ')) : '',
        t.sources ? h('p', { class: 'small' }, 'Based on: ', (S.sources || []).filter(s => t.sources.includes(s.id)).map(srcLabel).join(', ') || 'no project sources') : '',
        h('details', { class: 'adv' }, h('summary', {}, 'Files Claude wrote, logs and tokens'),
          h('div', { class: 'row' }, [['brief', 'Brief'], ['plan', 'Plan'], ['handoff', 'Handoff'], ['review', 'Review notes']].filter(([k]) => t.artifacts?.[k]).map(([k, l]) => btn(l, () => post('openArtifact', { id: t.id, which: k }), 'ghost')),
            t.worktree ? btn('Setup log', () => post('openArtifact', { id: t.id, which: 'setup' }), 'ghost') : ''),
          usageTotal(t) ? h('pre', { class: 'small' }, usageTitle(t) + '\nCached re-reads are context re-sent at every step and cost about a tenth.') : ''),
        btn('🕘 Prompts and sessions', () => historyDialog(t.id), 'ghost', 'Every prompt you sent this task, and each session\'s conversation'),
        h('p', { class: 'muted small' }, `Created ${new Date(t.created).toLocaleString()}${t.sessionId ? ` · session ${t.sessionId.slice(0, 8)}` : ''}${t.costUsd ? ` · ~$${t.costUsd.toFixed(2)} at API prices` : ''}`),
      ];
    }
    const list = steps[t.id] || [];
    if (!list.length) return [h('p', { class: 'muted' }, t.status === 'todo' ? 'Not started yet. Press ▶ Run.' : 'No activity yet.')];
    return [logEl(list)];
  }

  function logEl(list) {
    const el = h('div', { class: 'log' }, list.map(s => h('div', { class: `step ${s.kind}${s.kind === 'info' && s.text.startsWith('Model: ') ? ' model' : ''}` },
      h('span', { class: 'k' }, { user: 'you', say: 'claude', tool: s.agent ? `↳ ${s.agent}` : 'tool', result: '', error: 'error', info: 'note' }[s.kind]),
      s.kind === 'say' || s.kind === 'user' ? h('div', { class: 'txt' }, s.text) : h('code', {}, s.text))));
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    return el;
  }

  /* ---------- planner / editor chat ---------- */
  // What the planner is doing this turn: a moving bar while it works, then where the plan stands.
  function planProgress(p, running) {
    const since = p.turnAt || 0;
    const turn = (p.steps || []).filter(x => x.time && Date.parse(x.time) >= since);
    const tools = turn.filter(x => x.kind === 'tool');
    const reads = tools.filter(x => /^(Read|Grep|Glob)\b/.test(x.text)).length;
    const stage = p.asks?.length ? 'Waiting for your answer' : !running ? (p.proposals ? 'Plan ready: review and apply below' : p.note ? 'Applied' : 'Your turn')
      : turn.some(x => x.kind === 'say') ? 'Writing the proposal' : tools.length ? 'Reading the code' : 'Starting';
    const steps = ['Reading the code', 'Writing the proposal', 'Plan ready: review and apply below'];
    const at = steps.indexOf(stage);
    return h('div', { class: 'planprog' },
      h('div', { class: `bar${running && !p.asks?.length ? ' busy' : ''}`, role: 'progressbar', 'aria-label': 'Planning progress', 'aria-valuetext': stage },
        h('i', { class: 'seg run', style: `width:${running ? Math.max(15, (at + 1) * 33) : p.proposals ? 100 : 0}%` })),
      h('div', { class: 'small muted' }, stage, running ? ` · ${ago(since || Date.now())}` : '', tools.length ? ` · ${reads} file reads, ${tools.length} tool uses` : '',
        running && tools.length ? ` · now: ${tools[tools.length - 1].text.slice(0, 60)}` : ''));
  }

  const pKeep = {}; // which proposals the user has unticked
  function renderPlanner() {
    const p = S.planner;
    drawer.classList.add('on');
    document.body.classList.add('drawer-open');
    if (!p) {
      head.replaceChildren(h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Planning'), btn('×', closeTask, 'ghost icon', 'Close')));
      body.replaceChildren(h('p', { class: 'muted' }, S.plannerPhase || 'Starting the planning chat…'),
        S.plannerPhase ? btn('Show terminal', () => post('showSaveTerminal', {}), 'ghost', 'Open the terminal saving it, e.g. if it asks for approval') : '');
      return;
    }
    const running = p.run && p.run !== 'idle';
    head.replaceChildren(
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.sprint ? `Editing ${p.sprint}` : p.targets?.length ? `Editing ${p.targets.length} To do task${p.targets.length === 1 ? '' : 's'}` : 'Planning tasks'),
        btn('×', closeTask, 'ghost icon', 'Close (the chat keeps running)')),
      h('div', { class: `next ${p.asks?.length ? 'warn' : running ? 'run' : 'muted'}` }, p.asks?.length ? 'Claude has a question for you (below).' : running ? 'Claude is reading the code…' : 'Your turn: message Claude to refine, or apply the tasks below.',
        p.model ? h('span', { class: 'muted small', title: p.model }, ` · ${modelName(p.model)}`) : '',
        p.context ? h('span', { class: 'muted small' }, ` · ${tok(p.context)}`) : ''),
      planProgress(p, running));
    const prop = p.proposals;
    const panel = [];
    if (p.note) panel.push(h('div', { class: 'applied' }, '✓ ', p.note));
    for (const a of p.asks || []) panel.push(questionBox({ id: '__planner' }, a));
    if (prop) {
      const cur = id => S.board.tasks.find(t => t.id === id);
      const targets = (p.targets || []).map(cur).filter(Boolean);
      const refs = new Set(prop.map(x => x.ref).filter(Boolean));
      const others = new Set(p.others || []);
      const changes = prop.map((c, i) => {
        const was = c.ref ? cur(c.ref) : undefined;
        const same = was && was.title === c.title && (was.description || '') === (c.description || '');
        // A started or done task of the sprint: a done one goes back to To do, a started one gets the change as a message.
        const kind = !was ? 'add' : same ? 'same' : others.has(was.id) && was.status !== 'todo' ? (was.status === 'done' ? 'reopen' : 'amend') : 'edit';
        return { ...c, kind, key: `c${i}`, before: was?.title };
      });
      const removes = targets.filter(t => !refs.has(t.id)).map((t, i) => ({ id: t.id, title: t.title, description: t.description, kind: 'remove', key: `r${i}` }));
      const all = [...changes, ...removes];
      all.forEach(c => { if (!(c.key in pKeep)) pKeep[c.key] = c.kind !== 'same'; });
      const nChange = all.filter(c => c.kind !== 'same').length;
      panel.push(h('div', { class: 'proppanel' },
        h('div', { class: 'row' }, h('h4', { class: 'grow' }, `Proposed tasks (${prop.length})`), nChange ? h('span', { class: 'muted small' }, `${nChange} change${nChange === 1 ? '' : 's'}`) : ''),
        h('div', { class: 'reflist' }, all.map(c => h('label', { class: `refrow ${c.kind}` },
          c.kind === 'same' ? h('span', { class: 'rspace' }) : h('input', { type: 'checkbox', checked: pKeep[c.key], onchange: e => { pKeep[c.key] = e.target.checked; } }),
          h('div', { class: 'rbody' }, h('div', {}, h('span', { class: `rtag ${c.kind}` }, { add: 'NEW', edit: 'EDIT', same: 'keep', remove: 'REMOVE', reopen: 'BACK TO TO DO', amend: 'CHANGE SENT' }[c.kind]), ' ', h('b', {}, c.title), c.sprint ? h('span', { class: 'tag' }, ` ${c.sprint}`) : ''),
            c.kind === 'reopen' ? h('div', { class: 'small warn' }, 'Done, but must change: goes back to To do and is built again on top of the merged work.') : '',
            c.kind === 'amend' ? h('div', { class: 'small warn' }, 'Already started: the new text is saved and sent to its Claude as a message.') : '',
            c.before && c.before !== c.title ? h('div', { class: 'small muted strike' }, c.before) : '',
            c.description ? h('div', { class: 'small muted' }, c.description) : '')))),
        h('div', { class: 'acts' },
          nChange ? btn('Apply the ticked tasks', () => {
            post('applyProposals', { changes: changes.map(c => ({ ...c, apply: c.kind !== 'same' && pKeep[c.key] })), removes: removes.map(c => ({ id: c.id, apply: pKeep[c.key] })) });
            for (const k in pKeep) delete pKeep[k];
          }, 'primary') : h('span', { class: 'muted small' }, 'No changes to apply yet.'))));
    }
    body.replaceChildren(logEl(p.steps || []), ...panel);
    msg.placeholder = 'Message Claude to refine the tasks…  Enter sends';
  }

  /* ---------- agent map ---------- */
  // One agent's details and conversation, like Claude Code's agent map: status, type, model, who spawned it, time,
  // tokens, its final answer, then every step.
  function agentDetail(t) {
    const v = agentView, n = v.node, log = v.log;
    const ms = log?.ms || n.ms || (n.started ? Date.now() - n.started : 0), tokens = log?.tokens || n.tokens;
    return [
      h('div', { class: 'row' }, btn('←', () => { agentView = undefined; renderDrawer(); }, 'ghost icon', 'Back to the agents'), h('span', { class: `sdot s-${n.status}` }), h('b', {}, n.main ? 'Task session' : n.description || n.name)),
      h('p', { class: 'muted small' }, [{ running: 'Running', completed: 'Finished', failed: 'Failed', stopped: 'Stopped', waiting: 'Needs you', idle: 'Idle' }[n.status] || n.status,
        n.main ? '' : n.name, log?.model ? modelName(log.model) : t.modelUsed ? modelName(t.modelUsed) : ''].filter(Boolean).join(' · ')),
      n.main ? '' : h('p', { class: 'muted small' }, 'Spawned by the main agent'),
      h('p', { class: 'muted small' }, [ms ? ago(Date.now() - ms) : '', tokens ? tok(tokens) : ''].filter(Boolean).join(' · ')),
      !log ? h('p', { class: 'muted' }, 'Loading…') : '',
      log?.result ? h('div', { class: 'aresult' }, log.result) : '',
      log && !log.steps?.length ? h('p', { class: 'muted' }, n.status === 'running' ? 'Its transcript appears as it works.' : 'No saved transcript for this agent.') : '',
      log?.steps?.length ? h('details', { open: !log.result }, h('summary', {}, `Transcript · ${log.steps.length} steps`), logEl(log.steps)) : ''];
  }
  function openAgent(t, n) {
    agentView = { task: t.id, node: n };
    post('agentLog', { id: t.id, sessionId: n.sessionId || t.sessionId, agent: n.main ? 'main' : n.key || n.toolUseId || n.id });
    renderDrawer();
  }

  function agentTree(groups, single) {
    const row = (n, depth, extra = '', t) => h('div', { class: `node d${Math.min(depth, 4)} s-${n.status}${single && t ? ' click' : ''}`, onclick: single && t ? () => openAgent(t, n) : undefined, title: single && t ? 'Show its conversation' : undefined },
      h('span', { class: 'sdot' }), h('div', { class: 'ninfo' }, h('b', {}, n.name), n.description && n.description !== n.name ? h('span', { class: 'muted' }, ` · ${n.description.slice(0, 90)}`) : '',
        h('div', { class: 'muted small' }, [n.ms || n.started ? (n.status === 'running' ? ago(n.started) : ago(Date.now() - (n.ms || 0))) : '', n.tokens ? tok(n.tokens) : '', n.tools ? `${n.tools} tool uses` : '', n.last && n.status === 'running' ? `now: ${n.last}` : '', extra].filter(Boolean).join(' · ')),
        n.summary ? h('div', { class: 'small' }, n.summary) : ''));
    const out = [];
    for (const g of groups) {
      if (!single) out.push(h('h4', {}, g.name));
      for (const t of g.tasks) {
        const nodes = t.agents || [];
        const kids = p => nodes.filter(n => n.parent === p);
        const walk = (p, d) => kids(p).flatMap(n => [row(n, d, '', t), ...walk(n.id, d + 1)]);
        const main = nodes.find(n => n.id === 'main');
        const status = t.asks?.length ? 'waiting' : t.run === 'running' || t.run === 'starting' ? 'running' : main ? 'completed' : 'idle';
        out.push(h('div', { class: 'tree', onclick: single ? undefined : () => { $('#dlg').close(); if (g.root !== S.root) post('root', { root: g.root }); openTask(t.id, 'agents'); } },
          row({ ...(main || {}), main: true, name: single ? 'Task session' : t.title, description: single ? '' : t.status, status, started: main?.started }, 0, t.asks?.length ? 'needs you' : '', t),
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
  function toast(text) {
    const t = h('div', { class: 'toast', role: 'status', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#333;color:#fff;padding:10px 16px;border-radius:8px;z-index:9999' }, text);
    document.body.append(t); setTimeout(() => t.remove(), 2500);
  }
  // A dialog the host asked for (merge, bypass, discard, pick files, text input). Closing it any other way is a decline.
  function bridged(m) {
    const d = $('#dlg');
    let done = false;
    const reply = (extra) => { if (done) return; done = true; post('dialogReply', { id: m.id, ...extra }); };
    const field = m.input ? h(m.input.multiline ? 'textarea' : 'input', { 'aria-label': m.input.label, rows: 4, style: 'width:100%;box-sizing:border-box' }) : null;
    const finish = (extra) => { reply(extra); d.close(); };
    dialog(m.title, h('p', {}, m.text || ''), field || '',
      h('div', { class: 'acts' }, btn('Cancel', () => finish({ cancelled: true }), 'ghost'),
        ...(m.buttons || ['OK']).map(b => btn(b, () => finish({ button: b, value: field ? field.value : undefined }), 'primary'))));
    d.addEventListener('close', () => reply({ cancelled: true }), { once: true });
  }
  function dialog(title, ...content) {
    const d = $('#dlg');
    delete d.dataset.kind;
    d.replaceChildren(h('div', { class: 'dlghead' }, h('h3', {}, title), btn('×', () => d.close(), 'ghost icon', 'Close')), h('div', { class: 'dlgbody' }, content));
    if (!d.open) d.showModal();
    return d;
  }

  function newSprint() {
    let name, goal;
    dialog('New sprint', name = h('input', { placeholder: 'Sprint name', value: `Sprint ${S.board.sprints.length + 1}` }), goal = h('input', { placeholder: 'Goal (optional)' }),
      h('div', { class: 'acts' }, btn('Create', () => { if (name.value.trim()) { post('addSprint', { name: name.value.trim(), goal: goal.value }); $('#dlg').close(); } }, 'primary')));
    name.select();
  }

  function openPlanner() { open = '__planner'; remember(); render(); }

  // The one way to plan with Claude: new tasks from a goal, or rework To do tasks. With a sprint (✦ Edit sprint, or
  // ✦ Plan while a sprint is shown), one prompt edits every not-started task in that sprint. Offers project setup
  // first when the project has no Claude setup yet.
  function planDialog(todoIds, sprint, editSprint = false) {
    const pr = S.project || {};
    const missing = [!pr.projectMd && 'a project description'].filter(Boolean);
    const started = sprint ? S.board.tasks.filter(t => t.sprintId === sprint.id && !t.archived && !(t.status === 'todo' && !t.worktree)).length : 0;
    const where = sprint ? ` in ${sprint.name}` : '';
    let goal, rework, chips;
    const shots = [], thumbs = h('div', { class: 'imgs' }), paste = imagePaste(shots, thumbs);
    const presets = ['Add a "Done when" checklist to each', 'Split anything too big', 'Merge duplicates', 'Order by dependency', sprint ? 'Make them fit the sprint goal' : 'Group into sprints'];
    dialog(editSprint ? `Edit ${sprint.name} with Claude` : 'Plan with Claude',
      missing.length && !editSprint ? h('div', { class: 'banner info' }, h('div', { class: 'grow' }, h('b', {}, 'Set up this project first? '),
        `It is missing ${andList(missing)}. Claude reads the code, asks you a few questions, shows what it will write, and saves it to .justcode/project.md after you approve.`),
        btn('Set up project', () => { post('initialize'); $('#dlg').close(); }, 'primary')) : '',
      h('p', { class: 'muted' }, editSprint
        ? `One prompt edits all ${todoIds.length} not-started task${todoIds.length === 1 ? '' : 's'}${where}: reword, split, merge, add, remove or reorder.${sprint.goal ? ` Sprint goal: ${sprint.goal}.` : ''}${started ? ` Claude also checks the ${started} started or done task${started === 1 ? '' : 's'}: a done one that must change goes back to To do, a started one gets the change as a message.` : ''} You review every change before it is applied.`
        : 'Claude reads the code (read-only) and may ask you a few questions. It proposes tasks with a goal, likely files and a "Done when" checklist, grouped into sprints. Keep chatting to refine, then apply the ones you want.'),
      goal = complete(h('textarea', { rows: 4, onpaste: paste.onpaste, 'aria-label': 'What you want; paste screenshots here', placeholder: editSprint ? `What should change in all of them? e.g. "add Done when to each and split anything too big"` : todoIds.length ? 'What do you want? e.g. "Add password reset by email" or "split anything too big"' : 'What do you want to build or change? e.g. Add password reset by email, with tests' })),
      todoIds.length && !editSprint ? h('label', { class: 'row' }, rework = h('input', { type: 'checkbox', onchange: () => { chips.hidden = !rework.checked; } }), ` Also rework the ${todoIds.length} To do task${todoIds.length === 1 ? '' : 's'}${where}${started ? `, and check the ${started} started or done` : ''}`) : '',
      thumbs, h('p', { class: 'muted small' }, 'Type / for skills and @ for files. Paste screenshots or designs into the box: Claude looks at them first.'),
      chips = h('div', { class: 'chips', hidden: !editSprint }, presets.map(p => h('span', { class: 'chip', onclick: () => { goal.value = goal.value ? `${goal.value}; ${p}` : p; } }, p))),
      h('div', { class: 'acts' }, btn(editSprint ? '✦ Edit the sprint' : '✦ Start planning', () => {
        if (!goal.value.trim()) return goal.focus();
        const ids = editSprint || rework?.checked ? todoIds : [];
        post('planner', { instruction: goal.value.trim(), ids, sprint: ids.length && sprint ? { name: sprint.name, goal: sprint.goal } : undefined, images: shots,
          into: (sprint ?? S.board.sprints.find(s => s.active && !s.closed))?.name });
        $('#dlg').close();
        openPlanner();
      }, 'primary')));
    goal.focus();
  }

  function moreMenu() {
    const item = (label, help, fn) => h('button', { class: 'menuitem', onclick: () => { $('#dlg').close(); fn(); } }, h('b', {}, label), h('span', { class: 'muted small' }, help));
    dialog('More',
      h('div', { class: 'menu' },
        item('Agent map', 'Every Claude session, subagent and reviewer at work', () => agentMap()),
        item('Report', 'Tokens, rounds and time per task', () => report()),
        item('Prompt history', 'Every prompt you sent and each session\'s conversation', () => historyDialog()),
        item('Project history', 'What merged tasks changed', () => post('openArtifact', { which: 'progress' })),
        item(showArchived ? 'Hide archived tasks' : 'Show archived tasks', 'Archived tasks stay out of the lanes', () => { showArchived = !showArchived; render(); }),
        item('Set up project with Claude', 'Interview, then .justcode/project.md', () => post('initialize'))));
  }

  function settings() {
    const s = S.settings;
    const f = {};
    const field = (key, label, input, help) => h('label', { class: 'blk' }, h('span', {}, label), f[key] = input, help ? h('span', { class: 'muted small' }, help) : '');
    const sel = (v, opts) => h('select', {}, opts.map(([k, l]) => h('option', { value: k, selected: String(v) === String(k) }, l)));
    const effort = v => sel(v, [['low', 'Low (fewest tokens)'], ['medium', 'Medium'], ['high', 'High'], ['', 'Model default']]);
    // Every model in one dropdown (aliases follow the newest version); "Other…" takes any model id. Reads like an input: .value.
    const MODEL_LIST = [['', 'Your Claude default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (latest)'],
      ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
    const models = v => {
      const known = MODEL_LIST.some(m => m[0] === v);
      const sel = h('select', { onchange: () => { other.hidden = sel.value !== '__other'; if (!other.hidden) other.focus(); } },
        MODEL_LIST.map(([k, l]) => h('option', { value: k, selected: known && k === v }, l)), h('option', { value: '__other', selected: !known }, 'Other model id…'));
      const other = h('input', { value: known ? '' : v, placeholder: 'e.g. claude-opus-4-8', hidden: known });
      const box = h('div', { class: 'modelpick' }, sel, other);
      Object.defineProperty(box, 'value', { get: () => sel.value === '__other' ? other.value.trim() : sel.value });
      return box;
    };
    let rules;
    dialog('Settings',
      h('div', { class: 'grid' },
        field('defaultMode', 'Permissions for new tasks', sel(s.defaultMode, MODES.map(([k, l]) => [k, l])), 'Auto lets Claude approve what is safe; the card asks only when unsure.'),
        field('notifications', 'Notifications', sel(s.notifications || 'actionable', [['actionable', 'When a task needs me, is ready or failed'], ['errors', 'Only errors'], ['off', 'Off']]), 'The board and the JustCode output log always show everything.'),
        field('maxParallel', 'Tasks running at once', sel(s.maxParallel, [1, 2, 3, 4, 5, 6].map(n => [n, n === 1 ? '1 · one after another' : String(n)]))),
        field('taskModel', 'Task model', models(s.taskModel)),
        field('taskEffort', 'Task thinking', effort(s.taskEffort)),
        field('reviewModel', 'Reviewer model', models(s.review.model)),
        field('reviewEffort', 'Reviewer thinking', effort(s.review.effort)),
        field('plannerModel', 'Planner model', models(s.plannerModel)),
        field('plannerEffort', 'Planner thinking', effort(s.plannerEffort)),
        field('allowSubagents', 'Subagents in tasks', sel(s.subagents, [[false, 'Off (saves the most tokens)'], [true, 'On (they run on Haiku)']])),
        field('maxReviews', 'Review rounds before it waits for you', sel(s.review.maxAttempts, [1, 2, 3, 4, 5].map(n => [n, String(n)]))),
        field('autoReview', 'AI review', sel(s.review.auto, [[true, 'On: review every finished task'], [false, 'Off']])),
        field('autoMerge', 'When the review passes', sel(s.review.autoMerge, [[false, 'Wait for me to merge'], [true, 'Merge automatically (not critical ones)']])),
        field('mergeIfReviewCannotRun', 'When the review cannot run (twice)', sel(s.review.mergeIfCannotRun, [[true, 'Merge anyway (with automatic merging)'], [false, 'Wait for me']])),
        field('idleMinutes', 'Close idle Claude processes after (minutes)', h('input', { type: 'number', min: 1, value: s.idleMinutes })),
        field('checks', 'Checks after each turn (no tokens)', sel(s.checks === '' ? 'off' : s.checks === 'auto' ? 'auto' : 'custom', [['auto', `Auto${S.detectedChecks?.length ? `: ${S.detectedChecks.map(c => c.cmd).join(' · ')}` : ' (none found here)'}`], ['off', 'Off'], ['custom', 'My commands (below)']]),
          'Failures go back to Claude before the AI review.'),
        field('checksCustom', 'My check commands (one per line)', h('textarea', { rows: 2, placeholder: 'npm test\nnpx tsc --noEmit' }, s.checks !== 'auto' ? s.checks : '')),
        field('folderSetup', 'Task folder setup', sel(s.setup === '' ? 'off' : s.setup === 'auto' ? 'auto' : 'custom', [['auto', 'Auto: link node_modules, use .venv'], ['off', 'Off'], ['custom', 'My command (below)']])),
        field('setupCustom', 'My setup command', h('input', { value: s.setup !== 'auto' ? s.setup : '', placeholder: 'pnpm install' })),
        field('reviewTriage', 'Review size', sel(s.review.triage, [[true, 'Fit to the change (saves tokens)'], [false, 'Always the full reviewer']]), 'Docs-only: no review. Small, non-sensitive: lighter model.'),
        field('reviewLightModel', 'Model for small reviews', models(s.review.lightModel)),
        field('personalSetup', 'Your personal Claude setup in tasks', sel(s.personalSetup, [[false, 'Off: project setup only (saves ~7k tokens per step)'], [true, 'On: plugins, skills, MCP, memory']])),
        field('freshSessionTokens', 'Fresh session for fixes above (tokens of context)', h('input', { type: 'number', min: 0, step: 10000, value: s.freshAfterTokens }), '0 = never. Fix rounds then start from the brief, handoff and review notes.')),
      h('label', { class: 'blk' }, h('span', {}, `Always allowed in ${S.roots.find(r => r.path === S.root)?.name ?? 'this project'}`),
        rules = h('textarea', { rows: 4, placeholder: 'One rule per line, e.g. Bash(npm run:*)' }, (S.board.rules || []).join('\n')),
        h('span', { class: 'muted small' }, 'Added when you press "Always allow…" on a card. Every task in this project gets them.')),
      f.allowedTools = h('textarea', { rows: 3, placeholder: 'One rule per line, for every project' }, (s.allowedTools || []).join('\n')),
      h('span', { class: 'muted small' }, 'Always allowed in every project.'),
      h('div', { class: 'row' }, btn(s.apiKey ? 'Change or remove API key' : 'Use an API key instead of my Claude login', () => post('apiKey'), 'ghost'), btn('Setup checklist', () => { showSetup = true; $('#dlg').close(); render(); }, 'ghost')),
      h('div', { class: 'acts' }, btn('Save', () => {
        const lines = el => el.value.split('\n').map(x => x.trim()).filter(Boolean);
        post('settings', { values: {
          defaultMode: f.defaultMode.value, notifications: f.notifications.value, maxParallel: +f.maxParallel.value, taskModel: f.taskModel.value.trim(), reviewModel: f.reviewModel.value.trim(),
          plannerModel: f.plannerModel.value.trim(), taskEffort: f.taskEffort.value, reviewEffort: f.reviewEffort.value, plannerEffort: f.plannerEffort.value, allowSubagents: f.allowSubagents.value === 'true', maxReviews: +f.maxReviews.value, autoReview: f.autoReview.value === 'true', autoMerge: f.autoMerge.value === 'true', mergeIfReviewCannotRun: f.mergeIfReviewCannotRun.value === 'true',
          idleMinutes: Math.max(1, +f.idleMinutes.value || 10), allowedTools: lines(f.allowedTools),
          checks: f.checks.value === 'auto' ? 'auto' : f.checks.value === 'off' ? '' : f.checksCustom.value.trim(),
          folderSetup: f.folderSetup.value === 'auto' ? 'auto' : f.folderSetup.value === 'off' ? '' : f.setupCustom.value.trim(),
          reviewTriage: f.reviewTriage.value === 'true', reviewLightModel: f.reviewLightModel.value.trim(), personalSetup: f.personalSetup.value === 'true',
          freshSessionTokens: Math.max(0, +f.freshSessionTokens.value || 0),
        } });
        post('rules', { rules: lines(rules) });
        $('#mode').dataset.set = '';
        $('#dlg').close();
      }, 'primary')));
  }

  // Per task: tokens (build/review), check and review rounds, first-try pass, time. Totals for the current view.
  function report() {
    const tasks = visible().filter(t => t.startedAt || usageTotal(t));
    const mins = t => t.startedAt ? Math.round(((t.doneAt || Date.now()) - t.startedAt) / 60000) : 0;
    const rows = tasks.map(t => ({ t, build: fresh(t.usage?.build), review: fresh(t.usage?.review), cached: cachedTotal(t), checks: t.checks?.rounds || 0,
      reviews: t.review ? (t.review.state === 'pass' ? t.review.attempts + 1 : t.review.attempts) : 0, first: t.review?.state === 'pass' && !t.review.attempts && !(t.checks?.rounds), mins: mins(t) }));
    const tot = k => rows.reduce((a, r) => a + r[k], 0);
    const reviewed = rows.filter(r => r.t.review?.state === 'pass');
    const viewName = view === 'all' ? 'All tasks' : view === 'backlog' ? 'Backlog' : S.board.sprints.find(s => s.id === view)?.name;
    const md = [`# JustCode report · ${viewName}`, '', `Tasks: ${rows.length} · new tokens: ${tokShort(tot('build') + tot('review'))} (build ${tokShort(tot('build'))}, review ${tokShort(tot('review'))}) + ${tokShort(tot('cached'))} cached · ` +
      `first-try passes: ${reviewed.filter(r => r.first).length}/${reviewed.length} · time: ${tot('mins')} min`, '',
      '| Task | Status | Build | Review | Check rounds | Review rounds | Minutes |', '|---|---|---|---|---|---|---|',
      ...rows.map(r => `| ${r.t.title.replace(/\|/g, '/')} | ${r.t.status} | ${tokShort(r.build)} | ${tokShort(r.review)} | ${r.checks} | ${r.reviews} | ${r.mins} |`)].join('\n');
    dialog('Report',
      h('div', { class: 'kpis' }, [['Tasks', rows.length], ['New tokens', tokShort(tot('build') + tot('review'))], ['Cached re-reads', tokShort(tot('cached'))], ['Build / review', `${tokShort(tot('build'))} / ${tokShort(tot('review'))}`],
        ['First-try passes', `${reviewed.filter(r => r.first).length} / ${reviewed.length}`], ['Avg per task', rows.length ? tokShort((tot('build') + tot('review')) / rows.length) : '–'], ['Minutes', tot('mins')]]
        .map(([k, v]) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', { class: 'muted small' }, k)))),
      rows.length ? h('table', { class: 'rep' }, h('tr', {}, ['Task', 'Status', 'Build', 'Review', 'Checks', 'Reviews', 'Min'].map(x => h('th', {}, x))),
        rows.sort((a, b) => (b.build + b.review) - (a.build + a.review)).map(r => h('tr', { onclick: () => { $('#dlg').close(); openTask(r.t.id, 'details'); } },
          h('td', {}, r.t.title), h('td', {}, r.t.status), h('td', {}, tokShort(r.build)), h('td', {}, tokShort(r.review)), h('td', {}, r.checks), h('td', {}, r.reviews), h('td', {}, r.mins)))) : h('p', { class: 'muted' }, 'No task has run in this view yet.'),
      h('p', { class: 'muted small' }, 'New tokens = written plus input not already cached. Cached re-reads are context re-sent at each step (about a tenth of the cost). First-try pass: passed checks and review without a fix round.'),
      h('div', { class: 'acts' }, btn('Copy as Markdown', () => post('copy', { text: md }))));
  }

  // In a sprint view: the sources that sprint uses, then the rest of the project's library to pick from.
  // In All tasks or Backlog: the whole library, with the sprints using each one.
  function sourcesDialog() {
    const all = S.sources || [], sprint = sprintOf(view), used = sprint ? sprintSrcs(sprint.id) : all;
    const others = sprint ? all.filter(s => !used.includes(s)) : [];
    const usedBy = s => S.board.sprints.filter(sp => !sp.closed && (!sp.sources || sp.sources.includes(s.id))).map(sp => sp.name);
    const status = s => !s.artifact ? '' : s.saving
      ? h('span', { class: 'spill warn', title: 'Claude is saving the artifact\'s files' }, s.asking ? 'Approve in the terminal' : 'Saving…')
      : s.copy
      ? h('span', { class: 'spill ok', title: 'Tasks read this saved copy (the link needs a claude.ai sign-in)' }, `✓ Saved${s.savedAt ? ` ${savedAgo(s.savedAt)}` : ''}`)
      : h('span', { class: 'spill warn', title: 'Tasks cannot open claude.ai links: save a copy first' }, 'Not saved');
    const row = (s, inSprint) => h('li', { class: 'src' },
      h('div', { class: 'srchead' },
        h('span', { class: 'tag' }, s.kind), h('a', { onclick: () => post('openSource', { sourceId: s.id }), title: s.ref }, srcLabel(s)), status(s), h('div', { class: 'spacer' }),
        s.saving ? btn('Show terminal', () => post('showSaveTerminal', { sourceId: s.id }), 'ghost', 'Open the terminal saving it, e.g. if it asks for approval')
          : s.artifact && inSprint !== false ? btn(s.copy ? 'Refresh' : 'Save copy', () => post('saveSourceCopy', { sourceId: s.id }), s.copy ? 'ghost' : 'primary', 'Save the artifact\'s files so tasks can read them') : '',
        inSprint === false ? btn('+ Use in sprint', () => post('sprintSource', { sprintId: sprint.id, sourceId: s.id, on: true }), 'ghost')
          : sprint ? btn('Remove from sprint', () => post('sprintSource', { sprintId: sprint.id, sourceId: s.id, on: false }), 'ghost', 'Kept in the project; other sprints are unaffected')
          : btn('Delete…', () => post('removeSource', { sourceId: s.id }), 'ghost', 'Delete from the whole project (asks first)')),
      inSprint === false ? (s.note ? h('p', { class: 'muted small' }, s.note) : '')
        : h('input', { class: 'grow', value: s.note || '', placeholder: 'What is it? Claude reads this note first', onchange: e => post('editSource', { sourceId: s.id, note: e.target.value }) }),
      !sprint ? h('p', { class: 'muted small' }, usedBy(s).length ? `Used in: ${usedBy(s).join(', ')}` : 'Not used in any open sprint') : '');
    const d = dialog(sprint ? `Sources · ${sprint.name}` : 'Project sources',
      h('p', { class: 'muted' }, sprint
        ? `What ${sprint.name}'s plans and tasks are built on. Claude reads each note and opens only what it needs. A claude.ai link pasted in this sprint's prompts is added here.`
        : 'Every source in this project. Each sprint picks the ones it uses: open a sprint in the view menu to choose.'),
      sprint ? h('h4', {}, `In this sprint (${used.length})`) : '',
      used.length ? h('ul', { class: 'srclist' }, used.map(s => row(s, sprint ? true : undefined)))
        : h('p', { class: 'muted empty' }, sprint ? 'Nothing yet. Add a file or link, or use one from the project below.' : 'No sources yet.'),
      others.length ? h('details', { class: 'srcmore', open: !used.length }, h('summary', {}, `Other project sources (${others.length})`),
        h('ul', { class: 'srclist' }, others.map(s => row(s, false)))) : '',
      h('div', { class: 'acts' }, btn('+ Files or folders', () => post('addSource', { kind: 'file', sprintId: sprint?.id }), 'primary'), btn('+ Link', () => post('addSource', { kind: 'url', sprintId: sprint?.id })),
        btn('Project history', () => post('openArtifact', { which: 'progress' }), 'ghost', 'What merged tasks changed; later tasks read it instead of digging through git')));
    d.dataset.kind = 'sources';
  }

  function guide() {
    const sec = (n, title, ...p) => h('section', { class: 'gsec' }, h('h4', {}, h('span', { class: 'gn' }, n), title), ...p.map(x => typeof x === 'string' ? h('p', {}, x) : x));
    dialog('JustCode in 2 minutes',
      sec(1, 'Set up once', 'The checklist at the top checks Claude Code, your sign-in and git, and fixes what is missing. Any folder works: an existing project, or an empty one (JustCode asks before creating a git repository).'),
      sec(2, 'Add a task', 'Type what you want. Enter adds it, ⌘/Ctrl+Enter adds and runs it. "Details" adds the goal, a "Done when" checklist the reviewer checks against, screenshots (paste them), files and the sprint. Agent and permissions are under Advanced.'),
      sec('✦', 'Plan with Claude', '✦ Plan turns a goal into small tasks, or reworks the To do list. Claude reads the code, may ask you a few questions, and proposes tasks with a goal, likely files and "Done when", grouped into sprints. In a new project it offers to set it up first: it interviews you, then writes .justcode/project.md after you approve.'),
      sec(3, 'Claude works on its own branch', 'Every task gets its own copy of the project and its own branch, so your files and other tasks are never touched. Click a card to watch its activity, message Claude, or see its agents.'),
      sec(4, 'Approvals without babysitting', h('p', {}, h('b', {}, 'Auto'), ' (the default) lets Claude approve what is safe and ask only when unsure. A question or approval turns the card yellow under ', h('b', {}, 'Needs you'), ' with buttons: Allow, Always allow (remembered for the whole project), or Deny with a reason.'),
        'Other modes: Edit automatically (edits approved, commands ask), Manual (everything asks), Plan, Bypass permissions (no approvals; only for trusted work).'),
      sec(5, 'Review and merge', 'When Claude finishes, its work is committed and an AI reviewer runs the tests and checks the diff. Issues go back to Claude automatically. When the review passes, press ✓ Merge (or turn on automatic merging in ⚙). Conflicts stay on the task\'s branch until you or Claude resolve them.'),
      sec('▮', 'Sprints and progress', 'A sprint groups tasks under a goal. Pick it in the view menu: a bar under the toolbar shows how many are done, in review, working, need you or are still to do. ✦ Edit sprint reworks all its not-started tasks with one prompt. The planning panel has its own bar: reading the code, writing the proposal, waiting for you, ready.'),
      sec(6, 'Run a whole list', '▶ Run all runs every To do task in board order (drag cards to reorder), one at a time by default so each builds on the last merged one. Turn on automatic merging and a sprint runs unattended.'),
      sec(7, 'Continue on your phone', '📱 Continue on phone (in a task) moves its session to Claude Code Remote Control: open the Claude app or claude.ai/code to watch, answer and steer it. Close its terminal to bring the task back to the board. Needs a Claude account login.'),
      sec(8, 'More (⋯)', 'The ⋯ button next to Run all opens the agent map (every Claude session and reviewer at work), the report (tokens and rounds per task), the project history and archived tasks. Notifications appear only when something needs you or is ready to merge; everything else is in the JustCode output log.'),
      sec(9, 'Sources and artifacts', 'Add specs, designs, docs and links under 📎 Sources, or attach files to one task. Each task gets a brief (task + sources), Claude writes a handoff (what changed, how it verified it), and the reviewer reads both instead of re-exploring. Merged tasks add a line to the project history. Open them under Details.'),
      sec(10, 'Spending fewer tokens', 'Tasks load only the project\'s Claude setup, share a cached system prompt, and keep command output short. Reviews fit the change (docs: none, small: lighter model) and continue their own session for follow-ups. Long fix rounds restart from the artifacts. Each card shows its tokens; Details splits build and review.'),
      sec(11, 'Good to know', h('ul', {},
        h('li', {}, 'Closing the board never stops work. Closing VS Code pauses it; tasks that were mid-step continue when VS Code opens again.'),
        h('li', {}, 'Usage meter (top right) shows your 5-hour and weekly Claude limits. At the limit, tasks pause and continue after the reset.'),
        h('li', {}, '.env files are copied into each task\'s copy for tests, never committed. Keys, credentials and node_modules are kept out of git.'),
        h('li', {}, 'Everything is in .justcode/ in your project (board, task copies). Details: README.'))),
      h('div', { class: 'acts' }, btn('Got it', () => { post('guideSeen'); S.guideSeen = true; $('#dlg').close(); render(); }, 'primary')));
  }

  /* ---------- messages from the extension ---------- */
  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      S = m;
      if (view !== 'all' && view !== 'backlog' && !S.board?.sprints.some(s => s.id === view)) { view = 'all'; remember(); } // its sprint was deleted if (open && open !== '__planner' && !S.board?.tasks.some(t => t.id === open)) open = undefined;
      render();
      if ($('#dlg').open && $('#dlg').dataset.kind === 'sources') sourcesDialog();
    }
    else if (m.type === 'completions') { acData = m; acLoaded = true; if (acField) acDraw(); }
    else if (m.type === 'history') { history = m.items; if ($('#dlg').open && !sessionView) drawHistory(); }
    else if (m.type === 'sessionLog') { if (sessionView?.id === m.sessionId) { sessionView.steps = m.steps; drawHistory(); } }
    else if (m.type === 'steps') { steps[m.id] = m.steps; if (m.id === open && tab === 'activity') renderDrawer(); }
    else if (m.type === 'savedAgents') { agentsSaved[m.id] = m.nodes; if (m.id === open && tab === 'agents' && !agentView) renderDrawer(); }
    else if (m.type === 'agentLog') { if (agentView?.task === m.id) { agentView.log = m; if (m.id === open && tab === 'agents') renderDrawer(); } }
    else if (m.type === 'changes') { changes[m.id] = m.files; if (m.id === open) renderDrawer(); }
    else if (m.type === 'shots') { shots[m.id] = m.images; if (m.id === open) renderDrawer(); }
    else if (m.type === 'focus') openTask(m.id);
    else if (m.type === 'picked') { files.push(...m.files.filter(f => !files.includes(f))); toggleMore(true); drawFiles(); }
    else if (m.type === 'dialog') bridged(m);
    else if (m.type === 'toast') toast(m.text);
    else if (m.type === 'open') window.open(m.url, '_blank', 'noopener');
    else if (m.type === 'copy') { (navigator.clipboard?.writeText(m.text) ?? Promise.reject()).then(() => toast('Copied.'), () => toast('Could not copy.')); }
    else if (m.type === 'showSetup') { showSetup = true; render(); }
  });
  // Live timers (working for 2m 10s) tick without a state change.
  setInterval(() => {
    if (!S || S.empty) return;
    if (S.board.tasks.some(t => t.run === 'running' || t.reviewing)) { renderLanes(); if (open && tab === 'agents') renderDrawer(); }
    if (agentView && agentView.task === open && tab === 'agents' && S.board.tasks.find(t => t.id === open)?.run === 'running') openAgent(S.board.tasks.find(t => t.id === open), agentView.node);
    const pp = open === '__planner' && S.planner?.run && S.planner.run !== 'idle' && document.querySelector('#drawer .planprog');
    if (pp) pp.replaceWith(planProgress(S.planner, true));
  }, 5000);
  post('ready');
  if (open && open !== '__planner') post('watch', { id: open });
})();
