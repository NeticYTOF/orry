const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const lookup = require("./lookup");
const programs = require("./programs");

db.open(":memory:");

const PROG = {
  id: "t-timeline",
  name: "Timeline Test",
  milestones: [{ name: "Timeline Test launch", date: "2020-01-15" }],
};

test("dateFallback answers a timing question from the program's milestones", () => {
  const result = lookup.dateFallback("is timeline test out yet", "", PROG);
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
  assert.match(result.answer, /January 15, 2020/);
});

test("dateFallback accepts a bare program id as well as a record", () => {
  programs.saveProgram(PROG);
  programs.invalidate();
  const result = lookup.dateFallback("has timeline test launched", "", "t-timeline");
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
});

test("dateFallback returns null for a question that isn't about timing", () => {
  assert.equal(lookup.dateFallback("how do i center a div", "", PROG), null);
});

test("dateFallback falls back to the shared timeline with no program", () => {
  assert.doesNotThrow(() => lookup.dateFallback("when does it drop", "", null));
});

test("idOf accepts a record, an id, or nothing", () => {
  assert.equal(lookup.idOf({ id: "acme", name: "Acme" }), "acme");
  assert.equal(lookup.idOf("acme"), "acme");
  assert.equal(lookup.idOf(null), null);
  assert.equal(lookup.idOf({ name: "no id" }), null);
});

test("retrievalQuery augments follow-up questions with program name and thread context", () => {
  const context = "User: what is acme and how does it work\nAssistant: acme is a configured program.";
  const augmented = lookup.retrievalQuery("how does it work", context, { id: "acme", name: "Acme" });
  assert.match(augmented, /Acme/);
  assert.match(augmented, /what is acme and how does it work/);
});

test("retrievalQuery leaves standalone non-follow-up questions intact", () => {
  const standalone = "how do I configure a controller?";
  const result = lookup.retrievalQuery(standalone, "", { id: "acme", name: "Acme" });
  assert.equal(result, standalone);
});

test("a correction asking what this YSWS is resolves to the current program FAQ", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = {
    evidence: knowledge.getEvidenceContext,
    eligibility: knowledge.sourceEligibility,
    verify: answer.verifyGrounding,
  };
  const passage = {
    id: "loadout-faq",
    programId: "loadout-test",
    kind: "source",
    source: "Loadout FAQ",
    text: "**What is Loadout?** A technical builder YSWS where shipped projects become a persistent Digital Loadout.",
  };
  let coverageQuestion = "";
  knowledge.getEvidenceContext = (query: string) => ({ passages: /What is Loadout/i.test(query) ? [passage] : [] });
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  answer.verifyGrounding = async (
    claims: Array<{ claim: string; evidenceIds: string[] }>,
    _evidence: unknown,
    _program: unknown,
    _channel: unknown,
    options: { requestCoverage?: { question?: string } },
  ) => {
    coverageQuestion = options.requestCoverage?.question || "";
    return {
      ok: true,
      verdict: "supported",
      coverage: true,
      errors: [],
      claims: claims.map((claim) => ({ ...claim, supported: true, evidenceIds: ["loadout-faq"] })),
    };
  };
  try {
    const result = await lookup.answerOrChat(
      "no i meant what thsi ysws is",
      "Previous conversation:\nUser: what is ysws",
      {
        program: {
          id: "loadout-test",
          name: "Loadout",
          sharedSources: false,
          sources: [{ name: "Loadout FAQ", type: "markdown" }],
        },
        skipCache: true,
      },
    );
    assert.match(result.answer, /technical builder YSWS/);
    assert.equal(coverageQuestion, "What is Loadout?");
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    knowledge.sourceEligibility = original.eligibility;
    answer.verifyGrounding = original.verify;
  }
});

test("answerOrChat uses a preceding answered question for retrieval, not the answer prompt", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = { evidence: knowledge.getEvidenceContext, answer: answer.getAnswerOrChat };
  let retrievalQuery = "";
  let answerQuestion = "";
  const contextPrompt =
    "Previous conversation:\nuser: Can I use AI in my project?\nassistant: The program has an AI policy.\nuser: what about hardware?";
  knowledge.getEvidenceContext = (query: string) => {
    retrievalQuery = query;
    return { passages: [] };
  };
  answer.getAnswerOrChat = async (question: string) => {
    answerQuestion = question;
    return { answer: "", source: null };
  };
  try {
    await lookup.answerOrChat("what about hardware?", contextPrompt, {
      program: { id: "acme", name: "Acme", sharedSources: false, sources: [] },
      previousQuestion: "Can I use AI in my project?",
      skipCache: true,
    });
    assert.match(retrievalQuery, /Can I use AI in my project\?/);
    assert.match(retrievalQuery, /what about hardware\?/);
    assert.equal(answerQuestion, "what about hardware?");
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    answer.getAnswerOrChat = original.answer;
  }
});

