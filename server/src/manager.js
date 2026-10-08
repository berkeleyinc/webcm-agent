// Session registry: creation, lookup, concurrency slots and persistence.
//
// "Each new user has a new environment" is enforced here: a visitor without a
// session cookie gets a brand new session with its own VM, its own root
// filesystem state and its own network budget.

import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { Session } from './session.js';

const SESSION_ID_RE = /^s_[0-9a-f]{16}$/;

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.queue = [];
    this.runningCount = 0;
    this.flushTimer = null;
    this.dataRoot = resolve(config.dataDir);
    mkdirSync(join(this.dataRoot, 'sessions'), { recursive: true });
    this.loadFromDisk();
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  // ------------------------------------------------------------- persistence

  fileFor(id) {
    return join(this.dataRoot, 'sessions', `${id}.json`);
  }

  loadFromDisk() {
    const dir = join(this.dataRoot, 'sessions');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (!raw || !SESSION_ID_RE.test(raw.id)) continue;
        const session = new Session(this, {
          id: raw.id,
          token: raw.token,
          cols: raw.cols || 120,
          rows: raw.rows || 30,
          createdAt: raw.createdAt || Date.now(),
          recipe: Array.isArray(raw.recipe) ? raw.recipe : [],
          history: Array.isArray(raw.history) ? raw.history : [],
          agentHistory: Array.isArray(raw.agentHistory) ? raw.agentHistory : [],
        });
        if (raw.log) session.terminal.write(raw.log);
        session.dirty = false;
        this.sessions.set(session.id, session);
      } catch (err) {
        this.emit('log', `failed to load session ${name}: ${err.message}`);
      }
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1500);
    this.flushTimer.unref?.();
  }

  flush() {
    for (const session of this.sessions.values()) {
      if (!session.dirty) continue;
      session.dirty = false;
      try {
        writeFileSync(this.fileFor(session.id), JSON.stringify(session.toJSON()), 'utf8');
      } catch (err) {
        // The data dir can disappear under us (tests, tmp cleanup, a mounted
        // volume). Recreate it and keep the session marked dirty to retry.
        session.dirty = true;
        if (err.code === 'ENOENT') mkdirSync(join(this.dataRoot, 'sessions'), { recursive: true });
        else this.emit('log', `failed to persist ${session.id}: ${err.message}`);
      }
    }
  }

  // -------------------------------------------------------------------- CRUD

  create({ cols, rows } = {}) {
    const id = `s_${randomBytes(8).toString('hex')}`;
    const session = new Session(this, { id, token: randomBytes(24).toString('base64url'), cols, rows });
    this.sessions.set(id, session);
    this.emit('created', session);
    return session;
  }

  get(id) {
    if (!id || !SESSION_ID_RE.test(id)) return null;
    return this.sessions.get(id) || null;
  }

  /** Resolve from a cookie/token pair, creating a session when absent. */
  resolveOrCreate(id, token, { cols, rows } = {}) {
    const existing = this.get(id);
    if (existing && (!token || existing.token === token)) return { session: existing, created: false };
    const session = this.create({ cols, rows });
    return { session, created: true };
  }

  remove(id, reason = 'removed') {
    const session = this.get(id);
    if (!session) return false;
    session.close(reason).catch(() => {});
    this.sessions.delete(id);
    try {
      unlinkSync(this.fileFor(id));
    } catch {
      /* ignore */
    }
    this.emit('removed', session);
    return true;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  stats() {
    let boots = 0;
    for (const s of this.sessions.values()) if (s.running) boots++;
    return {
      sessions: this.sessions.size,
      running: boots,
      queued: this.queue.length,
      slots: config.session.maxRunning,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  get startedAt() {
    return this._startedAt || (this._startedAt = Date.now());
  }

  // ------------------------------------------------------------------ slots

  /** Wait until a VM slot is free (or time out) and take it. */
  async reserveSlot(session, timeoutMs = 180000) {
    if (this.runningCount < config.session.maxRunning) {
      this.runningCount++;
      return;
    }
    this.emit('log', `at capacity (${this.runningCount}/${config.session.maxRunning}) - queueing session ${session.id}`);
    return new Promise((res, rej) => {
      const waiter = {
        session,
        resolve: () => {
          clearTimeout(waiter.timer);
          res();
        },
        timer: setTimeout(() => {
          this.queue = this.queue.filter((w) => w !== waiter);
          rej(new Error('timed out waiting for a VM slot'));
        }, timeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  releaseSlot() {
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = this.queue.shift();
    if (next) {
      this.runningCount++;
      next.resolve();
    }
  }

  // ------------------------------------------------------------------ sweeper

  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      const idleFor = now - session.lastSeen;
      if (config.session.idleMs > 0 && idleFor > config.session.idleMs) {
        this.remove(session.id, 'idle timeout');
        continue;
      }
      if (session.running && session.instance) {
        if (config.session.maxWallMs > 0 && session.instance.uptimeMs > config.session.maxWallMs) {
          if (session.clients.size > 0) session.restart().catch(() => {});
          else session.suspend('wall clock limit').catch(() => {});
        } else if (
          config.session.maxCycles > 0 &&
          session.instance.cycles > config.session.maxCycles &&
          session.clients.size === 0
        ) {
          session.suspend('cycle budget').catch(() => {});
        } else if (
          session.clients.size === 0 &&
          !session.busy &&
          // A command in flight (headless exec, e.g. from a script) must not be
          // interrupted by a suspend halfway through.
          session.pending.size === 0 &&
          (session.bridge?.pending.size ?? 0) === 0
        ) {
          session.suspend('detached').catch(() => {});
        }
      }
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    this.flush();
    await Promise.all([...this.sessions.values()].map((s) => s.close('server shutdown').catch(() => {})));
  }
}
