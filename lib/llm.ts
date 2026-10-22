const axios = require("axios");
const https = require("https");
const log = require("./log");
const db = require("./db");
const crypto = require("crypto");
import type { ProviderTier } from "./types";

interface ChatMessage {
  role: string;
  content: unknown;
}
interface Usage {
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}
interface Telemetry {
  operation?: string;
  provider?: string | null;
  programId?: string | null;
  channel?: string | null;
  requestId?: string;
}
interface CompletionOptions {
  baseUrl: string;
  apiKey: string | (() => string | undefined);
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  thinking?: unknown;
  /** Reasoning budget, sent separately from max_tokens. Providers that reason
   *  before answering need both: a budget big enough to reason in, and a
   *  separate ceiling on the visible answer. */
  reasoningEffort?: "max" | "high" | "low";
  includeReasoning?: boolean;
  timeout?: number;
  fallback?: ProviderTier | null;
  telemetry?: Telemetry;
  onRateLimited?: (key: string | undefined, ms?: number) => void;
  deadlineAt?: number;
  fallbackAttempt?: boolean;
}
interface LlmError extends Error {
  response?: { status?: number };
  usedKey?: string;
  code?: string;
  cause?: { code?: string };
}
interface CompletionResult {
  text: string;
  finishReason?: string;
  usedKey?: string;
  usage?: Usage;
  stopped?: boolean;
  attempt?: number;
  retryCount?: number;
  latencyMs?: number;
}
interface ResultMeta extends Partial<CompletionResult> {
  status?: string;
  httpStatus?: number;
  errorKind?: string;
  eventId?: string;
}
interface Price {
  input: number;
  output: number;
}
interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toLlmError(error: unknown): LlmError {
  return error instanceof Error
    ? (error as LlmError)
    : (Object.assign(new Error(String(error)), { cause: error }) as LlmError);
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : null;
}

function firstChoice(value: unknown): JsonRecord {
  const choices = asRecord(value).choices;
  return Array.isArray(choices) ? asRecord(choices[0]) : {};
}

