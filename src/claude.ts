import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { Task } from './store';
import { sdk } from './sdk';

export interface AgentDef { name: string; description: string; model?: string; tools?: string; file: string; scope: 'project' | 'user' }

const WIN = process.platform === 'win32';

// GUI-launched editors often lack the shell PATH, so the usual install spots are searched too.
export function claudeBin(setting: string): string | undefined {
  if (setting) return fs.existsSync(setting) ? setting : undefined;
  const home = os.homedir();
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), ...(WIN ? [path.join(process.env.APPDATA ?? '', 'npm')] : [])];
  const names = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  return dirs.flatMap(d => names.map(n => path.join(d, n))).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

// Markers a parent Claude session leaves in the environment (VS Code started from Claude). Inherited, they make a
// task's session a "child" that doesn't save its transcript, or link it to the editor.
const INHERITED = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
  'ENABLE_IDE_INTEGRATION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_INJECTION', 'CURSOR_TRACE_ID'];

// apiKey: only when the user chose one (JustCode: Use an Anthropic API Key); otherwise Claude uses its own login, and an
// ANTHROPIC_API_KEY that happens to be in the editor's environment is not passed on (it would silently bill the API).
export function claudeEnv(apiKey?: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !INHERITED.includes(k))) as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  env.PATH = [process.env.PATH, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
  env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  return env;
}

// Flat `key: value` frontmatter, which all Claude Code agent files use for these fields.
function frontmatter(text: string) {
  const out: Record<string, string> = {};
  for (const line of /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readAgents(dir: string, scope: AgentDef['scope']): AgentDef[] {
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  return files.map(f => {
    const file = path.join(dir, f), fm = frontmatter(fs.readFileSync(file, 'utf8'));
    return { name: fm.name || f.slice(0, -3), description: fm.description ?? '', model: fm.model || undefined, tools: fm.tools || undefined, file, scope };
  });
}

// Project agents shadow user agents of the same name, as in Claude Code.
export function discoverAgents(root: string): AgentDef[] {
  const project = readAgents(path.join(root, '.claude', 'agents'), 'project');
  const names = new Set(project.map(a => a.name));
  return [...project, ...readAgents(path.join(os.homedir(), '.claude', 'agents'), 'user').filter(a => !names.has(a.name))];
}

// Skills (<name>/SKILL.md) and commands (<name>.md), project then user; offered as chips to drop into a task.
export function discoverSkills(root: string): string[] {
  const names = (dir: string, skills: boolean) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => skills
        ? d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')) ? [d.name] : []
        : d.isFile() && d.name.endsWith('.md') ? [d.name.slice(0, -3)] : []);
    } catch { return []; }
  };
  return [...new Set([root, os.homedir()].flatMap(r => [...names(path.join(r, '.claude', 'skills'), true), ...names(path.join(r, '.claude', 'commands'), false)]))]
    .filter(n => !/^lex-?code/i.test(n));
}

// A task's copy of the project only has committed files. Project agents, skills and local settings that are not
// committed are handed to its session instead of copied in, so the task's commit never picks them up. Nothing secret
// goes on a command line: settings are passed as a file path.
export function carryOver(root: string, worktree: string) {
  const out: { agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>; addDirs: string[]; settingsFile?: string } = { addDirs: [] };
  if (root === worktree) return out;
  const have = new Set(readAgents(path.join(worktree, '.claude', 'agents'), 'project').map(a => a.name));
  const missing = readAgents(path.join(root, '.claude', 'agents'), 'project').filter(a => !have.has(a.name));
  if (missing.length) {
    out.agents = Object.fromEntries(missing.map(a => [a.name, {
      description: a.description, prompt: fs.readFileSync(a.file, 'utf8').replace(/^---[\s\S]*?---\s*/, ''),
      ...(a.tools && { tools: a.tools.split(',').map(t => t.trim()).filter(Boolean) }), ...(a.model && { model: a.model }),
    }]));
  }
  // Claude Code loads .claude/skills from an added directory (the project folder itself, for uncommitted skills).
  if (fs.existsSync(path.join(root, '.claude', 'skills')) && !fs.existsSync(path.join(worktree, '.claude', 'skills'))) out.addDirs.push(root);
  const local = path.join(root, '.claude', 'settings.local.json');
  if (fs.existsSync(local) && !fs.existsSync(path.join(worktree, '.claude', 'settings.local.json'))) out.settingsFile = local;
  return out;
}

