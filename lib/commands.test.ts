process.env.ORRY_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");
const learn = require("./learn");
const teachThread = require("./teachThread");
const commands = require("./commands");
const { parseForgetInput, parseId, adminOnlyShortcut, teachThreadShortcut } = commands;

const ADMIN = "U0ADMIN";
config.slack.adminUserIds = [ADMIN];

test("parseForgetInput parses single ids, ranges, pending, and all", () => {
  assert.deepEqual(parseForgetInput("15"), { type: "id", id: 15 });
  assert.deepEqual(parseForgetInput("#15"), { type: "id", id: 15 });

  assert.deepEqual(parseForgetInput("12-40"), { type: "range", from: 12, to: 40 });
  assert.deepEqual(parseForgetInput("#12-#40"), { type: "range", from: 12, to: 40 });

  assert.deepEqual(parseForgetInput("pending"), { type: "pending" });
  assert.deepEqual(parseForgetInput("PENDING"), { type: "pending" });

  assert.deepEqual(parseForgetInput("all"), { type: "all" });
  assert.equal(parseForgetInput("allofit"), null);
  assert.equal(parseForgetInput("invalid"), null);
});

test("parseId accepts a bare or hashed id and rejects anything else", () => {
  assert.equal(parseId("7"), 7);
  assert.equal(parseId("#7"), 7);
  assert.equal(parseId(" 7 "), 7);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-3"), null);
  assert.equal(parseId("seven"), null);
  assert.equal(parseId(""), null);
});

function stubEphemeralClient() {
  const posted: any[] = [];
  return { client: { chat: { postEphemeral: async (args: any) => void posted.push(args) } }, posted };
}

test("adminOnlyShortcut blocks a non-admin and answers ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const inner = async () => {
    throw new Error("must not run for a non-admin");
  };

  await adminOnlyShortcut(inner)({
    shortcut: { channel: { id: "C1" }, user: { id: "U0NOTADMIN" } },
    ack: async () => {},
    client,
  });

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /helpers-only/);
});

test("adminOnlyShortcut runs the handler for an admin", async () => {
  let ran = false;
  await adminOnlyShortcut(async () => void (ran = true))({
    shortcut: { channel: { id: "C1" }, user: { id: ADMIN } },
    ack: async () => {},
    client: {},
  });
  assert.equal(ran, true);
});

