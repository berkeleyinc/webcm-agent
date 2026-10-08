// The agent loop: drives a session's VM towards a goal with an LLM.
//
// The LLM never touches the VM directly; it gets a small tool surface that maps
// onto the session's live shell. Every step is broadcast to attached clients,
// so the browser (or another agent) can watch the agent work.

import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { chat, llmAvailable, llmLabel, LlmError } from './llm.js';
import { stripAnsi } from './vt.js';

const MAX_TOOL_OUTPUT = 6000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command inside the agent VM (Alpine Linux / RISC-V, ash shell). ' +
        'The command runs in the persistent live shell, so `cd` and `export` persist. ' +
        'Returns combined stdout/stderr and the exit code. Quote carefully; the whole string is passed to `eval`.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell script to execute.' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (default 180000).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the VM filesystem. Returns the first 200 lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          lines: { type: 'integer', description: 'Max lines to return (default 200).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the VM filesystem (content is transported base64-safe).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_keys',
      description:
        'Send raw key bytes to the terminal, for interacting with full-screen programs (nvim, top, pager). ' +
        'Use \\u001b for ESC, \\u0003 for Ctrl-C, \\r for Enter.',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string' },
          wait_ms: { type: 'integer' },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_screen',
      description: 'Return the current terminal screen (what a human would see right now).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_shell',
      description: 'Kill the current shell and start a fresh login shell (useful after breaking the terminal).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Declare the task complete and give the final answer.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
];

export class AgentError extends Error {}

export class AgentRun {
  constructor(session, goal, { maxSteps = config.agent.maxSteps } = {}) {
    this.id = `a_${randomBytes(5).toString('hex')}`;
    this.session = session;
    this.goal = goal;
    this.maxSteps = maxSteps;
    this.steps = 0;
    this.messages = [];
    this.events = [];
    this.result = null;
    this.aborted = false;
    this.startedAt = Date.now();
  }

  emit(event, payload = {}) {
    const record = { seq: this.events.length, at: Date.now(), event, ...payload };
    this.events.push(record);
    this.session.agentHistory.push({ run: this.id, goal: this.goal, event, at: record.at, ...payload });
    if (this.session.agentHistory.length > 200) this.session.agentHistory.splice(0, this.session.agentHistory.length - 200);
    this.session.broadcast({ t: 'agent', run: this.id, event, ...payload });
    return record;
  }

  abort() {
    this.aborted = true;
  }

  // ------------------------------------------------------------------- tools

