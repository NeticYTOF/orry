import configModule = require("./config");
import jevDecision = require("./jevDecision");
import log = require("./log");

const { config, veyConfig } = configModule;

// Reuse the Jev taxonomy and state builder verbatim so both providers classify
// against the same seven intents and the same bounded, documentation-free state.
const { INTENT_CHOICES, buildJevState, classifyError } = jevDecision;

// jevDecision owns these shapes and does not export them; deriving them keeps the
// two providers' contracts in lockstep without restating the taxonomy.
type SupportInput = NonNullable<Parameters<typeof jevDecision.evaluateSupportDecision>[0]>;
type SupportOutcome = Awaited<ReturnType<typeof jevDecision.evaluateSupportDecision>>;
type VeyState = ReturnType<typeof jevDecision.buildJevState>;

interface VeyConfig {
  enabled?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  engageThreshold?: number;
}
interface VeyError extends Error {
  veyErrorKind?: string;
  status?: number;
}
interface Decision {
  intent: string;
  shouldEngage: boolean;
  probabilities: { shouldEngage: number };
}
interface VeyRequest {
  version: number;
  question: string;
  candidates: Record<string, string>;
  state: VeyState;
  explain: boolean;
}
interface VeyResponse {
  answer?: unknown;
  should_engage?: unknown;
  should_engage_p?: unknown;
  decision_mode?: unknown;
  certificate?: unknown;
}
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
interface VeyDeps {
  config?: VeyConfig;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  request?: VeyRequest;
}

const VEY_BASE_URL_DEFAULT = "http://127.0.0.1:8787";
const VEY_DECIDE_PATH = "/decide";
const WIRE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 3000;
const ENGAGE_THRESHOLD_DEFAULT = 0.7;

const ERROR_KINDS = new Set(["timeout", "unavailable", "bad_response", "config", "network", "auth"]);

const PROGRAM_INTENT: Record<string, true> = { support_question: true, direct_program_question: true };
const ADDRESSED_INTENT: Record<string, true> = { addressed_general_request: true, addressed_smalltalk: true };
const SILENT_INTENT: Record<string, true> = { unrelated_chatter: true, human_conversation: true };

// The VEY candidate consequence texts are the JEV intent descriptions verbatim:
// one taxonomy, two runtimes.
const VEY_CANDIDATES: Record<string, string> = { ...INTENT_CHOICES };

function fail(kind: string, message: string, status?: number): VeyError {
  const err = new Error(message) as VeyError;
  err.veyErrorKind = kind;
  if (status !== undefined) err.status = status;
  return err;
}

function classifyVeyError(err: VeyError | null | undefined): string {
  if (err && err.veyErrorKind && ERROR_KINDS.has(err.veyErrorKind)) return err.veyErrorKind;
  return classifyError(err);
}

function effectiveConfig(): VeyConfig {
  try {
    const live = typeof veyConfig === "function" ? veyConfig() : null;
    if (live) return live;
  } catch {
    // fall through to the boot-time snapshot
  }
  return config.vey;
}

function baseUrlOf(cfg: VeyConfig = effectiveConfig()): string {
  return (
    String(cfg.baseUrl || VEY_BASE_URL_DEFAULT)
      .trim()
      .replace(/\/+$/, "") || VEY_BASE_URL_DEFAULT
  );
}

function isEnabled(cfg: VeyConfig = effectiveConfig()): boolean {
  return Boolean(cfg && cfg.enabled && baseUrlOf(cfg));
}

function providerOf() {
  return "vey";
}

function buildVeyQuestion(): string {
  return (
    "Classify what kind of message this is for Orry, the support assistant of one Hack Club program. " +
    "Choose exactly one candidate that best describes it; never judge whether Orry can answer it. " +
    jevDecision.buildJevQuestions().intent.instructions
  );
}

function parseVeyResponse(body: unknown): Decision {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("bad_response", "vey returned no body");
  const res = body as VeyResponse;
  const answer = typeof res.answer === "string" ? res.answer.trim() : "";
  if (!answer) throw fail("bad_response", "vey returned no answer label");
  if (!Object.hasOwn(VEY_CANDIDATES, answer)) throw fail("bad_response", `vey answered an undeclared label: ${answer}`);
  if (typeof res.should_engage !== "boolean") throw fail("bad_response", "vey returned no should_engage boolean");
  const reported = Number(res.should_engage_p);
  return {
    intent: answer,
    shouldEngage: res.should_engage,
    // Vey is uncalibrated, so an absent score falls back to the decided boolean's
    // own endpoints; the shared engageThreshold comparison stays meaningful.
    probabilities: {
      shouldEngage: Number.isFinite(reported) && reported >= 0 && reported <= 1 ? reported : res.should_engage ? 1 : 0,
    },
  };
}

