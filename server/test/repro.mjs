// Focused session-level reproduction: boot a VM, exec a command, inspect result.
process.env.DATA_DIR = `/tmp/wag-repro-${Date.now()}`;
process.env.PORT = '0';
process.env.LOG_LEVEL = 'info';
process.env.AGENT_DIR = process.env.AGENT_DIR || 'server/agent';
process.env.PUBLIC_DIR = process.env.PUBLIC_DIR || 'server/public';
const log = { error: (...a) => console.error('[error]', ...a), warn: (...a) => console.warn('[warn]', ...a), info: (...a) => console.log('[info]', ...a), debug: () => {} };

const { createApp } = await import('../src/http.js');
const app = createApp({ log });
await app.listen();
const session = app.manager.create({ cols: 110, rows: 30 });

const t0 = Date.now();
await session.ensureRunning();
console.log(`boot: ${Date.now() - t0}ms state=${session.state}`);

for (const cmd of ['echo REPRO_$((3*7))', 'id -un', 'cd /root && pwd', 'test -f /etc/profile.d/zz-agent.sh && echo profile-present || echo profile-MISSING']) {
  const started = Date.now();
  try {
    const res = await session.exec(cmd, { timeoutMs: 25000, quietMs: 400 });
    console.log(`exec(${JSON.stringify(cmd)}) -> ${Date.now() - started}ms exit=${res.exitCode} out=${JSON.stringify(res.output)}`);
  } catch (err) {
    console.log(`exec(${JSON.stringify(cmd)}) FAILED ${Date.now() - started}ms: ${err.message} partial=${JSON.stringify(err.partial)}`);
    break;
  }
}
const t2 = Date.now();
await session.suspend('done');
console.log(`suspend: ${Date.now() - t2}ms`);
await app.close();
process.exit(0);
