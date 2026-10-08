// Browser network bridge.
//
// The guest VM reaches the outside world through the in-guest https-proxy, which
// performs a "soft yield" that our patched webcm binary answers by asking the
// host to perform an HTTP request. The upstream build performs that request with
// the browser Fetch API; here we forward the request over a WebSocket to the
// browser, so requests inherit the user's network (cookies, corporate proxy,
// localhost endpoints) instead of the server's.
//
// The whole path is a single async call:
//
//   guest cur/https-proxy -> soft yield -> server #performFetch()
//     -> WS {t:'http.request'} -> browser fetch() -> WS {t:'http.response'} -> guest

import { config } from './config.js';

let seq = 0;

export class BridgeClosed extends Error {}

export class Bridge {
  /** @param {import('./session.js').Session} session */
  constructor(session) {
    this.session = session;
    this.bytes = { sent: 0, received: 0 };
    this.pending = new Map();
    this.redirects = config.bridge.maxRedirects;
    this.closed = false;
  }

  get active() {
    return this.pending.size > 0;
  }

  /** Attached browser that can perform fetches for the guest, if any. */
  get client() {
    const client = this.session.bridgeClient;
    return client && client.conn.isOpen ? client : null;
  }

  get available() {
    return !this.closed && this.client !== null;
  }

  /** Called with the WS payload of type `http.response`. */
  settle(id, payload) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(payload);
  }

  /** Called with the WS payload of type `http.error`. */
  fail(id, message) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(message || 'bridge fetch failed'));
  }

  clientGone() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeClosed('client disconnected'));
    }
    this.pending.clear();
  }

  reset() {
    this.clientGone();
    this.closed = false;
  }

  /**
   * Perform one HTTP request on behalf of the guest.
   * @returns {Promise<{status:number, headers:[string,string][], body:Buffer}>}
   */
  async performFetch({ url, method, headers, body }) {
    const client = this.client;
    if (!client) throw new BridgeClosed('no browser attached to this session');

    const id = `r${++seq}`;
    const payload = {
      t: 'http.request',
      id,
      url,
      method: method || 'GET',
      headers: withUserAgent(headers),
    };
    if (body && body.length) payload.bodyB64 = Buffer.from(body).toString('base64');

    this.bytes.sent += payload.bodyB64 ? Math.floor(payload.bodyB64.length * 0.75) : 0;

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge timeout after ${config.bridge.timeoutMs}ms: ${url}`));
      }, config.bridge.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        client.conn.sendJson(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });

    const outHeaders = Array.isArray(response.headers) ? response.headers : [];
    const buf = response.bodyB64 ? Buffer.from(response.bodyB64, 'base64') : Buffer.alloc(0);
    this.bytes.received += buf.length;

    if (this.session.overBridgeQuota(this.bytes)) {
      throw new Error('session network quota exceeded');
    }
    return { status: response.status ?? 0, headers: outHeaders, body: buf };
  }
}

function withUserAgent(headers) {
  const list = Array.isArray(headers) ? headers.slice() : [];
  if (!list.some(([k]) => k.toLowerCase() === 'user-agent')) {
    list.push(['user-agent', config.bridge.userAgent]);
  }
  return list;
}
