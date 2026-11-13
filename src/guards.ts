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

// Runner methods: Project policy, budgets, the secret scan, the audit log and the artifact registry, as a task runs.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const guardMethods = {
  // The registry learns which artifacts a task is built on: its artifact sources and any links in its text.
  linkArtifacts(this: Runner, t: Task, sources: A.Source[]) {
    try {
      const picked = t.sources ? sources.filter(s => t.sources!.includes(s.id)) : sources;
      const urls = [...picked.filter(s => s.kind === 'url' && A.isArtifactLink(s.ref)).map(s => s.ref),
        ...A.artifactLinksIn([t.title, t.description ?? '', ...(t.files ?? [])].join('\n'))];
      for (const u of new Set(urls.map(A.artifactKey))) R.link(this.root, u, t.id, t.sprintId);
    } catch { /* the registry is a convenience */ }
  },

  // Spent against the policy's budgets: this task, its sprint, the whole project (tasks, reviews and planning).
  spent(this: Runner, t?: Task) {
    const tasks = this.store.data.tasks, sum = (l: Task[]) => l.reduce((n, x) => n + (x.costUsd ?? 0), 0);
    return { task: t?.costUsd ?? 0, sprint: t?.sprintId ? sum(tasks.filter(x => x.sprintId === t.sprintId)) : 0, project: sum(tasks) + (this.store.data.plannerCostUsd ?? 0) };
  },

  // "Budget reached: $5.12 of $5 (task)" when a budget is used up (0 = no budget), else undefined.
  overBudget(this: Runner, t: Task) {
    const max = loadPolicy(this.root).policy.maxCostUsd, s = this.spent(t);
    for (const k of ['task', 'sprint', 'project'] as const) {
      if (k === 'sprint' && !t.sprintId) continue;
      if (max[k] > 0 && s[k] >= max[k]) return `Budget reached: $${s[k].toFixed(2)} of $${max[k]} (${k}). Raise maxCostUsd.${k} in .justcode/policy.json, then press Resume.`;
    }
  },

  // After a turn or review adds cost: a used-up budget stops the task.
  checkBudget(this: Runner, id: string) {
    const t = this.store.task(id);
    const why = t && this.overBudget(t);
    if (!why) return false;
    this.stop(id);
    this.cancelReview(id);
    this.store.updateTask(id, { error: why, live: undefined });
    this.audit('budget.stop', id, why, 'policy');
    this.d.notify('warn', `"${t!.title}" stopped: ${why}`, id, true);
    return true;
  },

  secretScan(this: Runner) { return loadPolicy(this.root).policy.secretScan; },

  // Possible keys or tokens in what JustCode was about to commit: nothing is committed, the card names the lines, and
  // Claude is asked once to take them out (a second hit on the same lines waits for you).
  secretsBlocked(this: Runner, id: string, e: SecretsFound, cost?: number) {
    const t = this.store.task(id);
    if (!t) return;
    this.store.updateTask(id, { error: e.message, live: undefined, ...(cost !== undefined ? { costUsd: cost } : {}) });
    this.audit('secrets.block', id, describeSecrets(e.hits), 'policy');
    this.d.notify('warn', `"${t.title}": ${e.message}`, id, true);
    const key = `${id}|${describeSecrets(e.hits)}`;
    if (this.secretsAsked.has(key) || !this.sessions.get(id)?.open) return;
    this.secretsAsked.add(key);
    void this.say(id, `JustCode did not commit your changes: these lines look like secrets: ${describeSecrets(e.hits)}. ` +
      'Remove them (read keys from environment variables or an untracked .env file instead), then finish your turn. If one is a harmless example, rename the file to *.fixture.* or say why in your handoff.').catch(() => undefined);
  },

  // What the project policy forbids about running this task now, or undefined.
  policyBlock(this: Runner, t: Task) {
    const over = this.overBudget(t);
    if (over) return over;
    const p = loadPolicy(this.root).policy, set = this.d.settings();
    if (p.forbidModes.includes(t.mode)) return `The project policy forbids the "${t.mode}" permission mode (.justcode/policy.json, forbidModes). Pick another mode for this task.`;
    if (p.allowedModels.length && !p.allowedModels.includes(set.taskModel))
      return `The project policy allows only these models: ${p.allowedModels.join(', ')} (.justcode/policy.json, allowedModels). Set the task model in ⚙ to one of them.`;
  },

  // The mode a session runs in: Bypass all applies only when the policy allows bypassPermissions.
  modeFor(this: Runner, t: Task) {
    const set = this.d.settings();
    return set.bypassAll && loadPolicy(this.root).policy.forbidModes.includes('bypassPermissions') ? t.mode : effectiveMode(t.mode, set.bypassAll);
  },

  // Changed paths that the policy says need a person's look before merging (requireHumanReviewFor words).
  async humanReviewFor(this: Runner, t: Task) {
    const words = loadPolicy(this.root).policy.requireHumanReviewFor.map(w => w.toLowerCase()).filter(Boolean);
    if (!words.length) return [];
    const files = t.where === 'direct' ? t.directFiles ?? []
      : t.worktree && t.base ? (await g.git(t.worktree, ['diff', '--name-only', `${t.base}...HEAD`]).catch(() => '')).split('\n').filter(Boolean) : [];
    return files.filter(f => words.some(w => f.toLowerCase().includes(w)));
  },

  // The project policy for one session: re-read on every call, so an edit to policy.json applies at once.
  guard(this: Runner, taskId: string | undefined, cwd: string) {
    return (tool: string, input: Record<string, unknown>) => {
      const why = violations(loadPolicy(this.root).policy, tool, input, cwd);
      if (why) this.audit('policy.deny', taskId, `${tool} ${toolArg(input)}: ${why}`, 'policy');
      return why;
    };
  },

  audit(this: Runner, event: Audit.AuditEvent, taskId?: string, detail?: string, actor: Audit.Actor = 'justcode') {
    Audit.log(this.root, { actor, event, taskId, sprintId: taskId ? this.store.task(taskId)?.sprintId : undefined, detail });
  },

  // The published artifact whose title the task's text names (longest title wins), if any.
  publishedNamedIn(this: Runner, t: Task) {
    const text = `${t.title}\n${t.description ?? ''}`.toLowerCase();
    try {
      return R.load(this.root).filter(e => e.kind === 'output' && e.title && e.title.length >= 3 && text.includes(e.title.toLowerCase()))
        .sort((a, b) => b.title!.length - a.title!.length)[0];
    } catch { return undefined; }
  },

  // The page file of the task that last published this artifact, as a starting point.
  previousPage(this: Runner, e: R.ArtifactEntry) {
    for (const id of [...e.taskIds].reverse()) { const f = A.artifactFile(this.root, id); if (fs.existsSync(f)) return f; }
  },
};
