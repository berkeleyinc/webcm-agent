// HTTP surface: cookie-scoped session API, static assets, health.
//
// The session cookie carries a token so a session id alone cannot be used from
// another browser. Sessions are created on demand ("each new user a new env").

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { SessionManager } from './manager.js';
import { AgentRun } from './agent.js';
import { llmLabel, llmAvailable } from './llm.js';
import { attachWebSocket } from './ws.js';
import { probeArtifacts } from './artifacts.js';

const COOKIE_SID = 'wag_sid';
const COOKIE_TOK = 'wag_tok';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp({ log }) {
  const manager = new SessionManager();
  manager.on('log', (msg) => log.info(`[sessions] ${msg}`));

  const runs = new Map(); // runId -> AgentRun
  const artifacts = probeArtifacts();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`request failed: ${err && err.stack}`);
      if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message) });
      else res.end();
    });
  });

  attachWebSocket(server, (conn, req) => handleUpgrade(conn, req, { manager, log }));

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/favicon.svg' || path === '/favicon.ico') {
      const body = await readFile(resolve(config.publicDir, 'favicon.svg')).catch(() => null);
      if (body) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
        return res.end(body);
      }
    }
    if (path === '/healthz') {
      return sendJson(res, 200, { ok: true, ...manager.stats(), artifacts: artifacts.ready });
    }
    if (path.startsWith('/api/')) return handleApi(req, res, url);
    if (config.serveWasm && path.startsWith('/agent/')) return serveAgentAsset(res, path.slice('/agent/'.length), log);
    return serveStatic(res, path, log);
  }

  async function handleApi(req, res, url) {
    const path = url.pathname;
    const { session, created } = ensureSession(req, res, url);
    if (created) log.info(`created session ${session.id} for ${req.socket.remoteAddress}`);

    if (path === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        sessionId: session.id,
        wsToken: session.token,
        agentEnabled: config.agent.enabled,
        llm: { model: llmLabel(), available: llmAvailable() },
        limits: {
          maxWallMs: config.session.maxWallMs,
          maxCycles: config.session.maxCycles,
          maxBridgeBytes: config.quota.maxBridgeBytes,
          slots: config.session.maxRunning,
        },
        wasm: { clientSide: config.serveWasm && artifacts.ready },
        demoCommands: DEMO_COMMANDS,
        recipes: session.recipe.slice(-12),
      });
    }

    if (path === '/api/session' && req.method === 'GET') {
      return sendJson(res, 200, { session: session.summary(), snapshot: session.snapshot() });
    }

    if (path === '/api/session/reset' && req.method === 'POST') {
      manager.remove(session.id, 'reset by user');
      const { session: fresh } = manager.resolveOrCreate(null, null, { cols: session.terminal.cols, rows: session.terminal.rows });
      setSessionCookies(res, fresh);
      return sendJson(res, 200, { sessionId: fresh.id });
    }

    if (path === '/api/session/restart' && req.method === 'POST') {
      await session.ensureRunning();
      await session.restart();
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/session/exec' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.command) return sendJson(res, 400, { error: 'command required' });
      try {
        const result = await session.exec(body.command, {
          timeoutMs: body.timeoutMs || config.agent.commandTimeoutMs,
          quietMs: body.quietMs ?? 300,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 200, { error: err.message, partial: err.partial || null });
      }
    }

    if (path === '/api/session/keys' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await session.sendKeys(decodeKeys(body.keys || ''), { waitMs: body.waitMs || 500 });
      return sendJson(res, 200, result);
    }

    if (path === '/api/session/screen' && req.method === 'GET') {
      return sendJson(res, 200, session.snapshot());
    }

    if (path === '/api/agent' && req.method === 'POST') {
      if (!config.agent.enabled) return sendJson(res, 503, { error: 'agent disabled' });
      const body = await readJson(req);
      const goal = (body.goal || '').trim();
      if (!goal) return sendJson(res, 400, { error: 'goal required' });
      const run = new AgentRun(session, goal, { maxSteps: body.maxSteps || config.agent.maxSteps });
      runs.set(run.id, run);
      run.onDone = () => setTimeout(() => runs.delete(run.id), 5 * 60 * 1000);
      const promise = run
        .run()
        .catch((err) => {
          run.emit('error', { message: err.message });
          return { summary: `failed: ${err.message}`, steps: run.steps };
        })
        .finally(() => run.onDone?.());
      if (body.wait) {
        const result = await promise;
        return sendJson(res, 200, { runId: run.id, ...result, events: run.events });
      }
      return sendJson(res, 202, { runId: run.id, status: 'running' });
    }

    const runMatch = /^\/api\/agent\/([a-z0-9_]+)$/.exec(path);
    if (runMatch && req.method === 'GET') {
      const run = runs.get(runMatch[1]);
      if (!run) return sendJson(res, 200, historyFallback(session));
      return sendJson(res, 200, {
        runId: run.id,
        goal: run.goal,
        steps: run.steps,
        events: run.events.slice(Number(url.searchParams.get('since') || 0)),
        result: run.result,
        running: Boolean(session.busy),
      });
    }

    const cancelMatch = /^\/api\/agent\/([a-z0-9_]+)\/cancel$/.exec(path);
    if (cancelMatch && req.method === 'POST') {
      const run = runs.get(cancelMatch[1]);
      if (run) run.abort();
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: manager.list(), stats: manager.stats() });
    }

    if (path.startsWith('/api/session/') && path.endsWith('/delete')) {
      const id = path.slice('/api/session/'.length, -'/delete'.length);
      const ok = manager.remove(id, 'deleted by api');
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    return sendJson(res, 404, { error: 'unknown api route' });
  }

  function historyFallback(session) {
    return { runId: null, events: (session.agentHistory || []).slice(-50), result: null, running: false };
  }

  function ensureSession(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = url.searchParams.get('session') || cookies[COOKIE_SID];
    const token = url.searchParams.get('token') || cookies[COOKIE_TOK];
    const { session, created } = manager.resolveOrCreate(sid, token, {
      cols: Number(url.searchParams.get('cols')) || 120,
      rows: Number(url.searchParams.get('rows')) || 30,
    });
    if (created) setSessionCookies(res, session);
    session.markSeen();
    return { session, created };
  }

  async function serveStatic(res, path, log) {
    const root = resolve(config.publicDir);
    let rel = normalize(decodeURIComponent(path)).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const info = await stat(file);
      if (info.isDirectory()) return serveStatic(res, `${rel}/`, log);
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(body);
    } catch {
      const hasExtension = extname(rel) !== '';
      if (!hasExtension || extname(rel) === '.html') {
        try {
          const body = await readFile(join(root, 'index.html'));
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          return res.end(body);
        } catch {
          /* fallthrough */
        }
      }
      sendJson(res, 404, { error: 'not found' });
    }
  }

  async function serveAgentAsset(res, name, log) {
    const file = resolve(config.agentDir, normalize(name));
    try {
      const info = await stat(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'public, max-age=86400',
      });
      const body = await readFile(file);
      res.end(body);
    } catch (err) {
      log.warn(`agent asset missing: ${name} (${err.message})`);
      sendJson(res, 404, { error: `agent asset ${name} missing; build with \`make wasm\`` });
    }
  }

  function handleUpgrade(conn, req, { manager, log }) {
    const url = conn.url;
    const sid = url.searchParams.get('session');
    const token = url.searchParams.get('token');
    const session = manager.get(sid);
    if (!session) {
      conn.sendJson({ t: 'error', message: `unknown session ${sid}` });
      return conn.close(4001, 'unknown session');
    }
    if (token && session.token !== token) {
      conn.sendJson({ t: 'error', message: 'invalid token' });
      return conn.close(4003, 'invalid token');
    }
    const kind = url.searchParams.get('kind') === 'agent' ? 'agent' : 'user';
    const bridge = url.searchParams.get('bridge') !== '0';
    const cols = Number(url.searchParams.get('cols')) || undefined;
    const rows = Number(url.searchParams.get('rows')) || undefined;
    session
      .attach(conn, { kind, cols, rows, bridge, info: { ua: req.headers['user-agent'] || '', ip: req.socket.remoteAddress } })
      .then(() => log.debug?.(`client attached to ${session.id} (${kind})`))
      .catch((err) => {
        conn.sendJson({ t: 'error', message: err.message });
        conn.close(1011, 'attach failed');
      });
  }

  return {
    server,
    manager,
    runs,
    listen: () =>
      new Promise((resolveListen) => {
        server.listen(config.port, config.host, () => resolveListen(server.address()));
      }),
    close: async () => {
      await manager.shutdown();
      await new Promise((r) => server.close(r));
    },
  };
}

// ------------------------------------------------------------------- helpers

const DEMO_COMMANDS = [
  'uname -a',
  'cat /etc/os-release',
  'ls -la /root',
  'apk info | head -30',
  'node -e "console.log(process.arch, process.version)"',
];

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookies(res, session) {
  const cookies = [
    `${COOKIE_SID}=${session.id}; Path=/; HttpOnly; SameSite=Lax`,
    `${COOKIE_TOK}=${session.token}; Path=/; HttpOnly; SameSite=Lax`,
  ];
  const existing = res.getHeader('set-cookie');
  res.setHeader('set-cookie', existing ? [...[].concat(existing), ...cookies] : cookies);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.quota.maxRequestBytes) break;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function decodeKeys(text) {
  return String(text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\e/g, '\u001b');
}

export function randomId(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}
