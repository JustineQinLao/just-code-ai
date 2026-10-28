import * as fs from 'fs';
import * as path from 'path';
import { claudeAuth, claudeVersion, gitIdentity, gitVersion } from './claude';
import { isRepo } from './git';

// The setup checklist the board shows until everything a task needs is in place. Each failed check has one fix
// the board can do (or start) for you.

export interface Check {
  id: 'claude' | 'login' | 'git' | 'identity' | 'repo';
  ok: boolean;
  label: string;
  detail: string;
  fix?: { action: string; label: string };
  optional?: boolean;       // the board works without it (it is done for you on the first run)
}

export interface SetupState { checks: Check[]; ready: boolean; remote: boolean; at: number }

export async function checkSetup(bin: string | undefined, env: Record<string, string>, root: string | undefined, apiKey: boolean): Promise<SetupState> {
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

  return { checks, ready: checks.every(c => c.ok || c.optional), remote, at: Date.now() };
}

export const installCommand = () => process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

// Has this project any Claude setup of its own (agents, skills, CLAUDE.md)? None is needed; the board says what it adds.
export function projectSetup(root: string) {
  const has = (p: string) => { try { return fs.readdirSync(path.join(root, p)).length > 0; } catch { return false; } };
  return { agents: has('.claude/agents'), skills: has('.claude/skills'), claudeMd: fs.existsSync(path.join(root, 'CLAUDE.md')), tasksMd: fs.existsSync(path.join(root, 'TASKS.md')) };
}
