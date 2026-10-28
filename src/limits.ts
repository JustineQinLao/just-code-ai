import { EventEmitter } from 'events';

// Claude usage limits, shared by every project: the 5-hour and weekly windows (percent used, reset time) and whether a
// limit has stopped work ("reached"). Sources, most reliable first:
//   1. the statusLine JSON Claude Code feeds our injected command (rate_limits.five_hour / seven_day: used_percentage, resets_at in epoch s)
//   2. the StopFailure hook (a turn ended on rate_limit)
//   3. error text of headless runs (reviewer, planner)
//   4. the "You've used N% of your X limit · resets T" banner in a terminal (fallback; wording has changed between versions)

export interface Window { pct: number; resetsAt?: number }          // resetsAt: epoch ms
export interface Reached { kind: string; resetsAt?: number; at: number }
export interface LimitView { five?: Window; week?: Window; reached?: Reached; held: boolean }

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

// Held when the reset time is unknown for at most this long; the user can resume sooner.
const UNKNOWN_HOLD = 30 * 60 * 1000;
// Wait a little past the stated reset so the first request after it is not rejected again.
const GRACE = 20 * 1000;

const validZone = (z: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

// "2:40pm" / "2pm" / "14:40" in zone `tz` (default: local) → the next time the wall clock shows that, as epoch ms.
export function nextReset(clock: string, tz: string | undefined, now = Date.now()): number | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(clock.trim());
  if (!m) return;
  let h = +m[1];
  const min = +(m[2] ?? 0), ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return;
  const zone = tz && validZone(tz) ? tz : undefined;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = f.formatToParts(new Date(now));
  const g = (k: string) => +parts.find(p => p.type === k)!.value;
  const wallNow = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  const offset = wallNow - Math.floor(now / 1000) * 1000; // zone wall clock minus UTC
  let t = Date.UTC(g('year'), g('month') - 1, g('day'), h, min, 0) - offset;
  if (t <= now) t += 24 * 3600 * 1000;
  return t;
}

export interface TextHit { pct?: number; kind: string; reached: boolean; resetsAt?: number }

// Terminal text (ANSI already stripped). Deliberately narrow: Claude may print the words "limit reached" in code or prose.
export function parseText(plain: string, now = Date.now()): TextHit | undefined {
  const warn = /You(?:'|’)ve used (\d{1,3})% of your ([\w -]+?) limit\s*[·•|∙-]\s*resets\s+([0-9:apm\s]+?)(?:\s*\(([^)]+)\))?(?=\s*[·•|∙\n]|$)/i.exec(plain);
  if (warn) return { pct: +warn[1], kind: warn[2].trim(), reached: +warn[1] >= 100, resetsAt: nextReset(warn[3], warn[4], now) };
  const hit = /\b([\w-]+(?: [\w-]+)?) limit reached\s*[·•|∙-]\s*resets\s+([0-9:apm\s]+?)(?:\s*\(([^)]+)\))?(?=\s*[·•|∙\n]|$)/i.exec(plain);
  if (hit) return { kind: hit[1].trim(), reached: true, resetsAt: nextReset(hit[2], hit[3], now) };
  const epoch = /usage limit reached\|(\d{10,13})/i.exec(plain);
  if (epoch) return { kind: 'usage', reached: true, resetsAt: +epoch[1] < 1e12 ? +epoch[1] * 1000 : +epoch[1] };
}

// Error text of a headless run that means "out of quota", as opposed to a transient API error.
export const isLimitError = (text: string) => /usage limit reached|limit reached|rate_limit|you(?:'|’)ve (?:hit|used)[^.\n]*limit|credit balance/i.test(text);

export class Limits {
  private five?: Window;
  private week?: Window;
  private reached?: Reached;
  private timer?: NodeJS.Timeout;
  private tails = new Map<string, string>();
  private ev = new EventEmitter();

  onChange(fn: () => void) { this.ev.on('change', fn); }
  // Fires when a reached limit is over (its reset passed, or the user resumed).
  onReset(fn: () => void) { this.ev.on('reset', fn); }

  private expire(now = Date.now()) {
    if (this.five?.resetsAt && this.five.resetsAt < now) this.five = undefined;
    if (this.week?.resetsAt && this.week.resetsAt < now) this.week = undefined;
  }

  view(now = Date.now()): LimitView {
    this.expire(now);
    return { five: this.five, week: this.week, reached: this.reached, held: this.held(now) };
  }

  held(now = Date.now()) {
    if (!this.reached) return false;
    return now < (this.reached.resetsAt ?? this.reached.at + UNKNOWN_HOLD) + GRACE;
  }

  // statusLine JSON: { rate_limits: { five_hour: { used_percentage, resets_at }, seven_day: {...} } }
  setWindows(rate: any) {
    const win = (w: any): Window | undefined => typeof w?.used_percentage === 'number'
      ? { pct: w.used_percentage, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined } : undefined;
    const five = win(rate?.five_hour), week = win(rate?.seven_day);
    const changed = JSON.stringify([five, week]) !== JSON.stringify([this.five, this.week]);
    this.five = five; this.week = week;
    const full = [['5-hour', five], ['weekly', week]].find(([, w]) => (w as Window | undefined)?.pct !== undefined && (w as Window).pct >= 100) as [string, Window] | undefined;
    if (full) this.setReached(full[0], full[1].resetsAt);
    else if (this.reached && !this.held()) this.clear();
    else if (changed) this.ev.emit('change');
  }

  setReached(kind: string, resetsAt?: number) {
    // Reset time unknown: use the last one the statusLine reported for that window, if it is still ahead.
    const known = /week|7-day/i.test(kind) ? this.week?.resetsAt : this.five?.resetsAt;
    if (resetsAt === undefined && known && known > Date.now()) resetsAt = known;
    const same = this.reached && this.reached.kind === kind && this.reached.resetsAt === resetsAt;
    if (!same) this.reached = { kind, resetsAt, at: Date.now() };
    clearTimeout(this.timer);
    const wake = (this.reached!.resetsAt ?? this.reached!.at + UNKNOWN_HOLD) + GRACE;
    this.timer = setTimeout(() => this.clear(), Math.max(1000, wake - Date.now()));
    this.timer.unref?.();
    if (!same) this.ev.emit('change');
  }

  // Limit over (time passed) or user chose to try again.
  clear() {
    clearTimeout(this.timer);
    if (!this.reached) return;
    this.reached = undefined;
    this.ev.emit('change');
    this.ev.emit('reset');
  }

  // Terminal output of session `id`: keeps a short tail so a banner split across chunks is still seen.
  feed(id: string, chunk: string) {
    // Only the end of each chunk matters (a banner is short); keep a stripped tail so one split across chunks is seen whole.
    const tail = ((this.tails.get(id) ?? '') + stripAnsi(chunk.slice(-700))).slice(-500);
    this.tails.set(id, tail);
    if (!/limit/i.test(tail)) return;
    const hit = parseText(tail);
    if (!hit) return;
    this.tails.set(id, ''); // consumed
    const w: Window = { pct: hit.pct ?? 100, resetsAt: hit.resetsAt };
    if (/week|7-day/i.test(hit.kind)) this.week = w; else if (/5-hour|hour|session/i.test(hit.kind)) this.five = w;
    if (hit.reached) this.setReached(hit.kind, hit.resetsAt); else this.ev.emit('change');
  }

  dispose() { clearTimeout(this.timer); this.ev.removeAllListeners(); }
}
