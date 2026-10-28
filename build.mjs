// Bundles the extension and its CLI into out/ (one file each, the Agent SDK included), so the packaged extension
// needs no node_modules. Type checking is `tsc --noEmit` (npm run compile runs both).
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', sourcemap: true, logLevel: 'info',
  external: ['vscode'], define: { __JUSTCODE_BUNDLE__: 'true' },
  // The SDK is an ES module that uses import.meta.url (only to find its bundled binary, which JustCode never uses:
  // it runs the claude CLI you installed). Give it a CommonJS equivalent.
  banner: { js: 'const __import_meta_url = require("url").pathToFileURL(__filename).href;' },
  inject: [], supported: { 'dynamic-import': false },
};
const opts = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', define: { ...common.define, 'import.meta.url': '__import_meta_url' } },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'out/cli.js', define: { ...common.define, 'import.meta.url': '__import_meta_url' }, banner: common.banner },
];
if (watch) {
  const { context } = await import('esbuild');
  for (const o of opts) await (await context(o)).watch();
} else {
  await Promise.all(opts.map(o => build(o)));
}
