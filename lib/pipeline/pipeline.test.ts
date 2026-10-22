process.env.ORRY_DB_PATH = ":memory:";

const { test, expect, beforeEach, beforeAll, afterAll } = require("bun:test");

const ACME = {
  id: "acme",
  name: "Acme",
  scope: "program",
  helpChannel: "C_ACME_HELP",
  organizerChannel: "C_ACME_ORG",
  channels: ["C_ACME_HELP", "C_ACME_MAIN", "C_ACME_ORG"],
  ticketsEnabled: true,
  helperPing: true,
};
const BETA = {
  id: "beta",
  name: "Beta Program",
  scope: "program",
  helpChannel: "C_BETA_HELP",
  channels: ["C_BETA_HELP", "C_BETA_MAIN"],
};

const db = require("../db");
const programs = require("../programs");
const jevDecision = require("../jevDecision");
const veyDecision = require("../veyDecision");
const intent = require("../intent");
const lookup = require("../lookup");
const tickets = require("../tickets");
const context = require("../context");
const link = require("../link");
const respond = require("../respond");
const realSeedFromSlack = context.seedFromSlack;

type TestRecord = Record<string, unknown>;
type TestMessage = TestRecord & { text?: string; ts?: string };
type DecisionArgs = TestRecord & { message: string; conversationContext: string };
type ProgramOverride = { acme?: TestRecord; beta?: TestRecord };
type SendArgs = {
  channel: string;
  text: string;
  addressed?: boolean;
  userId?: string;
  threadTs?: string | null;
  messageTs?: string | null;
  seedClient?: unknown;
};
type MatrixWant = {
  spoke?: boolean;
  ticket?: number;
  handoff?: number;
  answer?: number;
  jev?: number;
  text?: RegExp;
};

let savedEnv: string | undefined;
const saved: Record<string, [Record<string, unknown>, unknown]> = {};
function stub(obj: object, key: string, value: unknown) {
  const target = obj as Record<string, unknown>;
  if (!(key in saved)) saved[key] = [target, target[key]];
  target[key] = value;
}

const JEV: Record<string, { action: string; intent: string }> = {
  "what is restoration energy?": { action: "engage", intent: "direct_program_question" },
  "what is acme?": { action: "engage", intent: "direct_program_question" },
  "lmao gg": { action: "silence", intent: "unrelated_chatter" },
  "did you finish your game?": { action: "silence", intent: "human_conversation" },
  "does the hardware grant cover shipping?": { action: "engage", intent: "direct_program_question" },
  "what is my exact payout amount right now?": { action: "engage", intent: "direct_program_question" },
  "what is the exact maximum percentage of ai code allowed?": { action: "engage", intent: "direct_program_question" },
  "how do i do this": { action: "silence", intent: "ambiguous_followup" },
  "give me a chocolate chip cookie recipe": { action: "engage", intent: "addressed_general_request" },
  "my submission got rejected, how do i resubmit?": { action: "engage", intent: "support_question" },
  "how do i get my personal grant code?": { action: "engage", intent: "support_question" },
  "@ricky if you had to save @orry or @pixorpheus who would you save?": {
    action: "silence",
    intent: "human_conversation",
  },
};

function groundedFixture(answer: string, source: string, programId: string | undefined) {
  const id = "fixture-passage";
  return {
    answer,
    source,
    passageCitations: [id],
    citationEvidence: [{ id, programId: programId || "acme", source, text: answer }],
  };
}

function fakeAnswer(question: string, program: { id?: string } | null | undefined) {
  const q = question.toLowerCase();
  if (q.includes("restoration energy") && program?.id === "acme") {
    return groundedFixture("Restoration Energy is what you earn by restoring pixels.", "Acme Docs", program.id);
  }
  if (q === "what is acme?" && program?.id === "acme")
    return groundedFixture("Acme is a YSWS for pixel art games.", "Acme Docs", program.id);
  if (q.includes("resubmit") && program?.id === "acme")
    return groundedFixture("Fix the notes and resubmit from your dashboard.", "Acme Docs", program.id);
  if (q.includes("pixorpheus")) return { answer: "Me, obviously. Pixorpheus can swim.", source: "NONE" };
  if (q.includes("cookie")) return { answer: "Cream butter and sugar, add chips, bake at 180C.", source: "NONE" };
  if (q === "how do i do this") return { answer: null, source: null, unclear: true, silent: true };
  return { answer: null, source: null, unclear: true };
}

