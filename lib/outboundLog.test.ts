process.env.RIVET_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const slackMessages = require("./slackMessages");
const reply = require("./reply");

before(() => {
  db.close();
  db.open(":memory:");
});

interface OutRow {
  id: number;
  program_id: string | null;
  channel: string;
  thread_ts: string | null;
  message_ts: string | null;
  surface: string;
  source: string;
  status: string;
  error: string | null;
  private: number;
  text: string | null;
  blocks_json?: string | null;
  text_chars: number | null;
  edit_count: number;
  deleted_at: number | null;
  text_purged_at: number | null;
}

function rows(channel: string): OutRow[] {
  return db.handle().query("SELECT * FROM outbound_messages WHERE channel = ? ORDER BY id").all(channel) as OutRow[];
}

function okClient(ts = "1700000000.000100") {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    chat: {
      postMessage: async (payload: unknown) => {
        calls.push({ method: "postMessage", payload });
        return { ok: true, ts };
      },
      update: async (payload: unknown) => {
        calls.push({ method: "update", payload });
        return { ok: true };
      },
      delete: async (payload: unknown) => {
        calls.push({ method: "delete", payload });
        return { ok: true };
      },
    },
  };
}

const PROGRAM = { id: "out-prog", name: "Out" };

test("outbound messages keep metadata only on every surface", async () => {
  await slackMessages.sendProgramMessage({
    client: okClient("10.1"),
    program: PROGRAM,
    channel: "C-OUT-1",
    threadTs: "9.9",
    text: "Try restarting the board.",
  });
  const [thread] = rows("C-OUT-1");
  assert.equal(thread.surface, "thread");
  assert.equal(thread.message_ts, "10.1");
  assert.equal(thread.text, null);
  assert.equal(thread.blocks_json, null);
  assert.equal(thread.text_chars, null);
  assert.equal(thread.program_id, "out-prog");
  assert.equal(thread.status, "sent");

  await slackMessages.sendProgramMessage({
    client: okClient("11.1"),
    program: PROGRAM,
    channel: "D-OUT-DM",
    text: "hi",
  });
  const [dm] = rows("D-OUT-DM");
  assert.equal(dm.surface, "dm");
  assert.equal(dm.text, null);
  assert.equal(dm.private, 1);
  assert.equal(dm.text_chars, null);

  await slackMessages.sendProgramMessage({
    client: okClient("12.1"),
    program: PROGRAM,
    channel: "C-OUT-2",
    threadTs: "8.8",
    text: "A person needs to decide.",
    logSource: "sensitive_reply",
    logPrivate: true,
  });
  const [sensitive] = rows("C-OUT-2");
  assert.equal(sensitive.text, null);
  assert.equal(sensitive.source, "sensitive_reply");
});

test("opening the schema clears legacy outbound text, blocks, and content lengths", () => {
  const schema = require("./schema");
  db.handle()
    .query(
      "UPDATE outbound_messages SET text = 'old text', blocks_json = '[{}]', text_chars = 8 WHERE channel = 'C-OUT-1'",
    )
    .run();
  db.handle().exec(schema.POST_MIGRATION_SCHEMA);
  const [row] = rows("C-OUT-1");
  assert.equal(row.text, null);
  assert.equal(row.blocks_json, null);
  assert.equal(row.text_chars, null);
  assert.ok(row.text_purged_at);
});

test("a failed send is logged as failed and still throws the Slack error", async () => {
  const err = Object.assign(new Error("An API error occurred: channel_not_found"), {
    data: { error: "channel_not_found" },
  });
  const client = {
    chat: {
      postMessage: async () => {
        throw err;
      },
    },
  };
  await assert.rejects(
    slackMessages.sendProgramMessage({ client, program: PROGRAM, channel: "C-OUT-FAIL", text: "x" }),
    (e: unknown) => e === err,
  );
  const [row] = rows("C-OUT-FAIL");
  assert.equal(row.status, "failed");
  assert.equal(row.error, "channel_not_found");
  assert.equal(row.message_ts, null);
});

test("a logging failure never breaks the send", async () => {
  db.handle().exec("ALTER TABLE outbound_messages RENAME TO outbound_messages_away");
  try {
    const res = await slackMessages.sendProgramMessage({
      client: okClient("13.1"),
      program: PROGRAM,
      channel: "C-OUT-BROKEN",
      text: "still sent",
    });
    assert.equal(res.ts, "13.1");
  } finally {
    db.handle().exec("ALTER TABLE outbound_messages_away RENAME TO outbound_messages");
  }
});

