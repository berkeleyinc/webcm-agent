// Agent-only driver: boots a session and lets the real LLM drive the VM.
// Prints every agent event as it happens.
//
//   node server/test/agent-only.mjs "goal text"

process.env.AGENT_DIR = process.env.AGENT_DIR || 'server/agent';
process.env.PUBLIC_DIR = process.env.PUBLIC_DIR || 'server/public';
process.env.DATA_DIR = `/tmp/wag-agent-${Date.now()}`;
process.env.PORT = '0';
process.env.LOG_LEVEL = 'warn';

const goal = process.argv[2] || 'Create /root/workspace/hello.sh that prints "agent ok", chmod +x it, run it, then finish.';
const { createApp } = await import('../src/http.js');
const { AgentRun } = await import('../src/agent.js');
const { llmLabel } = await import('../src/llm.js');

const app = createApp({ log: { error: (...a) => console.error('[error]', ...a), warn: () => {}, info: () => {}, debug: () => {} } });
await app.listen();
const session = app.manager.create({ cols: 100, rows: 30 });

console.log(`model: ${llmLabel()}`);
console.log(`goal:  ${goal}\n`);

const run = new AgentRun(session, goal, { maxSteps: 14 });
const t0 = Date.now();
run.onEventSent = true;
const originalEmit = run.emit.bind(run);
run.emit = (event, payload = {}) => {
  const rec = originalEmit(event, payload);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (event === 'command') console.log(`[${dt}s] $ ${payload.command}`);
  else if (event === 'tool') console.log(`[${dt}s] -> ${payload.call}`);
  else if (event === 'message') console.log(`[${dt}s] # ${payload.text.slice(0, 200)}`);
  else if (event === 'result') console.log(`[${dt}s]    ${JSON.stringify(String(payload.output).slice(0, 300))}`);
  else if (event === 'finish') console.log(`[${dt}s] FINISH: ${payload.summary}`);
  else if (event === 'error') console.log(`[${dt}s] ERROR: ${payload.message}`);
  return rec;
};

try {
  const result = await run.run();
  console.log(`\nresult: ${JSON.stringify(result)}`);
  const verify = await session.exec('ls -l /root/workspace');
  console.log(`verify:\n${verify.output}`);
} catch (err) {
  console.log(`agent failed: ${err.message}`);
}
await app.close();
process.exit(0);