let posts: TestMessage[];
let ticketCalls: TestRecord[];
let handOffs: TestRecord[];
let jevCalls: DecisionArgs[];
let answerCalls: TestRecord[];
let jevMode: string;
let veyMode: string;
let legacyMode: string;
let legacyCalls: number;

function client() {
  return {
    chat: {
      postMessage: async (msg: TestMessage) => {
        posts.push(msg);
        return { ok: true, ts: `p${posts.length}` };
      },
      update: async (msg: TestMessage) => {
        posts.push({ ...msg, updated: true });
        return { ok: true, ts: msg.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }) },
    conversations: {
      replies: async (_args?: TestRecord) => ({ messages: [] as TestMessage[] }),
      history: async (_args?: TestRecord) => ({ messages: [] as TestMessage[] }),
    },
  };
}

beforeAll(() => {
  savedEnv = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  db.open(":memory:");
});

afterAll(() => {
  for (const [key, [obj, value]] of Object.entries(saved)) obj[key] = value;
  if (savedEnv === undefined) delete process.env.ORRY_PROGRAMS_JSON;
  else process.env.ORRY_PROGRAMS_JSON = savedEnv;
  programs.invalidate();
});

function configure(overrides: ProgramOverride = {}) {
  const acme = { ...ACME, ...(overrides.acme || {}) };
  const beta = { ...BETA, ...(overrides.beta || {}) };
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([acme, beta]);
  programs.invalidate();
}

beforeEach(() => {
  configure();
  posts = [];
  ticketCalls = [];
  handOffs = [];
  jevCalls = [];
  answerCalls = [];
  jevMode = "script";
  veyMode = "disabled";
  legacyMode = "unavailable";
  legacyCalls = 0;
  stub(veyDecision, "isEnabled", () => veyMode !== "disabled");
  stub(veyDecision, "evaluateSupportDecision", async () => {
    if (veyMode === "throw") throw new Error("unexpected Vey error");
    return { action: "existing", intent: null, errorKind: null };
  });
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    if (jevMode === "throw") throw new Error("Jev request failed");
    if (jevMode === "error") return { action: "error", errorKind: "timeout" };
    const hit = JEV[String(args.message).toLowerCase()];
    return hit ? { ...hit } : { action: "silence", intent: "unrelated_chatter" };
  });
  stub(intent, "classifyIntentContext", async () => {
    legacyCalls += 1;
    return legacyMode === "help"
      ? {
          verdict: intent.HELP_NEEDED,
          addressedToOrry: false,
          directedAtHuman: false,
          recentOrryParticipation: false,
          programRelevance: "relevant",
        }
      : null;
  });
  stub(lookup, "knownAnswer", () => null);
  stub(
    lookup,
    "answerOrChat",
    async (question: string, _ctx: string, opts: { program?: { id?: string }; allowWebSearch?: boolean }) => {
      answerCalls.push({ question, program: opts.program?.id, allowWebSearch: opts.allowWebSearch });
      return fakeAnswer(question, opts.program);
    },
  );
  stub(tickets, "ensureSupportTicket", async (args: TestRecord) => {
    ticketCalls.push(args);
    return { id: ticketCalls.length, status: "open" };
  });
  stub(tickets, "handOffToHelper", async (args: TestRecord) => {
    handOffs.push(args);
  });
  stub(tickets, "escalateTicket", async (args: TestRecord) => {
    handOffs.push({ ...args, sensitive: true });
  });
  stub(context, "seedFromSlack", async () => {});
});

let seq = 0;
async function send({
  channel,
  text,
  addressed = false,
  userId,
  threadTs = null,
  messageTs = null,
  seedClient = null,
}: SendArgs) {
  seq += 1;
  const ts = messageTs || `${1000 + seq}.000`;
  return respond.respond({
    client: client(),
    channel,
    threadTs: threadTs || ts,
    messageTs: ts,
    userId: userId || `U_REQ_${seq}`,
    question: text,
    mode: addressed ? respond.ALWAYS : respond.HELP_ONLY,
    addressed,
    seedClient,
  });
}

const postedText = () => posts.map((p: TestMessage) => p.text || "").join("\n");

test("main ambient: a Acme program question is classified, retrieved and answered", async () => {
  const spoke = await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" });
  expect(spoke).toBe(true);
  expect(jevCalls).toHaveLength(1);
  expect(jevCalls[0].channelPosture).toBe("main");
  expect(answerCalls[0].program).toBe("acme");
  expect(postedText()).toContain("Restoration Energy");
  expect(ticketCalls).toHaveLength(0);
});

