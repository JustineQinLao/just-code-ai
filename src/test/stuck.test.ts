import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { issueKey, trackIssues, openIssues, roundLimit } from '../issues';
import { reviewPrompt } from '../claude';
import { Store } from '../store';
import { Runner } from '../runner';
import { Limits } from '../limits';

// media/status.js is plain JS shared with the webview; out-test/test → ../../media.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require(path.join(__dirname, '..', '..', 'media', 'status.js'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-stuck-'));

test('issues: the same problem reworded keeps its key; rounds count; accepted ones stay', () => {
  assert.equal(issueKey('src/a.ts:12 Missing null check on user'), issueKey('src/a.ts:40 missing null check on user!'));
  assert.notEqual(issueKey('src/a.ts missing null check'), issueKey('src/b.ts missing null check'));
  const r1 = trackIssues(undefined, ['src/a.ts:1 missing test for retry', 'docs typo']);
  assert.deepEqual(r1.map(i => i.rounds), [1, 1]);
  r1[1].accepted = true;
  const r2 = trackIssues(r1, ['src/a.ts:9 missing test for retry']);
  assert.equal(r2.length, 2);
  assert.equal(r2[0].rounds, 2);
  assert.equal(r2[1].accepted, true);
  assert.equal(openIssues({ state: 'fail', attempts: 2, issues: r2 }).length, 1);
  assert.equal(roundLimit({ state: 'fail', attempts: 3, extraRounds: 1 }, 3), 4);
});

test('store: plain-string issues from older boards become tracked issues once', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.justcode'));
  fs.writeFileSync(path.join(root, '.justcode', 'board.json'), JSON.stringify({ sprints: [], tasks: [{ id: 'a', title: 'x', status: 'review', mode: 'auto', review: { state: 'fail', attempts: 3, issues: ['src/a.ts bad'] } }] }));
  const i = new Store(root).task('a')!.review!.issues![0];
  assert.equal(i.text, 'src/a.ts bad'); assert.equal(i.rounds, 1); assert.equal(i.key.length, 8);
});

