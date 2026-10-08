// One VM per user session.
//
// The Cartesi RISC-V machine is server-side wasm; every session owns its own
// wasm instance (Module({ pty })) with its own heap, so sessions cannot observe
// each other. The wasm entry point blocks until the guest halts, so `run()`
// lives inside a worker_thread and the session talks to it through a small
// control plane (stdin lines). Guest output is pushed back as raw tty bytes.
//
// Lifecycle of one instance:
//
//   spawn()  -> new Worker(server/src/vm-worker.js)
//   ready    -> guest booted, prompt printed, instance "running"
//   write()  -> bytes into the guest tty (only while running)
//   resize() -> SIGWINCH into the guest tty
//   stop()   -> halts the worker (hard) or stops the VM (soft, then hard)

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';

const WORKER_URL = new URL('./vm-worker.js', import.meta.url);

let httpSeq = 0;

export const InstanceState = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  BOOTING: 'booting',
  STOPPING: 'stopping',
  HALTED: 'halted',
  FAILED: 'failed',
};

export class Instance extends EventEmitter {
  constructor({ id, cols = 120, rows = 30, dataDir }) {
    super();
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.dataDir = dataDir;
    this.state = InstanceState.STOPPED;
    this.worker = null;
    this.pid = null;
    this.startedAt = 0;
    this.readyAt = 0;
    this.lastActivity = 0;
    this.outputBytes = 0;
    this.inputBytes = 0;
    this.cycles = 0;
    this.exitReason = null;
    this.error = null;
    this.killTimer = null;
    this.softTimer = null;
    /** Guest-visible screen size is set once; resize goes through SIGWINCH. */
    this.pendingEcho = null;
    this.httpPending = new Map();
  }

  get running() {
    return this.state === InstanceState.RUNNING || this.state === InstanceState.BOOTING;
  }

  get booted() {
    return this.state === InstanceState.RUNNING;
  }

  get uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  get idleMs() {
    return Date.now() - (this.lastActivity || this.startedAt || Date.now());
  }

  /** @param {Record<string,string>} env */
  static agentEnv() {
    return {
      AGENT_DIR: resolve(config.agentDir),
    };
  }

  async start() {
    if (this.state !== InstanceState.STOPPED && this.state !== InstanceState.HALTED && this.state !== InstanceState.FAILED) {
      return;
    }
    const wasmPath = resolve(config.agentDir, 'webcm.wasm');
    const mjsPath = resolve(config.agentDir, 'webcm.mjs');
    if (!existsSync(mjsPath) || !existsSync(wasmPath)) {
      throw new Error(`webcm artifacts missing in ${resolve(config.agentDir)} (run \`make wasm\`)`);
    }
    this.state = InstanceState.STARTING;
    this.error = null;
    this.exitReason = null;
    this.startedAt = Date.now();
    this.lastActivity = Date.now();

    this.worker = new Worker(WORKER_URL, {
      workerData: {
        mjsPath,
        wasmPath: existsSync(wasmPath) ? wasmPath : undefined,
        cols: this.cols,
        rows: this.rows,
        maxCycles: config.session.maxCycles,
        memoryMiB: config.session.memoryMiB,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: config.session.memoryMiB + 256,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });

    this.worker.on('message', (msg) => this.#onWorkerMessage(msg));
    this.worker.on('error', (err) => {
      this.error = err;
      this.state = InstanceState.FAILED;
      this.emit('state', this.state, err);
      this.emit('closed', { reason: 'error', error: String(err && err.stack) || String(err) });
    });
    this.worker.on('exit', (code) => {
      this.#clearTimers();
      if (this.state !== InstanceState.FAILED) {
        this.state = code === 0 ? InstanceState.HALTED : InstanceState.FAILED;
      }
      this.emit('state', this.state);
      this.emit('exit', code);
    });
    this.emit('state', this.state);
  }

  #onWorkerMessage(msg) {
    switch (msg.t) {
      case 'ready':
        this.state = InstanceState.RUNNING;
        this.readyAt = Date.now();
        this.lastActivity = Date.now();
        this.pid = `worker:${this.worker.threadId}`;
        this.emit('ready');
        this.emit('state', this.state);
        break;
      case 'state':
        this.state = msg.state;
        if (msg.cycles) this.cycles = msg.cycles;
        this.emit('state', this.state, msg.detail);
        break;
      case 'out':
        this.outputBytes += msg.data.byteLength;
        this.lastActivity = Date.now();
        this.emit('output', Buffer.from(msg.data));
        break;
      case 'cycles':
        this.cycles = msg.cycles;
        break;
      case 'http-request':
        this.emit('http-request', msg);
        break;
      case 'http-response':
        this.respond(msg.id, msg);
        break;
      case 'log':
        this.emit('log', msg.message);
        break;
      case 'closed':
        this.exitReason = msg.reason;
        this.emit('closed', msg);
        break;
      default:
        break;
    }
  }

  #clearTimers() {
    clearTimeout(this.killTimer);
    clearTimeout(this.softTimer);
    this.killTimer = null;
    this.softTimer = null;
  }