test("main ambient: 'what is acme?' answers from Acme knowledge", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is acme?" })).toBe(true);
  expect(postedText()).toContain("Acme is a YSWS");
});

test("main ambient: another program's channel never reaches Acme sources", async () => {
  await send({ channel: "C_BETA_MAIN", text: "what is restoration energy?" });
  // The isolation property is which corpus was consulted, not whether a
  // message appeared: an ungrounded program question now gets an honest
  // decline rather than silence.
  expect(answerCalls[0].program).toBe("beta");
  expect(answerCalls.every((c) => c.program === "beta")).toBe(true);
});

for (const chatter of ["lmao gg", "did you finish your game?"]) {
  test(`main ambient: '${chatter}' stays silent with no retrieval, no ticket`, async () => {
    expect(await send({ channel: "C_ACME_MAIN", text: chatter })).toBe(false);
    expect(answerCalls).toHaveLength(0);
    expect(ticketCalls).toHaveLength(0);
    expect(handOffs).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
}

test("main ambient: unsupported shipping question declines without inventing coverage", async () => {
  await send({ channel: "C_ACME_MAIN", text: "does the hardware grant cover shipping?" });
  expect(answerCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(0);
  // It may decline out loud, but it must not claim shipping is or isn't covered.
  expect(postedText()).not.toMatch(/\b(shipp?ing|covered|not covered)\b/i);
});

test("a targeted clarification continues for its requester and ignores another speaker", async () => {
  const originalQuestion = "how many points do I need?";
  const threadTs = "clarification-thread";
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return args.message === "Bolts" || args.message === "Track XP"
      ? { action: "silence", intent: "human_conversation" }
      : { action: "engage", intent: "direct_program_question" };
  });
  stub(lookup, "answerOrChat", async (question: string, _ctx: string, opts: { program?: { id?: string } }) => {
    answerCalls.push({ question, program: opts.program?.id });
    return question === originalQuestion
      ? groundedFixture("Do you mean Bolts or Track XP?", "Acme Docs", opts.program?.id)
      : groundedFixture("Track XP records progress for each track.", "Acme Docs", opts.program?.id);
  });

  expect(await send({ channel: "C_ACME_MAIN", text: originalQuestion, userId: "U_REQUESTER", threadTs })).toBe(true);
  expect(postedText()).toContain("Quick clarification: Do you mean Bolts or Track XP?");
  expect(await send({ channel: "C_ACME_MAIN", text: "Track XP", userId: "U_REQUESTER", threadTs })).toBe(true);
  expect(answerCalls[1].question).toContain(originalQuestion);
  expect(answerCalls[1].question).toContain("Clarification: Track XP");
  expect(postedText()).toContain("Track XP records progress");

  const interloperThread = "clarification-interloper";
  expect(
    await send({ channel: "C_ACME_MAIN", text: originalQuestion, userId: "U_REQUESTER", threadTs: interloperThread }),
  ).toBe(true);
  expect(await send({ channel: "C_ACME_MAIN", text: "Track XP", userId: "U_OTHER", threadTs: interloperThread })).toBe(
    false,
  );
  expect(
    await send({ channel: "C_ACME_MAIN", text: "Track XP", userId: "U_REQUESTER", threadTs: interloperThread }),
  ).toBe(true);
  expect(answerCalls).toHaveLength(4);
  expect(answerCalls[3].question).toContain("Clarification: Track XP");
});

test("a clarification is asked once when the requester cannot choose", async () => {
  const threadTs = "clarification-once";
  stub(jevDecision, "evaluateSupportDecision", async () => ({
    action: "engage",
    intent: "direct_program_question",
  }));
  stub(lookup, "answerOrChat", async (_question: string, _ctx: string, opts: { program?: { id?: string } }) =>
    groundedFixture("Do you mean Bolts or Track XP?", "Acme Docs", opts.program?.id),
  );

  expect(await send({ channel: "C_ACME_MAIN", text: "how many points?", userId: "U_REQUESTER", threadTs })).toBe(true);
  // The follow-up is ambient now, so the default is a quiet reaction, not a public reply.
  expect(await send({ channel: "C_ACME_MAIN", text: "I'm not sure", userId: "U_REQUESTER", threadTs })).toBe(false);
  expect(postedText().match(/Quick clarification:/g)).toHaveLength(1);
  expect(postedText()).not.toContain("I couldn't verify that");
});

test("Loadout points ambiguity names Bolts and Track XP", async () => {
  // Same CLARIFY rule as loadout/program.json pinnedRules.
  configure({
    acme: {
      id: "loadout",
      name: "Loadout",
      pinnedRules: [
        "CLARIFY: \\bpoints?\\b | \\bbolts?\\b|\\btrack\\s*xp\\b | Do you mean Bolts (spendable currency) or Track XP (permanent progress)?",
      ],
    },
  });
  stub(jevDecision, "evaluateSupportDecision", async () => ({
    action: "engage",
    intent: "direct_program_question",
  }));
  stub(lookup, "answerOrChat", async () => ({ answer: "", source: null, unclear: true }));

  expect(await send({ channel: "C_ACME_MAIN", text: "how many points do I need?", userId: "U_REQUESTER" })).toBe(true);
  expect(postedText()).toContain("Bolts (spendable currency) or Track XP (permanent progress)");
  expect(handOffs).toHaveLength(0);
});

test("a clarification survives reseeding the thread from Slack", async () => {
  stub(context, "seedFromSlack", realSeedFromSlack);
  const originalQuestion = "how many points do I need?";
  const seedClient = client();
  seedClient.conversations.replies = async () => ({
    messages: [
      { user: "U_REQUESTER", text: originalQuestion, ts: "10.1" },
      { bot_id: "B_ORRY", text: "Quick clarification: Do you mean Bolts or Track XP?\n\nLoadout", ts: "10.2" },
    ],
  });
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return { action: "engage", intent: "direct_program_question" };
  });
  stub(lookup, "answerOrChat", async (question: string, _ctx: string, opts: { program?: { id?: string } }) => {
    answerCalls.push({ question, program: opts.program?.id });
    return groundedFixture("Track XP records progress.", "Acme Docs", opts.program?.id);
  });

  expect(
    await send({
      channel: "C_ACME_MAIN",
      text: "Track XP",
      userId: "U_REQUESTER",
      threadTs: "clarification-reseeded",
      messageTs: "10.3",
      seedClient,
    }),
  ).toBe(true);
  expect(answerCalls[0].question).toContain(originalQuestion);
  expect(answerCalls[0].question).toContain("Clarification: Track XP");
});

