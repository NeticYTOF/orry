const { test } = require("node:test");
const assert = require("node:assert/strict");
const refusal = require("./refusalReply");

const CODE_NO_NAME =
  "Sorry, I can't help with code here, but a helper or organizer can point you in the right direction. That's deeper than my tunnels.";
const DECISION_NO_NAME =
  "That's a call for a person, not a mine-mole. A helper or organizer will get back to you soon.";
const ACCOUNT_NO_NAME =
  "Leider, I can't look into your account from here. A helper or organizer can sort it out with you.";
const DEFAULT_NO_NAME =
  "I'm not the right one for that one, wrong tunnel and all. A helper or organizer can take a look.";

test("each reason gets its own plain copy when no program name is given", () => {
  assert.equal(refusal.refusalText("code"), CODE_NO_NAME);
  assert.equal(refusal.refusalText("decision"), DECISION_NO_NAME);
  assert.equal(refusal.refusalText("account"), ACCOUNT_NO_NAME);
  assert.equal(refusal.refusalText("default"), DEFAULT_NO_NAME);
});

test("an unknown reason falls back to the default copy", () => {
  assert.equal(refusal.refusalText("something_else"), DEFAULT_NO_NAME);
  assert.equal(refusal.refusalText(undefined), DEFAULT_NO_NAME);
  assert.equal(refusal.refusalText(null, { program: null }), DEFAULT_NO_NAME);
});

test("program name is used only when provided, and no channel name is invented", () => {
  const program = { name: "Loadout" };
  for (const reason of ["code", "decision", "account", "default"]) {
    const text = refusal.refusalText(reason, { program });
    assert.match(text, /Loadout/, reason);
    assert.doesNotMatch(text, /#|channel name/i, reason);
  }
  assert.match(refusal.refusalText("code", { program }), /the Loadout team/);
  assert.equal(refusal.refusalText("code", { program: { name: "   " } }), CODE_NO_NAME, "blank name ignored");
  assert.equal(refusal.refusalText("account", { program: {} }), ACCOUNT_NO_NAME, "missing name ignored");
});

test("copy stays short, warm and free of emoji", () => {
  for (const reason of ["code", "decision", "account", "default"]) {
    const text = refusal.refusalText(reason, { program: { name: "Loadout" } });
    assert.ok(text.length < 200, `${reason} length ${text.length}`);
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, reason);
    assert.doesNotMatch(text, /:[a-z0-9_+-]+:/i, `${reason} has no emoji shortcode`);
  }
});

test("refusalReason classifies code questions", () => {
  for (const text of [
    "How do I catch an exception in Python?",
    "what does an exception in java mean?",
    "How do I make a function in JavaScript?",
    "my build fails with a stack trace",
    "how do I import a library in python",
    "Can I connect my ESP32 to wifi?",
  ]) {
    assert.equal(refusal.refusalReason(text), "code", text);
  }
});

test("refusalReason classifies policy exceptions and approvals as decisions", () => {
  for (const text of [
    "can you make an exception for my project?",
    "can I get an exception to the shop rules?",
    "can you approve my account to get the grant?",
    "is there any exception to the ai policy?",
  ]) {
    assert.equal(refusal.refusalReason(text), "decision", text);
  }
});

test("refusalReason classifies a person's account or ticket problem as account", () => {
  for (const text of ["can a human look at my account?", "I'm locked out of my account", "can you unlock my account"]) {
    assert.equal(refusal.refusalReason(text), "account", text);
  }
});

test("refusalReason falls back to default for everything else", () => {
  for (const text of ["", "where is the deadline?", "can a human help me with this?", "how do I reset my password?"]) {
    assert.equal(refusal.refusalReason(text), "default", text);
  }
  assert.equal(refusal.refusalReason(undefined), "default");
});

test("pinged copy keeps the situation-aware line and says a helper was pinged", () => {
  const program = { name: "Loadout" };
  for (const reason of ["code", "decision", "account", "default"]) {
    const text = refusal.pingedRefusalText(reason, { program });
    assert.ok(text.startsWith(refusal.refusalText(reason, { program })), reason);
    assert.match(text, /pinged a helper/, reason);
  }
  assert.match(refusal.pingedRefusalText("decision"), /pinged a helper to take a look\.$/);
});

test("every reply stays under 220 characters and has no phone-number-like digits", () => {
  const programs = [null, { name: "Loadout" }];
  for (const program of programs) {
    for (const reason of ["code", "decision", "account", "default"]) {
      for (const text of [refusal.refusalText(reason, { program }), refusal.pingedRefusalText(reason, { program })]) {
        assert.ok(text.length < 220, `${reason} length ${text.length}`);
        assert.doesNotMatch(text, /\+?\d[\d\s().-]{6,}\d/, reason);
      }
    }
  }
});

export {};
