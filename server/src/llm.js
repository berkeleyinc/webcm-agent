// OpenAI-compatible chat client for the agent brain.

import { config } from './config.js';

export class LlmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function llmAvailable() {
  return Boolean(config.llm.baseUrl);
}

export function llmLabel() {
  return config.llm.model;
}

/**
 * One chat completion.
 * @param {{messages: Array<{role:string,content:any}>, tools?: any[], maxTokens?: number, temperature?: number, timeoutMs?: number}} opts
 */
export async function chat({ messages, tools, maxTokens, temperature, timeoutMs }) {
  if (!llmAvailable()) throw new LlmError('no LLM configured (set LLM_BASE_URL)');
  const url = `${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.llm.model,
    messages,
    max_tokens: maxTokens ?? config.llm.maxTokens,
    temperature: temperature ?? config.llm.temperature,
    stream: false,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.llm.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new LlmError(`LLM request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`LLM returned ${res.status}`, res.status, text.slice(0, 2000));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new LlmError(`LLM returned invalid JSON: ${err.message}`, res.status, text.slice(0, 500));
  }
  const choice = data.choices && data.choices[0];
  if (!choice) throw new LlmError('LLM returned no choices', res.status, text.slice(0, 500));
  const message = choice.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : normalizeContent(message.content),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finishReason: choice.finish_reason,
    usage: data.usage || null,
    raw: message,
  };
}

function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
  }
  return content == null ? '' : String(content);
}
