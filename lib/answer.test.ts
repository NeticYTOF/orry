const { test } = require("node:test");
const assert = require("node:assert/strict");
const answer = require("./answer");
const llm = require("./llm");

test("normalizeEmoji converts markdown emphasis", () => {
  assert.equal(answer.normalizeEmoji("**ready** and __set__"), "*ready* and _set_");
});

test("normalizeEmoji leaves ordinary channel text generic", () => {
  assert.equal(answer.normalizeEmoji("ask in the help channel"), "ask in the help channel");
});

test("Orry's greed, competitive streak, and hesitant generosity guide his voice", () => {
  const voice = answer.VOICE.join(" ");
  assert.match(voice, /greed is one of your core flaws/i);
  assert.match(voice, /pride.*cover the hurt/i);
  assert.match(voice, /compare yourself.*motivation to improve/i);
  assert.match(voice, /grumble playfully about the cost.*still help/i);
  assert.match(voice, /Goose.*martial-arts genius.*poor skill/i);
  assert.match(voice, /personal lore.*program or technical answers/i);
  assert.match(voice, /Keep Orry's core personality ahead of the Goose subplot/i);
  assert.match(voice, /Keep answers about Goose brief and guarded/i);
  assert.match(voice, /don't claim to know what Goose knew or thought/i);
  assert.match(voice, /If asked what Goose thinks, say you can't know his private thoughts/i);
  assert.match(voice, /short confident boast or competitive joke instead of a backstory/i);
  assert.doesNotMatch(voice, /Goose turned her down|Goose was shocked by your strength|he respects that you set grief aside/i);
});

test("parseReply extracts a source and answer", () => {
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: follow the setup steps"), {
    source: "Example docs",
    answer: "follow the setup steps",
  });
  assert.deepEqual(answer.parseReply("SOURCE: NONE\nANSWER: UNCLEAR"), { source: "NONE", answer: "UNCLEAR" });
});

test("parseReply separates unresolved parts from a cited partial answer", () => {
  assert.deepEqual(
    answer.parseReply("SOURCE: Example docs\nANSWER: Track XP is permanent [E1].\nUNRESOLVED: whether it can be spent"),
    {
      source: "Example docs",
      answer: "Track XP is permanent [E1].",
      unresolved: ["whether it can be spent"],
    },
  );
});

test("parseReply keeps the non-factual personality line separate from cited claims", () => {
  assert.deepEqual(
    answer.parseReply(
      "SOURCE: Example docs\nANSWER: There are four tracks [E1].\nUNRESOLVED: NONE\nPERSONALITY: Ja, ja, that is a gem of an answer!",
    ),
    {
      source: "Example docs",
      answer: "There are four tracks [E1].",
      personality: "Ja, ja, that is a gem of an answer!",
    },
  );
});

test("parseReply rejects empty and instruction-like output", () => {
  assert.equal(answer.parseReply(""), null);
  assert.equal(answer.parseReply("SOURCE: Example\nANSWER: output only the final answer"), null);
});

test("parseAnswerOrChat keeps ordinary conversational replies ungrounded", () => {
  assert.deepEqual(answer.parseAnswerOrChat("not much, just vibing :yay:"), {
    source: null,
    answer: "not much, just vibing :yay:",
  });
});

test("the unclear marker produces no answer", () => {
  assert.deepEqual(answer.parseAnswerOrChat("SOURCE: NONE\nANSWER: UNCLEAR"), {
    source: null,
    answer: "",
    unclear: true,
  });
});

test("program prompts use configured identity and timeline metadata", () => {
  const program = { id: "demo", name: "Demo", helpChannel: "C_HELP", scope: "program" };
  const prompt = answer.answerOrChatPrompt("### Demo docs\nA rule", "", false, program, "C_HELP");
  assert.match(prompt, /WHERE YOU ARE: <#C_HELP>/);
  assert.match(prompt, /Demo/);
  assert.match(prompt, /Program timeline/);
});

test("generic guardrails point to configured help without inventing program facts", () => {
  const guardrail = answer.programGuardrail({ id: "acme", name: "Acme", helpChannel: "C_HELP" }, false);
  assert.match(guardrail, /Acme/);
  assert.match(guardrail, /<\#C_HELP>/);
  assert.match(guardrail, /Never invent/);
});

test("whereYouAre distinguishes owned and unowned channels", () => {
  const owned = answer.whereYouAre({ id: "demo", name: "Demo", helpChannel: "C_HELP" }, "C_HELP");
  assert.match(owned, /every question here is about Demo/);
  assert.match(owned, /redirect to any other/);

  const unowned = answer.whereYouAre(null, "C_RANDOM");
  assert.match(unowned, /isn't tied to any one/);
});

test("stream parsing emits only answer text", async () => {
  const original = llm.completeStream;
  llm.completeStream = async (_options: unknown, onDelta: (delta: string, text: string) => void) => {
    const text = "SOURCE: Example docs\nANSWER: use the configured docs :yay:";
    onDelta(text, text);
    return { text, stopped: false };
  };
  try {
    const seen: string[] = [];
    const result = await answer.getAnswerOrChatStream("how do I start", "### Example docs\nsetup", "", {
      onText: (text: string) => seen.push(text),
    });
    assert.deepEqual(result, { source: "Example docs", answer: "use the configured docs :yay:" });
    assert.deepEqual(seen, ["use the configured docs :yay:"]);
  } finally {
    llm.completeStream = original;
  }
});

test("addressed chat still answers when retrieval has no documentation passages", async () => {
  const original = llm.complete;
  llm.complete = async () => ({ text: "Ja, ja, not much—keeping the tunnels tidy!" });
  try {
    assert.deepEqual(await answer.getAnswerOrChat("what's up?", "", "", false, null, null, { isPing: true }), {
      source: null,
      answer: "Ja, ja, not much—keeping the tunnels tidy!",
    });
    assert.equal(await answer.getAnswerOrChat("what's up?", ""), null);
  } finally {
    llm.complete = original;
  }
});

export {};