test("answerOrChat forwards the explicit general-answer mode", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = { evidence: knowledge.getEvidenceContext, answer: answer.getAnswerOrChat };
  let received: Record<string, unknown> | null = null;
  knowledge.getEvidenceContext = () => ({ passages: [] });
  answer.getAnswerOrChat = async (
    _question: string,
    _corpus: string,
    _context: string,
    _help: boolean,
    _program: unknown,
    _channel: string,
    options: Record<string, unknown>,
  ) => {
    received = options;
    return { source: null, answer: "Use the project-local TypeScript compiler." };
  };
  try {
    await lookup.answerOrChat("how do I typecheck this?", "", {
      program: { id: "loadout", name: "Loadout", requireGroundedAnswer: true },
      answerMode: "general",
      skipCache: true,
    });
    assert.equal(received?.answerMode, "general");
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    answer.getAnswerOrChat = original.answer;
  }
});

test("an unclear answer carries the closest retrieved program source for the helper reply", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = {
    evidence: knowledge.getEvidenceContext,
    sourceUrl: knowledge.getSourceUrl,
    answer: answer.getAnswerOrChat,
  };
  knowledge.getEvidenceContext = () => ({
    passages: [
      { id: "p1", source: "Loadout — rewards", text: "Reward details", kind: "source" },
      { id: "p2", source: "About Orry", text: "Orry lore", kind: "generated" },
    ],
  });
  knowledge.getSourceUrl = (name: string) => (name === "Loadout — rewards" ? "https://example.org/rewards" : null);
  answer.getAnswerOrChat = async () => ({ source: null, answer: "", unclear: true });
  try {
    const result = await lookup.answerOrChat("what is the prize amount?", "", {
      program: {
        id: "loadout",
        name: "Loadout",
        requireGroundedAnswer: true,
        sources: [{ name: "Loadout — rewards", siteUrl: "https://example.org/rewards" }],
      },
      skipCache: true,
    });
    assert.deepEqual(result?.suggestedSource, {
      name: "Loadout — rewards",
      url: "https://example.org/rewards",
    });
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    knowledge.getSourceUrl = original.sourceUrl;
    answer.getAnswerOrChat = original.answer;
  }
});

test("helper source suggestions never reveal a hidden document", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = { evidence: knowledge.getEvidenceContext, answer: answer.getAnswerOrChat };
  knowledge.getEvidenceContext = () => ({
    passages: [{ id: "p-hidden", source: "Private organizer notes", text: "internal", kind: "source" }],
  });
  answer.getAnswerOrChat = async () => ({ source: null, answer: "", unclear: true });
  try {
    const result = await lookup.answerOrChat("what is the exact award?", "", {
      program: {
        id: "loadout",
        name: "Loadout",
        requireGroundedAnswer: true,
        sources: [{ name: "Private organizer notes", hidden: true, siteUrl: "https://example.org/private" }],
      },
      skipCache: true,
    });
    assert.equal(result?.suggestedSource, null);
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    answer.getAnswerOrChat = original.answer;
  }
});

test("general mode still rejects an unsupported authoritative Loadout fact", async () => {
  assert.equal(
    lookup.applyGroundingBoundary(
      { source: null, answer: "The grant is $1,000." },
      { id: "loadout", name: "Loadout", requireGroundedAnswer: true, sources: [] },
      "how much is the grant amount?",
    ),
    null,
  );
});

