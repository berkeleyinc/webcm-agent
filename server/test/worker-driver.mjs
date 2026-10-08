// Worker driver: boots the VM in a worker, runs a few commands, powers off.
// Useful for isolating VM/pty behaviour from the HTTP layer.

import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

const url = new URL('../src/vm-worker.js', import.meta.url);
const w = new Worker(url, {
  workerData: {
    mjsPath: resolve('server/agent/webcm.mjs'),
    wasmPath: resolve('server/agent/webcm.wasm'),
    cols: 100,
    rows: 30,
  },
});

let out = '';
let t0 = 0;
w.on('message', (m) => {
  switch (m.t) {
    case 'out':
      out += Buffer.from(m.data).toString('utf8');
      break;
    case 'ready':
      t0 = Date.now();
      console.log(`[ready] after ${Date.now() - bootStart}ms`);
      w.postMessage({ t: 'in', data: Buffer.from('echo HELLO_WORKER; id -u\n').buffer });
      break;
    case 'closed':
      console.log(`[closed] reason=${m.reason}`);
      break;
    case 'state':
      console.log(`[state] ${m.state}${m.detail ? ` (${m.detail})` : ''}`);
      break;
    case 'cycles':
      console.log(`[cycles] ${m.cycles}`);
      break;
    case 'log':
      console.log(`[log] ${m.message}`);
      break;
    default:
      break;
  }
});
w.on('error', (e) => console.log('[worker error]', e && e.stack));
w.on('exit', (c) => console.log('[worker exit]', c));

const bootStart = Date.now();
setTimeout(() => {
  const clean = out.replace(/\r/g, '');
  console.log(`[check] hello=${/HELLO_WORKER\n/.test(clean)} uid0=${/\n0\n/.test(clean)} motd=${/Alpine/.test(clean)}`);
  console.log(`[check] command latency ~${Date.now() - t0 - 3100}ms`);
  w.postMessage({ t: 'stop' });
}, 12000);
setTimeout(() => process.exit(0), 30000);
