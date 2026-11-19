import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { SHOT_CODE, MEASURE_FN } from './skill';
import { parseMeasure, diffMeasures } from './designdiff';

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
// in outDir, and a one-line-per-screen summary (screens with no differences last).
export function diffAll(designDir: string, appDir: string, outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const rows: { name: string; n: number }[] = [];
  for (const f of fs.readdirSync(designDir).filter(f => f.endsWith('.json') && f !== 'screens.json' && f !== 'jobs.json').sort()) {
    const app = path.join(appDir, f);
    if (!fs.existsSync(app)) continue;
    let lines: string[];
    try { lines = diffMeasures(parseMeasure(fs.readFileSync(path.join(designDir, f), 'utf8')), parseMeasure(fs.readFileSync(app, 'utf8'))); }
    catch (e: any) { lines = [`could not compare: ${e.message}`]; }
    const name = f.replace(/\.json$/, '');
    fs.writeFileSync(path.join(outDir, `${name}.diff.txt`), (lines.length ? lines.join('\n') : 'No differences.') + '\n');
    rows.push({ name, n: lines.length });
  }
  rows.sort((a, b) => b.n - a.n);
  return rows;
}
