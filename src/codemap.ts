import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

// 🗺 Code map: Graphify (github.com/Graphify-Labs/graphify, free and local) turns code into a graph of its functions,
// classes, imports and calls. Sessions query it (graphify query, explain, path, affected) instead of grepping and
// reading file after file. JustCode runs it its own way, so nothing lands outside .justcode/: no `graphify install`
// (that writes CLAUDE.md and .claude/ hooks), code only (tree-sitter, no model, no API key).
// One map per folder Claude works in, kept at <folder>/.justcode/graphify-out/:
// - the project folder (direct tasks, chats, the planner), whatever branch it has checked out;
// - each task's own folder (.justcode/worktrees/<id>, on its branch cut from the sprint branch or the base), so a
//   sprint task sees the work already merged into its sprint and its own commits. A new folder starts from a copy of
//   the project's map (usable at once) and is then brought up to its branch; it goes away with the folder.
// A map is rebuilt when its folder's commit changes (each turn's work is committed when the turn ends); a stale map
// is used meanwhile. Graphify skips .justcode/, so the project map holds no copies of task folders.
// Flags checked against graphify 0.9.16: `extract <path> --code-only --out <dir> --no-viz`, `query|explain|path|affected --graph`.

export const mapDir = (dir: string) => path.join(dir, '.justcode', 'graphify-out');
export const graphFile = (dir: string) => path.join(mapDir(dir), 'graph.json');
const headFile = (dir: string) => path.join(mapDir(dir), '.jc-head');
export const INSTALL = 'uv tool install graphifyy';
export const INSTALL_PIPX = 'pipx install graphifyy';

// VS Code started from the Dock does not get the shell's PATH: also look where uv, pipx and Homebrew put tools.
function find(name: string): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (d && fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
}
export const bins = () => ({ graphify: find('graphify') });

// Run from inside the map's own folder with GRAPHIFY_OUT pointing there: anything Graphify writes by default (cache,
// reports) lands in .justcode/graphify-out, never in a graphify-out/ in the code, where a task commit would pick it up.
const run = (bin: string, args: string[], out: string, timeout: number) => {
  fs.mkdirSync(out, { recursive: true });
  return new Promise<string>((res, rej) =>
    execFile(bin, args, { cwd: out, timeout, maxBuffer: 16 << 20, env: { ...process.env, GRAPHIFY_BACKEND: 'none', GRAPHIFY_OUT: out } }, (e, o, err) => e ? rej(new Error(String(err || e.message).trim().split('\n').pop())) : res(String(o))));
};

export function version(): Promise<string | undefined> {
  const b = bins().graphify;
  return b ? run(b, ['--version'], path.join(os.tmpdir(), 'justcode-graphify'), 10_000).then(o => o.trim().replace(/^graphify\s*/, ''), () => undefined) : Promise.resolve(undefined);
}

const head = (root: string) => new Promise<string>(res => execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (e, out) => res(e ? '' : String(out).trim())));
const building = new Map<string, Promise<boolean>>();

// Builds (or refreshes) a folder's map when it is missing or older than the folder's commit. One build per folder at
// a time; Graphify's cache makes a refresh quick. Never throws: no map just means Claude searches as before.
export function refresh(dir: string, force = false): Promise<boolean> {
  const b = bins().graphify;
  if (!b || !fs.existsSync(dir)) return Promise.resolve(false);
  const running = building.get(dir);
  if (running) return running;
  const p = (async () => {
    const now = await head(dir);
    let was = '';
    try { was = fs.readFileSync(headFile(dir), 'utf8').trim(); } catch { /* never built */ }
    if (!force && fs.existsSync(graphFile(dir)) && now && now === was) return true;
    if (!now) return false;   // not a git folder (or git failed): nothing to tie the map to
    try {
      await run(b, ['extract', dir, '--code-only', '--out', path.join(dir, '.justcode'), '--no-viz'], mapDir(dir), 10 * 60_000);
      fs.writeFileSync(headFile(dir), now);
      return true;
    } catch { return false; }
  })().finally(() => building.delete(dir));
  building.set(dir, p);
  return p;
}