export function taskPrompt(t: Task) {
  return [t.title, t.description?.trim() === t.title.trim() ? undefined : t.description,
    t.images?.length && `Screenshots for this task (read them first):\n${t.images.map(f => `- ${f}`).join('\n')}`,
    t.where !== 'root' && 'You work in this task\'s own copy of the project (a git worktree on its own branch). Stay inside the current directory. ' +
      'JustCode commits your changes when you finish; do not commit or push yourself. When you are done, say what you changed and how you verified it.']
    .filter(Boolean).join('\n\n');
}

// Claude Code stores sessions in ~/.claude/projects/<cwd with non-alphanumerics → '-'>/<id>.jsonl
const transcript = (cwd: string, id: string) =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
export const sessionExists = (cwd: string, id: string) => fs.existsSync(transcript(cwd, id));
export const sessionSize = (cwd: string, id: string) => { try { return fs.statSync(transcript(cwd, id)).size; } catch { return 0; } };

export interface LogStep { kind: 'user' | 'say' | 'tool' | 'result' | 'error' | 'info'; text: string; time?: string }

// A finished session's saved transcript as readable steps (main thread only), for a card whose session has closed.
// Reads the last 4 MB.
export function sessionLog(cwd: string, sessionId: string): LogStep[] {
  let text: string;
  try {
    const fd = fs.openSync(transcript(cwd, sessionId), 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 4 * 1024 * 1024), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const steps: LogStep[] = [];
  const arg = (input: any) => {
    const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.description ?? input?.prompt;
    return typeof v === 'string' ? v.split('\n')[0].slice(0, 300) : '';
  };
  for (const line of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain || r.isMeta || (r.type !== 'assistant' && r.type !== 'user')) continue;
    const time = typeof r.timestamp === 'string' ? r.timestamp : undefined;
    const c = r.message?.content;
    if (typeof c === 'string') { if (r.type === 'user' && !c.startsWith('<')) steps.push({ kind: 'user', text: c, time }); continue; }
    for (const x of Array.isArray(c) ? c : []) {
      if (x.type === 'text' && x.text?.trim() && !x.text.startsWith('<')) steps.push({ kind: r.type === 'user' ? 'user' : 'say', text: x.text.trim(), time });
      else if (x.type === 'tool_use') steps.push({ kind: 'tool', text: `${x.name}(${arg(x.input)})`, time });
      else if (x.type === 'tool_result') {
        const t = typeof x.content === 'string' ? x.content : Array.isArray(x.content) ? x.content.filter((y: any) => y.type === 'text').map((y: any) => y.text).join('\n') : '';
        steps.push({ kind: x.is_error ? 'error' : 'result', text: t.split('\n').find((l: string) => l.trim())?.slice(0, 300) ?? '(no output)', time });
      }
    }
  }
  return steps.slice(-400);
}

/* ---------- AI reviewer ---------- */

export interface Verdict { pass: boolean; issues: string[]; risk: 'minor' | 'critical'; tested: string[] }

// adb from PATH or the usual Android SDK spots, and the devices it sees right now.
export function adb(): { bin: string; devices: string[] } | undefined {
  const sdkDirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')]
    .filter(Boolean).map(d => path.join(d!, 'platform-tools', WIN ? 'adb.exe' : 'adb'));
  const bin = [...(process.env.PATH ?? '').split(path.delimiter).map(d => path.join(d, WIN ? 'adb.exe' : 'adb')), ...sdkDirs].find(f => fs.existsSync(f));
  if (!bin) return;
  try {
    const out = execFileSync(bin, ['devices'], { encoding: 'utf8', timeout: 5000 });
    return { bin, devices: out.split('\n').slice(1).map(l => l.split('\t')).filter(([, s]) => s?.trim() === 'device').map(([id]) => id) };
  } catch { return { bin, devices: [] }; }
}

// Commands the reviewer may run: read git, run tests and builds, adb, screenshots. Edits stay blocked.
export const REVIEW_COMMANDS = ['git diff', 'git log', 'git show', 'git status', 'ls', 'cat',
  'npm test', 'npm run', 'npx tsc', 'npx jest', 'npx vitest', 'npx playwright', 'npx eslint', 'npx ng test',
  'yarn test', 'yarn run', 'yarn build', 'yarn lint', 'pnpm test', 'pnpm run', 'pnpm build', 'pnpm lint', 'bun test', 'bun run',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'python manage.py test', 'python3 manage.py test', 'ruff', 'mypy',
  'go test', 'go build', 'go vet', 'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'make test', 'make check', 'make build',
  'mvn test', 'mvn -q test', './gradlew', 'gradle test', 'dotnet test', 'dotnet build', 'flutter test', 'dart test', 'swift test', 'xcodebuild test',
  'docker compose exec', 'docker compose run', 'adb', 'curl'];

