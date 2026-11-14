// New-task box (webview): prompt, Details, Quick, Add, the / and @ menu and pasted images. Loaded after board.js, which
// shares its helpers and state through window.JC; this file hands the box's state and helpers back on the same object.
(() => {
  const JC = window.JC, { h, $, btn, post, MODES, sprintSrcs, srcLabel } = JC;
  let more = false;                        // new-task details open
  let images = [];                         // pasted screenshots for the new task
  let files = [];                          // files attached to the new task
  let srcOff = new Set();                  // project sources unticked for the new task

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
      const all = acLoaded ? acData.commands : JC.S?.skills || [];
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
      t.kind === '/' && !JC.S?.settings?.personalSetup ? h('div', { class: 'acnote muted small' }, 'Your personal skills and plugins are off for tasks. Turn on "Your personal Claude setup in tasks" in ⚙ to list them.') : '');
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
  function addTask(start, quick = false) {
    const title = $('#title').value.trim();
    if (!title) return $('#title').focus();
    const sprint = $('#sprintSel').value;
    const done = $('#done').value.split('\n').map(x => x.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
    const description = [$('#desc').value.trim(), done.length ? `Done when:\n${done.map(d => `- ${d}`).join('\n')}` : ''].filter(Boolean).join('\n');
    // "make an artifact…", "artifact of the API": the result is a published page, not a code change.
    const output = $('#output').value;   // '' = automatic: the host decides from the text (resolveOutput)
    post('addTask', { title, description, output, agent: $('#agent').value, mode: $('#mode').value, where: $('#where').value,
      sprintId: sprint || undefined, images, files, sources: sprintSrcs(sprint).map(s => s.id).filter(id => !srcOff.has(id)), start, ...(quick ? { quick: true } : {}) });
    $('#title').value = ''; $('#desc').value = ''; $('#done').value = ''; $('#output').value = ''; images = []; files = []; srcOff = new Set(); drawImages(); drawFiles(); renderAddOptions();
  }

  function renderAddOptions() {
    const ag = $('#agent'), cur = ag.value;
    ag.replaceChildren(h('option', { value: '' }, 'Default'), ...JC.S.agents.map(a => h('option', { value: a.name, title: a.description }, `${a.name}${a.scope === 'user' ? ' (yours)' : ''}`)));
    ag.value = JC.S.agents.some(a => a.name === cur) ? cur : '';
    if (!$('#where').dataset.set) { $('#where').value = ['direct', 'branch'].includes(JC.S.settings.defaultWhere) ? JC.S.settings.defaultWhere : ''; $('#where').dataset.set = '1'; }
    if (!$('#mode').dataset.set) { $('#mode').value = JC.S.settings.defaultMode; $('#mode').dataset.set = '1'; }
    const sp = $('#sprintSel'), sc = sp.value, active = JC.S.board.sprints.find(s => s.active && !s.closed);
    sp.replaceChildren(h('option', { value: '' }, 'Backlog'), ...JC.S.board.sprints.filter(s => !s.closed).map(s => h('option', { value: s.id }, s.name)));
    sp.value = sc && JC.S.board.sprints.some(s => s.id === sc) ? sc : (JC.view !== 'all' && JC.view !== 'backlog' ? JC.view : active?.id ?? '');
    sp.onchange = () => { srcOff = new Set(); renderAddOptions(); };
    const srcs = sprintSrcs(sp.value);
    $('#srcpick').replaceChildren(...(srcs.length ? [h('span', { class: 'muted small' }, 'Based on:')] : []), ...srcs.map(s => h('label', { class: 'chip', title: s.note || s.ref },
      h('input', { type: 'checkbox', checked: !srcOff.has(s.id), onchange: e => { e.target.checked ? srcOff.delete(s.id) : srcOff.add(s.id); } }), ' ', srcLabel(s))));
    $('#skills').replaceChildren(...(JC.S.skills.length ? [h('span', { class: 'muted small', title: 'Skills this task can use. Your personal skills appear when "Your personal Claude setup in tasks" is on (⚙).' }, 'Skills:')] : []),
      ...JC.S.skills.map(({ name: n, description: d }) => h('span', { class: 'chip', title: `${d || 'No description'}\n\nClick to use it in this task.`, onclick: () => {
        const t = $('#title'); if (!t.value.trim()) t.value = `/${n}`; else $('#desc').value += `${$('#desc').value ? '\n' : ''}/${n}`;
        if (t.value.trim() === `/${n}`) $('#where').value = 'direct';
      } }, `/${n}`)));
  }

  function addPicked(list) { files.push(...list.filter(f => !files.includes(f))); toggleMore(true); drawFiles(); }
  function completions(m) { acData = m; acLoaded = true; if (acField) acDraw(); }

  const section = h('section', { class: 'composer' },
    h('div', { class: 'box' },
      complete(h('input', { id: 'title', class: 'ask grow', 'aria-label': 'What should Claude do?', placeholder: 'What should Claude do?  / skills · @ files · Enter adds · ⌘/Ctrl+Enter adds and runs', oninput: e => {
        // A lone /command runs in the project folder; anything more is a normal task again.
        if (acRooted && !/^\/\S+\s*$/.test(e.target.value)) { $('#where').value = ''; acRooted = false; }
      }, onkeydown: e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTask(e.metaKey || e.ctrlKey); }
      }, onpaste: pasteImages })),
      btn('Details ▾', () => toggleMore(), '', 'Details, a "Done when" checklist, files, sprint'),
      btn('⚡ Quick', () => addTask(true, true), '', 'Run now in your workspace: no branch, no checks, no AI review. Then Finish (commit) or Discard. For questions and small edits.'),
      btn('Add', () => addTask(false), 'primary', 'Adds to To do: its own branch or the workspace, checked and reviewed. ⌘/Ctrl+Enter adds and runs it.')),
    h('div', { id: 'more', class: 'details', hidden: true },
      h('label', {}, 'Done when (the reviewer checks each line)',
        h('textarea', { id: 'done', rows: 3, placeholder: 'One check per line, e.g.\nthe toggle persists after a reload\nnpm test passes' })),
      h('label', { title: 'Code change: Claude edits the project. Artifact page: Claude designs one web page (with the frontend-design skill) and JustCode publishes it to claude.ai and puts the link on the card.' }, 'Result',
        h('select', { id: 'output' }, h('option', { value: '' }, 'Automatic'), h('option', { value: 'code' }, 'Code change'), h('option', { value: 'artifact' }, 'Artifact page (link)')),
        h('span', { class: 'small' }, '“mockup”, “prototype”, “landing page” become a page with a link.')),
      h('label', { title: 'Own branch: an isolated copy you review and merge. Workspace: runs in your checkout, reviewed, then Finish commits its files.' }, 'Runs in',
        h('select', { id: 'where' }, h('option', { value: '' }, 'Automatic (backlog: workspace, sprint: own branch)'), h('option', { value: 'branch' }, 'Own branch (reviewed, merged)'), h('option', { value: 'direct' }, 'Workspace (reviewed, then Finish)')),
        h('span', { class: 'small' }, 'Based on: ', h('span', { id: 'srcpick', class: 'chips' }))),
      h('details', { class: 'adv wide' }, h('summary', {}, 'More options'),
        complete(h('textarea', { id: 'desc', rows: 2, placeholder: 'Goal and details. / skills · @ files · paste screenshots', onpaste: pasteImages })),
        h('div', { id: 'imgs', class: 'imgs' }),
        h('div', { class: 'row' }, btn('📎 Attach files…', () => post('pickFiles'), 'ghost', 'Files or folders this task is based on (specs, designs, data)'), h('span', { id: 'files', class: 'chips' }),
          h('label', {}, 'Goes to ', h('select', { id: 'sprintSel' })),
          h('label', {}, 'Agent ', h('select', { id: 'agent' })),
          h('label', {}, 'Permissions ', h('select', { id: 'mode' }, MODES.map(([v, l, d]) => h('option', { value: v, title: d }, l))))),
        h('div', { id: 'skills', class: 'chips' }))));
  $('#composer').replaceWith(section);
  section.id = 'composer';

  Object.defineProperties(JC, Object.getOwnPropertyDescriptors({
    get more() { return more; }, set more(v) { more = v; },
    get images() { return images; }, set images(v) { images = v; },
    get files() { return files; }, set files(v) { files = v; },
    get srcOff() { return srcOff; }, set srcOff(v) { srcOff = v; },
    get acData() { return acData; }, set acData(v) { acData = v; },
    get acLoaded() { return acLoaded; }, set acLoaded(v) { acLoaded = v; },
    get acField() { return acField; }, set acField(v) { acField = v; },
    get acItems() { return acItems; }, set acItems(v) { acItems = v; },
    get acSel() { return acSel; }, set acSel(v) { acSel = v; },
    get acDismissed() { return acDismissed; }, set acDismissed(v) { acDismissed = v; },
    get acRooted() { return acRooted; }, set acRooted(v) { acRooted = v; },
    acMenu, acToken, acScore, acMatches, acHide, acDraw, acUpdate, acPick, complete, imagePaste, pasteImages, drawImages,
    base, drawFiles, addTask, addPicked, completions, toggleMore, renderAddOptions,
  }));
})();
