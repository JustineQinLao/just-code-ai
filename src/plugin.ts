import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_SKILLS, reviewerAgent, plannerAgent, implementerAgent } from './skill';

// <root>/.justcode/plugin: a local Claude Code plugin with JustCode's skills and agents. Files are rewritten only
// when their content changed. Nothing outside this folder is touched.
export const pluginDir = (root: string) => path.join(root, '.justcode', 'plugin');

// Rewrites the plugin when it is missing or its plugin.json version differs from the extension's.
export function ensurePlugin(root: string, version: string) {
  let have = '';
  try { have = JSON.parse(fs.readFileSync(path.join(pluginDir(root), '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { /* missing */ }
  if (have !== version) writePlugin(root, version);
}

export function writePlugin(root: string, version = '1.0.0'): { written: string[]; kept: string[] } {
  const dir = pluginDir(root);
  const files: Array<[string, string]> = [
    [path.join('.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'justcode', description: 'JustCode skills and agents', version }, null, 2) + '\n'],
    ...DEFAULT_SKILLS.map((s): [string, string] => [s.path, s.text()]),
    [path.join('agents', 'reviewer.md'), reviewerAgent()],
    [path.join('agents', 'planner.md'), plannerAgent()],
    [path.join('agents', 'implementer.md'), implementerAgent()],
  ];
  const written: string[] = [], kept: string[] = [];
  for (const [rel, text] of files) {
    const file = path.join(dir, rel);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === text; } catch { /* missing */ }
    if (same) { kept.push(file); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(file);
  }
  return { written, kept };
}
