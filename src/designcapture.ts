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

// actions: clicks done after the page loads, by the control's visible label or aria-label, to reach a state (a modal
// open, a tab picked). A label the page has no control for is reported (the json gets "missing"), not guessed.
export interface Shot { url: string; width: number; png: string; json: string; actions?: { click: string }[] }
// extract: code run once that returns [{ name, html }] (e.g. every screen of a gallery as a standalone page); each is
// written to <dir>/<name>.html before the group's shots, so splitting a design is one command too.
// open + page (optional) let JustCode explore each screen in the live design: open(page, name) shows that screen and
// returns the CSS selector of its root; page(page, selector) returns the standalone HTML of what that root shows now.
// Every control in the root is clicked in turn; each new state (a modal, a picked option, a variant) is saved as
// <dir>/<id>~<label>-<width>.html with a shot at the same width, and all of it is listed in <dir>/states.json.
export interface Extract { code: string; dir: string; open?: string; page?: string }
// states (app groups): the design's states.json. Each shot whose name has states gets one more shot per state: the same
// url with the state's click, so the app is compared in the same state as the design.
export interface Group { setup?: string; extract?: Extract; states?: string; shots: Shot[] }
// One explored state. kind: state (the screen changed in place: a modal, panel, picked option), overlay (new content
// outside the screen root, e.g. a menu or sheet on the body), toast (a short message), go (it leads to another screen).
export interface State { name: string; base: string; label: string; kind: 'state' | 'overlay' | 'toast' | 'go'; added?: string[]; removed?: string[]; to?: string }
export const EXPLORE_MAX = 30;   // controls tried per screen

// Where a design's reference lives (screens.json, each screen and state's html/css/json/png): beside the board, never
// inside the saved copy, which a re-save replaces whole. A design folder outside .justcode keeps its own screens/.
export function screensOf(copy: string) {
  const parent = path.dirname(copy), jcDir = path.dirname(parent);
  return path.basename(parent) === 'sources' && path.basename(jcDir) === '.justcode' ? path.join(jcDir, 'design', 'ref', path.basename(copy)) : path.join(copy, 'screens');
}
// "Send proof" → "send-proof" (a file-name part).
export const slug = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'x';
// "c-pay-390" → ["c-pay", "390"]
const split = (name: string) => { const m = /^(.*)-(\d{3,4})$/.exec(name); return m ? [m[1], m[2]] : [name, '']; };
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

// The page-side helpers both explore and replay use: the clickable controls inside a root (visible, enabled), each
// with its label, and the root's text. Plain JS in a string (it runs in the Playwright MCP).
const FIND = String.raw`const CLICK = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=radio], [role=checkbox], [role=option], [role=switch], [onclick], [data-act], [data-go], summary, input[type=radio], input[type=checkbox], select';
  const lines = t => (t || '').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const read = sel => page.evaluate(([sel, CLICK]) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.disabled; };
    const label = e => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.innerText || '').split('\n').map(x => x.trim()).find(Boolean) || e.value || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const all = [...root.querySelectorAll(CLICK)].filter(vis).filter((e, i, a) => !a.some(o => o !== e && e.contains(o)));
    return { text: root.innerText, body: document.body.innerText, controls: all.map((e, i) => ({ i, label: label(e), go: e.getAttribute('data-go') || '' })) };
  }, [sel, CLICK]);
  const clickAt = (sel, i) => page.evaluate(([sel, CLICK, i]) => {
    const root = document.querySelector(sel);
    if (!root) return false;
    const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.disabled; };
    const e = [...root.querySelectorAll(CLICK)].filter(vis).filter((e, i, a) => !a.some(o => o !== e && e.contains(o)))[i];
    if (!e) return false;
    e.click();
    return true;
  }, [sel, CLICK, i]);
  const settle = () => page.waitForTimeout(250);
  const opened = async n => { const sel = await open(page, n); await settle(); if (typeof sel !== 'string' || !sel) throw new Error('open() must return the screen root selector'); return sel; };`;