test("a placeholder that becomes the answer is one metadata row", async () => {
  const client = okClient("14.1");
  const placeholder = reply.postThinking(client, "C-OUT-ANS", "7.7", PROGRAM);
  await reply.finalize(client, "C-OUT-ANS", "7.7", placeholder, "Your build goes in the #ship channel.", {
    program: PROGRAM,
  });
  const list = rows("C-OUT-ANS");
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "answer");
  assert.equal(list[0].edit_count, 1);
  assert.equal(list[0].text, null);
  assert.equal(list[0].blocks_json, null);
  assert.equal(list[0].text_chars, null);
});

test("a discarded placeholder and a :x: delete leave a tombstone with no text", async () => {
  const client = okClient("15.1");
  const placeholder = reply.postThinking(client, "C-OUT-DEL", "6.6", PROGRAM);
  await reply.discardPlaceholder(client, "C-OUT-DEL", placeholder);
  const [discarded] = rows("C-OUT-DEL");
  assert.ok(discarded.deleted_at);
  assert.equal(discarded.text, null);

  const answerClient = okClient("16.1");
  await slackMessages.sendProgramMessage({
    client: answerClient,
    program: PROGRAM,
    channel: "C-OUT-X",
    threadTs: "5.5",
    text: "An answer someone wanted gone.",
  });
  const { config } = require("./config");
  const savedBot = config.slack.botUserId;
  config.slack.botUserId = "U-ORRY-BOT";
  try {
    await require("./reactionHandlers").onReactionAdded({
      event: { reaction: "x", user: "U-KID", item: { channel: "C-OUT-X", ts: "16.1" }, item_user: "U-ORRY-BOT" },
      client: answerClient,
    });
  } finally {
    config.slack.botUserId = savedBot;
  }
  assert.ok(
    answerClient.calls.some((c) => c.method === "delete"),
    "the reaction did delete in Slack",
  );
  const [gone] = rows("C-OUT-X");
  assert.ok(gone.deleted_at, "the row is a tombstone");
  assert.equal(gone.text, null, "the text went at once, not at the 30-day purge");
});

test("a ticket card edit updates metadata without retaining text or blocks", async () => {
  const tickets = require("./tickets");
  const client = okClient("17.1");
  const id = db.createTicket({
    programId: "out-prog",
    channel: "C-OUT-HELP",
    threadTs: "4.4",
    requesterId: "U-KID",
    question: "fake question",
  });
  db.updateTicketCardTs(id, "17.1");
  await slackMessages.sendProgramMessage({
    client,
    program: PROGRAM,
    channel: "C-OUT-ORG",
    text: "[Ticket] card",
    logSource: "ticket_card",
  });
  await tickets.reconcileTicketUI({
    client,
    ticket: db.getTicket(id),
    program: { ...PROGRAM, organizerChannel: "C-OUT-ORG" },
    cardText: "[Ticket] Claimed",
  });
  const [card] = rows("C-OUT-ORG").filter((r) => r.message_ts === "17.1");
  assert.equal(card.edit_count >= 1, true);
  assert.equal(card.text, null);
  assert.equal(card.blocks_json, null);
});

test("outbound message bodies are never retained and metadata rows expire after 365 days", () => {
  const outboundLog = require("./outboundLog");
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const make = (ts: string, ageDays: number) => {
    const id = outboundLog.recordPost({ programId: "out-prog", channel: "C-OUT-PURGE", ts, text: `text ${ts}` });
    db.handle()
      .query("UPDATE outbound_messages SET created_at = ? WHERE id = ?")
      .run(now - ageDays * DAY, id);
    return id;
  };
  make("p.fresh", 29);
  make("p.old", 31);
  make("p.ancient", 366);
  const deletedId = make("p.deleted", 1);
  db.handle().query("UPDATE outbound_messages SET deleted_at = ? WHERE id = ?").run(now, deletedId);

  db.sweep();
  const byTs = new Map(rows("C-OUT-PURGE").map((r) => [r.message_ts, r]));
  assert.equal(byTs.get("p.fresh").text, null);
  assert.equal(byTs.get("p.old").text, null);
  assert.equal(byTs.get("p.fresh").blocks_json, null);
  assert.equal(byTs.get("p.old").text_chars, null);
  assert.equal(byTs.has("p.ancient"), false);
  assert.equal(byTs.get("p.deleted").text, null);
});