test("a rejected program fact in general mode becomes a useful uncertainty handoff", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = { evidence: knowledge.getEvidenceContext, answer: answer.getAnswerOrChat };
  knowledge.getEvidenceContext = () => ({
    passages: [{ id: "p-grant", source: "Loadout — rewards", text: "Grant details vary.", kind: "source" }],
  });
  answer.getAnswerOrChat = async () => ({ source: null, answer: "The grant is $1,000." });
  try {
    const result = await lookup.answerOrChat("how much is the grant amount?", "", {
      answerMode: "general",
      program: {
        id: "loadout",
        name: "Loadout",
        requireGroundedAnswer: true,
        sources: [{ name: "Loadout — rewards", siteUrl: "https://example.org/rewards" }],
      },
      skipCache: true,
    });
    assert.equal(result?.unclear, true);
    assert.equal(result?.answer, "");
    assert.deepEqual(result?.suggestedSource, {
      name: "Loadout — rewards",
      url: "https://example.org/rewards",
    });
  } finally {
    knowledge.getEvidenceContext = original.evidence;
    answer.getAnswerOrChat = original.answer;
  }
});

test("stale dynamic sources cannot authorize an exact answer", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: false });
  try {
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Current policy", answer: "18%" },
        { id: "acme", sources: [{ name: "Current policy", type: "dynamic" }] },
      ),
      null,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("answers cached from a stale dynamic source are bypassed", () => {
  const cache = require("./cache");
  const knowledge = require("./knowledge");
  const source = { name: "Current policy", type: "url", dynamic: true, url: "https://example.invalid/policy" };
  const program = { id: "stale-cache-program", name: "Stale cache", sources: [source], sharedSources: false };
  const originalProgram = programs.get;
  const originalShared = programs.shared;
  const originalEligibility = knowledge.sourceEligibility;
  const question = "what is the current policy?";
  cache.put(question, { source: source.name, answer: "old policy" }, undefined, program.id);
  programs.get = (id: string) => (id === program.id ? program : null);
  programs.shared = () => ({ id: "shared", sources: [], milestones: [] });
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: false });
  try {
    assert.equal(lookup.cacheHit(question, "", program.id), null);
  } finally {
    programs.get = originalProgram;
    programs.shared = originalShared;
    knowledge.sourceEligibility = originalEligibility;
    cache.forget(cache.keyFor(question, program.id));
  }
});

test("grounding rejects related policy evidence and malformed fenced verdicts", () => {
  assert.equal(
    lookup.exactClaimAllowed(
      {
        source: "Policy",
        groundingVerdict: {
          verdict: "supported",
          claims: [{ claim: "18% is allowed", supported: true, evidenceIds: ["policy"] }],
        },
        evidence: [{ id: "policy", programId: "acme", supportsClaims: ["18% is allowed for another case"] }],
      },
      { id: "acme", sources: [] },
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: "Policy", groundingVerdict: "```json\n{ malformed\n```" },
      { id: "acme", sources: [] },
    ),
    false,
  );
});

test("isAuthoritativeOnlyTopic flags review, hours, AI, and money/fulfillment questions", () => {
  const yes = [
    "will learning Java count in the hours of making an MC mod?",
    "can I journal hand-drawn art?",
    "how long will second review take?",
    "what exactly is first pass?",
    "is my project in the fraud review queue?",
    "why is my project still waiting on review?",
    "how much AI can I use?",
    "when is the exact payout amount going to land?",
    "what's my order status",
  ];
  for (const q of yes) assert.equal(lookup.isAuthoritativeOnlyTopic(q), true, q);

  const no = [
    "what is Acme?",
    "how do I connect hackatime?",
    "where are the docs?",
    "is Acme open to people aged 13-18?",
  ];
  for (const q of no) assert.equal(lookup.isAuthoritativeOnlyTopic(q), false, q);
});

test("fixture B/D: an authoritative-only question with no matched source is rejected, never answered from prior knowledge", () => {
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "yeah learning Java definitely counts toward your project hours" },
      prog,
      "will learning Java count in the hours of making an MC mod?",
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "second review usually takes about 3 to 5 days" },
      prog,
      "how long will second review take?",
    ),
    false,
  );
});

