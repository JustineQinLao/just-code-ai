import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Every task works on its own branch in its own worktree (<project>/.justcode/worktrees/<id>),
// so the user's checkout is never switched and parallel tasks never share files.
// The branch is the "PR": reviewed and merged from the board, only on the user's approval.

const exec = promisify(execFile);

// Never waits on a prompt (credentials, GPG passphrase, editor): it fails instead, with git's message, after at most 2 minutes.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };

export async function git(cwd: string, args: string[]) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: GIT_ENV })).stdout.trimEnd();
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('git is not installed. Install it from https://git-scm.com, then try again.');
    const msg = String(e.stderr || e.message).trim();
    if (/Please tell me who you are|empty ident/i.test(msg)) throw new Error('git needs your name and email before it can commit. Open JustCode: Check Setup to set them.');
    // git's progress lines ("Preparing worktree ...") arrive on stderr too; only the failure is worth showing.
    const failure = msg.split('\n').filter(l => !/^Preparing worktree/.test(l)).join('\n');
    throw new Error(`git ${args[0]}: ${failure}`);
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
const PROTECT = ['node_modules/', 'node_modules', '.env', '.env.*', '!.env.example', '.DS_Store', '*.vsix', '.claude/settings.local.json',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', 'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc',
  'credentials*.json', 'service-account*.json', '*.tfstate', '*.tfstate.*', '.venv/', 'venv/', '__pycache__/', '.terraform/'];

