import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// The project's own checks (tests, type check) run by JustCode after each turn. They cost no tokens: a failure goes
// back to Claude with the end of the log, and the AI reviewer only sees work that already passes them. A task's
// folder is also set up before Claude starts (dependencies, ports), so Claude does not spend turns installing.

export interface Check { name: string; cmd: string }
export interface CheckResult { name: string; cmd: string; ok: boolean; code: number | null; ms: number; tail: string; timedOut?: boolean; preexisting?: boolean }

const WIN = process.platform === 'win32';
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const has = (dir: string, f: string) => fs.existsSync(path.join(dir, f));

export function packageManager(dir: string) {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun';
  return 'npm';
}
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

// The checks a project has, from its own files. Only commands that run once and exit; never a dev server.
// A check must run once and exit. Test runners that watch by default (Angular/Karma keeps Chrome open and waits for
// file changes, a check that never ends) get the flags that make them run once, headless.
export function oneShot(script: string, dir: string): string {
  const karma = has(dir, 'karma.conf.js') || has(dir, 'karma.conf.cjs') || has(dir, 'karma.conf.ts') || /:karma"/.test(read(path.join(dir, 'angular.json')));
  if (/\bng\s+test\b/.test(script) && !/--watch[= ]false|--no-watch/.test(script)) return `--watch=false${karma ? ' --browsers=ChromeHeadless' : ''}`;
  if (/\bkarma\s+start\b/.test(script) && !/--single-run/.test(script)) return '--single-run --browsers=ChromeHeadless';
  if (/\bvitest\b/.test(script) && !/\bvitest\s+run\b|--run\b/.test(script)) return '--run';
  if (/\b(react-scripts|craco|jest)\b/.test(script) && !/--watchAll[= ]false|--ci\b/.test(script)) return '--watchAll=false';
  return '';
}

export function detectChecks(dir: string): Check[] {
  const out: Check[] = [];
  let pkg: any;
  try { pkg = JSON.parse(read(path.join(dir, 'package.json'))); } catch { /* none */ }
  if (pkg?.scripts) {
    const pm = packageManager(dir), run = (s: string) => pm === 'npm' ? `npm run ${s} --silent` : `${pm} run ${s}`;
    const s = pkg.scripts as Record<string, string>;
    const tc = ['typecheck', 'type-check', 'check-types', 'tsc'].find(k => s[k]);
    if (tc) out.push({ name: 'type check', cmd: run(tc) });
    else if (has(dir, 'tsconfig.json') && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) out.push({ name: 'type check', cmd: 'npx --no-install tsc --noEmit' });
    if (s.test && !/no test specified/.test(s.test) && !/\b(watch|--watch)\b/.test(s.test)) {
      const once = oneShot(s.test, dir);
      out.push({ name: 'tests', cmd: `${pm === 'npm' ? 'npm test --silent' : `${pm} test`}${once ? ` -- ${once}` : ''}` });
    }
  }
  const py = has(dir, 'pytest.ini') || /\[tool\.pytest|pytest/.test(read(path.join(dir, 'pyproject.toml'))) || /pytest/.test(read(path.join(dir, 'setup.cfg'))) || /pytest/.test(read(path.join(dir, 'requirements-dev.txt')));
  if (has(dir, 'manage.py')) out.push({ name: 'tests', cmd: 'python manage.py test' });
  else if (py) out.push({ name: 'tests', cmd: 'python -m pytest -q -x' });
  if (has(dir, 'go.mod')) out.push({ name: 'tests', cmd: 'go test ./...' });
  if (has(dir, 'Cargo.toml')) out.push({ name: 'tests', cmd: 'cargo test -q' });
  if (!out.length && /^test:/m.test(read(path.join(dir, 'Makefile')))) out.push({ name: 'tests', cmd: 'make test' });
  return out;
}

// setting: "auto" (detect), "" (off), or commands separated by newlines.
export function checksFor(dir: string, setting: string): Check[] {
  if (!setting.trim()) return [];
  if (setting.trim() === 'auto') return detectChecks(dir);
  return setting.split('\n').map(l => l.trim()).filter(Boolean).map(cmd => ({ name: cmd.split(' ').slice(0, 2).join(' '), cmd }));
}

// Runs one shell command in `cwd`, at most `timeoutMs`, killing its whole process tree at the end. Keeps the end of
// the output (where test runners put failures).
export function runCommand(cmd: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; out: string; ms: number; timedOut: boolean }> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(WIN ? 'cmd.exe' : 'sh', WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd], { cwd, env, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false, done = false;
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-200_000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const kill = () => { try { if (WIN) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f']); else process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } };
    // At the time limit the tree is killed, and the result is in 5 s later whatever is left holding its output.
    const timer = setTimeout(() => { timedOut = true; kill(); setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); finish(null); }, 5000).unref?.(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, out, ms: Date.now() - t0, timedOut });
    };
    p.on('error', e => { out += `\n${e.message}`; finish(127); });
    p.on('close', code => finish(code));
    // The command exited but something it left in the background (a browser, a server, a docker helper) still holds
    // its output: 'close' would never come. Its exit code counts, after 3 s for the last output to arrive.
    p.on('exit', code => setTimeout(() => { if (done) return; p.stdout.destroy(); p.stderr.destroy(); finish(code); }, 3000).unref?.());
  });
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const tail = (out: string, lines = 80, chars = 6000) => out.replace(ANSI, '').split('\n').filter(l => l.trim()).slice(-lines).join('\n').slice(-chars);

