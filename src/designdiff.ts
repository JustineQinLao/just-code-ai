// Design versus app, from code: both sides are measured in the browser by the same function (MEASURE_FN in skill.ts:
// every visible text and control with its computed style and box, plus the CSS rules the page uses), and compared here,
// so a difference is a number from the page, not a guess from a picture. Used by `cli.js design-diff` and `design-css`.

export interface Box { x: number; w: number; pad: string; radius: string; bg: string; border: string }
export interface Item { text: string; cls?: string; x: number; w: number; h: number; font: string; size: number; weight: string; color: string; align: string; bg: string; radius: string; box: Box | null }
export interface Measure { width?: number; items: Item[]; css?: string }
// line: what to show; rule: the same difference without the text it was found on (with the element's classes), so the
// one CSS rule behind it can be found across screens.
export interface Diff { line: string; rule?: string }

// Accepts what browser_evaluate saved: the object, or the same as a JSON string.
export function parseMeasure(text: string): Measure {
  let v: any = JSON.parse(text);
  if (typeof v === 'string') v = JSON.parse(v);
  if (Array.isArray(v)) v = { items: v };
  if (!v || !Array.isArray(v.items)) throw new Error('not a design measure (expected { items: [...] })');
  return v as Measure;
}

const TOL = 6;   // px: anti-aliasing and rounding, not a design difference

// Sample data in the design (names, amounts, dates the app fills from its own data): a text containing one of these
// is never "missing" or "extra", only compared for style when both sides have it.
export const isSample = (text: string, sample: string[]) => { const t = text.toLowerCase(); return sample.some(s => !!s && t.includes(s.toLowerCase())); };

export function diffItems(design: Measure, app: Measure, sample: string[] = []): Diff[] {
  const out: Diff[] = [], pool = new Map<string, Item[]>(), k = (x: Item) => x.text.trim().toLowerCase();
  const seen = new Set<string>(), once = (key: string, d: Diff) => { if (!seen.has(key)) { seen.add(key); out.push(d); } };   // a card's difference once, not per text in it
  for (const y of app.items) { const key = k(y); if (!pool.has(key)) pool.set(key, []); pool.get(key)!.push(y); }
  for (const x of design.items) {
    const y = pool.get(k(x))?.shift();
    if (!y) { if (!isSample(x.text, sample)) out.push({ line: `missing in app: "${x.text}"` }); continue; }
    const on = x.cls ? `.${x.cls.split(/\s+/).slice(0, 2).join('.')}` : '';
    for (const p of ['font', 'size', 'weight', 'color', 'align', 'bg', 'radius'] as const)
      if (String(x[p]) !== String(y[p])) out.push({ line: `"${x.text}" ${p}: design ${x[p]}, app ${y[p]}`, rule: `${on} ${p}: design ${x[p]}, app ${y[p]}`.trim() });
    for (const p of ['x', 'w', 'h'] as const)
      if (Math.abs(x[p] - y[p]) > TOL) out.push({ line: `"${x.text}" ${p}: design ${x[p]}px, app ${y[p]}px` });
    if (x.box && y.box) {
      const card = `${x.box.x}:${x.box.w}:${x.box.bg}`, at = `container of "${x.text}"`;
      for (const p of ['x', 'w'] as const)
        if (Math.abs(x.box[p] - y.box[p]) > TOL) once(`${card}:${p}`, { line: `${at} ${p}: design ${x.box[p]}px, app ${y.box[p]}px` });
      for (const p of ['pad', 'radius', 'bg', 'border'] as const)
        if (x.box[p] !== y.box[p]) once(`${card}:${p}`, { line: `${at} ${p}: design ${x.box[p]}, app ${y.box[p]}`, rule: `container ${p}: design ${x.box[p]}, app ${y.box[p]}` });
    } else if (x.box && !y.box) out.push({ line: `"${x.text}" container: design has a card or panel (${x.box.w}px, ${x.box.bg}), app has none` });
  }
  for (const rest of pool.values()) for (const y of rest) if (!isSample(y.text, sample)) out.push({ line: `extra in app: "${y.text}"` });
  return out;
}

// One line per difference, design first: text in the design but not the app, then style and box differences of the
// texts both have (matched by text, in order), then texts only the app has.
export const diffMeasures = (design: Measure, app: Measure, sample: string[] = []) => diffItems(design, app, sample).map(d => d.line);