// A task folder with no map yet starts from a copy of the project's (same layout, so its paths read the same), marked
// stale so the next refresh brings it up to the folder's branch. Returns whether the folder now has a map.
export function seed(dir: string, root: string): boolean {
  if (fs.existsSync(graphFile(dir))) return true;
  if (dir === root || !fs.existsSync(graphFile(root))) return false;
  try {
    fs.cpSync(mapDir(root), mapDir(dir), { recursive: true });
    fs.rmSync(headFile(dir), { force: true });
    return true;
  } catch { return false; }
}

// Everything a session needs in one call: its folder's map brought up to the folder's commit first (a task folder
// starts from a copy of the project's map, whose cache makes this quick), then the options. A copy of the project's
// map is never handed over as is: the project folder can be on another branch (main without the sprint's work), so
// that map would point Claude at code the task does not have. No map within `wait`: the session searches as before.
export async function forSession(dir: string, root: string, on: boolean, wait = 90_000) {
  if (!on || !bins().graphify) return { allowed: [] as string[] };
  seed(dir, root);
  const ready = await Promise.race([refresh(dir), new Promise<boolean>(r => setTimeout(() => r(false), wait).unref?.())]);
  return ready && current(dir) ? sessionOptions(dir, true) : { allowed: [] as string[] };
}

// Whether a folder's map was built from the commit it has checked out now.
function current(dir: string) {
  try { return fs.readFileSync(headFile(dir), 'utf8').trim() !== ''; } catch { return false; }
}

// What a session gets: allow rules for the read-only map commands and how to use them, or nothing (Graphify not
// installed, or no map yet). The commands, not Graphify's MCP server: that needs an extra many installs lack.
export function sessionOptions(dir: string, on: boolean): { allowed: string[]; rule?: string } {
  const b = on ? bins().graphify : undefined;
  if (!b || !fs.existsSync(graphFile(dir))) return { allowed: [] };
  const cmd = /\s/.test(b) ? `"${b}"` : b, g = `--graph "${graphFile(dir)}"`;
  return {
    allowed: ['query', 'explain', 'path', 'affected'].map(c => `Bash(${cmd} ${c}:*)`),
    rule: 'A code map of this project is ready: its functions, classes, imports and calls. Ask it first where something lives and what depends on it, ' +
      'then Read only the files you need, instead of searching file by file:\n' +
      `- ${cmd} query "<question>" ${g} --budget 1500\n- ${cmd} explain "<name>" ${g}\n- ${cmd} path "<A>" "<B>" ${g}\n- ${cmd} affected "<name>" ${g}  (what a change to it can break)\n` +
      'Its file paths are relative to the .justcode folder of your working folder (../src/a.ts is src/a.ts). It maps this folder as of its last commit and is refreshed after each of your turns: edits you made in this turn are not in it yet.',
  };
}

