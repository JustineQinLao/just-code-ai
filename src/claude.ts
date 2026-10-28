import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Task } from './store';

export interface AgentDef { name: string; description: string; model?: string; tools?: string; file: string; scope: 'project' | 'user' }

// GUI-launched editors often lack the shell PATH, so look in the usual install spots too.
export function claudeBin(setting: string) {
  if (setting) return setting;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map(d => path.join(d, 'claude')).find(f => fs.existsSync(f)) ?? 'claude';
}

// Markers a parent Claude session leaves in the environment (e.g. VS Code started from Claude). Inherited, they make
// a task's session a "child" that doesn't save its transcript, so Resume would find nothing.
const INHERITED = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

export const ptyEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.includes(k))) as Record<string, string>,
  PATH: [process.env.PATH, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter),
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
});

// Flat `key: value` frontmatter; all Claude Code agent files use for these fields.
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

// Skills (<name>/SKILL.md) and commands (<name>.md), project then user; shown so they can be dropped into a prompt.
export function discoverSkills(root: string): string[] {
  const names = (dir: string, skills: boolean) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => skills
        ? d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')) ? [d.name] : []
        : d.isFile() && d.name.endsWith('.md') ? [d.name.slice(0, -3)] : []);
    } catch { return []; }
  };
  return [...new Set([root, os.homedir()].flatMap(r => [...names(path.join(r, '.claude', 'skills'), true), ...names(path.join(r, '.claude', 'commands'), false)]))];
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Hooks report the session's state to JustCode by appending a line to `statusFile`:
// stop = turn finished, run = working again, tool<TAB>json = about to use a tool,
// wait<TAB>json = asking for permission (for the tool reported just before).
function hooks(statusFile: string) {
  const say = (w: string) => [{ hooks: [{ type: 'command', command: `printf '${w}\\n' >> ${sh(statusFile)}` }] }];
  // The hook's JSON input, flattened to one line.
  const sayJson = (w: string) => [{ hooks: [{ type: 'command', command: `{ printf '${w}\\t'; tr -d '\\n'; printf '\\n'; } >> ${sh(statusFile)}` }] }];
  return {
    Stop: say('stop'),
    Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: sayJson('wait')[0].hooks }],
    PreToolUse: sayJson('tool'),
    UserPromptSubmit: say('run'),
    PostToolUse: say('run'),
  };
}

// A worktree only has committed files. Uncommitted project agents and settings are passed on the command line
// instead of copied in, so the auto-commit can never pick them up.
function carryOver(root: string, worktree: string, statusFile: string): string[] {
  const out: string[] = [];
  const have = new Set(readAgents(path.join(worktree, '.claude', 'agents'), 'project').map(a => a.name));
  const missing = readAgents(path.join(root, '.claude', 'agents'), 'project').filter(a => !have.has(a.name));
  if (missing.length) {
    out.push('--agents', JSON.stringify(Object.fromEntries(missing.map(a => [a.name, {
      description: a.description, prompt: fs.readFileSync(a.file, 'utf8').replace(/^---[\s\S]*?---\s*/, ''),
      ...(a.tools && { tools: a.tools.split(',').map(t => t.trim()).filter(Boolean) }), ...(a.model && { model: a.model }),
    }]))));
  }
  // Uncommitted skills: --add-dir loads .claude/skills from the main folder.
  if (fs.existsSync(path.join(root, '.claude', 'skills')) && !fs.existsSync(path.join(worktree, '.claude', 'skills'))) out.push('--add-dir', root);
  let settings: Record<string, any> = {};
  for (const f of ['settings.json', 'settings.local.json']) {
    if (fs.existsSync(path.join(worktree, '.claude', f))) continue;
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(path.join(root, '.claude', f), 'utf8')) }; } catch { /* absent or invalid */ }
  }
  // Hooks from every settings source run together, so ours never replace the project's.
  const ours = hooks(statusFile);
  const merged: Record<string, any[]> = { ...(settings.hooks ?? {}) };
  for (const [k, v] of Object.entries(ours)) merged[k] = [...(merged[k] ?? []), ...v];
  out.push('--settings', JSON.stringify({ ...settings, hooks: merged }));
  return out;
}

export function taskPrompt(t: Task) {
  return [t.title, t.description?.trim() === t.title.trim() ? undefined : t.description,
    t.images?.length && `Screenshots for this task (read them first):\n${t.images.map(f => `- ${f}`).join('\n')}`,
    t.where !== 'root' && 'Work only inside the current directory (this task\'s git worktree). JustCode commits your changes when you finish; do not push.']
    .filter(Boolean).join('\n\n');
}

// argv for the task's interactive session. resume: the session already exists (continue it, optionally with `prompt`).
export function sessionArgs(o: { task: Task; root: string; worktree: string; statusFile: string; resume: boolean; prompt?: string; model?: string }) {
  const { task } = o;
  const prompt = o.prompt ?? (o.resume ? undefined : taskPrompt(task));
  return [
    '--permission-mode', task.mode,
    ...(o.model ? ['--model', o.model] : []),
    ...(task.agent ? ['--agent', task.agent] : []),
    ...(task.allow?.length ? ['--allowedTools', ...task.allow] : []),
    ...carryOver(o.root, o.worktree, o.statusFile),
    ...(task.images?.length ? ['--add-dir', path.dirname(task.images[0])] : []), // attachments sit outside the worktree
    ...(o.resume ? ['--resume', task.sessionId!] : ['--session-id', task.sessionId!]),
    ...(prompt ? [prompt] : []),
  ];
}

