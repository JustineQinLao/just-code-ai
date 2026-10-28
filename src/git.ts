import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Every task works on its own branch in its own worktree (<project>/.justcode/worktrees/<id>),
// so the user's checkout is never switched and parallel tasks never share files.
// The branch is the "PR": reviewed and merged from the board, only on the user's approval.

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trimEnd();
  } catch (e: any) {
    throw new Error(`git ${args[0]}: ${String(e.stderr || e.message).trim()}`);
  }
}
const ok = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

export const isRepo = (dir: string) => ok(dir, ['rev-parse', '--git-dir']);
export const hasCommits = (dir: string) => ok(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
export const hasRemote = async (dir: string) => !!(await git(dir, ['remote']).catch(() => ''));
export const currentBranch = (dir: string) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

// Keeps .justcode/ (board, worktrees) out of git without touching the tracked .gitignore.
// fresh: a repo JustCode just created, which also gets the usual secrets/deps excluded before its first commit.
// Never committed by JustCode, unless the project's .gitignore already decides about them.
const PROTECT = ['node_modules/', '.env', '.env.*', '!.env.example', '.DS_Store', '*.vsix', '.claude/settings.local.json'];

async function exclude(repo: string, _fresh: boolean) {
  const file = path.join(path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let ignore = '';
  try { ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'); } catch { /* none */ }
  const mentioned = (p: string) => ignore.split('\n').some(l => l.trim().replace(/^!/, '').replace(/^\//, '') === p.replace(/^!/, ''));
  const want = ['/.justcode/', ...PROTECT.filter(p => !mentioned(p))]
    .filter(l => !cur.split('\n').includes(l));
  if (!want.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${want.join('\n')}\n`);
}

// Local repo when there is none (no remote is added). Worktrees need a first commit to branch from.
export async function ensureRepo(dir: string) {
  const fresh = !await isRepo(dir);
  if (fresh) await git(dir, ['init', '-q']);
  await exclude(dir, fresh);
  if (!await hasCommits(dir)) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '--allow-empty', '-m', 'chore: initial commit (JustCode)']);
  }
}

const MAX_FILE = 10 * 1024 * 1024;

// Commits the main folder's uncommitted work on its current branch, so a task's worktree (cut from that branch)
// has the same files. Secrets and deps stay out (see PROTECT), and files over 10 MB are never committed.
// Returns the committed paths and the ones left out for size.
export async function snapshot(repo: string) {
  await exclude(repo, false);
  if (!(await git(repo, ['status', '--porcelain'])).trim()) return { files: [] as string[], skipped: [] as string[] };
  await git(repo, ['add', '-A']);
  const staged = (await git(repo, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  const skipped = staged.filter(f => { try { return fs.statSync(path.join(repo, f)).size > MAX_FILE; } catch { return false; } });
  if (skipped.length) await git(repo, ['reset', '-q', '--', ...skipped]);
  const files = staged.filter(f => !skipped.includes(f));
  if (files.length) await git(repo, ['commit', '-q', '-m', 'chore: snapshot project files for JustCode tasks']);
  return { files, skipped };
}

// Brings `base` into a worktree that is behind it and has no work of its own in progress. true = updated.
export async function catchUp(dir: string, base: string) {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  if ((await git(dir, ['status', '--porcelain'])).trim()) return false;
  if (await ok(dir, ['merge-base', '--is-ancestor', base, 'HEAD'])) return false; // already has it
  await git(dir, ['merge', '--no-edit', '-q', base]);
  return true;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
export const taskBranch = (title: string, id: string) => `jc/${slug(title)}-${id}`;
export const worktreeDir = (repo: string, id: string) => path.join(repo, '.justcode', 'worktrees', id);

export async function addWorktree(repo: string, dir: string, branch: string, base: string) {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  const exists = await ok(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
}

// Only this one worktree; never `git worktree prune` (would drop the user's own temporarily-missing worktrees).
export async function removeWorktree(repo: string, dir: string) {
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  const listed = (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${real}`);
  if (listed) await git(repo, ['worktree', 'remove', '--force', dir]);
  else fs.rmSync(dir, { recursive: true, force: true });
}

// Commits whatever the task's session changed. false = nothing to commit.
export async function commitAll(dir: string, message: string) {
  await git(dir, ['add', '-A']);
  if (await ok(dir, ['diff', '--cached', '--quiet'])) return false;
  await git(dir, ['commit', '-q', '-m', message]);
  return true;
}

export interface Change { status: string; file: string }

// What the PR changes: base...branch, like a PR view, plus anything not committed yet.
export async function changes(dir: string, base: string): Promise<Change[]> {
  const out = await git(dir, ['diff', '--name-status', `${base}...HEAD`]);
  const pending = await git(dir, ['status', '--porcelain']);
  const list = out.split('\n').filter(Boolean).map(l => { const [s, ...f] = l.split('\t'); return { status: s[0], file: f[f.length - 1] }; });
  for (const l of pending.split('\n').filter(Boolean)) {
    const file = l.slice(3).split(' -> ').pop()!;
    if (!list.some(c => c.file === file)) list.push({ status: l.slice(0, 2).trim()[0] === '?' ? 'A' : l.slice(0, 2).trim()[0], file });
  }
  return list;
}

export const mergeBase = (dir: string, base: string) => git(dir, ['merge-base', base, 'HEAD']);
export const show = (dir: string, ref: string, file: string) => git(dir, ['show', `${ref}:${file}`]).catch(() => '');
export const conflicted = async (dir: string) => (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
export const merging = (dir: string) => ok(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);

// Step 1 of a merge: bring the latest base into the task branch, inside the task's worktree.
// Conflicts are left in place there (never in the user's checkout) to resolve before anything reaches base.
export async function syncWithBase(dir: string, base: string): Promise<string[]> {
  try {
    await git(dir, ['merge', '--no-edit', base]);
    return [];
  } catch (e) {
    const files = await conflicted(dir);
    if (!files.length) throw e;
    return files;
  }
}

// Conflict markers left in files the user (or Claude) marked resolved.
export function markersLeft(dir: string, files: string[]) {
  return files.filter(f => {
    try { return /^(<{7}|>{7}) /m.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; }
  });
}

export async function finishResolve(dir: string) {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '--no-edit']);
}

// Step 2: the branch now contains base, so merging it into base cannot conflict.
// Base checked out in the main folder: a normal --no-ff merge there (git refuses if local edits would be overwritten).
// Otherwise the merge commit is built without a checkout and base is moved only if it hasn't moved meanwhile.
export async function mergeIntoBase(repo: string, base: string, branch: string, message: string) {
  if (await currentBranch(repo) === base) {
    await git(repo, ['merge', '--no-ff', '-m', message, branch]);
    return;
  }
  const old = await git(repo, ['rev-parse', `refs/heads/${base}`]);
  if (!await ok(repo, ['merge-base', '--is-ancestor', old, branch])) throw new Error(`${base} moved; run Merge again`);
  const tree = await git(repo, ['rev-parse', `${branch}^{tree}`]);
  const commit = await git(repo, ['commit-tree', tree, '-p', old, '-p', branch, '-m', message]);
  await git(repo, ['update-ref', `refs/heads/${base}`, commit, old]);
}

export const deleteBranch = (repo: string, branch: string) => git(repo, ['branch', '-D', branch]);

// Optional remote PR: push the task branch and open a GitHub PR with gh.
export async function openRemotePr(dir: string, base: string, branch: string, title: string, body: string) {
  await git(dir, ['push', '-u', 'origin', branch]);
  try {
    return (await exec('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { cwd: dir })).stdout.trim().split('\n').pop()!;
  } catch (e: any) {
    throw new Error(e.code === 'ENOENT' ? 'Branch pushed. Install the GitHub CLI (gh) to open the PR from here.' : `gh pr create: ${String(e.stderr || e.message).trim()}`);
  }
}