export async function runChecks(checks: Check[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<{ results: CheckResult[]; log: string }> {
  const results: CheckResult[] = [];
  let log = '';
  for (const c of checks) {
    if (signal?.aborted) break;
    const r = await runCommand(c.cmd, cwd, { ...env, CI: 'true', FORCE_COLOR: '0' }, timeoutMs, signal);
    const ok = r.code === 0 && !r.timedOut;
    results.push({ ...c, ok, code: r.code, ms: r.ms, tail: ok ? '' : tail(r.out), timedOut: r.timedOut });
    log += `$ ${c.cmd}\n${r.out.replace(ANSI, '')}\n[exit ${r.timedOut ? 'timeout' : r.code} after ${Math.round(r.ms / 1000)}s]\n\n`;
  }
  return { results, log };
}

/* ---------- task folder setup ---------- */

// Gets a task's folder ready to build and test, so Claude spends no turns on it (it used to make its own virtualenv
// and run npm ci in every task, and the reviewer, without them, could not run the tests at all):
// - every package.json in the folder or one level down (frontend/, web/, …): node_modules linked from the same place
//   in the project folder when the lockfile is the same (instant), installed otherwise;
// - Python with a requirements.txt (in the folder or one level down) and no virtualenv in the project: one shared
//   virtualenv in .justcode/env/venv, created once and topped up when the requirements change. folderEnv puts it on PATH.
// A custom command replaces this.
export async function setupFolder(root: string, wt: string, setting: string, env: Record<string, string>, log: (s: string) => void): Promise<boolean> {
  if (!setting.trim()) return true;
  if (setting.trim() !== 'auto') {
    const r = await runCommand(setting, wt, env, 15 * 60_000);
    log(`$ ${setting}\n${tail(r.out, 200, 20000)}\n[exit ${r.code}]`);
    return r.code === 0;
  }
  let ok = true;
  for (const sub of packageDirs(wt)) ok = await nodeSetup(path.join(root, sub), path.join(wt, sub), env, log) && ok;
  ok = await pythonSetup(root, wt, env, log) && ok;
  return ok;
}

// The folder and its first-level subfolders that hold a package.json ('' is the folder itself).
export function packageDirs(dir: string): string[] {
  return ['', ...packageLike(dir)].filter(s => has(path.join(dir, s), 'package.json'));
}

async function nodeSetup(src: string, wt: string, env: Record<string, string>, log: (s: string) => void) {
  if (has(wt, 'node_modules')) return true;
  const lock = LOCKS.find(l => has(wt, l));
  const same = lock && read(path.join(src, lock)) === read(path.join(wt, lock)) && read(path.join(src, 'package.json')) === read(path.join(wt, 'package.json'));
  if (same && fs.existsSync(path.join(src, 'node_modules'))) {
    try {
      fs.symlinkSync(path.join(src, 'node_modules'), path.join(wt, 'node_modules'), WIN ? 'junction' : 'dir');
      log(`Linked ${path.basename(wt)}/node_modules from the project folder (same lockfile).`);
      return true;
    } catch (e: any) { log(`Could not link node_modules: ${e.message}`); }
  }
  const pm = packageManager(wt);
  const cmd = { npm: lock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install' }[pm];
  const r = await runCommand(cmd, wt, env, 15 * 60_000);
  log(`$ ${cmd} (in ${path.basename(wt)})\n${tail(r.out, 200, 20000)}\n[exit ${r.code}]`);
  return r.code === 0;
}

const BIN = WIN ? 'Scripts' : 'bin';
export const sharedVenv = (root: string) => path.join(root, '.justcode', 'env', 'venv');
// The project's virtualenv: its own (.venv or venv, in the project or one level down), else JustCode's shared one.
export function findVenv(root: string): string | undefined {
  const dirs = ['', ...packageLike(root)];
  for (const d of dirs) for (const v of ['.venv', 'venv']) { const p = path.join(root, d, v); if (fs.existsSync(path.join(p, BIN))) return p; }
  return fs.existsSync(path.join(sharedVenv(root), BIN)) ? sharedVenv(root) : undefined;
}
function packageLike(dir: string) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map(d => d.name); } catch { return []; }
}
// requirements.txt files in the folder or one level down.
function requirementFiles(dir: string) {
  return ['', ...packageLike(dir)].map(d => path.join(dir, d, 'requirements.txt')).filter(f => fs.existsSync(f));
}

// The newest python3.N on PATH or where Homebrew, uv and python.org put it (VS Code started from the Dock lacks the
// shell's PATH, and macOS's own /usr/bin/python3 is too old for many projects).
export function newestPython(env: Record<string, string>): string {
  if (WIN) return 'python';
  const dirs = [...(env.PATH ?? process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(require('os').homedir(), '.local', 'bin'), '/Library/Frameworks/Python.framework/Versions/Current/bin'];
  let best: { v: number; p: string } | undefined;
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const m = /^python3\.(\d+)$/.exec(n);
      if (m && (!best || +m[1] > best.v)) best = { v: +m[1], p: path.join(d, n) };
    }
  }
  return best?.p ?? 'python3';
}

