process.env.RIVET_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const redaction = require("./messageRedaction");

before(() => {
  db.close();
  db.open(":memory:");
});

const CHANNEL = "C-REDACT";

function seed(threadTs: string, extra: Record<string, unknown> = {}) {
  const id = db.createTicket({
    programId: "redact-prog",
    channel: CHANNEL,
    threadTs,
    requesterId: "U-KID",
    question: "SECRET-QUESTION my email is x",
  });
  db.handle()
    .query("UPDATE tickets SET summary = 'SECRET-SUMMARY', resolution = ?, resolution_summary = ? WHERE id = ?")
    .run(extra.resolution || null, extra.resolutionSummary || null, id);
  const add = (eventType: string, actorId: string, detail: unknown) => {
    db.addTicketEvent({ ticketId: id, programId: "redact-prog", actorId, eventType, detail });
    require("./audit").record({
      programId: "redact-prog",
      actorId,
      action: `ticket.${eventType}`,
      entityType: "ticket",
      entityId: id,
      metadata: detail,
    });
  };
  add("created", "U-KID", { channel: CHANNEL, source: "support_question" });
  add("requester_followup", "U-KID", { text: "SECRET-FOLLOWUP" });
  add("helper_reply", "U-HELP", { ts: `${threadTs}.reply`, text: "SECRET-REPLY" });
  add("helper_reply", "U-HELP", { ts: `${threadTs}.other`, text: "KEEP-OTHER-REPLY" });
  return id;
}

function storedText(id: number): string {
  const ticket = JSON.stringify(db.getTicket(id));
  const events = JSON.stringify(db.listTicketEvents(id));
  const audits = JSON.stringify(
    db.handle().query("SELECT * FROM audit_events WHERE entity_type = 'ticket' AND entity_id = ?").all(String(id)),
  );
  return `${ticket}\n${events}\n${audits}`;
}

test("deleting a ticket's root message removes every stored copy of the thread's text and keeps a tombstone", () => {
  const id = seed("100.1", {
    resolution: "auto-resolved: SECRET-JUDGE-REASON",
    resolutionSummary: "SECRET-RESOLUTION",
  });
  assert.equal(
    redaction.handleMessageChange({ subtype: "message_deleted", channel: CHANNEL, deleted_ts: "100.1" }),
    "root_deleted",
  );
  const text = storedText(id);
  assert.equal(/SECRET|KEEP-OTHER/.test(text), false, text);
  const ticket = db.getTicket(id);
  assert.equal(ticket.question, "");
  assert.equal(ticket.resolution, "auto-resolved:", "the close label survives, the judge's paraphrase does not");
  assert.equal(ticket.text_redaction, "deleted");
  assert.ok(ticket.text_redacted_at > 0);
  assert.equal(ticket.requester_id, "U-KID", "the row stays so counts still add up");
  const events = db.listTicketEvents(id);
  assert.ok(events.some((e: { event_type: string }) => e.event_type === "root_message_deleted"));
  assert.equal(
    JSON.parse(events.find((e: { event_type: string }) => e.event_type === "created").detail).source,
    "support_question",
  );
});

test("a root deleted while it has replies arrives as a tombstone change and is treated as a delete", () => {
  const id = seed("200.1");
  const result = redaction.handleMessageChange({
    subtype: "message_changed",
    channel: CHANNEL,
    message: { ts: "200.1", subtype: "tombstone", text: "This message was deleted." },
    previous_message: { ts: "200.1", text: "SECRET-QUESTION my email is x" },
  });
  assert.equal(result, "root_deleted");
  assert.equal(/SECRET/.test(storedText(id)), false);
});

test("editing the root drops the stored question but not the thread; reply-count updates change nothing", () => {
  const id = seed("300.1");
  const noop = redaction.handleMessageChange({
    subtype: "message_changed",
    channel: CHANNEL,
    message: { ts: "300.1", text: "same words", reply_count: 3 },
    previous_message: { ts: "300.1", text: "same words" },
  });
  assert.equal(noop, null);
  assert.equal(db.getTicket(id).question, "SECRET-QUESTION my email is x");

  const edited = redaction.handleMessageChange({
    subtype: "message_changed",
    channel: CHANNEL,
    message: { ts: "300.1", text: "NEW-WORDS without the email" },
    previous_message: { ts: "300.1", text: "SECRET-QUESTION my email is x" },
  });
  assert.equal(edited, "root_edited");
  const ticket = db.getTicket(id);
  assert.equal(ticket.question, "");
  assert.equal(ticket.summary, null);
  assert.equal(ticket.text_redaction, "edited");
  assert.equal(storedText(id).includes("NEW-WORDS"), false, "the edited text is not stored either");
  assert.equal(storedText(id).includes("SECRET-REPLY"), true, "replies are untouched by a root edit");
});

test("deleting one reply in a ticket thread removes only that reply's stored text", () => {
  const id = seed("400.1");
  const result = redaction.handleMessageChange({
    subtype: "message_deleted",
    channel: CHANNEL,
    deleted_ts: "400.1.reply",
    previous_message: { ts: "400.1.reply", thread_ts: "400.1", text: "SECRET-REPLY" },
  });
  assert.equal(result, "reply_deleted");
  const text = storedText(id);
  assert.equal(text.includes("SECRET-REPLY"), false);
  assert.equal(text.includes("KEEP-OTHER-REPLY"), true);
  assert.equal(db.getTicket(id).question, "SECRET-QUESTION my email is x");
});

test("Orry's own edits and deletes, and messages in other channels, are ignored", () => {
  const id = seed("500.1");
  assert.equal(
    redaction.handleMessageChange({
      subtype: "message_deleted",
      channel: CHANNEL,
      deleted_ts: "500.1",
      previous_message: { ts: "500.1", bot_id: "B-ORRY" },
    }),
    null,
  );
  assert.equal(
    redaction.handleMessageChange({ subtype: "message_deleted", channel: "C-ELSEWHERE", deleted_ts: "500.1" }),
    null,
  );
  assert.equal(db.getTicket(id).question, "SECRET-QUESTION my email is x");
});

test("onMessage routes deletes to redaction without answering or posting", async () => {
  const handlers = require("./handlers");
  const id = seed("600.1");
  const client = new Proxy(
    {},
    {
      get() {
        throw new Error("a delete event must not call Slack");
      },
    },
  );
  await handlers.onMessage({
    event: { subtype: "message_deleted", channel: CHANNEL, deleted_ts: "600.1", ts: "600.2" },
    client,
  });
  assert.equal(db.getTicket(id).question, "");
});

export {};
