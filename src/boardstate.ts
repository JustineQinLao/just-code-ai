import { mobileMessage, bypassGate, canEnableBypassAll, DialogHub, makePhoneBoard, confirmBypassFor, remoteConfirm, remoteInput, remotePaths, validLink } from './bridge';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Store, Task, resolveWhere } from './store';
import { Runner, RunnerSettings } from './runner';
import * as g from './git';
import { pluginDir } from './plugin';
import { transcript, agentLog, archivedLog, artifactUrlIn, claudeBin, claudeEnv, discoverAgents, discoverSkills, savedAgents, sessionLog, slashCommands } from './claude';
import { Limits } from './limits';
import { checkHealth, checkSetup, installCommand, projectSetup, SetupState, pluginInstallCommands, playwrightCommand, SUPERPOWERS_FALLBACK } from './setup';
import * as A from './artifacts';
import * as R from './registry';
import * as Audit from './audit';
import { writeSprintReport } from './report';
import { loadPolicy, policyFile } from './policy';
import type { Actor } from './audit';
import * as C from './checks';
import * as D from './design';
import { ensureCert, PhoneCert } from './phonecert';
import { Device, DeviceStore, startPhoneServer, canPhoneMerge, phoneDetail, phoneSteps, phoneMoveError, phoneProjectOk, phoneProjects, phoneLinkUrl, qrSvg, issuePairingCode } from './phone';
import type * as http from 'http';
import { startMobileServer, MobileServer } from './server';
import { askingTerms, bypassAllOn, emit, limits, roots, runner, runnerSettings, runners, savingTerms, setting, sinks, st, workspace } from './host';
import { phoneDevices } from './phonehost';
import { savedAt } from './artifact-terminal';

// The state the board renders, and the open task's activity.

export function post() {
  if (!sinks.size) return;
  const r = runner();
  if (!r) { emit({ type: 'state', empty: true, roots: [], setup: st.setup, version: st.ctx.extension.packageJSON.version }); return; }
  const tasks = r.store.data.tasks.map(t => ({ ...t, ...r.live(t.id),
    artifacts: { plan: fs.existsSync(A.planFile(r.root, t.id)), brief: fs.existsSync(A.briefFile(r.root, t.id)), handoff: fs.existsSync(A.handoffFile(r.root, t.id)), review: fs.existsSync(A.reviewFile(r.root, t.id)), transcript: fs.existsSync(A.transcriptFile(r.root, t.id)) } }));
  const s = runnerSettings();
  emit({
    type: 'state',
    roots: roots().map(p => ({ path: p, name: path.basename(p), removable: !workspace().includes(p), ...(runners.get(p)?.counts() ?? { running: 0, waiting: 0 }) })),
    root: r.root,
    board: { ...r.store.data, tasks },
    setup: st.setup, project: projectSetup(r.root),
    limit: limits.view(),
    version: st.ctx.extension.packageJSON.version,
    queue: r.queueInfo(),
    agents: discoverAgents(r.root).map(a => ({ name: a.name, description: a.description, scope: a.scope })),
    skills: discoverSkills(r.root, setting('personalSetup', false)),
    sources: A.loadSources(r.root).map(x => ({ ...x, artifact: x.kind === 'url' && A.isArtifactLink(x.ref), copy: A.hasCopy(r.root, x), savedAt: savedAt(r.root, x), saving: savingTerms.has(x.id), asking: askingTerms.has(x.id) })),
    registry: R.load(r.root),
    phone: { on: setting('phoneServer', false), days: setting<number>('phoneTokenDays', 7), devices: phoneDevices.list().filter(d => d.expires > Date.now()).map(({ hash: _, ...d }) => d) },
    policy: (() => { const l = loadPolicy(r.root), day = new Date(); day.setHours(0, 0, 0, 0);
      return { ...l, file: policyFile(r.root), denials: Audit.read(r.root, { since: day.getTime(), event: 'policy.deny' }).slice(-50) }; })(),
    detectedChecks: C.detectChecks(r.root),
    settings: { ...s, notifications: setting('notifications', 'actionable'), defaultMode: setting('defaultMode', 'auto'), defaultWhere: setting('defaultWhere', 'auto'), bypassAll: bypassAllOn(), plannerModel: setting('plannerModel', 'opus'), apiKey: !!st.apiKey },
    planner: r.plannerLive(),
    plannerPhase: r.plannerPhase,
    guideSeen: st.ctx.globalState.get('guideSeen', false),
    all: [...runners.entries()].filter(([root]) => roots().includes(root)).map(([root, x]) => ({
      root, name: path.basename(root),
      tasks: x.store.data.tasks.filter(t => !t.archived && (x.isOpen(t.id) || x.live(t.id).reviewing || t.status === 'doing' || t.status === 'review'))
        .map(t => ({ id: t.id, title: t.title, status: t.status, ...x.live(t.id), review: t.review })),
    })),
  });
  sendSteps();
}

// A closed task's activity: Claude Code's saved transcript, or the task's own archive once that is gone.
export function savedLog(r: Runner, t: Task) {
  if (!t.sessionId) return [];
  const dir = r.sessionDir(t.sessionId, t);
  return dir ? sessionLog(dir, t.sessionId) : archivedLog(A.transcriptFile(r.root, t.id));
}

// The open task's activity: live from its session, or from Claude Code's saved transcript once it has closed.
export function sendSteps(force = false) {
  if (!sinks.size || !st.watching) return;
  const r = runners.get(st.watching.root), t = r?.store.task(st.watching.id);
  if (!r || !t) return;
  const live = r.steps(t.id);
  const steps = live ?? savedLog(r, t);
  const last = steps.length ? steps[steps.length - 1].time + steps[steps.length - 1].text.slice(0, 40) : '';
  if (!force && steps.length === st.watching.n && last === st.watching.last) return;
  st.watching.n = steps.length; st.watching.last = last;
  emit({ type: 'steps', id: t.id, steps, live: !!live });
}
