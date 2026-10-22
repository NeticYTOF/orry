const { test } = require("node:test");
const assert = require("node:assert/strict");
const grounding = require("./grounding");

const supported = {
  verdict: "supported",
  claims: [{ claim: "The build grant is available to students.", supported: true, evidenceIds: ["policy-1"] }],
};

test("parses fenced JSON with surrounding model prose", () => {
  const result = grounding.parseGroundingVerdict(
    `Here is the result:\n\`\`\`json\n${JSON.stringify(supported)}\n\`\`\``,
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims[0].evidenceIds[0], "policy-1");
});

test("normalizes observed verifier passageIDs without relaxing evidence checks", () => {
  const result = grounding.parseGroundingVerdict({
    verdict: "supported",
    claims: [{ claim: "Track XP is permanent.", passageIDs: ["passage-1"] }],
  });
  assert.equal(result.claims[0].supported, true);
  assert.deepEqual(result.claims[0].evidenceIds, ["passage-1"]);
  assert.equal(
    grounding.parseGroundingVerdict({
      verdict: "unsupported",
      claims: [{ claim: "Track XP is permanent.", passageIDs: ["passage-1"] }],
    }).ok,
    false,
  );
});

test("fails closed for malformed or schema-invalid verdicts", () => {
  assert.equal(grounding.parseGroundingVerdict("not json").ok, false);
  assert.equal(grounding.parseGroundingVerdict({ verdict: "supported", claims: [] }).ok, false);
  assert.equal(
    grounding.parseGroundingVerdict({
      verdict: "supported",
      claims: [{ claim: "x", supported: true, evidenceIds: [] }],
    }).ok,
    false,
  );
});

test("accepts exact support from same-program retrieved evidence", () => {
  const result = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [
      { id: "policy-1", programId: "build-grant", supportsClaims: ["The build grant is available to students."] },
    ],
  });
  assert.equal(result.supported, true);
});

test("passage citations must resolve to evidence from the same program", () => {
  const evidence = [{ id: "p_1", programId: "build-grant" }];
  assert.equal(
    grounding.validatePassageCitations({ citations: ["p_1"], evidence, programId: "build-grant" }).supported,
    true,
  );
  assert.equal(
    grounding.validatePassageCitations({ citations: ["p_1"], evidence, programId: "other-program" }).supported,
    false,
  );
  assert.equal(
    grounding.validatePassageCitations({ citations: ["missing"], evidence, programId: "build-grant" }).supported,
    false,
  );
});

test("verified claims must match the answer and cited same-program passages exactly", () => {
  const expectedClaims = [{ claim: "Track XP is permanent.", evidenceIds: ["E1"] }];
  const evidence = [{ id: "E1", programId: "loadout" }];
  assert.equal(
    grounding.validatePassageClaims({
      verdict: { verdict: "supported", claims: [{ ...expectedClaims[0], supported: true }] },
      expectedClaims,
      evidence,
      programId: "loadout",
    }).supported,
    true,
  );
  assert.equal(
    grounding.validatePassageClaims({
      verdict: { verdict: "unsupported", claims: [{ ...expectedClaims[0], supported: false }] },
      expectedClaims,
      evidence,
      programId: "loadout",
    }).supported,
    false,
  );
  assert.equal(
    grounding.validatePassageClaims({
      verdict: {
        verdict: "supported",
        claims: [{ claim: "Bolts are permanent.", supported: true, evidenceIds: ["E1"] }],
      },
      expectedClaims,
      evidence,
      programId: "loadout",
    }).supported,
    false,
  );
});

test("duplicate answer claims cannot reuse a supported verifier entry", () => {
  const claim = { claim: "AI use is capped at 40%.", evidenceIds: ["E1"] };
  const result = grounding.validatePassageClaims({
    verdict: {
      verdict: "supported",
      claims: [
        { ...claim, supported: true },
        { ...claim, supported: false },
      ],
    },
    expectedClaims: [claim, claim],
    evidence: [{ id: "E1", programId: "loadout" }],
    programId: "loadout",
  });
  assert.equal(result.supported, false);
});

test("rejects related policy evidence and cross-program evidence", () => {
  const related = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [
      { id: "policy-1", programId: "build-grant", supportsClaims: ["The build grant has a student application."] },
    ],
  });
  const crossProgram = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [{ id: "policy-1", programId: "other-program", supportsClaims: [supported.claims[0].claim] }],
  });
  assert.equal(related.supported, false);
  assert.equal(crossProgram.supported, false);
});

test("allows only explicitly listed fixture-supported claims", () => {
  const result = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    fixtureClaims: [supported.claims[0].claim],
  });
  assert.equal(result.supported, true);
  const notExplicit = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    fixtureClaims: [],
  });
  assert.equal(notExplicit.supported, false);
});

test("uses an injected parser without calling a live model", () => {
  let calls = 0;
  const validator = grounding.createGroundingValidator({
    parse() {
      calls += 1;
      return { ...supported, ok: true };
    },
  });
  const result = validator.validate({ programId: "build-grant", fixtureClaims: [supported.claims[0].claim] });
  assert.equal(result.supported, true);
  assert.equal(calls, 1);
});
test("answer sentences end only at sentence punctuation, keeping citations with the sentence they end", () => {
  assert.deepEqual(
    grounding.splitAnswerSentences(
      "Bolts (e.g. shop items) are spendable [E1]. Track XP is permanent [E1] Each track progresses [E2].",
    ),
    ["Bolts (e.g. shop items) are spendable [E1].", "Track XP is permanent [E1] Each track progresses [E2]."],
  );
  assert.deepEqual(grounding.splitAnswerSentences("Pick XP vs. Bolts. Bolts are spendable."), [
    "Pick XP vs. Bolts.",
    "Bolts are spendable.",
  ]);
  assert.deepEqual(grounding.splitAnswerSentences("Use tools, e.g. 5 of them, etc. Done."), [
    "Use tools, e.g. 5 of them, etc. Done.",
  ]);
  assert.deepEqual(grounding.splitAnswerSentences("First line\nSecond line"), ["First line", "Second line"]);
  assert.deepEqual(grounding.splitAnswerSentences("Version 1.5 ships soon. It is free [E1]."), [
    "Version 1.5 ships soon.",
    "It is free [E1].",
  ]);
});

test("hedge sentences are recognized by their opening words only", () => {
  assert.equal(grounding.isHedgeSentence("Assuming you mean the Loadout program, it is open."), true);
  assert.equal(grounding.isHedgeSentence("If you mean the grant, ask a helper."), true);
  assert.equal(grounding.isHedgeSentence("Going by the docs, it is open."), true);
  assert.equal(grounding.isHedgeSentence("I'm guessing it is open."), true);
  assert.equal(grounding.isHedgeSentence("Bolts are spendable."), false);
});

export {};