function decideAction(
  decision: Decision,
  cfg: VeyConfig = effectiveConfig(),
  state: Partial<VeyState> = {},
): { action: string; reason: string } {
  const engageP = decision.probabilities.shouldEngage;
  const intent = decision.intent;
  if (PROGRAM_INTENT[intent]) return { action: "engage", reason: "vey_program_intent" };
  if (ADDRESSED_INTENT[intent]) {
    return state.addressed
      ? { action: "engage", reason: "vey_addressed" }
      : { action: "silence", reason: "vey_unaddressed_general" };
  }
  if (SILENT_INTENT[intent]) return { action: "silence", reason: "vey_chatter" };
  if (intent === "ambiguous_followup") {
    return String(state.conversationContext || "").trim() && engageP >= 0.5
      ? { action: "engage", reason: "vey_followup_with_referent" }
      : { action: "silence", reason: "vey_followup_no_referent" };
  }
  const threshold = Number.isFinite(cfg.engageThreshold) ? (cfg.engageThreshold as number) : ENGAGE_THRESHOLD_DEFAULT;
  if (decision.shouldEngage && engageP >= threshold) return { action: "engage", reason: "vey_engage" };
  return { action: "silence", reason: "vey_deny" };
}

const decisionCache = new Map<string, { expiresAt: number; result: SupportOutcome }>();
const inflightEvaluations = new Map<string, Promise<SupportOutcome>>();
const veyStats = { calls: 0, cacheHits: 0 };
const MAX_CACHE_ENTRIES = 2048;

