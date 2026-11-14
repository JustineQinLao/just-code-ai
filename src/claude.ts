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
  const seenP = new Set<string>();
  const project = [...readAgents(path.join(root, '.justcode', 'plugin', 'agents'), 'project'), ...readAgents(path.join(root, '.claude', 'agents'), 'project')].filter(a => !seenP.has(a.name) && (seenP.add(a.name), true));
  const names = new Set(project.map(a => a.name));
  return [...project, ...readAgents(path.join(os.homedir(), '.claude', 'agents'), 'user').filter(a => !names.has(a.name))];
}

// Skills (<name>/SKILL.md) and commands (<name>.md) a task can actually use, offered as chips to drop into a task.
// Tasks load only the project's Claude setup unless personal setup is on, so your ~/.claude skills are listed only
// then. Skills hidden from the / menu (user-invocable: false) and JustCode's own setup skill are left out.
export interface SkillDef { name: string; description: string; scope: 'project' | 'user' }
export function discoverSkills(root: string, personal: boolean): SkillDef[] {
  const read = (base: string, scope: SkillDef['scope']): SkillDef[] => {
    const out: SkillDef[] = [];
    const skills = path.join(base, '.claude', 'skills'), commands = path.join(base, '.claude', 'commands');
    try {
      for (const d of fs.readdirSync(skills, { withFileTypes: true })) {
        const file = path.join(skills, d.name, 'SKILL.md');
        if (!d.isDirectory() || !fs.existsSync(file)) continue;
        const fm = frontmatter(fs.readFileSync(file, 'utf8'));
        if (fm['user-invocable'] === 'false') continue;
        out.push({ name: fm.name || d.name, description: fm.description ?? '', scope });
      }
    } catch { /* none */ }
    try {
      for (const d of fs.readdirSync(commands, { withFileTypes: true })) {
        if (!d.isFile() || !d.name.endsWith('.md')) continue;
        out.push({ name: d.name.slice(0, -3), description: frontmatter(fs.readFileSync(path.join(commands, d.name), 'utf8')).description ?? '', scope });
      }
    } catch { /* none */ }
    return out;
  };
  const all = [...read(root, 'project'), ...(personal ? read(os.homedir(), 'user') : [])];
  const seen = new Set<string>();
  return all.filter(k => !/^lex-?code|^just-code-setup$/i.test(k.name) && !seen.has(k.name) && (seen.add(k.name), true));
}

// Everything a session here can run with /: built-in commands, bundled skills, plugins, project and (with personal
// setup) your own skills. Asks the CLI itself; no prompt is sent, so it costs no tokens.
export function usableCommands(all: { name: string; description?: string }[]) {
  return all.filter(c => !/^__|^lex-?code|^just-code-setup$/i.test(c.name)).map(c => ({ name: c.name, description: c.description ?? '' }));
}
export async function slashCommands(o: { bin: string; cwd: string; env: Record<string, string | undefined>; personal: boolean; plugins?: string[] }) {
  const { query } = await sdk();
  async function* never(): AsyncGenerator<never> { await new Promise(() => {}); }
  const q = query({ prompt: never(), options: { cwd: o.cwd, pathToClaudeCodeExecutable: o.bin, env: o.env, settingSources: settingSources(o.personal), ...(o.plugins?.length ? { plugins: o.plugins.map(p => ({ type: 'local' as const, path: p })) } : {}) } });
  try {
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('timed out')), 15_000).unref());
    return usableCommands(await Promise.race([q.supportedCommands(), timeout]));
  } finally { q.close(); }
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
  const local = path.join(root, '.claude', 'settings.local.json');
  if (fs.existsSync(local) && !fs.existsSync(path.join(worktree, '.claude', 'settings.local.json'))) out.settingsFile = local;
  return out;
}

// The task as the first message: its brief (see artifacts.ts) plus where it runs.
export function taskPrompt(t: Task, brief: string) {
  return [brief,
    t.where !== 'direct' && 'You work in this task\'s own copy of the project (a git worktree on its own branch). Stay inside the current directory. ' +
      'JustCode commits your changes when you finish; do not commit or push yourself.']
    .filter(Boolean).join('\n\n');
}

