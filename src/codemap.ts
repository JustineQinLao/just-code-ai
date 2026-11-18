import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

// 🗺 Code map: Graphify (github.com/Graphify-Labs/graphify, free and local) turns the project's code into a graph of
// its functions, classes, imports and calls. Tasks query it (graphify query, explain, path, affected) instead of
// grepping and reading file after file. JustCode runs it its own way, so nothing lands outside .justcode/: no
// `graphify install` (that writes CLAUDE.md and .claude/ hooks), code only (tree-sitter, no model, no API key), output
// in .justcode/graphify-out/. Rebuilt when the project folder's commit changes; a stale map is used while it rebuilds.
// Flags checked against graphify 0.9.16: `extract <path> --code-only --out <dir> --no-viz`, `query|explain|path|affected --graph`.

export const mapDir = (root: string) => path.join(root, '.justcode', 'graphify-out');
export const graphFile = (root: string) => path.join(mapDir(root), 'graph.json');
const headFile = (root: string) => path.join(mapDir(root), '.jc-head');
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

// Builds (or refreshes) the map when it is missing or older than the folder's commit. One build per project at a time;
// Graphify's cache makes a refresh quick. Never throws: no map just means tasks search as before.
export function refresh(root: string, force = false): Promise<boolean> {
  const b = bins().graphify;
  if (!b) return Promise.resolve(false);
  const running = building.get(root);
  if (running) return running;
  const p = (async () => {
    const now = await head(root);
    let was = '';
    try { was = fs.readFileSync(headFile(root), 'utf8').trim(); } catch { /* never built */ }
    if (!force && fs.existsSync(graphFile(root)) && now && now === was) return true;
    try {
      await run(b, ['extract', root, '--code-only', '--out', path.join(root, '.justcode'), '--no-viz'], root, 10 * 60_000);
      fs.writeFileSync(headFile(root), now);
      return true;
    } catch { return false; }
  })().finally(() => building.delete(root));
  building.set(root, p);
  return p;
}

// What a session gets: allow rules for the read-only map commands and how to use them, or nothing (Graphify not
// installed, or no map yet). The commands, not Graphify's MCP server: that needs an extra many installs lack.
export function sessionOptions(root: string, on: boolean): { allowed: string[]; rule?: string } {
  const b = on ? bins().graphify : undefined;
  if (!b || !fs.existsSync(graphFile(root))) return { allowed: [] };
  const cmd = /\s/.test(b) ? `"${b}"` : b, g = `--graph "${graphFile(root)}"`;
  return {
    allowed: ['query', 'explain', 'path', 'affected', 'god-nodes'].map(c => `Bash(${cmd} ${c}:*)`),
    rule: 'A code map of this project is ready: its functions, classes, imports and calls. Ask it first where something lives and what depends on it, ' +
      'then Read only the files you need, instead of searching file by file:\n' +
      `- ${cmd} query "<question>" ${g} --budget 1500\n- ${cmd} explain "<name>" ${g}\n- ${cmd} path "<A>" "<B>" ${g}\n- ${cmd} affected "<name>" ${g}  (what a change to it can break)\n` +
      'Its file paths are relative to the .justcode folder (../src/a.ts is src/a.ts), and it maps the project as last committed: your own edits are not in it.',
  };
}

export function stats(root: string): { nodes: number; edges: number } | undefined {
  try { const g = JSON.parse(fs.readFileSync(graphFile(root), 'utf8')); return { nodes: (g.nodes ?? []).length, edges: (g.links ?? g.edges ?? []).length }; } catch { return undefined; }
}