test("fixture E: a matched source authorizes only the exact number it contains, never an invented one alongside it", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  const corpus =
    "Acme Docs\nReview: no fixed SLA is published; review can take anywhere from a few days to about two weeks.";
  try {
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "Acme Docs", answer: "second review usually takes exactly 5 days" },
        prog,
        "how long will second review take?",
        corpus,
      ),
      false,
      "an invented digit-count SLA must be rejected even with a matched source",
    );
    assert.equal(
      lookup.exactClaimAllowed(
        {
          source: "Acme Docs",
          answer: "there's no fixed SLA — it can take anywhere from a few days to about two weeks",
        },
        prog,
        "how long will second review take?",
        corpus,
      ),
      true,
      "restating exactly what the source says (with no invented digit claim) must be allowed",
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("numericClaimsGrounded rejects invented digit-bearing claims and allows ones the corpus actually states", () => {
  assert.equal(
    lookup.numericClaimsGrounded("your project has an 80% chance of passing", "nothing here about odds"),
    false,
  );
  assert.equal(
    lookup.numericClaimsGrounded("software is capped at 30% AI", "the AI policy caps software code at 30% AI usage"),
    true,
  );
  assert.equal(
    lookup.numericClaimsGrounded("that sounds right to me", "irrelevant corpus text"),
    true,
    "no numeric claim at all is always fine",
  );
  assert.equal(lookup.numericClaimsGrounded("80% chance", ""), true, "no corpus supplied is a no-op, not a reject");
});

test("numericClaimsGrounded reads a dollar amount without its sentence punctuation", () => {
  assert.equal(
    lookup.numericClaimsGrounded("The prize is $500.", "The prize is $500 total"),
    true,
    "the period ends the sentence, so the claim is $500",
  );
  assert.equal(
    lookup.numericClaimsGrounded("The prize is $500.", "nothing about prizes"),
    false,
    "$500 is still recognized as a numeric claim and rejected when uncited",
  );
  assert.equal(
    lookup.numericClaimsGrounded("You get $1,000, plus bonuses.", "You get $1,000 total"),
    true,
    "the comma after $1,000 is not part of the amount",
  );
  assert.equal(
    lookup.numericClaimsGrounded("You get $1,000, plus bonuses.", "You get $100 total"),
    false,
    "$1,000 is still recognized as a numeric claim and rejected when uncited",
  );
});

test("verified answers keep evidence internally without listing sources", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = knowledge.sourceEligibility;
  const originalVerify = answer.verifyGrounding;
  let verifiedClaims: string[] = [];
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => {
    verifiedClaims = claims.map(({ claim }) => claim);
    return {
      ok: true,
      verdict: claims.some(({ claim }) => /Track XP is capped/i.test(claim)) ? "unsupported" : "supported",
      coverage: true,
      errors: [],
      claims: claims.map((claim) => ({ ...claim, supported: !/Track XP is capped/i.test(claim.claim) })),
    };
  };
  const program = {
    id: "citing-acme",
    sharedSources: false,
    sources: [{ name: "Program rules", type: "markdown", siteUrl: "https://example.org/rules" }],
  };
  const passages = [
    {
      id: "passage-1",
      programId: "citing-acme",
      kind: "source",
      source: "Program rules",
      heading: "Track XP",
      text: "Track XP is permanent and cannot be spent. Each track records its own progress.",
    },
  ];
  try {
    const partial = await lookup.applyPassageCitations(
      {
        source: "Program rules",
        answer: "Track XP is permanent. [E1] Each track records its own progress. [E1]",
        personality: "Ja, ja, that's a gem of an answer!",
        unresolved: ["whether it can be spent"],
      },
      passages,
      program,
    );
    assert.equal(
      partial.answer,
      "Track XP is permanent. Each track records its own progress.\n\nI couldn't confirm whether it can be spent in the docs, so I can't answer those parts.\n\nJa, ja, that's a gem of an answer!",
    );
    assert.deepEqual(verifiedClaims, ["Track XP is permanent.", "Each track records its own progress."]);
    assert.match(partial.answer, /couldn't confirm whether it can be spent/);
    assert.doesNotMatch(partial.answer, /Program rules|example\.org/);
    assert.equal(partial.source, "Program rules");
    assert.deepEqual(partial.passageCitations, ["passage-1"]);

    assert.equal(
      await lookup.applyPassageCitations(
        {
          source: "Program rules",
          answer: "You can spend 40 points [E1].",
        },
        passages,
        program,
      ),
      null,
    );
    assert.equal(
      await lookup.applyPassageCitations(
        {
          source: "Program rules",
          answer: "Track XP is capped at 40% [E1].",
        },
        [{ ...passages[0], text: "AI use is capped at 40% of code." }],
        program,
      ),
      null,
    );
    assert.equal(
      await lookup.applyPassageCitations(
        {
          source: "Program rules",
          answer: "Track XP is permanent [E1].",
        },
        [{ ...passages[0], programId: "another-program" }],
        program,
      ),
      null,
    );
  } finally {
    knowledge.sourceEligibility = original;
    answer.verifyGrounding = originalVerify;
  }
});

test("uncited claims get verifier-selected passage IDs and compound omissions fail closed", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const original = { eligibility: knowledge.sourceEligibility, verify: answer.verifyGrounding };
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  let coverageRequest: unknown;
  const prog = { id: "coverage-acme", sharedSources: false, sources: [] };
  const passages = [
    {
      id: "timeline-1",
      programId: "coverage-acme",
      kind: "generated",
      source: "Program timeline",
      heading: "Dates",
      text: "Applications close on June 1. Results arrive on July 1.",
    },
  ];
  try {
    answer.verifyGrounding = async (
      claims: Array<{ claim: string; evidenceIds: string[] }>,
      _evidence: unknown,
      _program: unknown,
      _channel: unknown,
      options: unknown,
    ) => {
      coverageRequest = (options as { requestCoverage?: unknown }).requestCoverage;
      return {
        ok: true,
        verdict: "supported",
        coverage: true,
        errors: [],
        claims: claims.map(({ claim }) => ({ claim, supported: true, evidenceIds: ["timeline-1"] })),
      };
    };
    const result = await lookup.applyPassageCitations(
      { source: "Program timeline", answer: "Applications close June 1." },
      passages,
      prog,
      "When do applications close and when do results arrive?",
      "When is the program deadline?",
    );
    assert.equal(result.answer, "Applications close June 1.");
    assert.doesNotMatch(result.answer, /Program timeline|Dates/);
    assert.deepEqual(result.passageCitations, ["timeline-1"]);
    assert.deepEqual(coverageRequest, {
      question: "When do applications close and when do results arrive?",
      contextQuestion: "When is the program deadline?",
      unresolved: [],
    });
    answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
      ok: true,
      verdict: "supported",
      coverage: false,
      errors: [],
      claims: claims.map(({ claim }) => ({ claim, supported: true, evidenceIds: ["timeline-1"] })),
    });
    assert.equal(
      await lookup.applyPassageCitations(
        { source: "Program timeline", answer: "Applications close June 1.", unresolved: [] },
        passages,
        prog,
        "When do applications close and when do results arrive?",
      ),
      null,
    );
  } finally {
    knowledge.sourceEligibility = original.eligibility;
    answer.verifyGrounding = original.verify;
  }
});

