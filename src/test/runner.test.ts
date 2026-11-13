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

// A fake Agent SDK: a task session edits a file in its folder and finishes the turn; a review (structured output)
// passes. No Claude process runs, so this checks JustCode's own state machine end to end.
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, session_id: 's', ...extra });
let reviews = 0;
useSdk({
  query: (({ prompt, options }: any) => {
    const review = !!options.outputFormat;
    async function* run() {
      if (review) { reviews++; yield result({ structured_output: { pass: true, issues: [], risk: 'minor', tested: ['npm test'] } }); return; }
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
  assert.match(sh('log', '--oneline', '-n', '1'), /Merge jc\/.*: Add b/);
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