test("subjectless policy follow-up carries only the same requester's preceding answered question", async () => {
  const retrievalQuestions: Array<string | null> = [];
  stub(jevDecision, "evaluateSupportDecision", async () => ({
    action: "engage",
    intent: "direct_program_question",
  }));
  stub(
    lookup,
    "answerOrChat",
    async (_question: string, _ctx: string, opts: { previousQuestion?: string | null; program?: { id?: string } }) => {
      retrievalQuestions.push(opts.previousQuestion || null);
      return groundedFixture("The policy applies to hardware too.", "Acme Docs", opts.program?.id);
    },
  );

  context.addToThread("subject-followup", "user", "Can I use AI in my project?", "U1", "C_ACME_MAIN");
  context.addToThread("subject-followup", "assistant", "The program has an AI policy.", null, "C_ACME_MAIN");
  expect(
    await send({ channel: "C_ACME_MAIN", text: "what about hardware?", userId: "U1", threadTs: "subject-followup" }),
  ).toBe(true);

  context.addToThread("unrelated-followup", "user", "What is the ticket policy?", "U2", "C_ACME_MAIN");
  context.addToThread(
    "unrelated-followup",
    "assistant",
    "Tickets are handled in the help channel.",
    null,
    "C_ACME_MAIN",
  );
  expect(
    await send({
      channel: "C_ACME_MAIN",
      text: "what about hardware?",
      userId: "U1",
      threadTs: "unrelated-followup",
    }),
  ).toBe(true);

  expect(retrievalQuestions).toEqual(["Can I use AI in my project?", null]);
});

test("main ambient: exact payout is never fabricated", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is my exact payout amount right now?" });
  expect(postedText()).not.toMatch(/\d/);
});

test("main ambient: exact AI-code percentage without evidence, no number", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is the exact maximum percentage of AI code allowed?" });
  expect(postedText()).not.toMatch(/\d+\s*%/);
});

test("main ambient: 'how do i do this' with no referent stays silent", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "how do i do this" })).toBe(false);
  expect(answerCalls).toHaveLength(0);
});

