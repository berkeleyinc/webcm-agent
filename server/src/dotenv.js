// Minimal .env loader — no dependency, ~30 lines.
//
// Docker compose injects the environment itself; this exists so running the
// server straight from source (`make dev`, `node server/launcher.js`) picks up
// the same git-ignored .env. Real environment variables always win, so a
// container, a CI runner or `FOO=1 node …` can override the file.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(file = '.env', { cwd = process.cwd() } = {}) {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { path, loaded: 0 };

  let loaded = 0;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real env wins

    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, then unescape the usuals.
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    process.env[key] = value;
    loaded++;
  }
  return { path, loaded };
}
