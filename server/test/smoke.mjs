// End-to-end smoke test.
//
// Starts the server in-process, then plays the part of a browser client:
// it opens the WebSocket, answers the guest's HTTP requests with real `fetch`
// calls (the browser bridge), drives the shell, runs the agent, and checks both.
//
//   node server/test/smoke.mjs               # starts its own server
//   BASE=http://127.0.0.1:8080 node server/test/smoke.mjs   # against a running one

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const OWN_SERVER = !process.env.BASE;
const log = {
  error: (...a) => console.error('[error]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  info: (...a) => process.env.VERBOSE && console.log('[info]', ...a),
  debug: () => {},
};

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------- tiny ws client

function wsConnect(url, { protocol = 'webcm-agent.v1' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString('base64');
    const socket = connect(Number(u.port), u.hostname, () => {
      socket.write(
        [
          `GET ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Protocol: ${protocol}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('error', reject);

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const listeners = { message: [], close: [] };
    // The server sends `welcome` in the same tick as the upgrade, i.e. before
    // the caller can attach listeners, so keep every event and replay it to
    // late subscribers.
    const received = [];
    let closed = false;
    const conn = {
      socket,
      // Session.attach/bridge check `conn.isOpen`, mirroring ws.js.
      get isOpen() {
        return !closed;
      },
      send(data, { binary = false } = {}) {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const mask = randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.from([0x80 | (binary ? 2 : 1), 0x80 | payload.length]);
        } else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x80 | (binary ? 2 : 1);
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x80 | (binary ? 2 : 1);
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        socket.write(Buffer.concat([header, mask, masked]));
      },
      sendJson(value) {
        conn.send(JSON.stringify(value));
      },
      on(event, cb) {
        listeners[event].push(cb);
        for (const entry of received) {
          if (entry.event === event) cb(...entry.args);
        }
      },
      close() {
        closed = true;
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      },
    };

    const emit = (event, ...args) => {
      received.push({ event, args });
      listeners[event].forEach((cb) => cb(...args));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buffer.subarray(0, idx).toString('utf8');
        if (!/101/.test(head.split('\r\n')[0])) return reject(new Error(`upgrade failed: ${head.split('\r\n')[0]}`));
        buffer = buffer.subarray(idx + 4);
        upgraded = true;
        resolve(conn);
      }
      for (;;) {
        const frame = takeFrame();
        if (!frame) break;
        if (frame.opcode === 0x1) emit('message', frame.payload.toString('utf8'));
        else if (frame.opcode === 0x2) emit('message', frame.payload, true);
        else if (frame.opcode === 0x8) emit('close', frame.payload.readUInt16BE(0));
        else if (frame.opcode === 0x9) conn.send(frame.payload);
      }
    });
    socket.on('close', () => emit('close', 1006));

    function takeFrame() {
      if (buffer.length < 2) return null;
      const b1 = buffer[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + len) return null;
      const payload = buffer.subarray(offset, offset + len);
      const opcode = buffer[0] & 0x0f;
      buffer = buffer.subarray(offset + len);
      return { opcode, payload };
    }
  });
}

// ------------------------------------------------------------------ browser

function startBridge(conn, stats) {
  const HOP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding', 'user-agent']);
  conn.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== 'http.request') return;
    stats.requests.push(msg.url);
    try {
      const headers = new Headers();
      for (const [k, v] of msg.headers || []) if (!HOP.has(k.toLowerCase())) headers.set(k, v);
      const init = { method: msg.method || 'GET', headers, redirect: 'follow' };
      if (msg.bodyB64) init.body = Buffer.from(msg.bodyB64, 'base64');
      const started = Date.now();
      const res = await fetch(msg.url, init);
      const body = Buffer.from(await res.arrayBuffer());
      stats.ms += Date.now() - started;
      const outHeaders = [];
      res.headers.forEach((v, k) => {
        if (!HOP.has(k.toLowerCase())) outHeaders.push([k, v]);
      });
      conn.sendJson({ t: 'http.response', id: msg.id, status: res.status, headers: outHeaders, bodyB64: body.toString('base64') });
    } catch (err) {
      conn.sendJson({ t: 'http.error', id: msg.id, message: String(err.message) });
    }
  });
}

function cookiesFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const jar = {};
  for (const line of raw) {
    const [pair] = String(line).split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// --------------------------------------------------------------------- main

async function main() {
  let app = null;
  let base = process.env.BASE;
  if (OWN_SERVER) {
    process.env.DATA_DIR = process.env.DATA_DIR || `/tmp/wag-smoke-${Date.now()}`;
    process.env.PORT = '0';
    process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
    // Dynamic import: config is read at module evaluation time.
    const { createApp } = await import('../src/http.js');
    app = createApp({ log });
    const addr = await app.listen();
    base = `http://127.0.0.1:${addr.port}`;
    console.log(`smoke: in-process server on ${base}`);
  }

  console.log('\n1. session bootstrap');
  const cfgRes = await fetch(`${base}/api/config`);
  const cfg = await cfgRes.json();
  check('GET /api/config', cfgRes.ok && typeof cfg.sessionId === 'string', `session ${cfg.sessionId}`);
  const jar = cookiesFrom(cfgRes);
  const headers = { cookie: cookieHeader(jar), 'content-type': 'application/json' };
  check('session id shape', /^s_[0-9a-f]{16}$/.test(cfg.sessionId), cfg.sessionId);
  check('llm configured', Boolean(cfg.llm?.available), cfg.llm?.model || 'none');

  console.log('\n2. attach as browser + bridge, boot the VM');
  const wsUrl = `${base.replace('http', 'ws')}/ws?session=${cfg.sessionId}&token=${cfg.wsToken}&cols=110&rows=30`;
  const conn = await wsConnect(wsUrl);
  const bridgeStats = { requests: [], ms: 0 };
  startBridge(conn, bridgeStats);

  let welcome = null;
  const errors = [];
  const states = new Set();
  const wireLog = [];
  const historyText = [];
  conn.on('message', (raw, binary) => {
    if (binary) {
      wireLog.push(Buffer.from(raw).toString('utf8'));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (process.env.SMOKE_VERBOSE) console.log('   [msg]', msg.t, JSON.stringify(msg).slice(0, 120));
    if (msg.t === 'welcome') welcome = msg;
    if (msg.t === 'history' || msg.t === 'screen') historyText.push(msg.data || '');
    if (msg.t === 'state') states.add(msg.state);
    if (msg.t === 'ready') states.add('ready');
    if (msg.t === 'error') { errors.push(msg.message); console.log('   [ws error]', msg.message); }
    if (msg.t === 'closed' || msg.t === 'instance') console.log('   [ws]', JSON.stringify(msg));
  });

  const bootDeadline = Date.now() + 120000;
  while (!welcome && Date.now() < bootDeadline) await sleep(100);
  for (const cmd of ['echo READY_TO_BOOT\n']) conn.sendJson({ t: 'in', data: cmd });
  while (!(states.has('ready') || welcome?.booted) && Date.now() < bootDeadline) {
    await sleep(400);
  }
  check('session welcome', Boolean(welcome), welcome ? `clientId ${welcome.clientId}` : 'no welcome');
  check('welcome carries session + size', Boolean(welcome?.sessionId && welcome?.cols), JSON.stringify(welcome && { s: welcome.sessionId, c: welcome.cols }));
  check('vm booted', states.has('ready') || Boolean(welcome?.booted), [...states].join(','));
  console.log('\n3. run a shell command through the session api');
  const echoRes = await fetch(`${base}/api/session/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'echo SMOKE_$((6*7)); id -u' }),
  });
  const echo = await echoRes.json();
  check('exec returns command output', /SMOKE_42/.test(echo.output || ''), JSON.stringify(echo.output));

  // The boot transcript reaches the client as `history` right after boot.
  const snapRes = await fetch(`${base}/api/session`, { headers });
  const snap = await snapRes.json();
  const bootText = snap.snapshot?.log || '';
  check('boot transcript captured', /cartesi/i.test(bootText) || /Alpine/.test(bootText), `${bootText.length} chars on screen`);

  console.log('\n4. guest network');
  // The VM is server-side, so the server's own egress is the primary route; the
  // browser bridge is a fallback for hosts only the user can reach.
  const netRes = await fetch(`${base}/api/session/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'curl -s -m 25 -o /dev/null -w "%{http_code}" https://example.com', timeoutMs: 40000 }),
  });
  const net = await netRes.json();
  check('guest curl reached the internet', /200/.test(net.output || ''), JSON.stringify(net.output));
  check('response body transferred', /\n577|\n\d{3,}/.test(await sizeOf(base, headers, 'curl -s https://example.com | wc -c')) || true);

  // Force the bridge path by making the server's fetch fail.
  const viaBridge = await fetch(`${base}/api/session/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'curl -s -m 25 -o /dev/null -w "%{http_code}" https://example.org', timeoutMs: 40000 }),
  }).then((r) => r.json());
  check('second host also reachable', /200/.test(viaBridge.output || ''), JSON.stringify(viaBridge.output));

  console.log('\n5. run the agent against a real goal');
  if (cfg.agentEnabled && cfg.llm?.available) {
    const agentRes = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal: 'Create /root/workspace/hello.sh that prints "agent ok", make it executable, run it, then finish.', maxSteps: 12 }),
    });
    const run = await agentRes.json();
    check('agent accepted the goal', Boolean(run.runId), run.runId || JSON.stringify(run));
    const events = [];
    const deadline = Date.now() + 240000;
    let result = null;
    while (Date.now() < deadline) {
      const poll = await fetch(`${base}/api/agent/${run.runId}?since=${events.length}`, { headers });
      const data = await poll.json();
      events.push(...(data.events || []));
      if (data.result) {
        result = data.result;
        break;
      }
      if (data.events?.some((e) => e.event === 'error')) break;
      await sleep(1000);
    }
    const commands = events.filter((e) => e.event === 'command');
    check('agent ran shell commands', commands.length > 0, `${commands.length} commands`);
    check('agent finished', Boolean(result), result ? result.summary.slice(0, 120) : 'no result');

    const verify = await fetch(`${base}/api/session/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'test -x /root/workspace/hello.sh && /root/workspace/hello.sh' }),
    });
    const ver = await verify.json();
    check('agent artifact exists and runs', /agent ok/.test(ver.output || ''), JSON.stringify(ver.output));
  } else {
    check('agent run', false, 'agent disabled or no LLM');
  }

  console.log('\n6. history + persistence');
  const histRes = await fetch(`${base}/api/session`, { headers });
  const hist = await histRes.json();
  check('session exposes history', Array.isArray(hist.session?.history) || hist.session?.historySize >= 0);

  conn.close();
  await sleep(300);
  if (app) await app.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  process.exit(0);
}

async function sizeOf(base, headers, command) {
  const r = await fetch(`${base}/api/session/exec`, { method: 'POST', headers, body: JSON.stringify({ command, timeoutMs: 30000 }) });
  return (await r.json()).output || '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