  async callTool(name, args) {
    const session = this.session;
    switch (name) {
      case 'run_command': {
        const timeoutMs = Math.min(Math.max(1000, args.timeout_ms || config.agent.commandTimeoutMs), 20 * 60 * 1000);
        this.emit('command', { command: args.command });
        try {
          const res = await session.exec(args.command, { timeoutMs, quietMs: config.agent.quietMs });
          return `exit=${res.exitCode}\n${clip(res.output)}`;
        } catch (err) {
          const partial = err.partial ? `\n--- partial output ---\n${clip(err.partial)}` : '';
          return `ERROR: ${err.message}${partial}`;
        }
      }
      case 'read_file': {
        const lines = Math.min(Math.max(1, args.lines || 200), 2000);
        const res = await session.exec(`sed -n '1,${lines}p' ${shq(args.path)}`, { quietMs: 200 });
        return res.output || '(empty)';
      }
      case 'write_file': {
        const b64 = Buffer.from(args.content ?? '', 'utf8').toString('base64');
        const res = await session.exec(
          `mkdir -p "$(dirname ${shq(args.path)})" && printf '%s' ${shq(b64)} | base64 -d > ${shq(args.path)} && wc -c < ${shq(args.path)}`,
          { quietMs: 200 },
        );
        return `wrote ${res.output.trim() || '?'} bytes to ${args.path}`;
      }
      case 'send_keys': {
        this.emit('keys', { keys: args.keys });
        const res = await session.sendKeys(decodeEscapes(args.keys), { waitMs: Math.min(args.wait_ms || 800, 15000) });
        return clip(res.output);
      }
      case 'read_screen': {
        return session.snapshot().text;
      }
      case 'restart_shell': {
        await session.sendKeys('\u0003', { waitMs: 300 });
        await session.exec('exec $SHELL -l', { quietMs: 800, timeoutMs: 30000 }).catch(() => {});
        await session.sendKeys('\r', { waitMs: 500 });
        return 'shell restarted';
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  // -------------------------------------------------------------------- loop

  systemPrompt() {
    const session = this.session;
    return [
      'You are an autonomous coding/ops agent embedded in a web terminal.',
      '',
      'Environment:',
      '- A private Alpine Linux VM (RISC-V, Cartesi emulator) started freshly for this user.',
      '- You drive it through a live `ash` login shell. `cd`, `export`, aliases persist between run_command calls.',
      '- Available: gcc/g++, make, nodejs/npm, python3/pip, git, curl/wget, jq, sqlite3, nvim, rg, tar/gzip.',
      '- Network: HTTP/HTTPS work directly (the host performs the requests), so `apk add`, `curl` and',
      '  `git clone https://github.com/<owner>/<repo>.git` all work unmodified.',
      '- Working directory starts at /root. Persist work under /root/workspace.',
      '',
      'Rules:',
      '- Prefer small, verifiable steps. After a change, run something that proves it works.',
      '- Never assume a command succeeded: read its output and exit code.',
      '- Keep outputs small (pipe through `head`/`tail`) - the terminal transcript is your context.',
      '- When the goal is reached, call `finish` with a concise summary of what was done and how it was verified.',
      '',
      `Session: ${session.id}. Shell: ash. Terminal: ${session.terminal.cols}x${session.terminal.rows}.`,
    ].join('\n');
  }

  async run() {
    const session = this.session;
    if (!llmAvailable()) throw new AgentError('no LLM configured (LLM_BASE_URL)');
    await session.ensureRunning();

    session.busy = { id: this.id, prompt: this.goal, startedAt: this.startedAt, agent: this };
    session.broadcast({ t: 'state', state: 'busy' });
    this.emit('start', { goal: this.goal, model: llmLabel() });

    this.messages = [
      { role: 'system', content: this.systemPrompt() },
      {
        role: 'user',
        content: `Goal:\n${this.goal}\n\nCurrent screen:\n\`\`\`\n${trimScreen(session.snapshot().text)}\n\`\`\``,
      },
    ];

    try {
      while (this.steps < this.maxSteps && !this.aborted) {
        this.steps++;
        this.emit('step', { step: this.steps, max: this.maxSteps });

        let reply;
        try {
          reply = await chat({ messages: this.trimMessages(), tools: TOOLS });
        } catch (err) {
          this.emit('error', { message: err instanceof LlmError ? err.message : String(err) });
          throw err;
        }

        if (reply.content && reply.content.trim()) {
          this.emit('message', { text: reply.content.trim() });
        }

        if (reply.toolCalls.length) {
          this.messages.push({
            role: 'assistant',
            content: reply.content || '',
            tool_calls: reply.toolCalls,
          });
          for (const call of reply.toolCalls) {
            const name = call.function?.name;
            let args = {};
            try {
              args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              args = {};
            }
            this.emit('tool', { call: name, args: summarizeArgs(args) });
            if (name === 'finish') {
              this.result = { summary: args.summary || '', steps: this.steps };
              this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'acknowledged' });
              this.emit('finish', { summary: this.result.summary, steps: this.steps });
              return this.result;
            }
            let contentOut;
            try {
              contentOut = await this.callTool(name, args);
            } catch (err) {
              contentOut = `ERROR: ${err.message}`;
            }
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: String(contentOut).slice(0, MAX_TOOL_OUTPUT) });
            this.emit('result', { call: name, output: clip(contentOut, 1200) });
          }
          continue;
        }

        // No tool calls: treat the text as a progress note and nudge.
        this.messages.push({ role: 'assistant', content: reply.content || '(no content)' });
        this.messages.push({
          role: 'user',
          content: `Continue. Current screen:\n\`\`\`\n${trimScreen(session.snapshot().text)}\n\`\`\`\nCall a tool, or call \`finish\` if done.`,
        });
      }

      this.result = {
        summary: this.aborted ? 'aborted by user' : `stopped after ${this.steps} steps without an explicit finish`,
        steps: this.steps,
      };
      this.emit('finish', this.result);
      return this.result;
    } finally {
      if (session.busy && session.busy.id === this.id) session.busy = null;
      session.broadcast({ t: 'state', state: session.state });
      session.markDirty();
    }
  }

  /** Keep the model transcript inside the context window. */
  trimMessages() {
    const budgetChars = Math.max(50_000, Math.floor(config.llm.contextWindow * 3.2));
    let total = this.messages.reduce((n, m) => n + contentLength(m), 0);
    if (total <= budgetChars) return this.messages;
    const head = this.messages.slice(0, 2);
    const tail = [];
    let used = head.reduce((n, m) => n + contentLength(m), 0);
    for (let i = this.messages.length - 1; i >= 2; i--) {
      const len = contentLength(this.messages[i]);
      if (used + len > budgetChars) break;
      tail.unshift(this.messages[i]);
      used += len;
    }
    // Never start with a dangling tool message.
    while (tail.length && tail[0].role === 'tool' && tail[0].tool_call_id) tail.shift();
    return [...head, { role: 'user', content: '(earlier turns elided to fit context)' }, ...tail];
  }
}

// -------------------------------------------------------------------- helpers

function contentLength(msg) {
  if (typeof msg.content === 'string') return msg.content.length;
  if (Array.isArray(msg.content)) return msg.content.length * 80;
  return 100;
}

function clip(text, max = MAX_TOOL_OUTPUT) {
  const str = stripAnsi(String(text ?? ''));
  if (str.length <= max) return str;
  const head = str.slice(0, Math.floor(max * 0.6));
  const tail = str.slice(str.length - Math.floor(max * 0.3));
  return `${head}\n... [${str.length - head.length - tail.length} chars elided] ...\n${tail}`;
}

function trimScreen(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-24).join('\n');
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v;
  }
  return out;
}

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function decodeEscapes(text) {
  return String(text).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\e|\\x1b|\\033/g, '\u001b');
}
