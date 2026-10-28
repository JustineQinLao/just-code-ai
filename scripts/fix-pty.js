// node-pty's macOS prebuild ships spawn-helper without the exec bit on some installs ("posix_spawnp failed").
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'spawn-helper');
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
} catch { /* no prebuilds: built from source */ }
