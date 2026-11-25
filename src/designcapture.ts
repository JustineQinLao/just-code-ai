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

// actions: steps done after the page loads to reach a state (a modal open, a step of it, a menu item): each types the
// given values into the fields with those labels (the values the design shows), then clicks the control with that
// visible label or aria-label. A label the page has no control for is reported (the json gets "missing"), not guessed.
export interface Fill { label: string; value: string }
export interface Step { click: string; fill?: Fill[] }
export interface Shot { url: string; width: number; png: string; json: string; actions?: Step[] }
// extract: code run once that returns [{ name, html }] (e.g. every screen of a gallery as a standalone page); each is
// written to <dir>/<name>.html before the group's shots, so splitting a design is one command too.
// open + page (optional) let JustCode explore each screen in the live design: open(page, name) shows that screen and
// returns the CSS selector of its root; page(page, selector) returns the standalone HTML of what that root shows now.
// Controls are clicked up to EXPLORE_DEPTH deep (a modal's steps, a menu's items, also menus added outside the root);
// each new state is saved as <dir>/<id>~<label>[~<label>…]-<width>.html with a shot at the same width, and all of it is
// listed in <dir>/states.json. A gallery screen that is the same as an explored state of another screen is merged
// into it (kind "same"): compared and fixed once.
export interface Extract { code: string; dir: string; open?: string; page?: string }
// states (app groups): the design's states.json. Each shot whose name has states gets one more shot per state: the same
// url with the state's steps, so the app is compared in the same state as the design.
export interface Group { setup?: string; extract?: Extract; states?: string; shots: Shot[] }
// One explored state. kind: state (the screen changed in place: a modal, panel, step, picked option), overlay (new
// content outside the screen root: a menu or sheet), toast (a short message), go (it leads to another screen), same
// (a gallery screen that is this state: name is the gallery screen, to the state it equals).
export interface State { name: string; base: string; label: string; steps?: Step[]; kind: 'state' | 'overlay' | 'toast' | 'go' | 'same'; added?: string[]; removed?: string[]; to?: string }
export const shown = (st: State) => st.kind === 'state' || st.kind === 'overlay';   // has its own page and shots
export const EXPLORE_DEPTH = 3;      // clicks deep
export const EXPLORE_STATES = 40;    // states kept per screen
// Gallery pages are cut out of a device frame: their root is often height:100% of it. Without the frame the root
// shrinks to its content (a tab bar floats up, blank space below), so each page is put back in a frame of the
// device's height (the viewport shots use); a longer page still grows, as the shot undoes inner scrolling.
export const frameHeight = (width: number) => width < 800 ? 844 : 900;
export function framePage(html: string, width: number) {
  if (/data-jc-frame/.test(html) || !/<body[^>]*>/i.test(html)) return html;
  const css = `<style>[data-jc-frame]>*:only-child{height:100%}</style>`;
  const head = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${css}</head>`) : html.replace(/(<body[^>]*>)/i, `${css}$1`);
  return head.replace(/(<body[^>]*>)/i, `$1<div data-jc-frame style="width:${width}px;height:${frameHeight(width)}px">`).replace(/<\/body>/i, '</div></body>');
}
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

// The page-side helpers both explore and replay use (plain JS in strings; they run in the Playwright MCP). PICK finds,
// for the open screen root, the content added outside it since the screen opened (menus, sheets: "over"), the
// clickable controls in both (visible, enabled, innermost) and the filled text fields with their labels.
const PICK = String.raw`(sel, CLICK) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.disabled; };
    const txt = e => (e.innerText || e.textContent || '').split('\n').map(x => x.trim()).find(Boolean) || '';
    const over = [...document.body.querySelectorAll('*:not([data-jc-old])')].filter(e => !root.contains(e) && !e.contains(root) && !/^(SCRIPT|STYLE|LINK)$/.test(e.tagName) && (e.parentElement === document.body || (e.parentElement && e.parentElement.hasAttribute('data-jc-old'))) && vis(e));
    const scopes = [root].concat(over);
    const ctl = scopes.flatMap(s => (s !== root && s.matches(CLICK) ? [s] : []).concat([...s.querySelectorAll(CLICK)])).filter(vis).filter((e, i, a) => a.indexOf(e) === i && !a.some(o => o !== e && e.contains(o)));
    const fieldLabel = e => { const f = e.id && document.querySelector('label[for="' + e.id + '"]'); const l = e.getAttribute('aria-label') || (f ? txt(f) : '') || (e.closest('label') ? txt(e.closest('label')) : '') || e.getAttribute('placeholder') || (e.previousElementSibling ? txt(e.previousElementSibling) : '') || e.name || ''; return l.replace(/\s+/g, ' ').trim().slice(0, 60); };
    const fields = scopes.flatMap(s => [...s.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=file]), textarea')]).filter(vis).map(e => ({ label: fieldLabel(e), value: e.value })).filter(f => f.label && f.value);
    const label = e => (e.getAttribute('aria-label') || e.getAttribute('title') || txt(e) || e.value || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { root, over, ctl, fields, label };
  }`;
const FIND = String.raw`const CLICK = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=radio], [role=checkbox], [role=option], [role=switch], [onclick], [data-act], [data-go], summary, input[type=radio], input[type=checkbox], select';
  const PICK = ` + '`' + PICK.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`' + String.raw`;
  const inPage = (fn, args) => page.evaluate('(' + fn + ')(...' + JSON.stringify(args) + ')');
  const lines = t => (t || '').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const mark = sel => page.evaluate(sel => { const root = document.querySelector(sel); for (const e of document.body.querySelectorAll('*')) if (!root || (!root.contains(e) && !e.contains(root))) e.setAttribute('data-jc-old', ''); }, sel);
  const READ = '(sel, CLICK) => { const p = (' + PICK + ')(sel, CLICK); if (!p) return null; return { text: p.root.innerText, over: p.over.map(e => e.innerText).join("\\n"), overHtml: p.over.map(e => e.outerHTML).join(""), body: document.body.innerText, fields: p.fields, controls: p.ctl.map((e, i) => ({ i, label: p.label(e), go: e.getAttribute("data-go") || "" })) }; }';
  const CLICK_AT = '(sel, CLICK, i) => { const p = (' + PICK + ')(sel, CLICK); const e = p && p.ctl[i]; if (!e) return false; e.click(); return true; }';
  const read = sel => inPage(READ, [sel, CLICK]);
  const clickAt = (sel, i) => inPage(CLICK_AT, [sel, CLICK, i]);
  const settle = () => page.waitForTimeout(250);
  const opened = async n => { const sel = await open(page, n); await settle(); if (typeof sel !== 'string' || !sel) throw new Error('open() must return the screen root selector'); await mark(sel); return sel; };
  const reach = async (n, path) => {
    const sel = await opened(n);
    for (const label of path) {
      const r = await read(sel), c = r && r.controls.find(x => x.label === label);
      if (!c || !await clickAt(sel, c.i)) return null;
      await settle();
    }
    return sel;
  };
  const html = async (sel, r) => { const h = await snap(page, sel); return r && r.overHtml ? h.replace(/<\/body>/i, r.overHtml + '</body>') : h; };`;

