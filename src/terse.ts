import * as fs from 'fs';
import * as path from 'path';
import { installedPlugin } from './claude';

// 🪨 Terse replies: the caveman plugin's rules (github.com/JuliusBrussee/caveman) in task and chat sessions, so
// Claude's prose (status lines, summaries, answers) costs fewer output tokens while code, commands, paths and errors
// stay exact. Its rules are read from the installed plugin and appended to the system prompt; the plugin itself is
// not loaded in tasks, because its hooks keep per-session state in ~/.claude and can ask Claude to set up a status
// line, which is not the task's work. Files Claude writes (code, brief, handoff, commits) stay in normal prose.

export function rules(): string | undefined {
  const dir = installedPlugin('caveman', undefined, 'skills');
  if (!dir) return;
  let md = '';
  try { md = fs.readFileSync(path.join(dir, 'skills', 'caveman', 'SKILL.md'), 'utf8'); } catch { return; }
  md = md.replace(/^---[\s\S]*?\n---\s*/, '')                      // frontmatter
    .replace(/\n## Persistence[\s\S]*?(?=\n## )/, '\n')            // on/off commands: not a chat with a person who toggles it
    .trim();
  if (md.length < 200) return;
  return `## Reply style (caveman)\nYour chat replies and status text follow these rules. Files you write (code, comments, the handoff, plans, commit messages) and questions you ask the user are normal clear prose.\n\n${md}`;
}