test("partial answers extract an explicit uncertainty clause and decline only that question part", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
    ok: true,
    verdict: "unsupported",
    coverage: true,
    errors: [],
    claims: claims.map(({ claim, evidenceIds }) => ({
      claim,
      supported: /netic.{0,40}orry|orry.{0,40}netic/i.test(claim),
      evidenceIds: /netic.{0,40}orry|orry.{0,40}netic/i.test(claim) ? ["identity-1"] : evidenceIds,
    })),
  });
  try {
    const result = await lookup.applyPassageCitations(
      {
        source: "About Orry",
        answer:
          "Orry the ore Maulwürf was built by Netic :meffmoney: and honestly no clue on approval status — that's not something i can see :thonk: a maintainer in the program would know better",
      },
      [
        {
          id: "identity-1",
          programId: "partial-program",
          kind: "generated",
          source: "About Orry",
          text: "Netic built Orry the ore Maulwürf.",
        },
      ],
      { id: "partial-program", sharedSources: false, sources: [] },
      "Who built Orry the ore Maulwürf, and what is my project's approval status?",
    );
    assert.match(result.answer, /Orry the ore Maulwürf was built by Netic/);
    assert.match(result.answer, /couldn't confirm this part: “what is my project's approval status”/);
    assert.doesNotMatch(result.answer, /honestly no clue|not something i can see/);
    assert.deepEqual(result.passageCitations, ["identity-1"]);

    const explicitUnresolved = await lookup.applyPassageCitations(
      {
        source: "About Orry",
        answer:
          "Orry the ore Maulwürf was built by Netic :meffmoney: as for your project's approval status, that's not something i can see from here.",
        unresolved: ["my project's approval status"],
      },
      [
        {
          id: "identity-1",
          programId: "partial-program",
          kind: "generated",
          source: "About Orry",
          text: "Netic built Orry the ore Maulwürf.",
        },
      ],
      { id: "partial-program", sharedSources: false, sources: [] },
      "Who built Orry the ore Maulwürf, and what is my project's approval status?",
    );
    assert.match(explicitUnresolved.answer, /Orry the ore Maulwürf was built by Netic/);
    assert.match(explicitUnresolved.answer, /couldn't confirm my project's approval status/);
    assert.doesNotMatch(explicitUnresolved.answer, /that's not something i can see/);
  } finally {
    answer.verifyGrounding = originalVerify;
  }
});

