import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { ptyEnv } from './claude';

// Owns every Claude process JustCode starts. Processes live in the extension host, not the webview, so
// hiding or reloading the board never cuts a run off; output is kept (last 2 MB) and replayed on reattach.
// dispose() kills them all, so nothing outlives the window.

const MAX_BUF = 2 * 1024 * 1024;

// A VSIX install can drop the exec bit on node-pty's macOS helper, which fails every spawn with "posix_spawnp failed".
try {
  const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
} catch { /* built from source */ }

interface Live { p: pty.IPty; chunks: string[]; size: number }

export class Ptys {
  private live = new Map<string, Live>();
  private ended = new Map<string, string>(); // last output of an exited run, still shown in its card
  private ev = new EventEmitter();

  onData(fn: (id: string, data: string) => void) { this.ev.on('data', fn); }
  onExit(fn: (id: string, code: number) => void) { this.ev.on('exit', fn); }

  has(id: string) { return this.live.has(id); }
  ids() { return [...this.live.keys()]; }

  start(id: string, cwd: string, file: string, args: string[], cols = 120, rows = 30) {
    this.kill(id);
    this.ended.delete(id);
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: ptyEnv() });
    const l: Live = { p, chunks: [], size: 0 };
    this.live.set(id, l);
    p.onData(d => {
      l.chunks.push(d);
      l.size += d.length;
      while (l.size > MAX_BUF && l.chunks.length > 1) l.size -= l.chunks.shift()!.length;
      this.ev.emit('data', id, d);
    });
    p.onExit(({ exitCode }) => {
      const cur = this.live.get(id);
      if (cur === l) { this.live.delete(id); this.ended.set(id, l.chunks.join('')); }
      if (!cur || cur === l) this.ev.emit('exit', id, exitCode); // not for a run already replaced by a new one
    });
  }

  buffer(id: string) { return this.live.get(id)?.chunks.join('') ?? this.ended.get(id) ?? ''; }
  forget(id: string) { this.ended.delete(id); }
  write(id: string, data: string) { this.live.get(id)?.p.write(data); }

  resize(id: string, cols: number, rows: number) {
    if (cols > 0 && rows > 0) try { this.live.get(id)?.p.resize(cols, rows); } catch { /* exited meanwhile */ }
  }

  kill(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    this.ended.set(id, l.chunks.join(''));
    try { l.p.kill(); } catch { /* already gone */ }
  }

  dispose() { for (const id of this.ids()) this.kill(id); this.ended.clear(); this.ev.removeAllListeners(); }
}
