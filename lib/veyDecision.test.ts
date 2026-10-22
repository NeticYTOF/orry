process.env.ORRY_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const vey = require("./veyDecision");

type SupportInput = NonNullable<Parameters<typeof vey.evaluateSupportDecision>[0]>;
type VeyConfig = { enabled?: boolean; baseUrl?: string; timeoutMs?: number; engageThreshold?: number };
type Deps = { config?: VeyConfig; timeoutMs?: number };
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
type Wire = { url: string; method?: string; body: Record<string, unknown> };

const CFG = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8787",
  timeoutMs: 50,
  engageThreshold: 0.7,
} satisfies VeyConfig;
const OFF_CFG = { ...CFG, enabled: false };
const PROGRAM = { id: "acme", name: "Acme" };

const input = (message: string, extra: Record<string, unknown> = {}) => ({
  message,
  conversationContext: "",
  program: PROGRAM,
  channelPosture: "main",
  ...extra,
});

function reply(body: unknown, { status = 200 }: { status?: number } = {}): FetchFn {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function verdict(answer: string, shouldEngage: boolean, extra: Record<string, unknown> = {}): FetchFn {
  return reply({ answer, should_engage: shouldEngage, decision_mode: "crux", certificate: {}, ...extra });
}

/** Records the wire request the sidecar receives, then answers with `responder`. */
function recording(responder: FetchFn): FetchFn & { wire: () => Wire } {
  let wire: Wire | null = null;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    wire = { url, method: init.method, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    return responder(url, init);
  };
  return Object.assign(impl, { wire: () => wire as Wire });
}

async function withFetch<T>(impl: FetchFn, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function decide(message: string, fetchFn: FetchFn, extra: Record<string, unknown> = {}, config: VeyConfig = CFG) {
  return vey.evaluateSupportDecision(input(message, extra) as SupportInput, { config, fetchFn } as Deps);
}

beforeEach(() => vey.clearDecisionCache());

test("Vey is disabled unless VEY_ENABLED is set", () => {
  assert.equal(vey.isEnabled(OFF_CFG), false);
});

test("a disabled provider hands the message back without calling the sidecar", async () => {
  let called = false;
  const spy: FetchFn = async () => {
    called = true;
    return verdict("support_question", true)("", {});
  };
  const res = await withFetch(spy, () => decide("what is restoration energy?", spy, {}, OFF_CFG));
  assert.equal(called, false);
  assert.equal(res.action, "existing");
  assert.equal(res.reason, "vey_disabled");
  assert.equal(res.intent, null);
  assert.equal(res.errorKind, null);
});

test("a program question engages with the intent the sidecar chose", async () => {
  const res = await decide("what is restoration energy?", verdict("direct_program_question", true));
  assert.deepEqual(Object.keys(res).sort(), ["action", "errorKind", "intent", "latencyMs", "reason", "shouldEngageP"]);
  assert.equal(res.action, "engage");
  assert.equal(res.intent, "direct_program_question");
  assert.equal(res.reason, "vey_program_intent");
  assert.equal(res.shouldEngageP, 1);
  assert.equal(res.errorKind, null);
});

test("chatter is silenced rather than engaged", async () => {
  const res = await decide("lmao gg", verdict("unrelated_chatter", false));
  assert.equal(res.action, "silence");
  assert.equal(res.reason, "vey_chatter");
  assert.equal(res.shouldEngageP, 0);
});

test("decision cache stays bounded when each conversation has a new key", async () => {
  vey.clearDecisionCache();
  const log = require("./log");
  const originalInfo = log.info;
  const originalFetch = globalThis.fetch;
  const fakeFetch = verdict("support_question", true);
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;
  log.info = () => {};
  try {
    for (let index = 0; index < vey.MAX_CACHE_ENTRIES + 2; index += 1) {
      await vey.evaluateSupportDecision(input(`unique question ${index}?`), { config: CFG });
    }
  } finally {
    log.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
  assert.ok(vey.getStats().cacheSize <= vey.MAX_CACHE_ENTRIES);
  assert.equal(vey.getStats().cacheSize, vey.MAX_CACHE_ENTRIES);
});
test("an addressed general request engages whether or not should_engage agrees", async () => {
  const engaged = await decide("tell me a joke", verdict("addressed_general_request", true), { addressed: true });
  const denied = await decide("tell me a joke", verdict("addressed_general_request", false), { addressed: true });
  assert.equal(engaged.action, "engage");
  assert.equal(engaged.reason, "vey_addressed");
  assert.equal(denied.action, "engage");
});

test("an unaddressed general request is silenced", async () => {
  const res = await decide("tell me a joke", verdict("addressed_general_request", true, { should_engage_p: 0.4 }));
  assert.equal(res.action, "silence");
  assert.equal(res.reason, "vey_unaddressed_general");
});

test("should_engage true engages a follow-up whose referent is clear", async () => {
  const res = await decide("and that one?", verdict("ambiguous_followup", true), {
    conversationContext: "acme: the deadline is friday",
  });
  assert.equal(res.action, "engage");
  assert.equal(res.reason, "vey_followup_with_referent");
  assert.equal(res.shouldEngageP, 1);
});

test("should_engage false silences the same follow-up", async () => {
  const res = await decide("and that one?", verdict("ambiguous_followup", false), {
    conversationContext: "acme: the deadline is friday",
  });
  assert.equal(res.action, "silence");
  assert.equal(res.reason, "vey_followup_no_referent");
  assert.equal(res.shouldEngageP, 0);
});

test("a reported should_engage score below the follow-up tie band silences", async () => {
  const res = await decide("and that one?", verdict("ambiguous_followup", true, { should_engage_p: 0.4 }), {
    conversationContext: "acme: the deadline is friday",
  });
  assert.equal(res.action, "silence");
  assert.equal(res.shouldEngageP, 0.4);
});

test("an unknown label is rejected and the message falls through", async () => {
  const res = await decide("what is restoration energy?", verdict("needs_human", true));
  assert.equal(res.action, "existing");
  assert.equal(res.intent, null);
  assert.equal(res.errorKind, "bad_response");
});

test("a non-2xx status fails closed", async () => {
  const res = await decide("what is restoration energy?", reply({ error: "boom" }, { status: 503 }));
  assert.equal(res.action, "existing");
  assert.equal(res.reason, "vey_error_unavailable");
  assert.equal(res.errorKind, "unavailable");
});

test("a sidecar timeout fails closed instead of hanging the classifier", async () => {
  const hanging: FetchFn = (_url, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
    );
    return promise;
  };
  const res = await decide("what is restoration energy?", hanging, {}, { ...CFG, timeoutMs: 5 });
  assert.equal(res.action, "existing");
  assert.equal(res.reason, "vey_error_timeout");
  assert.equal(res.errorKind, "timeout");
});

test("an unparseable body fails closed", async () => {
  const res = await decide("what is restoration energy?", reply("<html>not json</html>"));
  assert.equal(res.action, "existing");
  assert.equal(res.errorKind, "bad_response");
});

test("a missing engagement boolean fails closed", async () => {
  const res = await decide("what is restoration energy?", reply({ answer: "support_question" }));
  assert.equal(res.action, "existing");
  assert.equal(res.errorKind, "bad_response");
});

test("the request names the seven intents and no documentation", async () => {
  const spy = recording(verdict("support_question", true));
  await withFetch(spy, () => decide("what is restoration energy?", spy));
  const wire = spy.wire();

  assert.equal(wire.url, "http://127.0.0.1:8787/decide");
  assert.equal(wire.method, "POST");
  const candidates = wire.body.candidates as Record<string, string>;
  assert.equal(Object.keys(candidates).length, 7);
  assert.deepEqual(Object.keys(candidates).sort(), Object.keys(vey.VEY_CANDIDATES).sort());
  assert.equal(candidates.support_question, vey.VEY_CANDIDATES.support_question);
  assert.deepEqual((wire.body.state as Record<string, unknown>).program, { id: "acme", name: "Acme" });
  assert.doesNotMatch(JSON.stringify(wire.body), /document|evidence|corpus|retriev/i);
});

test("a trailing slash on the base URL does not double up the path", async () => {
  const spy = recording(verdict("support_question", true));
  await withFetch(spy, () =>
    decide("what is restoration energy?", spy, {}, { ...CFG, baseUrl: "http://127.0.0.1:8787/" }),
  );
  assert.equal(spy.wire().url, "http://127.0.0.1:8787/decide");
});

test("an identical message is served from cache without a second sidecar call", async () => {
  let calls = 0;
  const counting: FetchFn = async () => {
    calls += 1;
    return verdict("support_question", true)("", {});
  };
  const first = await withFetch(counting, async () =>
    vey.evaluateSupportDecision(input("what is restoration energy?") as SupportInput, { config: CFG } as Deps),
  );
  const second = await withFetch(counting, async () =>
    vey.evaluateSupportDecision(input("what is restoration energy?") as SupportInput, { config: CFG } as Deps),
  );

  assert.equal(first.action, "engage");
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.equal(second.action, "engage");
});
export {};
