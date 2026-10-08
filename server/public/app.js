// webcm-agent browser client: xterm terminal + WebSocket to the server-side VM,
// browser network bridge (fallback), and the agent console.
//
// Modes:
//   server (default)  the VM runs in a server worker; we stream its tty over ws
//   local (?local=1)  the same webcm.wasm is loaded in this tab (no bridge)

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const LOCAL_MODE = params.get('local') === '1';
const NET_VERBOSE = params.get('netlog') === '1';

const state = {
  cfg: null,
  sessionId: null,
  wsToken: null,
  ws: null,
  term: null,
  fit: null,
  running: false,
  runId: null,
  feed: [],           // newest first
  activity: [],       // newest first
  startedAt: 0,
  reconnectDelay: 500,
  local: { master: null, slave: null },
};

// ------------------------------------------------------------------ startup

async function boot() {
  const cfgRes = await fetch('/api/config');
  state.cfg = await cfgRes.json();
  state.sessionId = state.cfg.sessionId;
  state.wsToken = state.cfg.wsToken;
  state.startedAt = Date.now();

  buildTerminal();
  renderMachinePanel();
  renderDemos(state.cfg.demoCommands || []);

  wireChrome();

  if (LOCAL_MODE) await bootLocal();
  else connect();
}

function buildTerminal() {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13.5,
    cursorBlink: true,
    scrollback: 8000,
    theme: {
      background: '#08090d',
      foreground: '#e2e6ee',
      cursor: '#7aa2f7',
      cursorAccent: '#08090d',
      selectionBackground: '#2b3550',
    },
    allowProposedApi: true,
  });
  term.open($('#terminal'));
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  fit.fit();
  state.term = term;
  state.fit = fit;

  new ResizeObserver(() => {
    fit.fit();
    updateTermMeta();
    if (state.ws?.readyState === WebSocket.OPEN) {
      send({ t: 'resize', cols: term.cols, rows: term.rows });
    }
  }).observe($('#terminal'));
  updateTermMeta();

  term.onData((data) => {
    if (state.running) hideHint();
    send({ t: 'in', data });
  });
  term.onBinary((data) => send({ t: 'in', data: btoa(data), binary: true }));
}

function updateTermMeta() {
  const t = state.term;
  if (!t) return;
  const up = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  $('#term-meta').textContent = `${t.cols}×${t.rows}  ·  up ${fmtDuration(up)}`;
}

