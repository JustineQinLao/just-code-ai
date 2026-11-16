import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';

// The project's app, run from the project folder (the current branch) for the user to open: no task, no Claude.
// JustCode works out how to run it, where it listens and keeps one copy running per project. In order of preference:
// Docker Compose; a single Dockerfile; a Procfile; a frontend dev server (Node frameworks, static site generators,
// plain static HTML) plus a backend (Django, FastAPI, Flask, Laravel, Symfony, plain PHP, Rails, Phoenix, .NET, Go,
// Spring, Node servers); a monorepo's own dev script; a Makefile dev/run/serve/start target.
// Ports: .env first, then the framework default (moved to the next free port when that one is taken); the link is
// corrected from the dev server's own "http://localhost:NNNN" line when it prints one.

export type Role = 'frontend' | 'backend' | 'other';
export interface AppLink { label: string; url: string; role: Role; up?: boolean; note?: string }
export interface AppState {
  state: 'stopped' | 'building' | 'running' | 'failed';
  kind?: string;          // what was detected: "Docker Compose", "Angular + Django", …
  links: AppLink[];
  error?: string;
  startedAt?: number;
  head?: string;          // the commit it was built from
  pids?: number[];        // processes JustCode started (not for compose)
  container?: string;     // the container JustCode started for a lone Dockerfile
  why?: string;           // what started the last build ("after Sprint 2", "you")
  steps?: string[];       // this run's steps, for the modal's progress list
  stepNo?: number;        // the step it is on (or failed on)
  stepAt?: number;        // when that step began
  buildAt?: number;       // when this run began
}
export interface Proc {
  label: string; role: Role; cwd: string; cmd: string;
  port?: number;          // where it should listen; PORT is set to it
  setup?: string[];       // dependency installs and migrations, run first (each must succeed)
  urls?: boolean;         // take the link(s) from its output (dev scripts that pick their own port, monorepos)
}
export interface Plan { kind: string; compose?: string; dockerfile?: string; procs: Proc[]; env: Record<string, string> }

export const appEvents = new EventEmitter();
const busy = new Map<string, Promise<void>>();

const ENV_PATH = [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.docker', 'bin'), path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.dotnet', 'tools'), path.join(os.homedir(), '.cargo', 'bin'), path.join(os.homedir(), 'go', 'bin')].filter(Boolean).join(path.delimiter);
const ENV = { ...process.env, PATH: ENV_PATH, CI: '', BROWSER: 'none', FORCE_COLOR: '0' };
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
  try { tail = fs.readFileSync(logFile(root), 'utf8').slice(-6000); } catch { /* no log yet */ }
  let detected: string | undefined;
  try { detected = detect(root)?.kind; } catch { /* unreadable project */ }
  const lastLine = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n|\r/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).pop();
  return { ...s, busy: busy.has(root), log: tail, detected, lastLine };
}

/* ---------- detection ---------- */

export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const COMPOSE = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const FRONT_DIRS = ['frontend', 'client', 'web', 'ui', 'app', 'site', 'www', 'apps/web', 'apps/frontend', 'apps/client', 'apps/site', 'packages/web', 'packages/frontend', '.'];
const BACK_DIRS = ['backend', 'server', 'api', 'apps/api', 'apps/backend', 'apps/server', 'packages/api', 'packages/server', '.'];
const json = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const has = (d: string, f: string) => fs.existsSync(path.join(d, f));
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const q = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
const files = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };

// Node frameworks: dependency, name, default port, and how the port is passed ('flag' = --port N after the script).
type Fw = [dep: string, name: string, port: number, how: 'flag' | 'env'];
const NODE_FRONT: Fw[] = [
  ['@angular/core', 'Angular', 4200, 'flag'], ['next', 'Next.js', 3000, 'flag'], ['nuxt', 'Nuxt', 3000, 'flag'], ['astro', 'Astro', 4321, 'flag'],
  ['@sveltejs/kit', 'SvelteKit', 5173, 'flag'], ['@remix-run/dev', 'Remix', 3000, 'env'], ['@react-router/dev', 'React Router', 5173, 'flag'],
  ['@solidjs/start', 'SolidStart', 3000, 'flag'], ['@builder.io/qwik', 'Qwik', 5173, 'flag'], ['@docusaurus/core', 'Docusaurus', 3000, 'flag'],
  ['vitepress', 'VitePress', 5173, 'flag'], ['@11ty/eleventy', 'Eleventy', 8080, 'flag'], ['gatsby', 'Gatsby', 8000, 'flag'],
  ['react-scripts', 'Create React App', 3000, 'env'], ['expo', 'Expo', 8081, 'flag'], ['@vue/cli-service', 'Vue CLI', 8080, 'flag'],
  ['ember-cli', 'Ember', 4200, 'flag'], ['@redwoodjs/core', 'Redwood', 8910, 'env'], ['parcel', 'Parcel', 1234, 'flag'],
  ['webpack-dev-server', 'webpack', 8080, 'flag'], ['vite', 'Vite', 5173, 'flag'],
];
const NODE_BACK: Fw[] = [['@nestjs/core', 'NestJS', 3000, 'env'], ['@adonisjs/core', 'AdonisJS', 3333, 'env'], ['fastify', 'Fastify', 3000, 'env'],
  ['koa', 'Koa', 3000, 'env'], ['hono', 'Hono', 3000, 'env'], ['express', 'Express', 3000, 'env']];