test("GET /internal/v1/programs/:id/outbound is program-scoped and never returns message content", async () => {
  const outboundLog = require("./outboundLog");
  const programs = require("./programs");
  db.saveProgram({ id: "out-route", name: "Out Route" });
  db.saveProgram({ id: "out-route-other", name: "Other" });
  programs.invalidate();
  outboundLog.recordPost({ programId: "out-route", channel: "C-OR", threadTs: "1.1", ts: "1.2", text: "public reply" });
  outboundLog.recordPost({ programId: "out-route", channel: "D-OR", ts: "1.3", text: "dm words" });
  outboundLog.recordPost({ programId: "out-route", channel: "C-OR", ts: "1.4", text: "private", private: true });
  outboundLog.recordPost({ programId: "out-route-other", channel: "C-OTHER", ts: "1.5", text: "other program" });
  // Legacy/corrupt content must not be exposed by the API.
  db.handle().query("UPDATE outbound_messages SET text = 'leaked dm' WHERE channel = 'D-OR'").run();

  const saved = process.env.RIVET_INTERNAL_TOKEN;
  process.env.RIVET_INTERNAL_TOKEN = "outbound-route-token";
  try {
    const serve = require("./web/serve");
    const res = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/out-route/outbound?includeBlocks=1", {
        headers: { Authorization: "Bearer outbound-route-token" },
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 3);
    const blob = JSON.stringify(body);
    assert.equal(blob.includes("other program"), false, "other programs never appear");
    assert.equal(blob.includes("dm words") || blob.includes("leaked dm") || blob.includes("public reply"), false);
    assert.ok(
      body.rows.every(
        (r: { text: string | null; blocks?: unknown; textChars: number | null }) =>
          r.text === null && r.textChars === null && (!("blocks" in r) || r.blocks === null),
      ),
    );
    const pub = body.rows.find((r: { messageTs: string }) => r.messageTs === "1.2");
    assert.equal(pub.text, null);
    assert.equal(pub.surface, "thread");

    const missing = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/out-route-missing/outbound", {
        headers: { Authorization: "Bearer outbound-route-token" },
      }),
    );
    assert.equal(missing.status, 404);
  } finally {
    if (saved === undefined) delete process.env.RIVET_INTERNAL_TOKEN;
    else process.env.RIVET_INTERNAL_TOKEN = saved;
  }
});

test("log rows link to their ticket: thread replies, the card, and the route's ticketId filter", async () => {
  const outboundLog = require("./outboundLog");
  const id = db.createTicket({
    programId: "out-prog",
    channel: "C-OUT-T",
    threadTs: "20.1",
    requesterId: "U-KID",
    question: "SENTINEL-T question",
  });
  await slackMessages.sendProgramMessage({
    client: okClient("20.2"),
    program: PROGRAM,
    channel: "C-OUT-T",
    threadTs: "20.1",
    text: "a reply in the ticket thread",
  });
  await slackMessages.sendProgramMessage({
    client: okClient("20.3"),
    program: PROGRAM,
    channel: "C-OUT-ORG2",
    text: 'asked: "SENTINEL-T question"',
    logSource: "ticket_card",
    logTicketId: id,
  });
  outboundLog.recordPost({ programId: "out-prog", channel: "C-OUT-T", ts: "20.9", text: "unrelated" });
  const linked = db
    .handle()
    .query("SELECT message_ts FROM outbound_messages WHERE ticket_id = ? ORDER BY message_ts")
    .all(id)
    .map((r: { message_ts: string }) => r.message_ts);
  assert.deepEqual(linked, ["20.2", "20.3"]);

  db.saveProgram({ id: "out-prog", name: "Out" });
  require("./programs").invalidate();
  const listed = outboundLog.listForProgram("out-prog", { ticketId: id });
  assert.equal(listed.total, 2);
  assert.ok(listed.rows.every((r: { ticketId: number }) => r.ticketId === id));

  // Ticket thread changes do not cause outbound content to be retained.
  require("./messageRedaction").handleMessageChange({
    subtype: "message_deleted",
    channel: "C-OUT-T",
    deleted_ts: "20.1",
  });
  const left = db
    .handle()
    .query("SELECT text FROM outbound_messages WHERE ticket_id = ? AND (text IS NOT NULL OR blocks_json IS NOT NULL)")
    .all(id);
  assert.equal(left.length, 0);
});

export {};