// Explores one screen, up to DEPTH clicks deep: from each state, the controls new in it are clicked in turn (a
// modal's steps, a menu's items). Each change is classified; a state already reached another way is skipped.
export const exploreCode = (open: string, snap: string, name: string, depth = EXPLORE_DEPTH, max = EXPLORE_STATES) => (String.raw`async (page) => {
  const open = (__OPEN__), snap = (__SNAP__), NAME = __NAME__, DEPTH = __DEPTH__, MAX = __MAX__;
  ` + FIND + String.raw`
  const out = [], seen = new Set();
  const sig = r => lines(r.text).join('|') + '##' + lines(r.over).join('|');
  const walk = async (path, fills, level, known) => {
    const s0 = await reach(NAME, path);
    if (!s0) return;
    const cur = await read(s0);
    if (!cur) return;
    seen.add(sig(cur));
    const tried = new Set(known);
    for (const c of cur.controls) {
      if (out.filter(x => x.kind === 'state' || x.kind === 'overlay').length >= MAX) return;
      if (!c.label || tried.has(c.label)) continue;
      tried.add(c.label);
      const step = path.concat([c.label]);
      if (c.go) { out.push({ path: step, fills, kind: 'go', to: c.go }); continue; }
      const s = await reach(NAME, path);
      if (!s) return;
      const before = await read(s), b0 = before && before.controls.find(x => x.label === c.label);
      if (!b0 || !await clickAt(s, b0.i)) continue;
      await settle();
      const after = await read(s);
      const stepFills = fills.concat([before.fields]);
      if (!after) { out.push({ path: step, fills: stepFills, kind: 'go' }); continue; }
      const a = lines(after.text), b = lines(before.text), as = new Set(a), bs = new Set(b);
      const oa = lines(after.over), ob = lines(before.over), obs = new Set(ob), oas = new Set(oa);
      const both = a.filter(x => bs.has(x)).length, jac = both / Math.max(1, new Set(a.concat(b)).size);
      if (jac < 0.35) { out.push({ path: step, fills: stepFills, kind: 'go', to: a[0] || '' }); continue; }
      const added = a.filter(x => !bs.has(x)).concat(oa.filter(x => !obs.has(x))), removed = b.filter(x => !as.has(x)).concat(ob.filter(x => !oas.has(x)));
      if (!added.length && !removed.length) {
        const bb = new Set(lines(before.body)), extra = lines(after.body).filter(x => !bb.has(x));
        if (extra.length) out.push({ path: step, fills: stepFills, kind: 'toast', added: extra.slice(0, 6) });
        continue;
      }
      const k = sig(after);
      if (seen.has(k)) continue;
      seen.add(k);
      const inPlace = a.join('|') !== b.join('|');
      // New content outside the screen with nothing to click and a line or two: a toast, not a menu or sheet.
      if (!inPlace && after.controls.length <= before.controls.length && added.length <= 2) { out.push({ path: step, fills: stepFills, kind: 'toast', added }); continue; }
      out.push({ path: step, fills: stepFills, kind: inPlace ? 'state' : 'overlay', added: added.slice(0, 12), removed: removed.slice(0, 12), html: await html(s, after) });
      if (level + 1 < DEPTH) await walk(step, stepFills, level + 1, new Set(before.controls.map(x => x.label)));
    }
  };
  await walk([], [], 0, new Set());
  return out;
}`).replace('__OPEN__', () => open).replace('__SNAP__', () => snap).replace('__NAME__', JSON.stringify(name)).replace('__DEPTH__', String(depth)).replace('__MAX__', String(max));

