import * as fs from 'fs';
import * as path from 'path';

// A newer JustCode installed beside the one running (the window was not reloaded since): its version, else undefined.
export function newerInstalled(extPath: string, running: string) {
  const num = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const newer = (a: string, b: string) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const prefix = path.basename(extPath).replace(/-\d+\.\d+\.\d+.*$/, '') + '-';
  try {
    return fs.readdirSync(path.dirname(extPath)).filter(d => d.startsWith(prefix)).map(d => /^(\d+\.\d+\.\d+)/.exec(d.slice(prefix.length))?.[1])
      .filter((v): v is string => !!v && newer(v, running)).sort((a, b) => newer(a, b) ? -1 : 1)[0];
  } catch { return undefined; }
}