function hideHint() {
  const h = $('#hint');
  if (h) h.style.opacity = '0';
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

// --------------------------------------------------------------- server mode

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(state.sessionId)}` +
    `&token=${encodeURIComponent(state.wsToken)}&cols=${state.term.cols}&rows=${state.term.rows}`;
  const ws = new WebSocket(url, 'webcm-agent.v1');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => { state.reconnectDelay = 500; setState('connecting'); };
  ws.onerror = () => setState('error', 'socket error');
  ws.onclose = (ev) => {
    if (ev.code === 4001 || ev.code === 4003) {
      setState('error', 'session rejected');
      setTimeout(() => fetch('/api/session/reset', { method: 'POST' }).then(() => location.reload()), 1200);
      return;
    }
    setState('error', 'disconnected');
    setTimeout(connect, (state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000)));
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      state.term.write(new Uint8Array(ev.data));
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      setState(msg.state === 'ready' ? 'ready' : msg.state);
      $('#pill-uptime').hidden = false;
      break;
    case 'history':
      state.term.write(msg.data);
      break;
    case 'state':
      setState(msg.state);
      $('#btn-restart').disabled = !['ready', 'busy'].includes(msg.state);
      break;
    case 'ready':
      setState('ready');
      $('#btn-restart').disabled = false;
      hideHint();
      break;
    case 'note':
      toast(msg.message, msg.level === 'error' ? 'error' : 'info');
      break;
    case 'closed':
      state.term.write(`\r\n\x1b[33m[session closed: ${msg.reason}]\x1b[0m\r\n`);
      setState('suspended', msg.reason);
      break;
    case 'instance':
      if (msg.state === 'stopped') state.term.write(`\r\n\x1b[33m[vm stopped: ${msg.reason}]\x1b[0m\r\n`);
      break;
    case 'history-entry':
      pushActivity({ kind: 'cmd', text: msg.entry.command, exitCode: msg.entry.exitCode, at: msg.entry.at });
      break;
    case 'agent':
      handleAgentEvent(msg);
      break;
    case 'http.request':
      handleBridgeRequest(msg);
      break;
    case 'error':
      toast(msg.message, 'error');
      state.term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- local mode

async function bootLocal() {
  $('#hint').textContent = 'local mode — the VM runs in this tab';
  setState('booting', 'local');
  $('#btn-agent').disabled = true;
  await loadScriptOnce('/vendor/xterm-pty.js');
  const { master, slave } = openpty();
  state.local = { master, slave };
  state.term.loadAddon(master);
  state.term.focus();

  const mod = await import('/agent/webcm.mjs');
  setTimeout(() => setState('ready'), 12000);
  await (mod.default || mod)({ pty: slave });
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

// -------------------------------------------------------------- net fallback

const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding', 'user-agent']);

async function handleBridgeRequest(msg) {
  const started = performance.now();
  try {
    const headers = new Headers();
    for (const [k, v] of msg.headers || []) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    const init = { method: msg.method || 'GET', headers, redirect: 'follow' };
    if (msg.bodyB64) init.body = Uint8Array.from(atob(msg.bodyB64), (c) => c.charCodeAt(0));
    const res = await fetch(msg.url, init);
    const buf = new Uint8Array(await res.arrayBuffer());
    const outHeaders = [];
    res.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.push([k, v]); });
    if (!outHeaders.some(([k]) => k.toLowerCase() === 'content-type')) outHeaders.push(['content-type', 'application/octet-stream']);
    send({ t: 'http.response', id: msg.id, status: res.status, headers: outHeaders, bodyB64: buf.length ? bytesToB64(buf) : '' });
    if (NET_VERBOSE) pushActivity({ kind: 'net', text: `${msg.method} ${shortUrl(msg.url)} → ${res.status} (${buf.length}B, ${Math.round(performance.now() - started)}ms)` });
  } catch (err) {
    send({ t: 'http.error', id: msg.id, message: String(err && err.message) });
    pushActivity({ kind: 'net', text: `${msg.method} ${shortUrl(msg.url)} → error: ${err && err.message}` });
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 72);
  } catch { return String(url).slice(0, 72); }
}

// --------------------------------------------------------------- agent feed

function handleAgentEvent(msg) {
  switch (msg.event) {
    case 'start':
      state.runId = msg.run;
      state.running = true;
      state.feed = [];
      $('#timeline').innerHTML = '';
      $('#btn-run').disabled = true;
      $('#btn-stop').disabled = false;
      setState('busy');
      $('#run-head').hidden = false;
      $('#run-goal').textContent = msg.goal;
      $('#run-steps').textContent = `0/${state.cfg.maxSteps || '?'}`;
      addFeed('start', `model ${msg.model}`);
      break;
    case 'step':
      $('#run-steps').textContent = `${msg.step}/${msg.max}`;
      break;
    case 'message':
      addFeed('message', msg.text);
      break;
    case 'tool':
      addFeed('tool', `${msg.call}${describeArgs(msg.args)}`);
      break;
    case 'command':
      addFeed('command', `$ ${msg.command}`);
      break;
    case 'result':
      addFeed('result', String(msg.output || '').trim() || '(no output)');
      break;
    case 'finish':
      addFeed('finish', msg.summary || '(no summary)', `after ${msg.steps} steps`);
      finishRun();
      toast('agent finished', 'success');
      break;
    case 'error':
      addFeed('error', msg.message);
      finishRun();
      break;
    default:
      break;
  }
}

function finishRun() {
  state.running = false;
  state.runId = null;
  $('#btn-run').disabled = false;
  $('#btn-stop').disabled = true;
  setState('ready');
}

function addFeed(kind, text, meta) {
  const list = $('#timeline');
  $('#timeline-empty').hidden = true;
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.kind = kind;

  const k = document.createElement('div');
  k.className = 'k';
  const label = document.createElement('span');
  label.textContent = kind;
  k.appendChild(label);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = meta || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  k.appendChild(time);
  li.appendChild(k);

  const pre = document.createElement('pre');
  pre.textContent = text;
  if (text && text.split('\n').length > 4) pre.classList.add('clamp');
  pre.onclick = () => pre.classList.toggle('clamp');
  li.appendChild(pre);

  // newest first: prepend
  list.insertBefore(li, list.firstChild);
}

function describeArgs(args) {
  if (!args) return '';
  const s = Object.entries(args).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 80)}`).join('  ');
  return s ? `(${s})` : '';
}

async function runAgent() {
  const goal = $('#goal').value.trim();
  if (!goal || state.running) return;
  state.feed = [];
  $('#timeline').innerHTML = '';
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, maxSteps: 60 }),
  });
  const data = await res.json();
  if (data.error) {
    addFeed('error', data.error);
    return;
  }
  state.runId = data.runId;
  $('#goal').value = '';
}

