import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

// media/status.js is plain JS shared with the webview; out-test/test → ../../media.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require(path.join(__dirname, '..', '..', 'media', 'status.js'));

test('board lanes run To do, Needs you, Working, Review, Done', () => {
  assert.deepEqual(status.LANES.map((l: string[]) => l[0]), ['todo', 'needs', 'work', 'review', 'done']);
});

test('panel step tracker picks the step for each task state', () => {
  const at = (t: object) => status.stepOf(t);
  assert.equal(at({ status: 'todo' }), 0);
  assert.equal(at({ status: 'doing', run: 'running' }), 1);
  assert.equal(at({ status: 'review', checks: { state: 'fail' } }), 2);
  assert.equal(at({ status: 'review', review: { state: 'fail' } }), 3);
  assert.equal(at({ status: 'review', review: { state: 'pass' } }), 4);
  assert.equal(at({ status: 'done' }), 5);
});