// extra: more paths to keep out of git (the files copied into task copies, justCode.worktreeCopy).
export async function exclude(repo: string, _fresh: boolean, extra: string[] = []) {
  const file = path.join(path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let ignore = '';
  try { ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'); } catch { /* none */ }
  const mentioned = (p: string) => ignore.split('\n').some(l => l.trim().replace(/^!/, '').replace(/^\//, '') === p.replace(/^!/, ''));
  const want = ['/.justcode/', ...[...PROTECT, ...extra.filter(e => e && !e.includes('..'))].filter(p => !mentioned(p))]
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
// A merge, rebase or cherry-pick in progress, or unmerged paths: the folder is mid-operation and must not be committed.
export async function midOperation(repo: string): Promise<string | undefined> {
  for (const [ref, what] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    if (await ok(repo, ['rev-parse', '-q', '--verify', ref])) return what;
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const p = (await git(repo, ['rev-parse', '--git-path', d]).catch(() => '')).trim();
    if (p && fs.existsSync(path.resolve(repo, p))) return 'rebase';
  }
  if ((await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim()) return 'merge';
}

export async function snapshot(repo: string) {
  const busy = await midOperation(repo);
  if (busy) throw new Error(`Your project folder is in the middle of a ${busy}. Finish or abort it first; JustCode will not commit over it.`);
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
  try {
    await git(dir, ['merge', '--no-edit', '-q', base]);
  } catch (e) {
    // Never leave a half-done merge (with conflict markers) in a task's worktree: Merge on the card handles conflicts.
    await git(dir, ['merge', '--abort']).catch(() => {});
    throw e;
  }
  return true;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
export const taskBranch = (title: string, id: string) => `jc/${slug(title)}-${id}`;
export const sprintBranch = (name: string, id: string) => `jc/sprint-${slug(name)}-${id}`;
export const branchExists = (repo: string, branch: string) => ok(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
export const worktreeDir = (repo: string, id: string) => path.join(repo, '.justcode', 'worktrees', id);

export async function addWorktree(repo: string, dir: string, branch: string, base: string) {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  // A folder without .git is not a worktree: what is left after one was removed while a process still wrote into it
  // (build output, test caches). Clear it, and git's record of it, so the task can start again. That process may
  // still be writing and put the folder back, so "already exists" is tried again before it reaches the card.
  for (let attempt = 0; ; attempt++) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      await ok(repo, ['worktree', 'prune']);
    }
    const exists = await ok(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    try {
      await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
      return;
    } catch (e: any) {
      if (attempt >= 4 || !/already exists/.test(e.message)) throw e;
      await new Promise(res => setTimeout(res, 500));
    }
  }
}

// Uncommitted files in the project folder (what a task's copy would not have). Ignored files don't count.
// Files git tracks or would add, plus their folders, for the @ menu. Folders end in /.
export async function projectFiles(repo: string, cap = 20_000) {
  const files = (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => '')).split('\0').filter(Boolean);
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  return [...dirs, ...new Set(files)].slice(0, cap);
}

export async function dirtyFiles(repo: string) {
  await exclude(repo, false);
  return (await git(repo, ['status', '--porcelain'])).split('\n').filter(Boolean).map(l => l.slice(3).split(' -> ').pop()!);
}

// Task copies under .justcode/worktrees whose task is gone (deleted from another window, a crash mid-delete,
// board.json edited by hand). Clean ones are removed with their jc/ branch; one with uncommitted work is kept and reported.
export async function pruneOrphans(repo: string, keep: Set<string>): Promise<{ removed: string[]; kept: string[] }> {
  const dir = path.join(repo, '.justcode', 'worktrees');
  let ids: string[];
  try { ids = fs.readdirSync(dir).filter(d => !keep.has(d)); } catch { return { removed: [], kept: [] }; }
  const removed: string[] = [], kept: string[] = [];
  for (const id of ids) {
    const wt = path.join(dir, id);
    const dirty = fs.existsSync(path.join(wt, '.git')) && (await git(wt, ['status', '--porcelain']).catch(() => '')).trim();
    if (dirty) { kept.push(id); continue; }
    const branch = fs.existsSync(path.join(wt, '.git')) ? await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '') : '';
    await removeWorktree(repo, wt).catch(() => undefined);
    if (branch.startsWith('jc/') && await ok(repo, ['merge-base', '--is-ancestor', branch, 'HEAD'])) await deleteBranch(repo, branch).catch(() => undefined);
    removed.push(id);
  }
  return { removed, kept };
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
  // Unresolved conflicts: committing now would put the markers on the branch.
  if ((await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim()) return false;
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

// Direct tasks: what changed in the checkout since `startHead`, limited to `files` (the task's directFiles).
// Untracked files are included (as new files); nothing is staged.
async function untracked(dir: string, files: string[]) {
  if (!files.length) return [] as string[];
  return (await git(dir, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...files]).catch(() => '')).split('\0').filter(Boolean);
}
export async function workingChanges(dir: string, startHead: string, files: string[]): Promise<Change[]> {
  if (!files.length) return [];
  const out = await git(dir, ['diff', '--name-status', startHead || 'HEAD', '--', ...files]).catch(() => '');
  const list = out.split('\n').filter(Boolean).map(l => { const [s, ...f] = l.split('\t'); return { status: s[0], file: f[f.length - 1] }; });
  for (const file of await untracked(dir, files)) if (!list.some(c => c.file === file)) list.push({ status: 'A', file });
  return list;
}
export async function workingDiff(dir: string, startHead: string, files: string[]): Promise<string> {
  if (!files.length) return '';
  let diff = await git(dir, ['diff', startHead || 'HEAD', '--', ...files]).catch(() => '');
  for (const file of await untracked(dir, files)) {
    let body = '';
    try { const b = fs.readFileSync(path.join(dir, file)); body = b.includes(0) ? '' : b.toString('utf8'); } catch { continue; }
    const lines = body ? body.replace(/\n$/, '').split('\n') : [];
    diff += `${diff ? '\n' : ''}diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n` +
      (lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l).join('\n')}` : '');
  }
  return diff;
}

// A merged task's branch and folder are gone; its merge commit ("Merge <branch>: <title>") still says what it changed.
export async function mergeCommit(repo: string, branch: string) {
  return (await git(repo, ['log', '--all', '--merges', '--fixed-strings', `--grep=Merge ${branch}: `, '-1', '--format=%H']).catch(() => '')).trim() || undefined;
}
export async function mergedChanges(repo: string, branch: string): Promise<Change[]> {
  const sha = await mergeCommit(repo, branch);
  if (!sha) return [];
  const out = await git(repo, ['diff', '--name-status', `${sha}^1`, sha]).catch(() => '');
  return out.split('\n').filter(Boolean).map(l => { const [s, ...f] = l.split('\t'); return { status: s[0], file: f[f.length - 1] }; });
}

export const mergeBase = (dir: string, base: string) => git(dir, ['merge-base', base, 'HEAD']);
export const show = (dir: string, ref: string, file: string) =>
  exec('git', ['show', `${ref}:${file}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout, () => '');
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
  // Moving a branch that another worktree has checked out would leave that worktree's files stale.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  let where: string | undefined;
  for (const block of (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n')) {
    const lines = block.split('\n');
    if (lines.includes(`branch refs/heads/${base}`)) where = lines.find(l => l.startsWith('worktree '))?.slice(9);
  }
  if (where && real(where) !== real(repo)) throw new Error(`${base} is checked out in ${where}. Switch that folder to another branch, then merge again.`);
  const old = await git(repo, ['rev-parse', `refs/heads/${base}`]);
  if (!await ok(repo, ['merge-base', '--is-ancestor', old, branch])) throw new Error(`${base} moved; run Merge again`);
  const tree = await git(repo, ['rev-parse', `${branch}^{tree}`]);
  const commit = await git(repo, ['commit-tree', tree, '-p', old, '-p', branch, '-m', message]);
  await git(repo, ['update-ref', `refs/heads/${base}`, commit, old]);
}

// Merges `branch` into `target` without ever leaving a half-done merge in the user's checkout: the result is worked
// out first (git merge-tree), and on conflicts nothing changes and the conflicting files are returned.
export async function mergeBranch(repo: string, target: string, branch: string, message: string): Promise<string[]> {
  if (await ok(repo, ['merge-base', '--is-ancestor', branch, target])) return []; // already in
  const tree = await exec('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, branch], { cwd: repo, env: GIT_ENV })
    .then(r => ({ ok: true, out: r.stdout }), (e: any) => ({ ok: false, out: String(e.stdout ?? ''), err: String(e.stderr || e.message) }));
  const lines = tree.out.split('\n').filter(Boolean);
  if (!tree.ok) {
    if (!lines.length) throw new Error(`git merge-tree: ${(tree as any).err.trim()}`);
    return [...new Set(lines.slice(1))];
  }
  if (await currentBranch(repo) === target) { await git(repo, ['merge', '--no-ff', '-m', message, branch]); return []; }
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  for (const block of (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n')) {
    const where = block.split('\n').includes(`branch refs/heads/${target}`) && block.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
    if (where && real(where) !== real(repo)) throw new Error(`${target} is checked out in ${where}. Switch that folder to another branch, then merge again.`);
  }
  const old = await git(repo, ['rev-parse', `refs/heads/${target}`]);
  const commit = await git(repo, ['commit-tree', lines[0], '-p', old, '-p', branch, '-m', message]);
  await git(repo, ['update-ref', `refs/heads/${target}`, commit, old]);
  return [];
}

// Gitignored env files a task needs to run tests (a worktree only has committed files). They stay out of git
// (see PROTECT); existing files in the worktree are never overwritten. Returns what was copied.
export function copyEnvFiles(repo: string, worktree: string, names: string[]) {
  const copied: string[] = [];
  for (const n of names) {
    if (!n || n.includes('..') || path.isAbsolute(n)) continue;
    const from = path.join(repo, n), to = path.join(worktree, n);
    try {
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(n);
    } catch { /* not there */ }
  }
  return copied;
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
