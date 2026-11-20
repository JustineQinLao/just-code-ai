import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { PNG } from 'pngjs';
import { SHOT_CODE, MEASURE_FN } from './skill';
import { parseMeasure, diffItems, Diff, usableSample, MEASURE_V } from './designdiff';

// `cli.js design-capture <jobs.json>`: every screenshot and measure of a design or an app in ONE command, so an audit
// of many screens is not hundreds of tool calls (which sessions give up on, or auto mode blocks as a script). It drives
// the same pinned Playwright MCP the sessions use, with the same SHOT_CODE and MEASURE_FN, over stdio.
//
// jobs.json: { "groups": [ { "setup"?: "async (page) => { ...sign in... }", "shots": [ { "url", "width", "png", "json" } ] } ] }
// Each group starts signed out (cookies and storage cleared), runs its setup once, then its shots in order.
// Writes each png, json (the measure) and, beside the json, its .css (the CSS rules the page uses).

export interface Shot { url: string; width: number; png: string; json: string }
// extract: code run once that returns [{ name, html }] (e.g. every screen of a gallery as a standalone page); each is
// written to <dir>/<name>.html before the group's shots, so splitting a design is one command too.
export interface Extract { code: string; dir: string }
export interface Group { setup?: string; extract?: Extract; shots: Shot[] }
export interface Jobs { groups: Group[] }

export const MCP_ARGS = ['-y', '@playwright/mcp@0.0.85', '--headless', '--isolated', '--allow-unrestricted-file-access'];
const WIN = process.platform === 'win32';

export function parseJobs(text: string): Jobs {
  const j = JSON.parse(text);
  const groups: Group[] = Array.isArray(j?.groups) ? j.groups : Array.isArray(j?.shots) ? [{ shots: j.shots }] : Array.isArray(j) ? [{ shots: j }] : [];
  for (const g of groups) for (const s of g.shots ?? [])
    if (typeof s?.url !== 'string' || typeof s.width !== 'number' || typeof s.png !== 'string' || typeof s.json !== 'string')
      throw new Error(`each shot needs url, width (number), png and json: ${JSON.stringify(s).slice(0, 120)}`);
  if (!groups.some(g => g.shots?.length || g.extract)) throw new Error('no shots or extract in the jobs file');
  return { groups };
}

// SHOT_CODE with its placeholders filled.
export const shotCode = (s: Shot) => SHOT_CODE.replace("'URL'", JSON.stringify(s.url)).replace('WIDTH', String(Math.round(s.width))).replace("'PNG'", JSON.stringify(s.png));

