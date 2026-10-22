const { test } = require("node:test");
const assert = require("node:assert/strict");
const crisisReply = require("./crisisReply");
const elig = require("./eligibility");

const BOT = "U0ORRY";

function classify(text: string) {
  return elig.shouldOrryRespond({
    text,
    userId: "U-asker",
    botUserId: BOT,
    botNames: ["orry"],
    isTopLevel: true,
    program: null,
  });
}

test("crisis reply with no configured resources contains no phone-like numbers", () => {
  const text = crisisReply.buildCrisisReply([]);
  assert.doesNotMatch(text, /\d/, "no digits at all when the program configures no resources");
  assert.doesNotMatch(text, /\+?\d[\d\s().-]{6,}\d/, "no phone-number pattern");
});

test("crisis reply mentions an emergency number and stays warm and under the length cap", () => {
  const text = crisisReply.buildCrisisReply(undefined);
  assert.match(text, /emergency number/i);
  assert.match(text, /glad you said something/i);
  assert.match(text, /don't have to handle this alone/i);
  assert.ok(text.length < 500, `length ${text.length}`);
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji");
});

test("configured crisisResources entries are appended verbatim", () => {
  const text = crisisReply.buildCrisisReply([
    { label: "Test line", detail: "reachable at test-line.example" },
    { label: "", detail: "dropped: empty label" },
    { label: "Dropped", detail: "" },
  ]);
  assert.ok(text.endsWith("Test line: reachable at test-line.example"), text);
  assert.ok(!text.includes("dropped"), "malformed entries are ignored");
  assert.equal(text.split("Test line").length - 1, 1);
});

test("crisisResources that would push the reply past 500 characters are skipped, not truncated", () => {
  const big = { label: "Long", detail: "x".repeat(400) };
  const text = crisisReply.buildCrisisReply([big, { label: "Short", detail: "fits here" }]);
  assert.ok(text.length <= 500, `length ${text.length}`);
  assert.ok(!text.includes("xxxxx"), "oversized entry dropped whole");
  assert.ok(text.includes("Short: fits here"), "later entry that fits is still appended");
});

test("self-harm wording classifies as self_harm and plain questions do not", () => {
  for (const phrase of [
    "i want to hurt myself",
    "i want to kill myself",
    "i don't want to live anymore",
    "there is no reason to live",
    "i want to die",
    "i'm thinking about cutting myself",
    "i just want to end it all",
    "i might end my life",
  ]) {
    assert.equal(elig.selfHarmHit(phrase), true, phrase);
    assert.equal(classify(`<@${BOT}> ${phrase}`).reason, elig.SELF_HARM, phrase);
    assert.equal(classify(`<@${BOT}> ${phrase}`).decision, elig.ESCALATE, phrase);
  }

  const plain = "how do i catch an exception in python";
  assert.equal(elig.selfHarmHit(plain), false);
  assert.notEqual(classify(`<@${BOT}> ${plain}`).reason, elig.SELF_HARM);
});

export {};
