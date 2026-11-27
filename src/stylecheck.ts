import * as fs from 'fs';
import * as path from 'path';
import { parseMeasure, Item } from './designdiff';
import * as DC from './designcapture';
const { loadStates, mergedScreens } = DC;

// Fix to match's check, with no AI and no pixels: how the app LOOKS against the design, by its styles.
// - Tokens: the design's CSS variables (screens.json "tokens") against the ones the app's stylesheets declare.
// - Components: every class the design uses (".pill.on" at 390 wide), its usual font, size, weight, color, background
//   and corner radius in the design, against the same class in the app. Positions, sizes and texts are not compared:
//   a longer list, other records or another screen size are not a different look.
// - Design classes the app never uses: the app draws that part some other way.
// Writes .justcode/design/style-check.md (for you and the fix task) and style-check.json (for the board).

export const PROPS = ['font', 'size', 'weight', 'color', 'bg', 'radius'] as const;
type Prop = typeof PROPS[number];
// local: the class is right in most of the app but a page overrides it (screens: those pages).
export interface Drift { cls: string; width: number; prop: Prop; design: string; app: string; n: number; screens: string[]; local?: boolean }
export interface Unused { cls: string; width: number; n: number; screens: string[] }
export interface TokenDiff { name: string; design: string; app?: string }
export interface StyleReport { at: number; screens: number; drifts: Drift[]; unused: Unused[]; tokens: TokenDiff[] }

interface Use { n: number; screens: Set<string>; vals: Map<Prop, Map<string, number>>; per: Map<string, Map<Prop, Map<string, number>>> }
const value = (x: Item, p: Prop) => p === 'font' ? String(x.font ?? '').split(',')[0].replace(/["']/g, '').trim() : String(x[p] ?? '');
const mode = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
const screenOf = (name: string) => name.replace(/-\d{3,4}$/, '').split('~')[0];

function collect(dir: string, names: string[]) {
  const uses = new Map<string, Use>();
  for (const name of names) {
    let items: Item[];
    try { items = parseMeasure(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')).items; } catch { continue; }
    const width = Number(/-(\d{3,4})$/.exec(name)?.[1] ?? 0);
    for (const x of items) {
      const cls = (x.cls ?? '').trim().split(/\s+/).filter(Boolean);
      if (!cls.length) continue;
      const key = `.${cls.join('.')}@${width}`;
      let u = uses.get(key);
      if (!u) uses.set(key, u = { n: 0, screens: new Set(), vals: new Map(PROPS.map(p => [p, new Map()])), per: new Map() });
      u.n++; u.screens.add(screenOf(name));
      const sc = screenOf(name);
      if (!u.per.has(sc)) u.per.set(sc, new Map(PROPS.map(p => [p, new Map()])));
      for (const p of PROPS) for (const m of [u.vals.get(p)!, u.per.get(sc)!.get(p)!]) { const v = value(x, p); m.set(v, (m.get(v) ?? 0) + 1); }
    }
  }
  return uses;
}

// The app's CSS variables: `--name: value` in its own stylesheets (not dependencies or build output).
const SKIP = /^(node_modules|\.git|\.justcode|dist|build|out|coverage|\.angular|\.next|vendor|venv|\.venv)$/;
export function appTokens(root: string, max = 3000) {
  const out = new Map<string, string>();
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen > max) return;
      if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!/\.(css|scss|sass|less)$/.test(e.name)) continue;
      seen++;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)[;}]/g)) if (!out.has(m[1])) out.set(m[1], m[2].trim());
    }
  };
  walk(root);
  return out;
}
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();

// What the design's own rules for a class set, at one width: a class's other looks (the size of a .muted text, the
// weight of a .tnum) come from where it is used, so they are no fix to that class. From the screens' .css files.
const CSS_PROP: Record<string, Prop> = { 'font-size': 'size', 'font-weight': 'weight', color: 'color', background: 'bg', 'background-color': 'bg', 'border-radius': 'radius', 'font-family': 'font' };
export function declaredProps(css: string) {
  const out: { classes: string[]; props: Set<Prop> }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const props = new Set<Prop>();
    for (const d of m[2].split(';')) { const k = d.split(':')[0].trim().toLowerCase(); if (CSS_PROP[k]) props.add(CSS_PROP[k]); if (k === 'font') { props.add('size'); props.add('font'); props.add('weight'); } }
    if (!props.size) continue;
    for (const sel of m[1].split(',')) {
      const last = sel.trim().split(/[\s>+~]+/).pop() ?? '';
      if (/[:[]/.test(last)) continue;   // a state or attribute: not the plain class
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
      if (classes.length) out.push({ classes, props });
    }
  }
  return out;
}
function declaredFor(refDir: string) {
  const byWidth = new Map<number, ReturnType<typeof declaredProps>>();
  for (const f of fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(f => /-\d{3,4}\.css$/.test(f)) : []) {
    const w = Number(/-(\d{3,4})\.css$/.exec(f)![1]);
    byWidth.set(w, [...(byWidth.get(w) ?? []), ...declaredProps(fs.readFileSync(path.join(refDir, f), 'utf8'))]);
  }
  // No .css at all (an older reference): every property counts.
  return (cls: string, width: number): Set<Prop> => {
    const rules = byWidth.get(width);
    if (!rules) return new Set(PROPS);
    const have = new Set(cls.split('.').filter(Boolean)), out = new Set<Prop>();
    for (const r of rules) if (r.classes.every(c => have.has(c))) r.props.forEach(p => out.add(p));
    return out;
  };
}

