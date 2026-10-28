#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { findTasksFile, formatResult, syncTasks } from './tasksmd';

// JustCode CLI, used by the just-code-ai-sync skill:
//   node cli.js sync [projectRoot] [--dry-run] [--file path/to/TASKS.md]

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'sync') {
    console.log('Usage: cli.js sync [projectRoot] [--dry-run] [--file TASKS.md]');
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
