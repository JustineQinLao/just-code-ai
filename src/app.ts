import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';

// The project's app, run from the project folder (the current branch) for the user to open: no task, no Claude.
// JustCode works out how to run it (Docker Compose, a Node dev server, Django, Rails, Laravel, FastAPI, Flask, Go…),
// where it listens (compose port mappings, .env, the framework's default) and keeps one copy running per project.

export type Role = 'frontend' | 'backend' | 'other';
export interface AppLink { label: string; url: string; role: Role; up?: boolean }
export interface AppState {
  state: 'stopped' | 'building' | 'running' | 'failed';
  kind?: string;          // what was detected: "Docker Compose", "Angular + Django", …
  links: AppLink[];
  error?: string;
  startedAt?: number;
  head?: string;          // the commit it was built from
  pids?: number[];        // processes JustCode started (not for compose)
  why?: string;           // what started the last build ("after Sprint 2", "you")
}
export interface Proc { label: string; role: Role; cwd: string; cmd: string; port?: number; install?: string }
export interface Plan { kind: string; compose?: string; procs: Proc[]; env: Record<string, string> }

export const appEvents = new EventEmitter();
const busy = new Map<string, Promise<void>>();

const ENV_PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.docker', 'bin'), path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(path.delimiter);
const ENV = { ...process.env, PATH: ENV_PATH };
const dir = (root: string) => path.join(root, '.justcode');
const stateFile = (root: string) => path.join(dir(root), 'app.json');
export const logFile = (root: string) => path.join(dir(root), 'app.log');

export function load(root: string): AppState {
  try { return { links: [], ...JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) }; } catch { return { state: 'stopped', links: [] }; }
}
function save(root: string, s: AppState) {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(s, null, 2));
  appEvents.emit('change', root);
}
export function view(root: string) {
  const s = load(root);
  let tail = '';
  try { const t = fs.readFileSync(logFile(root), 'utf8'); tail = t.slice(-4000); } catch { /* no log yet */ }
  let detected: string | undefined;
  try { detected = detect(root)?.kind; } catch { /* unreadable project */ }
  return { ...s, busy: busy.has(root), log: tail, detected };
}

/* ---------- detection ---------- */

export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const COMPOSE = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const FRONT_DIRS = ['frontend', 'client', 'web', 'ui', 'app', 'apps/web', 'apps/frontend', 'packages/web', '.'];
const BACK_DIRS = ['backend', 'server', 'api', 'apps/api', 'apps/backend', 'packages/api', '.'];
const json = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const has = (d: string, f: string) => fs.existsSync(path.join(d, f));
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Node frameworks: which dependency means which dev server, and its default port.
const NODE_FRONT: [string, string, number][] = [
  ['@angular/core', 'Angular', 4200], ['next', 'Next.js', 3000], ['nuxt', 'Nuxt', 3000], ['astro', 'Astro', 4321],
  ['@sveltejs/kit', 'SvelteKit', 5173], ['@remix-run/dev', 'Remix', 3000], ['@react-router/dev', 'React Router', 5173], ['gatsby', 'Gatsby', 8000],
  ['react-scripts', 'Create React App', 3000], ['expo', 'Expo', 8081], ['@vue/cli-service', 'Vue CLI', 8080], ['vite', 'Vite', 5173],
];
const NODE_BACK: [string, string, number][] = [['@nestjs/core', 'NestJS', 3000], ['fastify', 'Fastify', 3000], ['koa', 'Koa', 3000], ['hono', 'Hono', 3000], ['express', 'Express', 3000]];

function pm(d: string, root: string) {
  const at = (f: string) => has(d, f) || has(root, f);
  return at('pnpm-lock.yaml') ? 'pnpm' : at('yarn.lock') ? 'yarn' : at('bun.lockb') || at('bun.lock') ? 'bun' : 'npm';
}
const runScript = (p: string, s: string) => p === 'npm' ? `npm run ${s}` : `${p} ${s === 'start' && p !== 'bun' ? 'start' : `run ${s}`}`;

