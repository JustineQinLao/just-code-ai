import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Store, Task } from './store';
import * as g from './git';
import { setupSkillBody } from './skill';
import { Session, Answer, Ask, AgentNode, TurnEnd, RunState } from './session';
import * as R from './registry';
import * as Audit from './audit';
import { SecretsFound, describeSecrets } from './secrets';
import { loadPolicy, violations, toolArg } from './policy';
import { trackIssues, openIssues, acceptedIssues, roundLimit } from './issues';
import { transcript } from './claude';
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
      asks: s?.open ? [...s.asks.values()].filter(a => a.kind === 'question') : [] };
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
    const s = new Session({
      // Not Claude Code's plan mode: it tells Claude to write a plan file, which a read-only chat cannot, so each turn
      // spent tokens on a refused Write. Default mode with the write tools removed keeps it read-only.
      bin, cwd: this.root, sessionId: this.plannerSession, resume: false, mode: 'default', model: set.plannerModel || undefined,
      append: PLANNER_APPEND, readOnly: true, effort: set.plannerEffort || undefined,
      allowed: userAllowRules(), rules: () => userAllowRules(), env: this.d.env(), idleMs: 30 * 60_000, label: 'Planner', personal: set.personalSetup, plugins: this.plugins(), guard: this.guard(undefined, this.root),
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
      others.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status })), into && this.store.data.sprints.some(x => x.name === into && !x.closed) ? into : undefined));
    this.changed();
  },

  onPlannerTurn(this: Runner, turn: TurnEnd) {
    this.store.addPlannerCost(turn.costUsd ?? 0);
    if (turn.limit) { this.d.limits.setReached('usage'); return; }
    if (!turn.ok) { this.d.notify('error', `Planner stopped: ${String(turn.error).slice(0, 200)}`); return; }
    const ids = new Set([...this.plannerTargets, ...this.plannerOthers]);
    const p = parseProposals(turn.text, ids);
    if (p) { this.plannerProposals = p; this.plannerNote = undefined; }
    this.changed();
  },

  plannerAnswer(this: Runner, a: Answer) { this.planner?.answer(a); },

  plannerSay(this: Runner, text: string) {
    if (!this.planner?.open) throw new Error('The planning chat has ended. Start it again.');
    this.planner.send(text);
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
    await this.say(t.id, `The plan for this task changed. Update your work to match, verify it, update your handoff, then finish your turn.\n\n# ${c.title}\n${c.description ?? ''}`)
      .catch(e => this.d.notify('error', `"${t.title}": ${e.message}`, t.id));
  },

  stopPlanner(this: Runner) { this.planner?.kill(); this.planner = undefined; this.plannerProposals = undefined; this.plannerTargets = []; this.changed(); },

  // Applies the proposals the user kept: edits, adds (in order), removes, reorder of the To do tasks.
  // Where a task lands: the sprint Claude named (created when the board has no open sprint of that name), else an
  // edited task keeps its sprint, and a fresh plan uses the active sprint (so the tasks appear where you work).
  applyProposals(this: Runner, changes: (RefineResult & { kind: string; apply?: boolean })[], removes: { id: string; apply?: boolean }[]) {
    const sprintId = this.plannerTargets.map(id => this.store.task(id)?.sprintId).find(Boolean)
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
      const named = this.sprintFor(c.sprint);
      if (c.ref) { this.store.updateTask(c.ref, { title: c.title, description: c.description || undefined, ...(named ? { sprintId: named } : {}) }); orderIds.push(c.ref); edited++; }
      else { const t = this.store.addTask({ title: c.title, description: c.description || undefined, sprintId: named ?? (sprintId || undefined), mode: this.defaultMode }); orderIds.push(t.id); made.set(c, t.id); added++; }
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