// Explores one screen: every control clicked from a freshly opened screen, the change classified. Returns State-like
// rows (the html of each in-place state included, for the caller to write).
export const exploreCode = (open: string, snap: string, name: string, max = EXPLORE_MAX) => (String.raw`async (page) => {
  const open = (__OPEN__), snap = (__SNAP__), NAME = __NAME__, MAX = __MAX__;
  ` + FIND + String.raw`
  const sel = await opened(NAME), first = await read(sel);
  if (!first) throw new Error('no element matches ' + sel);
  const out = [], seen = new Set();
  for (const c of first.controls.slice(0, MAX)) {
    if (!c.label || seen.has(c.label)) continue;
    seen.add(c.label);
    if (c.go) { out.push({ label: c.label, kind: 'go', to: c.go }); continue; }
    const s = await opened(NAME), before = await read(s);
    if (!before || !await clickAt(s, c.i)) continue;
    await settle();
    const after = await read(s);
    if (!after) { out.push({ label: c.label, kind: 'go' }); continue; }
    const a = lines(after.text), b = lines(before.text), bs = new Set(b), as = new Set(a);
    const added = a.filter(x => !bs.has(x)), removed = b.filter(x => !as.has(x));
    const both = a.filter(x => bs.has(x)).length, jac = both / Math.max(1, new Set([...a, ...b]).size);
    if (jac < 0.35) { out.push({ label: c.label, kind: 'go', to: a[0] || '' }); continue; }
    if (!added.length && !removed.length) {
      const bb = new Set(lines(before.body)), extra = lines(after.body).filter(x => !bb.has(x));
      if (extra.length) out.push({ label: c.label, kind: extra.length > 2 ? 'overlay' : 'toast', added: extra.slice(0, 12) });
      continue;
    }
    out.push({ label: c.label, kind: 'state', added: added.slice(0, 12), removed: removed.slice(0, 12), html: await snap(page, s) });
  }
  return out;
}`).replace('__OPEN__', open).replace('__SNAP__', snap).replace('__NAME__', JSON.stringify(name)).replace('__MAX__', String(max));

// The same state at another width: open that screen, click the control with this label, return the html (or null).
export const replayCode = (open: string, snap: string, name: string, label: string) => (String.raw`async (page) => {
  const open = (__OPEN__), snap = (__SNAP__), NAME = __NAME__, LABEL = __LABEL__;
  ` + FIND + String.raw`
  const s = await opened(NAME), r = await read(s);
  const c = r && r.controls.find(x => x.label === LABEL);
  if (!c || !await clickAt(s, c.i)) return null;
  await settle();
  return await snap(page, s);
}`).replace('__OPEN__', open).replace('__SNAP__', snap).replace('__NAME__', JSON.stringify(name)).replace('__LABEL__', JSON.stringify(label));

// SHOT_CODE with its placeholders filled.
export const shotCode = (s: Shot) => SHOT_CODE.replace("'URL'", JSON.stringify(s.url)).replace('WIDTH', String(Math.round(s.width))).replace("'PNG'", JSON.stringify(s.png))
  .replace('ACTIONS', JSON.stringify((s.actions ?? []).map(a => a.click).filter(x => typeof x === 'string' && x)));

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

// Explores every extracted screen of a design (see Extract): resumable, since states.json is written after each screen
// and a screen already in it is skipped, so a run cut off by a timeout goes on where it stopped when run again.
async function explore(mcp: Mcp, x: Extract, names: string[], log: (line: string) => void, failed: string[]) {
  const file = path.join(x.dir, 'states.json');
  let all: State[] = [];
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const done = new Set(all.map(st => st.base));
  const save = () => fs.writeFileSync(file, JSON.stringify(all, null, 1));
  const byId = new Map<string, string[]>();
  for (const n of names) { const [id] = split(n); if (!byId.has(id)) byId.set(id, []); byId.get(id)!.push(n); }
  let i = 0;
  for (const [id, widths] of byId) {
    i++;
    if (widths.every(n => done.has(n))) continue;
    const [first, ...others] = widths;
    let rows: any[];
    try { rows = resultOf(await mcp.call('browser_run_code_unsafe', { code: exploreCode(x.open!, x.page!, first) })) as any[]; }
    catch (e: any) { failed.push(`explore ${first}: ${e.message}`); log(`explore ${first} failed: ${e.message}`); continue; }
    const used = new Set<string>();
    const nameFor = (label: string) => { let k = slug(label), n = 2; while (used.has(k)) k = `${slug(label)}-${n++}`; used.add(k); return k; };
    const keep: State[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.label !== 'string') continue;
      const k = nameFor(r.label), w = split(first)[1];
      const st: State = { name: `${id}~${k}-${w}`, base: first, label: r.label, kind: r.kind, ...(r.added?.length ? { added: r.added } : {}), ...(r.removed?.length ? { removed: r.removed } : {}), ...(r.to ? { to: r.to } : {}) };
      if (r.kind === 'state' && typeof r.html === 'string') fs.writeFileSync(path.join(x.dir, `${st.name}.html`), r.html);
      keep.push(st);
      // The same state at the other widths, reached by the same label.
      if (r.kind === 'state') for (const o of others) {
        try {
          const html = resultOf(await mcp.call('browser_run_code_unsafe', { code: replayCode(x.open!, x.page!, o, r.label) }));
          if (typeof html === 'string') { const sn = `${id}~${k}-${split(o)[1]}`; fs.writeFileSync(path.join(x.dir, `${sn}.html`), html); keep.push({ ...st, name: sn, base: o }); }
        } catch (e: any) { failed.push(`replay ${o} "${r.label}": ${e.message}`); }
      }
    }
    // A screen with nothing to click still counts as explored (its base row has no states).
    all = all.filter(st => !widths.includes(st.base)).concat(keep.length ? keep : widths.map(b => ({ name: b, base: b, label: '', kind: 'go' as const })));
    save();
    const n = keep.filter(st => st.kind === 'state').length;
    log(`explored ${i}/${byId.size} ${id}: ${keep.length} control${keep.length === 1 ? '' : 's'}, ${n} state${n === 1 ? '' : 's'}`);
  }
  return all.filter(st => st.label);
}