const MAX_DIFF = 150_000;
const q = (p: string) => /\s/.test(p) ? `"${p}"` : p;

// Reviewer prompt: the task, its diff, how to test it (tests, adb screenshots), a strict JSON verdict.
export function reviewPrompt(t: Task, base: string, diff: string, test: { shots: string; adb?: { bin: string; devices: string[] }; cli?: string } = { shots: '' }) {
  const clipped = diff.length <= MAX_DIFF ? diff : `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated; read the changed files for the rest]`;
  return [
    `# Review task: ${t.title}`, t.description ?? '',
    `You review work another agent did on this branch (diff against ${base} below). You do not change code.`,
    'Check: does it do what the task asks, completely? Bugs, unhandled errors, edge cases, regressions in callers. ' +
    'Tests for the changed behaviour. Security: validation, authorization, data isolation, injection, secrets. Fits the codebase\'s conventions.',
    'Fail only for real problems. Make every issue specific and actionable: file, line, what to change.',
    `## Diff\n\`\`\`diff\n${clipped}\n\`\`\``,
    '## Required before your verdict: test it, do not only read it\n' +
    '1. Run the project\'s tests that cover this change (its own commands: package.json scripts, CLAUDE.md, Makefile, …) and its build or type check if it has one. ' +
    'A failing test or build is an issue. If the project has no tests or build at all, say so in "tested".\n' +
    (test.adb?.devices.length
      ? `2. An Android device/emulator is connected (${test.adb.devices.join(', ')}). If the change touches anything a user sees, open the app on it with adb, ` +
        `then capture the screen with exactly: \`node ${q(test.cli!)} screenshot ${q(test.shots + '/<name>.png')}\`. Then Read each PNG and judge the UI from it.\n`
      : '2. No Android device is connected, so no adb screenshots.\n') +
    `3. For a web UI with a running dev server and Playwright installed: \`npx playwright screenshot <url> ${test.shots}/<name>.png\`, then Read the PNG.\n` +
    `Save screenshots only in ${test.shots}. List every command you ran in "tested".\n` +
    'Run each command on its own, as written: no `cd`, `&&`, `;`, pipes or redirects (only single commands are approved here). ' +
    'Every command must finish by itself within a few minutes: never start a dev server, a watch mode or anything interactive (use flags like --run, --watchAll=false, CI=1).',
    'You run unattended: do not ask questions, do not edit or write project files.',
    'End your final message with exactly one ```json block:\n```json\n{"pass": true, "issues": [], "risk": "minor", "tested": ["npm test"]}\n```\n' +
    'A failing verdict must list issues. Use risk "critical" for security-sensitive code, migrations, public API or config changes, or anything you are unsure is safe to merge.',
  ].filter(Boolean).join('\n\n');
}

export function parseVerdict(text: string): Verdict {
  const raw = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop()?.[1] ?? /\{[\s\S]*"pass"[\s\S]*\}/.exec(text)?.[0];
  if (!raw) throw new Error('no JSON verdict in the reviewer reply');
  const v = JSON.parse(raw);
  if (typeof v.pass !== 'boolean') throw new Error('verdict has no "pass"');
  const issues = Array.isArray(v.issues) ? v.issues.map((i: any) => typeof i === 'string' ? i : JSON.stringify(i)) : [];
  if (!v.pass && !issues.length) throw new Error('failing verdict without issues');
  return { pass: v.pass, issues, risk: v.risk === 'critical' ? 'critical' : 'minor', tested: Array.isArray(v.tested) ? v.tested.map(String) : [] };
}

export interface HeadlessOpts { bin: string; cwd: string; env: Record<string, string>; model?: string; agent?: string; signal: AbortSignal; timeoutMs: number; onRate?: (info: any) => void }

