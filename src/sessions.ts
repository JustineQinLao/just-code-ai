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

// Runner methods: Remote Control hand-off, prompt history and where a task's saved sessions are.
// Attached to Runner.prototype in runner.ts; `this` is the project's Runner.
export const sessionMethods = {
  // The task leaves the board for a terminal running `claude --remote-control --resume <session>`, which shows it in
  // the Claude app and on claude.ai. Its session here is closed first: two processes must never share one session.
  async handoff(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.sessionId) throw new Error('Run the task first: there is no session to continue yet.');
    const s = this.sessions.get(id);
    if (s?.open) {
      await new Promise<void>(res => { s.on('exit', () => res()); s.close(); setTimeout(res, 5000).unref?.(); });
      this.sessions.delete(id);
    }
    this.store.updateTask(id, { remote: true, live: undefined, status: t.status === 'todo' ? 'doing' : t.status });
    this.changed();
    return { cwd: t.worktree && fs.existsSync(t.worktree) ? t.worktree : this.root, sessionId: t.sessionId, mode: t.mode };
  },

  // The Remote Control terminal closed: back on the board, its work committed and reviewed like any finished turn.
  async remoteEnded(this: Runner, id: string) {
    const t = this.store.task(id);
    if (!t?.remote) return;
    this.store.updateTask(id, { remote: undefined });
    await this.turnEnded(id, { ok: true, text: '' });
  },

  // Your prompts, newest first, with the sessions each one belongs to. Tasks from before the log existed are
  // filled in from the board, so nothing you ran is missing.
  history(this: Runner) {
    const logged = A.readPrompts(this.root);
    const seen = new Set(logged.filter(p => p.kind === 'task').map(p => p.taskId));
    const items = [...logged.reverse(), ...this.store.data.tasks.filter(t => !seen.has(t.id))
      .map(t => ({ time: t.created, kind: 'task' as const, text: [t.title, t.description].filter(Boolean).join('\n\n'), taskId: t.id, title: t.title }))];
    return items.sort((a, b) => b.time - a.time).map(p => {
      const t = p.taskId ? this.store.task(p.taskId) : undefined;
      const sessions = p.kind === 'plan' ? (p.sessionId && this.sessionDir(p.sessionId) ? [p.sessionId] : [])
        : t ? [...(t.pastSessions ?? []), t.sessionId].filter((s): s is string => !!s && !!this.sessionDir(s, t)) : [];
      return { ...p, title: t?.title ?? p.title, exists: !!t, status: t?.status, sessions };
    });
  },

  // Where a session's transcript is: the task's own folder (gone after a merge, its transcript stays) or the project.
  // Only sessions the board or the prompt log knows: a remote viewer can't read an arbitrary transcript.
  sessionDir(this: Runner, sessionId: string, t?: Task) {
    const task = t ?? this.store.data.tasks.find(x => x.sessionId === sessionId || x.pastSessions?.includes(sessionId));
    const known = task ? task.sessionId === sessionId || !!task.pastSessions?.includes(sessionId) : A.readPrompts(this.root).some(p => p.kind === 'plan' && p.sessionId === sessionId);
    if (!known) return;
    const dirs = task ? [task.worktree, g.worktreeDir(this.root, task.id), this.root] : [this.root];
    return dirs.find((d): d is string => !!d && sessionExists(d, sessionId));
  },
};