async function stopAgent() {
  if (!state.runId) return;
  await fetch(`/api/agent/${state.runId}/cancel`, { method: 'POST' });
  addFeed('error', 'stop requested');
}

// --------------------------------------------------------------- activity tab

function pushActivity(entry) {
  entry.at = entry.at || Date.now();
  state.activity.unshift(entry);
  if (state.activity.length > 300) state.activity.pop();
  renderActivity();
}

function renderActivity() {
  const list = $('#history-list');
  const showNet = $('#show-net').checked;
  const rows = state.activity.filter((a) => showNet || a.kind !== 'net').slice(0, 120);
  list.innerHTML = '';
  for (const a of rows) {
    const li = document.createElement('li');
    li.className = 'item' + (a.kind === 'net' ? '' : ' clickable');
    li.dataset.kind = a.kind === 'net' ? 'net' : 'command';
    const k = document.createElement('div');
    k.className = 'k';
    k.innerHTML = `<span>${a.kind === 'net' ? 'net' : 'cmd'}</span>`;
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    k.appendChild(t);
    li.appendChild(k);
    const pre = document.createElement('pre');
    pre.textContent = a.kind === 'net' ? a.text : `$ ${a.text}${a.exitCode != null ? `   → exit ${a.exitCode}` : ''}`;
    li.appendChild(pre);
    if (a.kind !== 'net') li.onclick = () => type(a.text + '\n');
    list.appendChild(li);
  }
  $('#hist-count').textContent = rows.length ? String(rows.length) : '';
}

// ------------------------------------------------------------------- chrome

function wireChrome() {
  $('#btn-agent').onclick = () => togglePanel($('#panel').hidden);
  $('#btn-close-panel').onclick = () => togglePanel(false);
  $('#btn-run').onclick = runAgent;
  $('#btn-stop').onclick = stopAgent;

  const reboot = async () => {
    toast('rebooting the VM…');
    setState('booting', 'reboot');
    await fetch('/api/session/restart', { method: 'POST' });
  };
  const reset = async () => {
    await fetch('/api/session/reset', { method: 'POST' });
    location.reload();
  };
  $('#btn-restart').onclick = reboot;
  $('#btn-reset').onclick = reset;

  const closeMenu = () => { $('#menu').hidden = true; };
  $('#btn-more').onclick = (e) => {
    e.stopPropagation();
    $('#menu').hidden = !$('#menu').hidden;
  };
  $('#menu').onclick = (e) => {
    e.stopPropagation();          // keep the doc handler from racing the action
    const act = e.target.closest('[data-act]')?.dataset.act;
    closeMenu();
    if (act === 'copy') copyScreen();
    if (act === 'reset') reset();
    if (act === 'restart') reboot();
    if (act === 'help') $('#help').showModal();
  };
  // Any click elsewhere, any scroll, or Escape closes it.
  document.addEventListener('click', closeMenu);
  window.addEventListener('blur', closeMenu);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const pane of document.querySelectorAll('.tab-body')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
      if (tab.dataset.tab === 'activity') renderActivity();
    };
  }

  $('#show-net').onchange = renderActivity;
  $('#btn-clear-activity').onclick = () => { state.activity = []; renderActivity(); };
  $('#btn-replay-all').onclick = () => {
    for (const c of (state.cfg.recipes || state.cfg.demoCommands || [])) type(c + '\n');
  };

  $('#goal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runAgent(); }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPanel('agent'); $('#goal').focus(); }
    else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); togglePanel($('#panel').hidden); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); runAgent(); }
    else if (e.key === 'Escape') { closeMenu(); state.term.focus(); }
  });

  setInterval(updateTermMeta, 1000);
}

