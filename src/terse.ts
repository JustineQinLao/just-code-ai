import * as fs from 'fs';
import * as path from 'path';
import { installedPlugin } from './claude';

// 🪨 Terse replies: the caveman plugin's rules (github.com/JuliusBrussee/caveman) in task and chat sessions, so
// Claude's prose (status lines, summaries, answers) costs fewer output tokens while code, commands, paths and errors
// stay exact. Its rules are read from the installed plugin and appended to the system prompt; the plugin itself is
// not loaded in tasks, because its hooks keep per-session state in ~/.claude and can ask Claude to set up a status
// line, which is not the task's work. Files Claude writes (code, brief, handoff, commits) stay in normal prose.

// The one line sent with every message (a hook), since system-prompt rules fade over a long task.
export const REMIND = 'Reply style: caveman rules from your instructions for status lines and the final summary (short, exact, no filler). Code, files and commit messages stay normal.';

export function rules(): string | undefined {
  const dir = installedPlugin('caveman', undefined, 'skills');
  if (!dir) return;
  let md = '';
  try { md = fs.readFileSync(path.join(dir, 'skills', 'caveman', 'SKILL.md'), 'utf8'); } catch { return; }
  md = md.replace(/^---[\s\S]*?\n---\s*/, '')                      // frontmatter
    .replace(/\n## Persistence[\s\S]*?(?=\n## )/, '\n')            // on/off commands: not a chat with a person who toggles it
    // Sent on every step of a task: keep the rules, drop the rationale, examples, self-check and chat-only parts.
    .replace(/\n## (Why|Pre-send check)\b[\s\S]*?(?=\n## |$)/g, '\n')
    .replace(/\n### \d+\. (User's language|Never perform caveman)[\s\S]*?(?=\n##)/g, '\n')
    .replace(/^(Bad|Good):.*\n?/gm, '')
    .replace(/\nSwitch:.*$/s, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (md.length < 200) return;
  return `## Reply style (caveman)\nEvery message you write in this session follows these rules: status lines between tool calls and your final summary of the turn (what changed, what you verified, what you could not). Files you write (code, comments, the handoff, plans, commit messages) and questions you ask the user are normal clear prose.\n\n${md}`;
}