function ownedFresh() {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  return original;
}

test("an exact percentage with no percentage in the corpus is rejected", () => {
  const original = ownedFresh();
  try {
    const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
    const corpus = "Acme Docs\nAI policy is documented qualitatively; ask a helper for the current numbers.";
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "The exact maximum is 30%." },
        prog,
        "what is the exact maximum percentage of AI code allowed?",
        corpus,
      ),
      null,
    );
  } finally {
    require("./knowledge").sourceEligibility = original;
  }
});

test("an unknown payout amount is never fabricated, a documented one passes", () => {
  const original = ownedFresh();
  try {
    const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
    const thinCorpus = "Acme Docs\nPayouts are calculated from approved hours; amounts vary by tier.";
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "Your payout is $50." },
        prog,
        "what is my exact payout amount?",
        thinCorpus,
      ),
      null,
      "a $50 figure from nowhere must be rejected",
    );
    const richCorpus = "Acme Docs\nPayouts are calculated from approved hours; the base tier pays out $50.";
    assert.ok(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "The base tier pays out $50." },
        prog,
        "what is my exact payout amount?",
        richCorpus,
      ),
      "the same figure stated in the corpus must be allowed",
    );
  } finally {
    require("./knowledge").sourceEligibility = original;
  }
});

test("deterministic dispatch reaches validator before retrieval", async () => {
  const order: string[] = [];
  const validator = require("./validator");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const orig = {
    val: validator.validateRepository,
    ctx: knowledge.getEvidenceContext,
    ans: answer.getAnswerOrChat,
  };
  validator.validateRepository = async (..._a: unknown[]) => {
    order.push("validator");
    return null;
  };
  knowledge.getEvidenceContext = () => {
    order.push("retrieval");
    return { context: "", passages: [] };
  };
  answer.getAnswerOrChat = async () => {
    order.push("answer");
    return null;
  };
  try {
    await lookup.answerOrChat("can you check https://github.com/u/r for submission readiness", "", {
      program: { id: "acme", name: "Acme" },
    });
    assert.deepEqual(order, ["validator", "retrieval", "answer"]);
  } finally {
    validator.validateRepository = orig.val;
    knowledge.getEvidenceContext = orig.ctx;
    answer.getAnswerOrChat = orig.ans;
  }
});

test("Firecrawl web fires only inside answerOrChat with allowWebSearch", async () => {
  const firecrawl = require("./firecrawl");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  let webCalls = 0;
  const origSearch = firecrawl.searchWeb;
  const origCtx = knowledge.getEvidenceContext;
  const origChat = answer.getAnswerOrChat;
  const origGrounded = answer.getGroundedAnswer;
  firecrawl.searchWeb = async () => {
    webCalls += 1;
    return [];
  };
  knowledge.getEvidenceContext = () => ({ context: "", passages: [] });
  answer.getAnswerOrChat = async () => ({ source: null, answer: "" });
  answer.getGroundedAnswer = async () => null;
  try {
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: false });
    assert.equal(webCalls, 0, "no web without explicit allowWebSearch");
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: true });
    assert.equal(webCalls, 1, "answerOrChat-only web fallback");
    await lookup.lookupAnswer("obscure question xyzzy", "");
    assert.equal(webCalls, 1, "lookupAnswer (docs-only path) never touches the web");
  } finally {
    firecrawl.searchWeb = origSearch;
    knowledge.getEvidenceContext = origCtx;
    answer.getAnswerOrChat = origChat;
    answer.getGroundedAnswer = origGrounded;
  }
});

test("cache key includes the program (no cross-program leakage)", () => {
  const cache = require("./cache");
  cache.put("same question everywhere", { source: "Docs", answer: "prog-a answer" }, "prog-a");
  try {
    assert.equal(cache.get("same question everywhere", "prog-b"), null);
    assert.ok(cache.get("same question everywhere", "prog-a"));
  } finally {
    cache.clear?.();
  }
});

