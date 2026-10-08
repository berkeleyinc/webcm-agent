// Artifact presence probe so the UI can tell users what is missing.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

export function probeArtifacts() {
  const dir = resolve(config.agentDir);
  const files = ['webcm.mjs', 'webcm.wasm'];
  const found = {};
  for (const name of files) {
    const path = resolve(dir, name);
    const ok = existsSync(path);
    found[name] = ok ? statSync(path).size : 0;
  }
  return {
    dir,
    files: found,
    ready: files.every((f) => found[f] > 0),
    get totalBytes() {
      return Object.values(found).reduce((a, b) => a + b, 0);
    },
  };
}
