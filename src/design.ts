import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

// Designs come from github.com/VoltAgent/awesome-design-md. Layout assumed (not verifiable offline; adjust if the repo
// changes): one folder per brand under design-md/, each holding a DESIGN.md, i.e. design-md/<name>/DESIGN.md on main.
export const REPO = 'VoltAgent/awesome-design-md';
export const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`;
export const rawUrl = (name: string) => `https://raw.githubusercontent.com/${REPO}/main/design-md/${encodeURIComponent(name)}/DESIGN.md`;
export const CACHE_TTL = 24 * 3600 * 1000;
export const cacheFile = () => path.join(os.homedir(), '.justcode-cache', 'designs.json');

export interface DesignEntry { name: string; path: string }

// Entries from a git tree JSON: the design-md/<name>/DESIGN.md blobs.
export function parseTree(tree: any): DesignEntry[] {
  const items: any[] = Array.isArray(tree?.tree) ? tree.tree : [];
  return items.flatMap(i => {
    const m = i?.type === 'blob' && typeof i.path === 'string' ? /^design-md\/([^/]+)\/DESIGN\.md$/.exec(i.path) : null;
    return m ? [{ name: m[1], path: i.path as string }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDesigns(fetchJson: (url: string) => Promise<any> = defaultJson, now = Date.now(), file = cacheFile()): Promise<DesignEntry[]> {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof c?.time === 'number' && now - c.time < CACHE_TTL && Array.isArray(c.designs)) return c.designs;
  } catch { /* no cache */ }
  const designs = parseTree(await fetchJson(TREE_URL));
  if (designs.length) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ time: now, designs })); } catch { /* cache is optional */ }
  }
  return designs;
}

async function defaultText(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'justcode', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
async function defaultJson(url: string) { return JSON.parse(await defaultText(url)); }
export const fetchDesign = (name: string) => defaultText(rawUrl(name));

const dir = (root: string) => path.join(root, '.justcode', 'design');
export const designFile = (root: string) => path.join(dir(root), 'DESIGN.md');
export const originFile = (root: string) => path.join(dir(root), 'origin.json');

// Writes DESIGN.md and origin.json (where it came from and its sha256).
export function installDesign(root: string, content: string, origin: { source: string; name?: string; url?: string }) {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.writeFileSync(designFile(root), content);
  const info = { ...origin, sha256: createHash('sha256').update(content).digest('hex'), savedAt: new Date().toISOString() };
  fs.writeFileSync(originFile(root), JSON.stringify(info, null, 2));
  return info;
}
export const removeDesign = (root: string) => { for (const f of [designFile(root), originFile(root)]) fs.rmSync(f, { force: true }); };
