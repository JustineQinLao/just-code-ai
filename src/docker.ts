import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Docker Compose stacks that tasks start in their own folders (docker compose -p <id> up). Nothing else stops them:
// left running they hold Docker's networks ("all predefined address pools have been fully subnetted") and keep
// writing into a folder JustCode is removing. Every call is best effort: no Docker, no stacks, nothing to do.

const exec = promisify(execFile);
const ENV = { ...process.env, PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.docker', 'bin')].filter(Boolean).join(path.delimiter) };
const docker = (args: string[], timeout: number) => exec('docker', args, { timeout, env: ENV, maxBuffer: 8 * 1024 * 1024 }).then(r => r.stdout);

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (file: string, dir: string) => { const f = real(path.dirname(file)), d = real(dir); return f === d || f.startsWith(d + path.sep); };

// Compose projects whose config file lies in `dir` (or below), running or stopped.
export async function stacksIn(dir: string): Promise<string[]> {
  let list: { Name: string; ConfigFiles?: string }[] = [];
  try { list = JSON.parse(await docker(['compose', 'ls', '-a', '--format', 'json'], 15_000) || '[]'); } catch { return []; }
  return list.filter(p => (p.ConfigFiles ?? '').split(',').some(f => f && inside(f, dir))).map(p => p.Name);
}

// Stops and removes them, with their networks and volumes (a task's database is as disposable as its folder).
export async function stopStacksIn(dir: string) {
  const names = await stacksIn(dir);
  for (const n of names) await docker(['compose', '-p', n, 'down', '-v', '--remove-orphans', '--timeout', '5'], 120_000).catch(() => undefined);
  return names;
}

type Stack = { Name: string; ConfigFiles?: string };
export const staleStacks = (list: Stack[], root: string, live: string[]) => {
  const base = path.join(root, '.justcode', 'worktrees');
  return list.filter(p => (p.ConfigFiles ?? '').split(',').some(f => f && inside(f, base) && !live.some(k => inside(f, k))));
};

// Stacks started from task folders under <root>/.justcode/worktrees that no task uses any more (merged, discarded,
// deleted while the window was closed). Stacks of the project folder itself, or of live tasks, are left alone.
export async function sweepStacks(root: string, live: string[]) {
  let list: Stack[] = [];
  try { list = JSON.parse(await docker(['compose', 'ls', '-a', '--format', 'json'], 15_000) || '[]'); } catch { return []; }
  const stale = staleStacks(list, root, live);
  for (const p of stale) await docker(['compose', '-p', p.Name, 'down', '-v', '--remove-orphans', '--timeout', '5'], 120_000).catch(() => undefined);
  return stale.map(p => p.Name);
}