function veyCacheTtlMs() {
  const n = Number(process.env.VEY_CACHE_TTL_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return 120 * 1000;
}

function cacheKeyFor({ baseUrl, state }: { baseUrl: string; state: VeyState }): string {
  const fingerprint = JSON.stringify({
    v: WIRE_VERSION,
    baseUrl,
    message: state.message,
    conversationContext: state.conversationContext,
    program: state.program,
    channelPosture: state.channelPosture,
    addressed: state.addressed,
  });
  return require("crypto").createHash("sha256").update(fingerprint).digest("hex");
}

function getStats() {
  return { ...veyStats, cacheSize: decisionCache.size };
}

function pruneDecisionCache(now = Date.now()) {
  for (const [key, hit] of decisionCache) {
    if (hit.expiresAt <= now) decisionCache.delete(key);
  }
  while (decisionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = decisionCache.keys().next().value;
    if (oldest === undefined) break;
    decisionCache.delete(oldest);
  }
}

function clearDecisionCache() {
  decisionCache.clear();
  inflightEvaluations.clear();
}

function logDecision({
  intent,
  shouldEngageP,
  action,
  reason,
  latencyMs,
  errorKind,
  enabled,
}: {
  intent: string | null;
  shouldEngageP: number | null;
  action: string;
  reason: string;
  latencyMs: number;
  errorKind: string | null;
  enabled: boolean;
}): void {
  const fmt = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?");
  log.info(
    "vey",
    `[vey] enabled=${enabled} vey_intent=${intent || "?"} vey_should_engage=${fmt(shouldEngageP)} ` +
      `final_action=${action} reason=${reason} latency_ms=${latencyMs}${errorKind ? ` error=${errorKind}` : ""}`,
  );
}

function statusError(status: number, text: string): VeyError {
  if (status === 401 || status === 403)
    return fail("auth", `vey sidecar rejected credentials (http ${status})`, status);
  if (status === 429) return fail("unavailable", `vey sidecar rate limited (http 429)`, status);
  if (status >= 500) return fail("unavailable", `vey sidecar unavailable (http ${status})`, status);
  return fail("bad_response", `vey sidecar rejected the request (http ${status}): ${text.slice(0, 120)}`, status);
}

async function postDecide(body: VeyRequest, baseUrl: string, timeoutMs: number, fetchFn: FetchFn): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${VEY_DECIDE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = (err && typeof err === "object" ? err : {}) as VeyError & { code?: unknown };
    if (e.veyErrorKind) throw err;
    if (e.name === "AbortError" || /abort|timeout|timed out/i.test(String(e.message || "")))
      throw fail("timeout", `vey sidecar timed out after ${timeoutMs}ms`);
    throw fail("unavailable", `vey sidecar unreachable (${String(e.code || e.message || "network").slice(0, 80)})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw statusError(res.status, await res.text().catch(() => ""));
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw fail("bad_response", "vey sidecar returned a body that is not JSON");
  }
}

async function evaluateSupportDecision(
  { message, conversationContext = "", program = null, channelPosture = "main", addressed = false }: SupportInput = {},
  deps: VeyDeps = {},
): Promise<SupportOutcome> {
  const cfg = deps.config || effectiveConfig();
  const startedAt = Date.now();
  if (!isEnabled(cfg)) {
    return {
      action: "existing",
      intent: null,
      shouldEngageP: null,
      reason: "vey_disabled",
      latencyMs: Date.now() - startedAt,
      errorKind: null,
    };
  }
  const state = buildJevState({ message, conversationContext, program, channelPosture, addressed });
  const baseUrl = baseUrlOf(cfg);
  const timeoutMs = deps.timeoutMs || (Number.isFinite(cfg.timeoutMs) ? (cfg.timeoutMs as number) : DEFAULT_TIMEOUT_MS);
  const request: VeyRequest = deps.request || {
    version: WIRE_VERSION,
    question: buildVeyQuestion(),
    candidates: VEY_CANDIDATES,
    state,
    explain: true,
  };
  const cacheable = !deps.fetchFn && !deps.request;
  const key = cacheable ? cacheKeyFor({ baseUrl, state }) : null;
  if (key) {
    const hit = decisionCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      decisionCache.delete(key);
      decisionCache.set(key, hit);
      veyStats.cacheHits += 1;
      try {
        require("./db").recordMetric("vey_cache_hit", 0, hit.result.action || null, state.program?.id || null);
      } catch {
        // metrics are best-effort
      }
      log.info("vey", `[vey] cached=true action=${hit.result.action} reason=${hit.result.reason}`);
      return { ...hit.result, latencyMs: 0, cached: true };
    }
    if (hit) decisionCache.delete(key);
    if (inflightEvaluations.has(key)) return inflightEvaluations.get(key) as Promise<SupportOutcome>;
  }
  const run = (async () => {
    const fetchFn: FetchFn = deps.fetchFn || ((url, init) => fetch(url, init));
    const body = await postDecide(request, baseUrl, timeoutMs, fetchFn);
    const decision = parseVeyResponse(body);
    const { action, reason } = decideAction(decision, cfg, state);
    const latencyMs = Date.now() - startedAt;
    const shouldEngageP = decision.probabilities.shouldEngage;
    logDecision({ intent: decision.intent, shouldEngageP, action, reason, latencyMs, errorKind: null, enabled: true });
    try {
      require("./db").recordMetric("vey_decision", latencyMs, `${action}:${reason}`, state.program?.id || null);
    } catch {
      // metrics are best-effort
    }
    const outcome: SupportOutcome = {
      action,
      intent: decision.intent,
      shouldEngageP,
      reason,
      latencyMs,
      errorKind: null,
    };
    if (key) {
      veyStats.calls += 1;
      pruneDecisionCache();
      decisionCache.delete(key);
      decisionCache.set(key, { expiresAt: Date.now() + veyCacheTtlMs(), result: outcome });
      pruneDecisionCache();
    }
    return outcome;
  })();
  if (key) {
    inflightEvaluations.set(key, run);
    void run.catch(() => undefined).finally(() => inflightEvaluations.delete(key));
  }
  try {
    return await run;
  } catch (err) {
    const errorKind = classifyVeyError(err as VeyError);
    const latencyMs = Date.now() - startedAt;
    const reason = `vey_error_${errorKind}`;
    logDecision({ intent: null, shouldEngageP: null, action: "existing", reason, latencyMs, errorKind, enabled: true });
    try {
      require("./db").recordMetric("vey_error", latencyMs, errorKind, state.program?.id || null);
    } catch {
      // metrics are best-effort
    }
    // Fail closed: "existing" hands the message back to the legacy classifier.
    return { action: "existing", intent: null, shouldEngageP: null, reason, latencyMs, errorKind };
  }
}

export = {
  evaluateSupportDecision,
  providerOf,
  isEnabled,
  effectiveConfig,
  baseUrlOf,
  buildVeyQuestion,
  parseVeyResponse,
  decideAction,
  classifyError: classifyVeyError,
  getStats,
  clearDecisionCache,
  VEY_CANDIDATES,
  VEY_BASE_URL_DEFAULT,
  VEY_DECIDE_PATH,
  WIRE_VERSION,
  DEFAULT_TIMEOUT_MS,
  MAX_CACHE_ENTRIES,
};
