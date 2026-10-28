import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ptyEnv } from './claude';

// Owns every Claude process JustCode starts. Processes live in the extension host, not the webview, so
// hiding or reloading the board never cuts a run off. Each output also feeds a hidden terminal, whose current
// screen (plus recent scrollback) is what a reopened terminal gets: replaying the raw stream instead would play
// back every frame Claude ever drew, which shows as heavy flicker. dispose() kills them all.

const SCROLLBACK = 1000;

// A VSIX install can drop the exec bit on node-pty's macOS helper, which fails every spawn with "posix_spawnp failed".
try {
  const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
} catch { /* built from source */ }

interface Live { p: pty.IPty; mirror: Terminal; snap: SerializeAddon }

export class Ptys {
  private live = new Map<string, Live>();
  private ended = new Map<string, string>(); // last output of an exited run, still shown in its card
  private ev = new EventEmitter();
  // Size of the board's terminal, so runs started in the background begin at the size they'll be shown at
  // (a later resize makes Claude redraw everything, which stacks old frames in the scrollback).
  size = { cols: 120, rows: 30 };
  // Where each session's last screen is kept, so a reload or restart doesn't leave its terminal blank.
  dir?: string;
  private file(id: string) { return this.dir ? path.join(this.dir, `${id}.screen`) : undefined; }
  private persist(id: string, screen: string) {
    const f = this.file(id);
    if (!f || !screen) return;
    try { fs.mkdirSync(this.dir!, { recursive: true }); fs.writeFileSync(f, screen); } catch { /* disk full or read-only: in-memory copy still works */ }
  }

  // Both return an unsubscribe, so a removed project's runner stops listening.
  onData(fn: (id: string, data: string) => void) { this.ev.on('data', fn); return () => { this.ev.off('data', fn); }; }
  onExit(fn: (id: string, code: number) => void) { this.ev.on('exit', fn); return () => { this.ev.off('exit', fn); }; }

  has(id: string) { return this.live.has(id); }
  ids() { return [...this.live.keys()]; }

  start(id: string, cwd: string, file: string, args: string[], cols = this.size.cols, rows = this.size.rows) {
    this.kill(id);
    this.ended.delete(id);
    const f = this.file(id);
    if (f) fs.rmSync(f, { force: true });
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: ptyEnv() });
    // Mirror: never answers terminal queries (the board's own terminal does), it only keeps the screen.
    const mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const snap = new SerializeAddon();
    mirror.loadAddon(snap as any);
    const l: Live = { p, mirror, snap };
    this.live.set(id, l);
    p.onData(d => {
      mirror.write(d);
      this.ev.emit('data', id, d);
    });
    p.onExit(({ exitCode }) => {
      const cur = this.live.get(id);
      if (cur === l) { this.live.delete(id); this.end(id, l); }
      if (!cur || cur === l) this.ev.emit('exit', id, exitCode); // not for a run already replaced by a new one
    });
  }

  // What a terminal opened now should show. Async: the mirror applies writes in batches.
  snapshot(id: string): Promise<string> {
    const l = this.live.get(id);
    if (!l) {
      const f = this.file(id);
      let saved = '';
      try { saved = this.ended.get(id) ?? (f ? fs.readFileSync(f, 'utf8') : ''); } catch { /* none saved */ }
      return Promise.resolve(saved);
    }
    return new Promise(res => l.mirror.write('', () => res(l.snap.serialize({ scrollback: SCROLLBACK }))));
  }

  private end(id: string, l: Live) {
    try {
      const screen = l.snap.serialize({ scrollback: SCROLLBACK });
      this.ended.set(id, screen);
      this.persist(id, screen);
    } catch { /* mirror gone */ }
    l.mirror.dispose();
  }
  forget(id: string) {
    this.ended.delete(id);
    const f = this.file(id);
    if (f) fs.rmSync(f, { force: true });
  }

  // Saves a live session's current screen (called when its turn ends), in case the window closes without a clean exit.
  save(id: string) {
    const l = this.live.get(id);
    if (l) try { this.persist(id, l.snap.serialize({ scrollback: SCROLLBACK })); } catch { /* mirror busy */ }
  }
  write(id: string, data: string) { this.live.get(id)?.p.write(data); }

  resize(id: string, cols: number, rows: number) {
    const p = this.live.get(id)?.p;
    if (!p || cols <= 0 || rows <= 0 || (p.cols === cols && p.rows === rows)) return; // no-op resizes still make Claude redraw
    try { p.resize(cols, rows); this.live.get(id)!.mirror.resize(cols, rows); } catch { /* exited meanwhile */ }
  }

  kill(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    this.end(id, l);
    try { l.p.kill(); } catch { /* already gone */ }
  }

  dispose() { for (const id of this.ids()) this.kill(id); this.ended.clear(); this.ev.removeAllListeners(); }
}
