// Permission rules in Claude Code's own syntax: "Edit", "Bash(npm run:*)" (prefix), "Bash(git status)" (exact),
// "WebFetch(domain:example.com)". JustCode keeps the rules you approve with "Always" per project, so every later task
// in that project gets them (Claude Code itself would save them in the task's own copy, which is deleted at merge).

export interface Rule { tool: string; content?: string }

export function parseRule(rule: string): Rule | undefined {
  const m = /^\s*([A-Za-z_][\w-]*)(?:\((.*)\))?\s*$/.exec(rule);
  if (!m) return;
  return { tool: m[1], content: m[2]?.trim() || undefined };
}

export const formatRule = (r: Rule) => r.content ? `${r.tool}(${r.content})` : r.tool;

// Shell operators that chain or redirect: a prefix rule never approves a compound command as a whole,
// the same as Claude Code (each part needs its own rule).
const COMPOUND = /&&|\|\||;|\||`|\$\(|>|<|\n/;

// Edit rules cover every file-changing tool, as in Claude Code.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Does `rule` approve this tool call? Only the simple cases are decided here (everything else asks): Claude Code
// applies the same rules itself through allowedTools when a session starts; this covers rules added while it runs.
export function matches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  const r = parseRule(rule);
  if (!r) return false;
  const sameTool = r.tool === tool || (r.tool === 'Edit' && EDIT_TOOLS.has(tool));
  if (!sameTool) return false;
  if (!r.content) return true;
  if (tool === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : '';
    if (!cmd || COMPOUND.test(cmd)) return false;
    if (r.content.endsWith(':*')) {
      const prefix = r.content.slice(0, -2).trim();
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return cmd === r.content;
  }
  if (r.content.startsWith('domain:')) {
    try { return new URL(String(input.url)).hostname === r.content.slice(7); } catch { return false; }
  }
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
  if (!file) return false;
  if (r.content.endsWith('/**')) return file.includes(r.content.slice(0, -3).replace(/^\.?\/*/, ''));
  return file.endsWith(r.content.replace(/^\.?\/*/, ''));
}

export const allowedBy = (rules: string[], tool: string, input: Record<string, unknown>) => rules.find(r => matches(r, tool, input));

// The suggestions Claude Code sends with a permission request, as JustCode offers them:
// rules to keep for the project, or a mode switch for this task only.
export interface Suggestion { type: string; rules?: { toolName: string; ruleContent?: string }[]; mode?: string; behavior?: string; destination?: string; directories?: string[] }

export function alwaysChoice(suggestions: Suggestion[] | undefined): { label: string; rules: string[]; mode?: string } | undefined {
  const rules = (suggestions ?? []).filter(s => s.type === 'addRules' && s.behavior !== 'deny')
    .flatMap(s => s.rules ?? []).map(r => formatRule({ tool: r.toolName, content: r.ruleContent }));
  if (rules.length) return { label: `Always allow ${rules.join(', ')}`.slice(0, 140), rules };
  const mode = suggestions?.find(s => s.type === 'setMode' && s.mode === 'acceptEdits');
  if (mode) return { label: 'Allow all edits in this task', rules: [], mode: 'acceptEdits' };
}

// The tool call's main argument, as Claude Code shows it: Bash(npm test), Read(src/a.ts).
export function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.notebook_path ?? o.pattern ?? o.url ?? o.description ?? o.prompt
    ?? Object.values(o).find(x => typeof x === 'string');
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 300) : '';
}