test("main ambient: 'how do i do this' with a clear thread referent retrieves and answers", async () => {
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return /restoration energy/i.test(args.conversationContext)
      ? { action: "engage", intent: "ambiguous_followup" }
      : { action: "silence", intent: "ambiguous_followup" };
  });
  stub(lookup, "answerOrChat", async (question: string, ctx: string, opts: { program?: { id?: string } }) => {
    answerCalls.push({ question, program: opts.program?.id });
    return /restoration energy/i.test(ctx)
      ? groundedFixture("Restore pixels in the editor to earn it.", "Acme Docs", opts.program?.id)
      : { unclear: true };
  });
  context.addToThread("9000.000", "user", "what is restoration energy?", "U1", "C_ACME_MAIN");
  const spoke = await send({
    channel: "C_ACME_MAIN",
    text: "how do i do this",
    threadTs: "9000.000",
    messageTs: "9000.100",
  });
  expect(jevCalls[0].conversationContext).toMatch(/restoration energy/i);
  expect(spoke).toBe(true);
  expect(postedText()).toContain("Restore pixels");
});

test("main ambient: a top-level fragment is classified with the channel's last messages", async () => {
  const historyCalls: TestRecord[] = [];
  const slack = client();
  slack.conversations.history = async (args?: TestRecord) => {
    historyCalls.push(args || {});
    return {
      messages: [
        { user: "U_OTHER", text: "yo is your hackatime streak still going?", ts: "1.3" },
        { user: "U_OTHER", text: "mine's broken lol", ts: "1.2" },
        { user: "U_OLD", text: "gm", ts: "1.1" },
      ],
    };
  };
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return /streak/i.test(args.conversationContext)
      ? { action: "silence", intent: "human_conversation" }
      : { action: "engage", intent: "direct_program_question" };
  });
  const spoke = await send({ channel: "C_ACME_MAIN", text: "it expires tomorrow", seedClient: slack });
  expect(historyCalls[0]).toMatchObject({ channel: "C_ACME_MAIN", limit: 5, inclusive: false });
  expect(jevCalls[0].conversationContext).toMatch(
    /other member: gm\nother member: mine's broken lol\nother member: yo is your hackatime streak/,
  );
  expect(spoke).toBe(false);
  expect(answerCalls).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("a threaded reply uses its thread, not the channel history", async () => {
  const slack = client();
  let historyCalled = false;
  slack.conversations.history = async () => {
    historyCalled = true;
    return { messages: [] };
  };
  context.addToThread("9100.000", "user", "what is restoration energy?", "U1", "C_ACME_MAIN");
  await send({
    channel: "C_ACME_MAIN",
    text: "how do i do this",
    threadTs: "9100.000",
    messageTs: "9100.100",
    seedClient: slack,
  });
  expect(historyCalled).toBe(false);
});

test("main ambient: Jev outage falls back to the legacy intent classifier", async () => {
  jevMode = "error";
  legacyMode = "help";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(legacyCalls).toBe(1);
  expect(answerCalls[0].program).toBe("acme");
  expect(postedText()).toContain("Restoration Energy");
});

test("main ambient: message stays silent when both classifiers are unavailable", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(false);
  expect(legacyCalls).toBe(1);
  expect(answerCalls).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("main ambient: an unexpected Jev exception falls back to legacy intent", async () => {
  jevMode = "throw";
  legacyMode = "help";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(legacyCalls).toBe(1);
  expect(postedText()).toContain("Restoration Energy");
});

test("main ambient: an unexpected Vey exception falls through to Jev", async () => {
  veyMode = "throw";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(jevCalls).toHaveLength(1);
  expect(postedText()).toContain("Restoration Energy");
  expect(legacyCalls).toBe(0);
});

test("the classifier never receives documentation", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" });
  const keys = Object.keys(jevCalls[0]).sort();
  expect(keys).toEqual(["addressed", "channelPosture", "conversationContext", "message", "program"]);
});

test("addressed: program question gets the grounded answer", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
});

