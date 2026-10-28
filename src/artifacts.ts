import * as fs from 'fs';
import * as path from 'path';
import { Task } from './store';

// Artifacts are the basis of every task: small written files each step reads instead of re-exploring the code or
// carrying a long history. All live under the project's .justcode/ (outside git):
//   sources.json          the project's source material (specs, designs, docs, URLs) with a note each
//   progress.md           one entry per merged task: what it changed (later tasks read this, not the git history)
//   tasks/<id>/brief.md   the task, its acceptance criteria and which sources it rests on (written by JustCode)
//   tasks/<id>/handoff.md what the builder changed and how it verified it (written by Claude at the end of each turn)
//   tasks/<id>/review.md  the reviewer's last verdict (written by JustCode)

export interface Source { id: string; kind: 'file' | 'folder' | 'url'; ref: string; note?: string }

const jc = (root: string, ...p: string[]) => path.join(root, '.justcode', ...p);
export const taskDir = (root: string, id: string) => jc(root, 'tasks', id);
export const briefFile = (root: string, id: string) => path.join(taskDir(root, id), 'brief.md');
export const handoffFile = (root: string, id: string) => path.join(taskDir(root, id), 'handoff.md');
export const reviewFile = (root: string, id: string) => path.join(taskDir(root, id), 'review.md');
export const planFile = (root: string, id: string) => path.join(taskDir(root, id), 'plan.md');
export const writePlan = (root: string, id: string, plan: string) => write(planFile(root, id), plan.trim() + '\n');
export const progressFile = (root: string) => jc(root, 'progress.md');

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

export function loadSources(root: string): Source[] {
  try {
    const s = JSON.parse(read(jc(root, 'sources.json')) || '[]');
    return Array.isArray(s) ? s.filter((x: any) => x && typeof x.ref === 'string') : [];
  } catch { return []; }
}
export const saveSources = (root: string, s: Source[]) => write(jc(root, 'sources.json'), JSON.stringify(s, null, 2));

// The source's location as Claude can open it: project files by their path in the task's copy, outside files absolute.
function where(root: string, s: Source) {
  if (s.kind === 'url') return s.ref;
  const rel = path.relative(root, s.ref);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : s.ref;
}
// Sources outside the project (Claude needs read access to them).
export const outsideDirs = (root: string, sources: Source[]) => [...new Set(sources.filter(s => s.kind !== 'url').map(s => {
  const rel = path.relative(root, s.ref);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '';
  return s.kind === 'folder' ? s.ref : path.dirname(s.ref);
}).filter(Boolean))];

// The brief: everything the builder needs to start, as references rather than pasted content, so it reads only
// what the task needs. Rewritten on each fresh session (the task may have been edited).
export function writeBrief(root: string, t: Task, sources: Source[]) {
  const picked = t.sources ? sources.filter(s => t.sources!.includes(s.id)) : sources;
  const files = t.files ?? [];
  const text = [
    `# ${t.title}`,
    t.description?.trim() && t.description.trim() !== t.title.trim() ? t.description.trim() : '',
    picked.length || files.length || t.images?.length ? '## Sources (the basis for this task; open only what you need)' : '',
    ...picked.map(s => `- ${where(root, s)}${s.note ? ` — ${s.note}` : ''}`),
    ...files.map(f => `- ${f}`),
    ...(t.images ?? []).map(f => `- ${f} (screenshot: read it first)`),
    fs.existsSync(planFile(root, t.id)) ? `## Approved plan\nFollow ${planFile(root, t.id)}.` : '',
    fs.existsSync(progressFile(root)) ? `## Project history\nWhat earlier tasks changed: ${progressFile(root)} (read it if you need context on recent work).` : '',
    `## When you finish\nUpdate ${handoffFile(root, t.id)} (create it if missing), at most 30 lines:\n` +
    '- What you changed and why (files, key decisions)\n- How you verified it: the exact commands you ran and their result\n- Anything left open, or risks for the reviewer to check',
  ].filter(Boolean).join('\n\n');
  write(briefFile(root, t.id), text + '\n');
  return text;
}

export const readHandoff = (root: string, id: string) => read(handoffFile(root, id)).trim().slice(0, 6000);

export function writeReview(root: string, id: string, v: { pass: boolean; issues: string[]; tested: string[]; risk: string }, round: number) {
  write(reviewFile(root, id), [`# Review round ${round}: ${v.pass ? 'PASS' : 'ISSUES'} (risk: ${v.risk})`,
    v.issues.length ? `## Issues\n${v.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '',
    v.tested.length ? `## Reviewer ran\n${v.tested.map(c => `- ${c}`).join('\n')}` : ''].filter(Boolean).join('\n\n') + '\n');
}

// One entry per merged task, newest last; capped so it stays a cheap read.
export function appendProgress(root: string, t: Task) {
  const handoff = readHandoff(root, t.id).split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 6).join('\n');
  const entry = `## ${new Date().toISOString().slice(0, 10)} · ${t.title}\n${handoff || t.description?.split('\n')[0] || ''}\n`;
  const cur = read(progressFile(root));
  const entries = (cur + '\n' + entry).split(/\n(?=## )/).filter(e => e.trim()).slice(-40);
  write(progressFile(root), entries.join('\n\n').trim() + '\n');
}

export const removeTaskDir = (root: string, id: string) => fs.rmSync(taskDir(root, id), { recursive: true, force: true });

// Review triage: what kind of review a diff needs. Docs-only changes need none; small changes outside sensitive code
// get the lighter model; everything else the full reviewer.
const SENSITIVE = /(auth|login|passw|token|secret|crypt|permission|role|payment|billing|migrat|security|session|\.env|settings|config|docker|deploy|\.github\/|schema|sql)/i;
const DOC = /\.(md|mdx|txt|rst|adoc)$|^(docs?|\.github\/ISSUE_TEMPLATE)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i;
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;

export function triage(diff: string): { level: 'none' | 'light' | 'full'; files: string[]; changed: number; why: string } {
  const files = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(m => m[2]);
  const changed = diff.split('\n').filter(l => /^[+-](?![+-]{2} )/.test(l)).length;
  const code = files.filter(f => !DOC.test(f) && !LOCK.test(f));
  if (files.length && !code.length) return { level: 'none', files, changed, why: 'only documentation or lockfiles changed' };
  if (code.some(f => SENSITIVE.test(f))) return { level: 'full', files, changed, why: 'touches sensitive code' };
  if (changed <= 60 && code.length <= 3) return { level: 'light', files, changed, why: `small change (${changed} lines in ${code.length} file${code.length === 1 ? '' : 's'})` };
  return { level: 'full', files, changed, why: `${changed} changed lines in ${code.length} files` };
}
