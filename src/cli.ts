#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { findTasksFile, formatResult, syncTasks } from './tasksmd';
import { adb } from './claude';
import { execFileSync } from 'child_process';

// JustCode CLI, used by the just-code-ai-sync skill:
//   node cli.js sync [projectRoot] [--dry-run] [--file path/to/TASKS.md]
//   node cli.js screenshot <out.png> [--serial id]   saves the Android device's screen (adb screencap) without a
//                                     shell redirect, which unattended Claude sessions are not allowed to use
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

function screenshot(out: string | undefined, serial?: string) {
  if (!out) { console.error('Usage: cli.js screenshot <out.png> [--serial id]'); return 1; }
  const a = adb();
  if (!a) { console.error('adb not found (PATH, ANDROID_HOME, ~/Library/Android/sdk).'); return 2; }
  const id = serial ?? a.devices[0];
  if (!id) { console.error('No Android device or emulator connected (adb devices is empty).'); return 2; }
  const png = execFileSync(a.bin, ['-s', id, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) { console.error(`adb returned no PNG (${png.length} bytes).`); return 3; }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`Saved ${path.resolve(out)} (${id}, ${png.length} bytes). Read it to see the screen.`);
  return 0;
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === 'screenshot') {
    const si = rest.indexOf('--serial');
    return screenshot(rest.find((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1)), si >= 0 ? rest[si + 1] : undefined);
  }
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