// Appended to Claude Code's own system prompt for every task. Identical for all tasks and projects, so it stays in
// the cached prefix; anything task-specific goes in the first message.
export const TASK_APPEND = `You are running as a JustCode task: one focused change, built, verified, then reviewed by another agent.
Work efficiently: read only the files the task needs, prefer Grep/Glob over broad directory reads, and do not re-read files you already have.
Keep command output small: run the tests that cover your change rather than the whole suite when it is large, use quiet or failure-only reporters
(e.g. --silent, -q, --reporter=dot), and never start dev servers, watch modes or interactive commands.
If the task has a "Done when" list, meet every item: the reviewer checks each one.
When a turn ends, update the handoff file named in your brief with what changed and how you verified it (each "Done when" item, if any).
If the superpowers plugin is loaded, follow its test-driven-development and verification-before-completion skills.`;

// Which Claude settings a session loads. Lean (default): the project's own (.claude/, CLAUDE.md, settings.local.json),
// not your personal plugins, skills, memory and MCP servers, which add ~7k tokens to every request. Your personal
// allow rules are still applied (userAllowRules).
// Commits and PRs made in JustCode sessions carry no Claude co-author trailer or "Generated with" line. Flag
// settings win over the user's and the project's, so this holds whatever their settings say. `file`: project
// settings a task's copy lacks (see carryOver), merged in.
export const NO_ATTRIBUTION = { commit: '', pr: '' };
export function sessionSettings(file?: string): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (file) try { base = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* unreadable: attribution only */ }
  return { ...base, attribution: NO_ATTRIBUTION };
}

export const settingSources = (personal: boolean) => (personal ? ['user', 'project', 'local'] : ['project', 'local']) as ('user' | 'project' | 'local')[];

export function userAllowRules(): string[] {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json'), 'utf8'));
    return Array.isArray(s?.permissions?.allow) ? s.permissions.allow.filter((r: unknown) => typeof r === 'string') : [];
  } catch { return []; }
}

// Same system prompt in every task folder (per-session details move into the first message), so parallel and
// consecutive tasks reuse each other's prompt cache.
export const systemPrompt = (append?: string) => ({ type: 'preset' as const, preset: 'claude_code' as const, excludeDynamicSections: true, ...(append ? { append } : {}) });

// Command output is capped (Claude Code's default is 30k characters per command); long test logs are the largest
// avoidable input in a task.
export const OUTPUT_CAPS = { BASH_MAX_OUTPUT_LENGTH: '20000' };

// Claude Code stores sessions in ~/.claude/projects/<cwd with non-alphanumerics → '-'>/<id>.jsonl
export const transcript = (cwd: string, id: string) =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
export const sessionExists = (cwd: string, id: string) => fs.existsSync(transcript(cwd, id));

// The first claude.ai artifact link in a session's transcript (the publish step's result), if any.
export const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;
export function artifactUrlIn(cwd: string, id: string) {
  try { return ARTIFACT_URL.exec(fs.readFileSync(transcript(cwd, id), 'utf8'))?.[0]; } catch { return undefined; }
}

// Plugins Claude Code has installed (plugins/installed_plugins.json): name (without @marketplace) → install path.
// With several scopes the user scope wins; entries whose folder is missing are ignored (`need`: a subfolder that must exist, e.g. 'skills').
const pluginsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json');
export function installedPlugins(file = pluginsFile(), need?: string): Record<string, string> {
  const found: Record<string, string> = {};
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf8'))?.plugins ?? {};
    const ok = (e: { installPath?: string }) => !!e.installPath && fs.existsSync(need ? path.join(e.installPath, need) : e.installPath);
    for (const [key, list] of Object.entries<{ scope?: string; installPath?: string }[]>(all)) {
      const entries = Array.isArray(list) ? list : [];
      const hit = entries.find(e => e.scope === 'user' && ok(e)) ?? entries.find(ok);
      const name = key.split('@')[0];
      if (hit?.installPath && !(name in found)) found[name] = hit.installPath;
    }
  } catch { /* no plugins file */ }
  return found;
}
// One installed plugin's folder, e.g. installedPlugin('frontend-design'). Lean task sessions do not load your plugins,
// so artifact tasks are given the design plugin by path.
export const installedPlugin = (name: string, file?: string, need?: string) => installedPlugins(file, need)[name];