test("teachThreadShortcut queues a summary and confirms ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const savedSummarize = teachThread.summarizeThread;
  const savedCapture = learn.captureFromThread;
  teachThread.summarizeThread = async () => ({ question: "how do i join", answer: "post in #acme-help" });
  learn.captureFromThread = () => 42;

  try {
    await teachThreadShortcut({
      shortcut: {
        channel: { id: "C1" },
        message: { thread_ts: "1.1", ts: "1.2" },
        message_ts: "1.2",
        user: { id: ADMIN },
      },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = savedSummarize;
    learn.captureFromThread = savedCapture;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /queued for review/);
  assert.match(posted[0].text, /#42/);
});

test("teachThreadShortcut tells the admin when nothing was found", async () => {
  const { client, posted } = stubEphemeralClient();
  const saved = teachThread.summarizeThread;
  teachThread.summarizeThread = async () => null;

  try {
    await teachThreadShortcut({
      shortcut: { channel: { id: "C1" }, message: { ts: "1.2" }, message_ts: "1.2", user: { id: ADMIN } },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = saved;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /couldn't find/);
});

test("programCommand list, add, set, and remove — admin-only", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);

  await commands.programCommand({
    command: { text: "list", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /registered programs/);

  await commands.programCommand({
    command: { text: "add testprog Test Program", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[1], /saved program `testprog`/);

  await commands.programCommand({
    command: { text: "set testprog posture passive", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[2], /updated `testprog` posture to `passive`/);

  await commands.programCommand({
    command: { text: "remove testprog", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[3], /removed program `testprog`/);
});

test("programCommand rejects list/add/set/remove for a non-admin, non-helper user", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);
  await commands.programCommand({
    command: { text: "list", user_id: "U0RANDOM" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /helpers-only/);
});

test("a new member of the configured main channel is invited to help, but test/help joins are ignored", async () => {
  const channelPolicy = require("./channelPolicy");
  const originalResolve = channelPolicy.resolve;
  channelPolicy.resolve = (channel: string) => ({
    role: channel === "C-AUTO-HELP" ? "help" : "main",
    program: {
      id: "auto-help-test",
      name: "Auto Help Test",
      channels: ["C-AUTO-MAIN", "C-AUTO-TEST"],
      helpChannel: "C-AUTO-HELP",
      autoInviteToHelp: true,
    },
  });

  const invites: any[] = [];
  const client = { conversations: { invite: async (args: any) => void invites.push(args) } };
  try {
    await commands.onMemberJoined({ event: { channel: "C-AUTO-MAIN", user: "U-NEW" }, client });
    await commands.onMemberJoined({ event: { channel: "C-AUTO-TEST", user: "U-TEST" }, client });
    await commands.onMemberJoined({ event: { channel: "C-AUTO-HELP", user: "U-HELP" }, client });

    assert.deepEqual(invites, [{ channel: "C-AUTO-HELP", users: "U-NEW" }]);
    commands.onMemberLeft({ event: { channel: "C-AUTO-HELP", user: "U-NEW" } });
    await commands.onMemberJoined({ event: { channel: "C-AUTO-MAIN", user: "U-NEW" }, client });
    assert.deepEqual(invites, [{ channel: "C-AUTO-HELP", users: "U-NEW" }]);
  } finally {
    channelPolicy.resolve = originalResolve;
  }
});

test("programCommand tickets on|off is reachable by a program's own helper, not just admins, and is channel-scoped", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);
  const db = require("./db");
  const programs = require("./programs");
  db.saveProgram({ id: "cmd-tix", name: "CmdTix", helpChannel: "C-CMD-TIX", channels: ["C-CMD-TIX"] });
  db.syncHelper({ programId: "cmd-tix", userId: "U-HELPER-TIX", source: "manual" });
  programs.invalidate();

  await commands.programCommand({
    command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U0RANDOM" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /helpers-only/);

  await commands.programCommand({
    command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[1], /ticket auto-creation from this channel is \*off\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, false);

  await commands.programCommand({
    command: { text: "tickets on", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[2], /back \*on\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, true);
});

test("every registered command has its ephemeral replies de-dashed", async () => {
  const registered: Record<string, any> = {};
  const registeredEvents: Record<string, any> = {};
  const app = {
    command: (name: any, handler: any) => {
      registered[name] = handler;
    },
    action: () => {},
    shortcut: () => {},
    event: (name: string, handler: any) => {
      registeredEvents[name] = handler;
    },
    view: () => {},
  };
  commands.register(app);

  const sent: any[] = [];
  const handler = commands.plainSpoken(async ({ respond }: any) => {
    await respond({ response_type: "ephemeral", text: "the price — 11,400 px" });
  });
  await handler({ command: { user_id: "U1" }, ack: async () => {}, respond: async (p: any) => sent.push(p) });

  assert.equal(sent[0].text, "the price, 11,400 px");
  assert.ok(Object.keys(registered).length > 0, "register() bound no commands");
  assert.equal(registeredEvents.member_left_channel, commands.onMemberLeft);
});

test("/orry help returns the actor's filtered runtime command list", async () => {
  const responses: any[] = [];
  await commands.askCommand({
    command: { text: "help", user_id: "U0RANDOM", channel_id: "C1" },
    ack: async () => {},
    respond: async (payload: any) => responses.push(payload),
  });

  assert.match(responses[0].text, /\/orry-sources/);
  assert.doesNotMatch(responses[0].text, /\/orry-teach/);
});

test("REGISTRY: slash defs, CAPABILITIES, and Bolt bindings cover each other", () => {
  const brand = require("./brand");
  const capabilities = require("./capabilities");
  const commandRegistry = require("./commandRegistry");

  const slashDefs = commandRegistry.COMMANDS.filter((c: any) => c.surface === "slash" || c.surface === "both");
  const suffixOf = (def: any) => (def.name === "ask" ? "" : def.name);

  const capabilitySuffixes = new Set(capabilities.CAPABILITIES.map((c: any) => c.suffix));
  for (const def of slashDefs) {
    assert.ok(capabilitySuffixes.has(suffixOf(def)), `/${def.name} has no CAPABILITIES entry`);
  }
  for (const suffix of capabilitySuffixes) {
    assert.ok(
      slashDefs.some((d: any) => suffixOf(d) === suffix),
      `CAPABILITIES suffix ${JSON.stringify(suffix)} has no registry def`,
    );
  }

  const bound: any[] = [];
  const app = {
    command: (name: any) => void bound.push(name),
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);
  const expected = slashDefs.map((d: any) => brand.cmd(suffixOf(d)));
  for (const name of expected) {
    assert.ok(bound.includes(name), `${name} in registry but not bound by register()`);
  }
});

test("/orry ask parity — docs hit answers ephemerally, miss chats, error falls back", async () => {
  const respond = require("./respond");
  const chat = require("./chat");
  const sent: any[] = [];
  const sendEphemeral = async (m: any) => sent.push(m);
  const origLookup = respond.lookupAnswer;
  const origChat = chat.getChatReply;
  const { config } = require("./config");
  const savedFaq = config.slack.faqChannels;
  config.slack.faqChannels = [...(savedFaq || []), "C1"];
  try {
    let lookedUpFor = null;
    respond.lookupAnswer = async (_q: any, _c: any, prog: any) => {
      lookedUpFor = prog;
      return { source: "Docs", answer: "docs answer here" };
    };
    await commands.askCommand({
      command: { text: "how do i join", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /docs answer here/);
    assert.ok(lookedUpFor, "the lookup is scoped to the channel's program");

    sent.length = 0;
    let unscopedLookups = 0;
    respond.lookupAnswer = async () => {
      unscopedLookups += 1;
      return { source: "Docs", answer: "leak" };
    };
    chat.getChatReply = async () => "chat only";
    await commands.askCommand({
      command: { text: "what is the payout", user_id: "U1", channel_id: "C-NOBODY" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.equal(unscopedLookups, 0);
    assert.doesNotMatch(sent[0].text, /leak/);

    sent.length = 0;
    respond.lookupAnswer = async () => null;
    chat.getChatReply = async () => "chat reply here";
    await commands.askCommand({
      command: { text: "hey orry", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /chat reply here/);

    sent.length = 0;
    respond.lookupAnswer = async () => {
      throw new Error("boom");
    };
    await commands.askCommand({
      command: { text: "anything", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /having trouble thinking/);
  } finally {
    respond.lookupAnswer = origLookup;
    chat.getChatReply = origChat;
    config.slack.faqChannels = savedFaq;
  }
});

test("/orry ask uses the resolved program in an allowed general fallback", async () => {
  const respond = require("./respond");
  const chat = require("./chat");
  const channelPolicy = require("./channelPolicy");
  const originalLookup = respond.lookupAnswer;
  const originalChat = chat.getChatReply;
  const originalResolve = channelPolicy.resolve;
  const savedGrounded = process.env.ORRY_REQUIRE_GROUNDED_ANSWER ?? process.env.RIVET_REQUIRE_GROUNDED_ANSWER;
  const sent: any[] = [];
  let fallbackContext = "";
  delete process.env.ORRY_REQUIRE_GROUNDED_ANSWER;
  channelPolicy.resolve = () => ({
    role: "main",
    program: { id: "grounded", name: "Grounded", requireGroundedAnswer: false },
    settings: { enabled: true },
  });
  respond.lookupAnswer = async () => null;
  chat.getChatReply = async (_question: string, context: string) => {
    fallbackContext = context;
    return "fallback";
  };
  try {
    await commands.askCommand({
      command: { text: "what is the rule", user_id: "U1", channel_id: "C-GROUNDED" },
      ack: async () => {},
      respond: async (payload: any) => sent.push(payload),
    });
  } finally {
    respond.lookupAnswer = originalLookup;
    chat.getChatReply = originalChat;
    channelPolicy.resolve = originalResolve;
    if (savedGrounded === undefined) delete process.env.ORRY_REQUIRE_GROUNDED_ANSWER;
    else process.env.ORRY_REQUIRE_GROUNDED_ANSWER = savedGrounded;
  }
  assert.match(fallbackContext, /Grounded program/);
  assert.equal(sent[0].text, "fallback");
});

test("/orry ask help resolves a program with the workspace identity", async () => {
  const programs = require("./programs");
  const originalForChannel = programs.forChannel;
  const calls: Array<{ channel: string; workspaceId?: string | null }> = [];
  const sent: any[] = [];
  programs.forChannel = (channel: string, workspaceId?: string | null) => {
    calls.push({ channel, workspaceId });
    return { id: workspaceId === "T-HELP-OWNER" ? "owner-program" : "other-program", name: "Help" };
  };
  try {
    await commands.askCommand({
      command: { text: "help", user_id: "U1", channel_id: "C-COLLIDING", team_id: "T-HELP-OWNER" },
      ack: async () => {},
      respond: async (payload: any) => sent.push(payload),
    });
  } finally {
    programs.forChannel = originalForChannel;
  }
  assert.deepEqual(calls, [{ channel: "C-COLLIDING", workspaceId: "T-HELP-OWNER" }]);
  assert.equal(sent.length, 1);
});

test("/orry ask skips cache and blocks general chat when grounded lookup has no answer", async () => {
  const respond = require("./respond");
  const chat = require("./chat");
  const channelPolicy = require("./channelPolicy");
  const originalLookup = respond.lookupAnswer;
  const originalChat = chat.getChatReply;
  const originalResolve = channelPolicy.resolve;
  const savedGrounded = process.env.ORRY_REQUIRE_GROUNDED_ANSWER ?? process.env.RIVET_REQUIRE_GROUNDED_ANSWER;
  const sent: any[] = [];
  const lookupOptions: any[] = [];
  let generalChatCalls = 0;
  channelPolicy.resolve = (channel: string) => ({
    role: "main",
    program: { id: "grounded", name: "Grounded", requireGroundedAnswer: channel.endsWith("-0") },
    settings: { enabled: true },
  });
  respond.lookupAnswer = async (...args: any[]) => {
    lookupOptions.push(args[4]);
    return null;
  };
  chat.getChatReply = async () => {
    generalChatCalls += 1;
    return "unsupported answer";
  };
  try {
    for (const [index, globalOnly] of [false, true].entries()) {
      if (globalOnly) process.env.ORRY_REQUIRE_GROUNDED_ANSWER = "1";
      else delete process.env.ORRY_REQUIRE_GROUNDED_ANSWER;
      await commands.askCommand({
        command: { text: "when is the deadline?", user_id: "U1", channel_id: `C-GROUNDED-${index}` },
        ack: async () => {},
        respond: async (payload: any) => sent.push(payload),
      });
    }
  } finally {
    respond.lookupAnswer = originalLookup;
    chat.getChatReply = originalChat;
    channelPolicy.resolve = originalResolve;
    if (savedGrounded === undefined) delete process.env.ORRY_REQUIRE_GROUNDED_ANSWER;
    else process.env.ORRY_REQUIRE_GROUNDED_ANSWER = savedGrounded;
  }
  assert.equal(lookupOptions.length, 2);
  assert.deepEqual(
    lookupOptions.map((options) => options?.skipCache),
    [true, true],
  );
  assert.equal(generalChatCalls, 0);
  assert.deepEqual(
    sent.map((payload) => payload.text),
    [respond.MENTION_FALLBACK, respond.MENTION_FALLBACK],
  );
});

test("/orry-check dispatches to the deterministic path", async () => {
  const validator = require("./validator");
  const respond = require("./respond");
  const sent: any[] = [];
  const sendEphemeral = async (m: any) => sent.push(m.text);
  const origValidate = validator.validateRepository;
  try {
    validator.validateRepository = async () => ({
      ok: true,
      url: "https://github.com/u/r",
      fullName: "u/r",
      isReady: true,
      passes: ["ok"],
      issues: [],
      tips: [],
    });
    await commands.checkCommand({
      command: { text: "https://github.com/u/r", user_id: "U1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0], /Ready for submission/);
  } finally {
    validator.validateRepository = origValidate;
  }
});
export {};