// The same state at another width: open that screen, click the path's labels, return the html (or null).
export const replayCode = (open: string, snap: string, name: string, path: string[]) => (String.raw`async (page) => {
  const open = (__OPEN__), snap = (__SNAP__), NAME = __NAME__, PATH = __PATH__;
  ` + FIND + String.raw`
  const s = await reach(NAME, PATH);
  if (!s) return null;
  return await html(s, await read(s));
}`).replace('__OPEN__', () => open).replace('__SNAP__', () => snap).replace('__NAME__', JSON.stringify(name)).replace('__PATH__', () => JSON.stringify(path));

// SHOT_CODE with its placeholders filled.
export const shotCode = (s: Shot) => SHOT_CODE.replace("'URL'", JSON.stringify(s.url)).replace('WIDTH', String(Math.round(s.width))).replace("'PNG'", JSON.stringify(s.png))
  .replace('ACTIONS', () => JSON.stringify((s.actions ?? []).filter(a => typeof a?.click === 'string' && a.click)));

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
  async call(name: string, args: Record<string, unknown>, ms = 120_000) {
    const j = await this.rpc('tools/call', { name, arguments: args }, ms);
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

// Words of a page's visible text (tags, styles and scripts dropped), for telling whether two pages show the same.
const words = (html: string) => new Set(html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').toLowerCase().split(/[^\p{L}\p{N}₱$%#.,:-]+/u).filter(w => w.length > 1));
export function sameText(a: string, b: string) {
  const A = words(a), B = words(b);
  if (A.size < 5 || B.size < 5) return false;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.9;
}

// Explores every extracted screen of a design (see Extract): resumable, since states.json is written after each screen
// and a screen already in it is skipped, so a run cut off by a timeout goes on where it stopped when run again.
// Then gallery screens equal to an explored state of another screen are merged into it (kind same).
async function explore(mcp: Mcp, x: Extract, names: string[], log: (line: string) => void, failed: string[]) {
  const file = path.join(x.dir, 'states.json');
  let all: State[] = [];
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  all = all.filter(st => st.kind !== 'same');
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
    try { rows = resultOf(await mcp.call('browser_run_code_unsafe', { code: exploreCode(x.open!, x.page!, first) }, 900_000)) as any[]; }
    catch (e: any) { failed.push(`explore ${first}: ${e.message}`); log(`explore ${first} failed: ${e.message}`); continue; }
    const used = new Set<string>();
    const nameFor = (p: string[]) => { const base = p.map(slug).join('~'); let k = base, n = 2; while (used.has(k)) k = `${base}-${n++}`; used.add(k); return k; };
    const keep: State[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !Array.isArray(r.path) || !r.path.length) continue;
      const k = nameFor(r.path), w = split(first)[1];
      const steps: Step[] = r.path.map((label: string, j: number) => {
        const f: Fill[] = (Array.isArray(r.fills?.[j]) ? r.fills[j] : []).filter((x: any) => x && typeof x.label === 'string' && typeof x.value === 'string');
        return f.length ? { click: label, fill: f } : { click: label };
      });
      const st: State = { name: `${id}~${k}-${w}`, base: first, label: r.path[r.path.length - 1], steps, kind: r.kind, ...(r.added?.length ? { added: r.added } : {}), ...(r.removed?.length ? { removed: r.removed } : {}), ...(r.to ? { to: r.to } : {}) };
      if (shown(st) && typeof r.html === 'string') fs.writeFileSync(path.join(x.dir, `${st.name}.html`), framePage(r.html, Number(w) || 390));
      keep.push(st);
      // The same state at the other widths, reached by the same clicks.
      if (shown(st)) for (const o of others) {
        try {
          const h = resultOf(await mcp.call('browser_run_code_unsafe', { code: replayCode(x.open!, x.page!, o, r.path) }, 300_000));
          if (typeof h === 'string') { const sn = `${id}~${k}-${split(o)[1]}`; fs.writeFileSync(path.join(x.dir, `${sn}.html`), framePage(h, Number(split(o)[1]) || 1440)); keep.push({ ...st, name: sn, base: o }); }
        } catch (e: any) { failed.push(`replay ${o} ${r.path.join(' › ')}: ${e.message}`); }
      }
    }
    // A screen with nothing to click still counts as explored.
    all = all.filter(st => !widths.includes(st.base)).concat(keep.length ? keep : widths.map(b => ({ name: b, base: b, label: '', kind: 'go' as const })));
    save();
    const n = keep.filter(shown).length;
    log(`explored ${i}/${byId.size} ${id}: ${keep.length} behaviour${keep.length === 1 ? '' : 's'}, ${n} state${n === 1 ? '' : 's'} (up to ${EXPLORE_DEPTH} clicks deep)`);
  }
  // A gallery screen drawn as its own page but equal to a state of another screen (a modal shown open): merged.
  const read = (n: string) => { try { return fs.readFileSync(path.join(x.dir, `${n}.html`), 'utf8'); } catch { return ''; } };
  for (const n of names) {
    const [id, w] = split(n), own = read(n);
    const twin = all.find(st => shown(st) && st.base.endsWith(`-${w}`) && split(st.base)[0] !== id && sameText(own, read(st.name)));
    if (twin) { all.push({ name: n, base: n, label: '', kind: 'same', to: twin.name }); log(`${n} is the state ${twin.name}: compared once, as that state`); }
  }
  save();
  return all;
}

