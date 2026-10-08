// Worker thread that owns one Cartesi RISC-V VM (server-side wasm).
//
// Important subtlety: the emscripten module's default export resolves as soon as
// the runtime is initialised (~2s) — *not* when the guest halts. `main()` keeps
// running on its own, driven by asyncify sleeps, for the whole VM lifetime. So we
// stay alive until the entry point prints its epilogue ("Cycles: ...") or the
// parent asks us to stop.
//
// main -> worker : { t:'in', data }      bytes typed into the guest tty
//                  { t:'resize', cols, rows }
//                  { t:'stop' }          graceful poweroff (xhalt)
//                  { t:'halt' }          hard stop
// worker -> main : { t:'ready' }         guest booted
//                  { t:'out', data }     raw guest output bytes
//                  { t:'state', state }
//                  { t:'log', message }
//                  { t:'cycles', cycles }
//                  { t:'closed', reason }

import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { installXhrShim } from './xhr-shim.js';

const incoming = [];
let readListeners = [];
let signalListeners = [];
let win = [workerData.cols || 120, workerData.rows || 30];

/**
 * tty settings, matching what upstream webcm applies in the browser (derived
 * from a stock musl termios plus `-sTTY`):
 *   iflag &= ~0x5eb, lflag &= ~0x804b (raw: no ICANON/ECHO/ISIG/cr->nl),
 *   cflag  = 0xbf & ~0x130 | 0x30 (CS8), oflag = 0x5 | 0x1 (OPOST|ONLCR).
 * ONLCR is what makes `\n` move to column 0 - without it the guest output
 * stair-steps across the screen. ISIG off means Ctrl-C is delivered as a byte
 * (0x03), which is how the agent interrupts programs.
 */
const termios = {
  iflag: 25856 & ~0x5eb,
  oflag: 5,
  cflag: (191 & ~0x130) | 0x30,
  lflag: 35387 & ~0x804b,
  cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
let stopped = false;
let bootOutput = '';
let booted = false;
let epilogueSeen = false;

const EPILOGUE_RE = /^(Cycles: (\d+)|Halted|Yielded |Reached target|Interpreter failed)/;

function post(msg, transfer) {
  parentPort.postMessage(msg, transfer);
}

/**
 * Output batching.
 *
 * The guest console emits roughly one byte per write, which would otherwise mean
 * one postMessage + one WebSocket frame per character (a 1KiB command output
 * became ~1000 frames). We coalesce in the worker, where it is cheapest.
 */
const OUT_FLUSH_MS = 8;
const OUT_MAX_CHUNK = 64 * 1024;
let pendingOut = [];
let pendingBytes = 0;

function flushOut() {
  if (pendingBytes === 0) return;
  const merged = pendingOut.length === 1 ? pendingOut[0] : Buffer.concat(pendingOut, pendingBytes);
  pendingOut = [];
  pendingBytes = 0;
  const copy = new Uint8Array(merged.byteLength);
  copy.set(merged);
  post({ t: 'out', data: copy }, [copy.buffer]);
}

const outTimer = setInterval(flushOut, OUT_FLUSH_MS);
outTimer.unref?.();

/** Minimal pty slave compatible with xterm-pty's `slave` object. */
const slave = {
  write(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!booted && bootOutput.length < 64 * 1024) bootOutput += buf.toString('utf8');
    pendingOut.push(buf);
    pendingBytes += buf.length;
    if (pendingBytes >= OUT_MAX_CHUNK) flushOut();
  },
  read(n) {
    const take = n === undefined ? incoming.length : Math.min(incoming.length, n);
    return incoming.splice(0, take);
  },
  get readable() {
    return incoming.length > 0;
  },
  get writable() {
    return true;
  },
  ioctl(cmd, arg) {
    if (cmd === 'TCGETS') return { ...termios, cc: [...termios.cc] };
    if (cmd === 'TCSETS') {
      Object.assign(termios, arg);
      return 0;
    }
    if (cmd === 'TIOCGWINSZ') return win;
    if (cmd === 'TIOCSWINSZ') {
      if (arg) win = [arg[0], arg[1]];
      return 0;
    }
    return 0;
  },
  onReadable(cb) {
    readListeners.push(cb);
    return {
      dispose: () => {
        readListeners = readListeners.filter((f) => f !== cb);
      },
    };
  },
  onWritable(cb) {
    return {
      dispose: () => {
        /* no-op: we are never write-blocked */
      },
    };
  },
  onSignal(cb) {
    signalListeners.push(cb);
    return {
      dispose: () => {
        signalListeners = signalListeners.filter((f) => f !== cb);
      },
    };
  },
};

function onEntryPointLine(line) {
  post({ t: 'log', message: line });
  const m = EPILOGUE_RE.exec(line);
  if (!m) return;
  if (m[2]) post({ t: 'cycles', cycles: Number(m[2]) });
  if (epilogueSeen) return;
  epilogueSeen = true;
  // The entry point finished: the machine halted (clean poweroff or failure).
  finish(stopped ? 'stopped' : 'halted');
}

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  post({ t: 'closed', reason });
  // Let the parent read the last output frames before the thread dies.
  setTimeout(() => process.exit(0), 400).unref();
}

