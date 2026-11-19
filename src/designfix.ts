import * as fs from 'fs';
import * as path from 'path';

// State of a project's Fix to match run (.justcode/design/fix.json): which design copy, which round, and whether it is
// over. Rounds: 1 from the audit, then one per re-measure after a round's tasks merged, at most MAX_ROUNDS.
export const MAX_ROUNDS = 3;
export interface FixState { sourceId: string; copy: string; round: number; done?: boolean }
const file = (root: string) => path.join(root, '.justcode', 'design', 'fix.json');
export function load(root: string): FixState | undefined {
  try { const v = JSON.parse(fs.readFileSync(file(root), 'utf8')); return v && typeof v.copy === 'string' ? v : undefined; } catch { return undefined; }
}
export function save(root: string, s: FixState) { fs.mkdirSync(path.dirname(file(root)), { recursive: true }); fs.writeFileSync(file(root), JSON.stringify(s, null, 2)); }
