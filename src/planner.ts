import * as fs from 'fs';
import * as CodeMap from './codemap';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { setupSkillBody, fixDesignSteps } from './skill';
import * as DC from './designcapture';
import * as DF from './designfix';
import * as App from './app';
import { Session, Answer, Ask, AgentNode, TurnEnd, RunState } from './session';
import * as R from './registry';
import * as Audit from './audit';
import { SecretsFound, describeSecrets } from './secrets';
import { loadPolicy, violations, toolArg } from './policy';
import { trackIssues, openIssues, acceptedIssues, roundLimit } from './issues';
import { transcript } from './claude';
import { taskText, PlanWhere } from './claude';
import { carryOver, discoverAgents, reviewPrompt, runReview, sessionExists, sessionSize, taskPrompt, adb, userAllowRules, addUsage, Usage, PLANNER_APPEND, plannerFirst, parseProposals, RefineResult, artifactBrief, installedPlugin, webOptions } from './claude';
import * as A from './artifacts';
import { ensurePlugin, pluginDir } from './plugin';
import * as C from './checks';
import { Limits, isLimitError } from './limits';
import type { Runner } from './runner';
import { BASELINE, sha, TEST_CMD, UI_FILE, effectiveMode } from './runner';

// Runner methods: The planning chat: start it, read its proposals, apply them to the board.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const plannerMethods = {
  plannerLive(this: Runner) {
    const s = this.planner;
    if (!s?.open && !this.plannerProposals) return undefined;
    return { run: s?.open ? s.state : 'idle', steps: s?.steps ?? [], proposals: this.plannerProposals, targets: this.plannerTargets, others: this.plannerOthers, context: s?.context ?? 0, model: s?.model, note: this.plannerNote, turnAt: this.plannerTurnAt, sprint: this.plannerSprint,
      branch: this.plannerBranch, where: this.planWhere(),
      asks: s?.open ? [...s.asks.values()].filter(a => a.kind === 'question') : [] };
  },

  // Where the proposed tasks run, as the panel's picker starts: what Claude set from the request, else the Default
  // where setting (direct: the current branch; branch: one branch per task; auto: a sprint when Claude named one).
  planWhere(this: Runner): PlanWhere {
    const p = this.plannerProposals ?? [];
    const said = p.map(c => c.where).find(Boolean);
    if (said) return said;
    if (this.plannerSprint) return 'sprint';
    const w = this.d.settings().defaultWhere;
    return w === 'direct' ? 'current' : w === 'branch' ? 'task' : p.some(c => c.sprint) ? 'sprint' : 'current';
  },

  // A claude.ai link pasted in a sprint's task or plan prompt becomes one of that sprint's sources.
  useLinkedSources(this: Runner, sprintId: string | undefined, text: string) {
    const sp = sprintId ? this.store.data.sprints.find(x => x.id === sprintId) : undefined;
    if (!sp?.sources) return;
    const add = A.linkedSources(A.loadSources(this.root), text).map(s => s.id).filter(id => !sp.sources!.includes(id));
    if (add.length) this.store.updateSprint(sp.id, { sources: [...sp.sources, ...add] });
  },

  async startPlanner(this: Runner, instruction: string, targetIds: string[], sprint?: { name: string; goal?: string }, into?: string) {
    const bin = this.d.bin();
    if (!bin) throw new Error('Claude Code is not installed. Open JustCode: Check Setup.');
    if (this.d.limits.held()) throw new Error('Your Claude usage limit is reached. Try again after the reset.');
    this.planner?.kill();
    this.plannerTargets = targetIds;
    // Reworking a sprint also checks the tasks already started or done in it.
    const sid = sprint ? this.store.data.sprints.find(x => x.name === sprint.name && !x.closed)?.id : undefined;
    const others = sid ? this.store.data.tasks.filter(t => t.sprintId === sid && !t.archived && !t.init && !targetIds.includes(t.id) && (t.status !== 'todo' || !!t.worktree)) : [];
    this.plannerOthers = others.map(t => t.id);
    this.plannerProposals = undefined;
    this.plannerNote = undefined;
    this.plannerBranch = await g.currentBranch(this.root).catch(() => undefined);
    await this.tidySprints().catch(() => undefined);   // finished sprints are not offered for reuse
    this.plannerTurnAt = Date.now();
    this.plannerSprint = sprint?.name;
    this.plannerPhase = 'Saving the claude.ai design locally first. This takes about 30 seconds…';
    this.changed();
    try { await this.d.saveSources?.(instruction); } finally { this.plannerPhase = undefined; }
    this.useLinkedSources(sid, instruction);
    const tasks = targetIds.map(id => this.store.task(id)).filter((t): t is Task => !!t);
    const set = this.d.settings();
    this.plannerSession = randomUUID();
    A.logPrompt(this.root, { kind: 'plan', text: instruction, sessionId: this.plannerSession, title: sprint ? `Edit ${sprint.name}` : 'Plan' });
    // The planner's map: the freshest one with the sprint's work (a task folder on the sprint branch), since the project
    // folder may be on another branch (main without the sprint's code); else the project folder's.
    const mapDir = this.plannerMapDir(sid);
    const map = await CodeMap.forSession(mapDir, this.root, set.codeMap !== false);
    const mapNotes = map.rule ? await this.mapNotes(mapDir, instruction, true) : '';
    const s = new Session({
      // Not Claude Code's plan mode: it tells Claude to write a plan file, which a read-only chat cannot, so each turn
      // spent tokens on a refused Write. Default mode with the write tools removed keeps it read-only.
      bin, cwd: this.root, sessionId: this.plannerSession, resume: false, mode: 'default', model: set.plannerModel || undefined,
      append: [PLANNER_APPEND, map.rule].filter(Boolean).join('\n\n'),   // no terse replies: its drafts become task text readOnly: true, effort: set.plannerEffort || undefined,
      allowed: [...userAllowRules(), ...map.allowed], rules: () => userAllowRules(), env: this.d.env(), idleMs: 30 * 60_000, label: 'Planner', personal: set.personalSetup, plugins: this.plugins(), guard: this.guard(undefined, this.root),
    });
    this.planner = s;
    s.on('change', () => this.changed());
    s.on('rate', info => this.d.limits.update(info));
    s.on('turn', turn => { this.onPlannerTurn(turn); });
    // Questions show in the planning panel. Anything else that asks (a command that is not read-only) is declined.
    s.on('ask', a => { if (a.kind !== 'question') setImmediate(() => s.answer({ id: a.id, choice: 'deny', message: 'Read-only planning chat: use Read, Grep, Glob or read-only commands (ls, cat, grep, git log), and reply with the proposed task list.' })); });
    s.on('exit', () => this.changed());
    const sprints = this.store.data.sprints.filter(x => !x.closed).map(x => ({ name: x.name, goal: x.goal }));
    const planSources = A.sprintSources(A.loadSources(this.root), sid ? this.store.data.sprints.find(x => x.id === sid) : undefined);
    const arts = A.artifactsSection(this.root, planSources, x => this.store.task(x)?.title);
    await s.start((A.projectSection(this.root) ? `${A.projectSection(this.root)}\n\n` : '') + A.sourceLines(this.root, planSources) + (arts ? `${arts}\n\n` : '') + plannerFirst(tasks.map(t => ({ id: t.id, title: t.title, description: t.description })), instruction, sprints, sprint,
      others.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status })), into && this.store.data.sprints.some(x => x.name === into && !x.closed) ? into : undefined, this.plannerBranch) + mapNotes);
    this.plannerMap = map.rule ? mapDir : undefined;
    this.changed();
  },

  onPlannerTurn(this: Runner, turn: TurnEnd) {
    this.store.addPlannerCost(turn.costUsd ?? 0, turn.sessionId ?? this.plannerSession);
    if (turn.limit) { this.d.limits.setReached('usage'); return; }
    if (!turn.ok) { this.d.notify('error', `Planner stopped: ${String(turn.error).slice(0, 200)}`); return; }
    const ids = new Set([...this.plannerTargets, ...this.plannerOthers]);
    const p = parseProposals(turn.text, ids);
    if (p) { this.plannerProposals = p; this.plannerNote = undefined; }
    this.changed();
  },

  plannerAnswer(this: Runner, a: Answer) { this.planner?.answer(a); },

  // JustCode asks the code map itself (the planner rarely does): the project's outline (first message only) and the
  // files and names most related to the request, so the planner writes exact "Files:" lines without searching.
  async mapNotes(this: Runner, dir: string, text: string, outline: boolean) {
    const o = outline ? CodeMap.overview(dir) : undefined, look = await CodeMap.lookFirst(dir, text);
    return [o && `## Project outline (code map)\n${o}`, look && `## Code related to this request (code map)\n${look}\nThe map's best guess from the request's words: check before relying on it.`]
      .filter(Boolean).map(x => `\n\n${x}`).join('');
  },

  plannerMapDir(this: Runner, sprintId?: string) {
    const mtime = (d: string) => { try { return fs.statSync(CodeMap.graphFile(d)).mtimeMs; } catch { return 0; } };
    const dirs = this.store.data.tasks.filter(t => t.worktree && !t.archived && t.status !== 'done' && (!sprintId || t.sprintId === sprintId) && fs.existsSync(t.worktree)).map(t => t.worktree!);
    return dirs.filter(d => mtime(d)).sort((a, b) => mtime(b) - mtime(a))[0] ?? this.root;
  },

  async plannerSay(this: Runner, text: string) {
    if (!this.planner?.open) throw new Error('The planning chat has ended. Start it again.');
    const notes = this.plannerMap ? await this.mapNotes(this.plannerMap, text, false) : '';
    if (!this.planner?.open) throw new Error('The planning chat has ended. Start it again.');
    this.planner.send(text + notes);
    A.logPrompt(this.root, { kind: 'plan', text, sessionId: this.plannerSession, title: 'Plan' });
    this.plannerTurnAt = Date.now();
  },

  // A done task that must change goes back to To do with the new text. Its work is already merged, so the next run
  // starts a fresh branch and session on top of it; the old session stays in its history.
  reopen(this: Runner, t: Task, c: RefineResult) {
    this.store.updateTask(t.id, { status: 'todo', title: c.title, description: c.description || undefined, ...(this.sprintFor(c.sprint) ? { sprintId: this.sprintFor(c.sprint) } : {}),
      pastSessions: t.sessionId ? [...(t.pastSessions ?? []), t.sessionId] : t.pastSessions, sessionId: undefined, branch: undefined, worktree: undefined, base: undefined,
      doneAt: undefined, startedAt: undefined, checks: undefined, review: undefined, error: undefined, reply: undefined, conflicts: undefined, live: undefined, pr: undefined, usage: undefined });
  },

  // A working or in-review task that must change: the new text is saved and the change goes to its Claude.
  async amend(this: Runner, t: Task, c: RefineResult) {
    this.store.updateTask(t.id, { title: c.title, description: c.description || undefined });
    await this.followUp(t.id, `The plan for this task changed. Update your work to match, verify it, update your handoff, then finish your turn.\n\n# ${c.title}\n${c.description ?? ''}`)
      .catch(e => this.d.notify('error', `"${t.title}": ${e.message}`, t.id));
  },

  stopPlanner(this: Runner) { this.planner?.kill(); this.planner = undefined; this.plannerProposals = undefined; this.plannerTargets = []; this.changed(); },

  // Applies the proposals the user kept: edits, adds (in order), removes, reorder of the To do tasks.
  // Where a task lands: the sprint Claude named (created when the board has no open sprint of that name), else an
  // edited task keeps its sprint, and a fresh plan uses the active sprint (so the tasks appear where you work).
  // where (the panel's picker): current = the tasks run in the project folder on its branch (no sprint, no new branch);
  // task = each on its own branch, no sprint; sprint = the sprint rules above. Without it (older panels), as before.
  applyProposals(this: Runner, changes: (RefineResult & { kind: string; apply?: boolean })[], removes: { id: string; apply?: boolean }[], where?: PlanWhere) {
    const noSprint = where === 'current' || where === 'task';
    const runWhere = where === 'current' ? { where: 'direct' as const } : where ? { where: 'branch' as const } : {};
    const sprintId = noSprint ? undefined : this.plannerTargets.map(id => this.store.task(id)?.sprintId).find(Boolean)
      ?? (this.plannerTargets.length ? undefined : this.store.data.sprints.find(s => s.active && !s.closed)?.id);
    const orderIds: string[] = [];
    let added = 0, edited = 0, removed = 0, reopened = 0, sent = 0;
    const made = new Map<RefineResult, string>();   // proposal → the task it became
    for (const c of changes) {
      const started = c.ref && this.plannerOthers.includes(c.ref) ? this.store.task(c.ref) : undefined;
      if (started && started.status !== 'todo') {
        if (!c.apply) continue;
        if (started.status === 'done') { this.reopen(started, c); orderIds.push(started.id); reopened++; }
        else { void this.amend(started, c); sent++; }
        continue;
      }
      if (!c.apply) { if (c.ref) orderIds.push(c.ref); continue; }
      const named = noSprint ? undefined : this.sprintFor(c.sprint);
      if (c.ref) {
        const was = this.store.task(c.ref);
        // A To do task not started yet can still move: to the current branch (out of its sprint) or to its own branch.
        const move = was && !was.worktree && was.status === 'todo' ? { ...runWhere, ...(noSprint ? { sprintId: undefined } : {}) } : {};
        this.store.updateTask(c.ref, { title: c.title, description: c.description || undefined, ...(named ? { sprintId: named } : {}), ...move }); orderIds.push(c.ref); edited++;
      }
      else { const t = this.store.addTask({ title: c.title, description: c.description || undefined, sprintId: named ?? (sprintId || undefined), mode: this.defaultMode, ...runWhere }); orderIds.push(t.id); made.set(c, t.id); added++; }
    }
    for (const rm of removes) if (rm.apply) { void this.remove(rm.id); removed++; }
    // "after": titles of tasks this one waits for (from this list or the board), resolved once all exist.
    const byTitle = (x: string) => this.store.data.tasks.find(o => !o.archived && o.title.trim().toLowerCase() === x.trim().toLowerCase())?.id;
    changes.forEach(c => {
      if (!c.apply || !c.after?.length) return;
      const id = c.ref ?? made.get(c);
      const deps = c.after.map(byTitle).filter((d): d is string => !!d && d !== id);
      if (id && deps.length) this.store.updateTask(id, { dependsOn: [...new Set(deps)] });
    });
    const after = this.store.data.tasks.find(t => t.status === 'todo' && !orderIds.includes(t.id) && !this.plannerTargets.includes(t.id));
    // Each goes in front of the same task (or to the end), so in proposal order they keep the planner's build order.
    for (const id of orderIds) this.store.reorder(id, after?.id);
    // The proposals are now real tasks: clear the panel (no double-apply) and let further chat refine them.
    this.plannerProposals = undefined;
    this.plannerTargets = orderIds.slice();
    this.plannerOthers = this.plannerOthers.filter(id => !this.plannerTargets.includes(id));
    const n = added + edited + removed + reopened + sent;
    const parts = [added && `added ${added}`, edited && `updated ${edited}`, removed && `removed ${removed}`, reopened && `${reopened} done back to To do`, sent && `sent the change to ${sent} started`].filter(Boolean);
    this.plannerNote = parts.length ? `Applied: ${parts.join(', ')} task${n === 1 ? '' : 's'}. Keep chatting to add or change more.` : 'No tasks changed.';
    this.changed();
  },

  // The 🎨 Fix to match task's first message: its design source (the task's one source) and the steps.
  fixDesignPrompt(this: Runner, t: Task) {
    const src = A.loadSources(this.root).find(s => t.sources?.includes(s.id));
    if (!src) return 'The design source for this task is gone. Say so in one line and stop.';
    const copy = A.hasCopy(this.root, src) ? A.sourceCopy(this.root, src.id) : src.kind === 'url' ? undefined : src.ref;
    if (!copy) return `The design ${src.ref} has no saved copy. Say in one line that the user must press Save copy on it under 📎 Sources, then stop.`;
    return `# Fix the UI to match the design\n\n${fixDesignSteps(copy, src.ref, this.root, this.d.cli || undefined, DC.screensOf(copy))}`;
  },

  // The audit's result becomes round 1 of the fix: the shared-style tasks it proposed (or, with none, the per-screen
  // tasks JustCode plans from the measures itself). Fix tasks merge into the checked-out branch (no sprint branch), so
  // the running app rebuilds after each merge and the next round re-measures what you actually run. Returns how many.
  addDesignFixes(this: Runner, id: string, text: string) {
    const p = parseProposals(text, new Set()) ?? [];
    // Fixes planned from bad design images would chase the wrong target: check them first.
    const audit = this.store.task(id), src = A.loadSources(this.root).find(s => audit?.sources?.includes(s.id));
    const copy = src && (A.hasCopy(this.root, src) ? A.sourceCopy(this.root, src.id) : src.kind === 'folder' ? src.ref : undefined);
    const bad = copy ? A.screenShotProblems(copy) : [];
    // Stopped before it finished (a run cut off, a capture left in the background): not done, the card says so.
    const unfinished = (why: string) => {
      this.store.updateTask(id, { status: 'review', error: `The audit stopped before finishing: ${why} No fix tasks were added. Press Follow-up task ("finish the audit: run design-capture again in the foreground, it resumes"), or run Fix to match again.` });
      this.d.notify('error', `Fix to match stopped before finishing: ${why}`, id);
      return 0;
    };
    if (bad.length) return unfinished(`the design reference is not complete (${bad.length} problem${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 3).join('; ')}).`);
    // An audit that compared only a few screens would plan fixes for those alone: say so instead.
    if (copy) {
      const shots = A.screenShotCount(copy), diffs = A.auditDiffCount(this.root);
      if (shots && diffs * 2 < shots) return unfinished(`it compared ${diffs} of ${shots} design screens with the app.`);
    }
    if (!copy || !src) { this.d.notify('info', 'Fix to match: the design source is gone. See the task card.', id); return 0; }
    // A new audit replaces the last one's fixes that have not started yet.
    for (const t of this.store.data.tasks.filter(t => t.status === 'todo' && !t.branch && !t.archived && (t.designFix || (A.DESIGN_FILE.test(t.description ?? '') && [copy, DC.screensOf(copy)].some(d => (t.description ?? '').includes(d))))))
      void this.remove(t.id);
    DF.save(this.root, { sourceId: src.id, copy, round: 1 });
    const plan = p.length ? [] : this.designPlan(copy, false);
    if (plan.some(x => x.rules)) DF.save(this.root, { sourceId: src.id, copy, round: 1, sharedTried: plan.flatMap(x => x.rules ?? []) });
    const planned = p.length ? p.map(c => ({ title: c.title, description: c.description, after: c.after }))
      : plan.map(x => ({ title: x.title, description: taskText(x), after: x.after }));
    if (!planned.length) { DF.save(this.root, { sourceId: src.id, copy, round: 1, done: true }); this.d.notify('info', 'Fix to match: every screen matches the design.', id); return 0; }
    return this.addRound(planned, 1, id);
  },

  // Adds one round of fix tasks (branch tasks on the checked-out branch, marked designFix) in order and queues them.
  addRound(this: Runner, planned: { title: string; description?: string; after?: string[] }[], round: number, from?: string) {
    const ids = new Map<string, string>();
    for (const c of planned) {
      const t = this.store.addTask({ title: c.title, description: c.description || undefined, mode: this.defaultMode, where: 'branch', designFix: round });
      ids.set(c.title.trim().toLowerCase(), t.id);
    }
    for (const c of planned) {
      const deps = (c.after ?? []).map(x => ids.get(x.trim().toLowerCase())).filter((d): d is string => !!d);
      const me = ids.get(c.title.trim().toLowerCase());
      if (me && deps.length) this.store.updateTask(me, { dependsOn: [...new Set(deps.filter(d => d !== me))] });
    }
    this.runAll([...ids.values()]);
    this.d.notify('info', `Fix to match, round ${round}: added ${ids.size} fix task${ids.size === 1 ? '' : 's'} (in All tasks / Backlog: they merge into your current branch) and started them. When they merge, JustCode measures again and plans what is left.`, from);
    return ids.size;
  },

  // Plans from the latest measures in .justcode/design/audit (recaptured first when asked): shared rules, else screens.
  designPlan(this: Runner, copy: string, _fresh: boolean) {
    const auditDir = path.join(this.root, '.justcode', 'design', 'audit');
    const { rows, shared, avgPx } = DC.diffAll(DC.screensOf(copy), auditDir, auditDir, DC.loadSample(path.join(this.root, '.justcode', 'design', 'sample.json')));
    this.designPx = avgPx;
    this.designScreensPx = Object.fromEntries(rows.filter(r => r.px !== undefined).map(r => [r.name, r.px!]));
    let screens: { id: string; title?: string; url?: string }[] = [];
    try { screens = JSON.parse(fs.readFileSync(path.join(DC.screensOf(copy), 'screens.json'), 'utf8')).screens ?? []; } catch { /* titles are a nicety */ }
    this.designLines = rows.reduce((n, r) => n + r.n, 0);   // the measured total, for "is the fix still making progress"
    return DC.planRound(copy, auditDir, rows, shared, screens, DF.load(this.root)?.sharedTried ?? []);
  },

  // After the last fix task of a round merges: rebuild-aware wait for the app, measure every screen again with the
  // audit's own jobs (no Claude), and add the next round, or say the app matches. Rounds go on while the differences fall.
  // manual: from 🎨 Design → Measure again: the same round is planned again (no new round), and a finished run restarts.
  // Wraps the measuring so the board shows it (designStatus, refreshed at most once a second) and clears it at the end.
  async designRemeasure(this: Runner, manual = false, progress: (line: string) => void = () => undefined) {
    if (this.designStatus) { if (manual) this.d.notify('info', 'Fix to match is already measuring.'); return; }
    let last = 0;
    const show = (line: string) => { progress(line); this.designStatus = line.replace(/^(Design|App): (\d+\/\d+).*/, '$1 $2'); if (Date.now() - last > 1000) { last = Date.now(); this.changed(); } };
    this.designStatus = 'starting…'; this.changed();
    try { await this.measureRound(manual, show); } finally { this.designStatus = undefined; this.changed(); }
  },

  async measureRound(this: Runner, manual: boolean, progress: (line: string) => void) {
    const st = DF.load(this.root);
    if (!st || (st.done && !manual)) return;
    const open = this.store.data.tasks.filter(t => t.designFix && !t.archived && t.status !== 'done');
    if (open.length) { if (manual) this.d.notify('info', `Fix to match: ${open.length} fix task${open.length === 1 ? ' is' : 's are'} not done. Let ${open.length === 1 ? 'it' : 'them'} merge, or archive ${open.length === 1 ? 'it' : 'them'}, then Measure again.`); return; }   // the round is not over
    const jobsFile = path.join(this.root, '.justcode', 'design', 'app-jobs.json');
    if (!fs.existsSync(jobsFile)) { this.d.notify('warn', 'Fix to match: no .justcode/design/app-jobs.json to measure the app again. Run Fix to match again.'); return; }
    if (!manual && st.round >= DF.MAX_ROUNDS) { DF.save(this.root, { ...st, done: true }); this.d.notify('warn', `Fix to match: stopped after ${DF.MAX_ROUNDS} rounds. What still differs is in .justcode/design/audit (*.diff.txt); Measure again to go on.`); return; }
    this.d.notify('info', 'Fix to match: the round merged. Measuring every screen again (no Claude)…');
    if (!await App.current(this.root, 'Fix to match: measure again')) { this.d.notify('error', 'Fix to match: the app is not running, so it could not be measured again. Start it with ▶ App, then run Fix to match.'); return; }
    // A design measured by an older recipe (no element classes) is measured again too, from the audit's own design jobs.
    const designJobs = path.join(this.root, '.justcode', 'design', 'jobs.json');
    if (fs.existsSync(designJobs) && DC.designMeasureOld(st.copy)) await DC.capture(DC.parseJobs(fs.readFileSync(designJobs, 'utf8')), l => progress(`Design: ${l}`)).catch(() => undefined);
    progress('App: starting the browser…');
    const r = await DC.capture(DC.parseJobs(fs.readFileSync(jobsFile, 'utf8')), l => progress(`App: ${l}`)).catch((e: Error) => ({ done: 0, failed: [e.message] }));
    if (!r.done) { this.d.notify('error', `Fix to match: could not measure the app again (${r.failed[0] ?? 'nothing captured'}). Is it running?`); return; }
    const planned = this.designPlan(st.copy, true);
    progress('Comparing…');
    if (!planned.length) { DF.save(this.root, { ...st, done: true }); this.d.notify('info', `Fix to match: every measured screen now matches the design (round ${st.round}).`); return; }
    // Go on while the measured differences keep falling; stop after STALE_ROUNDS rounds without progress (fixes that do
    // not land would otherwise repeat). Measure again always plans.
    // Progress is the average pixel score (what you see) when there is one, else the count of measured differences.
    const lines = this.designLines ?? 0, px = this.designPx, screensPx = this.designScreensPx ?? {};
    const better = px !== undefined && st.px !== undefined ? px <= st.px - 0.5 : st.lines === undefined || lines < st.lines;
    const stale = st.lines === undefined && st.px === undefined ? 0 : better ? 0 : (st.stale ?? 0) + 1;
    // Screens a round made worse (2+ points more pixels differing): named, so a regression is seen, not averaged away.
    const worse = Object.entries(screensPx).filter(([n, v]) => st.screensPx?.[n] !== undefined && v >= st.screensPx[n] + 2).map(([n, v]) => `${n} ${st.screensPx![n]}→${v}%`);
    if (worse.length) this.d.notify('warn', `Fix to match: the last round made ${worse.length} screen${worse.length === 1 ? '' : 's'} look less like the design: ${worse.slice(0, 6).join(', ')}${worse.length > 6 ? ', …' : ''}. See .justcode/design/audit/<name>.diff.png.`);
    const saved = { ...st, lines, px, screensPx, stale, sharedTried: [...new Set([...(st.sharedTried ?? []), ...planned.flatMap(x => x.rules ?? [])])] };
    if (!manual && stale >= DF.STALE_ROUNDS) {
      DF.save(this.root, { ...saved, done: true });
      this.d.notify('warn', `Fix to match: ${DF.STALE_ROUNDS} rounds without getting closer to the design (${px !== undefined ? `${px}% pixels differ on average` : `${lines} differences left`}), so it stopped. See .justcode/design/audit; Measure again to go on.`);
      return;
    }
    const round = manual ? st.round : st.round + 1;
    DF.save(this.root, { ...saved, round, done: false });
    if (px !== undefined) this.d.notify('info', `Fix to match: ${px}% of pixels differ from the design on average${st.px !== undefined ? ` (was ${st.px}%)` : ''}.`);
    this.addRound(planned.map(x => ({ title: x.title, description: taskText(x), after: x.after })), round);
  },

  // "Sprint 2: Search" → the open sprint named "Sprint 2", created with goal "Search" when there is none.
  sprintFor(this: Runner, label?: string) {
    if (!label) return undefined;
    const m = /^(.*?)\s*(?:[:—–]\s*|\s-\s)(.*)$/.exec(label);
    const name = (m ? m[1] : label).trim(), goal = m?.[2].trim() || undefined;
    if (!name) return undefined;
    const k = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    return this.store.data.sprints.find(x => !x.closed && k(x.name) === k(name))?.id ?? this.store.addSprint(name, goal).id;
  },
};
