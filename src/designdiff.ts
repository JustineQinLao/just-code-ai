// Design versus app, from code: both sides are measured in the browser by the same function (MEASURE_FN in skill.ts:
// every visible text and control with its computed style and box, plus the CSS rules the page uses), and compared here,
// so a difference is a number from the page, not a guess from a picture. Used by `cli.js design-diff` and `design-css`.

export interface Box { x: number; w: number; pad: string; radius: string; bg: string; border: string }
export interface Item { text: string; cls?: string; x: number; w: number; h: number; font: string; size: number; weight: string; color: string; align: string; bg: string; radius: string; box: Box | null }
// missing: the label of a control the page did not have, so the state could not be reached (nothing was measured).
export interface Measure { v?: number; width?: number; items: Item[]; css?: string; missing?: string }
// Measures without v (or an older one) lack element classes: a design measured that way is measured again.
export const MEASURE_V = 2;
// line: what to show; rule: the same difference without the text it was found on (with the element's classes), so the
// one CSS rule behind it can be found across screens.
export interface Diff { line: string; rule?: string; text?: string; data?: boolean }

// Text the app's records make, not its design: anything with a number in it (dates, times, amounts, counts, ids), or a
// text the app shows several times (rows of a list), or a record's field as "name: value". The app's data is not the design's sample, so such a text missing
// or extra is no fix to make; it is listed apart and not counted.
export const looksData = (text: string, times = 1) => /\d/.test(text) || /^[a-z_]+: /.test(text) || times > 1;   // "slug: malanday": a record's field

// Accepts what browser_evaluate saved: the object, or the same as a JSON string.
export function parseMeasure(text: string): Measure {
  let v: any = JSON.parse(text);
  if (typeof v === 'string') v = JSON.parse(v);
  if (Array.isArray(v)) v = { items: v };
  if (!v || !Array.isArray(v.items)) throw new Error('not a design measure (expected { items: [...] })');
  return v as Measure;
}

const TOL = 6;   // px: anti-aliasing and rounding, not a design difference

// Sample data in the design (names, amounts, dates the app fills from its own data): a text that IS one of these
// (alone, or with only digits, symbols and up to 3 letters around it, e.g. "₱75 · 3 items") is never "missing" or
// "extra". A sentence that merely mentions one ("Then apply to Agos Water – Malanday") is still compared.
const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
export const isSample = (text: string, sample: string[]) => {
  const t = norm(text);
  return sample.some(raw => { const s = norm(raw); return !!s && (t === s || (t.includes(s) && t.split(s).join('').replace(/[^a-z]/g, '').length <= 3)); });
};
// Only data-like entries count as sample: short (at most 60 characters and 8 words, room for an address). Labels, headings and sentences are
// design copy, never sample, even when an audit lists them.
export const usableSample = (list: string[]) => list.filter(x => { const t = x.trim(); return t.length > 0 && t.length <= 60 && t.split(/\s+/).length <= 8; });

// An unlabelled icon, image or control is measured under its tag name ("svg"): with nothing to match it by, pairing it
// with "the next svg" compares unrelated elements, so such items are left out of the diff.
export const unlabelled = (x: Item) => /^(svg|img|input|button|select|textarea)$/i.test(x.text.trim());

// How alike two texts are: the Dice coefficient of their letter pairs (1 = same, 0 = nothing shared).
export function similarity(a: string, b: string) {
  const pairs = (x: string) => { const t = x.toLowerCase().replace(/\s+/g, ' ').trim(), m = new Map<string, number>(); for (let i = 0; i < t.length - 1; i++) { const p = t.slice(i, i + 2); m.set(p, (m.get(p) ?? 0) + 1); } return m; };
  const A = pairs(a), B = pairs(b);
  let both = 0, n = 0;
  for (const [p, c] of A) { both += Math.min(c, B.get(p) ?? 0); n += c; }
  for (const c of B.values()) n += c;
  return n ? (2 * both) / n : (a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0);
}
const NEAR = 0.6;   // texts this alike (and on the same kind of element) are the same element with different copy