// One unattended turn through the SDK: never asks (dontAsk denies anything not allowed), stops at the timeout or
// when `signal` aborts, and returns Claude's final reply.
async function headless(prompt: string, o: HeadlessOpts, extra: Record<string, unknown>): Promise<string> {
  const { query } = await sdk();
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, o.timeoutMs);
  let result: any;
  try {
    for await (const m of query({ prompt, options: {
      cwd: o.cwd, pathToClaudeCodeExecutable: o.bin, env: o.env, abortController: ac, settingSources: ['user', 'project', 'local'],
      persistSession: false, ...(o.model ? { model: o.model } : {}), ...(o.agent ? { agent: o.agent } : {}), ...extra,
    } as any })) {
      if (m.type === 'rate_limit_event') o.onRate?.((m as any).rate_limit_info);
      if (m.type === 'result') result = m;
    }
  } catch (e: any) {
    if (ac.signal.aborted) throw new Error(o.signal.aborted ? 'cancelled' : `stopped after ${Math.round(o.timeoutMs / 60000)} minutes`);
    throw e;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', stop);
  }
  if (!result) throw new Error('Claude ended without a reply');
  if (result.subtype !== 'success' || result.is_error) throw new Error(String(result.errors?.join('; ') || result.result || result.subtype));
  return String(result.result ?? '');
}

export async function runReview(prompt: string, o: HeadlessOpts & { shots: string; extra?: string[]; adbBin?: string; cli?: string }): Promise<Verdict> {
  const allow = ['Read', 'Grep', 'Glob', ...[...REVIEW_COMMANDS, ...(o.extra ?? []), ...(o.adbBin ? [o.adbBin] : []), ...(o.cli ? [`node ${q(o.cli)} screenshot`] : [])].map(c => `Bash(${c}:*)`)];
  // Test runners run once instead of watching (CI), and no single command can hold the review for long.
  o = { ...o, env: { ...o.env, CI: 'true', BASH_DEFAULT_TIMEOUT_MS: '180000', BASH_MAX_TIMEOUT_MS: '300000' } };
  const text = await headless(prompt, o, {
    permissionMode: 'dontAsk', allowedTools: allow, disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'], additionalDirectories: [o.shots],
  });
  return parseVerdict(text);
}

export interface PlannedTask { title: string; description?: string }

// Read-only planning run: Claude reads the code and answers with a JSON task list.
export async function plan(goal: string, o: HeadlessOpts): Promise<PlannedTask[]> {
  const prompt = `Plan the work for this goal in the current codebase:\n\n${goal}\n\n` +
    'Read the code you need first. Split the work into small tasks that can each be built, reviewed and merged on their own, in build order, at most 12. ' +
    'Reply with ONLY a JSON array, no prose: [{"title": "...", "description": "what to change, where, and how to verify"}]';
  const text = await headless(prompt, o, { permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)'], disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] });
  try {
    const arr = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '[]');
    return arr.filter((t: any) => t && typeof t.title === 'string').map((t: any) => ({ title: t.title.trim(), description: typeof t.description === 'string' ? t.description.trim() : undefined }));
  } catch { throw new Error('Claude did not return a task list. Try a more specific goal.'); }
}

/* ---------- setup checks ---------- */

const run = (bin: string, args: string[], cwd?: string, env?: Record<string, string>) => new Promise<{ ok: boolean; out: string }>(res => {
  execFile(bin, args, { cwd, env, timeout: 15000, maxBuffer: 1024 * 1024, shell: WIN && /\.cmd$/i.test(bin) }, (e, stdout, stderr) =>
    res({ ok: !e, out: String(stdout || stderr || e?.message || '').trim() }));
});

export async function claudeVersion(bin: string) {
  const r = await run(bin, ['--version']);
  return r.ok ? /(\d+\.\d+\.\d+)/.exec(r.out)?.[1] : undefined;
}

export async function claudeAuth(bin: string, env: Record<string, string>): Promise<{ loggedIn: boolean; method?: string; email?: string }> {
  const r = await run(bin, ['auth', 'status'], undefined, env);
  try {
    const j = JSON.parse(r.out);
    return { loggedIn: !!j.loggedIn, method: j.authMethod, email: j.email };
  } catch { return { loggedIn: r.ok, method: undefined }; }
}

export const gitVersion = async () => { const r = await run('git', ['--version']); return r.ok ? r.out.replace(/^git version\s*/, '') : undefined; };
export const gitIdentity = async (cwd?: string) => {
  const [n, e] = await Promise.all([run('git', ['config', 'user.name'], cwd), run('git', ['config', 'user.email'], cwd)]);
  return n.ok && e.ok && n.out && e.out ? `${n.out} <${e.out}>` : undefined;
};
