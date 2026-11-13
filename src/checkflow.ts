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

// Runner methods: Task folder setup and the project's checks (no tokens): run, compare with the base branch, send failures back.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const checkMethods = {
  // The task folder's environment: the project's virtualenv and the task's own ports.
  folderEnv(this: Runner, id: string, cwd: string) { return cwd === this.root ? this.d.env() : C.folderEnv(this.root, id, this.d.env()); },

  async setupFolder(this: Runner, id: string, wt: string, quiet = false) {
    const set = this.d.settings();
    if (!set.setup.trim()) return;
    if (!quiet) this.setPhase(id, 'Setting up the task folder (dependencies)…');
    const log: string[] = [];
    try {
      const ok = await C.setupFolder(this.root, wt, set.setup, this.folderEnv(id, wt), s => log.push(s));
      if (!quiet) fs.mkdirSync(A.taskDir(this.root, id), { recursive: true });
      if (!quiet) fs.writeFileSync(path.join(A.taskDir(this.root, id), 'setup.log'), log.join('\n\n'));
      if (!ok && !quiet) this.d.notify('warn', `Setting up "${this.store.task(id)?.title}" failed; Claude starts anyway. See its setup.log under Details.`, id);
    } finally { if (!quiet) this.setPhase(id); }
  },

  // Runs the project's checks in the task's folder. Failures that the base branch has too are not the task's: they
  // are noted and ignored. A real failure goes back to Claude (up to maxCheckRounds), so the reviewer only sees
  // work that passes.
  async check(this: Runner, id: string): Promise<'pass' | 'fail' | 'none'> {
    const t = this.store.task(id), set = this.d.settings();
    const direct = t?.where === 'direct' && !t.init;
    if (!t || (direct ? !t.directFiles?.length : (!t.worktree || !t.base))) return 'none';
    const cwd = direct ? this.root : t.worktree!, base = direct ? t.startHead : t.base;
    if (!base) return 'none';
    const checks = C.checksFor(cwd, set.checks);
    if (!checks.length) return 'none';
    // A direct task has no commit of its own: its state is the hash of its working-tree diff.
    const head = direct ? sha(await g.workingDiff(cwd, base, t.directFiles!)) : await g.git(cwd, ['rev-parse', 'HEAD']).catch(() => '');
    if (t.checks?.head === head && t.checks.state === 'pass') return 'pass';
    if (this.checking.has(id)) return 'fail';  // already running for this task: the first run decides
    this.checking.add(id);
    this.setPhase(id, `Running checks: ${checks.map(c => c.name).join(', ')}…`);
    let results: C.CheckResult[], log: string;
    try {
      ({ results, log } = await C.runChecks(checks, cwd, this.folderEnv(id, cwd), set.checkTimeoutMinutes * 60_000));
      const failing = results.filter(r => !r.ok);
      if (failing.length) {
        const bl = await this.baseline(base, failing.map(f => f.cmd));
        for (const r of failing) if (bl.get(r.cmd) === false) r.preexisting = true;
      }
    } finally { this.setPhase(id); this.checking.delete(id); }
    const now = this.store.task(id);
    // Merged, discarded or deleted while the checks ran: their results no longer belong to anything.
    if (!now || now.status === 'done' || now.worktree !== t.worktree || (!direct && (!now.worktree || !fs.existsSync(path.join(now.worktree, '.git'))))) return 'none';
    if (direct) {
      const outside = (await g.dirtyFiles(this.root).catch(() => [] as string[])).filter(f => !t.directFiles!.includes(f));
      if (outside.length) log += `Note: the working tree also had changes outside this task's files (${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ', …' : ''}); the checks ran with them present.\n`;
    }
    try { fs.mkdirSync(A.taskDir(this.root, id), { recursive: true }); fs.writeFileSync(A.checksLog(this.root, id), log); } catch { /* the card still shows it */ }
    const real = results.filter(r => !r.ok && !r.preexisting);
    const rounds = real.length ? (now.checks?.state === 'fail' ? now.checks.rounds : 0) + 1 : 0;
    this.store.updateTask(id, { checks: { state: real.length ? 'fail' : 'pass', rounds, head,
      results: results.map(r => ({ name: r.name, cmd: r.cmd, ok: r.ok, ms: r.ms, tail: r.tail || undefined, preexisting: r.preexisting, timedOut: r.timedOut })) } });
    if (!real.length) return 'pass';
    this.audit('checks.fail', id, real.map(r => r.cmd).join(', '));
    if (rounds > set.maxCheckRounds) {
      this.d.notify('warn', `"${t.title}": checks still fail after ${rounds - 1} fix rounds. Details are on the card.`, id, true);
      return 'fail';
    }
    await this.sendChecks(id);
    return 'fail';
  },

  async sendChecks(this: Runner, id: string) {
    const t = this.store.task(id);
    const failing = t?.checks?.results?.filter(r => !r.ok && !r.preexisting) ?? [];
    if (!t || (!t.worktree && !(t.where === 'direct' && !t.init)) || t.status === 'done' || !failing.length) return;
    this.store.updateTask(id, { status: 'doing' });
    await this.say(id, `JustCode ran the project's checks after your turn. These fail:\n\n` +
      failing.map(r => `$ ${r.cmd}  (${r.timedOut ? 'timed out' : 'failed'})\n\`\`\`\n${r.tail ?? ''}\n\`\`\``).join('\n\n') +
      `\n\nFull log: ${A.checksLog(this.root, id)}. Fix the cause (change a test only if the test itself is wrong), re-run the failing check, update your handoff, then finish your turn.`);
  },

  async baseline(this: Runner, base: string, cmds: string[]): Promise<Map<string, boolean>> {
    const sha = await g.git(this.root, ['rev-parse', base]).catch(() => '');
    if (!sha) return new Map();
    const file = path.join(this.root, '.justcode', 'checks-baseline.json');
    let cache: Record<string, Record<string, boolean>> = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const known = cache[sha] ?? {};
    const todo = cmds.filter(c => !(c in known));
    if (todo.length) {
      const key = `${sha}:${todo.join('|')}`;
      if (!this.baselineRuns.has(key)) this.baselineRuns.set(key, (async () => {
        const dir = g.worktreeDir(this.root, BASELINE);
        await this.serial(async () => {
          if (!fs.existsSync(path.join(dir, '.git'))) await g.git(this.root, ['worktree', 'add', '--detach', dir, sha]);
          else await g.git(dir, ['checkout', '-q', '--detach', '-f', sha]);
        });
        g.copyEnvFiles(this.root, dir, this.d.settings().worktreeCopy);
        await this.setupFolder(BASELINE, dir, true);
        const out = new Map<string, boolean>();
        for (const cmd of todo) out.set(cmd, (await C.runCommand(cmd, dir, { ...this.folderEnv(BASELINE, dir), CI: 'true' }, this.d.settings().checkTimeoutMinutes * 60_000)).code === 0);
        return out;
      })().finally(() => this.baselineRuns.delete(key)));
      const res = await this.baselineRuns.get(key)!.catch(() => new Map<string, boolean>());
      for (const [c, ok] of res) known[c] = ok;
      cache = { [sha]: known }; // only the latest base commit is worth keeping
      try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* recomputed next time */ }
    }
    return new Map(Object.entries(known));
  },

  async hasWork(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.worktree || !t.base) return false;
    return !!(await g.git(t.worktree, ['diff', '--stat', `${t.base}...HEAD`]).catch(() => '')).trim();
  },
};