// The app shots for the design's states: each shot of a base screen (png name = state.base) once more per shown
// state, with that state's steps. Exported for tests.
export function stateShots(shots: Shot[], states: State[]): Shot[] {
  const out: Shot[] = [];
  for (const sh of shots) {
    const base = path.basename(sh.png).replace(/\.png$/i, '');
    for (const st of states) if (shown(st) && st.base === base)
      out.push({ ...sh, png: path.join(path.dirname(sh.png), `${st.name}.png`), json: path.join(path.dirname(sh.json), `${st.name}.json`), actions: [...(sh.actions ?? []), ...(st.steps ?? [{ click: st.label }])] });
  }
  return out;
}
// Gallery screens merged into a state (kind same): not compared on their own.
export const mergedScreens = (states: State[]) => new Set(states.filter(st => st.kind === 'same').map(st => st.name));
export const loadStates = (file: string): State[] => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((x: any) => x && typeof x.name === 'string' && (x.label || x.kind === 'same')) : []; } catch { return []; } };

// A screenshot of one colour (or two, for anti-aliasing at an edge): the page showed nothing.
export function blankPng(file: string) {
  try {
    const p = PNG.sync.read(fs.readFileSync(file)), seen = new Set<number>();
    for (let i = 0; i < p.data.length; i += 4 * 37) { seen.add((p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2]); if (seen.size > 3) return false; }
    return true;
  } catch { return false; }
}

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
          for (const pg of pages) if (pg && typeof pg.name === 'string' && typeof pg.html === 'string' && /^[\w.-]+$/.test(pg.name)) { fs.writeFileSync(path.join(g.extract.dir, `${pg.name}.html`), framePage(pg.html, Number(split(pg.name)[1]) || 390)); names.push(pg.name); }
          log(`extracted ${names.length} page${names.length === 1 ? '' : 's'} into ${g.extract.dir}`);
        } catch (e: any) { failed.push(`extract: ${e.message}`); log(`extract failed: ${e.message}`); }
        if (g.extract.open && g.extract.page && names.length) {
          const states = await explore(mcp, g.extract, names, log, failed);
          // Gallery screens merged into a state are not shot on their own (their old files go too).
          const merged = mergedScreens(states);
          const isMerged = (x: Shot) => merged.has(path.basename(x.png).replace(/\.png$/i, ''));
          for (const x of (g.shots ?? []).filter(isMerged)) for (const f of [x.png, x.json, x.json.replace(/\.json$/i, '.css')]) fs.rmSync(f, { force: true });
          g.shots = (g.shots ?? []).filter(x => !isMerged(x));
          // Each state is shot like its screen: same width, beside it.
          const extra: Shot[] = [];
          for (const st of states.filter(shown)) {
            const sh = (g.shots ?? []).find(x => path.basename(x.png).replace(/\.png$/i, '') === st.base);
            if (sh && fs.existsSync(path.join(g.extract.dir, `${st.name}.html`)))
              extra.push({ url: `file://${path.join(g.extract.dir, `${st.name}.html`)}`, width: sh.width, png: path.join(path.dirname(sh.png), `${st.name}.png`), json: path.join(path.dirname(sh.json), `${st.name}.json`) });
          }
          g.shots = [...(g.shots ?? []), ...extra];
          log(`${states.filter(shown).length} states to shoot; ${states.filter(x => x.kind === 'toast' || x.kind === 'go').length} other behaviours (toasts, links) and ${merged.size} merged screens in states.json`);
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
          // A blank image (the page had not drawn yet) is never compared: shot again once, else reported.
          if (blankPng(sh.png)) {
            await mcp.call('browser_run_code_unsafe', { code: `async (page) => { await page.waitForTimeout(2000); return 'waited'; }` });
            await mcp.call('browser_run_code_unsafe', { code: shotCode(sh) });
          }
          await mcp.call('browser_evaluate', { function: MEASURE_FN, filename: sh.json });
          if (blankPng(sh.png)) {
            fs.rmSync(sh.png, { force: true });
            failed.push(`${sh.png}: the page was blank when shot (nothing drawn); measured, but no image or pixel score`);
            log(`${++done}/${all().length} ${path.basename(sh.png)}: blank page, no image`);
            continue;
          }
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
  const merged = mergedScreens(loadStates(path.join(designDir, 'states.json')));
  for (const f of fs.readdirSync(designDir).filter(f => f.endsWith('.json') && !/^(screens|jobs|app-jobs|sample|states)\.json$/.test(f) && !merged.has(f.replace(/\.json$/, ''))).sort()) {
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
    const acts = r.name.includes('~') ? [] : states.filter(x => x.base === r.name && (x.kind === 'toast' || x.kind === 'go'));
    return `<section id="${esc(r.name)}"><h2>${esc(r.name)} <small>${r.n} difference${r.n === 1 ? '' : 's'}${r.px !== undefined ? ` · ${r.px}% pixels` : ''}</small></h2>` +
      (st ? `<p class="how">Reached by ${(st.steps ?? [{ click: st.label }]).map(x => `${x.fill?.length ? `typing ${x.fill.map(f => `“${esc(f.value)}”`).join(', ')}, then ` : ''}clicking “${esc(x.click)}”`).join(' › ')}</p>` : '') +
      `<div class="row"><figure><figcaption>Design</figcaption>${img(path.join(designDir, `${r.name}.png`))}</figure><figure><figcaption>App</figcaption>${img(path.join(appDir, `${r.name}.png`))}</figure><figure><figcaption>Different (red)</figcaption>${img(path.join(outDir, `${r.name}.diff.png`))}</figure></div>` +
      (acts.length ? `<ul class="acts">${acts.map(a => `<li>“${esc(a.label)}” ${a.kind === 'go' ? `goes to ${esc(a.to || 'another screen')}` : `shows the message ${esc((a.added ?? []).slice(0, 4).join(' · '))}`}</li>`).join('')}</ul>` : '') +
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
  const nStates = (id: string) => new Set(states.filter(st => shown(st) && baseOf(st.name) === id).map(st => screenOf(st.name))).size;
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
      for (const st of states.filter(x => baseOf(x.name) === id && shown(x) && x.name.endsWith('-390'))) {
        const m = missing(path.join(auditDir, `${st.name}.json`));
        if (m) done.push(`${id}: add the control "${m}"${(st.steps?.length ?? 1) > 1 ? ` (reached by ${(st.steps ?? []).map(x => `"${x.click}"`).join(' › ')})` : ''}; in the design it opens ${path.join(shotsDir, `${st.name}.html`)}${st.added?.length ? ` (showing ${st.added.slice(0, 3).map(x => `"${x}"`).join(', ')})` : ''}`);
      }
      const named = rows.filter(r => baseOf(r.name) === id && r.n > 0);
      const px = named.filter(r => !r.name.includes('~') && r.px !== undefined).map(r => `${r.px}% at ${r.name.slice(id.length + 1)}`);
      done.push(`every line in ${path.join(auditDir, `${id}[~state]-<width>.diff.txt`)} is fixed (${named.length} file${named.length === 1 ? '' : 's'}: the screen${named.some(r => r.name.includes('~')) ? ' and its states' : ''}), except sample data${px.length ? `; pixels differing go down from ${px.join(', ')}` : ''}`);
      const acts = states.filter(x => baseOf(x.base) === id && x.base.endsWith('-390') && (x.kind === 'toast' || x.kind === 'go'));
      if (acts.length) done.push(`${id} behaves as in the design: ${acts.slice(0, 8).map(a => a.kind === 'go' ? `"${a.label}" goes to ${a.to || 'another screen'}` : `${(a.steps ?? [{ click: a.label }]).map(x => `"${x.click}"`).join(' › ')} shows the message ${(a.added ?? []).slice(0, 2).map(x => `"${x}"`).join(', ')}`).join('; ')}`);
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
