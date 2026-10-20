process.env.RIVET_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const pipelineEvents = require("./pipeline/events");
const outcomes = require("./answerOutcomes");

before(() => {
  db.close();
  db.open(":memory:");
  db.saveProgram({ id: "ao-prog", name: "AO" });
  db.saveProgram({ id: "ao-other", name: "Other" });
  programs.invalidate();
});

test("a finished pipeline trace writes one metadata-only outcome row, linked to its ticket", () => {
  const ticketId = db.createTicket({
    programId: "ao-prog",
    channel: "C-AO",
    threadTs: "50.1",
    requesterId: "U-KID",
    question: "SENTINEL question text",
  });
  const trace = pipelineEvents.start({
    programId: "ao-prog",
    role: "help",
    addressed: true,
    channel: "C-AO",
    threadTs: "50.1",
    messageTs: "50.1",
  });
  trace.set({ groundingPass: true });
  trace.finish({ finalAction: "reply", reason: "grounded" });
  trace.finish({ finalAction: "silence", reason: "twice" });

  const rows = db.handle().query("SELECT * FROM answer_outcomes WHERE channel = 'C-AO'").all();
  assert.equal(rows.length, 1, "a trace finishes once");
  const row = rows[0] as Record<string, unknown>;
  assert.equal(row.final_action, "reply");
  assert.equal(row.reason, "grounded");
  assert.equal(row.grounded, 1);
  assert.equal(row.ticket_id, ticketId);
  assert.equal(row.addressed, 1);
  assert.ok(Number(row.latency_ms) >= 0);
  assert.equal(JSON.stringify(rows).includes("SENTINEL"), false);
  assert.equal(JSON.stringify(rows).includes("U-KID"), false, "no user id");
});

test("a trace with no message location (tests, probes) writes no row", () => {
  const before = db.handle().query("SELECT COUNT(*) AS n FROM answer_outcomes").get().n;
  pipelineEvents.start({ programId: "ao-prog", role: "help" }).finish({ finalAction: "reply", reason: "probe" });
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_outcomes").get().n, before);
});

test("the outcomes list is program-scoped and its counts cover the whole window, not one page", () => {
  for (const [action, reason] of [
    ["silence", "ambient_chatter"],
    ["silence", "ambient_chatter"],
    ["uncertain", "ungrounded"],
    ["escalate", "sensitive"],
  ]) {
    pipelineEvents
      .start({ programId: "ao-prog", role: "help", channel: "C-AO2", threadTs: `${Math.random()}` })
      .finish({ finalAction: action, reason });
  }
  pipelineEvents
    .start({ programId: "ao-other", role: "help", channel: "C-OTHER", threadTs: "1" })
    .finish({ finalAction: "reply", reason: "other" });

  const res = outcomes.listForProgram("ao-prog", { limit: 2 });
  assert.equal(res.total, 5);
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.byAction, { reply: 1, silence: 2, uncertain: 1, escalate: 1 });
  assert.equal(res.byReason.find((r: { reason: string }) => r.reason === "ambient_chatter").count, 2);
  assert.equal(JSON.stringify(res).includes("C-OTHER"), false);
  assert.equal(outcomes.listForProgram("ao-missing", {}).error, "unknown program");
});

export {};