  /**
   * Perform an HTTP request that originated *inside* the guest (the emulator's
   * fetch hook). Resolves with `{status, statusText, url, headers, body}`.
   */
  request(input) {
    const id = `h_${++httpSeq}`;
    return new Promise((resolve, reject) => {
      this.httpPending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ t: 'http-request', id, input });
      } catch (err) {
        this.httpPending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Answer a guest HTTP request.
   *
   * Requests can originate two ways: from this thread (`request()`, tracked in
   * httpPending) or from inside the guest/worker (`http-request` event, which
   * carries the worker's own id). The second kind must simply be handed back.
   */
  respond(id, response) {
    const entry = this.httpPending.get(id);
    if (entry) {
      this.httpPending.delete(id);
      if (response.error) entry.reject(new Error(response.error));
      else entry.resolve(response.response ?? response);
      return;
    }
    try {
      this.worker?.postMessage({ t: 'http-response', id, ...response });
    } catch {
      /* worker gone */
    }
  }

  write(data) {
    if (!this.running || !this.worker) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf.length) return true;
    this.inputBytes += buf.length;
    this.lastActivity = Date.now();
    // NB: Buffer.from() hands out slices of a shared pool, so copy the exact
    // bytes into a standalone ArrayBuffer before transferring it.
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    this.worker.postMessage({ t: 'in', data: copy }, [copy.buffer]);
    return true;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.worker) this.worker.postMessage({ t: 'resize', cols, rows });
  }

  /**
   * Ask the guest to power off (`xhalt` via init) and fall back to killing the
   * worker if it does not comply within `graceMs`.
   */
  async stop({ reason = 'stopped', graceMs = 15000 } = {}) {
    if (this.state === InstanceState.STOPPED) return;
    if (this.state === InstanceState.STOPPING) return this.stopping;
    this.state = InstanceState.STOPPING;
    this.emit('state', this.state, reason);
    this.stopping = new Promise((resolvePromise) => {
      const finish = () => {
        this.#clearTimers();
        this.worker = null;
        if (this.state !== InstanceState.FAILED) this.state = InstanceState.STOPPED;
        this.exitReason = this.exitReason || reason;
        this.emit('state', this.state);
        resolvePromise();
      };
      if (!this.worker) return finish();
      this.worker.once('exit', finish);
      try {
        this.worker.postMessage({ t: 'stop', reason });
        this.softTimer = setTimeout(() => this.#hardKill('stop-timeout'), graceMs);
      } catch {
        this.#hardKill('post-failed');
      }
    });
    return this.stopping;
  }

  #hardKill(reason) {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ t: 'halt', reason });
    } catch {
      /* ignore */
    }
    this.killTimer = setTimeout(() => {
      if (this.worker) {
        this.worker.terminate().catch(() => {});
        this.worker = null;
      }
    }, 3000);
  }

  /** Immediate teardown (used on shutdown). */
  kill(reason = 'killed') {
    if (!this.worker) {
      this.state = InstanceState.STOPPED;
      return;
    }
    this.exitReason = reason;
    const worker = this.worker;
    this.worker = null;
    this.state = InstanceState.STOPPED;
    worker.terminate().catch(() => {});
  }

  stats() {
    return {
      state: this.state,
      pid: this.pid,
      uptimeMs: this.uptimeMs,
      idleMs: this.idleMs,
      cycles: this.cycles,
      outputBytes: this.outputBytes,
      inputBytes: this.inputBytes,
      cols: this.cols,
      rows: this.rows,
      exitReason: this.exitReason,
      error: this.error ? String(this.error.message || this.error) : null,
    };
  }
}
