import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { sdk, Sdk } from './sdk';
import { alwaysChoice, allowedBy, toolArg, Suggestion } from './policy';
import { settingSources, systemPrompt, TASK_APPEND, OUTPUT_CAPS, addUsage, Usage } from './claude';

// One task's live Claude session, through the Agent SDK. Claude runs as a child process the SDK owns; JustCode talks
// to it in structured messages, so a permission request arrives as data (tool + input) and is answered as data. No
// terminal, no screen reading, no key presses. The session stays open between turns (follow-ups, review fixes) and is
// closed when idle; a later message resumes it from Claude Code's saved transcript.

export type RunState = 'starting' | 'running' | 'waiting' | 'idle';

export interface Question { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] }

// Something Claude waits on: a permission (Allow / Always / Deny) or a question with choices.
export interface Ask {
  id: string;
  kind: 'permission' | 'question' | 'plan';
  tool: string;
  detail: string;            // main argument: the command, the file
  reason?: string;           // why Claude Code asks (outside the folder, …)
  always?: string;           // label of the "Always" choice, when there is one
  questions?: Question[];
  plan?: string;             // kind plan: the plan Claude wants approved (markdown)
  at: number;
}

export interface Step { kind: 'user' | 'say' | 'tool' | 'result' | 'error' | 'info'; text: string; time?: string; agent?: string }

// Agent map: the task's session and every subagent it starts, with what each has used.
export interface AgentNode {
  id: string; parent?: string; name: string; description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  tokens: number; tools: number; ms: number; started: number; last?: string; summary?: string; toolUseId?: string;
}

export interface TurnEnd { ok: boolean; error?: string; text: string; limit?: boolean; costUsd?: number; usage?: Usage }

export interface SessionOptions {
  bin: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  mode: string;
  model?: string;
  effort?: string;            // low | medium | high | xhigh | max (empty: the model's default)
  subagents?: boolean;        // let Claude start subagents (each carries its own large prompt); off by default
  append?: string;            // system-prompt append (defaults to the task guidance; the planner uses its own)
  readOnly?: boolean;         // block all edits (the planner never changes code)
  agent?: string;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  allowed: string[];          // rules approved without asking (project + settings + task)
  rules: () => string[];      // current rules, re-read on each request: "Always" on another card applies here at once
  addDirs?: string[];
  settingsFile?: string;      // project settings that are not in the task's copy (uncommitted settings.local.json)
  env: Record<string, string>;
  idleMs: number;
  personal?: boolean;         // also load the user's own Claude setup (plugins, skills, MCP, memory)
  label: string;              // name of the root node in the agent map
}

const MAX_STEPS = 400;

// A queue of user messages the SDK reads from: what keeps the session open between turns.
class Inbox implements AsyncIterable<Sdk.SDKUserMessage> {
  private items: Sdk.SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(text: string) {
    if (this.closed) return false;
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as Sdk.SDKUserMessage);
    this.wake?.();
    return true;
  }
  close() { this.closed = true; this.wake?.(); }
  get isClosed() { return this.closed; }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>(r => { this.wake = r; });
      this.wake = undefined;
    }
  }
}

export class Session {
  state: RunState = 'starting';
  asks = new Map<string, Ask>();
  steps: Step[] = [];
  agents = new Map<string, AgentNode>();
  mode: string;
  modeNote?: string;               // e.g. Auto mode unavailable, so Claude asks instead
  context = 0;                     // tokens in context (last main-thread request)
  output = 0;                      // tokens Claude wrote this session
  private ev = new EventEmitter();
  private inbox = new Inbox();
  private ac = new AbortController();
  private q?: Sdk.Query;
  private pending = new Map<string, (answer: Answer) => void>();
  private idle?: NodeJS.Timeout;
  private ended = false;

  constructor(private o: SessionOptions) {
    this.mode = o.mode;
    this.agents.set('main', { id: 'main', name: o.label, description: 'Task session', status: 'running', tokens: 0, tools: 0, ms: 0, started: Date.now() });
  }

  on(ev: 'change', fn: () => void): this;
  on(ev: 'turn', fn: (t: TurnEnd) => void): this;
  on(ev: 'ask', fn: (a: Ask) => void): this;
  on(ev: 'running', fn: () => void): this;
  on(ev: 'rate', fn: (info: any) => void): this;
  on(ev: 'exit', fn: (error?: string) => void): this;
  on(ev: string, fn: (...a: any[]) => void) { this.ev.on(ev, fn); return this; }
  private emit(ev: string, ...a: unknown[]) { this.ev.emit(ev, ...a); }
  private changed() { this.emit('change'); }

