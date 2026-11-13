import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findSecrets } from '../secrets';
import * as g from '../git';

const diff = (file: string, ...added: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map(l => '+' + l).join('\n')}\n`;

test('secrets: each pattern is found with file and line; harmless text is not', () => {
  const cases: [string, string][] = [
    ['AWS access key', 'const k = "AKIAABCDEFGHIJKLMNOP";'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['GitHub token', `token = "ghp_${'a'.repeat(36)}"`],
    ['Slack token', 'hook: xoxb-1234567890-abcdef'],
    ['API key, secret or password', 'API_KEY = "sk_live_0123456789abc"'],
    ['JWT', 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'],
  ];
  for (const [kind, line] of cases) assert.deepEqual(findSecrets(diff('src/a.ts', 'ok', line)), [{ file: 'src/a.ts', line: 2, kind }], kind);
  assert.deepEqual(findSecrets(diff('src/a.ts', 'const password = process.env.DB_PASSWORD;', 'apiKey: "short"')), []);
  assert.deepEqual(findSecrets(diff('package-lock.json', 'AKIAABCDEFGHIJKLMNOP')), []);
  assert.deepEqual(findSecrets(diff('.justcode/x.md', 'AKIAABCDEFGHIJKLMNOP')), []);
  assert.deepEqual(findSecrets(diff('test/keys.fixture.json', 'AKIAABCDEFGHIJKLMNOP')), []);
  // Line numbers follow the hunk header and skip removed lines.
  const d = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@\n context\n-old\n+AKIAABCDEFGHIJKLMNOP\n';
  assert.deepEqual(findSecrets(d), [{ file: 'x', line: 11, kind: 'AWS access key' }]);
});

test('secrets: commitAll with the scan on refuses, unstages and names file:line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-sec-'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n'); sh('add', '-A'); sh('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'conf.ts'), 'export const k = "AKIAABCDEFGHIJKLMNOP";\n');
  await assert.rejects(g.commitAll(dir, 'work', true), /Not committed: possible secrets in conf\.ts:1 \(AWS access key\)/);
  assert.equal(sh('diff', '--cached', '--name-only').trim(), '', 'nothing left staged');
  assert.equal(sh('rev-list', '--count', 'HEAD').trim(), '1');
  await assert.rejects(g.commitFiles(dir, 'work', ['conf.ts'], true), /conf\.ts:1/);
  assert.equal(await g.commitAll(dir, 'work', false), true, 'scan off: commits');
});