class Mcp {
  private p: ReturnType<typeof spawn>;
  private buf = '';
  private wait = new Map<number, (j: any) => void>();
  private n = 0;
  constructor(out: string) {
    this.p = spawn(WIN ? 'npx.cmd' : 'npx', [...MCP_ARGS, '--output-dir', out], { stdio: ['pipe', 'pipe', 'pipe'], shell: WIN });
    this.p.stdout!.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        try { const j = JSON.parse(line); this.wait.get(j.id)?.(j); this.wait.delete(j.id); } catch { /* not a reply */ }
      }
    });
    this.p.on('exit', () => { for (const w of this.wait.values()) w({ error: { message: 'the Playwright MCP stopped' } }); this.wait.clear(); });
  }
  private rpc(method: string, params: unknown, ms = 120_000) {
    return new Promise<any>(res => {
      const id = ++this.n;
      const t = setTimeout(() => { this.wait.delete(id); res({ error: { message: `${method} timed out` } }); }, ms);
      this.wait.set(id, j => { clearTimeout(t); res(j); });
      this.p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start() {
    const j = await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'justcode', version: '1' } }, 180_000);
    if (j.error) throw new Error(`could not start the Playwright MCP: ${j.error.message}`);
    this.p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  // A tool's text, or an Error with the tool's own message.
  async call(name: string, args: Record<string, unknown>) {
    const j = await this.rpc('tools/call', { name, arguments: args });
    const text = String(j.result?.content?.[0]?.text ?? j.error?.message ?? '');
    if (j.error || j.result?.isError || /^### Error/m.test(text)) throw new Error(text.replace(/^### Error\s*/m, '').split('\n').slice(0, 3).join(' ').slice(0, 300));
    return text;
  }
  stop() { try { this.p.kill(); } catch { /* gone */ } }
}

// The value a run_code call returned: the JSON after "### Result" in the tool's text.
export function resultOf(text: string): unknown {
  const m = /### Result\n([\s\S]*?)(?:\n### |$)/.exec(text);
  if (!m) throw new Error('no result in the reply');
  return JSON.parse(m[1].trim());
}

export async function capture(jobs: Jobs, log: (line: string) => void = console.log) {
  const all = jobs.groups.flatMap(g => g.shots ?? []);
  const outDir = all[0] ? path.dirname(all[0].png) : jobs.groups.find(g => g.extract)!.extract!.dir;
  for (const s of all) { fs.mkdirSync(path.dirname(s.png), { recursive: true }); fs.mkdirSync(path.dirname(s.json), { recursive: true }); }
  fs.mkdirSync(outDir, { recursive: true });
  const mcp = new Mcp(outDir);
  const failed: string[] = [];
  let done = 0;
  try {
    await mcp.start();
    for (const g of jobs.groups) {
      if (g.extract) {
        try {
          const text = await mcp.call('browser_run_code_unsafe', { code: g.extract.code });
          const pages = resultOf(text);
          if (!Array.isArray(pages)) throw new Error('extract code must return [{ name, html }]');
          fs.mkdirSync(g.extract.dir, { recursive: true });
          let n = 0;
          for (const pg of pages) if (pg && typeof pg.name === 'string' && typeof pg.html === 'string' && /^[\w.-]+$/.test(pg.name)) { fs.writeFileSync(path.join(g.extract.dir, `${pg.name}.html`), pg.html); n++; }
          log(`extracted ${n} page${n === 1 ? '' : 's'} into ${g.extract.dir}`);
        } catch (e: any) { failed.push(`extract: ${e.message}`); log(`extract failed: ${e.message}`); }
      }
      if (!g.shots?.length) continue;
      try {
        await mcp.call('browser_run_code_unsafe', { code: `async (page) => { await page.context().clearCookies(); try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch (e) {} return 'signed out'; }` });
        if (g.setup) log(`setup: ${(await mcp.call('browser_run_code_unsafe', { code: g.setup })).split('\n')[1] ?? 'ok'}`);
      } catch (e: any) { for (const s of g.shots) failed.push(`${s.png}: setup failed: ${e.message}`); log(`setup failed: ${e.message}`); continue; }
      for (const s of g.shots) {
        try {
          await mcp.call('browser_run_code_unsafe', { code: shotCode(s) });
          await mcp.call('browser_evaluate', { function: MEASURE_FN, filename: s.json });
          const m = parseMeasure(fs.readFileSync(s.json, 'utf8'));
          fs.writeFileSync(s.json.replace(/\.json$/i, '') + '.css', (m.css ?? '') + '\n');
          log(`${++done}/${all.length} ${path.basename(s.png)} (${m.items.length} items)`);
        } catch (e: any) { failed.push(`${s.png}: ${e.message}`); log(`FAILED ${path.basename(s.png)}: ${e.message}`); }
      }
    }
  } finally { mcp.stop(); }
  return { done, failed };
}

// `design-diff --all <designDir> <appDir> <outDir>`: every <name>.json in both folders compared, one <name>.diff.txt each
// in outDir, a one-line-per-screen summary (most differences first), and the shared differences: the same rule (class,
// property and values) differing on SHARED_MIN or more screens, which one CSS change fixes everywhere (shared.txt).
export const SHARED_MIN = 3;
export interface DiffRow { name: string; n: number; px?: number }

// pixelmatch (the library Playwright's toHaveScreenshot uses), ESM, loaded once. threshold 0.1 is its own default;
// anti-aliased pixels are ignored (includeAA false), so font smoothing is not a difference.
type PixelMatch = (a: Uint8Array, b: Uint8Array, out: Uint8Array | null, w: number, h: number, o?: { threshold?: number; includeAA?: boolean }) => number;
let pm: PixelMatch | undefined;
const pixelmatch = (): PixelMatch => { if (!pm) { const m = require('pixelmatch'); pm = (m.default ?? m) as PixelMatch; } return pm; };

// How different two screenshots are, in percent of the taller one's pixels: pixelmatch over the rows both have, plus
// every row only one has (a page that is longer or shorter differs there). Writes a diff image (changed pixels red)
// when out is given. Different widths: 100 (not comparable).
export function pixelScore(design: string, app: string, out?: string): number {
  const A = PNG.sync.read(fs.readFileSync(design)), B = PNG.sync.read(fs.readFileSync(app));
  if (A.width !== B.width) return 100;
  const w = A.width, h = Math.min(A.height, B.height), H = Math.max(A.height, B.height), bytes = w * h * 4;
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch()(A.data.subarray(0, bytes), B.data.subarray(0, bytes), diff.data, w, h, { threshold: 0.1 });
  if (out) fs.writeFileSync(out, PNG.sync.write(diff));
  return Math.round(((n + (H - h) * w) / (w * H)) * 1000) / 10;
}
export interface Shared { rule: string; screens: string[]; examples: string[] }
export function diffAll(designDir: string, appDir: string, outDir: string, sample: string[] = []) {
  fs.mkdirSync(outDir, { recursive: true });
  const rows: DiffRow[] = [], rules = new Map<string, Set<string>>(), texts = new Map<string, Set<string>>();
  for (const f of fs.readdirSync(designDir).filter(f => f.endsWith('.json') && !/^(screens|jobs|app-jobs|sample)\.json$/.test(f)).sort()) {
    const app = path.join(appDir, f);
    if (!fs.existsSync(app)) continue;
    let d: Diff[];
    try { d = diffItems(parseMeasure(fs.readFileSync(path.join(designDir, f), 'utf8')), parseMeasure(fs.readFileSync(app, 'utf8')), sample); }
    catch (e: any) { d = [{ line: `could not compare: ${e.message}` }]; }
    const name = f.replace(/\.json$/, ''), screen = screenOf(name), width = /-(\d{3,4})$/.exec(name)?.[1];
    // A rule holds at one width: CSS differs per breakpoint (13px on desktop, 14px on mobile is not one difference).
    for (const x0 of d) if (x0.rule) {
      const x = { ...x0, rule: width ? `${x0.rule} @${width}` : x0.rule };
      if (!rules.has(x.rule)) { rules.set(x.rule, new Set()); texts.set(x.rule, new Set()); }
      rules.get(x.rule)!.add(screen);
      if (x.text && texts.get(x.rule)!.size < 3) texts.get(x.rule)!.add(`"${x.text.slice(0, 40)}" on ${screen}`);
    }
    const dp = path.join(designDir, `${name}.png`), ap = path.join(appDir, `${name}.png`);
    let px: number | undefined;
    try { if (fs.existsSync(dp) && fs.existsSync(ap)) px = pixelScore(dp, ap, path.join(outDir, `${name}.diff.png`)); } catch { /* a broken image: no score */ }
    fs.writeFileSync(path.join(outDir, `${name}.diff.txt`), (px !== undefined ? `Pixels differing: ${px}% (see ${name}.diff.png: red is different)\n` : '') + (d.length ? d.map(x => x.line).join('\n') : 'No differences.') + '\n');
    rows.push({ name, n: d.length, px });
  }
  rows.sort((a, b) => b.n - a.n);
  const shared: Shared[] = [...rules].filter(([, v]) => v.size >= SHARED_MIN).map(([rule, v]) => ({ rule, screens: [...v].sort(), examples: [...texts.get(rule)!] })).sort((a, b) => b.screens.length - a.screens.length);
  fs.writeFileSync(path.join(outDir, 'shared.txt'), shared.length ? shared.map(x => `${x.rule}  (${x.screens.length} screens, e.g. ${x.examples.join('; ')})`).join('\n') + '\n' : 'No shared differences.\n');
  const scored = rows.filter(r => r.px !== undefined);
  const avgPx = scored.length ? Math.round(scored.reduce((n, r) => n + r.px!, 0) / scored.length * 10) / 10 : undefined;
  return { rows, shared, avgPx };
}

// "c-login-390" → "c-login"; "c-root-guest-1440" → "c-root-guest".
export const screenOf = (name: string) => name.replace(/-\d{3,4}$/, '');

// The sample texts the audit listed (.justcode/design/sample.json: an array of strings), or none.
export function loadSample(file: string): string[] {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? usableSample(v.filter((x): x is string => typeof x === 'string')) : []; } catch { return []; }
}

