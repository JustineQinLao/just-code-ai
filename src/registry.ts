import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { artifactKey, copyFiles } from './artifacts';

// Every claude.ai artifact the project has used or produced, in one list: .justcode/artifacts.json.
// input: a link typed in a prompt or task, or a saved source. output: a page a task published.
export interface ArtifactEntry {
  id: string;                 // artifactKey(url), hashed to 8 hex
  url: string;
  title?: string;
  kind: 'input' | 'output';
  taskIds: string[];          // tasks that used (input) or produced (output) it
  sprintIds: string[];
  firstSeen: number;
  lastSeen: number;
  savedAt?: number;           // input: when the local copy was last saved
  sha256?: string;            // input: hash of the saved copy's files; output: hash of the published page
  files?: number;
  note?: string;
  changed?: boolean;          // the last refresh found different content; cleared when you look at it
}

export const registryFile = (root: string) => path.join(root, '.justcode', 'artifacts.json');
export const entryId = (url: string) => createHash('sha256').update(artifactKey(url)).digest('hex').slice(0, 8);

export function load(root: string): ArtifactEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(registryFile(root), 'utf8'));
    return Array.isArray(v) ? v.filter(e => e && typeof e.url === 'string' && typeof e.id === 'string') : [];
  } catch { return []; }
}

export function save(root: string, list: ArtifactEntry[]) {
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

// Adds the artifact or updates it. An output stays an output when its link is later typed in a prompt.
export function upsert(root: string, url: string, patch: Partial<Omit<ArtifactEntry, 'id' | 'url'>> = {}, now = Date.now()) {
  const list = load(root), id = entryId(url);
  let e = list.find(x => x.id === id);
  if (!e) {
    e = { id, url: artifactKey(url), kind: patch.kind ?? 'input', taskIds: [], sprintIds: [], firstSeen: now, lastSeen: now };
    list.push(e);
  }
  const kind = e.kind === 'output' ? 'output' : patch.kind ?? e.kind;
  Object.assign(e, patch, { kind, lastSeen: now });
  save(root, list);
  return e;
}

export function link(root: string, url: string, taskId: string, sprintId?: string, kind?: ArtifactEntry['kind']) {
  const e = upsert(root, url, kind ? { kind } : {});
  const list = load(root), x = list.find(y => y.id === e.id)!;
  if (!x.taskIds.includes(taskId)) x.taskIds.push(taskId);
  if (sprintId && !x.sprintIds.includes(sprintId)) x.sprintIds.push(sprintId);
  save(root, list);
  return x;
}

// A deleted task leaves the artifact in the list; only its link to the task goes.
export function unlinkTask(root: string, taskId: string) {
  const list = load(root);
  if (!list.some(e => e.taskIds.includes(taskId))) return;
  for (const e of list) e.taskIds = e.taskIds.filter(t => t !== taskId);
  save(root, list);
}

export const byTask = (root: string, taskId: string) => load(root).filter(e => e.taskIds.includes(taskId));
export const find = (root: string, url: string) => load(root).find(e => e.id === entryId(url));

// sha256 over a saved copy's files (names and bytes, sorted), so a refresh can tell whether the artifact changed.
export function hashCopy(root: string, sourceId: string) {
  const files = copyFiles(root, sourceId).sort();
  const h = createHash('sha256');
  for (const f of files) { h.update(path.basename(f)); h.update(fs.readFileSync(f)); }
  return { sha256: h.digest('hex'), files: files.length };
}

// After a source copy is saved: records the hash and flags the artifact when its content changed since last time.
export function recordSaved(root: string, url: string, sourceId: string, now = Date.now()) {
  const prev = find(root, url), { sha256, files } = hashCopy(root, sourceId);
  const changed = !!prev?.sha256 && prev.sha256 !== sha256;
  return upsert(root, url, { savedAt: now, sha256, files, ...(changed ? { changed: true } : {}) }, now);
}

export const titleOf = (html: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || undefined;

// One line per artifact for a brief or plan: newest first, at most `max`, skipping the links in `skip`.
export function forBrief(root: string, taskTitle: (id: string) => string | undefined, skip: string[] = [], max = 20, sourceCopyOf?: (url: string) => string | undefined) {
  const skipIds = new Set(skip.map(entryId));
  return load(root).filter(e => !skipIds.has(e.id)).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, max).map(e => {
    const tasks = e.taskIds.map(taskTitle).filter(Boolean) as string[];
    const who = e.kind === 'output' ? (tasks.length ? `produced by task "${tasks[0]}"` : 'a published page') : (tasks.length ? `used by ${tasks.map(t => `"${t}"`).join(', ')}` : 'an input');
    const copy = sourceCopyOf?.(e.url);
    return `- ${e.title ? `${e.title}: ` : ''}${e.url} (${e.kind}, ${who})${copy ? `, local copy: ${copy}` : ''}${e.note ? ` — ${e.note}` : ''}`;
  });
}
