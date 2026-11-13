// JustCode board: dialogs (settings, plan, report, sources, artifacts, design, guide), prompt history and the agent map.
// Shares the board's state and helpers through window.JC (set by board.js, which loads first).
(() => {
  /* ---------- prompt history ---------- */
  // Every prompt you sent (new task, message to a task, planning request), newest first, with each session's
  // conversation one click away. Kept after a task is merged or deleted.
  let history, historyFor, historyQuery = '', sessionView;
  function historyDialog(taskId) {
    historyFor = taskId; sessionView = undefined; history = undefined;
    JC.post('history');
    drawHistory();
  }
  function drawHistory() {
    if (sessionView) {
      const { title, steps: list } = sessionView;
      dialog(`Session · ${title}`, JC.btn('← Back to history', () => { sessionView = undefined; drawHistory(); }, 'ghost'),
        list ? (list.length ? JC.logEl(list) : JC.h('p', { class: 'muted' }, 'This session\'s transcript is no longer on this computer.')) : JC.h('p', { class: 'muted' }, 'Loading…'));
      return;
    }
    const kinds = { task: 'New task', message: 'Message', plan: 'Plan' };
    const q = historyQuery.toLowerCase();
    const items = (history || []).filter(p => (!historyFor || p.taskId === historyFor) && (!q || `${p.title || ''}\n${p.text}`.toLowerCase().includes(q)));
    let search;
    const d = dialog(historyFor ? `History · ${(JC.S.board.tasks.find(t => t.id === historyFor) || {}).title || 'task'}` : 'Prompt history',
      JC.h('div', { class: 'row' }, search = JC.h('input', { class: 'grow', placeholder: 'Search your prompts', value: historyQuery, 'aria-label': 'Search your prompts',
        oninput: e => { historyQuery = e.target.value; drawHistory(); } }),
        historyFor ? JC.btn('All tasks', () => { historyFor = undefined; drawHistory(); }, 'ghost') : ''),
      !history ? JC.h('p', { class: 'muted' }, 'Loading…') : !items.length ? JC.h('p', { class: 'muted' }, q ? 'No prompt matches.' : 'No prompts yet.') :
        JC.h('div', { class: 'hist' }, items.slice(0, 300).map(p => JC.h('div', { class: 'hitem' },
          JC.h('div', { class: 'row small' }, JC.h('span', { class: `tag k-${p.kind}` }, kinds[p.kind] || p.kind),
            p.kind !== 'task' && p.title ? JC.h('b', {}, p.title) : '',
            JC.h('span', { class: 'muted' }, new Date(p.time).toLocaleString()),
            p.taskId && !p.exists ? JC.h('span', { class: 'muted' }, '· task deleted') : p.status === 'done' ? JC.h('span', { class: 'muted' }, '· done') : ''),
          JC.h('div', { class: 'htext', title: 'Click to show all', onclick: e => e.currentTarget.classList.toggle('full') }, p.text),
          JC.h('div', { class: 'acts' },
            p.exists ? JC.btn('Open task', () => { JC.$('#dlg').close(); JC.openTask(p.taskId); }, 'ghost') : '',
            ...p.sessions.map((sid, i) => JC.btn(p.sessions.length > 1 ? `Conversation ${i + 1}` : 'Conversation', () => {
              sessionView = { id: sid, title: p.title || kinds[p.kind] }; JC.post('sessionLog', { sessionId: sid }); drawHistory();
            }, 'ghost', `Session ${sid.slice(0, 8)}`)),
            JC.btn('Copy', () => JC.post('copy', { text: p.text }), 'ghost'),
            JC.btn('Use again', () => { JC.$('#dlg').close(); const [first, ...rest] = p.text.split('\n\n'); JC.$('#title').value = first; JC.$('#desc').value = rest.join('\n\n'); if (rest.length) JC.toggleMore(true); JC.$('#title').focus(); }, 'ghost', 'Put it in the add box to send again'))))));
    if (document.activeElement !== search && d.open) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  // Sprint progress: the sprint on screen (or the active one in All tasks), as a bar split by lane, plus its goal.
  /* ---------- agent map ---------- */
  // One agent's details and conversation, like Claude Code's agent map: status, type, model, who spawned it, time,
  // tokens, its final answer, then every step.
  function agentDetail(t) {
    const v = JC.agentView, n = v.node, log = v.log;
    const ms = log?.ms || n.ms || (n.started ? Date.now() - n.started : 0), tokens = log?.tokens || n.tokens;
    return [
      JC.h('div', { class: 'row' }, JC.btn('←', () => { JC.agentView = undefined; JC.renderDrawer(); }, 'ghost icon', 'Back to the agents'), JC.h('span', { class: `sdot s-${n.status}` }), JC.h('b', {}, n.main ? 'Task session' : n.description || n.name)),
      JC.h('p', { class: 'muted small' }, [{ running: 'Running', completed: 'Finished', failed: 'Failed', stopped: 'Stopped', waiting: 'Needs you', idle: 'Idle' }[n.status] || n.status,
        n.main ? '' : n.name, log?.model ? JC.modelName(log.model) : t.modelUsed ? JC.modelName(t.modelUsed) : ''].filter(Boolean).join(' · ')),
      n.main ? '' : JC.h('p', { class: 'muted small' }, 'Spawned by the main agent'),
      JC.h('p', { class: 'muted small' }, [ms ? JC.ago(Date.now() - ms) : '', tokens ? JC.tok(tokens) : ''].filter(Boolean).join(' · ')),
      !log ? JC.h('p', { class: 'muted' }, 'Loading…') : '',
      log?.result ? JC.h('div', { class: 'aresult' }, log.result) : '',
      log && !log.steps?.length ? JC.h('p', { class: 'muted' }, n.status === 'running' ? 'Its transcript appears as it works.' : 'No saved transcript for this agent.') : '',
      log?.steps?.length ? JC.h('details', { open: !log.result }, JC.h('summary', {}, `Transcript · ${log.steps.length} steps`), JC.logEl(log.steps)) : ''];
  }
  function openAgent(t, n) {
    JC.agentView = { task: t.id, node: n };
    JC.post('agentLog', { id: t.id, sessionId: n.sessionId || t.sessionId, agent: n.main ? 'main' : n.key || n.toolUseId || n.id });
    JC.renderDrawer();
  }

  function agentTree(groups, single) {
    const row = (n, depth, extra = '', t) => JC.h('div', { class: `node d${Math.min(depth, 4)} s-${n.status}${single && t ? ' click' : ''}`, onclick: single && t ? () => openAgent(t, n) : undefined, title: single && t ? 'Show its conversation' : undefined },
      JC.h('span', { class: 'sdot' }), JC.h('div', { class: 'ninfo' }, JC.h('b', {}, n.name), n.description && n.description !== n.name ? JC.h('span', { class: 'muted' }, ` · ${n.description.slice(0, 90)}`) : '',
        JC.h('div', { class: 'muted small' }, [n.ms || n.started ? (n.status === 'running' ? JC.ago(n.started) : JC.ago(Date.now() - (n.ms || 0))) : '', n.tokens ? JC.tok(n.tokens) : '', n.tools ? `${n.tools} tool uses` : '', n.last && n.status === 'running' ? `now: ${n.last}` : '', extra].filter(Boolean).join(' · ')),
        n.summary ? JC.h('div', { class: 'small' }, n.summary) : ''));
    const out = [];
    for (const g of groups) {
      if (!single) out.push(JC.h('h4', {}, g.name));
      for (const t of g.tasks) {
        const nodes = t.agents || [];
        const kids = p => nodes.filter(n => n.parent === p);
        const walk = (p, d) => kids(p).flatMap(n => [row(n, d, '', t), ...walk(n.id, d + 1)]);
        const main = nodes.find(n => n.id === 'main');
        const status = t.asks?.length ? 'waiting' : t.run === 'running' || t.run === 'starting' ? 'running' : main ? 'completed' : 'idle';
        out.push(JC.h('div', { class: 'tree', onclick: single ? undefined : () => { JC.$('#dlg').close(); if (g.root !== JC.S.root) JC.post('root', { root: g.root }); JC.openTask(t.id, 'agents'); } },
          row({ ...(main || {}), main: true, name: single ? 'Task session' : t.title, description: single ? '' : t.status, status, started: main?.started }, 0, t.asks?.length ? 'needs you' : '', t),
          walk('main', 1),
          t.reviewing ? row({ name: 'AI reviewer', description: 'tests and reviews the diff', status: 'running', started: t.reviewing }, 1) : ''));
      }
    }
    if (!out.length) out.push(JC.h('p', { class: 'muted' }, 'No agents at work right now.'));
    return JC.h('div', { class: 'agentmap' }, out);
  }

  function agentMap() {
    const groups = (JC.S.all || []).filter(g => g.tasks.length);
    const n = groups.reduce((a, g) => a + g.tasks.reduce((b, t) => b + Math.max(1, t.agents?.length || 0) + (t.reviewing ? 1 : 0), 0), 0);
    dialog('Agent map', JC.h('p', { class: 'muted' }, `${n} agent${n === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'} · click a task for details`), agentTree(groups, false));
  }

  /* ---------- dialogs ---------- */
  function toast(text) {
    const t = JC.h('div', { class: 'toast', role: 'status', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#333;color:#fff;padding:10px 16px;border-radius:8px;z-index:9999' }, text);
    document.body.append(t); setTimeout(() => t.remove(), 2500);
  }
  // A dialog the host asked for (merge, bypass, discard, pick files, text input). Closing it any other way is a decline.
  function bridged(m) {
    const d = JC.$('#dlg');
    let done = false;
    const reply = (extra) => { if (done) return; done = true; JC.post('dialogReply', { id: m.id, ...extra }); };
    const field = m.input ? JC.h(m.input.multiline ? 'textarea' : 'input', { 'aria-label': m.input.label, rows: 4, style: 'width:100%;box-sizing:border-box' }) : null;
    const finish = (extra) => { reply(extra); d.close(); };
    dialog(m.title, JC.h('p', {}, m.text || ''), field || '',
      JC.h('div', { class: 'acts' }, JC.btn('Cancel', () => finish({ cancelled: true }), 'ghost'),
        ...(m.buttons || ['OK']).map(b => JC.btn(b, () => finish({ button: b, value: field ? field.value : undefined }), 'primary'))));
    d.addEventListener('close', () => reply({ cancelled: true }), { once: true });
  }
  function dialog(title, ...content) {
    const d = JC.$('#dlg');
    delete d.dataset.kind;
    d.replaceChildren(JC.h('div', { class: 'dlghead' }, JC.h('h3', {}, title), JC.btn('×', () => d.close(), 'ghost icon', 'Close')), JC.h('div', { class: 'dlgbody' }, content));
    if (!d.open) d.showModal();
    return d;
  }

  function newSprint() {
    let name, goal;
    dialog('New sprint', name = JC.h('input', { placeholder: 'Sprint name', value: `Sprint ${JC.S.board.sprints.length + 1}` }), goal = JC.h('input', { placeholder: 'Goal (optional)' }),
      JC.h('div', { class: 'acts' }, JC.btn('Create', () => { if (name.value.trim()) { JC.post('addSprint', { name: name.value.trim(), goal: goal.value }); JC.$('#dlg').close(); } }, 'primary')));
    name.select();
  }

  function openPlanner() { open = '__planner'; JC.remember(); JC.render(); }

  // The one way to plan with Claude: new tasks from a goal, or rework To do tasks. With a sprint (✦ Edit sprint, or
  // ✦ Plan while a sprint is shown), one prompt edits every not-started task in that sprint. Offers project setup
  // first when the project has no Claude setup yet.
  function planDialog(todoIds, sprint, editSprint = false) {
    const pr = JC.S.project || {};
    const missing = [!pr.projectMd && 'a project description'].filter(Boolean);
    const started = sprint ? JC.S.board.tasks.filter(t => t.sprintId === sprint.id && !t.archived && !(t.status === 'todo' && !t.worktree)).length : 0;
    const where = sprint ? ` in ${sprint.name}` : '';
    let goal, rework, chips;
    const shots = [], thumbs = JC.h('div', { class: 'imgs' }), paste = JC.imagePaste(shots, thumbs);
    const presets = ['Add a "Done when" checklist to each', 'Split anything too big', 'Merge duplicates', 'Order by dependency', sprint ? 'Make them fit the sprint goal' : 'Group into sprints'];
    dialog(editSprint ? `Edit ${sprint.name} with Claude` : 'Plan with Claude',
      missing.length && !editSprint ? JC.h('div', { class: 'banner info' }, JC.h('div', { class: 'grow' }, JC.h('b', {}, 'Set up this project first? '),
        `It is missing ${JC.andList(missing)}. Claude reads the code, asks you a few questions, shows what it will write, and saves it to .justcode/project.md after you approve.`),
        JC.btn('Set up project', () => { JC.post('initialize'); JC.$('#dlg').close(); }, 'primary')) : '',
      JC.h('p', { class: 'muted' }, editSprint
        ? `One prompt edits all ${todoIds.length} not-started task${todoIds.length === 1 ? '' : 's'}${where}: reword, split, merge, add, remove or reorder.${sprint.goal ? ` Sprint goal: ${sprint.goal}.` : ''}${started ? ` Claude also checks the ${started} started or done task${started === 1 ? '' : 's'}: a done one that must change goes back to To do, a started one gets the change as a message.` : ''} You review every change before it is applied.`
        : 'Claude reads the code (read-only) and may ask you a few questions. It proposes tasks with a goal, likely files and a "Done when" checklist, grouped into sprints. Keep chatting to refine, then apply the ones you want.'),
      goal = JC.complete(JC.h('textarea', { rows: 4, onpaste: paste.onpaste, 'aria-label': 'What you want; paste screenshots here', placeholder: editSprint ? `What should change in all of them? e.g. "add Done when to each and split anything too big"` : todoIds.length ? 'What do you want? e.g. "Add password reset by email" or "split anything too big"' : 'What do you want to build or change? e.g. Add password reset by email, with tests' })),
      todoIds.length && !editSprint ? JC.h('label', { class: 'row' }, rework = JC.h('input', { type: 'checkbox', onchange: () => { chips.hidden = !rework.checked; } }), ` Also rework the ${todoIds.length} To do task${todoIds.length === 1 ? '' : 's'}${where}${started ? `, and check the ${started} started or done` : ''}`) : '',
      thumbs, JC.h('p', { class: 'muted small' }, 'Type / for skills and @ for files. Paste screenshots or designs into the box: Claude looks at them first.'),
      chips = JC.h('div', { class: 'chips', hidden: !editSprint }, presets.map(p => JC.h('span', { class: 'chip', onclick: () => { goal.value = goal.value ? `${goal.value}; ${p}` : p; } }, p))),
      JC.h('div', { class: 'acts' }, JC.btn(editSprint ? '✦ Edit the sprint' : '✦ Start planning', () => {
        if (!goal.value.trim()) return goal.focus();
        const ids = editSprint || rework?.checked ? todoIds : [];
        JC.post('planner', { instruction: goal.value.trim(), ids, sprint: ids.length && sprint ? { name: sprint.name, goal: sprint.goal } : undefined, images: shots,
          into: (sprint ?? JC.S.board.sprints.find(s => s.active && !s.closed))?.name });
        JC.$('#dlg').close();
        openPlanner();
      }, 'primary')));
    goal.focus();
  }

  function moreMenu() {
    const item = (label, help, fn) => JC.h('button', { class: 'menuitem', onclick: () => { JC.$('#dlg').close(); fn(); } }, JC.h('b', {}, label), JC.h('span', { class: 'muted small' }, help));
    dialog('More',
      JC.h('div', { class: 'menu' },
        item('Agent map', 'Every Claude session, subagent and reviewer at work', () => agentMap()),
        item('Report', 'Tokens, rounds and time per task', () => report()),
        item('Prompt history', 'Every prompt you sent and each session\'s conversation', () => historyDialog()),
        item('Project history', 'What merged tasks changed', () => JC.post('openArtifact', { which: 'progress' })),
        item(JC.showArchived ? 'Hide archived tasks' : 'Show archived tasks', 'Archived tasks stay out of the lanes', () => { JC.showArchived = !JC.showArchived; JC.render(); }),
        item('Set up project with Claude', 'Interview, then .justcode/project.md', () => JC.post('initialize'))));
  }

  function settings() {
    const s = JC.S.settings;
    const f = {};
    const field = (key, label, input, help) => JC.h('label', { class: 'blk' }, JC.h('span', {}, label), f[key] = input, help ? JC.h('span', { class: 'muted small' }, help) : '');
    const sel = (v, opts) => JC.h('select', {}, opts.map(([k, l]) => JC.h('option', { value: k, selected: String(v) === String(k) }, l)));
    const effort = v => sel(v, [['low', 'Low (fewest tokens)'], ['medium', 'Medium'], ['high', 'High'], ['', 'Model default']]);
    // Every model in one dropdown (aliases follow the newest version); "Other…" takes any model id. Reads like an input: .value.
    const MODEL_LIST = [['', 'Your Claude default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (latest)'],
      ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
    const models = v => {
      const known = MODEL_LIST.some(m => m[0] === v);
      const sel = JC.h('select', { onchange: () => { other.hidden = sel.value !== '__other'; if (!other.hidden) other.focus(); } },
        MODEL_LIST.map(([k, l]) => JC.h('option', { value: k, selected: known && k === v }, l)), JC.h('option', { value: '__other', selected: !known }, 'Other model id…'));
      const other = JC.h('input', { value: known ? '' : v, placeholder: 'e.g. claude-opus-4-8', hidden: known });
      const box = JC.h('div', { class: 'modelpick' }, sel, other);
      Object.defineProperty(box, 'value', { get: () => sel.value === '__other' ? other.value.trim() : sel.value });
      return box;
    };
    let rules;
    dialog('Settings',
      JC.h('div', { class: 'grid' },
        field('defaultMode', 'Permissions for new tasks', sel(s.defaultMode, JC.MODES.map(([k, l]) => [k, l])), 'Auto lets Claude approve what is safe; the card asks only when unsure.'),
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
        field('idleMinutes', 'Close idle Claude processes after (minutes)', JC.h('input', { type: 'number', min: 1, value: s.idleMinutes })),
        field('checks', 'Checks after each turn (no tokens)', sel(s.checks === '' ? 'off' : s.checks === 'auto' ? 'auto' : 'custom', [['auto', `Auto${JC.S.detectedChecks?.length ? `: ${JC.S.detectedChecks.map(c => c.cmd).join(' · ')}` : ' (none found here)'}`], ['off', 'Off'], ['custom', 'My commands (below)']]),
          'Failures go back to Claude before the AI review.'),
        field('checksCustom', 'My check commands (one per line)', JC.h('textarea', { rows: 2, placeholder: 'npm test\nnpx tsc --noEmit' }, s.checks !== 'auto' ? s.checks : '')),
        field('folderSetup', 'Task folder setup', sel(s.setup === '' ? 'off' : s.setup === 'auto' ? 'auto' : 'custom', [['auto', 'Auto: link node_modules, use .venv'], ['off', 'Off'], ['custom', 'My command (below)']])),
        field('setupCustom', 'My setup command', JC.h('input', { value: s.setup !== 'auto' ? s.setup : '', placeholder: 'pnpm install' })),
        field('reviewTriage', 'Review size', sel(s.review.triage, [[true, 'Fit to the change (saves tokens)'], [false, 'Always the full reviewer']]), 'Docs-only: no review. Small, non-sensitive: lighter model.'),
        field('reviewLightModel', 'Model for small reviews', models(s.review.lightModel)),
        field('superpowers', 'superpowers plugin in sessions', sel(s.superpowers, [[true, 'On (when installed)'], [false, 'Off: saves tokens on every step']])),
        field('personalSetup', 'Your personal Claude setup in tasks', sel(s.personalSetup, [[false, 'Off: project setup only (saves ~7k tokens per step)'], [true, 'On: plugins, skills, MCP, memory']])),
        field('freshSessionTokens', 'Fresh session for fixes above (tokens of context)', JC.h('input', { type: 'number', min: 0, step: 10000, value: s.freshAfterTokens }), '0 = never. Fix rounds then start from the brief, handoff and review notes.')),
      JC.h('label', { class: 'blk' }, JC.h('span', {}, `Always allowed in ${JC.S.roots.find(r => r.path === JC.S.root)?.name ?? 'this project'}`),
        rules = JC.h('textarea', { rows: 4, placeholder: 'One rule per line, e.g. Bash(npm run:*)' }, (JC.S.board.rules || []).join('\n')),
        JC.h('span', { class: 'muted small' }, 'Added when you press "Always allow…" on a card. Every task in this project gets them.')),
      f.allowedTools = JC.h('textarea', { rows: 3, placeholder: 'One rule per line, for every project' }, (s.allowedTools || []).join('\n')),
      JC.h('span', { class: 'muted small' }, 'Always allowed in every project.'),
      policySection(),
      phoneSection(),
      JC.h('div', { class: 'row' }, JC.btn(s.apiKey ? 'Change or remove API key' : 'Use an API key instead of my Claude login', () => JC.post('apiKey'), 'ghost'), JC.btn('Setup checklist', () => { JC.showSetup = true; JC.$('#dlg').close(); JC.render(); }, 'ghost')),
      JC.h('div', { class: 'acts' }, JC.btn('Save', () => {
        const lines = el => el.value.split('\n').map(x => x.trim()).filter(Boolean);
        JC.post('settings', { values: {
          defaultMode: f.defaultMode.value, notifications: f.notifications.value, maxParallel: +f.maxParallel.value, taskModel: f.taskModel.value.trim(), reviewModel: f.reviewModel.value.trim(),
          plannerModel: f.plannerModel.value.trim(), taskEffort: f.taskEffort.value, reviewEffort: f.reviewEffort.value, plannerEffort: f.plannerEffort.value, allowSubagents: f.allowSubagents.value === 'true', maxReviews: +f.maxReviews.value, autoReview: f.autoReview.value === 'true', autoMerge: f.autoMerge.value === 'true', mergeIfReviewCannotRun: f.mergeIfReviewCannotRun.value === 'true',
          idleMinutes: Math.max(1, +f.idleMinutes.value || 10), allowedTools: lines(f.allowedTools),
          checks: f.checks.value === 'auto' ? 'auto' : f.checks.value === 'off' ? '' : f.checksCustom.value.trim(),
          folderSetup: f.folderSetup.value === 'auto' ? 'auto' : f.folderSetup.value === 'off' ? '' : f.setupCustom.value.trim(),
          reviewTriage: f.reviewTriage.value === 'true', reviewLightModel: f.reviewLightModel.value.trim(), personalSetup: f.personalSetup.value === 'true', superpowers: f.superpowers.value === 'true',
          freshSessionTokens: Math.max(0, +f.freshSessionTokens.value || 0),
        } });
        JC.post('rules', { rules: lines(rules) });
        JC.$('#mode').dataset.set = '';
        JC.$('#dlg').close();
      }, 'primary')));
  }

  // Per task: tokens (build/review), check and review rounds, first-try pass, time. Totals for the current view.
  function report() {
    const tasks = JC.visible().filter(t => t.startedAt || JC.usageTotal(t));
    const mins = t => t.startedAt ? Math.round(((t.doneAt || Date.now()) - t.startedAt) / 60000) : 0;
    const rows = tasks.map(t => ({ t, build: JC.fresh(t.usage?.build), review: JC.fresh(t.usage?.review), cached: JC.cachedTotal(t), checks: t.checks?.rounds || 0,
      reviews: t.review ? (t.review.state === 'pass' ? t.review.attempts + 1 : t.review.attempts) : 0, first: t.review?.state === 'pass' && !t.review.attempts && !(t.checks?.rounds), mins: mins(t) }));
    const tot = k => rows.reduce((a, r) => a + r[k], 0);
    const reviewed = rows.filter(r => r.t.review?.state === 'pass');
    const viewName = JC.view === 'all' ? 'All tasks' : JC.view === 'backlog' ? 'Backlog' : JC.S.board.sprints.find(s => s.id === JC.view)?.name;
    const md = [`# JustCode report · ${viewName}`, '', `Tasks: ${rows.length} · new tokens: ${JC.tokShort(tot('build') + tot('review'))} (build ${JC.tokShort(tot('build'))}, review ${JC.tokShort(tot('review'))}) + ${JC.tokShort(tot('cached'))} cached · ` +
      `first-try passes: ${reviewed.filter(r => r.first).length}/${reviewed.length} · time: ${tot('mins')} min`, '',
      '| Task | Status | Build | Review | Check rounds | Review rounds | Minutes |', '|---|---|---|---|---|---|---|',
      ...rows.map(r => `| ${r.t.title.replace(/\|/g, '/')} | ${r.t.status} | ${JC.tokShort(r.build)} | ${JC.tokShort(r.review)} | ${r.checks} | ${r.reviews} | ${r.mins} |`)].join('\n');
    dialog('Report',
      JC.h('div', { class: 'kpis' }, [['Tasks', rows.length], ['New tokens', JC.tokShort(tot('build') + tot('review'))], ['Cached re-reads', JC.tokShort(tot('cached'))], ['Build / review', `${JC.tokShort(tot('build'))} / ${JC.tokShort(tot('review'))}`],
        ['First-try passes', `${reviewed.filter(r => r.first).length} / ${reviewed.length}`], ['Avg per task', rows.length ? JC.tokShort((tot('build') + tot('review')) / rows.length) : '–'], ['Minutes', tot('mins')],
        ['Project cost (est.)', `$${(JC.costOf(JC.S.board.tasks) + (JC.S.board.plannerCostUsd || 0)).toFixed(2)}${JC.S.policy?.policy.maxCostUsd.project ? ` / $${JC.S.policy.policy.maxCostUsd.project}` : ''}`]]
        .map(([k, v]) => JC.h('div', { class: 'kpi' }, JC.h('b', {}, v), JC.h('span', { class: 'muted small' }, k)))),
      rows.length ? JC.h('table', { class: 'rep' }, JC.h('tr', {}, ['Task', 'Status', 'Build', 'Review', 'Checks', 'Reviews', 'Min'].map(x => JC.h('th', {}, x))),
        rows.sort((a, b) => (b.build + b.review) - (a.build + a.review)).map(r => JC.h('tr', { onclick: () => { JC.$('#dlg').close(); JC.openTask(r.t.id, 'details'); } },
          JC.h('td', {}, r.t.title), JC.h('td', {}, r.t.status), JC.h('td', {}, JC.tokShort(r.build)), JC.h('td', {}, JC.tokShort(r.review)), JC.h('td', {}, r.checks), JC.h('td', {}, r.reviews), JC.h('td', {}, r.mins)))) : JC.h('p', { class: 'muted' }, 'No task has run in this view yet.'),
      JC.h('p', { class: 'muted small' }, 'New tokens = written plus input not already cached. Cached re-reads are context re-sent at each step (about a tenth of the cost). First-try pass: passed checks and review without a fix round.'),
      JC.h('div', { class: 'acts' }, JC.btn('Copy as Markdown', () => JC.post('copy', { text: md }))));
  }

  // In a sprint view: the sources that sprint uses, then the rest of the project's library to pick from.
  // In All tasks or Backlog: the whole library, with the sprints using each one.
  function sourcesDialog() {
    const all = JC.S.sources || [], sprint = JC.sprintOf(JC.view), used = sprint ? JC.sprintSrcs(sprint.id) : all;
    const others = sprint ? all.filter(s => !used.includes(s)) : [];
    const usedBy = s => JC.S.board.sprints.filter(sp => !sp.closed && (!sp.sources || sp.sources.includes(s.id))).map(sp => sp.name);
    const status = s => !s.artifact ? '' : s.saving
      ? JC.h('span', { class: 'spill warn', title: 'Claude is saving the artifact\'s files' }, s.asking ? 'Approve in the terminal' : 'Saving…')
      : s.copy
      ? JC.h('span', { class: 'spill ok', title: 'Tasks read this saved copy (the link needs a claude.ai sign-in)' }, `✓ Saved${s.savedAt ? ` ${JC.savedAgo(s.savedAt)}` : ''}`)
      : JC.h('span', { class: 'spill warn', title: 'Tasks cannot open claude.ai links: save a copy first' }, 'Not saved');
    const row = (s, inSprint) => JC.h('li', { class: 'src' },
      JC.h('div', { class: 'srchead' },
        JC.h('span', { class: 'tag' }, s.kind), JC.h('a', { onclick: () => JC.post('openSource', { sourceId: s.id }), title: s.ref }, JC.srcLabel(s)), status(s), JC.h('div', { class: 'spacer' }),
        s.saving ? JC.btn('Show terminal', () => JC.post('showSaveTerminal', { sourceId: s.id }), 'ghost', 'Open the terminal saving it, e.g. if it asks for approval')
          : s.artifact && inSprint !== false ? JC.btn(s.copy ? 'Refresh' : 'Save copy', () => JC.post('saveSourceCopy', { sourceId: s.id }), s.copy ? 'ghost' : 'primary', 'Save the artifact\'s files so tasks can read them') : '',
        inSprint === false ? JC.btn('+ Use in sprint', () => JC.post('sprintSource', { sprintId: sprint.id, sourceId: s.id, on: true }), 'ghost')
          : sprint ? JC.btn('Remove from sprint', () => JC.post('sprintSource', { sprintId: sprint.id, sourceId: s.id, on: false }), 'ghost', 'Kept in the project; other sprints are unaffected')
          : JC.btn('Delete…', () => JC.post('removeSource', { sourceId: s.id }), 'ghost', 'Delete from the whole project (asks first)')),
      inSprint === false ? (s.note ? JC.h('p', { class: 'muted small' }, s.note) : '')
        : JC.h('input', { class: 'grow', value: s.note || '', placeholder: 'What is it? Claude reads this note first', onchange: e => JC.post('editSource', { sourceId: s.id, note: e.target.value }) }),
      !sprint ? JC.h('p', { class: 'muted small' }, usedBy(s).length ? `Used in: ${usedBy(s).join(', ')}` : 'Not used in any open sprint') : '');
    const d = dialog(sprint ? `Sources · ${sprint.name}` : 'Project sources',
      JC.h('p', { class: 'muted' }, sprint
        ? `What ${sprint.name}'s plans and tasks are built on. Claude reads each note and opens only what it needs. A claude.ai link pasted in this sprint's prompts is added here.`
        : 'Every source in this project. Each sprint picks the ones it uses: open a sprint in the view menu to choose.'),
      sprint ? JC.h('h4', {}, `In this sprint (${used.length})`) : '',
      used.length ? JC.h('ul', { class: 'srclist' }, used.map(s => row(s, sprint ? true : undefined)))
        : JC.h('p', { class: 'muted empty' }, sprint ? 'Nothing yet. Add a file or link, or use one from the project below.' : 'No sources yet.'),
      others.length ? JC.h('details', { class: 'srcmore', open: !used.length }, JC.h('summary', {}, `Other project sources (${others.length})`),
        JC.h('ul', { class: 'srclist' }, others.map(s => row(s, false)))) : '',
      JC.h('div', { class: 'acts' }, JC.btn('+ Files or folders', () => JC.post('addSource', { kind: 'file', sprintId: sprint?.id }), 'primary'), JC.btn('+ Link', () => JC.post('addSource', { kind: 'url', sprintId: sprint?.id })),
        JC.btn('Project history', () => JC.post('openArtifact', { which: 'progress' }), 'ghost', 'What merged tasks changed; later tasks read it instead of digging through git')));
    d.dataset.kind = 'sources';
  }

  // ⚙ → Phone: paired phones, how long each stays signed in, and Revoke.
  function phoneSection() {
    const P = JC.S.phone;
    if (!P || JC.REMOTE) return '';
    const day = ms => new Date(ms).toLocaleDateString();
    return JC.h('details', { class: 'adv' }, JC.h('summary', {}, `Phone${P.on ? ` · ${P.devices.length} paired` : ' · server off'}`),
      JC.h('p', { class: 'muted small' }, P.on ? `A paired phone stays signed in for ${P.days} day(s) (justCode.phoneTokenDays), then pairs again with a new code from JustCode: Show Phone Pairing.` : 'Turn on justCode.phoneServer to use the phone page or the Android app.'),
      P.devices.length ? JC.h('ul', { class: 'small' }, P.devices.map(d => JC.h('li', { class: 'row' },
        JC.h('span', { class: 'grow' }, `Device …${d.id} · paired ${day(d.created)} · ${d.lastUsed ? `last used ${JC.savedAgo(d.lastUsed)}` : 'not used yet'} · expires ${day(d.expires)}`),
        JC.btn('Revoke', () => JC.post('phoneRevoke', { id: d.id }), 'ghost small')))) : '',
      P.devices.length > 1 ? JC.btn('Revoke all', () => JC.post('phoneRevoke', { id: 'all' }), 'ghost') : '');
  }

  // ⚙ → Policy: what .justcode/policy.json enforces in this project, and what it denied today.
  function policySection() {
    const P = JC.S.policy;
    if (!P) return '';
    const p = P.policy, list = a => a.length ? a.join(', ') : 'none';
    const cost = k => p.maxCostUsd[k] ? `$${p.maxCostUsd[k]}` : 'no limit';
    return JC.h('details', { class: 'adv', open: !!P.errors.length },
      JC.h('summary', {}, `Policy${P.denials.length ? ` · ${P.denials.length} denied today` : ''}${P.errors.length ? ' · has errors' : ''}`),
      JC.h('p', { class: 'muted small' }, 'Rules every task in this project follows, whatever its permission mode. Edit the file to change them; they apply at once.'),
      ...P.errors.map(e => JC.h('p', { class: 'err small' }, e)),
      JC.h('ul', { class: 'small' },
        JC.h('li', {}, 'Protected paths (no edits): ', list(p.protectedPaths)),
        JC.h('li', {}, 'Denied tools: ', list(p.denyTools)),
        JC.h('li', {}, 'Forbidden modes: ', list(p.forbidModes)),
        JC.h('li', {}, 'Needs your approval before merging when a path contains: ', list(p.requireHumanReviewFor)),
        JC.h('li', {}, `Budgets: task ${cost('task')}, sprint ${cost('sprint')}, project ${cost('project')}`),
        JC.h('li', {}, 'Models: ', p.allowedModels.length ? p.allowedModels.join(', ') : 'any'),
        JC.h('li', {}, `Checks must pass to merge: ${p.requireChecksPass ? 'yes' : 'no'} · Secret scan before commits: ${p.secretScan ? 'on' : 'off'}`)),
      P.denials.length ? JC.h('div', {}, JC.h('h4', {}, 'Denied today'), JC.h('ul', { class: 'small' }, P.denials.slice().reverse().map(d => JC.h('li', {},
        JC.h('span', { class: 'muted' }, d.time.slice(11, 16), ' '), d.taskId ? JC.h('a', { onclick: () => { JC.$('#dlg').close(); JC.openTask(d.taskId, 'activity'); } }, JC.S.board.tasks.find(t => t.id === d.taskId)?.title || d.taskId) : '', ' ', d.detail || '')))) : '',
      !JC.REMOTE ? JC.h('div', { class: 'row' }, JC.btn('Open policy.json', () => JC.post('openPolicy'), 'ghost'), JC.btn('Export audit log', () => JC.post('exportAudit'), 'ghost')) : '');
  }

  // Every artifact the project typed, saved or published, with the tasks that used or produced it.
  function artifactsDialog() {
    const list = [...(JC.S.registry || [])].sort((a, b) => b.lastSeen - a.lastSeen);
    const title = id => JC.S.board.tasks.find(t => t.id === id)?.title;
    const isSource = e => (JC.S.sources || []).some(s => s.kind === 'url' && JC.artKey(s.ref) === e.url);
    const src = e => (JC.S.sources || []).find(s => s.kind === 'url' && JC.artKey(s.ref) === e.url);
    const row = e => JC.h('li', { class: 'src' },
      JC.h('div', { class: 'srchead' },
        JC.h('span', { class: `tag${e.kind === 'output' ? ' ok' : ''}` }, e.kind === 'output' ? 'published' : 'input'),
        JC.h('a', { onclick: () => JC.post('openUrl', { url: e.url }), title: e.url }, e.title || e.url.replace(/^https?:\/\//, '')),
        e.changedAt ? JC.h('span', { class: 'spill warn', title: 'The last refresh found different content' }, `changed ${JC.savedAgo(e.changedAt)}`) : '',
        e.kind === 'input' && src(e)?.copy ? JC.h('span', { class: 'spill ok' }, `✓ Saved${src(e).savedAt ? ` ${JC.savedAgo(src(e).savedAt)}` : ''}`) : '',
        JC.h('div', { class: 'spacer' }),
        JC.btn('Copy link', () => JC.post('copy', { text: e.url }), 'ghost'),
        e.kind === 'input' && isSource(e) ? JC.btn('Refresh copy', () => JC.post('refreshArtifact', { url: e.url }), 'ghost', 'Save the artifact\'s files again') : '',
        !JC.REMOTE ? JC.btn('Use as source', () => JC.post('useArtifact', { url: e.url, sprintId: JC.sprintOf(JC.view)?.id }), 'ghost', 'Adds it to 📎 Sources and ticks it for the next task') : ''),
      e.taskIds.length ? JC.h('p', { class: 'small' }, e.kind === 'output' ? 'Produced by: ' : 'Used by: ',
        ...e.taskIds.filter(title).map((id, i) => [i ? ', ' : '', JC.h('a', { onclick: () => { JC.$('#dlg').close(); JC.openTask(id, 'details'); } }, title(id))])) : '',
      JC.h('input', { class: 'grow', value: e.note || '', placeholder: 'Note (Claude reads it in briefs)', onchange: ev => JC.post('artifactNote', { url: e.url, note: ev.target.value }) }));
    const d = dialog('Artifacts',
      JC.h('p', { class: 'muted' }, 'Every claude.ai artifact this project used as input or published as a result. Briefs list them, so a later task can build on or update one instead of starting over.'),
      list.length ? JC.h('ul', { class: 'srclist' }, list.map(row)) : JC.h('p', { class: 'muted empty' }, 'None yet. Paste a claude.ai artifact link in a task or prompt, or run an artifact task.'));
    d.dataset.kind = 'artifacts';
    const newest = Math.max(0, ...list.map(e => e.changedAt || 0));
    if (newest > JC.artSeen) { JC.artSeen = newest; JC.remember(); }
  }

  function designDialog() {
    const has = !!(JC.S.project || {}).designMd;
    const d = dialog('Design', JC.h('p', { class: 'muted' }, has
      ? 'DESIGN.md is set (.justcode/design/DESIGN.md). UI and artifact tasks follow it.'
      : 'UI and artifact tasks follow .justcode/design/DESIGN.md. By default Claude writes it from the styles, theme and components your code already uses. For a project with no UI yet, pick one from the catalog or use your own file.'),
      JC.h('div', { class: 'acts' },
        JC.btn(has ? 'Rewrite from project' : 'From this project', () => { d.close(); JC.post('designFromProject'); }, has ? 'ghost' : 'primary', 'Claude reads the code\'s colors, type, spacing and components into DESIGN.md'),
        JC.btn('Catalog or my own file…', () => { d.close(); JC.post('designPick'); }, 'ghost', 'Pick a design from VoltAgent/awesome-design-md, or use a file you have'),
        has ? JC.btn('Show as artifact', () => { d.close(); JC.post('designArtifact'); }, 'ghost', 'A claude.ai page showing the palette, type and components; listed under ⧉ Artifacts and updated in place') : '',
        has ? JC.btn('Open', () => { d.close(); JC.post('openJustcodeFile', { file: 'design/DESIGN.md' }); }, 'ghost') : '',
        has ? JC.btn('Remove', () => { d.close(); JC.post('designRemove'); }, 'ghost') : ''));
  }

  function guide() {
    const sec = (n, title, ...p) => JC.h('section', { class: 'gsec' }, JC.h('h4', {}, JC.h('span', { class: 'gn' }, n), title), ...p.map(x => typeof x === 'string' ? JC.h('p', {}, x) : x));
    dialog('JustCode in 2 minutes',
      sec(1, 'Set up once', 'The checklist at the top checks Claude Code, your sign-in and git, and fixes what is missing. Any folder works: an existing project, or an empty one (JustCode asks before creating a git repository).'),
      sec(2, 'Add a task', 'Type what you want. Enter adds it, ⌘/Ctrl+Enter adds and runs it. "Details" adds the goal, a "Done when" checklist the reviewer checks against, screenshots (paste them), files and the sprint. Agent and permissions are under Advanced.'),
      sec('✦', 'Plan with Claude', '✦ Plan turns a goal into small tasks, or reworks the To do list. Claude reads the code, may ask you a few questions, and proposes tasks with a goal, likely files and "Done when", grouped into sprints. In a new project it offers to set it up first: it interviews you, then writes .justcode/project.md after you approve.'),
      sec(3, 'Claude works on its own branch', 'Every task gets its own copy of the project and its own branch, so your files and other tasks are never touched. Click a card to watch its activity, message Claude, or see its agents.'),
      sec(4, 'Approvals without babysitting', JC.h('p', {}, JC.h('b', {}, 'Auto'), ' (the default) lets Claude approve what is safe and ask only when unsure. A question or approval turns the card yellow under ', JC.h('b', {}, 'Needs you'), ' with buttons: Allow, Always allow (remembered for the whole project), or Deny with a reason.'),
        'Other modes: Edit automatically (edits approved, commands ask), Manual (everything asks), Plan, Bypass permissions (no approvals; only for trusted work).'),
      sec(5, 'Review and merge', 'When Claude finishes, its work is committed and an AI reviewer runs the tests and checks the diff. Issues go back to Claude automatically. When the review passes, press ✓ Merge (or turn on automatic merging in ⚙). Conflicts stay on the task\'s branch until you or Claude resolve them.'),
      sec('▮', 'Sprints and progress', 'A sprint groups tasks under a goal. Pick it in the view menu: a bar under the toolbar shows how many are done, in review, working, need you or are still to do. ✦ Edit sprint reworks all its not-started tasks with one prompt. The planning panel has its own bar: reading the code, writing the proposal, waiting for you, ready.'),
      sec(6, 'Run a whole list', '▶ Run all runs every To do task in board order (drag cards to reorder), one at a time by default so each builds on the last merged one. Turn on automatic merging and a sprint runs unattended.'),
      sec(7, 'Continue on your phone', '📱 Continue on phone (in a task) moves its session to Claude Code Remote Control: open the Claude app or claude.ai/code to watch, answer and steer it. Close its terminal to bring the task back to the board. Needs a Claude account login.'),
      sec(8, 'More (⋯)', 'The ⋯ button next to Run all opens the agent map (every Claude session and reviewer at work), the report (tokens and rounds per task), the project history and archived tasks. Notifications appear only when something needs you or is ready to merge; everything else is in the JustCode output log.'),
      sec(9, 'Sources and artifacts', 'Add specs, designs, docs and links under 📎 Sources, or attach files to one task. Each task gets a brief (task + sources), Claude writes a handoff (what changed, how it verified it), and the reviewer reads both instead of re-exploring. Merged tasks add a line to the project history. Open them under Details.'),
      sec(10, 'Spending fewer tokens', 'Tasks load only the project\'s Claude setup, share a cached system prompt, and keep command output short. Reviews fit the change (docs: none, small: lighter model) and continue their own session for follow-ups. Long fix rounds restart from the artifacts. Each card shows its tokens; Details splits build and review.'),
      sec(11, 'Good to know', JC.h('ul', {},
        JC.h('li', {}, 'Closing the board never stops work. Closing VS Code pauses it; tasks that were mid-step continue when VS Code opens again.'),
        JC.h('li', {}, 'Usage meter (top right) shows your 5-hour and weekly Claude limits. At the limit, tasks pause and continue after the reset.'),
        JC.h('li', {}, '.env files are copied into each task\'s copy for tests, never committed. Keys, credentials and node_modules are kept out of git.'),
        JC.h('li', {}, 'Everything is in .justcode/ in your project (board, task copies). Details: README.'))),
      JC.h('div', { class: 'acts' }, JC.btn('Got it', () => { JC.post('guideSeen'); JC.S.guideSeen = true; JC.$('#dlg').close(); JC.render(); }, 'primary')));
  }


  Object.assign(window.JC, { history, historyFor, historyQuery, sessionView, historyDialog, drawHistory, agentDetail, openAgent, agentTree, agentMap, toast, bridged, dialog, newSprint, openPlanner, planDialog, moreMenu, settings, report, sourcesDialog, phoneSection, policySection, artifactsDialog, designDialog, guide });
})();
