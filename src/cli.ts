#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { adb } from './claude';
import { execFileSync } from 'child_process';

// JustCode CLI:
//   node cli.js screenshot <out.png> [--serial id]   saves the Android device's screen (adb screencap) without a
//                                     shell redirect, which unattended Claude sessions are not allowed to use

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
  console.log('Usage: cli.js screenshot <out.png> [--serial id]');
  return cmd ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
