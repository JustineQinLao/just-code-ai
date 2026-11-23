import * as fs from 'fs';
import * as path from 'path';
import * as g from './git';
import type { OutsideFile } from './store';

// Files Claude edits outside the project folder and the task's own folder: a sibling repo (a deploy repo, a docs
// repo), a config file elsewhere. git in the task's folder never sees them, so without this the card says
// "finished without changing project files" and Finish leaves them uncommitted. They are tracked by absolute path,
// with the git repo that holds them (if any), and committed in that repo on Finish.

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

// Under `dir` (or `dir` itself), comparing real paths so /tmp and /private/tmp agree.
export function isInside(file: string, dir: string) {
  const rel = path.relative(real(dir), real(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The git repo that holds `file` (its folder may be new): the nearest existing folder's top level, or none.
export async function repoOf(file: string): Promise<string | undefined> {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try { return (await g.git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined; } catch { return undefined; }
}

// git's view of one outside file: '' = unchanged, else the porcelain status letters ('??' for new).
async function status(o: OutsideFile) {
  if (!o.repo) return fs.existsSync(o.file) ? 'M' : '';
  return (await g.git(o.repo, ['status', '--porcelain', '--', path.relative(o.repo, o.file)]).catch(() => '')).slice(0, 2).trim();
}

// The task's outside files after a turn: earlier ones plus this turn's edits that are not under `roots` (the project
// and the task's folder), keeping only files that are still changed (an edit that was undone drops off).
export async function outsideEdits(edited: string[], roots: string[], prev: OutsideFile[] = []): Promise<OutsideFile[]> {
  const all = new Map(prev.map(o => [o.file, o] as const));
  for (const file of edited) {
    if (!path.isAbsolute(file) || roots.some(r => isInside(file, r)) || all.has(file)) continue;
    all.set(file, { file, repo: await repoOf(file) });
  }
  const out: OutsideFile[] = [];
  for (const o of all.values()) if (await status(o)) out.push(o);
  return out;
}

// For the Changes tab: each outside file, shown relative to the project folder (../other-repo/README.md).
export async function outsideChanges(root: string, files: OutsideFile[]): Promise<g.Change[]> {
  const list: g.Change[] = [];
  for (const o of files) {
    const s = await status(o);
    if (s) list.push({ status: s.startsWith('?') ? 'A' : s[0], file: path.relative(root, o.file), outside: true });
  }
  return list;
}

// The outside file a Changes-tab path names (as outsideChanges wrote it), if it is one of the task's.
export function findOutside(root: string, files: OutsideFile[] | undefined, shown: string) {
  return (files ?? []).find(o => path.relative(root, o.file) === shown);
}

// Finish: one commit per repo with exactly the task's files there. Files in no git repo are left as they are.
export async function commitOutside(files: OutsideFile[], message: string, secretScan: boolean) {
  const byRepo = new Map<string, string[]>();
  const loose: string[] = [];
  for (const o of files) {
    if (!o.repo) { loose.push(o.file); continue; }
    byRepo.set(o.repo, [...(byRepo.get(o.repo) ?? []), path.relative(o.repo, o.file)]);
  }
  const committed: string[] = [];
  for (const [repo, rel] of byRepo) if (await g.commitFiles(repo, message, rel, secretScan)) committed.push(repo);
  return { committed, loose };
}
