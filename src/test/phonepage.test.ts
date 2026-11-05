import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { PAGE } from '../phonepage';

test('phone page script parses, avoids innerHTML, and guards the activity poll with a generation counter', () => {
  const js = [...PAGE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  assert.ok(js.length > 0);
  assert.doesNotThrow(() => new vm.Script(js));
  assert.ok(!/innerHTML/.test(PAGE));
  assert.match(js, /gen!==actGen/);
});
