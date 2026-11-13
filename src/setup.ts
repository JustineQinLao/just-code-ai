import * as fs from 'fs';
import * as path from 'path';
import { claudeAuth, claudeVersion, gitIdentity, gitVersion, installedPlugin } from './claude';
import { isRepo } from './git';

// The setup checklist the board shows until everything a task needs is in place. Each failed check has one fix
// the board can do (or start) for you.

export interface Check {
  id: 'claude' | 'login' | 'git' | 'identity' | 'repo' | 'frontendDesign' | 'superpowers' | 'playwright' | 'designMd'
    | 'board' | 'policy' | 'registry' | 'worktrees' | 'sources' | 'transcripts';
  ok: boolean;
  label: string;
  detail: string;
  fix?: { action: string; label: string };
  optional?: boolean;       // the board works without it (it is done for you on the first run)
}

export interface SetupState { checks: Check[]; ready: boolean; remote: boolean; at: number }

export async function checkSetup(bin: string | undefined, env: Record<string, string>, root: string | undefined, apiKey: boolean,
  lookup: { plugin: (name: string) => string | undefined; designMd: (root: string) => boolean } = { plugin: n => installedPlugin(n), designMd: r => projectSetup(r).designMd }): Promise<SetupState> {
  const checks: Check[] = [];
  const version = bin ? await claudeVersion(bin) : undefined;
  checks.push(version
    ? { id: 'claude', ok: true, label: 'Claude Code installed', detail: `v${version} · ${bin}` }
    : { id: 'claude', ok: false, label: 'Claude Code installed', detail: bin ? `${bin} does not run.` : 'The claude command was not found.',
        fix: { action: 'installClaude', label: 'Install Claude Code' } });

  let remote = false;
  if (version) {
    const auth = await claudeAuth(bin!, env);
    remote = auth.loggedIn && auth.method === 'claude.ai' && !apiKey;
    checks.push(auth.loggedIn || apiKey
      ? { id: 'login', ok: true, label: 'Signed in', detail: apiKey ? 'Using your Anthropic API key (Remote Control needs a claude.ai login).' : `${auth.method === 'claude.ai' ? 'Claude account' : auth.method ?? 'Signed in'}${auth.email ? ` · ${auth.email}` : ''}` }
      : { id: 'login', ok: false, label: 'Signed in', detail: 'Claude Code is not signed in.', fix: { action: 'login', label: 'Sign in' } });
  } else {
    checks.push({ id: 'login', ok: false, label: 'Signed in', detail: 'Install Claude Code first.' });
  }

  const gv = await gitVersion();
  checks.push(gv
    ? { id: 'git', ok: true, label: 'git installed', detail: `v${gv}` }
    : { id: 'git', ok: false, label: 'git installed', detail: 'git gives every task its own branch.', fix: { action: 'installGit', label: 'Get git' } });

  if (gv) {
    const who = await gitIdentity(root);
    checks.push(who
      ? { id: 'identity', ok: true, label: 'git name and email', detail: who }
      : { id: 'identity', ok: false, label: 'git name and email', detail: 'Needed to commit each task\'s work.', fix: { action: 'gitIdentity', label: 'Set name and email' } });
  }

  if (root && gv) {
    const repo = await isRepo(root);
    checks.push(repo
      ? { id: 'repo', ok: true, label: 'Project is a git repository', detail: path.basename(root) }
      : { id: 'repo', ok: false, optional: true, label: 'Project is a git repository', detail: `${path.basename(root)} has no repository yet. JustCode can create a local one (asked on the first run).`,
          fix: { action: 'gitInit', label: 'Create it now' } });
  }

  const rec = (id: Check['id'], label: string, ok: boolean, detail: string, fix: Check['fix']) =>
    checks.push({ id, ok, optional: true, label: `Recommended: ${label}`, detail: ok ? 'Installed' : detail, ...(ok ? {} : { fix }) });
  rec('frontendDesign', 'frontend-design plugin', !!lookup.plugin('frontend-design'), 'Gives page and artifact tasks a deliberate visual design.', { action: 'installPlugin:frontend-design', label: 'Install' });
  rec('superpowers', 'superpowers plugin', !!lookup.plugin('superpowers'), 'Planning, debugging and review skills.', { action: 'installPlugin:superpowers', label: 'Install' });
  rec('playwright', 'Playwright', !!lookup.plugin('playwright'), 'Lets Claude open pages in a browser to check UI work.', { action: 'installPlaywright', label: 'Install' });
  if (root) rec('designMd', 'DESIGN.md', lookup.designMd(root), 'A design brief (.justcode/design/DESIGN.md) keeps UI work consistent.', { action: 'createDesignMd', label: 'Create' });

  return { checks, ready: checks.every(c => c.ok || c.optional), remote, at: Date.now() };
}

export const installCommand = () => process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

// Has the project a description (.justcode/project.md) and, optionally, a design (.justcode/design/DESIGN.md)?
export function projectSetup(root: string) {
  return { projectMd: fs.existsSync(path.join(root, '.justcode', 'project.md')), designMd: fs.existsSync(path.join(root, '.justcode', 'design', 'DESIGN.md')) };
}