// The next round of fix tasks, planned from the measures alone (no Claude): when a rule differs on several screens,
// one task for those rules first (one CSS change each, and the next round re-measures); otherwise screens that still
// differ, grouped by area (the id's first part: role or section), at most PER_TASK screens a task.
export const PER_TASK = 5;
export interface Planned { title: string; goal: string; files: string[]; done: string[] }
export function planRound(copy: string, auditDir: string, rows: DiffRow[], shared: Shared[], screens: { id: string; title?: string; url?: string }[] = []): Planned[] {
  const shotsDir = path.join(copy, 'screens');
  const refs = (screen: string) => fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter(f => screenOf(f.replace(/\.(css|html|json)$/, '')) === screen && /\.(css|html|json)$/.test(f)).sort().map(f => path.join(shotsDir, f)) : [];
  if (shared.length) {
    const top = shared.slice(0, 15), examples = [...new Set(top.flatMap(x => x.screens))].slice(0, 3);
    return [{ title: 'Design fix: shared styles', goal: `Fix the ${top.length} style rule${top.length === 1 ? '' : 's'} that differ from the design on several screens at once, in the shared styles (one change each, not per page).`,
      files: [...examples.flatMap(refs).filter(f => f.endsWith('.css')), path.join(auditDir, 'shared.txt')],
      done: [...top.map(x => `${x.rule} is fixed (was on ${x.screens.length} screens, e.g. ${x.examples.join('; ')})`),
        'each fix is made once in the shared styles or component, and no page or component file overrides those design classes locally any more (grep the class names)',
        'the design-diff of the example screens shows none of these rules any more', 'tests for the changed code pass'] }];
  }
  const left = [...new Set(rows.filter(r => r.n > 0).map(r => screenOf(r.name)))];
  const byArea = new Map<string, string[]>();
  for (const id of left) { const area = id.split('-')[0]; if (!byArea.has(area)) byArea.set(area, []); byArea.get(area)!.push(id); }
  const out: Planned[] = [];
  for (const ids of byArea.values()) for (let i = 0; i < ids.length; i += PER_TASK) {
    const part = ids.slice(i, i + PER_TASK), info = (id: string) => screens.find(s => s.id === id || id.startsWith(`${s.id}-`));
    const names = part.map(id => info(id)?.title ?? id);
    out.push({ title: `Design fix: ${names.join(', ')}`.slice(0, 90),
      goal: `Make ${part.map(id => `${id}${info(id)?.url ? ` (${info(id)!.url})` : ''}`).join(', ')} match the design at every width.`,
      files: part.flatMap(refs),
      done: [...part.map(id => { const px = rows.filter(r => screenOf(r.name) === id && r.px !== undefined).map(r => `${r.px}% at ${r.name.slice(id.length + 1)}`);
          return `every line in ${path.join(auditDir, `${id}-<width>.diff.txt`)} is fixed, except sample data${px.length ? `; pixels differing go down from ${px.join(', ')}` : ''}`; }),
        'the design-diff of these screens shows only sample data', 'tests for the changed code pass'] });
  }
  return out;
}

// Is the design measured by an older recipe (a measure without v >= MEASURE_V)? Checks one measure in screens/.
export function designMeasureOld(copy: string) {
  const dir = path.join(copy, 'screens');
  try {
    const f = fs.readdirSync(dir).find(x => /-\d{3,4}\.json$/.test(x));
    return !!f && !((parseMeasure(fs.readFileSync(path.join(dir, f), 'utf8')).v ?? 0) >= MEASURE_V);
  } catch { return false; }
}