const DEFAULT_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function isRetryableStatus(status: number | undefined) {
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function isRetryableError(err: LlmError) {
  if (err.response) return isRetryableStatus(err.response.status);
  return true;
}

function usageFor(data: unknown): Usage {
  const usage = asRecord(asRecord(data).usage);
  return {
    promptTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    cachedPromptTokens: numberOrNull(usage.cached_prompt_tokens ?? usage.cache_read_input_tokens),
    completionTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
  };
}

const KNOWN_PRICING = Object.freeze({
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "deepseek/deepseek-v4-flash-0731": { input: 0.0152, output: 1.28 },
  "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
  // Units are USD per million tokens, verified against
  // https://ai.hackclub.com/proxy/v1/models on 2026-10-07.
});
function costFor(model: string, usage: Usage) {
  let prices: Record<string, Price> = { ...KNOWN_PRICING };
  try {
    const configured = JSON.parse(process.env.RIVET_LLM_PRICING_JSON || "{}");
    if (configured && typeof configured === "object")
      prices = { ...KNOWN_PRICING, ...(configured as Record<string, Price>) };
  } catch (_error: unknown) {
    prices = { ...KNOWN_PRICING };
  }
  const price = prices[model];
  if (!price || usage.promptTokens === null || usage.completionTokens === null) return null;
  return (usage.promptTokens * Number(price.input || 0) + usage.completionTokens * Number(price.output || 0)) / 1000000;
}

function recordUsage(options: CompletionOptions, result: ResultMeta = {}) {
  const context = options.telemetry || {};
  const usage: Usage = result.usage || {
    promptTokens: null,
    cachedPromptTokens: null,
    completionTokens: null,
    totalTokens: null,
  };
  try {
    db.recordLlmUsage({
      operation: context.operation || "llm",
      provider: context.provider || providerFor(options.baseUrl),
      programId: context.programId,
      channel: context.channel,
      requestId: context.requestId,
      eventId: result.eventId || crypto.randomUUID(),
      model: options.model,
      status: result.status || "error",
      httpStatus: result.httpStatus,
      attempt: result.attempt,
      retryCount: result.retryCount,
      ...usage,
      costUsd: costFor(options.model, usage),
      errorKind: result.errorKind,
      rateLimited: result.httpStatus === 429,
      latencyMs: result.latencyMs,
    });
  } catch (error: unknown) {
    log.debug("llm", `telemetry failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function providerFor(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname || null;
  } catch (_error: unknown) {
    return null;
  }
}

function backoffMs(attempt: number) {
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function remainingTimeout(options: CompletionOptions) {
  const remaining = (options.deadlineAt || Infinity) - Date.now();
  if (remaining <= 0) throw new Error("LLM request timed out");
  return Math.max(1, Math.min(options.timeout || DEFAULT_TIMEOUT_MS, remaining));
}

function noteRateLimit(options: CompletionOptions, err: LlmError) {
  if (err?.response?.status !== 429 || !options.onRateLimited) return;
  const usedKey = err.usedKey || (typeof options.apiKey === "function" ? options.apiKey() : options.apiKey);
  options.onRateLimited(usedKey);
}

function thinkingFor(model: string, thinking: unknown) {
  return thinking && !/\//.test(model || "") && /deepseek/i.test(model || "") ? thinking : undefined;
}

function stripThinking(text: string) {
  if (!text) return "";
  let clean = text
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/^[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*$/gi, "")
    .trim();

  while (true) {
    const next = clean
      .replace(
        /^(?:User\s+Safety|Safety\s+Assessment|Safety|Content\s+Filter|Safety\s+Category|Safety\s+Verdict):\s*[^\n]+\s*\n*/i,
        "",
      )
      .trim();
    if (next === clean) break;
    clean = next;
  }

  if (
    /^(?:Here(?:\x27s|\x20is) (?:a |the )?thinking process:?|\*\*Thinking Process:?\*\*|Thinking Process:?)/i.test(
      clean,
    )
  ) {
    const markers = [/\n(?:SOURCE|ANSWER):\s*/i, /\n[•\*]\s*\*Asker:\*/i, /\n(?:[^\n:]+)\s*::\s*(?:[^\n]+)$/m];
    let foundIndex = -1;
    for (const m of markers) {
      const match = clean.match(m);
      if (match && match.index !== undefined && (foundIndex === -1 || match.index < foundIndex)) {
        foundIndex = match.index;
      }
    }
    if (foundIndex !== -1) {
      clean = clean.slice(foundIndex).trim();
    } else {
      clean = "";
    }
  }

  return clean;
}

async function requestCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens,
  temperature,
  thinking,
  reasoningEffort,
  includeReasoning,
  timeout,
  deadlineAt,
}: CompletionOptions): Promise<CompletionResult> {
  const usedKey = typeof apiKey === "function" ? apiKey() : apiKey;
  const filteredThinking = thinkingFor(model, thinking);

  try {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature }),
        ...(filteredThinking === undefined ? {} : { thinking: filteredThinking }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(includeReasoning === undefined ? {} : { include_reasoning: includeReasoning }),
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${usedKey}`,
          "Content-Type": "application/json",
        },
        timeout: Math.max(1, Math.min(timeout || DEFAULT_TIMEOUT_MS, (deadlineAt || Infinity) - Date.now())),
        httpsAgent: keepAliveAgent,
      },
    );

    const choice = firstChoice(res.data);
    const rawContent = asRecord(choice.message).content;
    const cleanContent = stripThinking(typeof rawContent === "string" ? rawContent : "");

    return {
      text: cleanContent,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
      usedKey,
      usage: usageFor(res.data),
    };
  } catch (error: unknown) {
    const err = toLlmError(error);
    err.usedKey = usedKey;
    throw err;
  }
}

