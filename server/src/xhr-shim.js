// XMLHttpRequest shim.
//
// In the browser the Cartesi emulator's HTTP support (`-sFETCH`) performs guest
// requests with `XMLHttpRequest`. Under Node there is no XHR, so the guest's
// `https-proxy` dies at the first soft yield with "XMLHttpRequest is not
// defined". This shim maps the small XHR surface emscripten actually uses onto
// an async `request()` callback.
//
// Only the subset emscripten's fetchXHR() touches is implemented; anything else
// (sync XHR, progress streaming, cookies) is deliberately absent.

export function installXhrShim(scope, request) {
  if (scope.XMLHttpRequest) return;

  class XMLHttpRequestShim {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = null;
      this.responseURL = '';
      this.responseType = '';
      this.responseText = '';
      this.timeout = 0;
      this.withCredentials = false;
      // emscripten reads/writes this to decide whether to stream chunks.
      this._streamData = false;

      this.onload = null;
      this.onerror = null;
      this.ontimeout = null;
      this.onprogress = null;
      this.onreadystatechange = null;

      this._headers = [];
      this._method = 'GET';
      this._url = '';
      this._responseHeaders = '';
      this._aborted = false;
      this._timer = null;
    }

    open(method, url) {
      this._method = String(method || 'GET').toUpperCase();
      this._url = String(url);
      this.#setReadyState(1);
    }

    setRequestHeader(name, value) {
      this._headers.push([String(name), String(value)]);
    }

    overrideMimeType() {
      /* responseType is always arraybuffer here */
    }

    getResponseHeader(name) {
      const want = String(name).toLowerCase();
      for (const [k, v] of this._responseHeaderList || []) {
        if (k.toLowerCase() === want) return v;
      }
      return null;
    }

    getAllResponseHeaders() {
      return this._responseHeaders;
    }

    abort() {
      this._aborted = true;
      clearTimeout(this._timer);
    }

    send(body) {
      const debug = !!process.env.XHR_DEBUG;
      // The body points into the wasm heap; copy before going async.
      let payload = null;
      if (body && body.byteLength) {
        payload = new Uint8Array(body.byteLength);
        payload.set(body);
      }

      if (this.timeout > 0) {
        this._timer = setTimeout(() => {
          this._aborted = true;
          this.ontimeout?.({});
          this.onerror?.({});
        }, this.timeout);
      }

      if (debug) console.error(`[xhr] send ${this._method} ${this._url} body=${payload ? payload.length : 0}`);
      request({ url: this._url, method: this._method, headers: this._headers, body: payload })
        .then((res) => {
          if (debug) console.error(`[xhr] got ${res.status} ${res.url} bytes=${res.body ? res.body.length : 0} abort=${this._aborted} has=${{}}`);
          if (this._aborted) return;
          clearTimeout(this._timer);
          this.status = res.status;
          this.statusText = res.statusText || '';
          this.responseURL = res.url || this._url;
          this._responseHeaderList = res.headers || [];
          this._responseHeaders = this._responseHeaderList.map(([k, v]) => `${k}: ${v}`).join('\r\n');
          this.#setReadyState(2);
          this.#setReadyState(3);
          // `response` must be an exact-length ArrayBuffer: emscripten reads it
          // as `new Uint8Array(xhr.response)` and writes it into its heap.
          const bytes = res.body && res.body.byteLength ? Uint8Array.from(res.body) : new Uint8Array(0);
          if (debug) console.error(`[xhr] body bytes=${bytes.byteLength}`);
          this.response = bytes.buffer;
          this.#setReadyState(4);
          this.onprogress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
          // emscripten routes non-2xx to onerror itself, so onload is always the
          // response notification; onerror is reserved for transport failures.
          if (debug) console.error('[xhr] dispatching onload');
          this.onload?.({});
        })
        .catch((err) => {
          if (this._aborted) return;
          clearTimeout(this._timer);
          this.status = 0;
          this.statusText = String(err && err.message) || 'error';
          this.#setReadyState(4);
          this.onerror?.({ message: this.statusText });
        });
    }

    #setReadyState(state) {
      this.readyState = state;
      this.onreadystatechange?.({});
    }
  }

  scope.XMLHttpRequest = XMLHttpRequestShim;
}