// What an artifact task is told: build one page with the design skill, in the shape claude.ai artifacts accept.
export function artifactBrief(file: string, design: boolean, update?: { url: string; title?: string; file?: string }) {
  return [`## Result: a page, published as a claude.ai artifact`,
    `This task's result is one web page, not a code change. Write it as a single self-contained HTML file at ${file} (create or overwrite it).`,
    update ? `This task updates the existing artifact "${update.title ?? update.url}" (${update.url}): JustCode republishes it to the same link.${update.file ? ` Start from its current page, ${update.file} (copy it to the file above, then change it).` : ''}` : '',
    design ? 'Use the frontend-design skill (/frontend-design:frontend-design) for the visual design: a deliberate palette, typography and layout, not a generic template.' :
      'Give it a deliberate visual design: a clear palette, typography and layout, not a generic template.',
    'The page must follow the artifact rules: a <title> of two to four words; all CSS and JavaScript inline; images as inline SVG or data URIs; ' +
      'scripts only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm, unpkg.com, cdn.tailwindcss.com or code.jquery.com with an exact version; fonts only from Google Fonts; ' +
      'no fetch to other hosts; no relative links; colors as CSS variables with a dark mode (prefers-color-scheme); works at phone width; under 16 MB.',
    'Build the content from the project and the task (read the code or data you need). Do not publish it yourself: when you finish, JustCode publishes the file and puts the link on the card. ' +
      'If the user asks for changes later, edit the same file.'].filter(Boolean).join('\n');
}
export const sessionSize = (cwd: string, id: string) => { try { return fs.statSync(transcript(cwd, id)).size; } catch { return 0; } };

export interface LogStep { kind: 'user' | 'say' | 'tool' | 'result' | 'error' | 'info'; text: string; time?: string }

// A finished session's saved transcript as readable steps (main thread only), for a card whose session has closed.
// Reads the last 4 MB.
export function sessionLog(cwd: string, sessionId: string): LogStep[] {
  return logOf(transcript(cwd, sessionId), false);
}
// The same from a task's archived transcript (.justcode/tasks/<id>/transcript.jsonl), once its session store is gone.
export const archivedLog = (file: string) => logOf(file, false);

