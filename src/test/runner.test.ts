import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { useSdk } from '../sdk';
import { Store, Task } from '../store';
import { Runner } from '../runner';
import { Limits } from '../limits';
import * as A from '../artifacts';

// A fake Agent SDK: a task session edits a file in its folder and finishes the turn; a review (structured output)
// passes. No Claude process runs, so this checks JustCode's own state machine end to end.
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, session_id: 's', ...extra });
let reviews = 0;
useSdk({
  query: (({ prompt, options }: any) => {
    const review = !!options.outputFormat;
    async function* run() {
      if (review) { reviews++; yield result({ session_id: 'review', structured_output: { pass: true, issues: [], risk: 'minor', tested: ['npm test'] } }); return; }
      for await (const msg of prompt as AsyncIterable<any>) {
        const text = typeof msg.message?.content === 'string' ? msg.message.content : JSON.stringify(msg.message?.content);
        const name = /File: (\S+)/.exec(text)?.[1] ?? 'out.txt';
        fs.writeFileSync(path.join(options.cwd, name), `made by the fake\n`);
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `Wrote ${name}` }], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield result();
      }
    }
    const it: any = run();
    it.setPermissionMode = async () => {}; it.interrupt = async () => {}; it.close = () => {};
    return it;
  }) as any,
});

const settings: any = {
  maxParallel: 1, taskModel: '', allowedTools: [], worktreeCopy: [], idleMinutes: 10, personalSetup: false, superpowers: false, freshAfterTokens: 0,
  subagents: false, taskEffort: '', plannerModel: '', plannerEffort: '', checks: '', setup: '', maxCheckRounds: 2, checkTimeoutMinutes: 1,
  review: { auto: true, model: '', effort: '', lightModel: '', triage: false, maxAttempts: 3, autoMerge: true, mergeIfCannotRun: false, commands: [], timeoutMinutes: 1 },
};

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-run-'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n'); sh('add', '-A'); sh('commit', '-qm', 'init');
  return { root, sh };
}

const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); }
};

function runner(root: string, seen: string[]) {
  const store = new Store(root);
  const r = new Runner(store, { bin: () => process.execPath, env: () => ({ PATH: process.env.PATH! }), settings: () => settings, limits: new Limits(),
    notify: (_l: string, m: string) => seen.push(m), choose: async () => 'Run without them', cli: '' });
  return { store, r };
}

test('runner with a fake SDK: a branch task goes todo → doing → review → done, merged into main', async () => {
  const { root, sh } = repo();
  const seen: string[] = [];
  const { store, r } = runner(root, seen);
  const t = store.addTask({ title: 'Add b', description: 'File: b.txt', mode: 'auto', where: 'branch' });
  const states: string[] = [];
  store.onChange(() => { const s = store.task(t.id)?.status; if (s && states[states.length - 1] !== s) states.push(s); });
  await r.run(t.id);
  await until('merge', () => store.task(t.id)?.status === 'done');
  assert.deepEqual(states, ['doing', 'review', 'done']);
  const done = store.task(t.id) as Task;
  assert.equal(done.review?.state, 'pass');
  assert.ok((done.costUsd ?? 0) >= 0.02, 'build and review cost both counted');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'made by the fake\n');
  assert.match(sh('log', '-n', '1', '--format=%B'), /^Add b\n\nMerge branch jc\/\S+ into main/);
  assert.equal(done.worktree, undefined);
  assert.ok(fs.existsSync(path.join(root, '.justcode', 'tasks', t.id, 'brief.md')));
  r.dispose();
});

test('runner with a fake SDK: a direct task edits the checkout, is reviewed, and Finish commits only its files', async () => {
  const { root, sh } = repo();
  fs.writeFileSync(path.join(root, 'mine.txt'), 'my own edit\n'); // the user's uncommitted work stays out of the commit
  const seen: string[] = [];
  const { store, r } = runner(root, seen);
  const before = reviews;
  const t = store.addTask({ title: 'Add c', description: 'File: c.txt', mode: 'auto', where: 'direct' });
  await r.run(t.id);
  await until('finish', () => store.task(t.id)?.status === 'done');
  assert.ok(reviews > before, 'reviewed');
  assert.deepEqual(store.task(t.id)!.directFiles, ['c.txt']);
  assert.match(sh('log', '--format=%s', '-n', '1'), /^Add c/);
  assert.equal(sh('show', '--name-only', '--format=', 'HEAD').trim(), 'c.txt');
  assert.match(sh('status', '--porcelain'), /\?\? mine\.txt/);
  r.dispose();
});

