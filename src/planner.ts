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
import * as S from './stylecheck';
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
    this.ensureIntegration(orderIds, changes.filter(c => c.apply).map(c => made.get(c) ?? c.ref).filter((x): x is string => !!x));
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

  // Every plan of 2+ tasks ends with one integration task: it waits for all of them and verifies them together where
  // they merged (the checked-out branch, or the sprint branch). The planner is told to write it (PLANNER_APPEND rule 7,
  // with the project's real commands); when it did not, or a later round added tasks, JustCode adds or extends it.
  ensureIntegration(this: Runner, orderIds: string[], applied: string[]) {
    const isInt = (t?: Task) => !!t && (t.integration || /^integrate and verify\b/i.test(t.title));
    // This plan's tasks: the ones just applied and, in a later round of the same chat, the ones it made before.
    const plan = [...new Set([...this.plannerTargets, ...orderIds])];
    const work = plan.filter(id => { const t = this.store.task(id); return t && !t.archived && !isInt(t) && t.status !== 'done'; });
    if (work.length < 2 || !applied.length) return;
    let it = plan.map(id => this.store.task(id)).find(t => isInt(t) && !t!.archived && t!.status === 'todo');
    const titles = work.map(id => this.store.task(id)!.title);
    if (!it) {
      const sprint = this.store.task(work[0])?.sprintId;
      it = this.store.addTask({ title: 'Integrate and verify: the planned tasks together', mode: this.defaultMode, ...(sprint ? { sprintId: sprint, where: 'branch' as const } : { where: 'direct' as const }),
        description: ['Goal: Check that every task of this plan works together, where they all merged. No new features.',
          'Done when:', ...titles.map(x => `- "${x}" is merged here and its "Done when" items hold in the running app`),
          '- the app is rebuilt and restarted with the merged code', '- the full test suites and the build pass',
          '- anything still failing is listed in the reply (with a ```fixes block), not fixed here'].join('\n') });
      orderIds.push(it.id);
    } else if (!orderIds.includes(it.id)) orderIds.push(it.id);
    else { orderIds.splice(orderIds.indexOf(it.id), 1); orderIds.push(it.id); }   // always last
    this.store.updateTask(it.id, { integration: true, dependsOn: [...new Set([...(it.dependsOn ?? []).filter(d => d !== it!.id), ...work])] });
  },

  // The 🎨 Fix to match task's first message: its design source (the task's one source) and the steps.
  fixDesignPrompt(this: Runner, t: Task) {
    const src = A.loadSources(this.root).find(s => t.sources?.includes(s.id));
    if (!src) return 'The design source for this task is gone. Say so in one line and stop.';
    const copy = A.hasCopy(this.root, src) ? A.sourceCopy(this.root, src.id) : src.kind === 'url' ? undefined : src.ref;
    if (!copy) return `The design ${src.ref} has no saved copy. Say in one line that the user must press Save copy on it under 📎 Sources, then stop.`;
    return `# Fix the UI to match the design\n\n${fixDesignSteps(copy, src.ref, this.root, this.d.cli || undefined, DC.screensOf(copy))}`;
  },

  // The setup task (Claude, once) made the design reference and app-jobs.json: check it is complete, then run the
  // style check (no Claude). It adds no fix task by itself: you add the one fix task, or screen tasks, from 🎨 Design.
  designSetupDone(this: Runner, id: string) {
    const setup = this.store.task(id), src = A.loadSources(this.root).find(s => setup?.sources?.includes(s.id));
    const copy = src && (A.hasCopy(this.root, src) ? A.sourceCopy(this.root, src.id) : src.kind === 'folder' ? src.ref : undefined);
    const unfinished = (why: string) => {
      this.store.updateTask(id, { status: 'review', error: `The setup stopped before finishing: ${why} Press Follow-up task ("finish the setup: run design-capture again in the foreground, it resumes"), or run Fix to match again.` });
      this.d.notify('error', `Fix to match: the setup stopped before finishing: ${why}`, id);
      return false;
    };
    if (!copy || !src) { this.d.notify('info', 'Fix to match: the design source is gone. See the task card.', id); return false; }
    const bad = A.screenShotProblems(copy);
    if (bad.length) return unfinished(`the design reference is not complete (${bad.length} problem${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 3).join('; ')}).`);
    if (!fs.existsSync(path.join(this.root, '.justcode', 'design', 'app-jobs.json'))) return unfinished('there is no .justcode/design/app-jobs.json.');
    DF.save(this.root, { sourceId: src.id, copy, round: 1 });
    void this.designCheck(false);
    return true;
  },

  // Ready for the style check without Claude: a complete design reference and the app's jobs.
  designReady(this: Runner, copy: string) {
    return A.screenShotCount(copy) > 0 && !A.screenShotProblems(copy).length && fs.existsSync(path.join(this.root, '.justcode', 'design', 'app-jobs.json'));
  },

  // 🎨 Design → Check again (and after the setup): shoot the app's screens, compare styles, write the report and the
  // comparison. No Claude, no tasks. The board shows its progress (designStatus).
  async designCheck(this: Runner, manual: boolean, progress: (line: string) => void = () => undefined) {
    if (this.designStatus) { if (manual) this.d.notify('info', 'Fix to match is already checking.'); return; }
    const st = DF.load(this.root);
    if (!st) { this.d.notify('warn', 'Fix to match: run it once from 🎨 Design first.'); return; }
    let last = 0;
    const show = (line: string) => { progress(line); this.designStatus = line.replace(/^App: (\d+\/\d+).*/, 'App $1'); if (Date.now() - last > 1000) { last = Date.now(); this.changed(); } };
    this.designStatus = 'starting…'; this.changed();
    try {
      if (!await App.current(this.root, 'Fix to match: style check')) { this.d.notify('error', 'Fix to match: the app is not running. Start it with ▶ App, then press Check again.'); return; }
      const { report } = await S.runStyleCheck(this.root, st.copy, { progress: show });
      const n = S.reportCount(report);
      this.d.notify('info', n ? `Style check: ${n} style difference${n === 1 ? '' : 's'} on ${report.screens} screens (no AI). 🎨 Design → Fix the styles adds one task for them; Open comparison shows every screen side by side.` : `Style check: the styles match the design on ${report.screens} screens. Open comparison under 🎨 Design to look at each screen.`);
    } catch (e: any) { this.d.notify('error', `Fix to match: ${e.message}`); }
    finally { this.designStatus = undefined; this.changed(); }
  },

  // 🎨 Design → Fix the styles: ONE quick task (in your workspace, no checks or AI review; Finish commits it) from the
  // style check. Started at once: you pressed it.
  designFixTask(this: Runner) {
    const st = DF.load(this.root), report = S.loadReport(this.root);
    if (!st || !report || !S.reportCount(report)) { this.d.notify('info', 'Fix to match: no style differences to fix. Press Check again first.'); return; }
    const design = path.join(this.root, '.justcode', 'design');
    const css = fs.readdirSync(design).filter(f => /^design-\d+\.css$/.test(f)).map(f => path.join(design, f));
    const t = this.store.addTask({ title: 'Match the design\'s styles', description: S.fixTaskText(report, { report: S.reportFile(this.root, 'md'), css }, this.d.cli || '<JustCode cli.js>', this.root),
      mode: this.defaultMode, where: 'direct', quick: true, designFix: 1 });
    void this.run(t.id);
    return t.id;
  },

  // 🎨 Design → screens you ticked: one quick task per up to 5 screens, each told to look once at the end.
  designScreenTasks(this: Runner, ids: string[]) {
    const st = DF.load(this.root);
    if (!st || !ids.length) return [];
    const ref = DC.screensOf(st.copy);
    let info: { id: string; title?: string; url?: string }[] = [];
    try { info = JSON.parse(fs.readFileSync(path.join(ref, 'screens.json'), 'utf8')).screens ?? []; } catch { /* titles are a nicety */ }
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += 5) {
      const part = ids.slice(i, i + 5), name = (id: string) => info.find(s => s.id === id)?.title ?? id;
      const files = part.flatMap(id => fs.readdirSync(ref).filter(f => f.startsWith(`${id}-`) && /-\d{3,4}\.(html|png)$/.test(f) || f.startsWith(`${id}~`) && /\.html$/.test(f)).map(f => path.join(ref, f)));
      const t = this.store.addTask({ title: `Match the design: ${part.map(name).join(', ')}`.slice(0, 90),
        description: [`Goal: Make ${part.map(id => `${id}${info.find(s => s.id === id)?.url ? ` (${info.find(s => s.id === id)!.url})` : ''}`).join(', ')} look like the design: layout, order, spacing and the parts it shows. Use the app's shared classes; keep the app's own data and behaviour.`,
          `Files: ${files.join(', ')}`,
          'Steps:', '- Read the design .html of each screen (its structure and classes) and change the app\'s page to match it.',
          '- At the end take ONE screenshot of each screen at 390 wide and compare it with the design .png by eye; fix what is clearly different, then stop. No other screenshots, no measuring tools.',
          'Done when:', '- each screen shows the same parts in the same order as the design', '- the build passes'].join('\n'),
        mode: this.defaultMode, where: 'direct', quick: true, designFix: 1 });
      out.push(t.id);
    }
    this.runAll(out);
    return out;
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