// The app shots for the design's states: each shot of a base screen (png name = state.base) once more per in-place
// state, with that state's click. Exported for tests.
export function stateShots(shots: Shot[], states: State[]): Shot[] {
  const out: Shot[] = [];
  for (const sh of shots) {
    const base = path.basename(sh.png).replace(/\.png$/i, '');
    for (const st of states) if (st.kind === 'state' && st.base === base)
      out.push({ ...sh, png: path.join(path.dirname(sh.png), `${st.name}.png`), json: path.join(path.dirname(sh.json), `${st.name}.json`), actions: [...(sh.actions ?? []), { click: st.label }] });
  }
  return out;
}
export const loadStates = (file: string): State[] => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((x: any) => x && typeof x.label === 'string' && x.label) : []; } catch { return []; } };

export async function capture(jobs: Jobs, log: (line: string) => void = console.log) {
  for (const g of jobs.groups) if (g.states) g.shots = [...(g.shots ?? []), ...stateShots(g.shots ?? [], loadStates(g.states))];
  const all = () => jobs.groups.flatMap(g => g.shots ?? []);
  const outDir = all()[0] ? path.dirname(all()[0].png) : jobs.groups.find(g => g.extract)!.extract!.dir;
  fs.mkdirSync(outDir, { recursive: true });
  const mcp = new Mcp(outDir);
  const failed: string[] = [];
  let done = 0;
  try {
    await mcp.start();
    for (const g of jobs.groups) {
      if (g.extract) {
        let names: string[] = [];
        try {
          const text = await mcp.call('browser_run_code_unsafe', { code: g.extract.code });
          const pages = resultOf(text);
          if (!Array.isArray(pages)) throw new Error('extract code must return [{ name, html }]');
          fs.mkdirSync(g.extract.dir, { recursive: true });
          for (const pg of pages) if (pg && typeof pg.name === 'string' && typeof pg.html === 'string' && /^[\w.-]+$/.test(pg.name)) { fs.writeFileSync(path.join(g.extract.dir, `${pg.name}.html`), pg.html); names.push(pg.name); }
          log(`extracted ${names.length} page${names.length === 1 ? '' : 's'} into ${g.extract.dir}`);
        } catch (e: any) { failed.push(`extract: ${e.message}`); log(`extract failed: ${e.message}`); }
        if (g.extract.open && g.extract.page && names.length) {
          const states = await explore(mcp, g.extract, names, log, failed);
          // Each in-place state is shot like its screen: same width, beside it.
          const extra: Shot[] = [];
          for (const st of states.filter(x => x.kind === 'state')) {
            const sh = (g.shots ?? []).find(x => path.basename(x.png).replace(/\.png$/i, '') === st.base);
            if (sh && fs.existsSync(path.join(g.extract.dir, `${st.name}.html`)))
              extra.push({ url: `file://${path.join(g.extract.dir, `${st.name}.html`)}`, width: sh.width, png: path.join(path.dirname(sh.png), `${st.name}.png`), json: path.join(path.dirname(sh.json), `${st.name}.json`) });
          }
          g.shots = [...(g.shots ?? []), ...extra];
          log(`${states.filter(x => x.kind === 'state').length} states to shoot; ${states.filter(x => x.kind !== 'state').length} other behaviours (menus, toasts, links) in states.json`);
        }
      }
      if (!g.shots?.length) continue;
      for (const sh of g.shots) { fs.mkdirSync(path.dirname(sh.png), { recursive: true }); fs.mkdirSync(path.dirname(sh.json), { recursive: true }); }
      try {
        await mcp.call('browser_run_code_unsafe', { code: `async (page) => { await page.context().clearCookies(); try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch (e) {} return 'signed out'; }` });
        if (g.setup) log(`setup: ${(await mcp.call('browser_run_code_unsafe', { code: g.setup })).split('\n')[1] ?? 'ok'}`);
      } catch (e: any) { for (const sh of g.shots) failed.push(`${sh.png}: setup failed: ${e.message}`); log(`setup failed: ${e.message}`); continue; }
      for (const sh of g.shots) {
        try {
          const text = await mcp.call('browser_run_code_unsafe', { code: shotCode(sh) });
          let said = ''; try { said = String(resultOf(text) ?? ''); } catch { /* a reply without a result: shot taken */ }
          if (said.startsWith('missing:')) {
            // No control with that label: recorded as a difference (design-diff reports it), not a failure.
            fs.writeFileSync(sh.json, JSON.stringify({ v: MEASURE_V, width: sh.width, items: [], missing: said.slice(8) }));
            fs.rmSync(sh.png, { force: true });
            log(`${++done}/${all().length} ${path.basename(sh.png)}: no control "${said.slice(8)}"`);
            continue;
          }
          await mcp.call('browser_evaluate', { function: MEASURE_FN, filename: sh.json });
          const m = parseMeasure(fs.readFileSync(sh.json, 'utf8'));
          fs.writeFileSync(sh.json.replace(/\.json$/i, '') + '.css', (m.css ?? '') + '\n');
          log(`${++done}/${all().length} ${path.basename(sh.png)} (${m.items.length} items)`);
        } catch (e: any) { failed.push(`${sh.png}: ${e.message}`); log(`FAILED ${path.basename(sh.png)}: ${e.message}`); }
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
  for (const f of fs.readdirSync(designDir).filter(f => f.endsWith('.json') && !/^(screens|jobs|app-jobs|sample|states)\.json$/.test(f)).sort()) {
    const app = path.join(appDir, f);
    if (!fs.existsSync(app)) continue;
    let d: Diff[];
    try {
      const am = parseMeasure(fs.readFileSync(app, 'utf8'));
      // The app has no control to reach this state (see Shot.actions): that is the difference, nothing else to measure.
      d = am.missing ? [{ line: `missing in app: a control labelled "${am.missing}" (in the design it opens this state)`, rule: `missing control "${am.missing.slice(0, 40)}"`, text: am.missing }]
        : diffItems(parseMeasure(fs.readFileSync(path.join(designDir, f), 'utf8')), am, sample);
    } catch (e: any) { d = [{ line: `could not compare: ${e.message}` }]; }
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
  writeCompare(designDir, appDir, outDir, rows);
  const scored = rows.filter(r => r.px !== undefined);
  const avgPx = scored.length ? Math.round(scored.reduce((n, r) => n + r.px!, 0) / scored.length * 10) / 10 : undefined;
  return { rows, shared, avgPx };
}

// compare.html in outDir: every screen and state side by side (design, app, differences in red) with its diff lines,
// and what each screen's other controls do in the design. Opened from 🎨 Design → Open comparison.
function writeCompare(designDir: string, appDir: string, outDir: string, rows: DiffRow[]) {
  const esc = (x: string) => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
  const img = (f: string) => fs.existsSync(f) ? `<img loading="lazy" src="${esc(`file://${f}`)}">` : '<div class="none">none</div>';
  const states = loadStates(path.join(designDir, 'states.json'));
  const byName = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const sections = byName.map(r => {
    const lines = (() => { try { return fs.readFileSync(path.join(outDir, `${r.name}.diff.txt`), 'utf8').trim().split('\n').slice(0, 40); } catch { return []; } })();
    const st = states.find(x => x.name === r.name);
    const acts = r.name.includes('~') ? [] : states.filter(x => x.base === r.name && x.kind !== 'state');
    return `<section id="${esc(r.name)}"><h2>${esc(r.name)} <small>${r.n} difference${r.n === 1 ? '' : 's'}${r.px !== undefined ? ` · ${r.px}% pixels` : ''}</small></h2>` +
      (st ? `<p class="how">Reached by clicking “${esc(st.label)}”</p>` : '') +
      `<div class="row"><figure><figcaption>Design</figcaption>${img(path.join(designDir, `${r.name}.png`))}</figure><figure><figcaption>App</figcaption>${img(path.join(appDir, `${r.name}.png`))}</figure><figure><figcaption>Different (red)</figcaption>${img(path.join(outDir, `${r.name}.diff.png`))}</figure></div>` +
      (acts.length ? `<ul class="acts">${acts.map(a => `<li>“${esc(a.label)}” ${a.kind === 'go' ? `goes to ${esc(a.to || 'another screen')}` : `shows ${a.kind === 'toast' ? 'the message' : 'a menu or sheet:'} ${esc((a.added ?? []).slice(0, 4).join(' · '))}`}</li>`).join('')}</ul>` : '') +
      `<pre>${esc(lines.join('\n'))}</pre></section>`;
  }).join('\n');
  const nav = byName.map(r => `<a href="#${esc(r.name)}">${esc(r.name)} <b>${r.n}</b></a>`).join('');
  fs.writeFileSync(path.join(outDir, 'compare.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Design vs app</title><style>
body{font:14px system-ui,sans-serif;margin:0;display:flex;background:#f6f7f8;color:#111}nav{width:240px;flex:none;height:100vh;overflow:auto;position:sticky;top:0;background:#fff;border-right:1px solid #ddd;padding:8px}
nav a{display:flex;justify-content:space-between;padding:3px 6px;color:inherit;text-decoration:none;border-radius:4px}nav a:hover{background:#eef}main{flex:1;padding:16px;min-width:0}
section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:16px}h2{margin:0 0 8px;font-size:16px}small{color:#666;font-weight:400}.how{margin:0 0 8px;color:#555}
.row{display:flex;gap:10px;overflow-x:auto;align-items:flex-start}figure{margin:0;flex:1;min-width:200px}figcaption{font-weight:600;margin-bottom:4px}img{width:100%;border:1px solid #ccc}.none{padding:24px;color:#999;border:1px dashed #ccc;text-align:center}
pre{white-space:pre-wrap;background:#f3f3f3;padding:8px;border-radius:6px;max-height:240px;overflow:auto}.acts{margin:8px 0}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}nav,section{background:#1e1e1e;border-color:#333}pre{background:#111}nav a:hover{background:#2a2a40}.how,small{color:#aaa}}
</style></head><body><nav>${nav}</nav><main><h1>Design vs app</h1>${sections}</main></body></html>`);
}

// "c-login-390" → "c-login"; "c-root-guest-1440" → "c-root-guest".
export const screenOf = (name: string) => name.replace(/-\d{3,4}$/, '');

// The sample texts the audit listed (.justcode/design/sample.json: an array of strings), or none.
export function loadSample(file: string): string[] {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? usableSample(v.filter((x): x is string => typeof x === 'string')) : []; } catch { return []; }
}

// The next round of fix tasks, planned from the measures alone (no Claude): when a rule differs on several screens,
// one task for those rules first (one CSS change each, and the next round re-measures); otherwise screens that still
// differ, each with its states (modals, panels, picked options: "<id>~<label>"), grouped by area (the id's first
// part: role or section), at most PER_TASK screens a task, and a screen with many states on its own. Controls the
// app lacks and the design's other behaviours (menus, toasts, links to other screens, from states.json) are checks.
export const PER_TASK = 5;
export interface Planned { title: string; goal: string; files: string[]; done: string[] }
export const baseOf = (name: string) => screenOf(name).split('~')[0];
export function planRound(copy: string, auditDir: string, rows: DiffRow[], shared: Shared[], screens: { id: string; title?: string; url?: string }[] = []): Planned[] {
  const shotsDir = screensOf(copy);
  const states = loadStates(path.join(shotsDir, 'states.json'));
  const refs = (id: string) => fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter(f => /\.(css|html|json)$/.test(f) && f !== 'states.json' && f !== 'screens.json' && baseOf(f.replace(/\.(css|html|json)$/, '')) === id).sort().map(f => path.join(shotsDir, f)) : [];
  if (shared.length) {
    const top = shared.slice(0, 15), examples = [...new Set(top.flatMap(x => x.screens))].slice(0, 3);
    return [{ title: 'Design fix: shared styles', goal: `Fix the ${top.length} style rule${top.length === 1 ? '' : 's'} that differ from the design on several screens at once, in the shared styles (one change each, not per page).`,
      files: [...examples.flatMap(refs).filter(f => f.endsWith('.css')), path.join(auditDir, 'shared.txt')],
      done: [...top.map(x => `${x.rule} is fixed (was on ${x.screens.length} screens, e.g. ${x.examples.join('; ')})`),
        'each fix is made once in the shared styles or component, and no page or component file overrides those design classes locally any more (grep the class names)',
        'the design-diff of the example screens shows none of these rules any more', 'tests for the changed code pass'] }];
  }
  const missing = (file: string) => { try { return parseMeasure(fs.readFileSync(file, 'utf8')).missing; } catch { return undefined; } };
  const left = [...new Set(rows.filter(r => r.n > 0).map(r => baseOf(r.name)))];
  const nStates = (id: string) => new Set(states.filter(st => st.kind === 'state' && baseOf(st.name) === id).map(st => screenOf(st.name))).size;
  const byArea = new Map<string, string[][]>();
  for (const id of left) {
    const area = id.split('-')[0];
    if (!byArea.has(area)) byArea.set(area, []);
    const groups = byArea.get(area)!, last = groups[groups.length - 1];
    if (nStates(id) > 3) groups.push([id]);   // many states: its own task
    else if (last && last.length < PER_TASK && !(last.length === 1 && nStates(last[0]) > 3)) last.push(id);
    else groups.push([id]);
  }
  const out: Planned[] = [];
  const info = (id: string) => screens.find(s => s.id === id || id.startsWith(`${s.id}-`));
  for (const part of [...byArea.values()].flat()) {
    const names = part.map(id => info(id)?.title ?? id);
    const extra = part.reduce((n, id) => n + nStates(id), 0);
    const done: string[] = [];
    for (const id of part) {
      for (const st of states.filter(x => baseOf(x.name) === id && x.kind === 'state' && x.name.endsWith('-390'))) {
        const m = missing(path.join(auditDir, `${st.name}.json`));
        if (m) done.push(`${id}: add the control "${st.label}"; in the design it opens ${path.join(shotsDir, `${st.name}.html`)}${st.added?.length ? ` (showing ${st.added.slice(0, 3).map(x => `"${x}"`).join(', ')})` : ''}`);
      }
      const named = rows.filter(r => baseOf(r.name) === id && r.n > 0);
      const px = named.filter(r => !r.name.includes('~') && r.px !== undefined).map(r => `${r.px}% at ${r.name.slice(id.length + 1)}`);
      done.push(`every line in ${path.join(auditDir, `${id}[~state]-<width>.diff.txt`)} is fixed (${named.length} file${named.length === 1 ? '' : 's'}: the screen${named.some(r => r.name.includes('~')) ? ' and its states' : ''}), except sample data${px.length ? `; pixels differing go down from ${px.join(', ')}` : ''}`);
      const acts = states.filter(x => baseOf(x.base) === id && x.base.endsWith('-390') && x.kind !== 'state');
      if (acts.length) done.push(`${id} behaves as in the design: ${acts.slice(0, 8).map(a => a.kind === 'go' ? `"${a.label}" goes to ${a.to || 'another screen'}` : `"${a.label}" shows ${a.kind === 'toast' ? 'the message' : 'a menu or sheet with'} ${(a.added ?? []).slice(0, 2).map(x => `"${x}"`).join(', ')}`).join('; ')}`);
    }
    out.push({ title: `Design fix: ${names.join(', ')}${extra ? ` (+${extra} state${extra === 1 ? '' : 's'})` : ''}`.slice(0, 90),
      goal: `Make ${part.map(id => `${id}${info(id)?.url ? ` (${info(id)!.url})` : ''}`).join(', ')} and ${extra ? 'every state of it (modals, panels, picked options)' : 'it'} match the design at every width.`,
      files: part.flatMap(refs).filter(f => !f.endsWith('.json')),   // the html and css; the measures are in the diff files
      done: [...done, 'the design-diff of these screens and states shows only sample data', 'tests for the changed code pass'] });
  }
  return out;
}

// Is the design measured by an older recipe (a measure without v >= MEASURE_V)? Checks one measure in screens/.
export function designMeasureOld(copy: string) {
  const dir = screensOf(copy);
  try {
    const f = fs.readdirSync(dir).find(x => /-\d{3,4}\.json$/.test(x));
    return !!f && !((parseMeasure(fs.readFileSync(path.join(dir, f), 'utf8')).v ?? 0) >= MEASURE_V);
  } catch { return false; }
}
