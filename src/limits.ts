import { EventEmitter } from 'events';

// Claude plan usage, shared by every project: the 5-hour and weekly windows (percent used, reset time) and whether a
// limit has stopped work. Fed by the SDK's rate_limit_event (exact, from Claude's own servers) and by turns that end
// on a rate-limit error. API-key logins have no plan windows: the meter then stays empty.

export interface Window { pct: number; resetsAt?: number }          // resetsAt: epoch ms
export interface Reached { kind: string; resetsAt?: number; at: number }
export interface LimitView { five?: Window; week?: Window; reached?: Reached; held: boolean }

// Held this long when the reset time is unknown; the user can resume sooner.
const UNKNOWN_HOLD = 30 * 60 * 1000;
// A little past the stated reset, so the first request after it is not rejected again.
const GRACE = 20 * 1000;

const ms = (s: unknown) => typeof s === 'number' ? (s < 1e12 ? s * 1000 : s) : undefined;
const pct = (u: unknown) => typeof u === 'number' ? Math.round((u <= 1 ? u * 100 : u) * 10) / 10 : undefined;

export class Limits {
  private five?: Window;
  private week?: Window;
  private reached?: Reached;
  private timer?: NodeJS.Timeout;
  private ev = new EventEmitter();

  onChange(fn: () => void) { this.ev.on('change', fn); }
  // Fires when a reached limit is over (its reset passed, or the user chose to try again).
  onReset(fn: () => void) { this.ev.on('reset', fn); }

  view(now = Date.now()): LimitView {
    if (this.five?.resetsAt && this.five.resetsAt < now) this.five = undefined;
    if (this.week?.resetsAt && this.week.resetsAt < now) this.week = undefined;
    return { five: this.five, week: this.week, reached: this.reached, held: this.held(now) };
  }

  held(now = Date.now()) {
    if (!this.reached) return false;
    return now < (this.reached.resetsAt ?? this.reached.at + UNKNOWN_HOLD) + GRACE;
  }

  // SDKRateLimitInfo: { status, rateLimitType, utilization, resetsAt, unifiedWindows: { five_hour, seven_day } }
  update(info: any) {
    if (!info || typeof info !== 'object') return;
    const before = JSON.stringify([this.five, this.week]);
    const win = (w: any): Window | undefined => pct(w?.utilization) !== undefined ? { pct: pct(w.utilization)!, resetsAt: ms(w.resetsAt) } : undefined;
    const five = win(info.unifiedWindows?.five_hour) ?? (info.rateLimitType === 'five_hour' ? win(info) : undefined);
    const week = win(info.unifiedWindows?.seven_day) ?? (info.rateLimitType === 'seven_day' ? win(info) : undefined);
    if (five) this.five = five;
    if (week) this.week = week;
    if (info.status === 'rejected') {
      const kind = info.rateLimitType === 'seven_day' ? 'weekly' : info.rateLimitType === 'five_hour' ? '5-hour' : 'usage';
      this.setReached(kind, ms(info.resetsAt));
    } else if (this.reached && info.status && !this.held()) this.clear();
    else if (JSON.stringify([this.five, this.week]) !== before) this.ev.emit('change');
  }

  setReached(kind: string, resetsAt?: number) {
    const known = /week/i.test(kind) ? this.week?.resetsAt : this.five?.resetsAt;
    if (resetsAt === undefined && known && known > Date.now()) resetsAt = known;
    const same = this.reached && this.reached.kind === kind && this.reached.resetsAt === resetsAt;
    if (!same) this.reached = { kind, resetsAt, at: Date.now() };
    clearTimeout(this.timer);
    const wake = (this.reached!.resetsAt ?? this.reached!.at + UNKNOWN_HOLD) + GRACE;
    this.timer = setTimeout(() => this.clear(), Math.max(1000, wake - Date.now()));
    this.timer.unref?.();
    if (!same) this.ev.emit('change');
  }

  clear() {
    clearTimeout(this.timer);
    if (!this.reached) return;
    this.reached = undefined;
    this.ev.emit('change');
    this.ev.emit('reset');
  }

  dispose() { clearTimeout(this.timer); this.ev.removeAllListeners(); }
}

// Error text of a run that means "out of quota", as opposed to a transient API error.
export const isLimitError = (text: string) => /usage limit reached|limit reached|rate_limit|you(?:'|’)ve (?:hit|used)[^.\n]*limit/i.test(text);
