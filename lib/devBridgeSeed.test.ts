process.env.RIVET_DB_PATH = ":memory:";

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

test("the dev seed makes about 150 tickets over 12 ISO weeks and is idempotent", () => {
  assert.equal(summary.tickets, 150);
  assert.equal((summary.weeks as string[]).length, 12);
  assert.equal((summary.weeks as string[])[11], "2026-W43");
  const again = seedModule.seed({ now: NOW });
  assert.equal(again.tickets, 150, "a second run leaves the database alone");
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets").get().n, 150);
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
  const helpers = new Set(seedModule.HELPER_IDS);
  const credited = db
    .handle()
    .query("SELECT DISTINCT resolved_credit_id AS id FROM tickets WHERE resolved_credit_id IS NOT NULL")
    .all();
  assert.ok(
    credited.every((r: { id: string }) => helpers.has(r.id)),
    "only roster helpers get credit",
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

test("the fake Slack client answers lookups and refuses anything that would post", async () => {
  const slack = seedModule.fakeSlackClient();
  const juno = await slack.users.info({ user: "U0JUNO001" });
  assert.equal(juno.user.profile.real_name, "Juno Baker");
  await assert.rejects(slack.chat.postMessage({ channel: "C0DEVHELP1", text: "hi" }), /dev_bridge_no_slack/);
  await assert.rejects(slack.users.info({ user: "U-NOBODY" }), /user_not_found/);
});

export {};