function pm(d: string, root: string) {
  const at = (f: string) => has(d, f) || has(root, f);
  return at('pnpm-lock.yaml') ? 'pnpm' : at('yarn.lock') ? 'yarn' : at('bun.lockb') || at('bun.lock') ? 'bun' : 'npm';
}
const runScript = (p: string, s: string, extra: string) => p === 'yarn' ? `yarn ${s}${extra ? ` ${extra}` : ''}` : `${p} run ${s}${extra ? ` -- ${extra}` : ''}`;
const nodeSetup = (d: string, root: string) => has(d, 'node_modules') || has(root, 'node_modules') ? [] : [`${pm(d, root)} install`];

function nodeProc(root: string, rel: string, table: Fw[], role: Role, port?: number): Proc | undefined {
  const d = path.join(root, rel), pkg = json(path.join(d, 'package.json'));
  if (!pkg?.scripts) return undefined;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = table.find(([dep]) => dep in deps);
  if (!fw) return undefined;
  const script = ['dev', 'start', 'serve', 'develop'].find(s => pkg.scripts[s]);
  if (!script) return undefined;
  const p = pm(d, root), want = port ?? fw[2];
  const host = /Angular|Vite|SvelteKit|Astro|React Router|Qwik|VitePress|Ember/.test(fw[1]) ? ' --host 127.0.0.1' : '';
  return { label: fw[1], role, cwd: d, port: want, urls: true, setup: nodeSetup(d, root),
    cmd: runScript(p, script, fw[3] === 'flag' ? `--port ${want}${host}` : '') };
}

// Any package.json dev script, framework or not: it prints its own URL(s). Also a monorepo's root (turbo, nx, workspaces).
function anyNodeScript(root: string, rel: string, role: Role): Proc | undefined {
  const d = path.join(root, rel), pkg = json(path.join(d, 'package.json'));
  const script = pkg?.scripts && ['dev', 'start', 'serve', 'develop'].find(s => pkg.scripts[s]);
  if (!script) return undefined;
  const mono = !!pkg.workspaces || has(d, 'turbo.json') || has(d, 'nx.json') || has(d, 'pnpm-workspace.yaml') || has(d, 'lerna.json');
  return { label: mono ? 'Monorepo dev script' : `${script} script`, role, cwd: d, urls: true, setup: nodeSetup(d, root), cmd: runScript(pm(d, root), script, '') };
}

// Python: the project's own venv, uv or poetry; otherwise a venv JustCode keeps in .justcode/venv (never the system Python).
function python(d: string, root: string): { run: string; setup: string[] } {
  for (const v of ['.venv', 'venv', 'env']) for (const b of [d, root]) if (fs.existsSync(path.join(b, v, 'bin', 'python'))) return { run: q(path.join(b, v, 'bin', 'python')), setup: [] };
  if (has(d, 'uv.lock') || has(root, 'uv.lock')) return { run: 'uv run python', setup: ['uv sync'] };
  if (has(d, 'poetry.lock')) return { run: 'poetry run python', setup: ['poetry install --no-root'] };
  if (has(d, 'Pipfile')) return { run: 'pipenv run python', setup: ['pipenv install'] };
  const venv = path.join(dir(root), 'venv'), py = q(path.join(venv, 'bin', 'python'));
  const req = ['requirements.txt', 'requirements/dev.txt', 'requirements/base.txt', 'requirements-dev.txt'].find(f => has(d, f));
  const setup = fs.existsSync(path.join(venv, 'bin', 'python')) ? [] : [`python3 -m venv ${q(venv)}`, ...(req ? [`${py} -m pip install -q -r ${q(req)}`] : has(d, 'pyproject.toml') ? [`${py} -m pip install -q -e .`] : [])];
  return { run: py, setup };
}
const ruby = (d: string) => has(d, 'Gemfile') ? ['bundle check >/dev/null 2>&1 || bundle install'] : [];
const php = (d: string) => has(d, 'composer.json') && !has(d, 'vendor') ? ['composer install --no-interaction'] : [];