function nodeProc(root: string, rel: string, table: [string, string, number][], role: Role, port?: number): Proc & { fw: string } | undefined {
  const d = path.join(root, rel), pkg = json(path.join(d, 'package.json'));
  if (!pkg?.scripts) return undefined;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = table.find(([dep]) => dep in deps);
  if (!fw) return undefined;
  const script = ['dev', 'start', 'serve'].find(s => pkg.scripts[s]);
  if (!script) return undefined;
  const p = pm(d, root), want = port ?? fw[2];
  // Pass the port only where the framework takes a --port flag the same way (others read PORT from the environment).
  const flag = /Angular|Vite|SvelteKit|Astro|Nuxt|Next|React Router|Vue CLI|Gatsby/.test(fw[1]) ? ` -- --port ${want}${/Angular|Vite|SvelteKit|Astro|React Router/.test(fw[1]) ? ' --host 127.0.0.1' : ''}` : '';
  return { label: fw[1], fw: fw[1], role, cwd: d, cmd: `PORT=${want} ${runScript(p, script)}${p === 'npm' || p === 'pnpm' ? flag : ''}`, port: want,
    install: has(d, 'node_modules') ? undefined : `${p} install` };
}

function pythonCmd(d: string, root: string) {
  for (const v of ['.venv', 'venv', 'env']) for (const b of [d, root]) if (fs.existsSync(path.join(b, v, 'bin', 'python'))) return path.join(b, v, 'bin', 'python');
  return 'python3';
}