const venvBuilds = new Map<string, Promise<boolean>>();
async function pythonSetup(root: string, wt: string, env: Record<string, string>, log: (s: string) => void): Promise<boolean> {
  const reqs = requirementFiles(wt);
  if (!reqs.length) return true;
  const own = findVenv(root);
  if (own && own !== sharedVenv(root)) return true;     // the project has its own: used as is
  const venv = sharedVenv(root), stamp = path.join(venv, '.jc-requirements');
  const want = reqs.map(f => read(f)).join('\n');
  if (read(stamp) === want) return true;
  // One build at a time per project (tasks set up in parallel share it).
  const running = venvBuilds.get(venv);
  if (running) return running;
  const p = (async () => {
    // Never installed successfully (or made by an older JustCode): start over with the newest Python on the machine.
    if (!fs.existsSync(stamp)) fs.rmSync(venv, { recursive: true, force: true });
    const py = newestPython(env);
    if (!fs.existsSync(path.join(venv, BIN))) {
      const r = await runCommand(`"${py}" -m venv "${venv}"`, root, env, 5 * 60_000);
      log(`$ ${py} -m venv .justcode/env/venv\n${tail(r.out)}\n[exit ${r.code}]`);
      if (r.code !== 0) return false;
    }
    const pip = `"${path.join(venv, BIN, 'pip')}" install -q --disable-pip-version-check ${reqs.map(f => `-r "${f}"`).join(' ')}`;
    const r = await runCommand(pip, wt, env, 15 * 60_000);
    log(`$ pip install ${reqs.map(f => path.relative(wt, f)).join(' ')}\n${tail(r.out, 200, 20000)}\n[exit ${r.code}]`);
    if (r.code === 0) fs.writeFileSync(stamp, want);
    return r.code === 0;
  })().finally(() => venvBuilds.delete(venv));
  venvBuilds.set(venv, p);
  return p;
}

// What a task is told about its folder, so it does not set anything up itself.
export function setupNote(root: string, wt: string): string | undefined {
  const notes: string[] = [];
  const venv = findVenv(root);
  // The shared virtualenv counts only once its install worked; the project's own is taken as is.
  if (venv && (venv !== sharedVenv(root) || fs.existsSync(path.join(venv, '.jc-requirements')))) notes.push(`Python: the virtualenv ${venv} is already on PATH (python, pip and the project's packages). Do not create another one.`);
  const linked = packageDirs(wt).filter(d => has(path.join(wt, d), 'node_modules')).map(d => d || '.');
  if (linked.length) notes.push(`Node: dependencies are installed (node_modules in ${linked.join(', ')}). Do not run npm ci or npm install unless you change package.json.`);
  return notes.length ? `## Environment (ready)\n${notes.join('\n')}` : undefined;
}

// A task folder's environment: the project's Python virtualenv (if any) and its own ports, so parallel tasks'
// servers and tests do not collide.
export function folderEnv(root: string, taskId: string, base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const slot = parseInt(taskId.replace(/[^0-9a-f]/gi, '').slice(0, 6) || '0', 16);
  const venv = findVenv(root);
  if (venv) {
    env.VIRTUAL_ENV = venv;
    env.PATH = `${path.join(venv, WIN ? 'Scripts' : 'bin')}${path.delimiter}${base.PATH ?? process.env.PATH ?? ''}`;
  }
  const port = 4100 + (slot % 50) * 20;
  env.PORT = String(port);
  env.JUSTCODE_PORT = String(port);
  return env;
}
