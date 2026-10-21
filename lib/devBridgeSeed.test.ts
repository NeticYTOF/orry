process.env.RIVET_DB_PATH = ":memory:";
// scripts/dev-bridge.ts puts the invented organizer on the admin list; do the same here.
process.env.RIVET_ADMIN_USER_IDS = require("./devBridgePeople").ORGANIZER_IDS.join(",");

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const seedModule = require("./devBridgeSeed");
process.env.RIVET_PROGRAMS_JSON = JSON.stringify([seedModule.programConfig()]);
const db = require("./db");
const dash = require("./web/dashboardApi");

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
let summary: Record<string, unknown>;

before(() => {
  db.close();
  db.open(":memory:");
  require("./programs").invalidate();
  summary = seedModule.seed({ now: NOW });
});

test("the dev seed makes about 150 tickets over 12 ISO weeks (154 with the site cases) and is idempotent", () => {
  assert.equal(summary.tickets, 154);
  assert.equal((summary.weeks as string[]).length, 12);
  assert.equal((summary.weeks as string[])[11], "2026-W43");
  const again = seedModule.seed({ now: NOW });
  assert.equal(again.tickets, 154, "a second run leaves the database alone");
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets").get().n, 154);
  const first = seedModule.isoWeekStart(NOW) - 11 * 7 * 86400000;
  const spread = db.handle().query("SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM tickets").get();
  assert.ok(spread.lo >= first && spread.hi < NOW);
});

test("the dev seed's rows obey the invariants the bridge routes rely on", () => {
  const rows = db.handle().query("SELECT * FROM tickets").all();
  for (const t of rows) {
    if (t.status === "resolved" || t.status === "closed") assert.ok(t.resolved_at >= t.created_at, `#${t.id}`);
    else assert.equal(t.resolved_at, null, `#${t.id} open with a resolved_at`);
    if (t.first_human_response_at) assert.ok(t.last_human_reply_at >= t.first_human_response_at, `#${t.id}`);
    assert.ok(t.updated_at >= t.created_at);
    assert.ok(Number.isInteger(t.updated_at));
  }
  const staff = new Set([...seedModule.HELPER_IDS, ...seedModule.ORGANIZER_IDS]);
  const credited = db
    .handle()
    .query("SELECT DISTINCT resolved_credit_id AS id FROM tickets WHERE resolved_credit_id IS NOT NULL")
    .all();
  assert.ok(
    credited.every((r: { id: string }) => staff.has(r.id)),
    "only roster helpers and organizers get credit",
  );
  assert.deepEqual(
    db
      .handle()
      .query("SELECT user_id FROM program_helpers WHERE active = 1 ORDER BY user_id")
      .all()
      .map((r: { user_id: string }) => r.user_id),
    [...seedModule.HELPER_IDS].sort(),
  );
});

test("every kind of close the site labels is present in the closing route", () => {
  const res = dash.ticketClosing("loadout", { since: NOW - 90 * 86400000, until: NOW, limit: 500 });
  const kinds = new Set(
    res.rows.map(
      (r: {
        closing: { actorKind: string; source: string | null; rule: string | null; verdict: string | null } | null;
      }) =>
        !r.closing
          ? "no_event"
          : r.closing.source === "backfill"
            ? "import"
            : r.closing.rule === "last_word"
              ? "last_word"
              : r.closing.verdict
                ? "judge"
                : r.closing.actorKind,
    ),
  );
  for (const kind of ["helper", "requester", "last_word", "judge", "import", "no_event"]) {
    assert.ok(kinds.has(kind), `missing a ${kind} close`);
  }
  assert.ok(res.rows.some((r: { pings: unknown[] }) => r.pings.length > 0));
  assert.ok(res.rows.some((r: { reopenCount: number }) => r.reopenCount > 0));
  const statuses = db
    .handle()
    .query("SELECT DISTINCT status FROM tickets")
    .all()
    .map((r: { status: string }) => r.status);
  for (const status of ["waiting_for_helper", "claimed", "resolved", "closed"]) {
    assert.ok(statuses.includes(status), `no ${status} ticket`);
  }
  assert.ok(db.handle().query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'sla.notified'").get().n > 0);
});

test("the dev seed has the cases a status site must handle: an organizer's finish, a DM ticket, deleted and edited questions", () => {
  const [organizer] = seedModule.ORGANIZER_IDS;
  const byOrganizer = db
    .handle()
    .query("SELECT * FROM tickets WHERE status = 'resolved' AND resolved_credit_id = ?")
    .all(organizer);
  assert.equal(byOrganizer.length, 1, "one ticket finished and credited to the organizer");
  const closing = dash.ticketClosing("loadout", { since: NOW - 90 * 86400000, until: NOW, limit: 500 });
  const row = closing.rows.find((r: { id: number }) => r.id === byOrganizer[0].id);
  assert.equal(row.closing.actorKind, "helper", "an admin's close is a helper close on the closing route");
  assert.equal(row.closing.actorId, organizer);

  const outside = db.handle().query("SELECT * FROM tickets WHERE channel LIKE 'D%'").all();
  assert.equal(outside.length, 1, "one ticket outside the program's channels");

  const redacted = db.handle().query("SELECT * FROM tickets WHERE text_redacted_at IS NOT NULL ORDER BY id").all();
  assert.deepEqual(
    redacted.map((t: { text_redaction: string }) => t.text_redaction),
    ["deleted", "edited"],
  );
  for (const t of redacted) {
    assert.equal(t.question, "", `#${t.id} keeps its question`);
    const tombstone = t.text_redaction === "deleted" ? "root_message_deleted" : "root_message_edited";
    const events = db.handle().query("SELECT * FROM ticket_events WHERE ticket_id = ?").all(t.id);
    assert.ok(
      events.some((e: { event_type: string }) => e.event_type === tombstone),
      `#${t.id} has no ${tombstone}`,
    );
    if (t.text_redaction === "deleted") {
      for (const e of events) assert.ok(!/"text"\s*:/.test(e.detail || ""), `#${t.id} event ${e.id} keeps text`);
    }
  }
});

test("the fake Slack client answers lookups and refuses anything that would post", async () => {
  const slack = seedModule.fakeSlackClient();
  const juno = await slack.users.info({ user: "U0JUNO001" });
  assert.equal(juno.user.profile.real_name, "Juno Baker");
  await assert.rejects(slack.chat.postMessage({ channel: "C0DEVHELP1", text: "hi" }), /dev_bridge_no_slack/);
  await assert.rejects(slack.users.info({ user: "U-NOBODY" }), /user_not_found/);
});

export {};