function togglePanel(open) {
  const panel = $('#panel');
  panel.hidden = !open;
  $('#btn-agent').setAttribute('aria-pressed', String(open));
  requestAnimationFrame(() => { state.fit.fit(); updateTermMeta(); });
}

function openPanel(tabName) {
  togglePanel(true);
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.click();
}

function type(text) {
  send({ t: 'in', data: text });
  state.term.focus();
}

async function copyScreen() {
  const text = state.term.buffer.active.getLine(0) ? screenText() : '';
  try {
    await navigator.clipboard.writeText(text);
    toast('screen copied', 'success');
  } catch {
    toast('clipboard unavailable');
  }
}

function screenText() {
  const buf = state.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}

// -------------------------------------------------------------------- bits

function setState(kind, detail) {
  const pill = $('#pill-state');
  pill.dataset.state = kind;
  $('#pill-text').textContent = detail ? `${kind} — ${detail}` : kind;
}

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.level = level;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 6000 : 3200);
}

function renderMachinePanel() {
  const limits = state.cfg.limits || {};
  const rows = [
    ['session', state.sessionId],
    ['machine', 'RISC-V RV64GC · Cartesi emulator · Alpine Linux'],
    ['mode', LOCAL_MODE ? 'local (in-browser VM)' : 'server-side'],
    ['agent model', state.cfg.llm?.available ? state.cfg.llm.model : 'not configured'],
    ['vm lifetime', limits.maxWallMs ? `${Math.round(limits.maxWallMs / 60000)} min active` : 'unlimited'],
    ['concurrent VMs', limits.slots ?? '—'],
    ['network budget', limits.maxBridgeBytes ? `${Math.round(limits.maxBridgeBytes / 1048576)} MiB` : 'unlimited'],
  ];
  const kv = $('#info-list');
  kv.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    kv.append(dt, dd);
  }
  const tries = $('#try-list');
  tries.innerHTML = '';
  for (const cmd of state.cfg.demoCommands || []) {
    const b = document.createElement('button');
    b.textContent = cmd;
    b.onclick = () => type(cmd + '\n');
    tries.appendChild(b);
  }
  const recipes = $('#recipe-list');
  recipes.innerHTML = '';
  for (const cmd of (state.cfg.recipes || []).slice(-8)) {
    const b = document.createElement('button');
    b.textContent = cmd.length > 64 ? `${cmd.slice(0, 62)}…` : cmd;
    b.onclick = () => type(cmd + '\n');
    recipes.appendChild(b);
  }
  if (!recipes.children.length) recipes.innerHTML = '<button disabled>none yet</button>';
}

function renderDemos(cmds) {
  const box = $('#demos');
  box.innerHTML = '';
  for (const cmd of cmds.slice(0, 4)) {
    const b = document.createElement('button');
    b.textContent = cmd;
    b.onclick = () => type(cmd + '\n');
    box.appendChild(b);
  }
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

boot().catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f7768e;padding:12px">boot failed: ${err.message}</pre>`);
});
