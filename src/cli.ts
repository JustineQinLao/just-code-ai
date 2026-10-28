#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { findTasksFile, formatResult, syncTasks } from './tasksmd';

// JustCode CLI, used by the just-code-ai-sync skill:
//   node cli.js sync [projectRoot] [--dry-run] [--file path/to/TASKS.md]
//   node cli.js setup [projectRoot]   copies drafts from .justcode/setup/ into .claude/ (Claude Code asks before
//                                     every write into .claude/, so the init skill drafts there and this installs)

// Copies .justcode/setup/** to .claude/**, skipping files that already exist, then removes the drafts.
function setup(root: string) {
  const from = path.join(root, '.justcode', 'setup');
  if (!fs.existsSync(from)) { console.error(`Nothing to install: ${from} does not exist.`); return 2; }
  const installed: string[] = [], kept: string[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, d.name);
      if (d.isDirectory()) { walk(src); continue; }
      const rel = path.relative(from, src), dest = path.join(root, '.claude', rel);
      if (fs.existsSync(dest)) { kept.push(rel); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      installed.push(rel);
    }
  };
  walk(from);
  fs.rmSync(from, { recursive: true, force: true });
  console.log([`Installed into .claude/ (${installed.length}):`, ...installed.map(f => `  - ${f}`),
    ...(kept.length ? [`Kept existing (${kept.length}):`, ...kept.map(f => `  - ${f}`)] : [])].join('\n'));
  return 0;
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === 'setup') return setup(path.resolve(rest.find(a => !a.startsWith('--')) ?? process.cwd()));
  if (cmd !== 'sync') {
    console.log('Usage: cli.js sync [projectRoot] [--dry-run] [--file TASKS.md]\n       cli.js setup [projectRoot]');
    return cmd ? 1 : 0;
  }
  const dryRun = rest.includes('--dry-run');
  const fi = rest.indexOf('--file');
  const fileArg = fi >= 0 ? rest[fi + 1] : undefined;
  const root = path.resolve(rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--file') ?? process.cwd());
  if (!fs.existsSync(root)) { console.error(`No such folder: ${root}`); return 1; }
  const file = fileArg ? path.resolve(root, fileArg) : findTasksFile(root);
  if (!file || !fs.existsSync(file)) { console.error(`No TASKS.md found in ${root}. Create one (## Sprint 1 / ## Backlog with - [ ] items) or pass --file.`); return 2; }
  console.log(formatResult(syncTasks(new Store(root), file, dryRun), dryRun));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
