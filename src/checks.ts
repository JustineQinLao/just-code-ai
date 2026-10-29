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
    if (s.test && !/no test specified/.test(s.test) && !/\b(watch|--watch)\b/.test(s.test)) out.push({ name: 'tests', cmd: pm === 'npm' ? 'npm test --silent' : `${pm} test` });
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
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
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

// Gets a task's folder ready to build and test. node_modules is linked from the project folder when the lockfile is
// the same (instant; the project's own install is reused), installed otherwise. A custom command replaces this.
export async function setupFolder(root: string, wt: string, setting: string, env: Record<string, string>, log: (s: string) => void): Promise<boolean> {
  if (!setting.trim()) return true;
  if (setting.trim() !== 'auto') {
    const r = await runCommand(setting, wt, env, 15 * 60_000);
    log(`$ ${setting}\n${tail(r.out, 200, 20000)}\n[exit ${r.code}]`);
    return r.code === 0;
  }
  if (!has(wt, 'package.json') || has(wt, 'node_modules')) return true;
  const lock = LOCKS.find(l => has(wt, l));
  const same = lock && read(path.join(root, lock)) === read(path.join(wt, lock)) && read(path.join(root, 'package.json')) === read(path.join(wt, 'package.json'));
  if (same && fs.existsSync(path.join(root, 'node_modules'))) {
    try {
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'), WIN ? 'junction' : 'dir');
      log('Linked node_modules from the project folder (same lockfile).');
      return true;
    } catch (e: any) { log(`Could not link node_modules: ${e.message}`); }
  }
  const pm = packageManager(wt);
  const cmd = { npm: lock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install' }[pm];
  const r = await runCommand(cmd, wt, env, 15 * 60_000);
  log(`$ ${cmd}\n${tail(r.out, 200, 20000)}\n[exit ${r.code}]`);
  return r.code === 0;
}

// A task folder's environment: the project's Python virtualenv (if any) and its own ports, so parallel tasks'
// servers and tests do not collide.
export function folderEnv(root: string, taskId: string, base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const slot = parseInt(taskId.replace(/[^0-9a-f]/gi, '').slice(0, 6) || '0', 16);
  const venv = ['.venv', 'venv'].map(v => path.join(root, v)).find(v => fs.existsSync(path.join(v, WIN ? 'Scripts' : 'bin')));
  if (venv) {
    env.VIRTUAL_ENV = venv;
    env.PATH = `${path.join(venv, WIN ? 'Scripts' : 'bin')}${path.delimiter}${base.PATH ?? process.env.PATH ?? ''}`;
  }
  const port = 4100 + (slot % 50) * 20;
  env.PORT = String(port);
  env.JUSTCODE_PORT = String(port);
  return env;
}