test("addressed URL fetch starts before classification finishes", async () => {
  let releaseClassifier: (() => void) | null = null;
  const classifierGate = new Promise<void>((resolve) => {
    releaseClassifier = resolve;
  });
  let linkStarted = false;

  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    await classifierGate;
    return { action: "engage", intent: "addressed_general_request" };
  });
  const realFetchUrlContent = link.fetchUrlContent;
  link.fetchUrlContent = async () => {
    linkStarted = true;
    releaseClassifier?.();
    return { url: "https://example.com", text: "example page content" };
  };
  stub(lookup, "answerOrChat", async (_question: string, ctx: string) => {
    expect(linkStarted).toBe(true);
    expect(ctx).toContain("example page content");
    return { answer: "I read the linked page.", source: "NONE" };
  });

  try {
    expect(
      await send({
        channel: "C_ACME_MAIN",
        text: "check this https://example.com",
        addressed: true,
      }),
    ).toBe(true);
    expect(linkStarted).toBe(true);
  } finally {
    link.fetchUrlContent = realFetchUrlContent;
  }
});

test("addressed: a cookie recipe gets a general-purpose answer", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toContain("butter");
  expect(answerCalls[0].allowWebSearch).toBe(true);
});

test("addressed: banter that @mentions Orry gets a conversational reply, not 'couldn't verify'", async () => {
  const text = "@ricky if you had to save @orry or @pixorpheus who would you save?";
  expect(await send({ channel: "C_ACME_MAIN", text, addressed: true })).toBe(true);
  expect(postedText()).toContain("Pixorpheus can swim");
  expect(postedText()).not.toMatch(/couldn't verify/i);
  expect(handOffs).toHaveLength(0);
});

test("addressed: exact payout gets transparent uncertainty, never an amount", async () => {
  expect(
    await send({ channel: "C_ACME_MAIN", text: "what is my exact payout amount right now?", addressed: true }),
  ).toBe(true);
  expect(postedText()).toMatch(/can't confirm/i);
  expect(postedText()).not.toMatch(/\$\s*\d|\d+\s*(?:usd|dollars)/i);
  expect(handOffs).toHaveLength(0);
});

test("addressed: program questions never use web search", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true });
  expect(answerCalls[0].allowWebSearch).toBe(false);
});

