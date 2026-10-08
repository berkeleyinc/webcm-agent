#!/usr/bin/env node
// Entry point: loads .env, configures logging, verifies artifacts, starts HTTP + WS.

import { loadDotEnv } from './src/dotenv.js';

// Has to run before config.js is imported: config reads process.env at module
// evaluation time. Docker compose normally supplies the env directly; this makes
// `node server/launcher.js` behave the same outside a container.
const dotenv = loadDotEnv();

const { config, describeConfig } = await import('./src/config.js');
const { createApp } = await import('./src/http.js');
const { probeArtifacts } = await import('./src/artifacts.js');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const log = {
  error: (...a) => threshold >= LEVELS.error && console.error('[error]', ...a),
  warn: (...a) => threshold >= LEVELS.warn && console.warn('[warn]', ...a),
  info: (...a) => threshold >= LEVELS.info && console.log('[info]', ...a),
  debug: (...a) => threshold >= LEVELS.debug && console.log('[debug]', ...a),
};

async function main() {
  if (dotenv.loaded) log.debug(`loaded ${dotenv.loaded} value(s) from ${dotenv.path}`);
  const artifacts = probeArtifacts();
  if (!artifacts.ready) {
    log.warn(`VM artifacts not found in ${artifacts.dir}`);
    log.warn('the UI will still load, but sessions cannot boot until you run `make wasm`');
  } else {
    log.info(`VM artifacts: webcm.mjs ${(artifacts.files['webcm.mjs'] / 1024).toFixed(0)}KiB, webcm.wasm ${(artifacts.files['webcm.wasm'] / 1048576).toFixed(1)}MiB`);
  }

  const app = createApp({ log });
  const addr = await app.listen();
  log.info(`webcm-agent listening on http://${config.host}:${addr.port}`);
  log.info(`config: ${JSON.stringify(describeConfig())}`);

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } catch (err) {
      log.error(`shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err && err.stack}`));
}

main().catch((err) => {
  console.error('[fatal]', err && err.stack);
  process.exit(1);
});
