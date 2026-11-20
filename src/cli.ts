#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { adb } from './claude';
import { parseMeasure, diffMeasures } from './designdiff';
import { capture, parseJobs, diffAll, loadSample } from './designcapture';
import { execFileSync } from 'child_process';

// JustCode CLI:
//   node cli.js screenshot <out.png> [--serial id]   Android only: saves the Android device's screen (adb screencap) without a
//                                     shell redirect, which unattended Claude sessions are not allowed to use
//   node cli.js design-diff <design.json> <app.json> [<out.txt>]   differences between two design measures (see designdiff.ts)
//   node cli.js design-css <measure.json>   writes the measure's CSS rules to <measure>.css, beside it
//   node cli.js design-capture <jobs.json>  every screenshot + measure (+ .css) of a design or app in one run (designcapture.ts)
//   node cli.js design-diff --all <designDir> <appDir> <outDir> [--sample file]   every pair compared, a .diff.txt each,
//                                     a summary and shared.txt (sample.json beside outDir is used by default)

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

function designDiff(design?: string, app?: string, out?: string) {
  if (!design || !app) { console.error('Usage: cli.js design-diff <design.json> <app.json> [<out.txt>]'); return 1; }
  const lines = diffMeasures(parseMeasure(fs.readFileSync(design, 'utf8')), parseMeasure(fs.readFileSync(app, 'utf8')));
  const text = lines.length ? lines.join('\n') : 'No differences.';
  if (out) fs.writeFileSync(out, text + '\n');
  console.log(text);
  return 0;
}

function designCss(file?: string) {
  if (!file) { console.error('Usage: cli.js design-css <measure.json>'); return 1; }
  const css = parseMeasure(fs.readFileSync(file, 'utf8')).css ?? '';
  const out = file.replace(/\.json$/i, '') + '.css';
  fs.writeFileSync(out, css + '\n');
  console.log(`Saved ${out} (${css.split('\n').filter(Boolean).length} rules).`);
  return 0;
}

function main(argv: string[]): number | undefined {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'design-diff' && rest[0] === '--all') {
      if (rest.length < 4) { console.error('Usage: cli.js design-diff --all <designDir> <appDir> <outDir>'); return 1; }
      const si = rest.indexOf('--sample'), sample = loadSample(si > 0 ? rest[si + 1] : path.join(rest[3], '..', 'sample.json'));
      const { rows, shared, avgPx } = diffAll(rest[1], rest[2], rest[3], sample);
      console.log(rows.length ? rows.map(r => `${r.name}: ${r.n ? `${r.n} difference${r.n === 1 ? '' : 's'}` : 'matches'}${r.px !== undefined ? `, ${r.px}% pixels` : ''}`).join('\n') : 'No screen measured on both sides (same <id>-<width>.json names).');
      if (avgPx !== undefined) console.log(`\nAverage pixels differing: ${avgPx}%`);
      if (shared.length) console.log(`\nShared (same rule on ${shared[0].screens.length >= 3 ? '3+' : 'several'} screens, see shared.txt):\n${shared.slice(0, 15).map(x => `${x.rule}  (${x.screens.length} screens)`).join('\n')}`);
      return 0;
    }
    if (cmd === 'design-diff') return designDiff(rest[0], rest[1], rest[2]);
    if (cmd === 'design-css') return designCss(rest[0]);
  } catch (e: any) { console.error(e.message); return 2; }
  if (cmd === 'design-capture') {
    if (!rest[0]) { console.error('Usage: cli.js design-capture <jobs.json>'); return 1; }
    let jobs; try { jobs = parseJobs(fs.readFileSync(rest[0], 'utf8')); } catch (e: any) { console.error(e.message); return 1; }
    capture(jobs).then(r => {
      console.log(`Done: ${r.done} captured, ${r.failed.length} failed.${r.failed.length ? '\n' + r.failed.join('\n') : ''}`);
      process.exitCode = r.failed.length ? 3 : 0;
    }, e => { console.error(e.message); process.exitCode = 2; });
    return undefined;
  }
  if (cmd === 'screenshot') {
    const si = rest.indexOf('--serial');
    return screenshot(rest.find((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1)), si >= 0 ? rest[si + 1] : undefined);
  }
  console.log('Usage: cli.js screenshot <out.png> [--serial id]  (Android device screen only; use the Playwright MCP for web pages)\n       cli.js design-diff <design.json> <app.json> [<out.txt>]\n       cli.js design-css <measure.json>');
  return cmd ? 1 : 0;
}

const code = main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
