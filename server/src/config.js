// Runtime configuration, all overridable through the environment.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: num('PORT', 8080),
  publicDir: str('PUBLIC_DIR', 'public'),

  /** Directory holding webcm.wasm / webcm.mjs. */
  agentDir: str('AGENT_DIR', 'agent'),

  /** Where per-user sessions are persisted. */
  dataDir: str('DATA_DIR', 'data'),

  session: {
    /** Wall-clock milliseconds a session may stay alive while actively used. */
    maxWallMs: num('SESSION_MAX_WALL_MS', 30 * 60 * 1000),
    /** Instruction (machine cycle) budget per session. */
    maxCycles: num('SESSION_MAX_CYCLES', 0), // 0 = unlimited
    /** Close sessions idle for this long (no client, no agent activity). */
    idleMs: num('SESSION_IDLE_MS', 10 * 60 * 1000),
    /** Nobody connected and no bridge active for this long -> stop the VM. */
    detachMs: num('SESSION_DETACH_MS', 60 * 1000),
    /** Max concurrently running VMs on this host. */
    maxRunning: num('SESSION_MAX_RUNNING', 8),
    /** Wasm memory limit per VM in MiB (matches TOTAL_MEMORY in the build). */
    memoryMiB: num('SESSION_MEMORY_MIB', 1536),
  },

  quota: {
    /** Per-session network bytes allowed through the browser bridge. */
    maxBridgeBytes: num('QUOTA_MAX_BRIDGE_BYTES', 512 * 1024 * 1024),
    maxRequestBytes: num('QUOTA_MAX_REQUEST_BYTES', 64 * 1024 * 1024),
  },

  bridge: {
    timeoutMs: num('BRIDGE_TIMEOUT_MS', 120000),
    maxRedirects: num('BRIDGE_MAX_REDIRECTS', 5),
    userAgent: str('BRIDGE_USER_AGENT', 'webcm-agent/1.0 (+server-side browser bridge)'),
  },

  agent: {
    enabled: bool('AGENT_ENABLED', true),
    /** Shell poll interval while waiting for the guest prompt. */
    pollMs: num('AGENT_POLL_MS', 250),
    /** How long a single command may run before the agent intervenes. */
    commandTimeoutMs: num('AGENT_COMMAND_TIMEOUT_MS', 180000),
    /** Idle time (no output) before the agent considers a command finished. */
    quietMs: num('AGENT_QUIET_MS', 3000),
    maxSteps: num('AGENT_MAX_STEPS', 200),
  },

  llm: {
    // Keep in sync with .env.example; docker compose supplies these from .env.
    baseUrl: str('LLM_BASE_URL', str('OPENAI_BASE_URL', '')),
    apiKey: str('LLM_API_KEY', str('OPENAI_API_KEY', '')),
    model: str('LLM_MODEL', 'deepseek-ai/DeepSeek-V4.1-Dealigned'),
    /** Model context window (tokens); transcript is trimmed to fit. */
    contextWindow: num('LLM_CONTEXT_WINDOW', 1048576),
    maxTokens: num('LLM_MAX_TOKENS', 4096),
    temperature: num('LLM_TEMPERATURE', 0.2),
    timeoutMs: num('LLM_TIMEOUT_MS', 120000),
  },

  /** Serve webcm.mjs/webcm.wasm to browsers so the VM can also run client-side. */
  serveWasm: bool('SERVE_WASM', true),

  logLevel: str('LOG_LEVEL', 'info'),
};

export function describeConfig() {
  return {
    ...config,
    llm: { ...config.llm, apiKey: config.llm.apiKey ? '***' : '' },
  };
}
