const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planEngagement, finalAction } = require("./messagePolicy");

const settings = { enabled: true, mentionReplies: true, generalMentionChat: true };

function plan(role: string, intent: string, options: Record<string, unknown> = {}) {
  const extraSettings = options.settings;
  return planEngagement({
    role,
    settings: { ...settings, ...(extraSettings && typeof extraSettings === "object" ? extraSettings : {}) },
    addressed: options.addressed ?? true,
    addressedHow: options.addressedHow,
    engagement: { intent, engage: intent !== "unrelated_chatter" && intent !== "human_conversation" },
  });
}

test("implicit 1:1 thread chatter is silent in main and help roles", () => {
  for (const role of ["main", "organizer", "help"]) {
    assert.deepEqual(plan(role, "unrelated_chatter", { addressedHow: "thread" }), {
      proceed: false,
      reason: "thread_chatter",
    });
    assert.deepEqual(plan(role, "human_conversation", { addressedHow: "thread" }), {
      proceed: false,
      reason: "thread_chatter",
    });
  }
});

test("thread program questions still proceed and addressed smalltalk still gets a general reply", () => {
  assert.deepEqual(plan("main", "direct_program_question", { addressedHow: "thread" }), {
    proceed: true,
    kind: "program",
    reason: "addressed_program",
  });
  assert.deepEqual(plan("help", "addressed_smalltalk", { addressedHow: "thread" }), {
    proceed: true,
    kind: "general",
    support: false,
    reason: "addressed_general",
  });
});

test("explicit mentions keep chat behavior on, but general chat off is silent", () => {
  assert.deepEqual(plan("main", "unrelated_chatter", { addressedHow: "mention" }), {
    proceed: true,
    kind: "general",
    reason: "addressed_general",
  });
  assert.deepEqual(
    plan("main", "unrelated_chatter", {
      addressedHow: "mention",
      settings: { generalMentionChat: false },
    }),
    {
      proceed: false,
      reason: "general_chat_off",
    },
  );
});

test("missing provenance keeps legacy mention behavior and DMs are unchanged", () => {
  assert.deepEqual(plan("main", "human_conversation"), {
    proceed: true,
    kind: "general",
    reason: "addressed_general",
  });
  assert.deepEqual(plan("dm", "unrelated_chatter", { addressedHow: "thread" }), {
    proceed: true,
    kind: "general",
    reason: "dm",
  });
});

test("a ping gets the model's answer even when the docs don't cover it", () => {
  const base = { settings, addressed: true, kind: "program", grounded: false, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "reply_chat");
  assert.equal(finalAction({ ...base, role: "dm" }), "reply_chat");
  assert.equal(finalAction({ ...base, role: "help" }), "escalate_and_reply_chat");
  assert.equal(finalAction({ ...base, role: "help", settings: { ...settings, escalateUnknown: false } }), "reply_chat");
});

test("a ping still admits uncertainty when there is nothing to say, or strict grounding is on", () => {
  const base = { settings, role: "main", addressed: true, kind: "program", grounded: false };
  assert.equal(finalAction({ ...base, hasAnswer: false }), "uncertain");
  assert.equal(finalAction({ ...base, hasAnswer: true, unclear: true }), "uncertain");
  assert.equal(finalAction({ ...base, hasAnswer: true, requireGrounded: true }), "uncertain");
  assert.equal(
    finalAction({ ...base, hasAnswer: true, settings: { ...settings, generalMentionChat: false } }),
    "uncertain",
  );
});

test("an ungrounded ambient program question in main gets a quiet reaction by default", () => {
  // Changed: this used to be "uncertain" (a public "not confirmed yet" reply).
  // Busy main channels now get a :thinking_face: reaction and no public text.
  const base = { settings, addressed: false, kind: "program", grounded: false, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "react");
  assert.equal(finalAction({ ...base, role: "help" }), "escalate_and_uncertain");
});

test("ambientUncertainReply chooses react (default), silent, or reply for main channels", () => {
  const base = { addressed: false, kind: "program", grounded: false, hasAnswer: true, role: "main" };
  assert.equal(finalAction({ ...base, settings: { ...settings, ambientUncertainReply: "react" } }), "react");
  assert.equal(finalAction({ ...base, settings: { ...settings, ambientUncertainReply: "silent" } }), "silence");
  assert.equal(finalAction({ ...base, settings: { ...settings, ambientUncertainReply: "reply" } }), "uncertain");
  // Unknown or malformed values fall back to the react default, never to public text.
  assert.equal(finalAction({ ...base, settings: { ...settings, ambientUncertainReply: "loud" } }), "react");
  assert.equal(finalAction({ ...base, settings: { ...settings, ambientUncertainReply: 3 } }), "react");
});

test("the ambient setting does not change addressed or help-channel decisions", () => {
  const replyMode = { ...settings, ambientUncertainReply: "reply" };
  const silentMode = { ...settings, ambientUncertainReply: "silent" };
  const addressed = { addressed: true, kind: "program", grounded: false, hasAnswer: false, role: "main" };
  assert.equal(finalAction({ ...addressed, settings: silentMode }), "uncertain");
  assert.equal(finalAction({ ...addressed, settings: replyMode }), "uncertain");
  const help = { addressed: false, kind: "program", grounded: false, hasAnswer: true, role: "help" };
  assert.equal(finalAction({ ...help, settings: silentMode }), "escalate_and_uncertain");
});

test("an unaddressed unanswered help request gets both a helper handoff and a visible response", () => {
  const base = { settings, addressed: false, kind: "program", grounded: false, hasAnswer: false };
  assert.equal(finalAction({ ...base, role: "help" }), "escalate_and_uncertain");
});

test("ungrounded chatter is still silenced, not answered", () => {
  // Only program questions earn the honest decline. Chat has nothing to say
  // and should stay quiet.
  const base = { settings, addressed: false, kind: "general", grounded: false, hasAnswer: false };
  assert.equal(finalAction({ ...base, role: "main" }), "silence");
});

test("a grounded program question still answers", () => {
  const base = { settings, addressed: false, kind: "program", grounded: true, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "reply");
  assert.equal(finalAction({ ...base, role: "help" }), "reply");
});
export {};