test('runner with a fake SDK: a quick task runs in the checkout with no review, and Finish commits its files', async () => {
  const { root, sh } = repo();
  const { store, r } = runner(root, []);
  const before = reviews;
  const t = store.addTask({ title: 'Quick d', description: 'File: d.txt', mode: 'auto', where: 'direct', quick: true });
  await r.run(t.id);
  await until('turn end', () => store.task(t.id)?.status === 'review');
  await new Promise(res => setTimeout(res, 300));
  assert.equal(reviews, before, 'no AI review');
  assert.equal(store.task(t.id)!.review, undefined);
  assert.deepEqual(store.task(t.id)!.directFiles, ['d.txt']);
  await r.merge(t.id);
  assert.equal(store.task(t.id)!.status, 'done');
  assert.match(sh('log', '--format=%s', '-n', '1'), /^Quick d/);
  r.dispose();
});


test('fix to match: the setup task captures, adds no fix tasks, and the style check is ready; a fix task is one quick task', async () => {
  const { root } = repo();
  const { store, r } = runner(root, []);
  const copy = path.join(root, '.justcode', 'sources', 'd1');
  fs.mkdirSync(copy, { recursive: true }); fs.writeFileSync(path.join(copy, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, '.justcode', 'sources.json'), JSON.stringify([{ id: 'd1', kind: 'url', ref: 'https://claude.ai/artifact/Abc', note: 'Gallery' }]));
  const setup = store.addTask({ title: 'Set up Fix to match', mode: 'auto', where: 'direct', init: 'fixdesign', sources: ['d1'] });
  const first = r.fixDesignPrompt(setup);
  assert.ok(first.includes(`file://${copy}/index.html`) && /States: never skip/.test(first) && /app-jobs\.json/.test(first), 'the setup captures the design and writes the app jobs');
  assert.doesNotMatch(first, /```tasks|design-diff --all|audit\.md/, 'it never compares or plans tasks');
  const refDir = path.join(root, '.justcode', 'design', 'ref', 'd1'), shot = path.join(refDir, 'c-login-390.png');
  const png = (w: number, h: number) => { const b = Buffer.alloc(24); b.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  fs.mkdirSync(refDir, { recursive: true });
  const screens = (w: number, h: number) => { fs.writeFileSync(shot, png(w, h)); fs.writeFileSync(path.join(refDir, 'screens.json'), JSON.stringify({ capture: 4, screens: [{ id: 'c-login', png: { 390: shot } }] })); };
  screens(500, 575);
  assert.equal(r.designSetupDone(setup.id), false);
  assert.equal(store.task(setup.id)!.status, 'review'); assert.match(store.task(setup.id)!.error ?? '', /stopped before finishing/);
  screens(390, 1800);
  assert.equal(r.designSetupDone(setup.id), false, 'no app jobs yet');
  assert.ok(!r.designReady(copy));
  fs.writeFileSync(path.join(root, '.justcode', 'design', 'app-jobs.json'), '{"groups":[]}');
  assert.ok(r.designReady(copy), 'from now on Fix to match needs no Claude');
  const before = store.data.tasks.length;
  r.designSetupDone(setup.id);
  assert.equal(store.data.tasks.length, before, 'no fix task is added by itself');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.justcode', 'design', 'fix.json'), 'utf8')).copy, copy);
  await until('check ended', () => !r.designStatus);
  fs.writeFileSync(path.join(root, '.justcode', 'design', 'style-check.json'), JSON.stringify({ at: 1, screens: 1, drifts: [{ cls: '.btn', width: 390, prop: 'bg', design: 'teal', app: 'white', n: 2, screens: ['c-login'] }], unused: [], tokens: [] }));
  r.cancelQueue();
  const id = r.designFixTask()!;
  const t = store.task(id)!;
  assert.ok(t.quick && t.where === 'direct' && t.title === 'Match the design\'s styles');
  assert.match(t.description ?? '', /\.btn at 390: bg is white, the design has teal/);
  const ids = r.designScreenTasks(['c-login']);
  assert.equal(ids.length, 1); assert.match(store.task(ids[0])!.description ?? '', /ONE screenshot/);
  r.cancelQueue();
  r.dispose();
});