// JustCode asks the map itself (sessions rarely call it on their own): the files and names most related to the task,
// as a short list for the brief. Graph paths are relative to <folder>/.justcode, so "../src/a.ts" is "src/a.ts".
export async function lookFirst(dir: string, question: string, max = 12): Promise<string | undefined> {
  const b = bins().graphify;
  if (!b || !fs.existsSync(graphFile(dir)) || !question.trim() || !big(dir)) return;
  try {
    const out = await run(b, ['query', question.slice(0, 300), '--graph', graphFile(dir), '--budget', '800'], mapDir(dir), 20_000);
    return looksAt(out, max);
  } catch { return; }
}
export function looksAt(out: string, max = 12): string | undefined {
  const files = new Map<string, Set<string>>();
  for (const m of out.matchAll(/^NODE (.+?) \[src=([^ \]]+)/gm)) {
    const f = m[2].replace(/^\.\.\//, '');
    if (!files.has(f)) files.set(f, new Set());
    if (m[1] !== path.basename(f)) files.get(f)!.add(m[1]);
  }
  if (!files.size) return;
  return [...files].slice(0, max).map(([f, names]) => `- ${f}${names.size ? `: ${[...names].slice(0, 4).join(', ')}` : ''}`).join('\n');
}

// Below this size a project is quick to read directly, and the map's lists would only add text: JustCode's own map
// lookups (planner, tasks, reviews) start here.
export const MIN_NODES = 500;
export const big = (dir: string) => (stats(dir)?.nodes ?? 0) >= MIN_NODES;

const rel = (p: string) => p.replace(/^\.\.\//, '');

// The functions and classes a diff adds, removes or changes: names on changed definition lines and in hunk headers
// (git puts the enclosing function there).
export function changedNames(diff: string, max = 8): string[] {
  const names = new Set<string>();
  const def = /(?:\bdef|\bclass|\bfunction|\binterface|\benum)\s+([A-Za-z_$][\w$]*)|(?:\bconst|\blet)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/;
  for (const line of diff.split('\n')) {
    const text = line.startsWith('@@') ? line.replace(/^@@[^@]*@@/, '') : /^[+-](?![+-])/.test(line) ? line.slice(1) : '';
    const m = def.exec(text);
    const n = m?.[1] ?? m?.[2];
    if (n && n.length > 2 && !/^(test|setUp|tearDown|Meta|main)$/.test(n) && !/^test_/.test(n)) names.add(n);
    if (names.size >= max) break;
  }
  return [...names];
}

// What else uses what a change touched, outside the changed files: for the reviewer, so a break in a caller is checked
// without searching for callers.
export async function impact(dir: string, diff: string, max = 15): Promise<string | undefined> {
  const b = bins().graphify;
  if (!b || !fs.existsSync(graphFile(dir)) || !big(dir)) return;
  const changed = new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]));
  const lines: string[] = [];
  for (const name of changedNames(diff)) {
    let out = '';
    try { out = await run(b, ['affected', name, '--graph', graphFile(dir), '--depth', '1'], mapDir(dir), 20_000); } catch { continue; }
    const users = [...out.matchAll(/^- (.+?) \[(\w+)\] (\S+?):L(\d+)$/gm)].map(m => ({ label: m[1], file: rel(m[3]), line: m[4] }))
      .filter(u => !changed.has(u.file));
    if (users.length) lines.push(`- ${name}: ${users.slice(0, 5).map(u => `${u.file}:${u.line} ${u.label}`).join('; ')}${users.length > 5 ? ` (+${users.length - 5} more)` : ''}`);
    if (lines.length >= max) break;
  }
  return lines.length ? lines.join('\n') : undefined;
}

// A short picture of the project for the planner: its main folders and its most connected code (what much else
// depends on), from the map itself.
export function overview(dir: string, top = 12): string | undefined {
  let g: any;
  try { g = JSON.parse(fs.readFileSync(graphFile(dir), 'utf8')); } catch { return; }
  const nodes: any[] = g.nodes ?? [], edges: any[] = g.links ?? g.edges ?? [];
  if (nodes.length < MIN_NODES) return;
  const deg = new Map<string, number>();
  for (const e of edges) for (const k of [e.source, e.target]) { const id = typeof k === 'object' ? k?.id : k; if (id) deg.set(id, (deg.get(id) ?? 0) + 1); }
  const isFile = (n: any) => /\.\w+$/.test(n.label ?? '');
  const folders = new Map<string, number>();
  for (const n of nodes) { const f = rel(n.source_file ?? ''); if (!f) continue; const parts = f.split('/'); const k = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0]; folders.set(k, (folders.get(k) ?? 0) + 1); }
  const isTest = (n: any) => /(^|\/)(tests?|__tests__|spec)(\/|\.)|[._-](test|spec)\.\w+$|test_\w+\.py$/.test(rel(n.source_file ?? ''));
  const hubs = nodes.filter(n => !isFile(n) && n.source_file && !isTest(n) && !String(n.label).startsWith('.')).sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, top);
  return `Main folders (items mapped): ${[...folders].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, n]) => `${f} (${n})`).join(', ')}\n` +
    `Most connected code (much else depends on it):\n${hubs.map(n => `- ${n.label} (${rel(n.source_file)}:${String(n.source_location ?? '').replace(/^L/, '')})`).join('\n')}`;
}

export function stats(dir: string): { nodes: number; edges: number } | undefined {
  try { const g = JSON.parse(fs.readFileSync(graphFile(dir), 'utf8')); return { nodes: (g.nodes ?? []).length, edges: (g.links ?? g.edges ?? []).length }; } catch { return undefined; }
}