export function styleCheck(root: string, refDir: string, appDir: string): StyleReport {
  const merged = mergedScreens(loadStates(path.join(refDir, 'states.json')));
  const names = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(f => /-\d{3,4}\.json$/.test(f)).map(f => f.replace(/\.json$/, ''))
    .filter(n => !n.includes('~') && !merged.has(n) && fs.existsSync(path.join(appDir, `${n}.json`))).sort() : [];   // screens: the check shoots no states
  const design = collect(refDir, names), app = collect(appDir, names);
  const drifts: Drift[] = [], unused: Unused[] = [], sets = declaredFor(refDir);
  for (const [key, d] of design) {
    const [cls, w] = key.split('@'), width = Number(w), a = app.get(key);
    if (!a) { unused.push({ cls, width, n: d.n, screens: [...d.screens].slice(0, 3) }); continue; }
    const own = sets(cls, width);
    for (const p of PROPS) {
      if (!own.has(p)) continue;
      const dv = mode(d.vals.get(p)!), av = mode(a.vals.get(p)!);
      if (dv && av && norm(dv) !== norm(av)) { drifts.push({ cls, width, prop: p, design: dv, app: av, n: a.n, screens: [...a.screens].slice(0, 3) }); continue; }
      // Right in most of the app: the pages where it is not (a page rule overriding the class).
      const want = (sc: string) => { const m = d.per.get(sc)?.get(p); return m?.size ? mode(m) : dv; };   // the design on that screen
      // A variant the design draws with a modifier the app does not use (.inp.ph, a placeholder) is the same look.
      const variants = (sc: string) => [...design].filter(([k]) => k !== key && k.endsWith(`@${width}`) && cls.split('.').filter(Boolean).every(c => k.split('@')[0].split('.').includes(c)))
        .map(([, u]) => u.per.get(sc)?.get(p)).filter((m): m is Map<string, number> => !!m?.size).flatMap(m => [...m.keys()].map(norm));
      const off = [...a.per].filter(([sc, v]) => { const got = norm(mode(v.get(p)!)); return got !== norm(want(sc)) && !variants(sc).includes(got); });
      if (dv && off.length) drifts.push({ cls, width, prop: p, design: want(off[0][0]), app: mode(off[0][1].get(p)!), n: off.reduce((n, [, v]) => n + [...v.get(p)!.values()].reduce((a, b) => a + b, 0), 0), screens: off.map(([sc]) => sc), local: true });
    }
  }
  drifts.sort((x, y) => y.n - x.n); unused.sort((x, y) => y.n - x.n);
  let want: Record<string, string> = {};
  try { want = JSON.parse(fs.readFileSync(path.join(refDir, 'screens.json'), 'utf8')).tokens ?? {}; } catch { /* no tokens listed */ }
  const have = appTokens(root);
  const tokens = Object.entries(want).filter(([k, v]) => typeof v === 'string' && norm(have.get(k) ?? '') !== norm(v)).map(([name, design]) => ({ name, design, app: have.get(name) }));
  return { at: Date.now(), screens: new Set(names.map(screenOf)).size, drifts, unused, tokens };
}

export const reportFile = (root: string, ext: 'md' | 'json') => path.join(root, '.justcode', 'design', `style-check.${ext}`);
export const loadReport = (root: string): StyleReport | undefined => { try { return JSON.parse(fs.readFileSync(reportFile(root, 'json'), 'utf8')); } catch { return undefined; } };
export const reportCount = (r: StyleReport) => r.drifts.length + r.tokens.length;

export const driftLine = (x: Drift) => x.local
  ? `${x.cls} at ${x.width}: ${x.prop} is ${x.app} on ${x.screens.slice(0, 6).join(', ')}${x.screens.length > 6 ? ` and ${x.screens.length - 6} more` : ''}, the design has ${x.design} (right elsewhere: a page rule overrides it)`
  : `${x.cls} at ${x.width}: ${x.prop} is ${x.app}, the design has ${x.design} (${x.n} place${x.n === 1 ? '' : 's'}, e.g. ${x.screens.join(', ')})`;
export const tokenLine = (x: TokenDiff) => x.app === undefined ? `${x.name}: ${x.design} is not declared in the app` : `${x.name}: the app has ${x.app}, the design has ${x.design}`;