function backProc(root: string, env: Record<string, string>): Proc | undefined {
  const port = Number(env.BACKEND_PORT || env.API_PORT || env.SERVER_PORT || env.APP_PORT) || undefined;
  for (const rel of BACK_DIRS) {
    const d = path.join(root, rel), P = (n: number) => port ?? n;
    if (has(d, 'manage.py')) { const py = python(d, root); return { label: 'Django', role: 'backend', cwd: d, port: P(8000), setup: [...py.setup, `${py.run} manage.py migrate --noinput`], cmd: `${py.run} manage.py runserver 127.0.0.1:${P(8000)}` }; }
    if (has(d, 'artisan')) return { label: 'Laravel', role: 'backend', cwd: d, port: P(8000), setup: [...php(d), ...(has(d, '.env') ? ['php artisan migrate --force'] : [])], cmd: `php artisan serve --host=127.0.0.1 --port=${P(8000)}` };
    if (has(d, 'bin/console') && has(d, 'public/index.php')) return { label: 'Symfony', role: 'backend', cwd: d, port: P(8000), setup: php(d), cmd: `php -S 127.0.0.1:${P(8000)} -t public` };
    if (has(d, 'bin/rails')) return { label: 'Rails', role: 'backend', cwd: d, port: P(3000), setup: [...ruby(d), 'bin/rails db:prepare'], cmd: `bin/rails server -b 127.0.0.1 -p ${P(3000)}` };
    if (has(d, 'mix.exs') && /:phoenix/.test(read(path.join(d, 'mix.exs')))) return { label: 'Phoenix', role: 'backend', cwd: d, port: P(4000), setup: ['mix deps.get', 'mix ecto.create --quiet || true', 'mix ecto.migrate || true'], cmd: 'mix phx.server' };
    const csproj = files(d).find(f => f.endsWith('.csproj'));
    if (csproj && /Microsoft\.NET\.Sdk\.Web|AspNetCore/.test(read(path.join(d, csproj)))) return { label: '.NET', role: 'backend', cwd: d, port: P(5000), cmd: `dotnet run --urls http://127.0.0.1:${P(5000)}` };
    const py = ['main.py', 'app/main.py', 'src/main.py', 'app.py', 'wsgi.py', 'server.py'].find(f => has(d, f));
    if (py) {
      const src = read(path.join(d, py)), mod = py.replace(/\.py$/, '').replace(/\//g, '.'), env = python(d, root);
      if (/FastAPI\(/.test(src)) return { label: 'FastAPI', role: 'backend', cwd: d, port: P(8000), setup: env.setup, cmd: `${env.run} -m uvicorn ${mod}:app --host 127.0.0.1 --port ${P(8000)}` };
      if (/Flask\(/.test(src)) return { label: 'Flask', role: 'backend', cwd: d, port: P(5000), setup: env.setup, cmd: `${env.run} -m flask --app ${mod} run --port ${P(5000)}` };
      if (/streamlit/.test(src)) return { label: 'Streamlit', role: 'frontend', cwd: d, port: P(8501), setup: env.setup, cmd: `${env.run} -m streamlit run ${py} --server.port ${P(8501)} --server.headless true` };
      if (/gradio/.test(src)) return { label: 'Gradio', role: 'frontend', cwd: d, port: P(7860), setup: env.setup, cmd: `GRADIO_SERVER_PORT=${P(7860)} ${env.run} ${py}` };
    }
    if (has(d, 'go.mod') && (has(d, 'main.go') || has(d, 'cmd'))) return { label: 'Go', role: 'backend', cwd: d, port: P(8080), cmd: has(d, 'main.go') ? 'go run .' : `go run ./cmd/${files(path.join(d, 'cmd'))[0] ?? ''}` };
    if (has(d, 'Cargo.toml') && /axum|actix-web|rocket|warp|poem/.test(read(path.join(d, 'Cargo.toml')))) return { label: 'Rust', role: 'backend', cwd: d, port: P(8080), cmd: 'cargo run' };
    if (has(d, 'mvnw') || has(d, 'pom.xml') && /spring-boot/.test(read(path.join(d, 'pom.xml')))) return { label: 'Spring', role: 'backend', cwd: d, port: P(8080), cmd: `${has(d, 'mvnw') ? './mvnw' : 'mvn'} -q spring-boot:run -Dspring-boot.run.arguments=--server.port=${P(8080)}` };
    if ((has(d, 'gradlew') || has(d, 'build.gradle') || has(d, 'build.gradle.kts')) && /spring/i.test(read(path.join(d, 'build.gradle')) + read(path.join(d, 'build.gradle.kts')))) return { label: 'Spring', role: 'backend', cwd: d, port: P(8080), cmd: `${has(d, 'gradlew') ? './gradlew' : 'gradle'} bootRun --args=--server.port=${P(8080)}` };
    if (rel !== '.') { const n = nodeProc(root, rel, NODE_BACK, 'backend', port) ?? anyNodeScript(root, rel, 'backend'); if (n) return { ...n, port: n.port ?? port }; }
    if (rel !== '.' && has(d, 'index.php')) return { label: 'PHP', role: 'backend', cwd: d, port: P(8000), setup: php(d), cmd: `php -S 127.0.0.1:${P(8000)}` };
  }
  return nodeProc(root, '.', NODE_BACK, 'backend', port);
}

// Sites without a Node dev server: generators, PHP sites and WordPress, plain HTML.
function siteProc(root: string, port?: number): Proc | undefined {
  const d = root, P = (n: number) => port ?? n;
  if ((has(d, 'hugo.toml') || has(d, 'hugo.yaml') || has(d, 'config.toml') && has(d, 'content')) && !has(d, 'package.json')) return { label: 'Hugo', role: 'frontend', cwd: d, port: P(1313), cmd: `hugo server --bind 127.0.0.1 -p ${P(1313)}` };
  if (has(d, '_config.yml') && has(d, 'Gemfile')) return { label: 'Jekyll', role: 'frontend', cwd: d, port: P(4000), setup: ruby(d), cmd: `bundle exec jekyll serve --host 127.0.0.1 --port ${P(4000)}` };
  if (has(d, 'mkdocs.yml')) { const py = python(d, root); return { label: 'MkDocs', role: 'frontend', cwd: d, port: P(8000), setup: py.setup, cmd: `${py.run} -m mkdocs serve -a 127.0.0.1:${P(8000)}` }; }
  if (has(d, 'wp-config.php') || has(d, 'wp-config-sample.php') || has(d, 'wp-content')) return { label: 'WordPress (PHP built-in server: needs its MySQL running)', role: 'frontend', cwd: d, port: P(8000), cmd: `php -S 127.0.0.1:${P(8000)}` };
  if (has(d, 'index.php')) return { label: 'PHP', role: 'frontend', cwd: d, port: P(8000), setup: php(d), cmd: `php -S 127.0.0.1:${P(8000)}` };
  const html = ['.', 'public', 'site', 'www', 'docs', 'dist', 'build', 'src'].find(f => has(path.join(d, f), 'index.html'));
  if (html !== undefined) return { label: 'Static site', role: 'frontend', cwd: path.join(d, html), port: P(8080), cmd: `python3 -m http.server ${P(8080)} --bind 127.0.0.1` };
  return undefined;
}

// Procfile "web:" (Heroku-style): PORT is given to it.
function procfileProc(root: string, port?: number): Proc | undefined {
  const pf = read(path.join(root, 'Procfile.dev')) || read(path.join(root, 'Procfile'));
  const web = /^web:\s*(.+)$/m.exec(pf)?.[1];
  return web ? { label: 'Procfile web', role: 'frontend', cwd: root, port: port ?? 5000, urls: true, cmd: web } : undefined;
}
function makeProc(root: string): Proc | undefined {
  const mk = read(path.join(root, 'Makefile'));
  const target = ['dev', 'run', 'serve', 'start', 'up'].find(t => new RegExp(`^${t}\\s*:`, 'm').test(mk));
  return target ? { label: `make ${target}`, role: 'frontend', cwd: root, urls: true, cmd: `make ${target}` } : undefined;
}

// How to run this project, or undefined when JustCode cannot tell (the modal then offers "Ask Claude").
export function detect(root: string): Plan | undefined {
  const env = { ...readEnv(path.join(root, '.env.example')), ...readEnv(path.join(root, '.env')) };
  const compose = COMPOSE.find(f => has(root, f));
  if (compose) return { kind: 'Docker Compose', compose, procs: [], env };
  const fport = Number(env.FRONTEND_PORT || env.WEB_PORT || env.CLIENT_PORT || env.VITE_PORT) || undefined;
  const pf = procfileProc(root, fport);
  if (pf) return { kind: 'Procfile', procs: [pf], env };
  let front: Proc | undefined;
  for (const rel of FRONT_DIRS) if ((front = nodeProc(root, rel, NODE_FRONT, 'frontend', fport))) break;
  const back = backProc(root, env);
  if (!front && !back) {
    const rootPkg = json(path.join(root, 'package.json'));
    const mono = rootPkg && (rootPkg.workspaces || has(root, 'turbo.json') || has(root, 'nx.json') || has(root, 'pnpm-workspace.yaml'));
    front = (mono ? anyNodeScript(root, '.', 'frontend') : undefined) ?? siteProc(root, fport) ?? anyNodeScript(root, '.', 'frontend');
  }
  const procs = [front, back].filter((p): p is Proc => !!p);
  if (procs.length === 2 && procs[0].cwd === procs[1].cwd && procs[0].cmd === procs[1].cmd) procs.pop();
  if (procs.length) return { kind: procs.map(p => p.label).join(' + '), procs, env };
  const dockerfile = ['Dockerfile', 'dockerfile'].find(f => has(root, f));
  if (dockerfile) return { kind: 'Dockerfile', dockerfile, procs: [], env };
  const mk = makeProc(root);
  return mk ? { kind: mk.label, procs: [mk], env } : undefined;
}

/* ---------- links ---------- */

const NOT_HTTP = new Set([5432, 3306, 6379, 27017, 5672, 11211, 9200, 9300, 1025, 2525, 587, 25, 1433, 1521, 5433, 6380, 4222, 9092, 2181, 15672, 9000, 1883]);
const FRONT_NAME = /front|web|client|ui|site|nginx|caddy|traefik|proxy|^app$|portal|dashboard|admin|wordpress|storefront/i;
const BACK_NAME = /back|api|server|django|rails|laravel|php|node|express|nest|flask|fastapi|uvicorn|gunicorn|spring|^go$|worker/i;

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
      : /mail|smtp|pgadmin|adminer|grafana|prometheus|kibana|flower|minio|rabbit|jaeger|phpmyadmin|redis-?insight|mongo-express/i.test(name) ? 'other'
      : FRONT_NAME.test(name) ? 'frontend' : BACK_NAME.test(name) ? 'backend' : 'other';
    links.push({ label: name || `port ${port}`, url: `http://localhost:${port}`, role });
  }
  // Nothing marked as frontend: the one app service is what the user opens.
  if (!links.some(l => l.role === 'frontend')) { const first = links.find(l => l.role === 'backend') ?? links.find(l => l.role === 'other'); if (first && links.filter(l => l.role !== 'other').length <= 1) first.role = 'frontend'; }
  const order: Record<Role, number> = { frontend: 0, backend: 1, other: 2 };
  return links.sort((a, b) => order[a.role] - order[b.role]);
}

// Local URLs a dev server printed ("Local: http://localhost:5174/", "running at http://127.0.0.1:8000").
export function printedUrls(text: string): string[] {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const seen = new Set<string>();
  for (const m of clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'")\]]*)?/g)) seen.add(`http://localhost:${m[1]}${(m[2] ?? '/').replace(/\/$/, '') || ''}`);
  return [...seen];
}

const portFree = (port: number) => new Promise<boolean>(res => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
  s.listen(port, '127.0.0.1');
});
export async function freePort(want: number, taken: Set<number> = new Set()) {
  for (let p = want; p < want + 50; p++) if (!taken.has(p) && await portFree(p)) return p;
  return want;
}

// Does it answer? Any status under 500, redirects included; a self-signed certificate (local nginx) counts.
export function up(url: string): Promise<boolean> {
  return new Promise(res => {
    let u: URL;
    try { u = new URL(url); } catch { return res(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout: 3000, ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}) }, r => { r.resume(); res((r.statusCode ?? 500) < 500); });
    req.on('timeout', () => { req.destroy(); res(false); }); req.on('error', () => res(false)); req.end();
  });
}

