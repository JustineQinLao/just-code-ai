import * as fs from 'fs';
import * as path from 'path';
import { screensOf } from './designcapture';
import { Task } from './store';
import * as R from './registry';
import { SHOT_VERSION, arg } from './skill';

// Artifacts are the basis of every task: small written files each step reads instead of re-exploring the code or
// carrying a long history. All live under the project's .justcode/ (outside git):
//   sources.json          the project's source material (specs, designs, docs, URLs) with a note each
//   progress.md           one entry per merged task: what it changed (later tasks read this, not the git history)
//   tasks/<id>/brief.md   the task, its acceptance criteria and which sources it rests on (written by JustCode)
//   tasks/<id>/handoff.md what the builder changed and how it verified it (written by Claude at the end of each turn)
//   tasks/<id>/review.md  the reviewer's last verdict (written by JustCode)
//   prompts.jsonl         every prompt you typed (new task, message, planning request), kept after tasks are merged or deleted

export interface Source { id: string; kind: 'file' | 'folder' | 'url'; ref: string; note?: string }

// A claude.ai artifact link opens only when signed in to claude.ai, so a task's Claude gets just its title from a
// fetch. JustCode saves the artifact's files in a folder next to the sources; briefs point Claude at that copy.
// An artifact made from a type (a Design canvas, a deck) has the type's editor as its index.html and its real content
// under project/, so the copy holds project/ (canvas.json and one .dc.html per screen) rather than the editor page.
export const isArtifactLink = (url: string) => /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+\/?(?:[?#].*)?$/.test(url.trim());
export const sourceCopy = (root: string, id: string) => jc(root, 'sources', id);
const files = (dir: string): string[] => { try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); } catch { return []; } };
export const copyFiles = (root: string, id: string) => files(sourceCopy(root, id)).filter(f => !path.basename(f).startsWith('.'));
// claude.ai artifact links written in a prompt or a task's text.
export const artifactLinksIn = (text: string) => [...new Set((text.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g) ?? []))];
// Links from a prompt become project sources (once), so every later plan and task builds on them too.
export const artifactKey = (url: string) => url.trim().replace(/[?#].*$/, '').replace(/\/$/, '');
// Artifact links you deleted from the sources: a prompt that mentions one again does not add it back.
const removedFile = (root: string) => jc(root, 'sources-removed.json');
export function removedLinks(root: string): string[] {
  try { const l = JSON.parse(read(removedFile(root)) || '[]'); return Array.isArray(l) ? l.filter(x => typeof x === 'string') : []; } catch { return []; }
}
export function markRemoved(root: string, ref: string, removed: boolean) {
  const key = artifactKey(ref), cur = removedLinks(root).filter(l => l !== key);
  write(removedFile(root), JSON.stringify(removed ? [...cur, key] : cur, null, 2));
}

export function addLinkSources(root: string, text: string) {
  const all = loadSources(root), have = new Set([...all.map(s => artifactKey(s.ref)), ...removedLinks(root)]);
  const add = artifactLinksIn(text).filter(l => !have.has(l)).map(ref => ({ id: Math.random().toString(16).slice(2, 10), kind: 'url' as const, ref, note: 'claude.ai artifact from a prompt' }));
  if (add.length) saveSources(root, [...all, ...add]);
  try { for (const l of artifactLinksIn(text)) R.upsert(root, l, { kind: 'input' }); } catch { /* the registry is a convenience */ }
  return add;
}
// The sources section of a planning chat's first message: where each one is, as a task's brief lists them.
export const sourceLines = (root: string, sources: Source[]) => sources.length
  ? `## Sources (the basis for this plan: read the ones that matter before proposing tasks)\n${sources.map(s => `- ${where(root, s)}${s.note ? ` — ${s.note}` : ''}`).join('\n')}\n\n` : '';
export const hasCopy = (root: string, s: Source) => s.kind === 'url' && isArtifactLink(s.ref) && copyFiles(root, s.id).length > 0;

const jc = (root: string, ...p: string[]) => path.join(root, '.justcode', ...p);
export const taskDir = (root: string, id: string) => jc(root, 'tasks', id);
export const briefFile = (root: string, id: string) => path.join(taskDir(root, id), 'brief.md');
export const handoffFile = (root: string, id: string) => path.join(taskDir(root, id), 'handoff.md');
export const artifactFile = (root: string, id: string) => path.join(taskDir(root, id), 'artifact.html');
export const shotsDir = (root: string, id: string) => path.join(taskDir(root, id), 'shots');
export const reviewFile = (root: string, id: string) => path.join(taskDir(root, id), 'review.md');
export const checksLog = (root: string, id: string) => path.join(taskDir(root, id), 'checks.log');
export const transcriptFile = (root: string, id: string) => path.join(taskDir(root, id), 'transcript.jsonl');
// Copies the new lines of a session's transcript into the task's own archive, which outlives the task folder and
// Claude Code's per-folder session store. Several sessions (fresh fix rounds) append to the same file in order.
export function archiveTranscript(root: string, id: string, source: string, sessionId: string) {
  let text: string;
  try { text = fs.readFileSync(source, 'utf8'); } catch { return 0; }
  const lines = text.split('\n').filter(Boolean);
  const mark = path.join(taskDir(root, id), '.transcript.json');
  let seen: Record<string, number> = {};
  try { seen = JSON.parse(fs.readFileSync(mark, 'utf8')) ?? {}; } catch { /* first copy */ }
  const from = seen[sessionId] ?? 0;
  if (lines.length <= from) return 0;
  fs.mkdirSync(taskDir(root, id), { recursive: true });
  fs.appendFileSync(transcriptFile(root, id), lines.slice(from).join('\n') + '\n');
  fs.writeFileSync(mark, JSON.stringify({ ...seen, [sessionId]: lines.length }));
  return lines.length - from;
}
export const planFile = (root: string, id: string) => path.join(taskDir(root, id), 'plan.md');
export const writePlan = (root: string, id: string, plan: string) => write(planFile(root, id), plan.trim() + '\n');
export const progressFile = (root: string) => jc(root, 'progress.md');
export const projectFile = (root: string) => jc(root, 'project.md');
export const designMdFile = (root: string) => jc(root, 'design', 'DESIGN.md');
// Points a session at the project description JustCode's setup skill wrote, when there is one.
export const projectSection = (root: string) => fs.existsSync(projectFile(root)) ? `## Project\nRead ${projectFile(root)} first.` : '';

// UI-ish work (or an artifact page) follows the project's DESIGN.md when one exists.
const UI_WORDS = /\b(ui|ux|frontend|front-end|css|html|page|screen|layout|landing|dashboard|button|modal|dialog|form|component|style|styling|theme|navbar|sidebar|webview|responsive|visual)s?\b/i;
// A design screen file a task must match: a design reference (.justcode/design/ref, 🎨 Fix to match; screens/ in older
// copies) or a canvas's project/ files.
export const DESIGN_FILE = /\.justcode[\\/](?:sources[\\/][^\s,]+[\\/](?:screens[\\/][^\s,]+\.(?:png|html|css|json)|project[\\/][^\s,]+\.dc\.html)|design[\\/]ref[\\/][^\s,]+\.(?:png|html|css|json))/;
export const isUiTask = (t: Task) => t.output === 'artifact' || t.init === 'fixdesign' || !!t.designFix || UI_WORDS.test(`${t.title}\n${t.description ?? ''}`) || DESIGN_FILE.test(t.description ?? '');
const designSection = (root: string, t: Task) => isUiTask(t) && fs.existsSync(designMdFile(root))
  ? `## Design system\nFollow ${designMdFile(root)} as the style spec (colors, type, spacing, components) for any UI you build or change.` : '';

export interface Prompt { time: number; kind: 'task' | 'message' | 'plan'; text: string; taskId?: string; title?: string; sessionId?: string }
export const promptsFile = (root: string) => jc(root, 'prompts.jsonl');
export function logPrompt(root: string, p: Omit<Prompt, 'time'>) {
  try {
    fs.mkdirSync(jc(root), { recursive: true });
    fs.appendFileSync(promptsFile(root), JSON.stringify({ time: Date.now(), ...p }) + '\n');
  } catch { /* history is a convenience: never stops the prompt itself */ }
}
export function readPrompts(root: string): Prompt[] {
  let text = '';
  try { text = fs.readFileSync(promptsFile(root), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(l => { try { const p = JSON.parse(l); return typeof p?.text === 'string' && typeof p.time === 'number' ? [p] : []; } catch { return []; } });
}

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

export function loadSources(root: string): Source[] {
  try {
    const s = JSON.parse(read(jc(root, 'sources.json')) || '[]');
    return Array.isArray(s) ? s.filter((x: any) => x && typeof x.ref === 'string') : [];
  } catch { return []; }
}
export const saveSources = (root: string, s: Source[]) => write(jc(root, 'sources.json'), JSON.stringify(s, null, 2));
// Sources live in one project library; a sprint uses the ones it lists (all of them when it lists none, as before).
export const sprintSources = (all: Source[], sprint?: { sources?: string[] }) => sprint?.sources ? all.filter(s => sprint.sources!.includes(s.id)) : all;
// The library sources a prompt's claude.ai links point at (a source's ref may carry a #page part).
export const linkedSources = (all: Source[], text: string) => {
  const links = artifactLinksIn(text);
  return all.filter(s => links.includes(artifactKey(s.ref)));
};

// The source's location as Claude can open it: project files by their path in the task's copy, outside files absolute.
function where(root: string, s: Source, cli?: string) {
  if (hasCopy(root, s)) {
    const dir = sourceCopy(root, s.id), canvas = path.join(dir, 'project', 'canvas.json'), scr = screensOf(dir);
    if (fs.existsSync(path.join(scr, 'screens.json')))
      return `${dir}/ (saved copy of the design ${s.ref}; that link needs a claude.ai sign-in, so use this folder). ` +
        `Its reference, made by 🎨 Fix to match, is ${scr}/: screens.json lists every screen per width: its .css (the design's own CSS rules for that screen: copy these values, never estimate them from the image), ` +
        `its .html (the markup: same structure, order and copy), its .json (measured fonts, sizes, colors and boxes), its PNG (only for a look), and the app URL that gives the same state. ` +
        `Every state that clicks open (a modal and its steps, a panel, a picked option, a menu or sheet: up to 3 clicks deep) has its own files, named <screen>~<label>[~<label>…]-<width>; ` +
        `states.json lists each with its steps (the labels to click, and the values typed into fields first), plus the other behaviours (toast: a short message; go: it leads to another screen). ` +
        `Build those states and behaviours too, with the same control and field labels, so the same clicks reach them in the app. ` +
        `Build the screens your task covers from that code; only the data comes from the app. ` +
        `The app running at the project's link serves the project folder, not your task folder: to measure your change, start your folder's frontend detached on a free port (pointing at the running backend), and stop it after. ` +
        `Sign-in per role is already written: copy the "setup" of the matching group in ${jc(root, 'design', 'app-jobs.json')} (change only the app address to yours). ` +
        `Then check them in ONE command: write a jobs file in the Screenshots folder ` +
        `({"groups": [{"setup": "<async (page) => {...} signing in as the screen's role>", "shots": [{"url": "<app url of the state>", "width": 390, "png": "<Screenshots folder>/<name>.png", "json": "<Screenshots folder>/<name>.json"}]}]}, ` +
        `one shot per screen and width, <name> = the design file's name, e.g. c-login-390, and "states": "${scr}/states.json" in the group so each state is shot too, by clicking its label), run node ${arg(cli ?? '<cli.js>')} design-capture <jobs file> (Bash, timeout 600000), ` +
        `then node ${arg(cli ?? '<cli.js>')} design-diff --all ${scr} <Screenshots folder> <Screenshots folder> --sample ${arg(jc(root, 'design', 'sample.json'))}. Fix what the <name>.diff.txt files report until only sample data differs. Each starts with the share of pixels that differ; <name>.diff.png shows where in red: look at it for what numbers cannot say (an icon, an order, a missing block). Never redefine a design class in a page or component: fix it once in the shared styles.`;
    return fs.existsSync(canvas)
      ? `${dir}/ (saved copy of the design canvas ${s.ref}; that link needs a claude.ai sign-in, so use this folder). ` +
        `project/canvas.json lists every screen (boards: file name and title); each project/<name>.dc.html is that screen's exact markup, copy and classes, styled by the .css files beside it. ` +
        `Read the screens your task covers and build them to match: same sections, labels, order, colors, type and spacing; only the data comes from the app`
      : `${dir}/ (saved copy of ${s.ref}; that link needs a claude.ai sign-in, so read the files here, and open index.html in a browser to see it)`;
  }
  if (s.kind === 'url') return s.ref;
  const rel = path.relative(root, s.ref);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : s.ref;
}
// Sources outside the project (Claude needs read access to them).
export const outsideDirs = (root: string, sources: Source[]) => [...new Set(sources.filter(s => s.kind !== 'url' || hasCopy(root, s)).map(s => {
  if (s.kind === 'url') return sourceCopy(root, s.id); // not in the task's copy of the project
  const rel = path.relative(root, s.ref);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '';
  return s.kind === 'folder' ? s.ref : path.dirname(s.ref);
}).filter(Boolean))];

// The brief: everything the builder needs to start, as references rather than pasted content, so it reads only
// what the task needs. Rewritten on each fresh session (the task may have been edited).
// Artifacts the project already used or published (from the registry), beyond the ones listed as sources: a later task
// can build on or update one instead of recreating it. Newest first, at most 20.
export function artifactsSection(root: string, sources: Source[], taskTitle: (id: string) => string | undefined = () => undefined) {
  let lines: string[] = [];
  try {
    const listed = sources.filter(s => s.kind === 'url').map(s => s.ref);
    const copyOf = (url: string) => { const s = sources.find(x => x.kind === 'url' && artifactKey(x.ref) === url && hasCopy(root, x)); return s ? sourceCopy(root, s.id) : undefined; };
    lines = R.forBrief(root, taskTitle, listed, 20, copyOf);
  } catch { /* no registry */ }
  return lines.length ? `## Project artifacts (published or used before; update one rather than recreate it)\n${lines.join('\n')}` : '';
}

export function writeBrief(root: string, t: Task, sources: Source[], taskTitle?: (id: string) => string | undefined, cli?: string) {
  const picked = t.sources ? sources.filter(s => t.sources!.includes(s.id)) : sources;
  const files = t.files ?? [];
  const text = [
    `# ${t.title}`,
    t.description?.trim() && t.description.trim() !== t.title.trim() ? t.description.trim() : '',
    picked.length || files.length || t.images?.length ? '## Sources (the basis for this task; open only what you need)' : '',
    ...picked.map(s => `- ${where(root, s, cli)}${s.note ? ` — ${s.note}` : ''}`),
    ...files.map(f => `- ${/^\.justcode[\\/]/.test(f) ? path.join(root, f) : f}`), // the task's folder has no .justcode
    ...(t.images ?? []).map(f => `- ${f} (screenshot: read it first)`),
    `## Screenshots go to\n${shotsDir(root, t.id)} (any screenshot or design copy goes here, never in the repo).${isUiTask(t) ? ` Take screenshots only with the Playwright MCP browser_take_screenshot tool (headless), filename always an absolute path in that folder.` : ''}`,
    projectSection(root),
    designSection(root, t),
    artifactsSection(root, picked, taskTitle),
    fs.existsSync(planFile(root, t.id)) ? `## Approved plan\nFollow ${planFile(root, t.id)}.` : '',
    fs.existsSync(progressFile(root)) ? `## Project history\nWhat earlier tasks changed: ${progressFile(root)} (read it if you need context on recent work).` : '',
    `## When you finish\nUpdate ${handoffFile(root, t.id)} (create it if missing), at most 30 lines:\n` +
    '- What you changed and why (files, key decisions)\n- How you verified it: the exact commands you ran and their result\n- Anything left open, or risks for the reviewer to check\n' +
    commitInstructions(root, t.id),
  ].filter(Boolean).join('\n\n');
  write(briefFile(root, t.id), text + '\n');
  return text;
}

// 📝 Commit messages: Claude writes one per task (commit.md beside the handoff), in the project's own convention when
// it has one (a commit command or skill for Claude, CONTRIBUTING, commitlint, a .gitmessage template), else
// Conventional Commits. JustCode commits with it; the task title is only the fallback.
export const commitFile = (root: string, id: string) => path.join(taskDir(root, id), 'commit.md');
export function commitRules(root: string): string[] {
  const out: string[] = [];
  const ls = (d: string) => { try { return fs.readdirSync(path.join(root, d)); } catch { return []; } };
  for (const f of ls('.claude/commands')) if (/commit/i.test(f) && f.endsWith('.md')) out.push(path.join(root, '.claude/commands', f));
  for (const d of ls('.claude/skills')) if (/commit/i.test(d) && fs.existsSync(path.join(root, '.claude/skills', d, 'SKILL.md'))) out.push(path.join(root, '.claude/skills', d, 'SKILL.md'));
  for (const f of ls('.github')) if (/commit/i.test(f) && f.endsWith('.md')) out.push(path.join(root, '.github', f));
  for (const f of ls('.')) if (/^(commitlint\.config\.(c|m)?(js|ts)|\.commitlintrc.*|\.gitmessage)$/.test(f)) out.push(path.join(root, f));
  for (const f of ['CONTRIBUTING.md', 'docs/CONTRIBUTING.md']) if (/commit message|conventional commit/i.test(read(path.join(root, f)))) out.push(path.join(root, f));
  return out;
}
export const commitInstructions = (root: string, id: string) => {
  const rules = commitRules(root);
  return `Then write the commit message for all of this task's changes to ${commitFile(root, id)}, replacing it each time (JustCode commits with it; never run git commit yourself). ` +
    (rules.length ? `Use this project's commit message format from ${rules.join(', ')}: only its message format applies (write the message to the file above, not where those files say, and do not run the git commands they list).`
      : 'Use Conventional Commits: `type(scope): description` (types feat, fix, refactor, style, perf, chore, docs, test; scope = the module touched; imperative, lowercase, under 72 characters, no period), then a blank line and `- ` bullets of what changed and why, each under 100 characters. Match the scopes in `git log --oneline -15`.') +
    ' Plain text only: no headings, no code fences, nothing about JustCode or tasks.';
};
// The message to commit with: the task's commit.md when it looks like one (a subject line of sensible length), else the title.
export function commitMessage(root: string, t: { id: string; title: string }): string {
  const m = read(commitFile(root, t.id)).replace(/^```\w*\n?|\n?```\s*$/g, '').trim();
  const subject = m.split('\n')[0]?.trim() ?? '';
  return subject && subject.length <= 100 && !/^#/.test(subject) ? m.slice(0, 4000) : t.title;
}
export const commitSubject = (root: string, t: { id: string; title: string }) => commitMessage(root, t).split('\n')[0];

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

// A PNG's size from its header (IHDR), without an image library.
export function pngSize(file: string) {
  try {
    const b = Buffer.alloc(24), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, b, 0, 24, 0); } finally { fs.closeSync(fd); }
    return b.toString('ascii', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : undefined;
  } catch { return undefined; }
}

// Checks a design's reference (screensOf) made by 🎨 Fix to match: the recipe version, and each PNG exactly its width wide and
// tall enough to be a whole screen. Returns what is wrong (empty when all is well).
export function screenShotProblems(copy: string) {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(path.join(screensOf(copy), 'screens.json'), 'utf8')); } catch { return [`${screensOf(copy)}/screens.json is missing or not JSON`]; }
  const out: string[] = [];
  if (j.capture !== SHOT_VERSION) out.push(`screens.json was not made with the current screenshot recipe (capture ${SHOT_VERSION})`);
  for (const sc of Array.isArray(j.screens) ? j.screens : []) for (const [w, f] of Object.entries(sc?.png ?? {})) {
    const z = typeof f === 'string' ? pngSize(f) : undefined;
    if (!z) out.push(`${sc.id}: ${w} image missing`);
    else if (z.w !== Number(w) || z.h < 600) out.push(`${path.basename(f as string)}: ${z.w}×${z.h}, expected ${w} wide and at least 600 high`);
  }
  return out;
}

// How many design screenshots screens.json lists (screens × widths), and how many screens the audit compared (.diff.txt).
export function screenShotCount(copy: string) {
  try { return (JSON.parse(fs.readFileSync(path.join(screensOf(copy), 'screens.json'), 'utf8')).screens ?? []).reduce((n: number, s: any) => n + Object.keys(s?.png ?? {}).length, 0); } catch { return 0; }
}
export const auditDiffCount = (root: string) => { try { return fs.readdirSync(jc(root, 'design', 'audit')).filter(f => f.endsWith('.diff.txt')).length; } catch { return 0; } };
