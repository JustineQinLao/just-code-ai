// What a card says and which buttons it offers, shared by the board (window.JCStatus) and the tests (require).
// Rule: when JustCode stops an automatic loop, the card says what happened and offers every way out, each labeled
// with what it does; never only a button that repeats the loop that just gave up.
(function (root) {
  const roundLimit = (r, max) => max + (r?.extraRounds || 0);
  const open = r => (r?.issues || []).filter(i => !i.accepted);
  const accepted = r => (r?.issues || []).filter(i => i.accepted);
  const isDirect = t => t.where === 'direct' && !t.init;
  // How long since `since` (a timestamp): 45s, 3m 12s, 2h 5m.
  const elapsed = (since, now = Date.now()) => {
    if (!since) return '';
    const s = Math.max(0, Math.round((now - since) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  };
  const busy = t => t.run === 'running' || t.run === 'starting';

  // Which column a card sits in.
  function lane(t, settings) {
    if (t.status === 'done') return 'done';
    if (t.status === 'todo' && !t.run) return 'todo';
    if (t.asks?.length || t.error || t.conflicts?.length) return 'needs';
    if (t.status === 'review' && t.review?.state === 'fail' && t.review.attempts >= roundLimit(t.review, settings.review.maxAttempts)) return 'needs';
    if (t.status === 'review' && t.checks?.state === 'fail' && !t.phase) return 'needs';
    if (t.status === 'review' && t.review?.state === 'error' && !t.reviewing) return 'needs';
    if (t.status === 'review' && t.review?.state === 'pass' && t.review.hold) return 'needs';
    if (t.phase) return 'work';
    if (t.quick && t.status === 'review' && !busy(t)) return 'review';   // ⚡ Quick: done, nothing to review
    // Claude finished but changed nothing to review (a branch with no new commits, a workspace task with no files).
    if (t.status === 'review' && !t.review && !t.reviewing && t.reply && !busy(t) && (t.where !== 'direct' || !(t.directFiles || []).length)) return 'needs';
    if (t.run && t.run !== 'idle' || t.remote || t.limited || t.status === 'doing') return 'work';
    return 'review';
  }

  // { text, tone, actions: [[label, fn, style?], ...] }: the first action is the primary one.
  // c: { settings, queue, policy?, tasks, post, open(id, tab), lastTool(t) }
  function nextStep(t, c) {
    const s = c.settings, max = roundLimit(t.review, s.review.maxAttempts), r = t.review, post = c.post, id = t.id;
    const fin = isDirect(t) ? 'Finish' : 'Merge';
    const discard = ['Discard', () => post('discard', { id }), 'danger'];
    const resume = ['↻ Resume', () => post('say', { id, text: 'Continue the task.' })];
    const acc = accepted(r).length;
    if (t.status === 'done') return r?.unreviewed ? { text: 'Merged without a finished review (the reviewer could not run)', tone: 'warn', actions: [] }
      : acc ? { text: `${t.where === 'direct' ? 'Finished' : 'Merged'} with ${acc} accepted review issue(s)`, tone: 'warn', actions: [] }
      : { text: t.where === 'direct' ? 'Finished' : 'Merged', tone: 'ok', actions: [] };
    if (t.asks?.length) return { text: t.asks[0].kind === 'question' ? 'Claude has a question for you' : t.asks[0].kind === 'plan' ? 'Plan ready for your OK' : 'Claude needs your approval', tone: 'warn', actions: [] };
    if (t.phase) return { text: t.phase, tone: 'run', actions: [] };
    if (t.run === 'starting') return { text: 'Starting Claude…', tone: 'run', actions: [] };
    if (t.run === 'running') return { text: `Working${c.lastTool(t)}`, tone: 'run', actions: [['Open', () => c.open(id)]] };
    if (t.remote) return { text: 'In Remote Control: continue in the Claude app or claude.ai/code. Close its terminal to bring it back.', tone: 'run', actions: [] };
    if (t.limited) return { text: 'Paused by the usage limit. Continues by itself after the reset.', tone: 'muted', actions: [] };
    if (t.error) return { text: `Stopped: ${t.error}${hint(t.error)}`, tone: 'err', actions: [resume, ['Open task', () => c.open(id, 'activity')], discard] };
    const waits = (t.dependsOn || []).map(d => (c.tasks || []).find(o => o.id === d)).filter(o => o && !o.archived && o.status !== 'done');
    if (t.status === 'todo' && waits.length) return { text: `⟂ waits for “${waits[0].title.slice(0, 50)}”${waits.length > 1 ? ` and ${waits.length - 1} more` : ''}${t.queued ? ' (queued)' : ''}`, tone: 'muted',
      actions: [['▶ Run anyway', () => post(t.queued ? 'runNow' : 'run', { id })]] };
    if (t.status === 'todo') return t.queued ? { text: `Queued #${c.queue.queued.indexOf(id) + 1}${c.queue.blocker ? ` · waits for “${c.queue.blocker.title.slice(0, 40)}”, which ${c.queue.blocker.why}` : ''}`, tone: 'muted', actions: [['▶ Run now', () => post('runNow', { id })]] }
      : { text: 'Ready', tone: 'muted', actions: [['▶ Run', () => post('run', { id })]] };
    if (t.conflicts?.length) return { text: `Conflicts with ${t.base} in ${t.conflicts.length} file(s): ${t.conflicts.slice(0, 3).join(', ')}${t.conflicts.length > 3 ? '…' : ''}`, tone: 'err',
      actions: [['Resolve with Claude', () => post('resolve', { id })], ['Open task folder', () => post('openFolder', { id })], discard] };
    if (t.status === 'review' && t.checks?.state === 'fail') {
      const bad = t.checks.results.filter(x => !x.ok && !x.preexisting);
      const first = (bad[0]?.tail || '').split('\n').map(x => x.trim()).find(Boolean);
      return { text: `${bad.map(x => x.cmd || x.name).join(', ')} still fail${bad.length === 1 ? 's' : ''} after ${Math.max(0, t.checks.rounds - 1)} fix round(s)${first ? `: ${first.slice(0, 120)}` : ''}`, tone: 'err',
        actions: [['See log', () => c.open(id, 'details')], ['Try 1 more round', () => post('sendChecks', { id })], ...(c.policy?.requireChecksPass ? [] : [[`${fin} anyway`, () => post('merge', { id }), 'ghost']]), discard] };
    }
    if (t.reviewing) return { text: `AI reviewer is testing it · ${elapsed(t.reviewing)}`, tone: 'run', actions: [] };
    if (t.status === 'doing') return r?.state === 'fail' ? { text: `Claude is fixing ${open(r).length} review issue(s) (round ${r.attempts} of ${max})`, tone: 'run', actions: [] } : { text: 'Paused', tone: 'muted', actions: [resume] };
    if (t.quick && t.status === 'review') {
      const n = (t.directFiles || []).length;
      return n ? { text: `⚡ Done: changed ${n} file(s)${t.reply ? `. "${t.reply.slice(0, 120)}"` : ''}`, tone: 'ok',
          actions: [['✓ Finish (commit)', () => post('merge', { id })], ['See changes', () => c.open(id, 'changes')], ['Reply', () => c.open(id, 'activity')], discard] }
        : { text: `⚡ ${t.reply ? t.reply.slice(0, 200) : 'Done, no files changed'}`, tone: 'ok', actions: [['Reply', () => c.open(id, 'activity')], ['✓ Close', () => post('merge', { id })]] };
    }
    if (t.output === 'artifact') {
      if (t.publishing) return { text: 'Publishing the page to claude.ai…', tone: 'run', actions: [] };
      if (t.artifactUrl) return { text: 'Artifact published. Message Claude to change it; the same link updates.', tone: 'ok', actions: [['⧉ Open artifact', () => post('openUrl', { url: t.artifactUrl })], ['Finish', () => post('move', { id, status: 'done' })]] };
      if (t.status !== 'todo') return { text: 'Finished without a published page.', tone: 'warn', actions: [['Publish', () => post('publishArtifact', { id })], ['Reply', () => c.open(id, 'activity')]] };
    }
    if (r?.state === 'pass' && r.hold) return { text: `Needs your approval (policy): ${r.hold}. Look at the changes, then ${fin.toLowerCase()}.`, tone: 'warn',
      actions: [[`✓ ${fin}`, () => post('merge', { id })], ['See changes', () => c.open(id, 'changes')], discard] };
    if (r?.state === 'pass') {
      const text = r.risk === 'critical' ? 'Review passed, flagged critical: look before merging' : acc ? `Review passed (${acc} accepted). Ready to ${fin.toLowerCase()}.` : `Review passed. Ready to ${fin.toLowerCase()}.`;
      return { text, tone: r.risk === 'critical' ? 'warn' : 'ok', actions: [[`✓ ${fin}`, () => post('merge', { id })]] };
    }
    if (r?.state === 'fail' && r.attempts >= max) {
      const left = open(r), same = left.filter(i => i.rounds >= 2).length;
      return { text: `Review: ${left.length} issue(s) left after ${r.attempts} fix round(s).${same ? ` ${same} came back every round (Claude may disagree: see its note).` : ''} Read them, then pick one:`, tone: 'err',
        actions: [['See issues', () => c.open(id, 'review')], ['Try 1 more round', () => post('moreRound', { id })], [`Accept issues and ${fin.toLowerCase()}`, () => post('acceptIssues', { id, merge: true }), 'ghost'], discard] };
    }
    if (r?.state === 'error') return { text: `Review could not run: ${r.error ?? ''}${hint(r.error)}`, tone: 'err',
      actions: [['↻ Retry review', () => post('review', { id })], ...(t.worktree || isDirect(t) ? [[`${fin} without review`, () => post('merge', { id }), 'ghost']] : []), discard] };
    if (!r && t.reply && !busy(t) && (!isDirect(t) || !(t.directFiles || []).length)) return { text: `Claude finished without changing project files: "${t.reply.slice(0, 140)}"`, tone: 'warn',
      actions: [['Reply', () => c.open(id, 'activity')], ['Finish (no changes)', () => post('merge', { id }), 'ghost'], discard] };
    if (!s.review.auto) return { text: `Finished. Look at the changes, then ${fin.toLowerCase()}.`, tone: 'ok', actions: [[`✓ ${fin}`, () => post('merge', { id })]] };
    return { text: 'Waiting for the AI reviewer', tone: 'muted', actions: [] };
  }

  // A short cause for the common failures, so the card says what to do about it.
  function hint(err) {
    const e = String(err || '');
    if (/auth|login|401|403|credential/i.test(e)) return ' (sign in again: ⚙ → Setup checklist)';
    if (/rate|429|overloaded|limit/i.test(e)) return ' (Claude is busy or the limit was reached: retry in a few minutes)';
    if (/timed? ?out|timeout/i.test(e)) return ' (it took too long: retry, or raise the review timeout)';
    return '';
  }

  // Board columns, left to right: id and name.
  const LANES = [['todo', 'To do'], ['needs', 'Needs you'], ['work', 'Working'], ['review', 'Review'], ['done', 'Done']];
  // Panel step tracker: Plan, Build, Checks, Review, Merge. Returns the current step 0-4, or 5 when all are done.
  const STEPS = ['Plan', 'Build', 'Checks', 'Review', 'Merge'];
  function stepOf(t) {
    if (t.status === 'done') return 5;
    if (t.status === 'todo' && !t.run) return 0;
    if (t.asks?.some(a => a.kind === 'plan')) return 0;
    if (t.status !== 'review' && !t.reviewing) return 1;
    if (t.reviewing) return 3;
    if (t.review) return t.review.state === 'pass' ? 4 : 3;
    return t.checks?.state === 'fail' || /check/i.test(t.phase || '') ? 2 : t.checks?.state === 'pass' ? 3 : 2;
  }
  const api = { LANES, STEPS, stepOf, lane, nextStep, roundLimit, elapsed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JCStatus = api;
})(typeof window !== 'undefined' ? window : this);