/* ---------- configured addresses: .env URLs and nginx server names ---------- */

const FRONT_KEY = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_)?(APP|FRONTEND|SITE|WEB|CLIENT|BASE|PUBLIC)_?URL$/i;
const BACK_KEY = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_)?(API|BACKEND|SERVER)_?(BASE_?)?URL$/i;
const LOCAL_NAME = /^(_|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::1?)$/i;

// Server names the project's nginx config answers on, and whether it serves them over https.
export function nginxHosts(root: string): { host: string; ssl: boolean }[] {
  const found = new Map<string, boolean>();
  const walk = (d: string, depth: number) => {
    for (const f of files(d)) {
      if (/^(node_modules|\.git|\.justcode|vendor|dist|build|\.venv|venv)$/.test(f)) continue;
      const p = path.join(d, f);
      let st: fs.Stats; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (!/(nginx.*|\.conf|\.conf\.template|\.nginx)$/i.test(f) || st.size > 200_000) continue;
      const text = read(p);
      if (!/server\s*\{/.test(text)) continue;
      for (const block of text.split(/\bserver\s*\{/).slice(1)) {
        const ssl = /listen\s+[^;]*\b443\b|listen\s+[^;]*\bssl\b|ssl_certificate\s/.test(block);
        for (const m of block.matchAll(/server_name\s+([^;]+);/g))
          for (const h of m[1].trim().split(/\s+/)) if (!LOCAL_NAME.test(h) && !/[~$*]/.test(h)) found.set(h, (found.get(h) ?? false) || ssl);
      }
    }
  };
  walk(root, 0);
  return [...found].map(([host, ssl]) => ({ host, ssl }));
}

// Addresses the project itself says it is opened at: .env URL variables, then nginx server names on the published
// http/https ports. A name this machine cannot resolve gets a note on how to reach it.
export async function configuredLinks(root: string, env: Record<string, string>, published: { target: number; port: number; service: string }[]): Promise<AppLink[]> {
  const links: AppLink[] = [];
  const add = (l: AppLink) => { if (!links.some(x => x.url.replace(/\/$/, '') === l.url.replace(/\/$/, ''))) links.push(l); };
  for (const [k, v] of Object.entries(env)) {
    if (!/^https?:\/\//.test(v)) continue;
    if (FRONT_KEY.test(k)) add({ label: k, url: v, role: 'frontend' }); else if (BACK_KEY.test(k)) add({ label: k, url: v, role: 'backend' });
  }
  const web = published.filter(p => p.target === 80 || p.target === 443 || p.target === 8080 || p.target === 8443);
  for (const { host, ssl } of nginxHosts(root)) {
    const tls = web.find(p => p.target === 443 || p.target === 8443), plain = web.find(p => p.target === 80 || p.target === 8080);
    const via = ssl && tls ? { scheme: 'https', p: tls.port, std: 443 } : plain ? { scheme: 'http', p: plain.port, std: 80 } : ssl ? { scheme: 'https', p: 443, std: 443 } : undefined;
    if (via) add({ label: `nginx ${host}`, url: `${via.scheme}://${host}${via.p === via.std ? '' : `:${via.p}`}`, role: 'frontend' });
  }
  for (const l of links) {
    const host = (() => { try { return new URL(l.url).hostname; } catch { return ''; } })();
    if (!host || LOCAL_NAME.test(host)) continue;
    const ok = await new Promise<boolean>(res => dns.lookup(host, e => res(!e)));
    if (!ok) l.note = `${host} does not resolve on this machine: add "127.0.0.1 ${host}" to /etc/hosts`;
    else if (l.url.startsWith('https:')) l.note = 'self-signed? Your browser may ask you to accept the certificate once';
  }
  return links;
}
async function waitUp(links: AppLink[], ms: number, refresh?: () => void) {
  // Done when every link answers, or when a frontend does and the rest had 20 s more (a name that does not resolve
  // must not hold the whole build for minutes).
  const end = Date.now() + ms;
  let frontAt = 0;
  for (;;) {
    refresh?.();
    for (const l of links) if (!l.up) l.up = await up(l.url);
    if (!frontAt && links.some(l => l.role === 'frontend' && l.up)) frontAt = Date.now();
    if (links.every(l => l.up) || (frontAt && Date.now() - frontAt > 20_000) || Date.now() > end) return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/* ---------- start / stop ---------- */

function sh(cmd: string, cwd: string, log: fs.WriteStream, timeout: number, env: NodeJS.ProcessEnv = ENV) {
  return new Promise<void>((resolve, reject) => {
    log.write(`\n$ ${cmd}\n`);
    // Its own process group: a timeout stops the command and everything it started (a hung docker call included).
    const p = spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true });
    p.stdout.on('data', b => log.write(b)); p.stderr.on('data', b => log.write(b));
    const t = setTimeout(() => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } reject(new Error(`${cmd.slice(0, 120)} took longer than ${Math.round(timeout / 60000) || 1} min and was stopped`)); }, timeout);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${cmd.slice(0, 120)} failed (exit ${code}); see the log`)); });
  });
}
const out = (cmd: string, args: string[], cwd: string) => new Promise<string>((res, rej) => execFile(cmd, args, { cwd, env: ENV, timeout: 30_000, maxBuffer: 8 << 20 }, (e, o) => e ? rej(e) : res(o)));
const headOf = (root: string) => out('git', ['rev-parse', '--short', 'HEAD'], root).then(s => s.trim(), () => undefined);
// Is the Docker engine answering? Its socket's /_ping, 3 s at most: a hung `docker info` can never stall a build.
export function pingDocker(): Promise<boolean> {
  const host = process.env.DOCKER_HOST?.startsWith('unix://') ? process.env.DOCKER_HOST.slice(7) : undefined;
  const socks = [host, path.join(os.homedir(), '.docker', 'run', 'docker.sock'), path.join(os.homedir(), '.docker', 'desktop', 'docker.sock'), '/var/run/docker.sock'].filter((s): s is string => !!s && fs.existsSync(s));
  return socks.reduce<Promise<boolean>>((prev, sock) => prev.then(ok => ok || new Promise(res => {
    const req = http.request({ socketPath: sock, path: '/_ping', timeout: 3000 }, r => { r.resume(); res(r.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); res(false); }); req.on('error', () => res(false)); req.end();
  })), Promise.resolve(false));
}
// Docker not running: start Docker Desktop (macOS, Linux desktop) and wait up to 2 minutes for it.
async function dockerUp(root: string, log: fs.WriteStream) {
  log.write('\n$ checking Docker…\n');
  if (await pingDocker()) { log.write('Docker is running.\n'); return; }
  log.write('Docker is not answering: starting Docker Desktop…\n');
  await sh('open -a Docker 2>/dev/null || systemctl --user start docker-desktop 2>/dev/null || true', root, log, 20_000).catch(() => undefined);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await pingDocker()) { log.write('Docker is up.\n'); return; }
    if (i % 5 === 4) log.write(`still waiting for Docker (${(i + 1) * 2} s)…\n`);
  }
  throw new Error('Docker did not answer within 2 minutes. Open Docker Desktop (quit and reopen it if it is stuck), then Rebuild.');
}
const imageName = (root: string) => `justcode-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

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
  if (!plan) { save(root, { state: 'failed', links: [], why, error: 'JustCode could not tell how to run this project. Use "Ask Claude to fix it": Claude sets it up and starts it.' }); return; }
  fs.mkdirSync(dir(root), { recursive: true });
  const log = fs.createWriteStream(logFile(root), { flags: 'w' });
  log.write(`# ${plan.kind} · ${new Date().toISOString()} · ${why}\n`);
  // The steps the modal lists, with a live timer and the log's last line: refreshed every 1.5 s while it builds.
  const steps = plan.compose ? ['Check that Docker is running', 'Build and start the containers', 'Find the links', 'Wait until it answers']
    : plan.dockerfile ? ['Check that Docker is running', 'Build the image', 'Start the container', 'Wait until it answers']
    : ['Install dependencies and prepare', `Start ${plan.procs.map(p => p.label).join(' and ')}`, 'Find the links', 'Wait until it answers'];
  const step = (i: number) => save(root, { ...load(root), stepNo: i, stepAt: Date.now() });
  const tick = setInterval(() => appEvents.emit('change', root), 1500);
  save(root, { ...old, state: 'building', kind: plan.kind, why, error: undefined, steps, stepNo: 0, stepAt: Date.now(), buildAt: Date.now(), links: [] });
  killAll(old.pids);
  if (old.container) await out('docker', ['rm', '-f', old.container], root).catch(() => '');
  try {
    let links: AppLink[] = [];
    let pids: number[] | undefined, container: string | undefined;
    const printed = new Map<Proc, string>();   // each process's output, for the URL it prints
    if (!has(root, '.env') && has(root, '.env.example')) fs.copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    if (plan.compose) {
      await dockerUp(root, log);
      step(1);
      const upCmd = `docker compose -f ${plan.compose} up -d --build --remove-orphans`;
      try { await sh(upCmd, root, log, 20 * 60_000); } catch (e) {
        // Compose breakages Docker does not repair itself (a container pointing at a network that is gone, a name
        // still taken, an orphan): take the project's containers down (volumes and data stay) and try once more.
        const tail = read(logFile(root)).slice(-4000);
        if (!/network [0-9a-f]+ not found|failed to set up container networking|is already in use by container|No such container|orphan|Conflict\. The container name|endpoint .* already exists|has active endpoints/i.test(tail)) throw e;
        log.write('\nDocker left stale containers or networks behind: recreating them (your data volumes stay)…\n');
        await sh(`docker compose -f ${plan.compose} down --remove-orphans`, root, log, 5 * 60_000).catch(() => undefined);
        await sh(`${upCmd} --force-recreate`, root, log, 20 * 60_000);
      }
      step(2);
      const ps = parsePs(await out('docker', ['compose', '-f', plan.compose, 'ps', '--format', 'json'], root)), env = readEnv(path.join(root, '.env'));
      const published = ps.flatMap(c => (c.Publishers ?? []).filter(p => p.PublishedPort).map(p => ({ target: p.TargetPort ?? 0, port: p.PublishedPort!, service: c.Service })));
      // The project's own addresses (nginx server names, .env URLs) come first; the localhost ports stay listed after them.
      const named = await configuredLinks(root, env, published);
      const local = composeLinks(ps, env);
      if (named.some(l => l.role === 'frontend')) for (const l of local) if (l.role === 'frontend') l.role = 'other';
      links = [...named, ...local.filter(l => !named.some(n => n.url.replace(/\/$/, '') === l.url))];
    } else if (plan.dockerfile) {
      // A lone Dockerfile: build it and publish the port it EXPOSEs on the same port (or the next free one).
      await dockerUp(root, log);
      const img = imageName(root), expose = Number(/^\s*EXPOSE\s+(\d+)/mi.exec(read(path.join(root, plan.dockerfile)))?.[1]) || 8080;
      const host = await freePort(expose);
      step(1);
      await sh(`docker build -t ${img} -f ${plan.dockerfile} .`, root, log, 20 * 60_000);
      step(2);
      container = img;
      await sh(`docker rm -f ${img} >/dev/null 2>&1; docker run -d --name ${img} -p 127.0.0.1:${host}:${expose}${has(root, '.env') ? ' --env-file .env' : ''} ${img}`, root, log, 120_000);
      links = [{ label: 'container', url: `http://localhost:${host}`, role: 'frontend' }];
      setTimeout(() => void out('docker', ['logs', '--tail', '200', img], root).then(t => fs.appendFileSync(logFile(root), `\n${t}`), () => undefined), 20_000).unref?.();
    } else {
      pids = [];
      const taken = new Set<number>();
      for (const p of plan.procs) for (const cmd of p.setup ?? []) await sh(cmd, p.cwd, log, 15 * 60_000);
      step(1);
      for (const p of plan.procs) {
        // The wanted port may be taken (another project, an old run): the next free one, so the link is right.
        const want = p.port;
        if (p.port) { p.port = await freePort(p.port, taken); taken.add(p.port); }
        const env = { ...ENV, ...(p.port ? { PORT: String(p.port) } : {}) };
        const cmd = want && p.port !== want ? p.cmd.replace(new RegExp(`\\b${want}\\b`, 'g'), String(p.port)) : p.cmd;
        log.write(`\n$ (${p.label}) ${cmd}\n`);
        const child = spawn('/bin/sh', ['-c', cmd], { cwd: p.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        printed.set(p, '');
        const take = (b: Buffer) => { log.write(b); const t = printed.get(p)! + b.toString(); printed.set(p, t.slice(-20_000)); };
        child.stdout?.on('data', take); child.stderr?.on('data', take);
        child.unref();
        if (child.pid) pids.push(child.pid);
        if (p.port) links.push({ label: p.label, url: `http://localhost:${p.port}`, role: p.role });
      }
    }
    // Processes that print their URL (dev scripts, monorepos, make, Procfile): their links come from the output.
    const refresh = () => {
      for (const [p, text] of printed) {
        if (!p.urls && p.port) continue;
        const urls = printedUrls(text);
        if (!urls.length) continue;
        const mine = links.filter(l => l.label === p.label);
        if (p.port && mine.length === 1) { if (mine[0].url !== urls[0]) { mine[0].url = urls[0]; mine[0].up = false; } continue; }
        for (const [i, u] of urls.entries()) if (!links.some(l => l.url === u)) links.push({ label: urls.length > 1 ? `${p.label} ${i + 1}` : p.label, url: u, role: i === 0 && !links.some(l => l.role === 'frontend') ? 'frontend' : p.role === 'backend' ? 'backend' : 'other' });
      }
    };
    if (!plan.compose) step(plan.dockerfile ? 3 : 2);
    if (printed.size) { const end = Date.now() + 90_000; while (!links.length && Date.now() < end) { refresh(); await new Promise(r => setTimeout(r, 1500)); } }
    if (!plan.compose) {
      const named = await configuredLinks(root, readEnv(path.join(root, '.env')), []);
      if (named.length) { if (named.some(l => l.role === 'frontend')) for (const l of links) if (l.role === 'frontend') l.role = 'other'; links.unshift(...named.filter(n => !links.some(l => l.url === n.url))); }
    }
    // A backend-only app (Django templates, Rails, Laravel…) is what the user opens.
    if (links.length && !links.some(l => l.role === 'frontend')) links[0].role = 'frontend';
    if (!links.length) throw new Error('It started, but JustCode found no web address (no published port and none printed). See the log, or use "Ask Claude to fix it".');
    const head = await headOf(root);
    save(root, { ...load(root), state: 'building', kind: plan.kind, links, pids, container, why, startedAt: Date.now(), head, stepNo: steps.length - 1, stepAt: Date.now() });
    // Each link shows "answers" as soon as it does.
    await waitUp(links, 5 * 60_000, () => { refresh(); save(root, { ...load(root), links: links.map(l => ({ ...l })) }); });
    const front = links.find(l => l.role === 'frontend' && l.up) ?? links.find(l => l.role === 'frontend') ?? links[0];
    save(root, { ...load(root), state: front.up ? 'running' : 'failed', kind: plan.kind, links, pids, container, why, startedAt: Date.now(), head,
      error: front.up ? undefined : `${front.url} does not answer after 5 minutes. The log says why; "Ask Claude to fix it" can repair the setup.` });
  } catch (e: any) {
    save(root, { ...load(root), state: 'failed', error: String(e?.message ?? e) });   // stepNo stays on the step that failed
  } finally { clearInterval(tick); log.end(); }
}

export async function stop(root: string) {
  const s = load(root), plan = detect(root);
  if (plan?.compose) await out('docker', ['compose', '-f', plan.compose, 'stop'], root).catch(() => '');
  if (s.container) await out('docker', ['rm', '-f', s.container], root).catch(() => '');
  killAll(s.pids);
  save(root, { ...s, state: 'stopped', pids: undefined, container: undefined, links: s.links.map(l => ({ ...l, up: false })) });
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