// Subagents' transcripts sit next to the session's: <session>/subagents/agent-<id>.jsonl, with a .meta.json each.
export interface SavedAgent { id: string; toolUseId?: string; name: string; description: string; finished: boolean }
const subagentDir = (cwd: string, sessionId: string) => transcript(cwd, sessionId).replace(/\.jsonl$/, '') + path.sep + 'subagents';
export function savedAgents(cwd: string, sessionId: string): SavedAgent[] {
  const dir = subagentDir(cwd, sessionId);
  let names: string[];
  try { names = fs.readdirSync(dir).filter(f => /^agent-[\w-]+\.meta\.json$/.test(f)); } catch { return []; }
  return names.map(f => {
    let m: any = {};
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* no details */ }
    return { id: f.slice(6, -10), toolUseId: m.toolUseId, name: m.agentType || 'agent', description: m.description ?? '', finished: !!m.finished };
  });
}
// One subagent's conversation, the model it ran on, its final answer, and how long and how many tokens it took.
export function agentLog(cwd: string, sessionId: string, agentId: string) {
  if (!/^[\w-]+$/.test(agentId)) return;
  const file = path.join(subagentDir(cwd, sessionId), `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) return;
  const steps = logOf(file, true);
  let model = '', result = '', tokens = 0, first = '', last = '';
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (typeof r.timestamp === 'string') { first ||= r.timestamp; last = r.timestamp; }
      if (r.type !== 'assistant') continue;
      if (typeof r.message?.model === 'string' && !r.message.model.startsWith('<')) model = r.message.model;
      const u = r.message?.usage;
      if (u) tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      const text = (Array.isArray(r.message?.content) ? r.message.content : []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n').trim();
      if (text) result = text;
    }
  } catch { /* partial */ }
  return { steps, model, result, tokens, ms: first && last ? Date.parse(last) - Date.parse(first) : 0 };
}

function logOf(file: string, sidechain: boolean): LogStep[] {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
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
  let model = '';
  for (const line of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if ((r.isSidechain && !sidechain) || r.isMeta || (r.type !== 'assistant' && r.type !== 'user')) continue;
    const time = typeof r.timestamp === 'string' ? r.timestamp : undefined;
    // Which model answered: noted where it is first known and wherever it changes.
    const m = r.type === 'assistant' ? r.message?.model : undefined;
    if (typeof m === 'string' && m !== model && !m.startsWith('<')) { model = m; steps.push({ kind: 'info', text: `Model: ${m}`, time }); }
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

// Headless Playwright MCP for UI work: the only way to take screenshots, saved into the task's shots folder.
// Pinned version; flags checked against `npx @playwright/mcp@0.0.85 --help`: --headless, --isolated, --output-dir.
// The server-level rule allows all of the server's tools.
export const PLAYWRIGHT_TOOLS = 'mcp__playwright';
export const playwrightMcp = (shots: string) => ({ playwright: { type: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp@0.0.85', '--headless', '--isolated', '--output-dir', shots] } });
export const SHOT_RULE = (shots: string) => `Take screenshots only with the Playwright MCP tool browser_take_screenshot (headless); always pass filename as the absolute path "${shots}/<name>.png" (a bare name lands in the project folder). If the browser is missing, call browser_install once and retry. Never use npx playwright, a screenshot script or a visible browser.`;

// Tool options for a UI session or review: the MCP server and its allow rule are added together, or not at all.
export function webOptions(on: boolean, shots: string, allowed: string[]) {
  return on ? { allowed: [PLAYWRIGHT_TOOLS, ...allowed], mcpServers: playwrightMcp(shots) } : { allowed, mcpServers: undefined };
}

// Commands the reviewer may run: read git, run tests and builds, adb, screenshots. Edits stay blocked.
export const REVIEW_COMMANDS = ['git diff', 'git log', 'git show', 'git status', 'ls', 'cat',
  'npm test', 'npm run', 'npx tsc', 'npx jest', 'npx vitest', 'npx eslint', 'npx ng test',
  'yarn test', 'yarn run', 'yarn build', 'yarn lint', 'pnpm test', 'pnpm run', 'pnpm build', 'pnpm lint', 'bun test', 'bun run',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'python manage.py test', 'python3 manage.py test', 'ruff', 'mypy',
  'go test', 'go build', 'go vet', 'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'make test', 'make check', 'make build',
  'mvn test', 'mvn -q test', './gradlew', 'gradle test', 'dotnet test', 'dotnet build', 'flutter test', 'dart test', 'swift test', 'xcodebuild test',
  'docker compose exec', 'docker compose run', 'docker compose -p * exec *', 'docker compose -p * run *', 'docker compose -p * ps', 'docker compose -p * logs *', 'adb', 'curl'];

const MAX_DIFF = 150_000;
const q = (p: string) => /\s/.test(p) ? `"${p}"` : p;

// The reviewer's standing instructions: identical for every review, so they stay in the cached system prompt.
export const REVIEW_APPEND = `You are the code reviewer for a JustCode task: another agent built a change on this branch; you decide if it can merge.
You do not change code: never edit or write project files. You run unattended: never ask questions.
If the task has a "Done when" list, check every item; each unmet item is a blocking issue. Judge correctness only: does the change do what the task asks, completely; bugs, unhandled errors, edge cases, regressions in callers;
missing tests for new behaviour; security (validation, authorization, data isolation, injection, secrets). Do not report style or naming.
Report only issues that should block the merge, at most 8, each specific and actionable (file, line, what to change). If the change is sound, pass it.
Report only problems this diff introduces or touches, not older code it leaves alone. A "Done when" item that only a person can check
(a manual run by hand, a device or account you do not have) is not an issue: say in "tested" that it is left for the user.
Never re-report an issue listed under "Accepted by the user". If the builder explained why it left an issue from the previous round,
judge the explanation: drop the issue when the reason is sound.
Verify, do not only read: the builder's handoff lists what it ran. Re-run the tests that cover the changed files (and the build or type check if quick)
to confirm; do not re-run the whole suite unless the change is broad, and do not explore unrelated code.
Run each command on its own, as written: no cd, &&, ;, pipes or redirects. Every command must finish by itself within a few minutes:
never a dev server, watch mode or anything interactive (use flags like --run, --watchAll=false).
Risk "critical" only when merging without a human look could do real harm: authentication or authorization, secrets, payments,
data migrations or deletion, deployment or infrastructure config, breaking a public API. Ordinary code, tests, scripts and build or package
config changes are "minor".
If a command is denied or fails for a setup reason (wrong folder, missing flag), try another allowed form of it (a package script, a path argument) before giving up.
In "tested", list every command you ran (or why nothing could run).`;

// The review's task-specific part: the task, the builder's handoff, how to test the UI, and the diff.
export function reviewPrompt(t: Task, base: string, diff: string, test: { shots: string; adb?: { bin: string; devices: string[] }; cli?: string; web?: boolean; handoff?: string; brief?: string; checks?: string[]; accepted?: string[]; fixNote?: string } = { shots: '' }) {
  const clipped = diff.length <= MAX_DIFF ? diff : `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated; read the changed files for the rest]`;
  return [
    test.brief ? `# Task\n${test.brief}` : `# Task: ${t.title}\n${t.description ?? ''}`,
    test.checks?.length ? `# Checks JustCode already ran on this commit: all pass\n${test.checks.map(c => `- ${c}`).join('\n')}\nDo not re-run them; run only tests they do not cover, if the change needs any.` : '',
    test.handoff ? `# Builder's handoff (its own account: verify it)\n${test.handoff}` : '# Builder\'s handoff\n(none written: find out how it was meant to be verified from the diff)',
    test.adb?.devices.length
      ? `# UI checks\nAn Android device is connected (${test.adb.devices.join(', ')}). If the change touches anything a user sees, open the app with adb, ` +
        `capture the screen with exactly: \`node ${q(test.cli!)} screenshot ${q(test.shots + '/<name>.png')}\`, then Read the PNG.`
      : test.web ? `# UI checks\nFor a web UI with a running dev server: open the page with the Playwright MCP tools, then ${SHOT_RULE(test.shots)} Read the PNG.` : '',
    test.accepted?.length ? `# Accepted by the user (not blocking; do not report again)\n${test.accepted.map(a => `- ${a}`).join('\n')}` : '',
    test.fixNote ? `# The builder's reply to the previous review round\n${test.fixNote}` : '',
    `# Diff against ${base}\n\`\`\`diff\n${clipped}\n\`\`\``,
  ].filter(Boolean).join('\n\n');
}

