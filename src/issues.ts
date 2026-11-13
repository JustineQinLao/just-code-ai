import { createHash } from 'crypto';
import type { Issue, Review } from './store';

// A review issue's identity across rounds: the file it names (without the line) and its first words, so the same
// problem reworded slightly still matches. 8 hex characters.
export function issueKey(text: string) {
  const file = /[\w@./-]+\.[a-z]{1,6}\b/i.exec(text)?.[0]?.replace(/:\d+(-\d+)?$/, '') ?? '';
  const words = text.toLowerCase().replace(/[`'"]/g, '').replace(/[\w@./-]+\.[a-z]{1,6}(:\d+(-\d+)?)?/gi, ' ')
    .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 6).join(' ');
  return createHash('sha256').update(`${file}|${words}`).digest('hex').slice(0, 8);
}

// The new round's issues, matched against the previous round by key: a repeat counts one more round, and accepted
// issues stay accepted (and listed) even when the reviewer does not report them again.
export function trackIssues(prev: Issue[] | undefined, texts: string[]): Issue[] {
  const old = new Map((prev ?? []).map(i => [i.key, i]));
  const out: Issue[] = [];
  for (const text of texts) {
    const key = issueKey(text);
    if (out.some(i => i.key === key)) continue;
    const p = old.get(key);
    out.push({ text, key, rounds: (p?.rounds ?? 0) + 1, ...(p?.accepted ? { accepted: true } : {}) });
  }
  for (const p of prev ?? []) if (p.accepted && !out.some(i => i.key === p.key)) out.push(p);
  return out;
}

export const openIssues = (r?: Review) => (r?.issues ?? []).filter(i => !i.accepted);
export const acceptedIssues = (r?: Review) => (r?.issues ?? []).filter(i => i.accepted);
// Review rounds this task may use before it waits for you: the setting plus any "1 more round" presses.
export const roundLimit = (r: Review | undefined, max: number) => max + (r?.extraRounds ?? 0);