function backProc(root: string, env: Record<string, string>): Proc | undefined {
  const port = Number(env.BACKEND_PORT || env.API_PORT || env.SERVER_PORT) || undefined;
  for (const rel of BACK_DIRS) {
    const d = path.join(root, rel);
    if (has(d, 'manage.py')) return { label: 'Django', role: 'backend', cwd: d, cmd: `${pythonCmd(d, root)} manage.py runserver 127.0.0.1:${port ?? 8000}`, port: port ?? 8000 };
    if (has(d, 'artisan')) return { label: 'Laravel', role: 'backend', cwd: d, cmd: `php artisan serve --port=${port ?? 8000}`, port: port ?? 8000 };
    if (has(d, 'bin/rails')) return { label: 'Rails', role: 'backend', cwd: d, cmd: `bin/rails server -p ${port ?? 3000}`, port: port ?? 3000 };
    const py = ['main.py', 'app/main.py', 'app.py', 'src/main.py'].find(f => has(d, f));
    if (py) {
      const src = read(path.join(d, py)), mod = py.replace(/\.py$/, '').replace(/\//g, '.');
      if (/FastAPI\(/.test(src)) return { label: 'FastAPI', role: 'backend', cwd: d, cmd: `${pythonCmd(d, root)} -m uvicorn ${mod}:app --port ${port ?? 8000}`, port: port ?? 8000 };
      if (/Flask\(/.test(src)) return { label: 'Flask', role: 'backend', cwd: d, cmd: `${pythonCmd(d, root)} -m flask --app ${mod} run --port ${port ?? 5000}`, port: port ?? 5000 };
    }
    if (has(d, 'go.mod') && (has(d, 'main.go') || has(d, 'cmd'))) return { label: 'Go', role: 'backend', cwd: d, cmd: `PORT=${port ?? 8080} go run .`, port: port ?? 8080 };
    if (has(d, 'mvnw')) return { label: 'Spring', role: 'backend', cwd: d, cmd: `./mvnw spring-boot:run -Dspring-boot.run.arguments=--server.port=${port ?? 8080}`, port: port ?? 8080 };
    if (has(d, 'gradlew') && /spring/i.test(read(path.join(d, 'build.gradle')) + read(path.join(d, 'build.gradle.kts')))) return { label: 'Spring', role: 'backend', cwd: d, cmd: `./gradlew bootRun --args=--server.port=${port ?? 8080}`, port: port ?? 8080 };
    if (rel !== '.') { const n = nodeProc(root, rel, NODE_BACK, 'backend', port); if (n) return n; }
  }
  const n = nodeProc(root, '.', NODE_BACK, 'backend', port);
  return n;
}

// How to run this project, or undefined when JustCode cannot tell (the modal then offers "Ask Claude").
export function detect(root: string): Plan | undefined {
  const env = { ...readEnv(path.join(root, '.env.example')), ...readEnv(path.join(root, '.env')) };
  const compose = COMPOSE.find(f => has(root, f));
  if (compose) return { kind: 'Docker Compose', compose, procs: [], env };
  const fport = Number(env.FRONTEND_PORT || env.WEB_PORT || env.CLIENT_PORT || env.VITE_PORT) || undefined;
  let front: (Proc & { fw: string }) | undefined;
  for (const rel of FRONT_DIRS) if ((front = nodeProc(root, rel, NODE_FRONT, 'frontend', fport))) break;
  const back = backProc(root, env);
  const procs = [front, back].filter((p): p is Proc => !!p && !(front && back && p === back && back.cwd === front.cwd && back.port === front.port));
  if (!procs.length) return undefined;
  return { kind: procs.map(p => p.label).join(' + '), procs, env };
}

/* ---------- links ---------- */

const NOT_HTTP = new Set([5432, 3306, 6379, 27017, 5672, 11211, 9200, 9300, 1025, 2525, 587, 25, 1433, 1521, 5433, 6380, 4222, 9092, 2181, 15672]);
const FRONT_NAME = /front|web|client|ui|site|nginx|caddy|proxy|^app$|portal|dashboard|admin/i;
const BACK_NAME = /back|api|server|django|rails|laravel|php|node|express|nest|flask|fastapi|uvicorn|gunicorn|spring|go/i;

// `docker compose ps --format json` prints an array (Compose ≥ 2.21) or one object per line (older).
export function parsePs(out: string): { Service: string; Publishers?: { URL?: string; PublishedPort?: number; TargetPort?: number }[] }[] {
  const t = out.trim();
  if (!t) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : [v]; } catch { /* NDJSON */ }
  return t.split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
}

export function composeLinks(ps: ReturnType<typeof parsePs>, env: Record<string, string>): AppLink[] {
  const links: AppLink[] = [];
  const seen = new Set<number>();
  for (const c of ps) for (const p of c.Publishers ?? []) {
    const port = p.PublishedPort;
    if (!port || seen.has(port) || NOT_HTTP.has(p.TargetPort ?? 0) || NOT_HTTP.has(port)) continue;
    seen.add(port);
    const name = c.Service || '';
    const role: Role = String(port) === env.FRONTEND_PORT ? 'frontend' : String(port) === env.BACKEND_PORT ? 'backend'
      : /mail|smtp|pgadmin|adminer|grafana|prometheus|kibana|flower|minio|rabbit/i.test(name) ? 'other' : FRONT_NAME.test(name) ? 'frontend' : BACK_NAME.test(name) ? 'backend' : 'other';
    links.push({ label: name || `port ${port}`, url: `http://localhost:${port}`, role });
  }
  // One app service and nothing marked as frontend: that service is what the user opens.
  if (!links.some(l => l.role === 'frontend')) { const first = links.find(l => l.role === 'backend') ?? links.find(l => l.role === 'other'); if (first && links.filter(l => l.role !== 'other').length <= 1) first.role = 'frontend'; }
  const order: Record<Role, number> = { frontend: 0, backend: 1, other: 2 };
  return links.sort((a, b) => order[a.role] - order[b.role]);
}

async function up(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' }); return r.status < 500; } catch { return false; }
}
async function waitUp(links: AppLink[], ms: number, abort: () => boolean) {
  const end = Date.now() + ms;
  for (;;) {
    for (const l of links) if (!l.up) l.up = await up(l.url);
    if (links.every(l => l.up) || Date.now() > end || abort()) return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/* ---------- start / stop ---------- */

function sh(cmd: string, cwd: string, log: fs.WriteStream, timeout: number) {
  return new Promise<void>((resolve, reject) => {
    log.write(`\n$ ${cmd}\n`);
    const p = spawn('/bin/sh', ['-c', cmd], { cwd, env: ENV });
    p.stdout.pipe(log, { end: false }); p.stderr.pipe(log, { end: false });
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`${cmd} took longer than ${Math.round(timeout / 60000)} min`)); }, timeout);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${cmd} failed (exit ${code}); see the log`)); });
  });
}
const out = (cmd: string, args: string[], cwd: string) => new Promise<string>((res, rej) => execFile(cmd, args, { cwd, env: ENV, timeout: 30_000, maxBuffer: 8 << 20 }, (e, o) => e ? rej(e) : res(o)));
const headOf = (root: string) => out('git', ['rev-parse', '--short', 'HEAD'], root).then(s => s.trim(), () => undefined);

function killAll(pids?: number[]) {
  for (const pid of pids ?? []) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
}

// Builds (again) and starts the app. One run per project at a time; a second call waits for the first.
export function start(root: string, why = 'you'): Promise<void> {
  const prev = busy.get(root);
  if (prev) return prev;
  const job = run(root, why).finally(() => { busy.delete(root); appEvents.emit('change', root); });
  busy.set(root, job);
  appEvents.emit('change', root);
  return job;
}

async function run(root: string, why: string) {
  const plan = detect(root);
  const old = load(root);
  if (!plan) { save(root, { state: 'failed', links: [], why, error: 'JustCode could not tell how to run this project (no compose file, dev server or backend it knows). Use "Ask Claude" to set it up.' }); return; }
  fs.mkdirSync(dir(root), { recursive: true });
  const log = fs.createWriteStream(logFile(root), { flags: 'w' });
  log.write(`# ${plan.kind} · ${new Date().toISOString()} · ${why}\n`);
  save(root, { ...old, state: 'building', kind: plan.kind, why, error: undefined });
  try {
    let links: AppLink[];
    let pids: number[] | undefined;
    if (plan.compose) {
      if (!has(root, '.env') && has(root, '.env.example')) fs.copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
      await sh('docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop, then Rebuild."; exit 1; }', root, log, 30_000);
      await sh(`docker compose -f ${plan.compose} up -d --build --remove-orphans`, root, log, 20 * 60_000);
      links = composeLinks(parsePs(await out('docker', ['compose', '-f', plan.compose, 'ps', '--format', 'json'], root)), readEnv(path.join(root, '.env')));
    } else {
      killAll(old.pids);
      pids = [];
      links = [];
      for (const p of plan.procs) {
        if (p.install) await sh(p.install, p.cwd, log, 10 * 60_000);
        log.write(`\n$ (${p.label}) ${p.cmd}\n`);
        const child = spawn('/bin/sh', ['-c', p.cmd], { cwd: p.cwd, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
        child.unref();
        if (child.pid) pids.push(child.pid);
        links.push({ label: p.label, url: `http://localhost:${p.port}`, role: p.role });
      }
    }
    if (!links.length) throw new Error('The app started but publishes no web port. Check the compose file\'s ports, or use "Ask Claude".');
    save(root, { state: 'building', kind: plan.kind, links, pids, why, startedAt: Date.now(), head: await headOf(root) });
    await waitUp(links, 4 * 60_000, () => false);
    const front = links.find(l => l.role === 'frontend') ?? links[0];
    save(root, { state: front.up ? 'running' : 'failed', kind: plan.kind, links, pids, why, startedAt: Date.now(), head: await headOf(root),
      error: front.up ? undefined : `${front.url} does not answer. The log below says why; "Ask Claude" can fix the setup.` });
  } catch (e: any) {
    save(root, { ...load(root), state: 'failed', error: String(e?.message ?? e) });
  } finally { log.end(); }
}

export async function stop(root: string) {
  const s = load(root), plan = detect(root);
  if (plan?.compose) await out('docker', ['compose', '-f', plan.compose, 'stop'], root).catch(() => '');
  killAll(s.pids);
  save(root, { ...s, state: 'stopped', pids: undefined, links: s.links.map(l => ({ ...l, up: false })) });
}

// Is the running copy behind the project folder? Then it rebuilds, for the changes that need it.
const NO_BUILD = /(^|\/)(docs?|\.justcode|\.github|\.claude|e2e|tests?|__tests__|spec)\/|\.(md|mdx|txt|png|jpe?g|gif|svg|pdf)$|(^|\/)(README|CHANGELOG|LICENSE|TASKS)[^/]*$|\.(spec|test)\.[jt]sx?$/i;
export const needsBuild = (files: string[]) => files.some(f => !NO_BUILD.test(f));

// After a sprint merged (always, when code changed) or a task merged into the checked-out branch (when the app runs).
export async function afterMerge(root: string, files: string[], why: string, always: boolean) {
  if (!needsBuild(files)) return;
  const s = load(root);
  if (!always && s.state !== 'running') return;
  if (!detect(root)) return;
  await start(root, why);
}