export function diffItems(design: Measure, app: Measure, sample: string[] = []): Diff[] {
  design = { ...design, items: design.items.filter(x => !unlabelled(x)) }; app = { ...app, items: app.items.filter(x => !unlabelled(x)) };
  const out: Diff[] = [], pool = new Map<string, Item[]>(), k = (x: Item) => x.text.trim().toLowerCase();
  const seen = new Set<string>(), once = (key: string, d: Diff) => { if (!seen.has(key)) { seen.add(key); out.push(d); } };   // a card's difference once, not per text in it
  for (const y of app.items) { const key = k(y); if (!pool.has(key)) pool.set(key, []); pool.get(key)!.push(y); }
  const compare = (x: Item, y: Item) => {
    const cls = (x.cls || y.cls || '').trim(), on = cls ? `.${cls.split(/\s+/).slice(0, 2).join('.')}` : `<${x.text.slice(0, 20)}>`;
    for (const p of ['font', 'size', 'weight', 'color', 'align', 'bg', 'radius'] as const)
      if (String(x[p]) !== String(y[p])) out.push({ line: `"${x.text}" ${p}: design ${x[p]}, app ${y[p]}`, rule: `${on} ${p}: design ${x[p]}, app ${y[p]}`, text: x.text });
    for (const p of ['x', 'w', 'h'] as const)
      if (Math.abs(x[p] - y[p]) > TOL) out.push({ line: `"${x.text}" ${p}: design ${x[p]}px, app ${y[p]}px`, rule: `${on} ${p}: design ${x[p]}px, app ${y[p]}px`, text: x.text });
    if (x.box && y.box) {
      const card = `${x.box.x}:${x.box.w}:${x.box.bg}`, at = `container of "${x.text}"`;
      for (const p of ['x', 'w'] as const)
        if (Math.abs(x.box[p] - y.box[p]) > TOL) once(`${card}:${p}`, { line: `${at} ${p}: design ${x.box[p]}px, app ${y.box[p]}px` });
      for (const p of ['pad', 'radius', 'bg', 'border'] as const)
        if (x.box[p] !== y.box[p]) once(`${card}:${p}`, { line: `${at} ${p}: design ${x.box[p]}, app ${y.box[p]}`, rule: `${on} container ${p}: design ${x.box[p]}, app ${y.box[p]}`, text: x.text });
    } else if (x.box && !y.box) out.push({ line: `"${x.text}" container: design has a card or panel (${x.box.w}px, ${x.box.bg}), app has none` });
  };
  // 1. The same text on both sides.
  const unmatched: Item[] = [];
  for (const x of design.items) { const y = pool.get(k(x))?.shift(); if (y) compare(x, y); else unmatched.push(x); }
  // 2. Near text on the same kind of element (same first class, or nearly the same words): one element whose copy
  //    differs, compared like the rest, instead of a "missing" plus an "extra".
  const left = [...pool.values()].flat();
  for (const x of unmatched) {
    let best: Item | undefined, score = 0;
    for (const y of left) {
      const sim = similarity(x.text, y.text), same = (x.cls || '').split(/\s+/)[0] === (y.cls || '').split(/\s+/)[0];
      if (sim > score && sim >= NEAR && (same || sim >= 0.8)) { best = y; score = sim; }
    }
    if (best) {
      left.splice(left.indexOf(best), 1);
      if (!isSample(x.text, sample) && !isSample(best.text, sample)) out.push({ line: `copy differs: design "${x.text}", app "${best.text}"`, rule: `copy "${x.text.slice(0, 40)}": app "${best.text.slice(0, 40)}"`, text: x.text, data: looksData(x.text) || looksData(best.text) });
      compare(x, best);
      continue;
    }
    // Missing and extra texts carry a rule too: the same text missing on many screens is one shared piece (a header,
    // a nav item), fixed once, not per screen.
    if (!isSample(x.text, sample)) out.push({ line: `missing in app: "${x.text}"`, rule: `missing in app: "${x.text.slice(0, 40)}"`, text: x.text, data: looksData(x.text, design.items.filter(z => z.text === x.text).length) });
  }
  for (const y of left) if (!isSample(y.text, sample)) out.push({ line: `extra in app: "${y.text}"`, rule: `extra in app: "${y.text.slice(0, 40)}"`, text: y.text, data: looksData(y.text, app.items.filter(z => z.text === y.text).length) });
  return out;
}

// One line per difference, design first: text in the design but not the app, then style and box differences of the
// texts both have (matched by text, in order), then texts only the app has.
export const diffMeasures = (design: Measure, app: Measure, sample: string[] = []) => diffItems(design, app, sample).map(d => d.line);
