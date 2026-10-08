// A user session = one private VM + its screen + its network bridge.
//
// Sessions survive client (disconnects: the VM keeps running while the session
// is active, so a user can close the tab, and the agent keeps working. When the
// session goes idle the VM is suspended; the session keeps its transcript, its
// command recipe and its history, and is rebuilt on the next attach.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { Instance, InstanceState } from './instance.js';
import { Terminal, stripAnsi } from './vt.js';
import { Bridge } from './bridge.js';

export const SessionState = {
  BOOTING: 'booting',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
};

let cmdCounter = 0;

/**
 * The guest profile sets PS1 to `\h [\w]# `, so a finished command always
 * reprints something like `cartesi-machine [/root]# ` at the end of the stream.
 * Used only as a fallback when the end sentinel is lost.
 */
const PROMPT_RE = /(?:^|\n)[^\n]{0,160}[#$] ?$/;
const PROMPT_TAIL = 200;
const PROMPT_IDLE_MS = 250;
const PROMPT_POLL_MS = 80;

/**
 * A pty never signals EOF, so a snippet that reads stdin without redirection
 * (`cat $(which foo)` where the substitution is empty, `read x`, a pager) waits
 * for the next line forever - the host's sentinel never arrives. After this long
 * with no output the host sends one ^D at the command (which is a real EOF
 * because the guest tty is in canonical mode), and the command completes.
 */
const STDIN_EOF_IDLE_MS = 2000;

export class Session extends EventEmitter {
  constructor(manager, { id, token, cols = 120, rows = 30, createdAt = Date.now(), recipe = [], history = [], agentHistory = [], log = '' }) {
    super();
    this.manager = manager;
    this.id = id;
    this.token = token;
    this.createdAt = createdAt;
    this.lastSeen = createdAt;

    /** @type {Instance|null} */
    this.instance = null;
    this.terminal = new Terminal({ cols, rows });
    this.bridge = new Bridge(this);
    this.state = SessionState.READY;
    this.error = null;

    /** Attached clients: id -> { conn, kind, cols, rows, bridge, info } */
    this.clients = new Map();
    this.attachEpoch = 0;
    this.detachTimer = null;
    this.idleTimer = null;

    /** Commands that recreate the session's environment after a suspend. */
    this.recipe = recipe;
    this.history = history;
    this.agentHistory = agentHistory;
    this.log = log;
    this.replayPending = recipe.length > 0;

    this.pending = new Map();
    this.pendingAttachMessages = [];
    this.busy = null;
    this.dirty = false;
    this.closed = false;
    this.markDirty();
  }

  // ---------------------------------------------------------------- accessors

  get running() {
    return this.instance !== null && this.instance.running;
  }

  get booted() {
    return this.instance !== null && this.instance.booted;
  }

  /** Preferred client for the network bridge: a browser if one is attached. */
  get bridgeClient() {
    for (const client of this.clients.values()) {
      if (client.kind === 'user' && client.bridge) return client;
    }
    for (const client of this.clients.values()) {
      if (client.bridge) return client;
    }
    return null;
  }

  get userClients() {
    return [...this.clients.values()].filter((c) => c.kind === 'user');
  }

  hasAgentClient() {
    return [...this.clients.values()].some((c) => c.kind === 'agent');
  }

  // ------------------------------------------------------------- persistence

  markDirty() {
    this.dirty = true;
    this.manager.scheduleFlush();
  }

  toJSON() {
    return {
      id: this.id,
      token: this.token,
      createdAt: this.createdAt,
      lastSeen: this.lastSeen,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      state: this.running ? this.state : 'suspended',
      recipe: this.recipe,
      history: this.history.slice(-500),
      log: this.terminal.logText(64 * 1024),
      agentHistory: this.agentHistory.slice(-200),
    };
  }

  summary() {
    return {
      id: this.id,
      state: this.running ? this.state : 'suspended',
      createdAt: this.createdAt,
      lastSeen: this.lastSeen,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      clients: this.clients.size,
      bridge: {
        available: this.bridge.available,
        pending: this.bridge.pending.size,
        bytes: this.bridge.bytes,
      },
      instance: this.instance ? this.instance.stats() : null,
      busy: this.busy ? { id: this.busy.id, prompt: this.busy.prompt, startedAt: this.busy.startedAt } : null,
      historySize: this.history.length,
      recipeSize: this.recipe.length,
    };
  }

  // ------------------------------------------------------------------ clients

  static clientId() {
    return `c_${randomBytes(6).toString('hex')}`;
  }

  async attach(conn, { kind = 'user', cols, rows, bridge = false, info = null } = {}) {
    const id = Session.clientId();
    const client = { id, conn, kind, cols: cols || this.terminal.cols, rows: rows || this.terminal.rows, bridge, info };
    this.clients.set(id, client);
    this.lastSeen = Date.now();
    if (this.detachTimer) {
      clearTimeout(this.detachTimer);
      this.detachTimer = null;
    }

    if (cols && rows) this.terminal.setSize(cols, rows);

    conn.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onClientMessage(client, data);
    });
    conn.on('close', () => this.detach(client));

    conn.sendJson({
      t: 'welcome',
      sessionId: this.id,
      clientId: id,
      state: this.running ? this.state : 'suspended',
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      booted: this.booted,
      clients: this.clients.size,
    });

    if (!this.running) await this.ensureRunning();

    // Replay the persisted transcript so the client sees prior work.
    if (this.terminal.log.length) {
      conn.sendJson({ t: 'history', data: this.terminal.logText(128 * 1024) });
    }
    conn.sendJson({ t: 'screen', data: this.snapshot().text });

    if (this.pendingAttachMessages) {
      for (const msg of this.pendingAttachMessages.splice(0)) conn.sendJson(msg);
    }
    return client;
  }

  detach(client) {
    const wasBridge = this.bridgeClient === client;
    this.clients.delete(client.id);
    if (wasBridge) this.bridge.clientGone();
    this.broadcast({ t: 'clients', count: this.clients.size });
    this.markDirty();
    if (this.clients.size === 0 && !this.busy) this.scheduleDetach();
  }

  scheduleDetach() {
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => {
      this.detachTimer = null;
      if (this.clients.size === 0 && !this.busy) this.suspend('detached').catch(() => {});
    }, config.session.detachMs);
    this.detachTimer.unref?.();
  }

  onClientMessage(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'in':
        this.writeToVm(msg.data, msg.binary ? 'base64' : 'utf8');
        break;
      case 'resize':
        this.resize(msg.cols, msg.rows);
        break;
      case 'ping':
        client.conn.sendJson({ t: 'pong', ts: msg.ts });
        break;
      case 'http.response':
        this.bridge.settle(msg.id, msg);
        break;
      case 'http.error':
        this.bridge.fail(msg.id, msg.message);
        break;
      default:
        break;
    }
  }

  send(client, msg) {
    try {
      client.conn.sendJson(msg);
    } catch {
      /* client gone */
    }
  }

  broadcast(msg, { kinds = null } = {}) {
    for (const client of this.clients.values()) {
      if (kinds && !kinds.includes(client.kind)) continue;
      try {
        client.conn.sendJson(msg);
      } catch {
        /* ignore */
      }
    }
  }

  broadcastOutput(buf) {
    for (const client of this.clients.values()) {
      try {
        client.conn.send(buf, { binary: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------ runtime

  async ensureRunning() {
    if (this.closed) throw new Error('session closed');
    if (this.running) {
      if (this.replayPending) await this.replayRecipe();
      return;
    }
    await this.manager.reserveSlot(this);
    const instance = new Instance({
      id: this.id,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      dataDir: config.dataDir,
    });
    this.instance = instance;
    instance.on('output', (buf) => {
      this.terminal.write(buf);
      this.broadcastOutput(buf);
      this.markDirty();
      this.emit('output', buf);
    });
    instance.on('ready', () => {
      this.state = this.busy ? SessionState.BUSY : SessionState.READY;
      if (this.replayPending) {
        this.replayRecipe().catch((err) => this.emit('log', `replay failed: ${err.message}`));
      }
      this.broadcast({ t: 'ready' });
    });
    instance.on('state', (state) => {
      this.broadcast({ t: 'state', state: state === InstanceState.RUNNING ? SessionState.READY : state });
    });
    instance.on('closed', (info) => {
      this.broadcast({ t: 'instance', state: 'stopped', reason: info.reason });
      this.manager.releaseSlot(this);
      if (this.pending.size) {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          clearInterval(entry.watchdog);
          clearInterval(entry.eofTimer);
          this.instance?.off('output', entry.onOutput);
          entry.fail?.(new Error('VM halted'));
        }
        this.pending.clear();
      }
    });
    instance.on('http-request', (msg) => this.handleGuestHttp(msg));
    instance.on('log', (msg) => this.emit('log', msg));
    this.state = SessionState.BOOTING;
    this.broadcast({ t: 'state', state: this.state });
    await instance.start();
    await this.waitForBoot();
  }

  /**
   * A request the guest made through the emulator's fetch hook (its https-proxy
   * tunnels through us).
   *
   * The VM runs server-side, so the server's own egress is the primary route:
   * no CORS, no browser in the loop, and it works headless. The browser bridge
   * is kept as a fallback for the case the user's network sees hosts the server
   * cannot (an intranet, a localhost dev server).
   */
  async handleGuestHttp({ id, input }) {
    const body = input.bodyB64 ? Buffer.from(input.bodyB64, 'base64') : null;
    const started = Date.now();
    try {
      let response;
      let viaBridge = false;
      try {
        response = await this.serverFetch(input.url, input.method, input.headers, body);
      } catch (serverErr) {
        if (!this.bridge.available) throw serverErr;
        this.emit('log', `server fetch failed (${serverErr.message}), retrying via browser: ${input.url}`);
        response = await this.bridge.performFetch({ url: input.url, method: input.method, headers: input.headers, body });
        viaBridge = true;
      }
      this.instance?.respond(id, {
        response: {
          status: response.status,
          statusText: response.statusText || '',
          url: response.url || input.url,
          headers: response.headers,
          bodyB64: response.body && response.body.length ? Buffer.from(response.body).toString('base64') : '',
        },
      });
      this.emit('http', { url: input.url, method: input.method, status: response.status, viaBridge, ms: Date.now() - started });
    } catch (err) {
      this.emit('http', { url: input.url, method: input.method, error: err.message, viaBridge: this.bridge.available });
      this.instance?.respond(id, { error: err.message });
    }
  }

  /** Direct server-side fetch, used when no browser is bridging. */
  async serverFetch(url, method, headers, body) {
    const init = { method: method || 'GET', redirect: 'follow' };
    const list = (headers || []).filter(([k]) => !/^(host|content-length|connection)$/i.test(k));
    if (list.length) init.headers = list;
    if (body && body.length) init.body = body;
    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      headers: [...res.headers],
      body: buf,
    };
  }

  waitForBoot(timeoutMs = 120000) {
    if (this.booted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('VM did not boot in time'));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onClosed = () => {
        cleanup();
        reject(new Error('VM halted during boot'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.instance?.off('ready', onReady);
        this.instance?.off('closed', onClosed);
      };
      this.instance.once('ready', onReady);
      this.instance.once('closed', onClosed);
    });
  }

  async replayRecipe() {
    this.replayPending = false;
    if (!this.recipe.length) return;
    this.broadcast({ t: 'note', level: 'info', message: `restoring ${this.recipe.length} command(s) from the saved session` });
    for (const command of this.recipe) {
      // eslint-disable-next-line no-await-in-loop
      await this.exec(command, { timeoutMs: 120000, quietMs: 400, record: false, replay: true });
    }
    this.broadcast({ t: 'note', level: 'info', message: 'session restored' });
  }

  writeToVm(data, encoding = 'utf8') {
    if (!this.running) return false;
    const buf = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
    return this.instance.write(buf);
  }

  resize(cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 5) return;
    this.terminal.setSize(cols, rows);
    if (this.instance) this.instance.resize(cols, rows);
    for (const client of this.clients.values()) {
      client.cols = cols;
      client.rows = rows;
    }
    this.markDirty();
  }

  snapshot() {
    return {
      text: this.terminal.screenText(),
      cursor: this.terminal.cursor,
      log: this.terminal.logText(64 * 1024),
    };
  }

  overBridgeQuota(bytes) {
    return config.quota.maxBridgeBytes > 0 && bytes.received > config.quota.maxBridgeBytes;
  }

  // ------------------------------------------------------- command execution

  /**
   * Run a shell snippet in the *live* shell and return its output.
   *
   * The guest profile defines `webcm-agent-run <id> <base64>`, which prints
   * sentinels around the snippet. We wrap the command in a bracketed paste
   * (ESC[200~..ESC[201~) so multi-line scripts are not executed line by line.
   */
  async exec(command, { timeoutMs = config.agent.commandTimeoutMs, quietMs = 0, record = true, replay = false, stream = null, stdinEof = true } = {}) {
    if (!this.running) throw new Error('VM is not running');
    const id = `${++cmdCounter}_${randomBytes(3).toString('hex')}`;
    const b64 = Buffer.from(command, 'utf8').toString('base64');
    const line = `\x01webcm-agent-run ${id} ${b64}\n`;

    const beginMarker = `__WAGENT_BEGIN_${id}__`;
    const endRe = new RegExp(`__WAGENT_END_${id}_(\\d+)__`);

    let buffer = '';
    let started = false;
    let beginIdx = -1;

    const result = await new Promise((resolve, reject) => {
      const entry = {
        id,
        command,
        startedAt: Date.now(),
        lastOutputAt: Date.now(),
        quietMs,
        output: '',
        timer: null,
        onOutput: null,
        chunks: [],
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        clearInterval(entry.watchdog);
        if (entry.onOutput) this.instance?.off('output', entry.onOutput);
        const err = new Error(`command timed out after ${timeoutMs}ms`);
        err.partial = stripAnsi(entry.output);
        reject(err);
      }, timeoutMs);

      entry.onOutput = (buf) => {
        const text = buf.toString('utf8');
        buffer += text;
        entry.lastOutputAt = Date.now();
        if (!started) {
          beginIdx = buffer.indexOf(beginMarker);
          if (beginIdx >= 0) {
            started = true;
            // Drop the marker and the newline that follows it, so `buffer` holds
            // only the command's own output (empty for a command that prints
            // nothing).
            buffer = buffer.slice(beginIdx + beginMarker.length).replace(/^\r?\n/, '');
          }
        }
        if (!started) return;
        const match = endRe.exec(buffer);
        if (match) {
          const out = buffer.slice(0, match.index);
          finish(out, Number(match[1]));
          return;
        }
        // Stream live output between markers.
        if (stream && text) stream(stripAnsi(text));
        this.emit('exec-output', { id, text });
      };

      const finish = (raw, exitCode, viaPrompt = false) => {
        clearTimeout(entry.timer);
        clearInterval(entry.watchdog);
        clearInterval(entry.eofTimer);
        this.instance?.off('output', entry.onOutput);
        this.pending.delete(id);
        const cleaned = cleanOutput(raw, command, viaPrompt);
        entry.output = cleaned;
        resolve({ id, exitCode, output: cleaned, viaPrompt, durationMs: Date.now() - entry.startedAt });
      };

      // Safety net for a lost end sentinel (Ctrl-C, `exec`, a program eating the
      // shell, truncated output): fall back to prompt detection. The shell always
      // reprints its prompt when the command really finished, which is why this
      // is correct even for commands that stay silent for a long time.
      // Completion when the end sentinel is lost (the user hit Ctrl-C, the
      // snippet called `exec`, an interactive program is in the foreground, or
      // output was truncated). The shell always reprints its prompt when the
      // command really finished, and nothing between the markers can look like a
      // prompt (the echoed `webcm-agent-run <id> <base64>` blob has no `#`/`$`),
      // so this is an exact signal - unlike a "quiet for N seconds" heuristic,
      // which fires while a slow silent command (`find /`, `apk upgrade`) is
      // still running.
      entry.watchdog = setInterval(() => {
        if (!started) return;
        if (Date.now() - entry.lastOutputAt < PROMPT_IDLE_MS) return;
        if (PROMPT_RE.test(buffer.slice(-PROMPT_TAIL))) finish(buffer, null, true);
      }, PROMPT_POLL_MS);

      entry.fail = (err) => {
        clearTimeout(entry.timer);
        clearInterval(entry.watchdog);
        clearInterval(entry.eofTimer);
        this.instance?.off('output', entry.onOutput);
        this.pending.delete(id);
        err.partial = stripAnsi(buffer);
        reject(err);
      };

      // stdin rescue (see STDIN_EOF_IDLE_MS note above). Idle-based, not
      // empty-buffer-based: `echo hi; read x` prints first and then blocks.
      if (stdinEof) {
        entry.eofTimer = setInterval(() => {
          if (!started || entry.eofSent) return;
          if (Date.now() - entry.lastOutputAt < STDIN_EOF_IDLE_MS) return;
          entry.eofSent = true;
          this.instance?.write('\x04');
        }, 200);
      }

      this.pending.set(id, entry);
      this.instance.on('output', entry.onOutput);
      if (!this.running) {
        reject(new Error('VM halted before command could run'));
        return;
      }
      this.instance.write(Buffer.from(line, 'utf8'));
    });

    if (record && !replay) {
      this.history.push({ command, exitCode: result.exitCode, at: Date.now() });
      this.recipe.push(command);
      this.markDirty();
      this.broadcast({ t: 'history-entry', entry: { command, exitCode: result.exitCode, at: Date.now() } });
    }
    return result;
  }

  /** Send raw key bytes with no sentinel bookkeeping (interactive use). */
  async sendKeys(keys, { waitMs = 800 } = {}) {
    this.writeToVm(keys);
    await sleep(waitMs);
    return { output: this.terminal.logText(64 * 1024) };
  }

  /** Type plain text (no marker) - used to touch up an interactive program. */
  async type(text, { waitMs = 500 } = {}) {
    this.writeToVm(text);
    await sleep(waitMs);
    return { output: this.terminal.logText(64 * 1024) };
  }

  // ------------------------------------------------------------------ control

  async suspend(reason = 'idle') {
    if (!this.instance) return;
    this.broadcast({ t: 'note', level: 'info', message: `suspending VM (${reason})` });
    const instance = this.instance;
    this.instance = null;
    await instance.stop({ reason });
    this.manager.releaseSlot(this);
    this.replayPending = true;
    this.markDirty();
    this.broadcast({ t: 'state', state: 'suspended' });
  }

  async restart() {
    if (this.instance) {
      const instance = this.instance;
      this.instance = null;
      await instance.stop({ reason: 'restart' });
      this.manager.releaseSlot(this);
    }
    this.terminal.reset();
    this.terminal.log = '';
    this.replayPending = false;
    await this.ensureRunning();
    this.broadcast({ t: 'note', level: 'info', message: 'virtual machine restarted' });
  }

  async close(reason = 'closed') {
    this.closed = true;
    clearTimeout(this.detachTimer);
    clearTimeout(this.idleTimer);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      clearInterval(entry.watchdog);
      clearInterval(entry.eofTimer);
      this.instance?.off('output', entry.onOutput);
      entry.fail?.(new Error('session closed'));
    }
    this.pending.clear();
    for (const client of this.clients.values()) {
      this.send(client, { t: 'closed', reason });
      client.conn.close(1000, 'session closed');
    }
    this.clients.clear();
    if (this.instance) {
      const instance = this.instance;
      this.instance = null;
      await instance.stop({ reason });
      this.manager.releaseSlot(this);
    }
    this.emit('closed', reason);
  }

  markSeen() {
    this.lastSeen = Date.now();
    this.markDirty();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Remove echo noise, sentinel leftovers and a trailing prompt from captured
 * output. `viaPrompt` means the end sentinel never arrived, so the command echo
 * and the final prompt *are* present and must be trimmed.
 */
function cleanOutput(raw, command, viaPrompt) {
  let text = stripAnsi(raw);
  if (viaPrompt) {
    // Everything up to the first newline is the echoed paste (`webcm-agent-run ...`).
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
    text = text.replace(PROMPT_RE, '');
    // The shell also echoes the trailing prompt sequence; drop a bare one.
    text = text.replace(/\n?[^\n]{0,140}[#$] $/, '');
  }
  return text.replace(/^\r?\n/, '').replace(/\s+$/, '').replace(/\n?[^\n]{0,160}[#$] ?$/, (m) => (m.startsWith('\n') ? '' : m));
}
