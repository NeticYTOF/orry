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
  assert.match(voice, /Greed drives you/i);
  assert.match(voice, /boast about your money with confidence/i);
  assert.match(voice, /Treat that as private history, not small talk\. Don't volunteer it/i);
  assert.doesNotMatch(voice, /pride in being wealthy helps cover the hurt/i);
  assert.match(voice, /never explain your greed as therapy or say money covers hurt/i);
  assert.match(voice, /don't name your traits or analyze them/i);
  assert.match(voice, /Examples of style to vary, not scripts: 'I like looking at my money/i);
  assert.match(voice, /compare yourself.*motivation to improve/i);
  assert.match(voice, /grumble playfully about the cost.*still help/i);
  assert.match(voice, /Goose.*martial-arts genius.*poor skill/i);
  assert.match(voice, /personal lore.*program or technical answers/i);
  assert.match(voice, /Keep Orry's core personality ahead of the Goose subplot/i);
  assert.match(voice, /Keep answers about Goose brief and guarded/i);
  assert.match(voice, /don't claim to know what Goose knew or thought/i);
  assert.match(voice, /If asked what Goose thinks, say you can't know his private thoughts/i);
  assert.match(voice, /short confident boast or competitive joke instead of a backstory/i);
  assert.doesNotMatch(
    voice,
    /Goose turned her down|Goose was shocked by your strength|he respects that you set grief aside/i,
  );
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

test("parseReply takes the optional ASSUMPTION line out of the answer", () => {
  assert.deepEqual(
    answer.parseReply(
      "SOURCE: Example docs\nANSWER: Tracks unlock at level five [E1].\nUNRESOLVED: NONE\nASSUMPTION: Assuming you mean the Track XP unlocks.",
    ),
    {
      source: "Example docs",
      answer: "Tracks unlock at level five [E1].",
      assumption: "Assuming you mean the Track XP unlocks.",
    },
  );
});

test("parseReply changes nothing when there is no ASSUMPTION line", () => {
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Tracks unlock at level five [E1].\nUNRESOLVED: NONE"), {
    source: "Example docs",
    answer: "Tracks unlock at level five [E1].",
  });
});

test("parseAnswerOrChat keeps an ASSUMPTION only when it is an 'Assuming you mean' sentence", () => {
  const withAssumption = answer.parseAnswerOrChat(
    "SOURCE: Example docs\nANSWER: Tracks unlock at level five [E1].\nASSUMPTION: Assuming you mean the Track XP unlocks.",
  );
  assert.equal(withAssumption.assumption, "Assuming you mean the Track XP unlocks.");
  assert.equal(withAssumption.answer, "Tracks unlock at level five [E1].");

  const placeholder = answer.parseAnswerOrChat(
    "SOURCE: Example docs\nANSWER: Tracks unlock at level five [E1].\nASSUMPTION: NONE",
  );
  assert.equal("assumption" in placeholder, false);
  assert.equal(placeholder.answer, "Tracks unlock at level five [E1].");

  const notAnAssumption = answer.parseAnswerOrChat(
    "SOURCE: Example docs\nANSWER: Tracks unlock at level five [E1].\nASSUMPTION: you probably mean tracks",
  );
  assert.equal("assumption" in notAnAssumption, false);
  assert.equal(notAnAssumption.answer, "Tracks unlock at level five [E1].");
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

test("the unclear marker preserves a question-specific handoff sentence", () => {
  assert.deepEqual(
    answer.parseAnswerOrChat(
      "SOURCE: NONE\nANSWER: UNCLEAR\nUNCERTAINTY: I can't verify the prize amount from my notes, and I won't guess.",
    ),
    {
      source: null,
      answer: "",
      unclear: true,
      uncertaintyReply: "I can't verify the prize amount from my notes, and I won't guess.",
    },
  );
});

test("the model can mark a subjectless follow-up for silence", () => {
  assert.deepEqual(answer.parseAnswerOrChat("SOURCE: NONE\nANSWER: UNCLEAR\nUNCERTAINTY: SILENT"), {
    source: null,
    answer: "",
    unclear: true,
    silent: true,
  });
});

test("program prompts use configured identity and timeline metadata", () => {
  const program = { id: "demo", name: "Demo", helpChannel: "C_HELP", scope: "program" };
  const prompt = answer.answerOrChatPrompt("### Demo docs\nA rule", "", false, program, "C_HELP");
  assert.match(prompt, /WHERE YOU ARE: <#C_HELP>/);
  assert.match(prompt, /Demo/);
  assert.match(prompt, /Program timeline/);
  assert.match(prompt, /In casual, personal chat, let one core trait show naturally/i);
});

test("general addressed questions can use general knowledge without weakening program grounding", () => {
  const program = { id: "loadout", name: "Loadout", requireGroundedAnswer: true };
  const prompt = answer.answerOrChatPrompt("### About Orry\nOrry is a mole.", "", false, program, "C_MAIN", "general");
  assert.doesNotMatch(prompt, /CASE 2[\s\S]{0,160}ANSWER: UNCLEAR/);
  assert.match(prompt, /Loadout-specific facts must still come from the supplied Loadout sources/i);
  assert.match(prompt, /Use Orry's identity and lore for personal questions about Orry/i);
  assert.match(prompt, /addressed as a personal or general request/i);
  assert.match(prompt, /For anything that is NOT Loadout-specific.*answer normally and helpfully/i);
});

test("strict grounded answers ask for a voiced uncertainty line and accept 'what is' program questions", () => {
  const program = { id: "loadout", name: "Loadout", requireGroundedAnswer: true };
  const prompt = answer.answerOrChatPrompt("### What YSWS means\nYou Ship, We Ship [E1]", "", false, program, "C_MAIN");
  assert.match(prompt, /ANSWER: UNCLEAR\nUNCERTAINTY: one short sentence in Orry's voice/);
  assert.match(prompt, /Judge questions by meaning, never by wording/);
  assert.match(prompt, /'what YSWS are we'/);
  assert.match(prompt, /UNRESOLVED: NONE, or the question parts[^\n]*\nPERSONALITY: one short line of Orry's character/);
  assert.match(prompt, /one PERSONALITY line after UNRESOLVED/);
  assert.match(prompt, /never a standalone greeting/);
  assert.match(prompt, /Interpret before you match/);
  assert.match(prompt, /Do not ask the person to rephrase/);
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

test("the /ask grounded helper never returns the UNCLEAR marker as an answer", async () => {
  const original = llm.complete;
  try {
    for (const text of [
      "SOURCE: NONE\nANSWER: UNCLEAR",
      "SOURCE: NONE\nANSWER: **UNCLEAR**",
      "SOURCE: NONE\nANSWER: _unclear_",
    ]) {
      llm.complete = async () => ({ text });
      const result = await answer.getGroundedAnswer("what is the prize?", "### Example docs\nsetup", "", null);
      assert.equal(result, null, `${JSON.stringify(text)} is no answer`);
    }
  } finally {
    llm.complete = original;
  }
});

test("parseReply accepts markdown-wrapped and lowercase labels", () => {
  assert.deepEqual(answer.parseReply("**SOURCE**: Example docs\nANSWER: follow the setup steps"), {
    source: "Example docs",
    answer: "follow the setup steps",
  });
  assert.deepEqual(answer.parseReply("**SOURCE:** Example docs\n**ANSWER:** Track XP is permanent [E1]."), {
    source: "Example docs",
    answer: "Track XP is permanent [E1].",
  });
  assert.deepEqual(answer.parseReply("source: Example docs\nanswer: Fact [e1]"), {
    source: "Example docs",
    answer: "Fact [E1]",
  });
  assert.deepEqual(
    answer.parseReply("**SOURCE**: Example docs\n**ANSWER**: Track XP is permanent [E1].\n**UNRESOLVED:** **NONE**"),
    { source: "Example docs", answer: "Track XP is permanent [E1]." },
  );
  assert.deepEqual(
    answer.parseReply("**SOURCE**: Example docs\n**ANSWER**: Track XP is permanent [E1].\n**UNRESOLVED**: whether it can be spent"),
    {
      source: "Example docs",
      answer: "Track XP is permanent [E1].",
      unresolved: ["whether it can be spent"],
    },
  );
});

test("parseReply recognizes [E01], comma lists, and valid ranges as canonical citations", () => {
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Fact one [E01]."), {
    source: "Example docs",
    answer: "Fact one [E1].",
  });
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Fact two [E1, E2]."), {
    source: "Example docs",
    answer: "Fact two [E1][E2].",
  });
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Fact three [E1-E3]."), {
    source: "Example docs",
    answer: "Fact three [E1][E2][E3].",
  });
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Fact four [e2]."), {
    source: "Example docs",
    answer: "Fact four [E2].",
  });
  // A backwards range is not a citation: it is left as written for the citation check to reject.
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: Odd [E5-E1]."), {
    source: "Example docs",
    answer: "Odd [E5-E1].",
  });
});

test("the instruction-echo filter checks only the first sentence and the generic phrases only as a whole reply", () => {
  assert.deepEqual(
    answer.parseReply(
      "SOURCE: Example docs\nANSWER: Bolts are spendable [E1]. Let's see how the output format works for trackers.",
    ),
    {
      source: "Example docs",
      answer: "Bolts are spendable [E1]. Let's see how the output format works for trackers.",
    },
  );
  assert.equal(answer.parseReply("SOURCE: Example docs\nANSWER: let's see"), null);
  assert.equal(answer.parseReply("SOURCE: Example docs\nANSWER: Output format"), null);
  assert.notEqual(answer.parseReply("SOURCE: Example docs\nANSWER: I don't have access to that exact figure [E1]."), null);
  assert.equal(
    answer.parseReply("SOURCE: Example docs\nANSWER: Output only the final answer [E1]. Bolts are spendable [E1]."),
    null,
  );
});

test("an UNCLEAR reply with markdown or a trailing full stop still counts as no answer", () => {
  assert.deepEqual(answer.parseAnswerOrChat("SOURCE: NONE\nANSWER: **UNCLEAR**."), {
    source: null,
    answer: "",
    unclear: true,
  });
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
