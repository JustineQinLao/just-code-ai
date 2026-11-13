import * as fs from 'fs';
import * as path from 'path';
import { claudeAuth, claudeVersion, gitIdentity, gitVersion, installedPlugin } from './claude';
import { isRepo } from './git';

// The setup checklist the board shows until everything a task needs is in place. Each failed check has one fix
// the board can do (or start) for you.

export interface Check {
  id: 'claude' | 'login' | 'git' | 'identity' | 'repo' | 'frontendDesign' | 'superpowers' | 'playwright' | 'designMd';
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
export const MARKETPLACE: Record<string, string> = { 'frontend-design': 'claude-plugins-official', superpowers: 'superpowers-marketplace' };
export const pluginInstallCommands = (bin: string, name: string) => [
  ...(name === 'superpowers' ? [`${bin} plugin marketplace add obra/superpowers-marketplace`] : []),
  `${bin} plugin install ${name}@${MARKETPLACE[name] ?? 'claude-plugins-official'}`];
export const playwrightCommand = (bin: string) => `${bin} mcp add playwright -- npx @playwright/mcp@latest`;
// Shown if the CLI route fails: the same steps typed inside Claude Code.
export const SUPERPOWERS_FALLBACK = ['/plugin marketplace add obra/superpowers-marketplace', '/plugin install superpowers@superpowers-marketplace'];