  get open() { return !this.ended; }

  async start(prompt?: string) {
    if (prompt) this.inbox.push(prompt);
    const { query } = await sdk();
    const o = this.o;
    const options: Sdk.Options = {
      cwd: o.cwd,
      pathToClaudeCodeExecutable: o.bin,
      env: { ...o.env, ...OUTPUT_CAPS, ...(o.subagents ? { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } : {}) },
      systemPrompt: systemPrompt(o.append ?? TASK_APPEND),
      permissionMode: o.mode as Sdk.PermissionMode,
      // Lets the user switch a running task to Allow everything; it does not turn that mode on by itself.
      allowDangerouslySkipPermissions: true,
      settingSources: settingSources(!!o.personal),
      ...(o.settingsFile ? { settings: o.settingsFile } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort as Sdk.Options['effort'] } : {}),
      ...(o.readOnly ? { disallowedTools: ['Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] } : o.subagents ? {} : { disallowedTools: ['Agent', 'Task'] }),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.agents && Object.keys(o.agents).length ? { agents: o.agents as any } : {}),
      ...(o.allowed.length ? { allowedTools: o.allowed } : {}),
      ...(o.addDirs?.length ? { additionalDirectories: o.addDirs } : {}),
      ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
      abortController: this.ac,
      agentProgressSummaries: true,
      canUseTool: (tool, input, opt) => this.permission(tool, input, opt as any),
      stderr: (s: string) => { if (/error/i.test(s)) this.step({ kind: 'error', text: s.trim().slice(0, 400) }); },
    };
    this.q = query({ prompt: this.inbox, options });
    this.state = prompt ? 'running' : 'idle';
    this.changed();
    void this.read();
  }

  private async read() {
    let error: string | undefined;
    try {
      for await (const m of this.q!) this.message(m);
    } catch (e: any) {
      if (!this.ac.signal.aborted) error = String(e?.message ?? e).slice(0, 600);
    }
    this.finish(error);
  }

  private finish(error?: string) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idle);
    for (const [id, resolve] of this.pending) resolve({ id, choice: 'deny', message: 'The session ended' });
    this.pending.clear();
    this.asks.clear();
    for (const n of this.agents.values()) if (n.status === 'running') n.status = error ? 'failed' : n.id === 'main' ? 'completed' : 'stopped';
    if (error) this.step({ kind: 'error', text: error });
    this.state = 'idle';
    this.emit('exit', error);
    this.changed();
    this.ev.removeAllListeners();
  }

  /* ---------- messages from Claude ---------- */

