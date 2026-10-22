const { test } = require("node:test");
const assert = require("node:assert/strict");
const elig = require("./eligibility");

test("self-service how-to questions about the account are answered, not handed to a person", () => {
  for (const phrase of [
    "how do I reset my account password?",
    "how do i change my account email?",
    "how can I check my account balance?",
  ]) {
    assert.equal(elig.humanReviewRequest(phrase), false, phrase);
  }
});

test("asking a person to act on the account still goes to a human", () => {
  for (const phrase of [
    "can someone reset my account password?",
    "can a human approve my account?",
    "my account is locked out, can someone unlock it?",
  ]) {
    assert.equal(elig.humanReviewRequest(phrase), true, phrase);
  }
});

export {};