// Claude Code stores sessions in ~/.claude/projects/<cwd with non-alphanumerics → '-'>/<id>.jsonl
export const sessionExists = (cwd: string, id: string) =>
  fs.existsSync(path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl'));

export interface Step { kind: 'user' | 'say' | 'tool' | 'result' | 'error'; text: string; time?: string }

// The tool call's main argument, as Claude Code shows it: Bash(npm test), Read(src/a.ts).
const toolArg = (input: any) => {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.description ?? input.prompt
    ?? Object.values(input).find(x => typeof x === 'string');
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 300) : '';
};
const resultText = (c: any) => {
  const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
  const lines = t.split('\n').filter((l: string) => l.trim());
  return lines.length > 1 ? `${lines[0].slice(0, 300)}  (+${lines.length - 1} lines)` : lines[0]?.slice(0, 300) ?? '(no output)';
};

// A session's saved transcript as readable steps (main thread only), so a card shows its log after the session
// ended or the window reloaded. Reads the last 4 MB.
export function sessionLog(cwd: string, sessionId: string): Step[] {
  let text: string;
  try {
    const file = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 4 * 1024 * 1024), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const steps: Step[] = [];
  for (const line of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; } // cut first line or partial last one
    if (r.isSidechain || r.isMeta || (r.type !== 'assistant' && r.type !== 'user')) continue;
    const time = typeof r.timestamp === 'string' ? r.timestamp : undefined;
    const c = r.message?.content;
    if (typeof c === 'string') { if (r.type === 'user' && !c.startsWith('<')) steps.push({ kind: 'user', text: c, time }); continue; }
    for (const x of Array.isArray(c) ? c : []) {
      if (x.type === 'text' && x.text?.trim() && !x.text.startsWith('<')) steps.push({ kind: r.type === 'user' ? 'user' : 'say', text: x.text.trim(), time });
      else if (x.type === 'tool_use') steps.push({ kind: 'tool', text: `${x.name}(${toolArg(x.input)})`, time });
      else if (x.type === 'tool_result') steps.push({ kind: x.is_error ? 'error' : 'result', text: resultText(x), time });
    }
  }
  return steps.slice(-600);
}

export interface Verdict { pass: boolean; issues: string[]; risk: 'minor' | 'critical' }

const MAX_DIFF = 150_000;

// Read-only reviewer prompt (after LexCode's): the task, its diff, and a strict JSON verdict.
export function reviewPrompt(t: Task, base: string, diff: string) {
  const clipped = diff.length <= MAX_DIFF ? diff : `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated; read the changed files for the rest]`;
  return [
    `# Review task: ${t.title}`, t.description ?? '',
    `You review work another agent did on this branch (diff against ${base} below). You do not change code.`,
    'Check: does it do what the task asks, completely? Bugs, unhandled errors, edge cases, regressions in callers. ' +
    'Tests for the changed behaviour. Security: validation, authorization, data isolation, injection, secrets. Fits the codebase\'s conventions.',
    'Fail only for real problems. Make every issue specific and actionable: file, line, what to change.',
    `## Diff\n\`\`\`diff\n${clipped}\n\`\`\``,
    'You are running unattended in read-only mode: do not ask questions and do not write files. Read files if you need more context.',
    'End your final message with exactly one ```json block:\n```json\n{"pass": true, "issues": [], "risk": "minor"}\n```\n' +
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
  return { pass: v.pass, issues, risk: v.risk === 'critical' ? 'critical' : 'minor' };
}

// Runs the reviewer headless (claude -p, plan mode, no edit tools) in the task's worktree.
export function runReview(bin: string, cwd: string, prompt: string, model: string, agent: string | undefined, signal?: AbortSignal): Promise<Verdict> {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'ExitPlanMode',
    ...(model ? ['--model', model] : []), ...(agent ? ['--agent', agent] : []), '--', prompt];
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: ptyEnv(), signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `reviewer exited with ${code}`));
      try { resolve(parseVerdict(JSON.parse(out).result ?? '')); } catch (e) { reject(e); }
    });
  });
}

export interface PlannedTask { title: string; description?: string }

// Read-only planning run: Claude reads the code and answers with a JSON task list.
export function plan(bin: string, root: string, goal: string, agent: string | undefined, model: string, signal: AbortSignal): Promise<PlannedTask[]> {
  const prompt = `Plan the work for this goal in the current codebase:\n\n${goal}\n\n` +
    'Read the code you need first. Split the work into small tasks that can each be built, reviewed and merged on their own, in build order, at most 12. ' +
    'Reply with ONLY a JSON array, no prose: [{"title": "...", "description": "what to change, where, and how to verify"}]';
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', ...(model ? ['--model', model] : []), ...(agent ? ['--agent', agent] : []), prompt];
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: root, env: ptyEnv(), signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(e.name === 'AbortError' ? new Error('Planning cancelled') : e));
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `claude exited with ${code}`));
      try {
        const text: string = JSON.parse(out).result ?? '';
        const arr = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '[]');
        resolve(arr.filter((t: any) => t && typeof t.title === 'string').map((t: any) => ({ title: t.title.trim(), description: typeof t.description === 'string' ? t.description.trim() : undefined })));
      } catch { reject(new Error('Claude did not return a task list. Try a more specific goal.')); }
    });
  });
}