parentPort.on('message', (msg) => {
  switch (msg.t) {
    case 'in': {
      const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
      incoming.push(...bytes);
      for (const cb of readListeners) cb();
      break;
    }
    case 'resize': {
      win = [msg.cols, msg.rows];
      for (const cb of signalListeners) cb('SIGWINCH');
      break;
    }
    case 'halt': {
      stopped = true;
      post({ t: 'state', state: 'stopping', detail: 'hard halt' });
      for (const cb of readListeners) cb();
      // If the asyncify loop refuses to unwind, leave anyway.
      setTimeout(() => finish('stopped'), 4000).unref();
      break;
    }
    case 'stop': {
      stopped = true;
      post({ t: 'state', state: 'stopping', detail: msg.reason || 'stop' });
      // `xhalt` makes cartesi-init power the machine off cleanly.
      incoming.push(...new Uint8Array(Buffer.from('\nxhalt\n')));
      for (const cb of readListeners) cb();
      setTimeout(() => finish('stopped'), 20000).unref();
      break;
    }
    case 'http-response': {
      const entry = httpPending.get(msg.id);
      if (!entry) break;
      httpPending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error));
        break;
      }
      const res = msg.response;
      // The body travels base64-encoded over the worker channel; the XHR shim
      // wants raw bytes.
      entry.resolve({ ...res, body: res.bodyB64 ? Buffer.from(res.bodyB64, 'base64') : Buffer.alloc(0) });
      break;
    }
    default:
      break;
  }
});

/**
 * Guest-originated HTTP. The emulator's fetch hook (used by the guest
 * `https-proxy`) is synchronous under the hood, so the request goes out to the
 * session and the answer comes back on the same channel.
 */
let httpSeq = 0;
const httpPending = new Map();

let httpIndex = 0;
const httpQueue = [];

function guestRequest({ url, method, headers, body }) {
  const id = `w${++httpSeq}`;
  const copy = body && body.byteLength ? new Uint8Array(body) : undefined;
  return new Promise((resolve, reject) => {
    httpPending.set(id, { resolve, reject });
    const payload = { t: 'http-request', id, input: { url, method, headers, bodyB64: copy ? Buffer.from(copy).toString('base64') : null } };
    // Keep the message tiny; the session re-fetches it.
    payload.input.bodyB64 = payload.input.bodyB64;
    post(payload);
    setTimeout(() => {
      if (!httpPending.has(id)) return;
      httpPending.delete(id);
      reject(new Error('guest http request timed out'));
    }, 180000).unref?.();
  });
}

async function main() {
  installXhrShim(globalThis, guestRequest);
  const mjsUrl = pathToFileURL(workerData.mjsPath).href;
  const mod = await import(mjsUrl);
  const initEmscripten = mod.default || mod;
  if (typeof initEmscripten !== 'function') throw new Error('webcm.mjs did not export a default init function');

  const moduleArg = {
    pty: slave,
    thisProgram: 'webcm',
    print: onEntryPointLine,
    printErr: (line) => post({ t: 'log', message: String(line) }),
  };
  if (workerData.wasmPath) moduleArg.wasmBinary = await readFile(workerData.wasmPath);

  // Boot readiness: the guest prints a shell prompt, but we also probe for the
  // agent profile so we never start typing commands at a shell that lacks
  // `webcm-agent-run`. `main()` keeps running, so this must stay cheap.
  let probeSent = false;
  const readyWatcher = setInterval(() => {
    if (booted) return;
    if (!probeSent && bootOutput.includes('# ')) {
      probeSent = true;
      // `stty onlcr` is the one setting that matters for rendering: without it
      // the guest's `\n` does not return the cursor to column 0 and output
      // stair-steps across the terminal. The guest image also does this from
      // /etc/profile.d, but the pty is shared, so doing it once here means it
      // holds even for shells that never source the profile.
      incoming.push(...new Uint8Array(Buffer.from('stty onlcr 2>/dev/null;echo __WAGRDY__\n')));
      for (const cb of readListeners) cb();
      return;
    }
    if (probeSent && bootOutput.includes('__WAGRDY__')) {
      booted = true;
      clearInterval(readyWatcher);
      post({ t: 'ready' });
      post({ t: 'state', state: 'running' });
    }
  }, 150);
  readyWatcher.unref();

  post({ t: 'state', state: 'booting' });
  await initEmscripten(moduleArg);
  // NB: main() is still running inside the runtime from here on.
  if (!epilogueSeen) post({ t: 'state', state: 'running' });
}

main().catch((err) => {
  post({ t: 'log', message: `worker error: ${err && err.stack}` });
  post({ t: 'closed', reason: 'error', error: String(err && err.stack) });
  setTimeout(() => process.exit(1), 100);
});