test('review prompt: accepted issues and the builder\'s note are passed to the reviewer', () => {
  const p = reviewPrompt({ id: 'x', title: 't' } as any, 'main', 'd', { shots: '/s', accepted: ['docs typo'], fixNote: 'I left X because Y' });
  assert.match(p, /# Accepted by the user[\s\S]*- docs typo/);
  assert.match(p, /# The builder's reply to the previous review round\nI left X because Y/);
});

// Every state where an automatic loop gave up: the card explains it and offers a way out besides repeating the loop.
const settings = { review: { maxAttempts: 3, auto: true }, maxCheckRounds: 2 };
const ctx = (posts: any[] = []) => ({ settings, queue: { queued: [] }, post: (type: string, m: any) => posts.push({ type, ...m }), open: () => {}, lastTool: () => '' });
const issue = (text: string, rounds = 1) => ({ text, key: issueKey(text), rounds });
const STUCK: Record<string, any> = {
  reviewFail: { id: 'a', title: 'A', status: 'review', worktree: '/w', review: { state: 'fail', attempts: 3, issues: [issue('src/a.ts bug', 3), issue('src/b.ts missing test')] } },
  checksFail: { id: 'b', title: 'B', status: 'review', worktree: '/w', checks: { state: 'fail', rounds: 3, results: [{ name: 'tests', cmd: 'npm test', ok: false, tail: 'FAIL x' }] } },
  reviewError: { id: 'c', title: 'C', status: 'review', worktree: '/w', review: { state: 'error', attempts: 0, error: 'timed out' } },
  stopped: { id: 'd', title: 'D', status: 'doing', worktree: '/w', error: 'crashed' },
  conflicts: { id: 'e', title: 'E', status: 'review', worktree: '/w', base: 'main', conflicts: ['a.ts'] },
  noChanges: { id: 'f', title: 'F', status: 'review', worktree: '/w', reply: 'Nothing to do' },
  directNoFiles: { id: 'g', title: 'G', status: 'review', where: 'direct', run: 'idle', directFiles: [], reply: 'Made a mockup in .justcode' },
};

test('status: every stuck card explains itself and offers more than a retry', () => {
  for (const [name, t] of Object.entries(STUCK)) {
    const n = status.nextStep(t, ctx());
    assert.ok(['err', 'warn'].includes(n.tone), `${name}: tone ${n.tone}`);
    assert.ok(n.actions.length >= 2, `${name}: needs at least two actions, got ${n.actions.map((a: any) => a[0])}`);
    assert.ok(n.actions.some((a: any) => /discard|merge|finish|accept/i.test(a[0])), `${name}: no way out besides retrying`);
    assert.equal(status.lane(t, settings), 'needs', `${name}: lane`);
  }
});

test('status: review stuck card names repeats and the actions post the right messages', () => {
  const posts: any[] = [];
  const n = status.nextStep(STUCK.reviewFail, ctx(posts));
  assert.match(n.text, /2 issue\(s\) left after 3 fix round/);
  assert.match(n.text, /1 came back every round/);
  assert.deepEqual(n.actions.map((a: any) => a[0]), ['See issues', 'Try 1 more round', 'Accept issues and merge', 'Discard']);
  n.actions[1][1](); n.actions[2][1]();
  assert.deepEqual(posts, [{ type: 'moreRound', id: 'a' }, { type: 'acceptIssues', id: 'a', merge: true }]);
  // One more round raises the limit: the card is back to "fixing" instead of stuck.
  const more = { ...STUCK.reviewFail, review: { ...STUCK.reviewFail.review, extraRounds: 1 } };
  assert.equal(status.lane(more, settings), 'review');
  // Direct tasks say Finish, and a done task with accepted issues says so.
  assert.equal(status.nextStep({ ...STUCK.reviewFail, where: 'direct' }, ctx()).actions[2][0], 'Accept issues and finish');
  const done = { ...STUCK.reviewFail, status: 'done', review: { ...STUCK.reviewFail.review, state: 'pass', issues: [{ ...issue('x'), accepted: true }] } };
  assert.match(status.nextStep(done, ctx()).text, /Merged with 1 accepted review issue/);
});

test('runner: accepting issues passes the review; a stuck task does not hold Run all', async () => {
  const root = tmp();
  const store = new Store(root);
  const set: any = { maxParallel: 1, maxCheckRounds: 2, review: { maxAttempts: 3, autoMerge: false, mergeIfCannotRun: false } };
  const r: any = new Runner(store, { bin: () => 'claude', env: () => ({}), settings: () => set, limits: new Limits(), notify: () => {}, choose: async () => 'x', cli: '' });
  const t = store.addTask({ title: 'A', mode: 'auto' });
  store.updateTask(t.id, { status: 'review', worktree: root, branch: 'b', base: 'main', review: { state: 'fail', attempts: 3, issues: trackIssues(undefined, ['src/a.ts one', 'src/b.ts two']) } });
  assert.equal(r.stuck(store.task(t.id)), true);
  assert.equal(r.inFlight().length, 0, 'a stuck task frees its slot');
  const [first, second] = store.task(t.id)!.review!.issues!;
  await r.acceptIssues(t.id, [first.key]);
  assert.equal(store.task(t.id)!.review!.state, 'fail');
  await r.acceptIssues(t.id, [second.key]);
  assert.equal(store.task(t.id)!.review!.state, 'pass');
  // "1 more round" raises this task's limit and sends only the open issues.
  const u = store.addTask({ title: 'B', mode: 'auto' });
  const issues = trackIssues(undefined, ['src/c.ts three', 'src/d.ts four']); issues[1].accepted = true;
  store.updateTask(u.id, { status: 'review', worktree: root, branch: 'b2', base: 'main', review: { state: 'fail', attempts: 3, issues } });
  const said: string[] = []; r.say = async (_: string, text: string) => { said.push(text); };
  await r.moreRound(u.id);
  assert.equal(store.task(u.id)!.review!.extraRounds, 1);
  assert.equal(store.task(u.id)!.status, 'doing');
  assert.match(said[0], /review 3 of 4[\s\S]*1\. src\/c\.ts three[\s\S]*accepted these[\s\S]*src\/d\.ts four/);
  r.dispose();
});

import { resolveOutput } from '../store';
test('output: automatic picks an artifact page for a mockup, the form can force either', () => {
  assert.equal(resolveOutput('', 'create mockup redesign for this with good ui'), 'artifact');
  assert.equal(resolveOutput(undefined, 'Wireframe the onboarding'), 'artifact');
  assert.equal(resolveOutput('', 'Fix the retry bug'), undefined);
  assert.equal(resolveOutput('code', 'mockup data for tests'), undefined);
  assert.equal(resolveOutput('artifact', 'Q3 numbers'), 'artifact');
});

test('quick: done without checks or review; Finish commits, Close when nothing changed', () => {
  const settings = { review: { maxAttempts: 3, auto: true }, maxCheckRounds: 2 };
  const posts: any[] = [];
  const c = { settings, queue: { queued: [] }, post: (type: string, m: any) => posts.push({ type, ...m }), open: () => {}, lastTool: () => '' };
  const files = { id: 'q', title: 'Q', status: 'review', where: 'direct', quick: true, run: 'idle', directFiles: ['a.ts'], reply: 'Renamed it.' };
  const n = status.nextStep(files, c);
  assert.match(n.text, /⚡ Done: changed 1 file/);
  assert.equal(n.actions[0][0], '✓ Finish (commit)');
  assert.equal(status.lane(files, settings), 'review');
  const answer = status.nextStep({ ...files, directFiles: [], reply: 'The retry limit is 3.' }, c);
  assert.match(answer.text, /⚡ The retry limit is 3\./);
  assert.deepEqual(answer.actions.map((a: any) => a[0]), ['Reply', '✓ Close']);
});

test('elapsed: time since a timestamp, never since 1970', () => {
  const now = 1_800_000_000_000;
  assert.equal(status.elapsed(now - 45_000, now), '45s');
  assert.equal(status.elapsed(now - (10 * 60 + 59) * 1000, now), '10m 59s');
  assert.equal(status.elapsed(now - 2 * 3600_000 - 5 * 60_000, now), '2h 5m');
  assert.equal(status.elapsed(undefined, now), '');
  assert.match(status.nextStep({ id: 'r', title: 'R', status: 'review', reviewing: Date.now() - 90_000 }, ctx()).text, /testing it · 1m 30s/);
});