// Terminal commands for the Recommended installs. Superpowers is not in the official marketplace, so it adds its own first.
export const MARKETPLACE: Record<string, string> = { 'frontend-design': 'claude-plugins-official', superpowers: 'superpowers-marketplace', playwright: 'claude-plugins-official' };
export const pluginInstallCommands = (bin: string, name: string) => [
  ...(name === 'superpowers' ? [`${bin} plugin marketplace add obra/superpowers-marketplace`] : []),
  `${bin} plugin install ${name}@${MARKETPLACE[name] ?? 'claude-plugins-official'}`];
// Playwright is installed as a plugin, so the same lookup that detects it (installed_plugins.json) sees the result.
export const playwrightCommand = (bin: string) => pluginInstallCommands(bin, 'playwright').join(' && ');
// Shown if the CLI route fails: the same steps typed inside Claude Code.
export const SUPERPOWERS_FALLBACK = ['/plugin marketplace add obra/superpowers-marketplace', '/plugin install superpowers@superpowers-marketplace'];

/* ---------- health: the project's JustCode files ---------- */

// Problems in the project's .justcode/ files, each a checklist row with one fix. Only problems are returned.
export interface HealthInput {
  root: string;
  taskIds: Set<string>;
  worktrees: Set<string>;            // folder names under .justcode/worktrees that a task uses (plus the baseline)
  staleSources: string[];            // artifact sources whose saved copy is missing or older than the refresh setting
  unarchived: string[];              // tasks whose transcript Claude Code still has but .justcode does not
}
export function checkHealth(h: HealthInput, policyErrors: string[]): Check[] {
  const out: Check[] = [];
  const jc = (...p: string[]) => path.join(h.root, '.justcode', ...p);
  const problem = (id: Check['id'], label: string, detail: string, fix: Check['fix']) => out.push({ id, ok: false, optional: true, label, detail, fix });
  // board.json: readable, and every task has an id, a title and a known status.
  try {
    const b = JSON.parse(fs.readFileSync(jc('board.json'), 'utf8'));
    const bad = (Array.isArray(b?.tasks) ? b.tasks : [null]).filter((t: any) => !t || typeof t.id !== 'string' || typeof t.title !== 'string' || !['todo', 'doing', 'review', 'done'].includes(t.status));
    const ids = (b?.tasks ?? []).map((t: any) => t?.id), dup = ids.filter((x: any, i: number) => ids.indexOf(x) !== i);
    if (bad.length || dup.length || !Array.isArray(b?.sprints)) problem('board', 'Board file', `.justcode/board.json has ${[bad.length && `${bad.length} broken task(s)`, dup.length && `duplicate ids (${dup.slice(0, 3).join(', ')})`, !Array.isArray(b?.sprints) && 'no sprint list'].filter(Boolean).join(', ')}.`, { action: 'openJustcodeFile:board.json', label: 'Open board.json' });
  } catch (e: any) {
    if (e?.code !== 'ENOENT') problem('board', 'Board file', `.justcode/board.json cannot be read (${String(e.message).slice(0, 100)}).`, { action: 'openJustcodeFile:board.json', label: 'Open board.json' });
  }
  if (policyErrors.length) problem('policy', 'Policy file', `.justcode/policy.json: ${policyErrors.join('; ')}. The defaults apply for those fields.`, { action: 'openPolicy', label: 'Open policy.json' });
  // artifacts.json: a list, and every task it names still exists.
  try {
    const list = JSON.parse(fs.readFileSync(jc('artifacts.json'), 'utf8'));
    if (!Array.isArray(list) || list.some((e: any) => !e || typeof e.url !== 'string' || !Array.isArray(e.taskIds))) problem('registry', 'Artifact registry', '.justcode/artifacts.json is not a valid artifact list.', { action: 'resetRegistry', label: 'Reset registry' });
    else {
      const gone = new Set(list.flatMap((e: any) => e.taskIds.filter((t: string) => !h.taskIds.has(t))));
      if (gone.size) problem('registry', 'Artifact registry', `.justcode/artifacts.json links ${gone.size} task(s) that no longer exist.`, { action: 'pruneRegistry', label: 'Remove the stale links' });
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') problem('registry', 'Artifact registry', `.justcode/artifacts.json cannot be read (${String(e.message).slice(0, 100)}).`, { action: 'resetRegistry', label: 'Reset registry' });
  }
  let orphans: string[] = [];
  try { orphans = fs.readdirSync(jc('worktrees')).filter(d => !h.worktrees.has(d)); } catch { /* none */ }
  if (orphans.length) problem('worktrees', 'Leftover task folders', `.justcode/worktrees has ${orphans.length} folder(s) no task uses: ${orphans.slice(0, 4).join(', ')}${orphans.length > 4 ? '…' : ''}. They may hold uncommitted work.`, { action: 'deleteOrphans', label: 'Delete them…' });
  if (h.staleSources.length) problem('sources', 'Artifact sources', `${h.staleSources.length} claude.ai source(s) have no recent saved copy, so tasks read an old version or none.`, { action: 'refreshSources', label: 'Save copies now' });
  if (h.unarchived.length) problem('transcripts', 'Task transcripts', `${h.unarchived.length} task(s) have no transcript under .justcode yet; it is lost when Claude Code's session store is cleared.`, { action: 'archiveTranscripts', label: 'Archive now' });
  return out;
}
