// Keys and tokens in what JustCode is about to commit. Scans only the added lines of a unified diff
// (git diff --cached), so a secret already in history does not block every later commit.
export interface SecretHit { file: string; line: number; kind: string }

const PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['API key, secret or password', /(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
];

// Files never scanned: JustCode's own folder, lockfiles (hashes look like keys), and test fixtures named *.fixture.*.
const SKIP = /(^|\/)\.justcode\/|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.fixture\.[^/]+$/;

export function findSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '', line = 0, skip = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '').trim();
      skip = file === '/dev/null' || SKIP.test(file);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith('+')) {
      if (!skip) for (const [kind, re] of PATTERNS) if (re.test(l)) { hits.push({ file, line, kind }); break; }
      line++;
    } else if (!l.startsWith('-') && !l.startsWith('\\')) line++;
  }
  return hits;
}

export const describeSecrets = (hits: SecretHit[]) => hits.slice(0, 5).map(h => `${h.file}:${h.line} (${h.kind})`).join(', ') + (hits.length > 5 ? ` and ${hits.length - 5} more` : '');

export class SecretsFound extends Error {
  constructor(readonly hits: SecretHit[]) { super(`Not committed: possible secrets in ${describeSecrets(hits)}`); }
}