  private message(m: Sdk.SDKMessage) {
    const main = this.agents.get('main')!;
    switch (m.type) {
      case 'system': {
        const s = m as any;
        if (s.subtype === 'init') {
          if (s.permissionMode && s.permissionMode !== this.o.mode) {
            this.modeNote = `${this.o.mode} is not available here, so Claude runs in ${s.permissionMode} mode.`;
            this.mode = s.permissionMode;
            this.step({ kind: 'info', text: this.modeNote });
          }
        } else if (s.subtype === 'task_started') {
          this.agents.set(s.task_id, { id: s.task_id, parent: s.parent_task_id ?? 'main', name: s.subagent_type || s.task_type || 'agent',
            description: s.description ?? '', status: 'running', tokens: 0, tools: 0, ms: 0, started: Date.now(), toolUseId: s.tool_use_id });
          this.changed();
        } else if (s.subtype === 'task_progress') {
          const n = this.agents.get(s.task_id);
          if (n) Object.assign(n, { tokens: s.usage?.total_tokens ?? n.tokens, tools: s.usage?.tool_uses ?? n.tools, ms: s.usage?.duration_ms ?? n.ms, last: s.last_tool_name ?? n.last, summary: s.summary ?? n.summary });
          this.changed();
        } else if (s.subtype === 'task_notification' || s.subtype === 'task_updated') {
          const n = this.agents.get(s.task_id);
          const status = s.status ?? s.patch?.status;
          if (n && status) {
            n.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'running' || status === 'pending' ? 'running' : 'stopped';
            if (s.usage) Object.assign(n, { tokens: s.usage.total_tokens, tools: s.usage.tool_uses, ms: s.usage.duration_ms });
            if (s.summary) n.summary = String(s.summary).slice(0, 300);
            if (n.status !== 'running' && !n.ms) n.ms = Date.now() - n.started;
          }
          this.changed();
        }
        return;
      }
      case 'rate_limit_event':
        this.emit('rate', (m as any).rate_limit_info);
        return;
      case 'assistant': {
        const a = m as any;
        const sub = a.parent_tool_use_id ? this.agentFor(a.parent_tool_use_id) : undefined;
        if (!a.parent_tool_use_id) {
          const u = a.message?.usage;
          if (u) {
            this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            this.output += u.output_tokens ?? 0;
            main.tokens = this.context + this.output;
          }
        }
        for (const c of a.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim() && !sub) this.step({ kind: 'say', text: c.text.trim() });
          else if (c.type === 'tool_use') {
            if (!sub) { main.tools++; main.last = c.name; }
            this.step({ kind: 'tool', text: `${c.name}(${toolArg(c.input)})`, agent: sub });
          }
        }
        if (a.error === 'rate_limit') this.emit('rate', { status: 'rejected' });
        this.changed();
        return;
      }
      case 'user': {
        const u = m as any;
        if (u.parent_tool_use_id || u.isReplay) return;
        for (const c of Array.isArray(u.message?.content) ? u.message.content : []) {
          if (c.type === 'tool_result') this.step({ kind: c.is_error ? 'error' : 'result', text: resultText(c) });
        }
        return;
      }
      case 'result': {
        const r = m as any;
        main.ms += r.duration_ms ?? 0;
        const ok = r.subtype === 'success' && !r.is_error;
        const text = typeof r.result === 'string' ? r.result : '';
        const error = ok ? undefined : (r.errors?.join('; ') || text || r.subtype);
        const limit = !ok && /rate.?limit|usage limit|limit reached/i.test(String(error));
        if (error) this.step({ kind: 'error', text: String(error).slice(0, 600) });
        this.state = 'idle';
        this.armIdle();
        this.emit('turn', { ok, error, text, limit, costUsd: r.total_cost_usd, usage: addUsage(undefined, r.usage) } as TurnEnd);
        this.changed();
        return;
      }
    }
  }

  // Subagent messages carry the id of the Agent tool call that started them.
  private agentFor(toolUseId: string) {
    for (const n of this.agents.values()) if (n.toolUseId === toolUseId) return n.name;
    return 'subagent';
  }

  private step(s: Step) {
    this.steps.push({ ...s, time: s.time ?? new Date().toISOString() });
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
  }

  /* ---------- permissions and questions ---------- */

  private async permission(tool: string, input: Record<string, unknown>, opt: { signal: AbortSignal; suggestions?: Suggestion[]; decisionReason?: string; blockedPath?: string; toolUseID?: string }): Promise<Sdk.PermissionResult> {
    // A rule approved on another card while this session runs.
    if (tool !== 'AskUserQuestion' && allowedBy(this.o.rules(), tool, input)) return { behavior: 'allow', updatedInput: input };
    // The task's mode as the user set it. Claude Code may still ask in some cases (a protected path, a mode switch it
    // refused); the user's choice wins.
    if (tool !== 'AskUserQuestion' && autoApproves(this.mode, tool)) return { behavior: 'allow', updatedInput: input };
    const id = opt.toolUseID ?? randomUUID();
    const isQuestion = tool === 'AskUserQuestion';
    const always = isQuestion ? undefined : alwaysChoice(opt.suggestions);
    const ask: Ask = isQuestion
      ? { id, kind: 'question', tool, detail: '', questions: normalizeQuestions(input.questions), at: Date.now() }
      : tool === 'ExitPlanMode'
      ? { id, kind: 'plan', tool, detail: 'Claude\'s plan is ready', plan: String(input.plan ?? '').slice(0, 20000), at: Date.now() }
      : { id, kind: 'permission', tool, detail: toolArg(input) || JSON.stringify(input).slice(0, 300), reason: opt.decisionReason ?? (opt.blockedPath ? `Outside this task's folder: ${opt.blockedPath}` : undefined), always: always?.label, at: Date.now() };
    this.asks.set(id, ask);
    this.state = 'waiting';
    this.emit('ask', ask);
    this.changed();
    const answer = await new Promise<Answer>(resolve => {
      this.pending.set(id, resolve);
      opt.signal.addEventListener('abort', () => resolve({ id, choice: 'deny', message: 'Cancelled' }), { once: true });
    });
    this.pending.delete(id);
    this.asks.delete(id);
    if (!this.asks.size && this.state === 'waiting') this.state = 'running';
    this.changed();
    if (isQuestion) {
      if (answer.choice === 'deny' || !answer.answers) return { behavior: 'deny', message: answer.message || 'The user did not answer.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
    }
    if (answer.choice === 'deny') return { behavior: 'deny', message: answer.message?.trim() || 'The user denied this.', interrupt: false };
    if (answer.choice === 'always' && always) {
      if (always.rules.length) this.emit('rules', always.rules);
      const updatedPermissions = always.mode
        ? [{ type: 'setMode', mode: always.mode, destination: 'session' }]
        : [{ type: 'addRules', rules: always.rules.map(r => ({ toolName: r.replace(/\(.*$/, ''), ruleContent: /\((.*)\)$/.exec(r)?.[1] })), behavior: 'allow', destination: 'session' }];
      if (always.mode) this.mode = always.mode;
      return { behavior: 'allow', updatedInput: input, updatedPermissions: updatedPermissions as any };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  onRules(fn: (rules: string[]) => void) { this.ev.on('rules', fn); }

  answer(a: Answer) {
    const resolve = this.pending.get(a.id);
    if (!resolve) return false;
    resolve(a);
    return true;
  }

  /* ---------- control ---------- */

  send(text: string) {
    if (this.ended || this.inbox.isClosed) return false;
    clearTimeout(this.idle);
    this.step({ kind: 'user', text });
    this.inbox.push(text);
    this.state = 'running';
    this.emit('running');
    this.changed();
    return true;
  }

  // Switches the running session's mode. Requests already waiting on the card that the new mode would not ask
  // about are approved at once (Allow everything: all of them; Auto-edit: file edits).
  async setMode(mode: string) {
    this.mode = mode;
    if (this.q && !this.ended) {
      try { await this.q.setPermissionMode(mode as Sdk.PermissionMode); } catch (e: any) {
        this.step({ kind: 'info', text: `Claude Code did not switch to ${mode} (${String(e?.message ?? e).slice(0, 200)}); JustCode approves on its behalf instead.` });
      }
    }
    for (const a of [...this.asks.values()]) {
      if (a.kind === 'permission' && autoApproves(mode, a.tool)) this.answer({ id: a.id, choice: 'allow' });
    }
    this.changed();
  }

  async interrupt() {
    if (!this.q || this.ended) return;
    for (const [id, resolve] of this.pending) resolve({ id, choice: 'deny', message: 'Interrupted by the user' });
    await this.q.interrupt().catch(() => undefined);
  }

  // Ends the session: the Claude process exits, its transcript stays for a later resume.
  close() {
    if (this.ended) return;
    this.inbox.close();
    // Give Claude a moment to exit on its own (it saves the transcript), then make sure.
    const t = setTimeout(() => this.ac.abort(), 3000);
    t.unref?.();
  }

  kill() {
    this.inbox.close();
    this.ac.abort();
    this.finish();
  }

  private armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.state === 'idle' && !this.pending.size) this.close(); }, this.o.idleMs);
    this.idle.unref?.();
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const autoApproves = (mode: string, tool: string) => mode === 'bypassPermissions' || (mode === 'acceptEdits' && EDIT_TOOLS.has(tool));

export interface Answer { id: string; choice: 'allow' | 'always' | 'deny'; message?: string; answers?: Record<string, string> }

function normalizeQuestions(q: unknown): Question[] {
  if (!Array.isArray(q)) return [];
  return q.filter(x => x && typeof x.question === 'string').map(x => ({
    question: x.question, header: typeof x.header === 'string' ? x.header : undefined, multiSelect: !!x.multiSelect,
    options: Array.isArray(x.options) ? x.options.filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined, preview: typeof o.preview === 'string' ? o.preview.slice(0, 4000) : undefined })) : [],
  }));
}

function resultText(c: any) {
  const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
  const lines = t.split('\n').filter((l: string) => l.trim());
  return lines.length > 1 ? `${lines[0].slice(0, 300)}  (+${lines.length - 1} lines)` : lines[0]?.slice(0, 300) ?? '(no output)';
}
