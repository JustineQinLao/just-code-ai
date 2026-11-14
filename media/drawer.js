// JustCode board: approvals and questions on a card, the task panel, and the planning chat.
// Shares the board's state and helpers through window.JC (set by board.js, which loads first).
(() => {
  /* ---------- approvals and questions ---------- */
  function askBox(t, a) {
    if (a.kind === 'question') return questionBox(t, a);
    if (a.kind === 'plan') return planBox(t, a);
    let reason;
    const box = JC.h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      JC.h('div', { class: 'askhead' }, JC.h('b', {}, a.tool === 'Bash' ? 'Claude asks to run' : `Claude asks to use ${a.tool}`), a.reason ? JC.h('span', { class: 'muted small' }, ` · ${a.reason}`) : ''),
      a.detail ? JC.h('pre', { class: 'askdetail' }, a.detail) : '',
      JC.h('div', { class: 'acts' },
        JC.btn('Allow', () => JC.post('answer', { id: t.id, ask: a.id, choice: 'allow' }), 'primary'),
        a.always ? JC.btn('Always allow (this project)', () => JC.post('answer', { id: t.id, ask: a.id, choice: 'always' }), '', 'Remembered for every task in this project (⚙ Settings lists them)') : '',
        JC.btn('Deny with a reason…', () => { reason.hidden = !reason.hidden; reason.querySelector('input').focus(); }, 'danger')),
      reason = JC.h('div', { class: 'row', hidden: true },
        JC.h('input', { class: 'grow', placeholder: 'Tell Claude why, or what to do instead (optional)', onkeydown: e => { if (e.key === 'Enter') send(); } }),
        JC.btn('Deny', () => send(), 'danger')));
    function send() { JC.post('answer', { id: t.id, ask: a.id, choice: 'deny', message: reason.querySelector('input').value }); }
    return box;
  }

  // Plan mode: Claude's plan, to build as is or send back with changes.
  function planBox(t, a) {
    let note;
    const forbid = JC.S.policy?.policy.forbidModes || [];
    const build = JC.S.settings.defaultMode === 'plan' || forbid.includes(JC.S.settings.defaultMode) ? 'auto' : JC.S.settings.defaultMode;
    return JC.h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      JC.h('div', { class: 'askhead' }, JC.h('b', {}, 'Claude\'s plan'), JC.h('span', { class: 'muted small' }, ' · saved as the task\'s plan.md')),
      JC.h('pre', { class: 'askdetail plan' }, a.plan || '(empty plan)'),
      JC.h('div', { class: 'acts' },
        JC.btn(`Build it (${JC.modeName(build)})`, () => { JC.post('answer', { id: t.id, ask: a.id, choice: 'allow' }); JC.post('setMode', { id: t.id, mode: build }); }, 'primary'),
        JC.btn('Revise…', () => { note.hidden = !note.hidden; note.querySelector('input').focus(); })),
      note = JC.h('div', { class: 'row', hidden: true },
        JC.h('input', { class: 'grow', placeholder: 'What should change in the plan?', onkeydown: e => { if (e.key === 'Enter') send(); } }), JC.btn('Send', () => send())));
    function send() { JC.post('answer', { id: t.id, ask: a.id, choice: 'deny', message: `Revise the plan: ${note.querySelector('input').value || 'keep planning'}` }); }
  }

  function questionBox(t, a) {
    const reply = x => t.id === '__planner' ? JC.post('plannerAnswer', x) : JC.post('answer', { id: t.id, ...x });
    const picked = a.questions.map(() => new Set());
    const other = a.questions.map(() => '');
    const box = JC.h('div', { class: 'ask', onclick: e => e.stopPropagation() },
      a.questions.map((q, i) => JC.h('div', { class: 'q' },
        JC.h('div', {}, q.header ? JC.h('span', { class: 'tag' }, q.header) : '', ' ', JC.h('b', {}, q.question)),
        JC.h('div', { class: 'opts' }, q.options.map(o => JC.h('label', { class: `opt${/\(recommended\)/i.test(o.label) ? ' rec' : ''}` },
          JC.h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${a.id}-${i}`, onchange: e => {
            if (!q.multiSelect) picked[i].clear();
            e.target.checked ? picked[i].add(o.label) : picked[i].delete(o.label);
          } }),
          JC.h('span', { class: 'otext' }, JC.h('span', { class: 'olabel' }, o.label), o.description ? JC.h('span', { class: 'odesc' }, o.description) : '',
            o.preview ? JC.h('pre', { class: 'opreview' }, o.preview) : '')))),
        JC.h('input', { class: 'other', placeholder: 'Or type your own answer', oninput: e => { other[i] = e.target.value; } }))),
      JC.h('div', { class: 'acts' },
        JC.btn('Answer', () => {
          const answers = {};
          a.questions.forEach((q, i) => { answers[q.question] = other[i].trim() || [...picked[i]].join(', '); });
          if (Object.values(answers).some(v => !v)) return;
          reply({ ask: a.id, choice: 'allow', answers });
        }, 'primary'),
        JC.btn('Skip', () => reply({ ask: a.id, choice: 'deny', message: 'The user skipped the question. Use your best judgement.' }), 'ghost')));
    return box;
  }

  /* ---------- task drawer ---------- */
  function openTask(id, t2) {
    open = id; if (t2) JC.tab = t2;
    JC.agentView = undefined; delete JC.agentsSaved[id];
    JC.remember();
    JC.post('watch', { id });
    if (JC.tab === 'changes') JC.post('changes', { id });
    JC.render();
  }
  function closeTask() { open = undefined; JC.remember(); JC.post('watch', { id: undefined }); JC.render(); }

  const drawer = JC.$('#drawer');
  const msgImages = [], msgThumbs = JC.h('div', { class: 'imgs' }), msgPaste = JC.imagePaste(msgImages, msgThumbs);
  const msg = JC.complete(JC.h('textarea', { id: 'msg', rows: 2, placeholder: 'Message Claude…  / skills · @ files · Enter sends · Shift+Enter new line · paste screenshots', onpaste: msgPaste.onpaste, onkeydown: e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
  } }));
  function sendMsg() {
    const text = msg.value.trim() || (msgImages.length ? 'See the screenshot(s).' : '');
    if (!text || !open) return;
    const images = msgImages.splice(0);
    JC.post(open === '__planner' ? 'plannerSay' : 'say', open === '__planner' ? { text, images } : { id: open, text, images });
    msg.value = ''; msgPaste.draw();
  }
  const body = JC.h('div', { class: 'dbody' });
  const head = JC.h('div', { class: 'dhead' });
  drawer.append(head, body, JC.h('div', { class: 'dfoot' }, JC.h('div', { class: 'col grow' }, msgThumbs, msg), JC.h('div', { class: 'col' }, JC.btn('Send', sendMsg, 'primary'), JC.btn('Stop step', () => JC.post(open === '__planner' ? 'stopPlanner' : 'interrupt', open === '__planner' ? {} : { id: open }), 'ghost', 'Interrupt what Claude is doing now (Esc)'))));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open && document.activeElement === msg && open !== '__planner') JC.post('interrupt', { id: open }); else if (e.key === 'Escape' && open && !JC.$('#dlg').open) closeTask(); });

  let menu = [];
  function renderDrawer() {
    if (open === '__planner') return renderPlanner();
    const t = open && JC.S.board.tasks.find(x => x.id === open);
    drawer.classList.toggle('on', !!t);
    document.body.classList.toggle('drawer-open', !!t);
    if (!t) return;
    const nx = JC.next(t);
    const live = t.run && t.run !== 'idle';
    menu = [
      t.status === 'todo' && ['▶ Run', () => JC.post('run', { id: t.id })],
      live && ['■ Stop', () => JC.post('stop', { id: t.id })],
      t.sessionId && !t.remote && ['📱 Continue on phone', () => JC.post('remote', { id: t.id })],
      t.sessionId && !t.remote && ['⌨ Open in terminal', () => JC.post('claudeCode', { id: t.id })],
      t.worktree && ['Changes', () => { JC.tab = 'changes'; JC.post('changes', { id: t.id }); JC.render(); }],
      t.worktree && t.status !== 'done' && ['✓ Merge', () => JC.post('merge', { id: t.id })],
      t.worktree && !t.reviewing && t.status === 'review' && ['Review again', () => JC.post('review', { id: t.id })],
      t.reviewing && ['Cancel review', () => JC.post('cancelReview', { id: t.id })],
      t.conflicts?.length && ['Mark resolved', () => JC.post('resolved', { id: t.id })],
      t.worktree && ['Open its folder', () => JC.post('openFolder', { id: t.id })],
      t.worktree && !t.pr && ['Push PR', () => JC.post('remotePr', { id: t.id })],
      t.pr && ['Open PR', () => JC.post('openUrl', { url: t.pr })],
      (t.worktree || (t.where === 'direct' && !t.init && t.status !== 'done' && t.directFiles?.length)) && ['Discard work', () => JC.post('discard', { id: t.id }), 'danger'],
      [t.archived ? 'Unarchive' : 'Archive', () => JC.post('archive', { id: t.id })],
      ['Delete', () => JC.post('delete', { id: t.id }), 'danger'],
    ].filter(Boolean);
    const st = window.JCStatus.stepOf(t);
    const tags = [t.branch && `⎇ ${t.branch}`, t.mode && t.mode !== 'auto' && JC.modeName(t.mode)].filter(Boolean);
    head.replaceChildren(
      JC.h('div', { class: 'row' }, JC.h('span', { class: 'tags grow' }, tags.map(x => JC.h('span', { class: 'tag' }, x))), JC.btn('✕', closeTask, 'ghost icon', 'Close (Esc)')),
      JC.h('h3', {}, t.title),
      JC.h('div', { class: 'stepper' }, window.JCStatus.STEPS.map((s, i) => JC.h('span', { class: i < st ? 'ok' : i === st ? 'now' : '' }, i < st ? `✓ ${s}` : s))),
      JC.h('div', { class: `next dnext ${nx.tone}` }, JC.h('span', {}, nx.text), nx.actions.length ? JC.h('div', { class: 'acts' }, nx.actions.slice(0, 3).map(([l, fn], i) => JC.btn(l, fn, i === 0 ? 'primary' : 'ghost'))) : ''),
      JC.h('nav', { class: 'tabs' }, [['activity', 'Activity'], ['changes', 'Changes'], ['review', 'Review'], ['details', 'Details']]
        .map(([k, l]) => JC.h('a', { class: (JC.tab === k || (k === 'details' && JC.tab === 'agents')) ? 'on' : '', onclick: () => { JC.tab = k; if (k === 'changes') JC.post('changes', { id: t.id }); if (k === 'review' && t.review?.screenshots?.length) JC.post('shots', { id: t.id }); JC.render(); } }, l))));
    body.replaceChildren(...drawerBody(t));
    msg.placeholder = t.status === 'todo' ? 'Run the task first, or edit it under Details' : t.remote ? 'This task is in Remote Control' : 'Message Claude…  Enter sends · Shift+Enter new line';
  }

  function drawerBody(t) {
    if (JC.tab === 'agents') {
      if (JC.agentView?.task === t.id) return JC.agentDetail(t);
      const live = (t.agents || []).filter(n => n.id !== 'main');
      if (!JC.agentsSaved[t.id]) JC.post('savedAgents', { id: t.id });
      const extra = (JC.agentsSaved[t.id] || []).filter(a => !live.some(n => n.toolUseId && n.toolUseId === a.toolUseId))
        .map(a => ({ id: `saved-${a.id}`, parent: 'main', name: a.name, description: a.description, status: a.finished ? 'completed' : 'stopped', key: a.id, sessionId: a.sessionId }));
      return [JC.btn('← Details', () => { JC.tab = 'details'; JC.render(); }, 'ghost small'), JC.agentTree([{ name: t.title, tasks: [{ ...t, agents: [...(t.agents || []), ...extra] }] }], true),
        JC.h('p', { class: 'muted small' }, 'Click an agent for its whole conversation.')];
    }
    if (JC.tab === 'changes') {
      const files = JC.changes[t.id];
      const merged = t.status === 'done' && !t.worktree && t.branch && t.where !== 'direct';
      if (!t.worktree && !merged) return [JC.h('p', { class: 'muted' }, t.where === 'direct' ? 'This task runs in the project folder: its changes are in your working tree.' : 'No changes yet.')];
      if (!files) return [JC.h('p', { class: 'muted' }, 'Loading…')];
      if (!files.length) return [JC.h('p', { class: 'muted' }, merged ? 'Could not find this task\'s merge in git history.' : 'No changes on this branch yet.')];
      return [merged ? JC.h('p', { class: 'muted small' }, 'What the merge changed. Click a file for its diff; Open shows it from the project folder.') : '',
        JC.h('ul', { class: 'files' }, files.map(f => JC.h('li', { onclick: () => JC.post('diff', { id: t.id, file: f.file }), title: 'Open side-by-side diff (PDFs and other documents open in their app)' },
          JC.h('span', { class: `st st-${f.status}` }, f.status), JC.h('span', { class: 'grow' }, f.file),
          f.status !== 'D' ? JC.btn('Open', e => { e.stopPropagation(); JC.post('openFile', { id: t.id, file: f.file }); }, 'ghost small', 'Open the file') : '')))];
    }
    if (JC.tab === 'review') {
      const r = t.review;
      if (!r) return [JC.h('p', { class: 'muted' }, t.reviewing ? 'The AI reviewer is testing this change…' : JC.S.settings.review.auto ? 'Reviewed automatically when Claude finishes.' : 'AI review is off (⚙ Settings).'), t.worktree && !t.reviewing ? JC.btn('Review now', () => JC.post('review', { id: t.id })) : ''];
      return [
        JC.h('p', {}, JC.h('b', {}, { pass: '✓ Passed', fail: '✗ Issues found', error: 'Review could not run', running: 'Reviewing…' }[r.state]), r.risk === 'critical' ? JC.h('span', { class: 'warn' }, ' · flagged critical') : '', JC.h('span', { class: 'muted' }, ` · round ${r.attempts || 1}`)),
        r.level ? JC.h('p', { class: 'muted small' }, r.level === 'none' ? `No AI review needed: ${r.why}.` : `${r.level === 'light' ? 'Light review (lighter model)' : 'Full review'}${r.why ? `: ${r.why}` : ''}.`) : '',
        r.error ? JC.h('pre', { class: 'err' }, r.error) : '',
        r.fixNote ? JC.h('details', { class: 'fixnote' }, JC.h('summary', {}, 'Claude\'s reply to the last round'), JC.h('p', { class: 'small' }, r.fixNote)) : '',
        r.issues?.length ? JC.h('ol', { class: 'issues' }, r.issues.map(i => JC.h('li', { class: i.accepted ? 'accepted' : '' },
          JC.h('div', {}, i.text),
          JC.h('div', { class: 'row small' },
            JC.h('span', { class: 'muted' }, i.accepted ? 'Accepted by you' : i.rounds > 1 ? `Seen in ${i.rounds} rounds` : 'New this round'),
            !i.accepted && r.state === 'fail' && !JC.REMOTE ? JC.btn('Accept', () => JC.post('acceptIssues', { id: t.id, keys: [i.key] }), 'ghost small', 'Does not block the merge: the reviewer stops reporting it') : '',
            !i.accepted && r.state === 'fail' ? JC.btn('Ask Claude to fix this one', () => JC.post('sendIssues', { id: t.id, key: i.key }), 'ghost small') : '')))) : '',
        r.tested?.length ? JC.h('p', { class: 'muted small' }, 'Tested: ', r.tested.join(' · ')) : '',
        r.state === 'fail' ? JC.h('div', { class: 'row' },
          JC.btn('Send open issues to Claude', () => JC.post('sendIssues', { id: t.id }), 'primary'),
          !JC.REMOTE ? JC.btn(`Accept all and ${t.where === 'direct' && !t.init ? 'finish' : 'merge'}`, () => JC.post('acceptIssues', { id: t.id, merge: true }), 'ghost') : '') : '',
        JC.h('div', { class: 'shots' }, (JC.shots[t.id] || []).map(s => JC.h('img', { src: s.data, title: s.name }))),
      ];
    }
    if (JC.tab === 'details') {
      const editable = t.status === 'todo';
      let title, desc;
      return [
        JC.h('div', { class: 'acts wrap' }, menu.map(([l, f, c]) => JC.btn(l, f, c || 'ghost')), JC.btn(`Agents${t.agents?.length > 1 ? ` (${t.agents.length})` : ''}`, () => { JC.tab = 'agents'; JC.render(); }, 'ghost')),
        JC.h('div', { class: 'row small' },
          JC.h('label', {}, 'Permissions ', JC.h('select', { onchange: e => JC.post('setMode', { id: t.id, mode: e.target.value }), disabled: !!JC.S.settings?.bypassAll, title: JC.S.settings?.bypassAll ? 'Bypass all is on: every task runs with Bypass permissions' : undefined },
            JC.MODES.map(([v, l, d]) => { const no = (JC.S.policy?.policy.forbidModes || []).includes(v); return JC.h('option', { value: v, title: no ? 'Forbidden by this project\'s policy (.justcode/policy.json, forbidModes)' : d, disabled: no, selected: (JC.S.settings?.bypassAll ? 'bypassPermissions' : t.mode) === v }, no ? `${l} (policy)` : l); }))),
          t.modeNote ? JC.h('span', { class: 'warn' }, t.modeNote) : '',
          t.modelUsed ? JC.h('span', { class: 'muted', title: t.modelUsed }, JC.modelName(t.modelUsed)) : '',
          t.output ? JC.h('span', { class: 'muted' }, `${JC.tok(t.context + t.output)}`) : ''),
        JC.h('label', { class: 'blk' }, 'Title', title = JC.h('input', { value: t.title, disabled: !editable })),
        JC.h('label', { class: 'blk' }, 'Details', desc = JC.h('textarea', { rows: 8, disabled: !editable }, t.description || '')),
        editable ? (() => {
          const others = JC.S.board.tasks.filter(o => o.id !== t.id && !o.archived && o.status !== 'done' || (t.dependsOn || []).includes(o.id));
          return others.length ? JC.h('details', { class: 'adv', open: !!t.dependsOn?.length }, JC.h('summary', {}, `After${t.dependsOn?.length ? ` (${t.dependsOn.length})` : ''}: Run all starts this task only when these are done`),
            JC.h('div', { class: 'deps' }, others.map(o => JC.h('label', { class: 'chip' }, JC.h('input', { type: 'checkbox', checked: (t.dependsOn || []).includes(o.id),
              onchange: e => { const cur = new Set(t.dependsOn || []); e.target.checked ? cur.add(o.id) : cur.delete(o.id); JC.post('editTask', { id: t.id, patch: { dependsOn: [...cur] } }); } }), ' ', o.title.slice(0, 60))))) : '';
        })() : '',
        editable ? JC.h('div', { class: 'row' }, JC.btn('Save', () => JC.post('editTask', { id: t.id, patch: { title: title.value, description: desc.value } }), 'primary'),
          JC.h('span', { class: 'muted small' }, 'To rework it with Claude, use ✦ Plan.')) : JC.h('p', { class: 'muted small' }, 'Started tasks keep their text; message Claude instead.'),
        t.images?.length ? JC.h('p', { class: 'muted small' }, `${t.images.length} screenshot(s) attached.`) : '',
        t.checks?.results?.length ? JC.h('div', {}, JC.h('h4', {}, `Checks · ${t.checks.state === 'pass' ? 'pass' : 'fail'}${t.checks.rounds ? ` · fix round ${t.checks.rounds}` : ''}`),
          JC.h('ul', { class: 'checks' }, t.checks.results.map(r => JC.h('li', { class: r.ok ? 'ok' : r.preexisting ? 'pre' : 'bad' },
            JC.h('span', { class: 'dot' }, r.ok ? '✓' : r.preexisting ? '○' : '✗'), JC.h('code', {}, r.cmd), JC.h('span', { class: 'muted small' }, ` ${Math.round(r.ms / 1000)}s${r.preexisting ? ' · fails on the base branch too: ignored' : ''}${r.timedOut ? ' · timed out' : ''}`)))),
          JC.btn('Open log', () => JC.post('openArtifact', { id: t.id, which: 'checks' }), 'ghost')) : '',
        t.output === 'artifact' ? JC.h('div', { class: 'row small' }, JC.h('b', {}, 'Artifact '), t.artifactUrl
          ? [JC.h('a', { onclick: () => JC.post('openUrl', { url: t.artifactUrl }), title: 'Open in your browser' }, t.artifactUrl), JC.btn('Copy link', () => JC.post('copy', { text: t.artifactUrl }), 'ghost')]
          : JC.h('span', { class: 'muted' }, t.publishing ? 'publishing…' : 'not published yet'),
          t.status !== 'todo' ? JC.btn(t.artifactUrl ? 'Publish again' : 'Publish', () => JC.post('publishArtifact', { id: t.id }), 'ghost') : '') : '',
        t.files?.length ? JC.h('p', { class: 'small' }, 'Attached: ', t.files.map(JC.base).join(', ')) : '',
        (arts => arts.length ? JC.h('p', { class: 'small' }, 'Artifacts: ', ...arts.map((e, i) => [i ? ', ' : '', JC.h('a', { onclick: () => JC.post('openUrl', { url: e.url }), title: e.url }, `${e.title || e.url.replace(/^https?:\/\//, '')} (${e.kind === 'output' ? 'published' : 'used'})`)])) : '')((JC.S.registry || []).filter(e => e.taskIds.includes(t.id))),
        t.sources ? JC.h('p', { class: 'small' }, 'Based on: ', (JC.S.sources || []).filter(s => t.sources.includes(s.id)).map(JC.srcLabel).join(', ') || 'no project sources') : '',
        JC.h('details', { class: 'adv' }, JC.h('summary', {}, 'Files Claude wrote, logs and tokens'),
          JC.h('div', { class: 'row' }, [['brief', 'Brief'], ['plan', 'Plan'], ['handoff', 'Handoff'], ['review', 'Review notes'], ['transcript', 'Transcript']].filter(([k]) => t.artifacts?.[k]).map(([k, l]) => JC.btn(l, () => JC.post('openArtifact', { id: t.id, which: k }), 'ghost')),
            t.worktree ? JC.btn('Setup log', () => JC.post('openArtifact', { id: t.id, which: 'setup' }), 'ghost') : ''),
          JC.usageTotal(t) ? JC.h('pre', { class: 'small' }, JC.usageTitle(t) + '\nCached re-reads are context re-sent at every step and cost about a tenth.') : ''),
        JC.btn('🕘 Prompts and sessions', () => JC.historyDialog(t.id), 'ghost', 'Every prompt you sent this task, and each session\'s conversation'),
        JC.h('p', { class: 'muted small' }, `Created ${new Date(t.created).toLocaleString()}${t.sessionId ? ` · session ${t.sessionId.slice(0, 8)}` : ''}${t.costUsd ? ` · ~$${t.costUsd.toFixed(2)} at API prices` : ''}`),
      ];
    }
    const list = JC.steps[t.id] || [];
    const asks = (t.asks || []).map(a => askBox(t, a));
    if (!list.length) return [...asks, JC.h('p', { class: 'muted' }, t.status === 'todo' ? 'Not started yet. Press ▶ Run.' : 'No activity yet.')];
    return [...asks, timeline(t, list)];
  }

  // Activity: what Claude did as a timeline, finished steps green, the last one live while it works.
  function timeline(t, list) {
    const live = t.run && t.run !== 'idle';
    const el = JC.h('div', { class: 'tl' }, list.map((s, i) => {
      const last = live && i === list.length - 1;
      const txt = s.kind === 'tool' ? `${s.agent ? `↳ ${s.agent}: ` : ''}${s.text}` : s.text;
      return JC.h('p', { class: `${last ? 'live' : s.kind === 'error' ? 'err' : 'ok'} ${s.kind}` }, s.kind === 'user' ? JC.h('b', {}, `You: ${txt}`) : last ? JC.h('b', {}, txt) : txt);
    }));
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    return el;
  }

  function logEl(list) {
    const el = JC.h('div', { class: 'log' }, list.map(s => JC.h('div', { class: `step ${s.kind}${s.kind === 'info' && s.text.startsWith('Model: ') ? ' model' : ''}` },
      JC.h('span', { class: 'k' }, { user: 'you', say: 'claude', tool: s.agent ? `↳ ${s.agent}` : 'tool', result: '', error: 'error', info: 'note' }[s.kind]),
      s.kind === 'say' || s.kind === 'user' ? JC.h('div', { class: 'txt' }, s.text) : JC.h('code', {}, s.text))));
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
    return JC.h('div', { class: 'planprog' },
      JC.h('div', { class: `bar${running && !p.asks?.length ? ' busy' : ''}`, role: 'progressbar', 'aria-label': 'Planning progress', 'aria-valuetext': stage },
        JC.h('i', { class: 'seg run', style: `width:${running ? Math.max(15, (at + 1) * 33) : p.proposals ? 100 : 0}%` })),
      JC.h('div', { class: 'small muted' }, stage, running ? ` · ${JC.ago(since || Date.now())}` : '', tools.length ? ` · ${reads} file reads, ${tools.length} tool uses` : '',
        running && tools.length ? ` · now: ${tools[tools.length - 1].text.slice(0, 60)}` : ''));
  }

  const pKeep = {}; // which proposals the user has unticked
  function renderPlanner() {
    const p = JC.S.planner;
    drawer.classList.add('on');
    document.body.classList.add('drawer-open');
    if (!p) {
      head.replaceChildren(JC.h('div', { class: 'row' }, JC.h('h3', { class: 'grow' }, 'Planning'), JC.btn('×', closeTask, 'ghost icon', 'Close')));
      body.replaceChildren(JC.h('p', { class: 'muted' }, JC.S.plannerPhase || 'Starting the planning chat…'),
        JC.S.plannerPhase ? JC.btn('Show terminal', () => JC.post('showSaveTerminal', {}), 'ghost', 'Open the terminal saving it, e.g. if it asks for approval') : '');
      return;
    }
    const running = p.run && p.run !== 'idle';
    head.replaceChildren(
      JC.h('div', { class: 'row' }, JC.h('h3', { class: 'grow' }, p.sprint ? `Editing ${p.sprint}` : p.targets?.length ? `Editing ${p.targets.length} To do task${p.targets.length === 1 ? '' : 's'}` : 'Planning tasks'),
        JC.btn('×', closeTask, 'ghost icon', 'Close (the chat keeps running)')),
      JC.h('div', { class: `next ${p.asks?.length ? 'warn' : running ? 'run' : 'muted'}` }, p.asks?.length ? 'Claude has a question for you (below).' : running ? 'Claude is reading the code…' : 'Your turn: message Claude to refine, or apply the tasks below.',
        p.model ? JC.h('span', { class: 'muted small', title: p.model }, ` · ${JC.modelName(p.model)}`) : '',
        p.context ? JC.h('span', { class: 'muted small' }, ` · ${JC.tok(p.context)}`) : ''),
      planProgress(p, running));
    const prop = p.proposals;
    const panel = [];
    if (p.note) panel.push(JC.h('div', { class: 'applied' }, '✓ ', p.note));
    for (const a of p.asks || []) panel.push(questionBox({ id: '__planner' }, a));
    if (prop) {
      const cur = id => JC.S.board.tasks.find(t => t.id === id);
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
      panel.push(JC.h('div', { class: 'proppanel' },
        JC.h('div', { class: 'row' }, JC.h('h4', { class: 'grow' }, `Proposed tasks (${prop.length})`), nChange ? JC.h('span', { class: 'muted small' }, `${nChange} change${nChange === 1 ? '' : 's'}`) : ''),
        JC.h('div', { class: 'reflist' }, all.map(c => JC.h('label', { class: `refrow ${c.kind}` },
          c.kind === 'same' ? JC.h('span', { class: 'rspace' }) : JC.h('input', { type: 'checkbox', checked: pKeep[c.key], onchange: e => { pKeep[c.key] = e.target.checked; } }),
          JC.h('div', { class: 'rbody' }, JC.h('div', {}, JC.h('span', { class: `rtag ${c.kind}` }, { add: 'NEW', edit: 'EDIT', same: 'keep', remove: 'REMOVE', reopen: 'BACK TO TO DO', amend: 'CHANGE SENT' }[c.kind]), ' ', JC.h('b', {}, c.title), c.sprint ? JC.h('span', { class: 'tag' }, ` ${c.sprint}`) : ''),
            c.kind === 'reopen' ? JC.h('div', { class: 'small warn' }, 'Done, but must change: goes back to To do and is built again on top of the merged work.') : '',
            c.kind === 'amend' ? JC.h('div', { class: 'small warn' }, 'Already started: the new text is saved and sent to its Claude as a message.') : '',
            c.before && c.before !== c.title ? JC.h('div', { class: 'small muted strike' }, c.before) : '',
            c.description ? JC.h('div', { class: 'small muted' }, c.description) : '')))),
        JC.h('div', { class: 'acts' },
          nChange ? JC.btn('Apply the ticked tasks', () => {
            JC.post('applyProposals', { changes: changes.map(c => ({ ...c, apply: c.kind !== 'same' && pKeep[c.key] })), removes: removes.map(c => ({ id: c.id, apply: pKeep[c.key] })) });
            for (const k in pKeep) delete pKeep[k];
          }, 'primary') : JC.h('span', { class: 'muted small' }, 'No changes to apply yet.'))));
    }
    body.replaceChildren(logEl(p.steps || []), ...panel);
    msg.placeholder = 'Message Claude to refine the tasks…  Enter sends';
  }


  Object.assign(window.JC, { askBox, planBox, questionBox, openTask, closeTask, drawer, msgImages, msgThumbs, msgPaste, msg, sendMsg, body, head, renderDrawer, drawerBody, logEl, planProgress, pKeep, renderPlanner });
})();