test("an end-date question reaches retrieval and the answer model, not a canned reply", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const orig = { ctx: knowledge.getEvidenceContext, ans: answer.getAnswerOrChat, verify: answer.verifyGrounding };
  const prog = { id: "enddate-prog", name: "EndDate", milestones: [], sharedSources: false };
  const seen: string[] = [];
  knowledge.getEvidenceContext = (_q: string) => {
    seen.push("retrieval");
    return {
      context: "",
      passages: [
        {
          id: "evidence-1",
          programId: "enddate-prog",
          kind: "generated",
          source: "EndDate facts",
          heading: "Timeline",
          text: "The final end date is January 1, 2027.",
        },
      ],
    };
  };
  answer.getAnswerOrChat = async () => {
    seen.push("answer");
    return { answer: "The final end date is January 1, 2027 [E1].", source: "EndDate facts" };
  };
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
    ok: true,
    verdict: "supported",
    coverage: true,
    errors: [],
    claims: claims.map((claim) => ({ ...claim, supported: true })),
  });
  try {
    const result = await lookup.answerOrChat("when does it end?", "", { program: prog, skipCache: true });
    assert.deepEqual(seen, ["retrieval", "answer"]);
    assert.doesNotMatch(result.answer, /4 months|No official/);
  } finally {
    knowledge.getEvidenceContext = orig.ctx;
    answer.getAnswerOrChat = orig.ans;
    answer.verifyGrounding = orig.verify;
  }
});
function sentenceGroundingFixture(id: string, programId: string) {
  const knowledge = require("./knowledge");
  const passages = [
    {
      id,
      programId,
      kind: "source",
      source: "Shop rules",
      heading: "Bolts",
      text: "Bolts are spendable on shop items. Track XP is permanent. Dogs are not sold here.",
    },
  ];
  const prog = { id: programId, sharedSources: false, sources: [{ name: "Shop rules", type: "markdown" }] };
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  return { passages, prog, restore: () => (knowledge.sourceEligibility = original) };
}

test("a sentence containing e.g. stays whole and each cited sentence is verified on its own", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  const { passages, prog, restore } = sentenceGroundingFixture("bolt-1", "shop-whole");
  const verified: string[] = [];
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => {
    verified.push(...claims.map(({ claim }) => claim));
    return {
      ok: true,
      verdict: "supported",
      coverage: true,
      errors: [],
      claims: claims.map((claim) => ({ ...claim, supported: true, evidenceIds: ["bolt-1"] })),
    };
  };
  try {
    const result = await lookup.applyPassageCitations(
      {
        source: "Shop rules",
        answer: "Bolts (e.g. shop items) are spendable [E1]. Track XP is permanent [E1].",
      },
      passages,
      prog,
    );
    assert.deepEqual(verified, ["Bolts (e.g. shop items) are spendable.", "Track XP is permanent."]);
    assert.equal(result.answer, "Bolts (e.g. shop items) are spendable. Track XP is permanent.");
    assert.doesNotMatch(result.answer, /couldn't confirm/);
  } finally {
    restore();
    answer.verifyGrounding = originalVerify;
  }
});

test("'There is no official deadline' and 'check in on the FAQ' are kept when the docs support them", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  const { passages, prog, restore } = sentenceGroundingFixture("faq-1", "faq-wording");
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
    ok: true,
    verdict: "supported",
    coverage: true,
    errors: [],
    claims: claims.map((claim) => ({ ...claim, supported: true, evidenceIds: ["faq-1"] })),
  });
  try {
    const deadline = await lookup.applyPassageCitations(
      { source: "Shop rules", answer: "There is no official deadline [E1]." },
      passages,
      prog,
    );
    assert.equal(deadline.answer, "There is no official deadline.");
    const checkIn = await lookup.applyPassageCitations(
      { source: "Shop rules", answer: "check in on the FAQ [E1]." },
      passages,
      prog,
    );
    assert.equal(checkIn.answer, "check in on the FAQ.");
  } finally {
    restore();
    answer.verifyGrounding = originalVerify;
  }
});