// The verdict as structured output (schema-checked by Claude Code, no parsing guesswork).
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'issues', 'risk', 'tested'],
  properties: {
    pass: { type: 'boolean' },
    issues: { type: 'array', maxItems: 8, items: { type: 'string' } },
    risk: { type: 'string', enum: ['minor', 'critical'] },
    tested: { type: 'array', items: { type: 'string' } },
  },
};

export function parseVerdict(text: string): Verdict {
  const raw = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop()?.[1] ?? /\{[\s\S]*"pass"[\s\S]*\}/.exec(text)?.[0];
  if (!raw) throw new Error('no JSON verdict in the reviewer reply');
  return toVerdict(JSON.parse(raw));
}

function toVerdict(v: any): Verdict {
  if (typeof v?.pass !== 'boolean') throw new Error('verdict has no "pass"');
  const issues = Array.isArray(v.issues) ? v.issues.map((i: any) => typeof i === 'string' ? i : JSON.stringify(i)) : [];
  if (!v.pass && !issues.length) throw new Error('failing verdict without issues');
  return { pass: v.pass, issues, risk: v.risk === 'critical' ? 'critical' : 'minor', tested: Array.isArray(v.tested) ? v.tested.map(String) : [] };
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export const addUsage = (a: Usage | undefined, u: any): Usage => ({
  input: (a?.input ?? 0) + (u?.input_tokens ?? 0), output: (a?.output ?? 0) + (u?.output_tokens ?? 0),
  cacheRead: (a?.cacheRead ?? 0) + (u?.cache_read_input_tokens ?? 0), cacheWrite: (a?.cacheWrite ?? 0) + (u?.cache_creation_input_tokens ?? 0),
});

export interface HeadlessOpts { bin: string; cwd: string; env: Record<string, string>; model?: string; agent?: string; effort?: string; signal: AbortSignal; timeoutMs: number; personal?: boolean; plugins?: string[]; onRate?: (info: any) => void; mcpServers?: Record<string, unknown> }
interface HeadlessResult { text: string; structured?: unknown; sessionId?: string; usage?: Usage; costUsd: number }

// One unattended turn through the SDK: never asks (dontAsk denies anything not allowed), stops at the timeout or
// when `signal` aborts. `resume` continues an earlier headless session, whose context is still cached.
async function headless(prompt: string, o: HeadlessOpts, extra: Record<string, unknown>): Promise<HeadlessResult> {
  const { query } = await sdk();
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, o.timeoutMs);
  let result: any;
  try {
    for await (const m of query({ prompt, options: {
      cwd: o.cwd, pathToClaudeCodeExecutable: o.bin, env: { ...o.env, ...OUTPUT_CAPS }, abortController: ac, settingSources: settingSources(!!o.personal), settings: sessionSettings() as any,
      ...(o.mcpServers ? { mcpServers: o.mcpServers as any } : {}),
      plugins: (o.plugins ?? [path.join(o.cwd, '.justcode', 'plugin')]).map(p => ({ type: 'local' as const, path: p })),
      ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), ...(o.agent ? { agent: o.agent } : {}), ...extra,
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
  return { text: String(result.result ?? ''), structured: result.structured_output, sessionId: result.session_id, usage: addUsage(undefined, result.usage), costUsd: Number(result.total_cost_usd ?? 0) };
}

export interface ReviewRun { verdict: Verdict; sessionId?: string; usage?: Usage; costUsd?: number }

// resume: continue the same reviewer session (its context is cached) instead of reviewing from scratch.
export async function runReview(prompt: string, o: HeadlessOpts & { shots: string; extra?: string[]; web?: boolean; adbBin?: string; cli?: string; resume?: string }): Promise<ReviewRun> {
  const w = webOptions(!!o.web, o.shots, ['Read', 'Grep', 'Glob', ...[...REVIEW_COMMANDS, ...(o.extra ?? []), ...(o.adbBin ? [o.adbBin] : []), ...(o.cli ? [`node ${q(o.cli)} screenshot`] : [])].map(c => c.includes('*') ? `Bash(${c})` : `Bash(${c}:*)`)]);
  const allow = w.allowed;
  // Test runners run once instead of watching (CI), and no single command can hold the review for long.
  o = { ...o, env: { ...o.env, CI: 'true', BASH_DEFAULT_TIMEOUT_MS: '180000', BASH_MAX_TIMEOUT_MS: '300000' } };
  const base = {
    permissionMode: 'dontAsk' as const, allowedTools: allow, disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'], additionalDirectories: [o.shots],
    systemPrompt: systemPrompt(REVIEW_APPEND), outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA }, maxTurns: 60,
  };
  o = { ...o, mcpServers: w.mcpServers };
  let r = await headless(prompt, o, { ...base, ...(o.resume ? { resume: o.resume } : {}) });
  let usage = r.usage, sessionId = r.sessionId, costUsd = r.costUsd;
  const read = (x: typeof r) => x.structured !== undefined ? toVerdict(x.structured) : parseVerdict(x.text);
  // The reviewer sometimes ends without a clean verdict (it wrote prose, or the JSON was malformed). Rather than fail
  // the whole review, ask the same session (its context is cached, so this is cheap) for just the verdict, twice.
  for (let i = 0; ; i++) {
    try { return { verdict: read(r), sessionId, usage, costUsd }; }
    catch (e) {
      if (i >= 2 || !sessionId) throw e;
      r = await headless('Reply with ONLY the JSON verdict, nothing else: {"pass": <true|false>, "issues": [<strings>], "risk": "minor"|"critical", "tested": [<commands you ran>]}. A failing verdict must list at least one issue.',
        o, { ...base, resume: sessionId });
      usage = addUsage(usage, { input_tokens: r.usage?.input, output_tokens: r.usage?.output, cache_read_input_tokens: r.usage?.cacheRead, cache_creation_input_tokens: r.usage?.cacheWrite });
      sessionId = r.sessionId ?? sessionId;
      costUsd += r.costUsd;
    }
  }
}

export interface PlannedTask { title: string; description?: string }

// Read-only planning run: Claude reads the code and answers with a JSON task list.
export async function plan(goal: string, o: HeadlessOpts): Promise<PlannedTask[]> {
  const prompt = `Plan the work for this goal in the current codebase:\n\n${goal}\n\n` +
    'Read the code you need first. Split the work into small tasks that can each be built, reviewed and merged on their own, in build order, at most 12. ' +
    'Reply with ONLY a JSON array, no prose: [{"title": "...", "description": "what to change, where, and how to verify"}]';
  const { text } = await headless(prompt, o, { permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)'], disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'],
    systemPrompt: systemPrompt(), persistSession: false });
  try {
    const arr = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '[]');
    return arr.filter((t: any) => t && typeof t.title === 'string').map((t: any) => ({ title: t.title.trim(), description: typeof t.description === 'string' ? t.description.trim() : undefined }));
  } catch { throw new Error('Claude did not return a task list. Try a more specific goal.'); }
}

