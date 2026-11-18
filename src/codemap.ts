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

const run = (bin: string, args: string[], cwd: string, timeout: number) => new Promise<string>((res, rej) =>
  execFile(bin, args, { cwd, timeout, maxBuffer: 16 << 20, env: { ...process.env, GRAPHIFY_BACKEND: 'none' } }, (e, out, err) => e ? rej(new Error(String(err || e.message).trim().split('\n').pop())) : res(String(out))));

export function version(): Promise<string | undefined> {
  const b = bins().graphify;
  return b ? run(b, ['--version'], os.homedir(), 10_000).then(o => o.trim().replace(/^graphify\s*/, ''), () => undefined) : Promise.resolve(undefined);
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
    try {
      await run(b, ['extract', dir, '--code-only', '--out', path.join(dir, '.justcode'), '--no-viz'], dir, 10 * 60_000);
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

// Everything a session needs in one call: a map for its folder (seeded, refreshing in the background) and the options.
export function forSession(dir: string, root: string, on: boolean) {
  if (!on || !bins().graphify) return { allowed: [] as string[] };
  seed(dir, root);
  void refresh(dir);
  return sessionOptions(dir, true);
}

// What a session gets: allow rules for the read-only map commands and how to use them, or nothing (Graphify not
// installed, or no map yet). The commands, not Graphify's MCP server: that needs an extra many installs lack.
export function sessionOptions(dir: string, on: boolean): { allowed: string[]; rule?: string } {
  const b = on ? bins().graphify : undefined;
  if (!b || !fs.existsSync(graphFile(dir))) return { allowed: [] };
  const cmd = /\s/.test(b) ? `"${b}"` : b, g = `--graph "${graphFile(dir)}"`;
  return {
    allowed: ['query', 'explain', 'path', 'affected', 'god-nodes'].map(c => `Bash(${cmd} ${c}:*)`),
    rule: 'A code map of this project is ready: its functions, classes, imports and calls. Ask it first where something lives and what depends on it, ' +
      'then Read only the files you need, instead of searching file by file:\n' +
      `- ${cmd} query "<question>" ${g} --budget 1500\n- ${cmd} explain "<name>" ${g}\n- ${cmd} path "<A>" "<B>" ${g}\n- ${cmd} affected "<name>" ${g}  (what a change to it can break)\n` +
      'Its file paths are relative to the .justcode folder of your working folder (../src/a.ts is src/a.ts). It maps this folder as of its last commit and is refreshed after each of your turns: edits you made in this turn are not in it yet.',
  };
}

export function stats(dir: string): { nodes: number; edges: number } | undefined {
  try { const g = JSON.parse(fs.readFileSync(graphFile(dir), 'utf8')); return { nodes: (g.nodes ?? []).length, edges: (g.links ?? g.edges ?? []).length }; } catch { return undefined; }
}
