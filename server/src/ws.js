// Minimal RFC6455 WebSocket server (no dependencies).
//
// Handles the HTTP Upgrade dance, frame parsing (fragmentation, masking,
// control frames) and frame writing with a simple send queue.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const MAX_MESSAGE = 4 * 1024 * 1024;

export class WsConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOp = 0;
  #open = true;
  #queue = [];
  #draining = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.#onClose(1006, String(err.message)));
    socket.on('close', () => this.#onClose(1006, 'socket closed'));
  }

  get isOpen() {
    return this.#open;
  }

  get socket() {
    return this.#socket;
  }

  #onData(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.#parseFrame();
      if (!frame) break;
      this.#handleFrame(frame);
    }
  }

  #parseFrame() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, 'frame too large');
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_MESSAGE) {
      this.close(1009, 'message too large');
      return null;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.#buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.#send(Buffer.alloc(0), OP_CLOSE, true);
      this.#open = false;
      this.#socket.end();
      this.emit('close', code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '');
      return;
    }
    if (opcode === OP_PING) {
      this.#send(payload, OP_PONG, true);
      this.emit('ping', payload);
      return;
    }
    if (opcode === OP_PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OP_CONT) {
      this.#fragments.push(payload);
    } else {
      if (this.#fragments.length) {
        this.close(1002, 'interleaved fragments');
        return;
      }
      this.#fragmentOp = opcode;
      this.#fragments.push(payload);
    }
    if (!fin) return;
    const full = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments);
    const op = this.#fragmentOp;
    this.#fragments = [];
    this.emit('message', op === OP_TEXT ? full.toString('utf8') : full, op === OP_BINARY);
  }

  #onClose(code, reason) {
    if (!this.#open) return;
    this.#open = false;
    this.emit('close', code, reason);
  }

  #send(payload, opcode, fin = true) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = (fin ? 0x80 : 0) | opcode;
    return this.#write(Buffer.concat([header, payload]));
  }

  #write(buf) {
    if (!this.#open && buf[0] !== 0x88) {
      // still allow the close frame through
    }
    this.#queue.push(buf);
    this.#flush();
  }

  #flush() {
    if (this.#draining) return;
    while (this.#queue.length) {
      const buf = this.#queue.shift();
      if (!this.#socket.writable) break;
      try {
        if (!this.#socket.write(buf)) {
          this.#draining = true;
          this.#socket.once('drain', () => {
            this.#draining = false;
            this.#flush();
          });
          return;
        }
      } catch {
        this.#onClose(1006, 'write failed');
        return;
      }
    }
  }

  /** Send a text or binary message. Binary input must be Uint8Array/Buffer. */
  send(data, { binary = false } = {}) {
    if (!this.#open) return false;
    if (binary) {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
      this.#send(payload, OP_BINARY);
    } else {
      this.#send(Buffer.from(String(data), 'utf8'), OP_TEXT);
    }
    return true;
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  /** Wait until the kernel send buffer is drained. */
  flush() {
    if (!this.#draining && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#socket.once('drain', resolve));
  }

  ping(payload = Buffer.alloc(0)) {
    this.#send(payload, OP_PING);
  }

  close(code = 1000, reason = '') {
    if (!this.#open) {
      try {
        this.#socket.end();
      } catch {
        /* ignore */
      }
      return;
    }
    this.#open = false;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.#send(payload, OP_CLOSE);
    this.#socket.end();
    this.emit('close', code, reason);
  }
}

/**
 * Attach a WebSocket handler to an http.Server.
 * `onConnection(conn, req)` is invoked for every accepted upgrade.
 */
export function attachWebSocket(server, onConnection, { path = '/ws' } = {}) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    const protocol = selectProtocol(req);
    if (protocol) headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    if (head && head.length) socket.unshift(head);

    const conn = new WsConnection(socket);
    conn.protocol = protocol;
    conn.url = url;
    onConnection(conn, req);
  });
}

function selectProtocol(req) {
  const offered = req.headers['sec-websocket-protocol'];
  if (!offered) return null;
  const list = String(offered).split(',').map((s) => s.trim());
  for (const candidate of ['webcm-agent.v1']) {
    if (list.includes(candidate)) return candidate;
  }
  return list[0] || null;
}

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}