// Refines existing To do tasks with an instruction: Claude reads the code read-only and returns the task list it
// proposes. Each item keeps `ref` (an existing task's id) when it is that task reworded, or omits it for a new task.
// An existing id in none of the items is proposed for removal. This covers edit, split, merge, reorder and add.
export interface RefineResult { ref?: string; title: string; description?: string; sprint?: string; after?: string[] }
export async function refine(tasks: { id: string; title: string; description?: string }[], instruction: string, o: HeadlessOpts): Promise<RefineResult[]> {
  const prompt = `These are the To do tasks on a board (id, title, details). Rework them following the instruction, using the codebase to make them accurate.\n\n` +
    `## Current tasks\n${tasks.map(t => `[${t.id}] ${t.title}${t.description ? `\n    ${t.description.replace(/\n/g, '\n    ')}` : ''}`).join('\n')}\n\n` +
    `## Instruction\n${instruction}\n\n` +
    'Read the code you need first. Return the full list you propose, in build order. For a task that is an existing one reworded, keep its id in "ref"; ' +
    'to split one task, keep its id on one item and leave "ref" off the other(s); to merge, keep one id and drop the rest; leave "ref" off a brand-new task. ' +
    'Omit a task entirely to propose removing it. Keep each title short and each description to what to change, where, and how to verify. ' +
    'Reply with ONLY a JSON array, no prose: [{"ref": "<id or omit>", "title": "...", "description": "..."}]';
  const { text } = await headless(prompt, o, { permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)'], disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'],
    systemPrompt: systemPrompt(), persistSession: false });
  try {
    const ids = new Set(tasks.map(t => t.id));
    const arr = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '[]');
    return arr.filter((t: any) => t && typeof t.title === 'string').map((t: any) => ({
      ref: typeof t.ref === 'string' && ids.has(t.ref) ? t.ref : undefined,
      title: t.title.trim(), description: typeof t.description === 'string' ? t.description.trim() || undefined : undefined,
    }));
  } catch { throw new Error('Claude did not return a task list. Try a clearer instruction.'); }
}