export function writeReport(root: string, r: StyleReport, designCss: string[]) {
  const md = [
    '# Style check: design vs app',
    '',
    `${r.screens} screens checked, by their styles (no AI, no pixels): ${r.tokens.length} token${r.tokens.length === 1 ? '' : 's'} and ${r.drifts.length} component style${r.drifts.length === 1 ? '' : 's'} differ.`,
    `The design's stylesheet, all rules of every screen: ${designCss.join(', ')}`,
    '',
    '## Tokens (CSS variables)', '', ...(r.tokens.length ? r.tokens.map(x => `- ${tokenLine(x)}`) : ['All match.']), '',
    '## Component styles that differ', '', ...(r.drifts.length ? r.drifts.map(x => `- ${driftLine(x)}`) : ['None.']), '',
    '## Design classes the app never uses', '',
    'The app draws these parts with other classes, or not at all. Look at them in the comparison before changing anything.', '',
    ...(r.unused.length ? r.unused.slice(0, 60).map(x => `- ${x.cls} at ${x.width} (${x.n} place${x.n === 1 ? '' : 's'} in the design, e.g. ${x.screens.join(', ')})`) : ['None.']), '',
  ].join('\n');
  fs.mkdirSync(path.dirname(reportFile(root, 'md')), { recursive: true });
  fs.writeFileSync(reportFile(root, 'md'), md);
  fs.writeFileSync(reportFile(root, 'json'), JSON.stringify(r));
}

// One stylesheet per width from every screen's .css (the rules each page uses), so a fix copies the design's own CSS.
export function designStylesheets(refDir: string, outDir: string) {
  const byWidth = new Map<string, Set<string>>();
  for (const f of fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(f => /-\d{3,4}\.css$/.test(f)).sort() : []) {
    const w = /-(\d{3,4})\.css$/.exec(f)![1];
    if (!byWidth.has(w)) byWidth.set(w, new Set());
    for (const rule of fs.readFileSync(path.join(refDir, f), 'utf8').split('\n')) if (rule.trim()) byWidth.get(w)!.add(rule);
  }
  fs.mkdirSync(outDir, { recursive: true });
  return [...byWidth].map(([w, rules]) => { const f = path.join(outDir, `design-${w}.css`); fs.writeFileSync(f, [...rules].join('\n') + '\n'); return f; });
}

// The one fix task: copy the design's tokens and component styles into the app's shared styles. Returns its text.
export function fixTaskText(r: StyleReport, files: { report: string; css: string[] }, cli: string, root: string) {
  return [
    'Goal: Make the app look like the design by its shared styles: the design\'s tokens and component classes, changed once in the global stylesheet and shared components, not per page.',
    `Files: ${files.report}, ${files.css.join(', ')}`,
    'Steps:',
    '- Read style-check.md. Take each value from the design stylesheet named there (copy the rule, do not guess).',
    '- Put tokens in the app\'s global stylesheet; fix each listed class there or in its shared component; remove page or component rules that override these classes with other values.',
    '- Do not touch layout, data, texts or behaviour. Do not take screenshots.',
    `- At the end run \`node ${cli} style-check ${root}\` ONCE (it re-reads the running app, no AI) and fix only what it still lists from your changes. Then stop.`,
    'Done when:',
    ...r.tokens.slice(0, 30).map(x => `- ${tokenLine(x)}: fixed`),
    ...r.drifts.slice(0, 40).map(x => `- ${driftLine(x)}: fixed`),
    ...(r.drifts.length > 40 ? [`- the other ${r.drifts.length - 40} lines of style-check.md: fixed`] : []),
    '- the build passes',
  ].join('\n');
}

// The whole check, no AI: shoot the app's screens again with the audit's app-jobs.json (screens only, not every
// state: styles are the same), compare styles, write the report, the design stylesheets and compare.html.
export async function runStyleCheck(root: string, copy: string, opts: { capture?: boolean; progress?: (line: string) => void } = {}) {
  const refDir = DC.screensOf(copy), design = path.join(root, '.justcode', 'design'), appDir = path.join(design, 'audit');
  const jobsFile = path.join(design, 'app-jobs.json');
  if (opts.capture !== false) {
    if (!fs.existsSync(jobsFile)) throw new Error('no .justcode/design/app-jobs.json: run Fix to match once so Claude sets it up');
    const jobs = DC.parseJobs(fs.readFileSync(jobsFile, 'utf8'));
    const r = await DC.capture({ groups: jobs.groups.map(g => ({ ...g, states: undefined })) }, l => opts.progress?.(`App: ${l}`));
    if (!r.done) throw new Error(`could not shoot the app (${r.failed[0] ?? 'nothing captured'}). Is it running?`);
  }
  opts.progress?.('Comparing styles…');
  const report = styleCheck(root, refDir, appDir);
  const css = designStylesheets(refDir, design);
  writeReport(root, report, css);
  const per = (name: string) => report.drifts.filter(x => x.screens.includes(name.replace(/-\d{3,4}$/, '').split('~')[0]) && name.endsWith(`-${x.width}`)).map(driftLine);
  const merged = DC.mergedScreens(DC.loadStates(path.join(refDir, 'states.json')));
  const names = fs.readdirSync(refDir).filter(f => /-\d{3,4}\.png$/.test(f)).map(f => f.replace(/\.png$/, '')).filter(n => !n.includes('~') && !merged.has(n) && fs.existsSync(path.join(appDir, `${n}.png`)));
  DC.writeCompare(refDir, appDir, appDir, names.map(name => ({ name, n: per(name).length })), per);
  return { report, css };
}