async function completeAttempts(options: CompletionOptions, scope: string): Promise<CompletionResult> {
  let lastError: LlmError | null = null;
  const requestId = options.telemetry?.requestId || crypto.randomUUID();
  const instrumented = {
    ...options,
    telemetry: { ...options.telemetry, operation: options.telemetry?.operation || scope, requestId },
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      remainingTimeout(instrumented);
    } catch (error) {
      throw error;
    }
    const startedAt = Date.now();
    try {
      const result = await requestCompletion(instrumented);
      result.attempt = attempt + 1;
      result.retryCount = attempt > 0 || instrumented.fallbackAttempt ? 1 : 0;
      result.latencyMs = Date.now() - startedAt;
      recordUsage(instrumented, { ...result, status: result.text?.trim() ? "success" : "empty" });
      if (result.text?.trim()) return result;
      log.debug(
        scope,
        `empty completion (finish_reason=${result.finishReason}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`,
      );
    } catch (error: unknown) {
      const err = toLlmError(error);
      lastError = err;
      recordUsage(instrumented, {
        status: "error",
        httpStatus: err.response?.status,
        attempt: attempt + 1,
        retryCount: attempt > 0 || instrumented.fallbackAttempt ? 1 : 0,
        latencyMs: Date.now() - startedAt,
        errorKind: err.response?.status === 429 ? "rate_limit" : err.code || "request",
      });
      noteRateLimit(options, err);
      if (!isRetryableError(err)) throw err;
      const status = err.response?.status || "network";
      log.debug(scope, `request failed (${status}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS - 1)
      await sleep(Math.min(backoffMs(attempt), Math.max(0, (instrumented.deadlineAt || Infinity) - Date.now())));
  }

  if (lastError) throw lastError;
  return { text: "", finishReason: "length" };
}

function describeError(err: LlmError) {
  return err.response?.status || err.cause?.code || err.code || "network";
}

function isProviderFailure(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { providerFailure?: unknown }).providerFailure === true,
  );
}

async function complete(options: CompletionOptions, scope = "llm") {
  const deadlineAt = options.deadlineAt || Date.now() + (options.timeout || DEFAULT_TIMEOUT_MS);
  const requestId = options.telemetry?.requestId || crypto.randomUUID();
  const { fallback, ...primary } = {
    ...options,
    deadlineAt,
    telemetry: { ...options.telemetry, requestId },
  };

  try {
    return await completeAttempts(primary, scope);
  } catch (error: unknown) {
    const err = toLlmError(error);
    if (!fallback) {
      Object.assign(err, { providerFailure: true });
      throw err;
    }
    log.warn(
      scope,
      `${primary.model || primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.model || fallback.baseUrl}`,
    );
    return await complete({ ...primary, ...fallback, fallbackAttempt: true }, `${scope}-fallback`);
  }
}

function parseSseChunk(buffer: string, { flush = false }: { flush?: boolean } = {}) {
  const deltas: string[] = [];
  const lines = buffer.split("\n");
  let rest = lines.pop();
  if (flush && rest) {
    lines.push(rest);
    rest = "";
  }
  let finishReason: string | null = null;
  let usage: Usage | undefined;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame: JsonRecord;
    try {
      frame = asRecord(JSON.parse(payload));
    } catch {
      continue;
    }
    const choice = firstChoice(frame);
    if (frame.usage) usage = usageFor(frame);
    const delta = asRecord(choice.delta).content;
    if (typeof delta === "string" && delta) deltas.push(delta);
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
  }

  return { deltas, rest, finishReason, usage };
}

async function streamCompletion(options: CompletionOptions, onDelta: (delta: string, text: string) => boolean | void) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    maxTokens,
    temperature,
    thinking,
    reasoningEffort,
    includeReasoning,
    timeout,
    deadlineAt,
  } = options;
  const controller = new AbortController();
  const requestTimeout = remainingTimeout(options);
  const deadline = Date.now() + requestTimeout;
  const timer = setTimeout(() => controller.abort(new Error("stream timed out")), requestTimeout);
  let reader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?: () => Promise<void>;
    releaseLock?: () => void;
  } | null = null;

  const usedKey = typeof apiKey === "function" ? apiKey() : apiKey;
  const filteredThinking = thinkingFor(model, thinking);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${usedKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(temperature === undefined ? {} : { temperature }),
        ...(filteredThinking === undefined ? {} : { thinking: filteredThinking }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(includeReasoning === undefined ? {} : { include_reasoning: includeReasoning }),
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = Object.assign(new Error(`stream failed: HTTP ${res.status} ${body.slice(0, 200)}`), {
        response: { status: res.status },
        usedKey,
      });
      throw err;
    }
    if (!res.body) throw new Error("stream failed: no response body");

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stopped = false;
    let insideThink = false;
    let thinkBuffer = "";
    let finishReason: string | null = null;
    let usage: Usage | undefined;

    const applyFrames = (frames: { finishReason: string | null; deltas: string[]; usage?: Usage }) => {
      if (frames.finishReason) finishReason = frames.finishReason;
      if (frames.usage) usage = frames.usage;
      for (const delta of frames.deltas) {
        const hasThinkOpen = (s: string) => /<(?:think|thinking|thought|scratchpad)>/i.test(s);
        const hasThinkClose = (s: string) => /<\/(?:think|thinking|thought|scratchpad)>/i.test(s);

        if (insideThink || hasThinkOpen(delta) || hasThinkOpen(thinkBuffer)) {
          insideThink = true;
          thinkBuffer += delta;
          if (hasThinkClose(thinkBuffer)) {
            insideThink = false;
            const parts = thinkBuffer.split(/<\/(?:think|thinking|thought|scratchpad)>/i);
            const remaining = parts.slice(1).join("");
            thinkBuffer = "";
            if (remaining) {
              text += remaining;
              if (onDelta && onDelta(remaining, text) === false) return true;
            }
          }
          continue;
        }

        text += delta;
        if (onDelta && onDelta(delta, text) === false) return true;
      }
      return false;
    };

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("stream timed out");
      let idleTimer: ReturnType<typeof setTimeout>;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => reject(new Error("stream read timed out")), remaining);
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = parseSseChunk(buffer);
      buffer = frames.rest ?? "";
      stopped = applyFrames(frames);

      if (stopped) {
        controller.abort();
        break;
      }
    }

    buffer += decoder.decode();
    if (!stopped && buffer) applyFrames(parseSseChunk(buffer, { flush: true }));
    if (!stopped && finishReason !== "stop") {
      throw new Error(`stream ended without a complete answer (finish_reason=${finishReason || "missing"})`);
    }

    return { text, stopped, usedKey, finishReason, usage };
  } finally {
    clearTimeout(timer);
    if (reader) {
      controller.abort();
      if (typeof reader.cancel === "function") await reader.cancel().catch(() => undefined);
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
  }
}

async function streamAttempts(
  options: CompletionOptions,
  onDelta: (delta: string, text: string) => boolean | void,
  scope: string,
) {
  let lastError: LlmError | null = null;
  const requestId = options.telemetry?.requestId || crypto.randomUUID();
  const instrumented = {
    ...options,
    telemetry: { ...options.telemetry, operation: options.telemetry?.operation || scope, requestId },
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    remainingTimeout(instrumented);
    const startedAt = Date.now();
    let streamed = false;
    const track = (delta: string, text: string) => {
      streamed = true;
      return onDelta ? onDelta(delta, text) : undefined;
    };

    try {
      const result = await streamCompletion(instrumented, track);
      recordUsage(instrumented, {
        ...result,
        attempt: attempt + 1,
        retryCount: attempt > 0 || instrumented.fallbackAttempt ? 1 : 0,
        latencyMs: Date.now() - startedAt,
        status: result.text.trim() || result.stopped ? "success" : "empty",
      });
      if (result.text.trim() || result.stopped) return result;
      log.debug(scope, `empty stream, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    } catch (error: unknown) {
      const err = toLlmError(error);
      lastError = err;
      recordUsage(instrumented, {
        status: "error",
        httpStatus: err.response?.status,
        attempt: attempt + 1,
        retryCount: attempt > 0 || instrumented.fallbackAttempt ? 1 : 0,
        latencyMs: Date.now() - startedAt,
        errorKind: err.response?.status === 429 ? "rate_limit" : err.code || "request",
      });
      noteRateLimit(options, err);
      if (streamed) throw err;
      if (!isRetryableError(err)) throw err;
      const status = err.response?.status || "network";
      log.debug(scope, `stream failed (${status}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS - 1)
      await sleep(Math.min(backoffMs(attempt), Math.max(0, (options.deadlineAt || Infinity) - Date.now())));
  }

  if (lastError) throw lastError;
  return { text: "", stopped: false };
}

async function completeStream(
  options: CompletionOptions,
  onDelta: (delta: string, text: string) => boolean | void,
  scope = "llm",
) {
  const deadlineAt = options.deadlineAt || Date.now() + (options.timeout || DEFAULT_TIMEOUT_MS);
  const requestId = options.telemetry?.requestId || crypto.randomUUID();
  const { fallback, ...primary } = {
    ...options,
    deadlineAt,
    telemetry: { ...options.telemetry, requestId },
  };

  let streamedAny = false;
  const track = (delta: string, text: string) => {
    streamedAny = true;
    return onDelta ? onDelta(delta, text) : undefined;
  };

  try {
    return await streamAttempts(primary, track, scope);
  } catch (error: unknown) {
    const err = toLlmError(error);
    if (!fallback || streamedAny) {
      Object.assign(err, { providerFailure: true });
      throw err;
    }
    log.warn(
      scope,
      `${primary.model || primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.model || fallback.baseUrl}`,
    );
    return await completeStream({ ...primary, ...fallback, fallbackAttempt: true }, track, `${scope}-fallback`);
  }
}

export = {
  complete,
  completeStream,
  isProviderFailure,
  requestCompletion,
  streamCompletion,
  parseSseChunk,
  thinkingFor,
  isRetryableStatus,
  isRetryableError,
  stripThinking,
  keepAliveAgent,
  MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
};