// The planner/editor is a chat: you talk with Claude, it reads the code read-only, and it keeps a proposed To do
// list that you apply when ready. This append (identical every turn, so it stays cached) tells it to end each turn
// with that list as a JSON block, which parseProposals reads.
export const PLANNER_APPEND = `You are planning tasks for a kanban board where each task is built by Claude on its own branch, checked by an AI reviewer, then merged. You never change code: this is a read-only planning chat. Write, Edit and plan files are not available: never try them, and never write a plan to a file. Your plan is your chat reply, ending with the tasks block below.

How to plan:
1. If the goal is vague (no clear outcome, scope or way to check it), first ask 2-4 short multiple-choice questions with AskUserQuestion. Do not ask what the code already answers.
2. Read only the code you need (Grep/Glob first). Name real files. If the superpowers plugin is loaded, use its brainstorming and writing-plans skills before proposing tasks.
3. Make each task one change that can be built, reviewed and merged on its own, in build order. Prefer 3-8 tasks. Split anything bigger than about a day of work.
4. Group tasks into sprints when there are more than about 5, each sprint with a one-line goal. Reuse the board's open sprint names when they fit.
5. Build order: foundations first (models, tokens, shared components, layout), features next, and tasks that verify or document the whole (captures, PDFs, e2e reports) last. A task never depends on a later one. If the project has a plan-tasks skill, follow it.
6. When a source is a design (a saved design canvas folder with project/canvas.json, mockups, screenshots), open it before proposing UI tasks. Give each UI task the exact screen files it must match in "files" (e.g. ".justcode/sources/<id>/project/Staff-Floor.dc.html") and in "done" a check that the built screen has the same sections, labels, order and styling as that file, shown by a screenshot at the design's width.

After every turn, end your message with the FULL proposed To do list as one JSON block:
\`\`\`tasks
[{"ref": "<existing task id, or omit for a new task>", "title": "short imperative title", "goal": "the outcome in one sentence", "files": ["path/likely/changed.ts"], "done": ["a check the reviewer can verify", "the test or command that must pass"], "sprint": "Sprint 1: <goal>"}]
\`\`\`
Add "after": ["<title of an earlier task in this list or on the board>"] when a task cannot start before another is done (Run all waits for it); omit it otherwise.
Every task needs a goal and 1-4 "done" items that are concrete and testable (not "works well"). "files" are your best guess. Omit "sprint" for backlog tasks.
Keep an existing task's id in "ref" when your item is that task reworded; omit "ref" for a new task; drop a task entirely to propose removing it. Always include the whole list, not only what changed. Keep the prose before the block short.
Started and done tasks (listed separately, when there are any) are never removed. Check each against the request and the code: include one, with its id in "ref" and the updated text, only when it must change. A done one then goes back to To do and is built again on top of its merged work; a working or in-review one gets the change as a message. Leave out the ones that are fine.`;