test("addressed: classifier outage still answers, docs or not", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
  posts = [];
  expect(await send({ channel: "C_ACME_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toContain("bake at 180C");
  expect(postedText()).not.toMatch(/couldn't verify/i);
});

test("addressed: 'who are you' needs no classifier call", async () => {
  stub(lookup, "answerOrChat", async () => ({ answer: "I'm Orry!", source: "NONE" }));
  expect(await send({ channel: "C_ACME_MAIN", text: "who are you?", addressed: true })).toBe(true);
  expect(jevCalls).toHaveLength(0);
});

test("help: a known question opens a ticket and gets the grounded reply; ticket stays open", async () => {
  expect(await send({ channel: "C_ACME_HELP", text: "my submission got rejected, how do i resubmit?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(ticketCalls[0].role).toBe("help");
  expect(postedText()).toContain("resubmit");
  expect(handOffs).toHaveLength(0);
});

test("help: an unknown personal question opens a ticket and hands to a helper without hallucinating", async () => {
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
  expect(handOffs[0].requesterId).toMatch(/^U_REQ_/);
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toMatch(/couldn't verify|can't confirm|helper/i);
  expect(posts[0].text).not.toMatch(/your personal grant code is/i);
});

test("help: chatter creates no ticket and pings nobody", async () => {
  for (const t of ["lmao gg", "did you finish your game?"]) {
    await send({ channel: "C_ACME_HELP", text: t });
  }
  expect(ticketCalls).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("help: classifier outage preserves the support path (ticket + helper)", async () => {
  jevMode = "error";
  await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" });
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
});

test("help: 'how do i do this' with no referent never fabricates", async () => {
  jevMode = "error";
  await send({ channel: "C_ACME_HELP", text: "how do i do this" });
  expect(posts).toHaveLength(0);
  expect(handOffs).toHaveLength(1);
});

test("help: a thread reply does not open a second ticket", async () => {
  await send({
    channel: "C_ACME_HELP",
    text: "how do i get my personal grant code?",
    threadTs: "7000.000",
    messageTs: "7000.500",
  });
  expect(ticketCalls).toHaveLength(0);
});

const MATRIX: Array<[string, TestRecord, string, string, boolean, MatrixWant]> = [
  [
    "main disabled: silent even when addressed",
    { main: { enabled: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "ambient off: ambient question silent, no classifier",
    { main: { ambientProgramReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    false,
    { spoke: false, answer: 0, jev: 0 },
  ],
  [
    "ambient off: addressed still answered",
    { main: { ambientProgramReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: true },
  ],
  [
    "mention replies off: addressed silent",
    { main: { mentionReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "general chat off: addressed chatter is silent",
    { main: { generalMentionChat: false } },
    "C_ACME_MAIN",
    "give me a chocolate chip cookie recipe",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "main escalation on: ambient unknown hands to helper",
    { main: { helperEscalationEnabled: true } },
    "C_ACME_MAIN",
    "does the hardware grant cover shipping?",
    false,
    { spoke: true, handoff: 1 },
  ],
  [
    "help disabled: silent",
    { help: { enabled: false } },
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { spoke: false, ticket: 0, handoff: 0 },
  ],
  [
    "help AI off: no model call, ticket + helper",
    { help: { aiReplies: false } },
    "C_ACME_HELP",
    "my submission got rejected, how do i resubmit?",
    false,
    { answer: 0, ticket: 1, handoff: 1 },
  ],
  [
    "help escalate off: unknown stays silent, ticket still recorded",
    { help: { escalateUnknown: false } },
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { spoke: false, ticket: 1, handoff: 0 },
  ],
  [
    "help escalate on: unknown handed off",
    {},
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { ticket: 1, handoff: 1 },
  ],
];

for (const [name, behavior, channel, text, addressed, want] of MATRIX) {
  test(`matrix: ${name}`, async () => {
    configure({ acme: { behavior } });
    const spoke = await send({ channel, text, addressed });
    if ("spoke" in want) expect(spoke).toBe(want.spoke);
    if ("ticket" in want) expect(ticketCalls).toHaveLength(want.ticket);
    if ("handoff" in want) expect(handOffs).toHaveLength(want.handoff);
    if ("answer" in want) expect(answerCalls).toHaveLength(want.answer);
    if ("jev" in want) expect(jevCalls).toHaveLength(want.jev);
    if (want.text) expect(postedText()).toMatch(want.text);
  });
}

test("paused program: silent in main and help, even when addressed", async () => {
  configure({ acme: { status: "paused" } });
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(false);
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(false);
  expect(ticketCalls).toHaveLength(0);
  expect(jevCalls).toHaveLength(0);
});

test("sandbox program runs the same pipeline as live", async () => {
  configure({ acme: { status: "sandbox" } });
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(handOffs).toHaveLength(1);
});

test("organizer channel: never volunteers, answers when addressed, files no tickets", async () => {
  expect(await send({ channel: "C_ACME_ORG", text: "what is restoration energy?" })).toBe(false);
  expect(jevCalls).toHaveLength(0);
  expect(await send({ channel: "C_ACME_ORG", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
  posts = [];
  expect(await send({ channel: "C_ACME_ORG", text: "how do i get my personal grant code?", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toMatch(/can't confirm/i);
  expect(ticketCalls).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
});

test("ambient engage without a named intent never pulls a human in, even with escalation on", async () => {
  configure({ acme: { behavior: { main: { helperEscalationEnabled: true } } } });
  stub(jevDecision, "evaluateSupportDecision", async () => ({ action: "engage", intent: null }));
  expect(await send({ channel: "C_ACME_MAIN", text: "hmm is the thing broken" })).toBe(false);
  expect(handOffs).toHaveLength(0);
});

test("unclaimed channel: total silence even when addressed via message", async () => {
  expect(await send({ channel: "C_NOBODY", text: "what is restoration energy?" })).toBe(false);
  expect(jevCalls).toHaveLength(0);
});

test("conversationContextFor labels speakers, keeps order, and appends the thread", () => {
  const { conversationContextFor } = require("./engagement");
  const ctx = conversationContextFor({
    userId: "U_ME",
    recentMessages: [
      { speaker: "human", userId: "U_ME", text: "my code  came through" },
      { speaker: "orry", userId: "U_BOT", text: "nice" },
      { speaker: "human", userId: "U_X", text: "x".repeat(500) },
    ],
    threadContext: "user: hi",
  });
  const lines = ctx.split("\n");
  expect(lines[0]).toBe("Recent channel messages:");
  expect(lines[1]).toBe("same sender: my code came through");
  expect(lines[2]).toBe("orry: nice");
  expect(lines[3].length).toBeLessThanOrEqual("other member: ".length + 200);
  expect(ctx.endsWith("Thread:\nuser: hi")).toBe(true);
  expect(conversationContextFor({ recentMessages: [], threadContext: "" })).toBe("");
});
export {};