test("one unsupported sentence out of three keeps the other two with an UNRESOLVED note", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  const { passages, prog, restore } = sentenceGroundingFixture("bolt-2", "shop-partial");
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
    ok: true,
    verdict: "supported",
    coverage: true,
    errors: [],
    claims: claims.map((claim) => ({
      ...claim,
      supported: !/Dogs/.test(claim.claim),
      evidenceIds: ["bolt-2"],
    })),
  });
  try {
    const result = await lookup.applyPassageCitations(
      {
        source: "Shop rules",
        answer: "Bolts are spendable [E1]. Dogs can fly [E1]. Track XP is permanent [E1].",
      },
      passages,
      prog,
      "what can I buy with bolts and can dogs fly?",
    );
    assert.equal(
      result.answer,
      "Bolts are spendable. Track XP is permanent.\n\nI couldn't confirm this part: “Dogs can fly” in the docs, so I can't answer those parts.",
    );
    assert.deepEqual(result.passageCitations, ["bolt-2"]);
  } finally {
    restore();
    answer.verifyGrounding = originalVerify;
  }
});

test("when no factual sentence is supported the whole answer still falls back", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  const { passages, prog, restore } = sentenceGroundingFixture("bolt-3", "shop-none");
  answer.verifyGrounding = async (claims: Array<{ claim: string; evidenceIds: string[] }>) => ({
    ok: true,
    verdict: "unsupported",
    coverage: true,
    errors: [],
    claims: claims.map((claim) => ({ ...claim, supported: false, evidenceIds: [] })),
  });
  try {
    assert.equal(
      await lookup.applyPassageCitations(
        { source: "Shop rules", answer: "Dogs can fly [E1]. Bolts are free [E1]." },
        passages,
        prog,
      ),
      null,
    );
  } finally {
    restore();
    answer.verifyGrounding = originalVerify;
  }
});

test("a verifier that throws or times out accepts sentences whose citations resolve, and drops uncited ones", async () => {
  const answer = require("./answer");
  const originalVerify = answer.verifyGrounding;
  const { passages, prog, restore } = sentenceGroundingFixture("bolt-4", "shop-timeout");
  try {
    answer.verifyGrounding = async () => {
      throw new Error("verifier timed out");
    };
    const thrown = await lookup.applyPassageCitations(
      { source: "Shop rules", answer: "Bolts are spendable [E1]. Dogs can fly." },
      passages,
      prog,
      "can dogs fly?",
    );
    assert.match(thrown.answer, /^Bolts are spendable\./);
    assert.match(thrown.answer, /couldn't confirm this part: “Dogs can fly”/);
    assert.deepEqual(thrown.passageCitations, ["bolt-4"]);

    answer.verifyGrounding = async () => null;
    const nulled = await lookup.applyPassageCitations(
      { source: "Shop rules", answer: "Bolts are spendable [E1]." },
      passages,
      prog,
    );
    assert.equal(nulled.answer, "Bolts are spendable.");

    assert.equal(
      await lookup.applyPassageCitations(
        { source: "Shop rules", answer: "Bolts are spendable [E9]." },
        passages,
        prog,
      ),
      null,
      "a citation that matches no passage is never accepted",
    );
  } finally {
    restore();
    answer.verifyGrounding = originalVerify;
  }
});

test("numeric grounding reads 'five days' as 5 days, '1,000' as 1000, and never matches inside a longer number", () => {
  assert.equal(lookup.numericClaimsGrounded("Review takes five days.", "Review takes 5 days."), true);
  assert.equal(lookup.numericClaimsGrounded("Review takes 5 days.", "Review takes five days."), true);
  assert.equal(lookup.numericClaimsGrounded("Review takes 5 days.", "Review takes 15 days."), false);
  assert.equal(lookup.numericClaimsGrounded("You get 1000 bolts.", "You get 1,000 bolts."), true);
  assert.equal(lookup.numericClaimsGrounded("You get 1,000 bolts.", "You get 1000 bolts."), true);
});

test("a number that appears only in the user's question never grounds an answer claim", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  const prog = { id: "cap-acme", sharedSources: false, sources: [{ name: "Shop rules", type: "markdown" }] };
  const cited = (text: string) => ({
    source: "Shop rules",
    answer: text,
    groundedAnswer: text,
    passageCitations: ["p-1"],
    citationEvidence: [{ id: "p-1", programId: "cap-acme", source: "Shop rules", text: "The cap is 30%." }],
  });
  try {
    assert.equal(
      lookup.exactClaimAllowed(cited("The cap is 40%."), prog, "is 40% allowed?", "The cap is 30%."),
      false,
      "40% is not in the cited passage, whatever the question says",
    );
    assert.equal(
      lookup.exactClaimAllowed(cited("The cap is 30%."), prog, "is 40% allowed?", "The cap is 30%."),
      true,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

export {};