// The first message: the board's sprints, the To do tasks being edited (if any), and the user's request.
// With `sprint`, the tasks are every not-started task of that sprint and the instruction applies to all of them.
export function plannerFirst(tasks: { id: string; title: string; description?: string }[], instruction: string, sprints: { name: string; goal?: string }[] = [], sprint?: { name: string; goal?: string },
  others: { id: string; title: string; description?: string; status: string }[] = [], into?: string) {
  const target = into && !sprint ? `## Target sprint\nI am planning in ${into}: set "sprint" to "${into}" on every new task. Do not create other sprints unless I ask for them.\n\n` : '';
  const sp = sprints.length ? `## Open sprints\n${sprints.map(s => `- ${s.name}${s.goal ? `: ${s.goal}` : ''}`).join('\n')}\n\n` : '';
  const scope = sprint ? `## Scope\nEdit all the tasks below: they are every not-started task of ${sprint.name}${sprint.goal ? ` (goal: ${sprint.goal})` : ''}. ` +
    `Apply my instruction to each of them, keep them in this sprint (set "sprint" to "${sprint.name}" on every item), and return the whole sprint list.\n\n` : '';
  const list = tasks.length ? `${scope}## Current To do tasks\n${tasks.map(t => `[${t.id}] ${t.title}${t.description ? `\n    ${t.description.replace(/\n/g, '\n    ')}` : ''}`).join('\n')}\n\n` : '';
  const state = (s: string) => ({ done: 'done, merged', review: 'in review', doing: 'working' } as Record<string, string>)[s] ?? s;
  const started = others.length ? `## Started and done tasks${sprint ? ` in ${sprint.name}` : ''}\nCheck each one; include it only if it must change (see the rules).\n` +
    `${others.map(t => `[${t.id}] (${state(t.status)}) ${t.title}${t.description ? `\n    ${t.description.replace(/\n/g, '\n    ')}` : ''}`).join('\n')}\n\n` : '';
  return `${sp}${target}${list}${started}## What I want\n${instruction}\n\nRead what you need (or ask me first if the goal is unclear), then reply with your thoughts and the proposed task list.`;
}

// A task's details as stored on the board: the reviewer checks the work against "Done when".
export function taskText(t: { goal?: string; files?: string[]; done?: string[]; description?: string }) {
  const parts = [t.goal?.trim() && `Goal: ${t.goal.trim()}`, t.files?.length && `Files: ${t.files.join(', ')}`,
    t.done?.length && `Done when:\n${t.done.map(d => `- ${d}`).join('\n')}`, t.description?.trim()].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [];

export function parseProposals(text: string, taskIds: Set<string>): RefineResult[] | undefined {
  const block = [...text.matchAll(/```tasks\s*([\s\S]*?)```/g)].pop()?.[1] ?? [...text.matchAll(/```json\s*(\[[\s\S]*?\])\s*```/g)].pop()?.[1] ?? /\[\s*\{[\s\S]*"title"[\s\S]*\}\s*\]/.exec(text)?.[0];
  if (!block) return;
  try {
    const arr = JSON.parse(block);
    if (!Array.isArray(arr)) return;
    return arr.filter((t: any) => t && typeof t.title === 'string').map((t: any) => ({
      ref: typeof t.ref === 'string' && taskIds.has(t.ref) ? t.ref : undefined,
      title: t.title.trim(),
      description: taskText({ goal: typeof t.goal === 'string' ? t.goal : undefined, files: strs(t.files), done: strs(t.done), description: typeof t.description === 'string' ? t.description : undefined }),
      sprint: typeof t.sprint === 'string' && t.sprint.trim() ? t.sprint.trim() : undefined,
      ...(strs(t.after).length ? { after: strs(t.after) } : {}),
    }));
  } catch { return; }
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
